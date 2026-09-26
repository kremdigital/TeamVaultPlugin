/**
 * A note edited offline that a teammate deletes and creates again under its
 * name while this device connects. The delete comes live, and the copy here
 * holds edits the server may never have had: the user is asked about it. The
 * create comes live too, while the question is open, and the server gives the
 * new note the deleted one's id — continuing its history (the server that
 * knows the catch-up flag) or starting a new one (production when 0.3.8 came
 * out). The catch-up's docs are encoded before the delete, or after it all,
 * and the engine takes them once the listing is in.
 *
 * Before: the note under the question stayed in the index, so the create's
 * broadcast was dropped as a note known here, and the new note's history met
 * the deleted one's, offline edits included: the team got the two texts
 * merged, or the new note's text replaced by the old one — whatever the
 * answer.
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

/** `early`: the batch comes before the listing is in, encoded before the delete. */
type Batch = 'early' | 'late, encoded after' | 'late, encoded before';
type Answer = 'none yet' | 'delete-local' | 'restore-server';

const cases: Array<[BroadcastFormat, Batch, Answer]> = [];
for (const format of ['legacy', 'current'] as BroadcastFormat[]) {
  cases.push([format, 'early', 'delete-local']);
  cases.push([format, 'late, encoded after', 'restore-server']);
  cases.push([format, 'late, encoded before', 'none yet']);
}

describe.each(cases)(
  'SyncEngine — a note deleted and created again by a teammate while this device connects, %s server, batch %s',
  (format, batch, answer) => {
    it(`keeps the new note as it is, the offline edit in a copy of its own (answer: ${answer})`, async () => {
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

      // Typed offline.
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

      // Connecting to a large vault: the listing takes a while.
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
      if (batch === 'early') stream(h, before);
      await flushAsync(10);
      server.teammateDelete('f1');
      await flushAsync(20);
      await server.teammateCreate('Plan.md', 'new plan\n');
      await flushAsync(40);
      if (batch === 'late, encoded after') stream(h, docs.snapshots());
      if (batch === 'late, encoded before') stream(h, before);
      h.routes.set(LIST, listing);
      gate.resolve();
      await flushAsync(40);
      await docs.drive();

      expect(h.engine.getStatus()).toBe('connected');
      expect(h.calls.filter((c) => c === 'modal.resolveDeleteConflict')).toHaveLength(1);
      expect(docs.text('f1')).toBe('new plan\n');
      expect(h.vault.text('Plan.md')).toBe('new plan\n');
      const copies = (): string[] =>
        [...h.vault.files.keys()].filter((p) => p.startsWith('Plan.conflict-'));
      expect(copies()).toHaveLength(1);
      const copy = copies()[0] ?? '';
      expect(h.vault.text(copy)).toBe('old plan\nmine\n');

      if (answer !== 'none yet') {
        h.modal.del.resolve(answer);
        await flushAsync(40);
        await docs.drive();
        await h.settle();
      }

      // Connect again: nothing of the old note comes back into the new one.
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

      const all = ['Other.md=other\n', `${copy}=old plan\nmine\n`, 'Plan.md=new plan\n'];
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      expect(h.calls.filter((c) => c === 'modal.resolveDeleteConflict')).toHaveLength(1);
      await h.engine.stop();
    });
  },
);
