/**
 * A rename made in Obsidian, and what happens under the new name while the
 * rename is still being carried out.
 *
 * 0.3.8 moved a renamed note's records only once it had waited for the work
 * on the old name to end (a save being folded in, which may wait up to 15 s
 * for the note's state from the server) and for its offline history to move
 * in IndexedDB. Until then the new name was unknown: a save under it was
 * uploaded as a new file — the server then put the renamed note under a
 * conflict name, a duplicate for the whole team — and a second quick rename
 * was queued without the file id, dropped, and uploaded as a new file on the
 * next connect. The save stuck on the old name then read a file that was no
 * longer there and failed.
 *
 * The records now move at once; the history follows under both names' locks.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { DocManager, type DocPersistence } from '@/crdt/doc-manager';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  deferred,
  encode,
  eventLog,
  flushAsync,
  remoteEdit,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Deferred,
  type Harness,
} from './engine-test-kit';

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<string> {
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
  return hash;
}

const modify = (h: Harness, path: string): Promise<void> =>
  h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });

function applySent(h: Harness, serverDoc: Y.Doc, fileId: string): void {
  for (const e of h.socket().emits) {
    const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
    if (e.event === 'yjs:update' && p.fileId === fileId && p.update) {
      Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
    }
  }
}

const renamesSent = (h: Harness): unknown[] =>
  h
    .socket()
    .emits.filter((e) => e.event === 'file:rename')
    .map((e) => e.payload);

describe('SyncEngine — while a local rename is being carried out', () => {
  it('takes a save under the new name for the renamed note, not a new file', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    const d1 = serverDocWith('A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);

    // A save: its fold waits for the note's state (the catch-up skipped it).
    h.vault.files.set('a.md', encode('A\ntyped\n'));
    const save = modify(h, 'a.md');
    await flushAsync(10);
    expect(h.socket().fetches).toHaveLength(1);

    // Renamed through the inline title; typing goes on under the new name.
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    h.vault.files.set('b.md', encode('A\ntyped\nmore\n'));
    const typed = modify(h, 'b.md');
    await flushAsync(10);

    expect(h.socket().created()).toEqual([]);
    expect(renamesSent(h)).toEqual([
      expect.objectContaining({ fileId: 'f1', filePath: 'a.md', newPath: 'b.md' }),
    ]);

    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    h.socket().pending('file:rename').ack({ ok: true });
    await expect(save).resolves.toBeUndefined();
    await expect(typed).resolves.toBeUndefined();
    await h.settle();
    applySent(h, d1, 'f1');

    expect(h.socket().created()).toEqual([]);
    expect(d1.getText('content').toJSON()).toBe('A\ntyped\nmore\n');
    expect(h.vault.text('b.md')).toBe('A\ntyped\nmore\n');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('sends a second quick rename with the file id and carries the history to the end', async () => {
    const idb = new FakeIndexedDb();
    let gate: Deferred<void> | null = null;
    const docs = new DocManager({
      persistenceFactory: (name, doc): DocPersistence | null => {
        const p = idb.factory(name, doc);
        if (p && name === dbNameOf('a.md') && gate) {
          const loaded = p.whenSynced;
          const g = gate;
          p.whenSynced = g.promise.then(() => loaded);
        }
        return p;
      },
      idb: idb.registry,
    });
    const d1 = serverDocWith('A\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(d1)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs });
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    expect(h.doc.has('b1', 'a.md')).toBe(false);

    // The history's store loads slowly: the first move is still under way
    // when the note is renamed again (Templater: rename, then move).
    gate = deferred<void>();
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    await h.vault.rename('b.md', 'c.md');
    await flushAsync(10);
    gate.resolve();
    for (const e of h.socket().emits) if (e.event === 'file:rename') e.ack({ ok: true });
    await h.settle();

    expect(renamesSent(h)).toEqual([
      expect.objectContaining({ fileId: 'f1', filePath: 'a.md', newPath: 'b.md' }),
      expect.objectContaining({ fileId: 'f1', filePath: 'b.md', newPath: 'c.md' }),
    ]);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
    expect(h.log.listFileMeta('b1').map((m) => m.relativePath)).toEqual(['c.md']);
    expect(idb.textOf(dbNameOf('c.md'))).toBe('A\n');
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.dbs.has(dbNameOf('b.md'))).toBe(false);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('keeps a teammate’s edit that arrives while the history moves', async () => {
    const idb = new FakeIndexedDb();
    let listGate: Deferred<void> | null = null;
    const docs = new DocManager({
      persistenceFactory: idb.factory,
      idb: {
        list: () =>
          (listGate ? listGate.promise : Promise.resolve()).then(() => idb.registry.list()),
        delete: (name) => idb.registry.delete(name),
      },
    });
    const h = buildHarness({ docs });
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    // The server has more than the disk: the catch-up opens the doc.
    const d1 = serverDocWith('A\n');
    d1.getText('content').insert(2, 'S\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await h.settle();
    expect(h.vault.text('a.md')).toBe('A\nS\n');
    expect(h.doc.has('b1', 'a.md')).toBe(true);

    listGate = deferred<void>();
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    remoteEdit(h, d1, 'f1', 'T\n');
    await flushAsync(10);
    listGate.resolve();
    h.socket().pending('file:rename').ack({ ok: true });
    await h.settle();

    expect(h.vault.text('b.md')).toBe('T\nA\nS\n');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('T\nA\nS\n');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('uploads a file it never synced under the name it is renamed to', async () => {
    const h = buildHarness();
    await connect(h);
    // On disk, never uploaded (its first upload failed, say).
    h.vault.files.set('draft.md', encode('D\n'));

    await h.vault.rename('draft.md', 'Plan.md');
    await flushAsync(10);

    expect(h.socket().created()).toEqual(['Plan.md']);
    expect(renamesSent(h)).toEqual([]);
    h.socket()
      .pending('file:create')
      .ack({
        ok: true,
        outcome: { kind: 'created', fileId: 'f7', path: 'Plan.md' },
      });
    await h.settle();
    expect(h.engine.getFileIdForPath('Plan.md')).toBe('f7');
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    await h.engine.stop();
  });

  it('folds a save made just before the rename into the note under its new name', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    const d1 = serverDocWith('A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);

    h.vault.files.set('a.md', encode('A\ntyped\n'));
    const save = modify(h, 'a.md');
    await flushAsync(10);
    // Renamed while the save waits for the note's state; nothing typed since.
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    h.socket().pending('file:rename').ack({ ok: true });
    await expect(save).resolves.toBeUndefined();
    await h.settle();
    applySent(h, d1, 'f1');

    expect(d1.getText('content').toJSON()).toBe('A\ntyped\n');
    expect(h.vault.text('b.md')).toBe('A\ntyped\n');
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it.each([
    ['its stored history loads', 'slow-store'],
    ['its state cannot be fetched', 'no-fetch'],
  ] as const)('folds a save into the renamed note while %s', async (_label, variant) => {
    const idb = new FakeIndexedDb();
    let gate: Deferred<void> | null = null;
    const docs = new DocManager({
      persistenceFactory: (name, doc): DocPersistence | null => {
        const p = idb.factory(name, doc);
        if (p && name === dbNameOf('a.md') && gate) {
          const loaded = p.whenSynced;
          const g = gate;
          p.whenSynced = g.promise.then(() => loaded);
        }
        return p;
      },
      idb: idb.registry,
    });
    const d1 = serverDocWith('A\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(d1)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs });
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    // `slow-store`: no catch-up for the note, whose history loads slowly.
    // `no-fetch`: the catch-up skipped it, and the server cannot send it.
    await connect(h, variant === 'no-fetch' ? { yjsDocs: [snapshotOf(d1, 'f1')] } : {});
    await flushAsync(20);
    if (variant === 'slow-store') gate = deferred<void>();

    h.vault.files.set('a.md', encode('A\ntyped\n'));
    const save = modify(h, 'a.md');
    await flushAsync(10);
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    h.socket().pending('file:rename').ack({ ok: true });
    if (gate) gate.resolve();
    for (const f of h.socket().fetches.splice(0)) f.answer({ ok: false, error: 'timeout' });
    await expect(save).resolves.toBeUndefined();
    await h.settle();
    applySent(h, d1, 'f1');

    expect(d1.getText('content').toJSON()).toBe('A\ntyped\n');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\ntyped\n');
    expect(h.vault.text('b.md')).toBe('A\ntyped\n');
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('keeps a teammate’s new note under the old name out of the renamed note’s history', async () => {
    const idb = new FakeIndexedDb();
    const d1 = serverDocWith('A\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(d1)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);

    // A save waits for the note's state; the note is renamed meanwhile, so
    // its history has not left the old name yet.
    h.vault.files.set('a.md', encode('A\ntyped\n'));
    const save = modify(h, 'a.md');
    await flushAsync(10);
    await h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    // A teammate creates a note under the freed name, and its text arrives.
    const d2 = serverDocWith('NEW\n');
    h.socket().fire('file:created', {
      result: { outcome: { kind: 'created', fileId: 'f2', path: 'a.md' } },
      log: eventLog,
      clientId: 'device-2',
    });
    h.socket().fire('yjs:update', { fileId: 'f2', update: Array.from(Y.encodeStateAsUpdate(d2)) });
    await flushAsync(10);

    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    h.socket().pending('file:rename').ack({ ok: true });
    await save;
    await h.settle();
    await flushAsync(40);
    applySent(h, d1, 'f1');

    expect(h.vault.text('b.md')).toBe('A\ntyped\n');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\ntyped\n');
    expect(d1.getText('content').toJSON()).toBe('A\ntyped\n');
    expect(h.vault.text('a.md')).toBe('NEW\n');
    expect(h.doc.getText('b1', 'a.md')).toBe('NEW\n');
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('keeps an offline edit when sync stops before the renamed note’s history has moved', async () => {
    const idb = new FakeIndexedDb();
    const d1 = serverDocWith('A\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(d1)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    h.socket().disconnect();
    await flushAsync();

    // Offline: an edit folded into the note's history.
    h.vault.files.set('a.md', encode('A\nX\n'));
    await modify(h, 'a.md');
    expect(h.log.getFileMeta('b1', 'a.md')?.foldedHash).toBe(await sha256Hex('A\nX\n'));
    // Another save holds the name while it reads the disk; the note is renamed
    // then, and sync stops before its history could move.
    const read = h.vault.gate('exists');
    const save = modify(h, 'a.md');
    await read.reached;
    const renamed = h.vault.rename('a.md', 'b.md');
    await flushAsync(10);
    await h.engine.stop();
    read.release();
    await renamed;
    await save;
    await h.settle();
    await h.doc.destroy();

    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(next, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(40);
    next.socket().pending('file:rename').ack({ ok: true });
    await next.settle();
    applySent(next, d1, 'f1');

    expect([...next.vault.files.keys()]).toEqual(['b.md']);
    expect(next.vault.text('b.md')).toBe('A\nX\n');
    expect(d1.getText('content').toJSON()).toBe('A\nX\n');
    await next.engine.stop();
  });
});
