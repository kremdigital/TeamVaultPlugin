/**
 * A note's CRDT history belongs to the note, not to its name.
 *
 * Docs and their offline stores (y-indexeddb) are kept by path, and a path
 * changes hands: a note renamed away, deleted, a new one created under its
 * name. The doc used to stay where it was:
 *
 * - a note renamed while this device was offline lost an edit folded into its
 *   doc in the meantime — the doc stayed under the old name, the fold marker
 *   moved with the file and said the edit was in;
 * - the next note under the old name took the previous note's history: mixed
 *   text on disk and, through the catch-up's push-back or the live fan-out,
 *   on the server for the whole team. Obsidian reuses "Untitled" for every
 *   new note, so this happened in ordinary use.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  eventLog,
  flushAsync,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/**
 * A file this device synced earlier: on disk, and in `state.json` at `path`
 * with the hash of `synced` — the disk may hold `onDisk` since.
 */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: ArrayBuffer,
  onDisk: ArrayBuffer = synced,
  fileType: FileType = 'TEXT',
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, onDisk);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: synced.byteLength,
    fileType,
    lastSyncedAt: 1,
    ...(fileType === 'TEXT' ? { foldedHash: hash } : {}),
  });
  return hash;
}

const rename = (from: string, to: string, fileId: string, clock: number) =>
  op('RENAME', from, to, { fileId }, clock);

/** Apply every `yjs:update` the engine sent for `fileId` (from emit `from` on). */
function applySent(h: Harness, serverDoc: Y.Doc, fileId: string, from = 0): void {
  for (const e of h.socket().emits.slice(from)) {
    if (e.event !== 'yjs:update') continue;
    const p = e.payload as { fileId: string; update: Uint8Array | number[] };
    if (p.fileId === fileId) Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
  }
}

/** Updates the engine sent for `fileId` from emit `from` on. */
function sentFor(h: Harness, fileId: string, from = 0): number {
  return h
    .socket()
    .emits.slice(from)
    .filter((e) => e.event === 'yjs:update' && (e.payload as { fileId: string }).fileId === fileId)
    .length;
}

/** Disconnect and connect again, answering the join with `join`. */
async function rejoin(
  h: Harness,
  join: { operations?: unknown[]; yjsDocs?: unknown[] } = {},
): Promise<void> {
  h.socket().disconnect();
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: join.operations ?? [], yjsDocs: join.yjsDocs ?? [] });
  await flushAsync(40);
}

const modify = (h: Harness, path: string): Promise<void> =>
  h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });

/** Create `path` in Obsidian; the server acks it as `fileId`. */
async function createNote(h: Harness, path: string, fileId: string): Promise<void> {
  h.vault.files.set(path, encode(''));
  const done = h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'create',
    path,
    source: 'obsidian',
  });
  await flushAsync();
  h.socket().pending('file:create', path).ack({ ok: true, outcome: { fileId, path } });
  await done;
  await flushAsync();
}

async function type(h: Harness, path: string, text: string): Promise<void> {
  h.vault.files.set(path, encode(text));
  await modify(h, path);
  await flushAsync();
}

/** Connect with `a.md` (f1) synced as `A\n` and an unsent `mine` line on disk. */
async function connectWithEditedNote(h: Harness): Promise<Y.Doc> {
  await remember(h, 'a.md', 'f1', encode('A\n'), encode('A\nmine\n'));
  const d1 = serverDocWith('A\n');
  h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];
  await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
  await flushAsync(20);
  applySent(h, d1, 'f1');
  expect(d1.getText('content').toJSON()).toBe('A\nmine\n');
  return d1;
}

describe('SyncEngine — an edit folded while offline, the note renamed meanwhile', () => {
  it('keeps the edit when a teammate renamed the note while this device was offline', async () => {
    const h = buildHarness();
    const d1 = await connectWithEditedNote(h);

    // Offline, Obsidian open: the edit is folded into the note's doc.
    h.socket().disconnect();
    await flushAsync();
    h.vault.files.set('a.md', encode('A\nmine\noffline\n'));
    await modify(h, 'a.md');
    await flushAsync();
    expect(h.log.getFileMeta('b1', 'a.md')?.foldedHash).toBe(await sha256Hex('A\nmine\noffline\n'));

    // Meanwhile a teammate renames a.md → b.md.
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7)];
    await rejoin(h, {
      operations: [rename('a.md', 'b.md', 'f1', 5)],
      yjsDocs: [snapshotOf(d1, 'f1')],
    });
    applySent(h, d1, 'f1');

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('A\nmine\noffline\n');
    expect(d1.getText('content').toJSON()).toBe('A\nmine\noffline\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('keeps it across a restart, from the offline store', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const d1 = await connectWithEditedNote(h);
    h.socket().disconnect();
    await flushAsync();
    h.vault.files.set('a.md', encode('A\nmine\noffline\n'));
    await modify(h, 'a.md');
    await flushAsync();
    await h.engine.stop();
    await h.doc.destroy(); // Obsidian closed.

    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7)];
    await connect(next, {
      operations: [rename('a.md', 'b.md', 'f1', 5)],
      yjsDocs: [snapshotOf(d1, 'f1')],
    });
    await flushAsync(20);
    applySent(next, d1, 'f1');

    expect(next.vault.text('b.md')).toBe('A\nmine\noffline\n');
    expect(d1.getText('content').toJSON()).toBe('A\nmine\noffline\n');
    // The history moved: nothing is left under the old name.
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    await next.engine.stop();
  });
});

describe('SyncEngine — a new note under the name another one left', () => {
  it('does not take in a note renamed away while offline (doc still open)', async () => {
    const h = buildHarness();
    const d1 = await connectWithEditedNote(h);
    expect(h.doc.has('b1', 'a.md')).toBe(true);

    // Away: a.md → b.md, and a new a.md.
    const d3 = serverDocWith('new\n');
    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7),
      serverFile('f3', 'a.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];
    await rejoin(h, {
      operations: [
        rename('a.md', 'b.md', 'f1', 5),
        op('CREATE', 'a.md', null, { fileId: 'f3' }, 6),
      ],
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d3, 'f3')],
    });
    applySent(h, d3, 'f3');
    applySent(h, d1, 'f1');

    expect(h.vault.text('a.md')).toBe('new\n');
    expect(h.vault.text('b.md')).toBe('A\nmine\n');
    expect(d3.getText('content').toJSON()).toBe('new\n');
    expect(d1.getText('content').toJSON()).toBe('A\nmine\n');
    await h.engine.stop();
  });

  it('swaps two notes whose docs are open without mixing their histories', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'), encode('A\n1\n'));
    await remember(h, 'b.md', 'f2', encode('B\n'), encode('B\n2\n'));
    const d1 = serverDocWith('A\n');
    const d2 = serverDocWith('B\n');
    h.serverFiles = [
      serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f2', 'b.md', 'TEXT', await sha256Hex('B\n'), 2),
    ];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')] });
    await flushAsync(20);
    applySent(h, d1, 'f1');
    applySent(h, d2, 'f2');

    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\n1\n'), 4),
      serverFile('f2', 'a.md', 'TEXT', await sha256Hex('B\n2\n'), 4),
    ];
    await rejoin(h, {
      operations: [
        rename('a.md', 'tmp.md', 'f1', 5),
        rename('b.md', 'a.md', 'f2', 6),
        rename('tmp.md', 'b.md', 'f1', 7),
      ],
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')],
    });
    applySent(h, d1, 'f1');
    applySent(h, d2, 'f2');

    expect(h.vault.text('a.md')).toBe('B\n2\n');
    expect(h.vault.text('b.md')).toBe('A\n1\n');
    expect(d1.getText('content').toJSON()).toBe('A\n1\n');
    expect(d2.getText('content').toJSON()).toBe('B\n2\n');
    await h.engine.stop();
  });

  it('does not take in, after a restart, a note renamed away while Obsidian was closed', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const d1 = await connectWithEditedNote(h);
    await h.engine.stop();
    await h.doc.destroy();

    const d3 = serverDocWith('new\n');
    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7),
      serverFile('f3', 'a.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];
    await connect(next, {
      operations: [
        rename('a.md', 'b.md', 'f1', 5),
        op('CREATE', 'a.md', null, { fileId: 'f3' }, 6),
      ],
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d3, 'f3')],
    });
    await flushAsync(20);
    applySent(next, d3, 'f3');

    expect(next.vault.text('a.md')).toBe('new\n');
    expect(d3.getText('content').toJSON()).toBe('new\n');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\nmine\n');
    await next.engine.stop();
  });

  it('does not take in, after a restart, a note deleted while away', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'r.md', 'f2', encode('old\n'), encode('old\nmine\n'));
    const d2 = serverDocWith('old\n');
    h.serverFiles = [serverFile('f2', 'r.md', 'TEXT', await sha256Hex('old\n'), 4)];
    await connect(h, { yjsDocs: [snapshotOf(d2, 'f2')] });
    await flushAsync(20);
    applySent(h, d2, 'f2');
    await h.engine.stop();
    await h.doc.destroy();

    const d3 = serverDocWith('new\n');
    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f3', 'r.md', 'TEXT', await sha256Hex('new\n'), 4)];
    next.routes.set('GET /api/projects/p1/files/f2/versions', () => ({
      status: 200,
      json: { versions: [] },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    await connect(next, {
      operations: [
        op('DELETE', 'r.md', null, { fileId: 'f2' }, 5),
        op('CREATE', 'r.md', null, { fileId: 'f3' }, 6),
      ],
      yjsDocs: [snapshotOf(d3, 'f3')],
    });
    await flushAsync(20);
    applySent(next, d3, 'f3');

    expect(next.vault.text('r.md')).toBe('new\n');
    expect(d3.getText('content').toJSON()).toBe('new\n');
    await next.engine.stop();
  });

  it('does not take in a note renamed live by a teammate (Obsidian’s "Untitled")', async () => {
    const h = buildHarness();
    await connect(h);
    const created = (fileId: string, path: string, d: Y.Doc): void => {
      h.socket().fire('file:created', { result: { outcome: { fileId, path } }, log: eventLog });
      h.socket().fire('yjs:update', { fileId, update: Array.from(Y.encodeStateAsUpdate(d)) });
    };
    const d1 = serverDocWith('first\n');
    created('f1', 'Untitled.md', d1);
    await flushAsync(20);
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'Meeting.md', log: eventLog });
    await flushAsync(20);
    const d2 = serverDocWith('second\n');
    created('f2', 'Untitled.md', d2);
    await flushAsync(20);

    expect(h.vault.text('Untitled.md')).toBe('second\n');
    expect(h.vault.text('Meeting.md')).toBe('first\n');

    h.serverFiles = [
      serverFile('f1', 'Meeting.md', 'TEXT', await sha256Hex('first\n'), 6),
      serverFile('f2', 'Untitled.md', 'TEXT', await sha256Hex('second\n'), 7),
    ];
    await rejoin(h, { yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')] });
    applySent(h, d2, 'f2');
    applySent(h, d1, 'f1');
    expect(d2.getText('content').toJSON()).toBe('second\n');
    expect(d1.getText('content').toJSON()).toBe('first\n');
    await h.engine.stop();
  });

  it('keeps a note renamed in Obsidian apart from the next "Untitled"', async () => {
    const h = buildHarness();
    await connect(h);
    await createNote(h, 'Untitled.md', 'f1');
    await type(h, 'Untitled.md', 'first\n');
    const d1 = new Y.Doc();
    applySent(h, d1, 'f1');

    // Renamed in Obsidian: the vault event reaches the engine through the watcher.
    await h.vault.rename('Untitled.md', 'Meeting.md');
    await flushAsync();
    h.socket().pending('file:rename').ack({ ok: true });
    await h.settle();
    const mark = h.socket().emits.length;

    await createNote(h, 'Untitled.md', 'f3');
    await type(h, 'Untitled.md', 'second\n');
    await type(h, 'Meeting.md', 'first\nagenda\n');
    const d3 = new Y.Doc();
    applySent(h, d3, 'f3', mark);
    applySent(h, d1, 'f1', mark);

    expect(d3.getText('content').toJSON()).toBe('second\n');
    expect(d1.getText('content').toJSON()).toBe('first\nagenda\n');
    expect(h.doc.getText('b1', 'Untitled.md')).toBe('second\n');
    await h.engine.stop();
  });

  it('keeps a note deleted in Obsidian apart from a new one under its name', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    await connect(h);
    await createNote(h, 'Todo.md', 'f1');
    await type(h, 'Todo.md', 'old\n');

    await h.vault.delete('Todo.md');
    const deleting = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'delete',
      path: 'Todo.md',
      source: 'obsidian',
    });
    await flushAsync();
    h.socket().pending('file:delete').ack({ ok: true });
    await deleting;
    await flushAsync();
    expect(idb.dbs.has(dbNameOf('Todo.md'))).toBe(false);
    const mark = h.socket().emits.length;

    await createNote(h, 'Todo.md', 'f2');
    await type(h, 'Todo.md', 'new\n');
    const d2 = new Y.Doc();
    applySent(h, d2, 'f2', mark);

    expect(d2.getText('content').toJSON()).toBe('new\n');
    expect(sentFor(h, 'f1', mark)).toBe(0);
    expect(h.vault.text('Todo.md')).toBe('new\n');
    await h.engine.stop();
  });
});

describe('SyncEngine — edits after a note changed names', () => {
  it.each([
    ['in memory', false],
    ['with an offline store', true],
  ])(
    'sends an edit live after a teammate renamed a note whose doc was not open (%s)',
    async (_label, persist) => {
      const idb = new FakeIndexedDb();
      const h = buildHarness(persist ? { docs: idb.manager() } : {});
      const hash = await remember(h, 'a.md', 'f1', encode('A\n'));
      const d1 = serverDocWith('A\n');
      if (persist) {
        idb.dbs.set(dbNameOf('a.md'), { updates: [Y.encodeStateAsUpdate(d1)], custom: new Map() });
      }
      h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
      // Disk and server agree: the catch-up leaves the doc closed.
      await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
      await flushAsync(20);
      expect(h.doc.has('b1', 'a.md')).toBe(false);

      h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
      await flushAsync(20);
      const mark = h.socket().emits.length;
      h.vault.files.set('b.md', encode('A\nmore\n'));
      const editing = modify(h, 'b.md');
      await flushAsync(20);
      for (const f of h.socket().fetches) {
        f.answer({
          ok: true,
          sync1: Array.from(Y.encodeStateAsUpdate(d1)),
          stateVector: Array.from(Y.encodeStateVector(d1)),
        });
      }
      await editing;
      await flushAsync(20);
      applySent(h, d1, 'f1', mark);

      expect(sentFor(h, 'f1', mark)).toBeGreaterThan(0);
      expect(d1.getText('content').toJSON()).toBe('A\nmore\n');
      await h.engine.stop();
    },
  );

  it('sends each edit of a note created here once', async () => {
    const h = buildHarness();
    await connect(h);
    await createNote(h, 'n.md', 'f1');
    const mark = h.socket().emits.length;

    await type(h, 'n.md', 'x\n');

    expect(sentFor(h, 'f1', mark)).toBe(1);
    await h.engine.stop();
  });
});

describe('SyncEngine — an offline store another note left behind', () => {
  it('is started anew when it is stamped for another note', async () => {
    const idb = new FakeIndexedDb();
    // f9's history, stamped f9, under the name f1 has now — what a move cut
    // short by a crash leaves behind.
    const leftover = new Y.Doc();
    leftover.getText('content').insert(0, 'foreign\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(leftover)],
      custom: new Map([['team-vault-file-id', 'f9']]),
    });
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', encode('A\n'));
    const d1 = serverDocWith('A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];
    h.vault.files.set('a.md', encode('A\nmine\n'));

    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    applySent(h, d1, 'f1');

    expect(d1.getText('content').toJSON()).toBe('A\nmine\n');
    expect(h.vault.text('a.md')).toBe('A\nmine\n');
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get('team-vault-file-id')).toBe('f1');
    await h.engine.stop();
  });

  it('is kept, and stamped, when it has no stamp yet (a store from before 0.3.8)', async () => {
    const idb = new FakeIndexedDb();
    // Offline edits in the note's own store, written by an older build.
    const d1 = serverDocWith('A\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d1));
    local.getText('content').insert(2, 'offline\n');
    idb.dbs.set(dbNameOf('a.md'), { updates: [Y.encodeStateAsUpdate(local)], custom: new Map() });
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', encode('A\n'), encode('A\noffline\n'));
    const meta = h.log.getFileMeta('b1', 'a.md');
    if (!meta) throw new Error('no meta');
    h.log.setFileMeta({ ...meta, foldedHash: await sha256Hex('A\noffline\n') });
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];

    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    applySent(h, d1, 'f1');

    expect(d1.getText('content').toJSON()).toBe('A\noffline\n');
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get('team-vault-file-id')).toBe('f1');
    await h.engine.stop();
  });

  it('is not taken for the note of a name new to this device (left there by 0.3.7)', async () => {
    const idb = new FakeIndexedDb();
    // 0.3.7 moved a.md (f1) to b.md and left its history under a.md, with
    // no stamp. A teammate then created a new a.md (f3).
    const d1 = serverDocWith('A\n');
    const left = new Y.Doc();
    Y.applyUpdate(left, Y.encodeStateAsUpdate(d1));
    left.getText('content').insert(2, 'mine\n');
    idb.dbs.set(dbNameOf('a.md'), { updates: [Y.encodeStateAsUpdate(left)], custom: new Map() });
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'b.md', 'f1', encode('A\nmine\n'));
    const d3 = serverDocWith('new\n');
    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7),
      serverFile('f3', 'a.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];

    await connect(h, {
      operations: [op('CREATE', 'a.md', null, { fileId: 'f3' }, 6)],
      yjsDocs: [snapshotOf(d3, 'f3')],
    });
    await flushAsync(20);
    applySent(h, d3, 'f3');

    expect(h.vault.text('a.md')).toBe('new\n');
    expect(d3.getText('content').toJSON()).toBe('new\n');
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get('team-vault-file-id')).toBe('f3');
    await h.engine.stop();
  });

  it.each([
    ['by a teammate', true],
    ['here', false],
  ])(
    'is not taken for a note created %s under the name (left there by 0.3.7)',
    async (_label, remote) => {
      const idb = new FakeIndexedDb();
      // An older note's history under `Untitled.md`, without a stamp.
      const left = new Y.Doc();
      left.getText('content').insert(0, 'first\n');
      idb.dbs.set(dbNameOf('Untitled.md'), {
        updates: [Y.encodeStateAsUpdate(left)],
        custom: new Map(),
      });
      const h = buildHarness({ docs: idb.manager() });
      await connect(h);
      const mark = h.socket().emits.length;

      const d2 = serverDocWith('second\n');
      if (remote) {
        h.socket().fire('file:created', {
          result: { outcome: { fileId: 'f2', path: 'Untitled.md' } },
          log: eventLog,
        });
        h.socket().fire('yjs:update', {
          fileId: 'f2',
          update: Array.from(Y.encodeStateAsUpdate(d2)),
        });
        await flushAsync(20);
      } else {
        await createNote(h, 'Untitled.md', 'f2');
        h.socket().fire('yjs:update', {
          fileId: 'f2',
          update: Array.from(Y.encodeStateAsUpdate(d2)),
        });
        await flushAsync(20);
        await type(h, 'Untitled.md', 'second\nmore\n');
      }
      // What the team sees of the new note, update by update: the old note's
      // text never shows up in it, not even for a moment.
      const seen: string[] = [];
      for (const e of h.socket().emits.slice(mark)) {
        const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
        if (e.event !== 'yjs:update' || p.fileId !== 'f2' || !p.update) continue;
        Y.applyUpdate(d2, Uint8Array.from(p.update));
        seen.push(d2.getText('content').toJSON());
      }

      const expected = remote ? 'second\n' : 'second\nmore\n';
      expect(h.vault.text('Untitled.md')).toBe(expected);
      expect(d2.getText('content').toJSON()).toBe(expected);
      expect(seen.filter((text) => text.includes('first'))).toEqual([]);
      await h.engine.stop();
    },
  );

  it('deletes only the databases of the names that changed hands', async () => {
    const idb = new FakeIndexedDb();
    // Another vault's store and another binding's store on the same machine.
    idb.dbs.set('team-vault-b2-a.md', { updates: [], custom: new Map() });
    idb.dbs.set('team-vault-b1x-a.md', { updates: [], custom: new Map() });
    const h = buildHarness({ docs: idb.manager() });
    const d1 = await connectWithEditedNote(h);
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\nmine\n'), 7)];
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);
    applySent(h, d1, 'f1');

    expect(h.vault.text('b.md')).toBe('A\nmine\n');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\nmine\n');
    expect(idb.deleted).toEqual([dbNameOf('a.md')]);
    expect(idb.dbs.has('team-vault-b2-a.md')).toBe(true);
    expect(idb.dbs.has('team-vault-b1x-a.md')).toBe(true);
    await h.engine.stop();
  });
});
