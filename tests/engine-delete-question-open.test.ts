/**
 * A note edited offline that a teammate deletes while this device connects:
 * the user is asked about the copy here, and the note leaves the index until
 * the question is settled (see `SyncEngine.leaveIndexWhileAsked`). The
 * listing of the connect may have been taken before the delete, or after.
 *
 * A listing from before the delete must not bring the note back into the
 * index: the question then found its name taken and decided nothing — the
 * copy stayed on disk, never synced again, whatever the answer. One from
 * after it must not ask about the copy a second time.
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

type Listing = 'taken before the delete' | 'taken after the delete';
type Answer = 'delete-local' | 'restore-server';

const cases: Array<[BroadcastFormat, Listing, Answer]> = [];
for (const format of ['legacy', 'current'] as BroadcastFormat[]) {
  cases.push([format, 'taken before the delete', 'delete-local']);
  cases.push([format, 'taken before the delete', 'restore-server']);
  cases.push([format, 'taken after the delete', 'delete-local']);
}

describe.each(cases)(
  'SyncEngine — a note deleted by a teammate while this device connects with an edit of it, %s server, listing %s',
  (format, listingTaken, answer) => {
    it(`asks once, and the answer holds (${answer})`, async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
      await remember(h, 'Plan.md', 'f1', 'old plan\n');
      await docs.add('f1', 'Plan.md', 'old plan\n');
      await remember(h, 'Other.md', 'f2', 'other\n');
      await docs.add('f2', 'Other.md', 'other\n');
      await h.engine.start();
      h.socket()
        .pending('project:join')
        .ack(joinAnswer(server, format, 2));
      await flushAsync(3);
      stream(h, docs.snapshots());
      await docs.drive();

      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await h.settle();

      const listing = h.routes.get(LIST);
      if (!listing) throw new Error('no listing route');
      const stale = listing();
      const gate = deferred<void>();
      h.routes.set(LIST, () =>
        gate.promise.then(() => (listingTaken === 'taken before the delete' ? stale : listing())),
      );
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
      h.routes.set(LIST, listing);
      gate.resolve();
      await flushAsync(40);
      await docs.drive();
      await h.settle();

      expect(h.engine.getStatus()).toBe('connected');
      expect(asked(h)).toBe(1);
      expect(h.vault.text('Plan.md')).toBe('old plan\nmine\n');
      expect(h.engine.getFileIdForPath('Plan.md')).toBeNull();

      h.modal.del.resolve(answer);
      await flushAsync(40);
      await docs.drive();
      await h.settle();
      await docs.drive();

      const all =
        answer === 'delete-local'
          ? ['Other.md=other\n']
          : ['Other.md=other\n', 'Plan.md=old plan\nmine\n'];
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);

      // And after the next connect.
      h.socket().disconnect();
      await flushAsync();
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack(joinAnswer(server, format, docs.snapshots().length));
      await flushAsync(3);
      stream(h, docs.snapshots());
      await flushAsync(40);
      await docs.drive();
      await h.settle();
      await docs.drive();
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      expect(asked(h)).toBe(1);
      await h.engine.stop();
    });
  },
);
