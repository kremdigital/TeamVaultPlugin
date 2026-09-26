/**
 * A note edited offline that a teammate deleted meanwhile: the user is asked
 * about the copy here, and the question is not settled — Obsidian closes
 * before an answer, or **Restore on server** is chosen without a connection.
 * While Obsidian is closed, the teammate creates the note again under its
 * name, and the server brings the tombstone back under the old id: continuing
 * its history and marking the CREATE `revived` (the server that knows the
 * catch-up flag), or with a new history (production when 0.3.8 came out).
 *
 * The clock took the DELETE in on the connect that asked, so the next whole
 * catch-up returns the CREATE alone, and a `revived` mark without its DELETE
 * counts only in a catch-up cut short. `state.json` still has the record of
 * the deleted note under the id: before, the listing indexed the new note as
 * that one, and on the server that continues the history the offline edit
 * went into the teammate's new note, for the whole team, without a question.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
  joinClockOf,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

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

function asked(h: Harness): number {
  return h.calls.filter((c) => c === 'modal.resolveDeleteConflict').length;
}

/** Answer the join for the clock it carried, the way each server does. */
async function join(
  h: Harness,
  server: FakeServer,
  docs: ServerDocs,
  format: BroadcastFormat,
): Promise<string[]> {
  const answer = server.joinAnswer(format === 'current' ? 'whole journal' : 'first rows', {
    clock: joinClockOf(h),
    yjsDocs: docs.snapshots(),
  });
  h.socket().pending('project:join').ack(answer);
  await docs.drive();
  await h.settle();
  await docs.drive();
  // The write through MCP is left out by the server that knows the flag.
  return (answer['operations'] as Array<{ opType: string }>)
    .map((op) => op.opType)
    .filter((type) => type !== 'UPDATE');
}

type Unsettled = 'Obsidian closed before an answer' | 'Restore on server without a connection';

const cases: Array<[BroadcastFormat, Unsettled]> = [];
for (const format of ['current', 'legacy'] as BroadcastFormat[]) {
  cases.push([format, 'Obsidian closed before an answer']);
  cases.push([format, 'Restore on server without a connection']);
}

describe.each(cases)(
  'SyncEngine — a note deleted by a teammate, its question unsettled (%s server, %s), created again while Obsidian is closed',
  (format, unsettled) => {
    it('keeps the new note as it is, the offline edit in a copy of its own', async () => {
      const idb = new FakeIndexedDb();
      const h = buildHarness({ docs: idb.manager() });
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
      await remember(h, 'Plan.md', 'f1', 'old\n');
      await docs.add('f1', 'Plan.md', 'old\n');
      await remember(h, 'Other.md', 'f2', 'other\n');
      await docs.add('f2', 'Other.md', 'other\n');
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      // The note's history is on this device: a write through MCP came live.
      await docs.restWrite('f1', 'old plan\n');
      await docs.drive();
      await h.settle();

      // Typed offline, while the teammate deletes the note.
      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await flushAsync(20);
      expect(idb.textOf(dbNameOf('Plan.md'))).toBe('old plan\nmine\n');
      server.teammateDelete('f1');

      // The connect asks about the copy; the DELETE reaches the clock.
      h.socket().connect();
      await flushAsync();
      expect(await join(h, server, docs, format)).toEqual(['DELETE']);
      await flushAsync(20);
      expect(asked(h)).toBe(1);
      expect(disk(h)).toEqual(['Other.md=other\n', 'Plan.md=old plan\nmine\n']);
      if (unsettled === 'Restore on server without a connection') {
        h.socket().disconnect();
        await flushAsync();
        h.modal.del.resolve('restore-server');
        await flushAsync(40);
        expect(server.applied.filter((op) => op.startsWith('create'))).toEqual([]);
      }

      // Obsidian closes; the teammate creates Plan.md again meanwhile.
      await h.engine.stop();
      await h.doc.destroy();
      await server.teammateCreate('Plan.md', 'new plan\n');
      expect(docs.text('f1')).toBe('new plan\n');

      const next = buildHarness({ predecessor: h, docs: idb.manager() });
      server.attach(next);
      docs.attach(next);
      await next.engine.start();
      await flushAsync();
      expect(await join(next, server, docs, format)).toEqual(['CREATE']);
      await flushAsync(40);
      await docs.drive();

      const copies = (): string[] =>
        [...next.vault.files.keys()].filter((p) => p.startsWith('Plan.conflict-'));
      expect(copies()).toHaveLength(1);
      const copy = copies()[0] ?? '';
      const all = ['Other.md=other\n', `${copy}=old plan\nmine\n`, 'Plan.md=new plan\n'];
      expect(docs.text('f1')).toBe('new plan\n');
      expect(docs.live()).toEqual(all);
      expect(disk(next)).toEqual(all);
      expect(idb.textOf(dbNameOf('Plan.md'))).toBe('new plan\n');
      expect(asked(next)).toBe(0);
      expect(next.log.deleteAskedIds('b1')).toEqual(new Set());

      // Connect again: nothing of the old note comes back into the new one.
      next.socket().disconnect();
      await flushAsync();
      next.socket().connect();
      await flushAsync();
      await join(next, server, docs, format);
      await flushAsync(40);
      await docs.drive();
      expect(docs.live()).toEqual(all);
      expect(disk(next)).toEqual(all);
      expect(asked(next)).toBe(0);
      await next.engine.stop();
    });
  },
);

// The marker goes with the question: settled, nothing is taken for new later.
describe('SyncEngine — a note deleted by a teammate, its question settled', () => {
  it.each(['delete-local', 'restore-server'] as const)(
    'forgets the question once answered (%s)',
    async (answer) => {
      const idb = new FakeIndexedDb();
      const h = buildHarness({ docs: idb.manager() });
      const server = new FakeServer(h, 'current');
      const docs = new ServerDocs(server, h);
      await remember(h, 'Plan.md', 'f1', 'old\n');
      await docs.add('f1', 'Plan.md', 'old\n');
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      await docs.restWrite('f1', 'old plan\n');
      await docs.drive();
      await h.settle();

      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await flushAsync(20);
      server.teammateDelete('f1');
      h.socket().connect();
      await flushAsync();
      await join(h, server, docs, 'current');
      await flushAsync(20);
      expect(asked(h)).toBe(1);
      expect(h.log.deleteAskedIds('b1')).toEqual(new Set(['f1']));

      h.modal.del.resolve(answer);
      await flushAsync(40);
      await docs.drive();
      await h.settle();
      expect(h.log.deleteAskedIds('b1')).toEqual(new Set());
      const kept = answer === 'restore-server' ? ['Plan.md=old plan\nmine\n'] : [];
      expect(docs.live()).toEqual(kept);
      expect(disk(h)).toEqual(kept);
      await h.engine.stop();
    },
  );
});

// Created again while the question is open, live: the file under the id is
// the new note from then on, and the question is no longer about it. An
// offline edit of the new note made after merges into it on the next
// connect — not taken for an edit of the deleted one, set aside.
describe.each(['current', 'legacy'] as BroadcastFormat[])(
  'SyncEngine — a note deleted by a teammate and created again while its question is open (%s server)',
  (format) => {
    it('takes an offline edit of the new note for one, on the next connect', async () => {
      const idb = new FakeIndexedDb();
      const h = buildHarness({ docs: idb.manager() });
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
      await remember(h, 'Plan.md', 'f1', 'old\n');
      await docs.add('f1', 'Plan.md', 'old\n');
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      await docs.restWrite('f1', 'old plan\n');
      await docs.drive();
      await h.settle();

      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('old plan\nmine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await flushAsync(20);
      server.teammateDelete('f1');
      h.socket().connect();
      await flushAsync();
      await join(h, server, docs, format);
      await flushAsync(20);
      expect(asked(h)).toBe(1);

      // Not answered; the teammate creates the note again, live.
      await server.teammateCreate('Plan.md', 'new plan\n');
      await docs.drive();
      await h.settle();
      await docs.drive();
      const copies = (): string[] =>
        [...h.vault.files.keys()].filter((p) => p.startsWith('Plan.conflict-'));
      expect(copies()).toHaveLength(1);
      const copy = copies()[0] ?? '';
      expect(h.vault.text('Plan.md')).toBe('new plan\n');
      expect(h.log.deleteAskedIds('b1')).toEqual(new Set());

      // Typed into the new note offline.
      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('new plan\nlater\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await flushAsync(20);
      h.socket().connect();
      await flushAsync();
      await join(h, server, docs, format);
      await flushAsync(40);
      await docs.drive();

      const all = [`${copy}=old plan\nmine\n`, 'Plan.md=new plan\nlater\n'];
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      await h.engine.stop();
    });
  },
);
