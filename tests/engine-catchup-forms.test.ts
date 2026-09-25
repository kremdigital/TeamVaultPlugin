/**
 * The two forms of the operation catch-up `project:join` answers with (see
 * `sync-protocol.md`, «Подключение»), and what the engine concludes from each.
 *
 * The plugin asks for every operation its clock has not seen, from the whole
 * journal (`operationsCatchup: 2`). A server that knows the flag says so in
 * its answer, and may cut a long catch-up short to its newest operations
 * (`operationsTruncated`). One that does not — production when 0.3.8 came out
 * — answers with the unseen operations among the journal's first 500 rows:
 * none at all on a longer project. Only a whole catch-up, echoed and not cut
 * short, tells by what it leaves out; from any other, a missing operation
 * proves nothing.
 *
 * Before: a catch-up cut short between a note's DELETE and its CREATE took the
 * note for the deleted one, and merged what this device had done to that one
 * and never sent into the new note — on a server that continues a revived
 * note's history, which marks such a CREATE `revived` for this.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import type { ServerOperation } from '@/client/socket';
import {
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  buildHarness,
  bytes,
  encode,
  flushAsync,
  json,
  remoteEdit,
  type BroadcastFormat,
  type CatchupForm,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

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

/** `CREATE revived` for a CREATE the server marks as a revival, else the op's type. */
function kindOf(op: ServerOperation): string {
  const revived = (op.payload as { revived?: unknown } | null)?.revived === true;
  return revived ? `${op.opType} revived` : op.opType;
}

/** Connect (or connect again), answering the join in `form`. */
async function join(
  h: Harness,
  server: FakeServer,
  docs: ServerDocs,
  form: CatchupForm,
  rows?: number,
): Promise<void> {
  if (h.socketIfBuilt() === null) await h.engine.start();
  else h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack(
      server.joinAnswer(form, {
        yjsDocs: docs.snapshots(),
        ...(rows !== undefined ? { rows } : {}),
      }),
    );
  await docs.drive();
}

async function drop(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

async function withNotes(format: BroadcastFormat, notes: Array<[string, string, string]>) {
  const idb = new FakeIndexedDb();
  const h = buildHarness({ docs: idb.manager() });
  const server = new FakeServer(h, format);
  // The server of the `legacy` format replaces a revived note's history, as
  // production did when 0.3.8 came out.
  const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
  for (const [id, path, text] of notes) {
    await remember(h, path, id, text);
    await docs.add(id, path, text);
  }
  await join(h, server, docs, 'whole journal');
  return { idb, h, server, docs };
}

describe('SyncEngine — the catch-up asked for', () => {
  it('is the whole journal, at every connect', async () => {
    const { h, server, docs } = await withNotes('current', [['f1', 'a.md', 'A\n']]);
    await drop(h);
    await join(h, server, docs, 'first rows');

    const joins = h.socket().emits.filter((e) => e.event === 'project:join');
    expect(joins).toHaveLength(2);
    for (const e of joins) expect(e.payload).toMatchObject({ operationsCatchup: 2 });
    await h.engine.stop();
  });
});

// A server that continues the history cuts the catch-up short; the one before
// it gives the first rows, and starts a revived note's history anew.
describe.each([
  ['current', 'whole journal'],
  ['current', 'cut short'],
  ['legacy', 'first rows'],
] as const)(
  'SyncEngine — a note deleted and created again while away, %s server, %s',
  (format, form) => {
    it('keeps what this device did to the deleted note and never sent out of the new one', async () => {
      const { h, server, docs } = await withNotes(format, [['f1', 'Untitled.md', 'old text\n']]);
      h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
      // A teammate's edit brings the note's history into its store here.
      remoteEdit(h, docs.docs.get('f1') as Y.Doc, 'f1', 'shared\n');
      await docs.drive();
      expect(h.vault.text('Untitled.md')).toBe('shared\nold text\n');

      // Typed offline, never sent.
      await drop(h);
      h.vault.files.set('Untitled.md', encode('shared\nold text\nunsent line\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Untitled.md',
        source: 'obsidian',
      });
      await flushAsync(20);
      // Meanwhile a teammate deletes it and creates a new Untitled.md.
      server.teammateDelete('f1');
      await server.teammateCreate('Untitled.md', 'S2 text\n');
      const ops = server.joinAnswer(form).operations as ServerOperation[];
      const revived = format === 'current' ? 'CREATE revived' : 'CREATE';
      expect(ops.map((op) => kindOf(op))).toEqual(
        form === 'cut short' ? [revived] : ['DELETE', revived],
      );

      await join(h, server, docs, form, form === 'cut short' ? 1 : undefined);

      expect(docs.text('f1')).toBe('S2 text\n');
      expect(h.vault.text('Untitled.md')).toBe('S2 text\n');
      const copies = [...h.vault.files.keys()].filter((p) => p.includes('.conflict-'));
      expect(copies).toHaveLength(1);
      expect(h.vault.text(copies[0] ?? '')).toBe('shared\nold text\nunsent line\n');
      await h.engine.stop();
    });
  },
);

describe.each([
  ['whole journal', undefined],
  ['cut short', 1],
  // A project longer than the window: no operations at all.
  ['first rows', 0],
] as const)('SyncEngine — a catch-up, %s', (form, rows) => {
  it('brings an attachment a teammate added while this device was away', async () => {
    const { h, server, docs } = await withNotes('current', [
      ['f1', 'a.md', 'A\n'],
      ['f2', 'b.md', 'B\n'],
    ]);
    await drop(h);
    const pic = encode('their picture');
    const id = await server.teammateUpload('pic.png', pic);
    h.routes.set(`GET /api/projects/p1/files/${id}`, () => bytes(pic));
    // And renames a note after it.
    server.teammateRename('f2', 'c.md');

    await join(h, server, docs, form, rows);

    expect(h.vault.text('pic.png')).toBe('their picture');
    expect(h.vault.text('c.md')).toBe('B\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('forgets what was applied live only when it is whole', async () => {
    const { h, server, docs } = await withNotes('current', [
      ['f1', 'a.md', 'A\n'],
      ['f2', 'b.md', 'B\n'],
    ]);
    // Applied live: a teammate's new note. A rename follows while away.
    await server.teammateCreate('n.md', 'N\n');
    await docs.drive();
    const created = server.journal[server.journal.length - 1]?.id ?? '';
    expect(h.log.appliedLiveIds('b1')).toContain(created);
    await drop(h);
    server.teammateRename('f2', 'c.md');

    await join(h, server, docs, form, rows);

    expect(h.vault.text('n.md')).toBe('N\n');
    expect(h.vault.text('c.md')).toBe('B\n');
    // Returned by the whole catch-up: the clock has it now. Left out of the
    // others, it may come again.
    if (form === 'whole journal') expect(h.log.appliedLiveIds('b1')).not.toContain(created);
    else expect(h.log.appliedLiveIds('b1')).toContain(created);
    await h.engine.stop();
  });
});
