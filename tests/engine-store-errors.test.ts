/**
 * A rename when IndexedDB refuses to delete a note's offline store.
 *
 * A rename moves the note's history to its new name and deletes the database
 * of the old one. y-indexeddb rejects that delete when its database never
 * opened, and the error used to end the rename: made here, it was neither
 * sent nor queued while the index already had the new name — the next
 * connect moved the file back; made by a teammate, the engine went to
 * status `error`.
 */
import { DocManager } from '@/crdt/doc-manager';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  eventLog,
  flushAsync,
  type Harness,
} from './engine-test-kit';

/** Docs whose stores refuse to be deleted, as y-indexeddb does over a broken database. */
function undeletable(idb: FakeIndexedDb): DocManager {
  return new DocManager({
    persistenceFactory: (name, doc) => {
      const p = idb.factory(name, doc);
      if (p) p.clearData = () => Promise.reject(new Error('UnknownError: Internal error'));
      return p;
    },
    idb: idb.registry,
  });
}

/** `a.md` created here and acked as f1, with a line typed into it. */
async function createdNote(h: Harness): Promise<void> {
  h.vault.files.set('a.md', encode(''));
  const created = h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'create',
    path: 'a.md',
    source: 'obsidian',
  });
  await flushAsync();
  h.socket()
    .pending('file:create', 'a.md')
    .ack({ ok: true, outcome: { fileId: 'f1', path: 'a.md' } });
  await created;
  h.vault.files.set('a.md', encode('text\n'));
  await h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'modify',
    path: 'a.md',
    source: 'obsidian',
  });
  await flushAsync();
}

/** Rename a.md → b.md in Obsidian; resolves once the engine is done with it. */
function renameHere(h: Harness): Promise<void> {
  h.vault.files.set('b.md', h.vault.files.get('a.md') ?? encode(''));
  h.vault.files.delete('a.md');
  return h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'rename',
    oldPath: 'a.md',
    newPath: 'b.md',
    source: 'obsidian',
  });
}

describe('SyncEngine — a rename when the old offline store cannot be deleted', () => {
  it('sends a rename made here', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: undeletable(idb) });
    await connect(h);
    await createdNote(h);

    const renamed = renameHere(h);
    await flushAsync(20);
    h.socket().pending('file:rename', 'a.md').ack({ ok: true });
    await renamed;

    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(idb.textOf(dbNameOf('b.md'))).toBe('text\n');
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('queues a rename made here offline', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: undeletable(idb) });
    await connect(h);
    await createdNote(h);
    h.socket().disconnect();
    await flushAsync();

    await renameHere(h);

    expect(h.log.dequeueOperations('b1').map((o) => [o.opType, o.filePath, o.newPath])).toEqual([
      ['RENAME', 'a.md', 'b.md'],
    ]);
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    await h.engine.stop();
  });

  it.each([
    ['sends', true],
    ['queues', false],
  ])('%s a rename made here even when its records could not be moved', async (_label, online) => {
    class FailingMove extends DocManager {
      override move(): never {
        throw new Error('UnknownError: Internal error');
      }
    }
    const h = buildHarness({ docs: new FailingMove() });
    await connect(h);
    await createdNote(h);
    if (!online) {
      h.socket().disconnect();
      await flushAsync();
    }

    const renamed = renameHere(h);
    await flushAsync(20);
    if (online) h.socket().pending('file:rename', 'a.md').ack({ ok: true });
    await renamed;

    const queued = h.log.dequeueOperations('b1').map((o) => [o.opType, o.filePath, o.newPath]);
    expect(queued).toEqual(online ? [] : [['RENAME', 'a.md', 'b.md']]);
    await h.engine.stop();
  });

  it('applies a teammate’s rename without going to error', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: undeletable(idb) });
    await connect(h);
    await createdNote(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(30);

    expect(h.engine.getStatus()).toBe('connected');
    expect(h.vault.text('b.md')).toBe('text\n');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(idb.textOf(dbNameOf('b.md'))).toBe('text\n');
    await h.engine.stop();
  });
});
