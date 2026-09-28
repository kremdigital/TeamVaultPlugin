/**
 * `DocManager.noteWritten` and `DocManager.peek`: the mark of a note's text
 * written to disk, kept in the note's own y-indexeddb database, and a look at
 * what a database holds without opening a doc for the name — by its exact
 * name only: IndexedDB is one store for every vault on the machine.
 *
 * The engine checks after a crash whether a teammate's note on disk is what
 * it wrote there from this history (`SyncEngine.settleWrittenHere`); see
 * `engine-crash.test.ts`.
 */
import * as Y from 'yjs';
import { DocManager, type DocPersistence, type PersistenceFactory } from '@/crdt/doc-manager';
import { putOrdered } from '@/crdt/idb-persistence';
import { FOREIGN_DB, FakeIndexedDb, dbNameOf, deferred, flushAsync } from './engine-test-kit';

const OWNER = 'team-vault-file-id';
const WRITTEN = 'team-vault-written';

/** A database holding `text`, optionally stamped for `owner`. */
function seed(idb: FakeIndexedDb, name: string, text: string, owner?: string): void {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  idb.dbs.set(name, {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map(owner === undefined ? [] : [[OWNER, owner]]),
  });
  doc.destroy();
}

/** The mark stored in database `name`, parsed; `undefined` without one. */
function markIn(idb: FakeIndexedDb, name: string): unknown {
  const raw = idb.dbs.get(name)?.custom.get(WRITTEN);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** A doc open for `path`, stamped for `fileId`, holding `text`. */
async function opened(dm: DocManager, path: string, fileId: string, text: string): Promise<void> {
  await dm.open('b1', path, fileId);
  dm.setText('b1', path, text);
}

describe('DocManager — noteWritten', () => {
  it('puts the mark in the key/value area of the note’s own database', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual({ fileId: 'f1', hash: 'h1', over: '' });
    // What the next start of Obsidian finds.
    await expect(idb.manager().peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\n',
      written: { fileId: 'f1', hash: 'h1', over: '' },
    });
  });

  it('marks nothing on a doc stamped for another file, or not stamped', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('old.md'), 'old\n');
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f9', 'foreign\n');
    await dm.open('b1', 'old.md', 'f1');

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    dm.noteWritten('b1', 'old.md', { fileId: 'f1', hash: 'h1', over: '' });
    dm.noteWritten('b1', 'none.md', { fileId: 'f1', hash: 'h1', over: '' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toBeUndefined();
    expect(markIn(idb, dbNameOf('old.md'))).toBeUndefined();
    expect(idb.dbs.has(dbNameOf('none.md'))).toBe(false);
  });

  it('writes through `setOrdered`, once per mark, without waiting for it', async () => {
    const idb = new FakeIndexedDb();
    const writes: string[] = [];
    const landed = deferred<void>();
    // A store whose ordered writes land when the test says.
    const factory: PersistenceFactory = (name, doc) => {
      const inner = idb.factory(name, doc) as DocPersistence;
      return {
        ...inner,
        set: (key, value) => {
          writes.push(`set ${key}`);
          return inner.set!(key, value);
        },
        setOrdered: async (key, value) => {
          writes.push(`setOrdered ${key}`);
          await landed.promise;
          return inner.setOrdered!(key, value);
        },
      };
    };
    const dm = new DocManager({ persistenceFactory: factory, idb: idb.registry });
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    await flushAsync();
    writes.length = 0;

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h2', over: 'h1' });

    expect(writes).toEqual([`setOrdered ${WRITTEN}`, `setOrdered ${WRITTEN}`]);
    landed.resolve();
    await flushAsync();
    expect(markIn(idb, dbNameOf('n.md'))).toEqual({ fileId: 'f1', hash: 'h2', over: 'h1' });
  });

  it('writes through `set` on a store without `setOrdered`', async () => {
    const idb = new FakeIndexedDb();
    const factory: PersistenceFactory = (name, doc) => {
      const inner = idb.factory(name, doc) as DocPersistence;
      const plain = { ...inner };
      delete plain.setOrdered;
      return plain;
    };
    const dm = new DocManager({ persistenceFactory: factory, idb: idb.registry });
    await opened(dm, 'n.md', 'f1', 'theirs\n');

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual({ fileId: 'f1', hash: 'h1', over: '' });
  });

  it('goes with the database when the doc is deleted, and stays behind when it moves', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    await opened(dm, 'm.md', 'f2', 'moved\n');
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    dm.noteWritten('b1', 'm.md', { fileId: 'f2', hash: 'h2', over: '' });
    await flushAsync();

    await dm.clear('b1', 'n.md');
    await dm.move('b1', 'm.md', 'moved/m.md', 'f2', () => undefined);
    await dm.release('b1', 'moved/m.md');

    const next = idb.manager();
    await expect(next.peek('b1', 'n.md')).resolves.toBeNull();
    await expect(next.peek('b1', 'm.md')).resolves.toBeNull();
    await expect(next.peek('b1', 'moved/m.md')).resolves.toEqual({
      owner: 'f2',
      text: 'moved\n',
      written: null,
    });
  });

  it('is gone after the history is started anew under the name', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '' });
    await flushAsync();

    await dm.startOver('b1', 'n.md', 'f1');
    await dm.release('b1', 'n.md');

    await expect(idb.manager().peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: '',
      written: null,
    });
  });
});

describe('DocManager — peek', () => {
  it('opens no database for a name that has none, and creates none', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('a.md'), 'A\n', 'f1');
    const before = [...idb.dbs.keys()];
    const dm = idb.manager();

    await expect(dm.peek('b1', 'n.md')).resolves.toBeNull();

    expect([...idb.dbs.keys()]).toEqual(before);
    expect(idb.opened).toEqual([]);
    expect(idb.deleted).toEqual([]);
    expect(dm.has('b1', 'n.md')).toBe(false);
  });

  it('reads only the database under the exact name, never another vault’s', async () => {
    const idb = new FakeIndexedDb();
    // The same note in another vault of the machine (another binding).
    const other = `team-vault-b2-${encodeURIComponent('n.md')}`;
    seed(idb, other, 'theirs\n', 'f1');
    const dm = idb.manager();

    await expect(dm.peek('b1', 'n.md')).resolves.toBeNull();

    expect(idb.opened).toEqual([]);
    expect(idb.dbs.has(other)).toBe(true);
    expect(idb.dbs.has(FOREIGN_DB)).toBe(true);
  });

  it('reads the stamp, the text and the mark of a store, and closes it without deleting it', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\r\ntyping\r\n', 'f1');
    idb.dbs
      .get(dbNameOf('n.md'))
      ?.custom.set(WRITTEN, JSON.stringify({ fileId: 'f1', hash: 'h1', over: '' }));
    const dm = idb.manager();

    await expect(dm.peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\r\ntyping\r\n',
      written: { fileId: 'f1', hash: 'h1', over: '' },
    });

    expect(idb.opened).toEqual([dbNameOf('n.md')]);
    expect(idb.deleted).toEqual([]);
    // No doc was opened for the name: the next open loads it from the store.
    expect(dm.has('b1', 'n.md')).toBe(false);
  });

  it('gives up on a store that does not load in time, without waiting for it to close', async () => {
    jest.useFakeTimers();
    try {
      const idb = new FakeIndexedDb();
      seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
      let closes = 0;
      // A wedged IndexedDB: the database never opens, so y-indexeddb never
      // loads it, and never closes it either.
      const dm = new DocManager({
        persistenceFactory: () => ({
          whenSynced: new Promise<never>(() => undefined),
          destroy: () => {
            closes += 1;
            return new Promise<void>(() => undefined);
          },
        }),
        idb: idb.registry,
      });
      let result: unknown = 'pending';
      void dm.peek('b1', 'n.md').then((found) => {
        result = found;
      });

      await jest.advanceTimersByTimeAsync(10_000);

      expect(result).toBeNull();
      expect(closes).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('takes a mark it cannot read for none', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    const dm = idb.manager();

    for (const raw of ['{', JSON.stringify({ fileId: 'f1', hash: 7, over: '' }), 42]) {
      idb.dbs.get(dbNameOf('n.md'))?.custom.set(WRITTEN, raw);
      await expect(dm.peek('b1', 'n.md')).resolves.toMatchObject({ written: null });
    }
  });

  it('reads a doc open under the name as it is', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    dm.setText('b1', 'n.md', 'theirs\nmore\n');

    await expect(dm.peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\nmore\n',
      written: null,
    });
  });

  it('opens nothing when the name is deleted while the databases are listed', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    const listing = deferred<void>();
    const dm = new DocManager({
      persistenceFactory: idb.factory,
      idb: {
        list: async () => {
          const names = [...idb.dbs.keys()];
          await listing.promise;
          return names;
        },
        delete: (name) => idb.registry.delete(name),
      },
    });

    const peeked = dm.peek('b1', 'n.md');
    await flushAsync();
    await dm.clear('b1', 'n.md');
    listing.resolve();

    // Listed before the delete: opened after it, the database was created anew.
    await expect(peeked).resolves.toBeNull();
    expect(idb.dbs.has(dbNameOf('n.md'))).toBe(false);
    expect(idb.opened).toEqual([]);
  });

  it('does not take the listing of a moment ago: a database deleted since is not opened', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    seed(idb, dbNameOf('m.md'), 'mine\n', 'f2');
    const dm = idb.manager();
    // A move lists the databases, and the listing is kept for a moment.
    await dm.move('b1', 'm.md', 'm2.md', 'f2', () => undefined);
    // Deleted by name elsewhere (another manager, say): not through this one.
    await idb.registry.delete(dbNameOf('n.md'));

    await expect(dm.peek('b1', 'n.md')).resolves.toBeNull();
    expect(idb.dbs.has(dbNameOf('n.md'))).toBe(false);
  });
});

describe('putOrdered — the mark after the updates', () => {
  /** An `IDBDatabase` whose transactions are recorded and finish when the test says. */
  function fakeDb(): {
    db: IDBDatabase;
    txs: Array<{
      scope: string[];
      mode: string;
      puts: Array<[string, unknown, unknown]>;
      tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown };
    }>;
  } {
    const txs: Array<{
      scope: string[];
      mode: string;
      puts: Array<[string, unknown, unknown]>;
      tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown };
    }> = [];
    const db = {
      transaction: (scope: string[], mode: string) => {
        const puts: Array<[string, unknown, unknown]> = [];
        const tx = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore: (store: string) => ({
            put: (value: unknown, key: unknown) => puts.push([store, value, key]),
          }),
        };
        txs.push({ scope: [...scope], mode, puts, tx });
        return tx;
      },
    } as unknown as IDBDatabase;
    return { db, txs };
  }

  it('takes the updates into the transaction’s scope, read-write, and puts into the key/value area', async () => {
    const { db, txs } = fakeDb();

    const put = putOrdered(db, WRITTEN, '{"fileId":"f1"}');

    expect(txs).toHaveLength(1);
    expect([...txs[0]!.scope].sort()).toEqual(['custom', 'updates']);
    expect(txs[0]!.mode).toBe('readwrite');
    expect(txs[0]!.puts).toEqual([['custom', '{"fileId":"f1"}', WRITTEN]]);
    txs[0]!.tx.oncomplete?.();
    await expect(put).resolves.toBeUndefined();
  });

  it('fails when the transaction is aborted', async () => {
    const { db, txs } = fakeDb();

    const put = putOrdered(db, WRITTEN, 'x');
    txs[0]!.tx.error = new Error('QuotaExceededError');
    txs[0]!.tx.onabort?.();

    await expect(put).rejects.toThrow('QuotaExceededError');
  });
});
