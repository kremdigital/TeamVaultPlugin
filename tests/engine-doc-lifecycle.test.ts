/**
 * A note's doc across reconnects, `stop()` and renames: subscribed once, moved
 * in one piece, closed when nobody has it open.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { DocManager, type DocPersistence } from '@/crdt/doc-manager';
import {
  FakeIndexedDb,
  buildHarness,
  bytes,
  connect,
  dbNameOf,
  deferred,
  encode,
  eventLog,
  flushAsync,
  json,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

const OWNER = 'team-vault-file-id';

/** `path` (f1) last synced as `synced`; the disk holds `onDisk`, folded as `folded`. */
async function remember(
  h: Harness,
  path: string,
  synced: string,
  onDisk: string = synced,
  folded: string = synced,
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, encode(onDisk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: 'f1',
    contentHash: hash,
    size: encode(synced).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: await sha256Hex(folded),
  });
  return hash;
}

function store(idb: FakeIndexedDb, path: string, doc: Y.Doc, owner: string): void {
  idb.dbs.set(dbNameOf(path), {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map([[OWNER, owner]]),
  });
}

/** `yjs:update`s sent for f1 from emit `from` on. */
function sent(h: Harness, from = 0): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const e of h.socket().emits.slice(from)) {
    const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
    if (e.event === 'yjs:update' && p.fileId === 'f1' && p.update) {
      out.push(Uint8Array.from(p.update));
    }
  }
  return out;
}

const modify = (h: Harness, path: string): Promise<void> =>
  h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });

async function rejoin(h: Harness, yjsDocs: unknown[] = []): Promise<void> {
  h.socket().disconnect();
  h.socket().connect();
  await flushAsync();
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs });
  await flushAsync(40);
}

describe('SyncEngine — a note’s subscription', () => {
  it('sends an edit once after reconnects', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'a.md', 'A\n', 'A\nx\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    const d1 = serverDocWith('A\n');
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    await rejoin(h);
    await rejoin(h);

    const mark = h.socket().emits.length;
    h.vault.files.set('a.md', encode('A\nx\ny\n'));
    await modify(h, 'a.md');
    await flushAsync(20);

    expect(sent(h, mark)).toHaveLength(1);
    await h.engine.stop();
  });
});

describe('SyncEngine — a note renamed by a teammate while its doc is not open', () => {
  it('keeps no doc open under the new name, and its store holds the history', async () => {
    const idb = new FakeIndexedDb();
    const d1 = serverDocWith('A\n');
    store(idb, 'a.md', d1, 'f1');
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'a.md', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    expect(h.doc.has('b1', 'a.md')).toBe(false);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);

    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.doc.has('b1', 'b.md')).toBe(false);
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\n');
    expect(idb.dbs.get(dbNameOf('b.md'))?.custom.get(OWNER)).toBe('f1');

    // The next catch-up still skips the note: disk and server agree.
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', hash, 2)];
    await rejoin(h, [snapshotOf(d1, 'f1')]);
    expect(h.doc.has('b1', 'b.md')).toBe(false);

    // An edit opens it from the store, and goes out once.
    const mark = h.socket().emits.length;
    h.vault.files.set('b.md', encode('A\nmine\n'));
    const edit = modify(h, 'b.md');
    await flushAsync(20);
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    await edit;
    await flushAsync(20);
    const updates = sent(h, mark);
    expect(updates).toHaveLength(1);
    for (const u of updates) Y.applyUpdate(d1, u);
    expect(d1.getText('content').toJSON()).toBe('A\nmine\n');
    await h.engine.stop();
  });
});

describe('SyncEngine — a teammate’s edit arriving while their rename moves the doc', () => {
  it('is written to the disk under the new name', async () => {
    const idb = new FakeIndexedDb();
    // The store under a.md loads only when the test lets it.
    const gate = deferred<void>();
    const slow = new DocManager({
      persistenceFactory: (name, doc): DocPersistence | null => {
        const p = idb.factory(name, doc);
        if (p && name === dbNameOf('a.md')) {
          const loaded = p.whenSynced;
          p.whenSynced = gate.promise.then(() => loaded);
        }
        return p;
      },
      idb: idb.registry,
    });
    const d1 = serverDocWith('A\n');
    store(idb, 'a.md', d1, 'f1');
    // A snapshot debounce long enough to still be pending when the move ends.
    const h = buildHarness({ docs: slow, diskSnapshotDebounceMs: 200 });
    const hash = await remember(h, 'a.md', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    expect(h.doc.has('b1', 'a.md')).toBe(false);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(5);
    const seen = Y.encodeStateVector(d1);
    d1.getText('content').insert(2, 'T\n');
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(d1, seen)),
    });
    gate.resolve();
    await flushAsync(5);
    expect(h.vault.text('b.md')).toBe('A\n');

    await new Promise((r) => setTimeout(r, 300));
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    await flushAsync(30);

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('A\nT\n');
    await h.engine.stop();
  });
});

describe('SyncEngine — stop() while a teammate’s rename moves a note’s doc', () => {
  it('finishes the move, and the next engine sends the offline edit once', async () => {
    const idb = new FakeIndexedDb();
    // Docs whose store under b.md loads only when the test lets it.
    const gate = deferred<void>();
    const slow = new DocManager({
      persistenceFactory: (name, doc): DocPersistence | null => {
        const p = idb.factory(name, doc);
        if (p && name === dbNameOf('b.md')) {
          const loaded = p.whenSynced;
          p.whenSynced = gate.promise.then(() => loaded);
        }
        return p;
      },
      idb: idb.registry,
    });
    const d1 = serverDocWith('A\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d1));
    local.getText('content').insert(2, 'offline\n');
    store(idb, 'a.md', local, 'f1');
    const h = buildHarness({ docs: slow });
    const hash = await remember(h, 'a.md', 'A\n', 'A\noffline\n', 'A\noffline\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h);
    await flushAsync(20);
    // The note is open.
    await h.doc.whenSynced('b1', 'a.md');
    await flushAsync();

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);
    const stopped = h.engine.stop();
    await flushAsync();
    gate.resolve();
    await stopped;
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\noffline\n');
    await h.doc.destroy();

    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f1', 'b.md', 'TEXT', hash, 2)];
    await connect(next, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(30);
    const updates = sent(next);
    expect(updates).toHaveLength(1);
    for (const u of updates) Y.applyUpdate(d1, u);
    expect(d1.getText('content').toJSON()).toBe('A\noffline\n');
    expect(next.vault.text('b.md')).toBe('A\noffline\n');
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });
});

describe('SyncEngine — a save being folded when a teammate renames the note', () => {
  it('lands in the note’s doc, and reaches the server and the new name', async () => {
    // The server: "A\n", then "B\n" typed here, then a teammate's "T\n" on
    // top. The store has all of it; the disk still has "A\nB\n", folded.
    const d1 = serverDocWith('A\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d1));
    local.getText('content').insert(2, 'B\n');
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(local, Y.encodeStateVector(d1)));
    d1.getText('content').insert(0, 'T\n');
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(local)));
    const idb = new FakeIndexedDb();
    store(idb, 'a.md', local, 'f1');
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'a.md', 'A\n', 'A\nB\n', 'A\nB\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    // The fold's base comes from the version history, held until the rename.
    const held = deferred<void>();
    const baseHash = await sha256Hex('A\nB\n');
    h.routes.set('GET /api/projects/p1/files/f1/versions', async () => {
      await held.promise;
      return json({
        versions: [
          { id: 'v1', contentHash: baseHash, size: 4, createdAt: '', authorId: 'u1', fileId: 'f1' },
        ],
      });
    });
    h.routes.set('GET /api/projects/p1/files/f1/versions/v1', () => bytes(encode('A\nB\n')));
    await connect(h);
    await flushAsync(20);
    const mark = h.socket().emits.length;

    h.vault.files.set('a.md', encode('A\nB\nX\n'));
    const save = modify(h, 'a.md');
    await flushAsync(20);
    expect(h.requests.map((r) => r.path)).toContain('/api/projects/p1/files/f1/versions');
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);
    held.resolve();
    await save;
    await flushAsync(40);

    for (const u of sent(h, mark)) Y.applyUpdate(d1, u);
    expect(d1.getText('content').toJSON()).toBe('T\nA\nB\nX\n');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('T\nA\nB\nX\n');
    await h.engine.stop();
  });
});
