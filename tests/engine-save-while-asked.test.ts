/**
 * A save of a note that reaches the engine while the user is asked what to do
 * with the copy of it a teammate deleted (see `SyncEngine.askedCopies`).
 *
 * Obsidian saves the open note, and the watcher holds the event in its
 * debounce: the teammate's delete lands in between, and the question — the
 * disk differs from what was folded — comes up before the save's event does.
 * The note is out of the index meanwhile (see `leaveIndexWhileAsked`), and the
 * save used to go out as a create: the server brought the note back for the
 * whole team before the user answered, and "Delete locally" was ignored —
 * the file under the name was another's by then. The same for a save during
 * the connect, and for the question about a note deleted while this device was
 * away, which the index never has.
 *
 * "Restore on server" sends the copy as it is when the user answers, the save
 * made meanwhile included.
 */
import { sha256Hex } from '@/sync/hash';
import type { YjsDocSnapshot } from '@/client/socket';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  deferred,
  encode,
  flushAsync,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

const LIST = 'GET /api/projects/p1/files';

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<void> {
  const hash = await sha256Hex(text);
  h.vault.files.set(path, encode(text));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function joinAnswer(server: FakeServer, format: BroadcastFormat, count: number) {
  return {
    ...server.joinAnswer(format === 'current' ? 'whole journal' : 'first rows'),
    yjsStream: true,
    yjsCount: count,
  };
}

function stream(h: Harness, docs: YjsDocSnapshot[]): void {
  h.socket().fire('yjs:catchup', { projectId: 'p1', docs, done: true });
}

function asked(h: Harness): number {
  return h.calls.filter((c) => c === 'modal.resolveDeleteConflict').length;
}

function creates(h: Harness): string[] {
  return h
    .socket()
    .emits.filter((e) => e.event === 'file:create')
    .map((e) => (e.payload as { filePath: string }).filePath);
}

function modify(h: Harness, path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });
}

async function connectWith(
  h: Harness,
  server: FakeServer,
  docs: ServerDocs,
  format: BroadcastFormat,
): Promise<void> {
  h.socket()
    .pending('project:join')
    .ack(joinAnswer(server, format, docs.snapshots().length));
  await flushAsync(3);
  stream(h, docs.snapshots());
  await flushAsync(40);
  await docs.drive();
  await h.settle();
  await docs.drive();
}

type When = 'once connected' | 'while connecting' | 'deleted while away';
type Answer = 'delete-local' | 'restore-server';

const cases: Array<[BroadcastFormat, When, Answer]> = [];
for (const format of ['legacy', 'current'] as BroadcastFormat[]) {
  cases.push([format, 'once connected', 'delete-local']);
  cases.push([format, 'once connected', 'restore-server']);
  cases.push([format, 'while connecting', 'delete-local']);
  cases.push([format, 'deleted while away', 'restore-server']);
}

describe.each(cases)(
  'SyncEngine — a save of a note deleted by a teammate while the user is asked, %s server, %s',
  (format, when, answer) => {
    it(`is left to the answer (${answer})`, async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
      await remember(h, 'Plan.md', 'f1', 'old plan\n');
      await docs.add('f1', 'Plan.md', 'old plan\n');
      await remember(h, 'Other.md', 'f2', 'other\n');
      await docs.add('f2', 'Other.md', 'other\n');
      await h.engine.start();
      await connectWith(h, server, docs, format);

      if (when === 'once connected') {
        // Obsidian saved the note; the event waits in the watcher's debounce.
        h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
        server.teammateDelete('f1');
        await flushAsync(40);
        await docs.drive();
      } else {
        h.socket().disconnect();
        await flushAsync();
        h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
        await modify(h, 'Plan.md');
        await h.settle();
        if (when === 'deleted while away') {
          server.teammateDelete('f1');
          h.socket().connect();
          await flushAsync();
          await connectWith(h, server, docs, format);
        } else {
          // The listing of the connect is late; the teammate deletes the note
          // meanwhile, and the question comes up while connecting.
          const listing = h.routes.get(LIST);
          if (!listing) throw new Error('no listing route');
          const gate = deferred<void>();
          h.routes.set(LIST, () => gate.promise.then(() => listing()));
          h.socket().connect();
          await flushAsync();
          const before = docs.snapshots();
          h.socket()
            .pending('project:join')
            .ack(joinAnswer(server, format, 2));
          await flushAsync(3);
          stream(h, before);
          await flushAsync(10);
          server.teammateDelete('f1');
          await flushAsync(20);
          expect(h.engine.getStatus()).not.toBe('connected');
          expect(asked(h)).toBe(1);
          // A save of the note while connecting, the question on screen.
          h.vault.files.set('Plan.md', encode('old plan\nmine\nmore\n'));
          const saved = modify(h, 'Plan.md');
          await flushAsync(20);
          await server.pump();
          await saved;
          h.routes.set(LIST, listing);
          gate.resolve();
          await flushAsync(40);
          await docs.drive();
          await h.settle();
        }
      }
      expect(asked(h)).toBe(1);
      expect(h.engine.getFileIdForPath('Plan.md')).toBeNull();

      // The save's event comes now, the question on screen; another save of
      // the copy follows it.
      await modify(h, 'Plan.md');
      h.vault.files.set('Plan.md', encode('old plan\nmine\nlast\n'));
      await modify(h, 'Plan.md');
      await flushAsync(20);
      await server.pump();
      await docs.drive();
      await h.settle();
      expect(creates(h)).toEqual([]);
      expect(docs.live()).toEqual(['Other.md=other\n']);

      h.modal.del.resolve(answer);
      await flushAsync(40);
      await docs.drive();
      await h.settle();
      await docs.drive();

      const all =
        answer === 'delete-local'
          ? ['Other.md=other\n']
          : ['Other.md=other\n', 'Plan.md=old plan\nmine\nlast\n'];
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);

      // And after the next connect.
      h.socket().disconnect();
      await flushAsync();
      h.socket().connect();
      await flushAsync();
      await connectWith(h, server, docs, format);
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      expect(asked(h)).toBe(1);
      await h.engine.stop();
    });
  },
);
