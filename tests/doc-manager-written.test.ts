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

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual({
      fileId: 'f1',
      hash: 'h1',
      over: '',
      synced: '',
    });
    // What the next start of Obsidian finds.
    await expect(idb.manager().peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\n',
      written: { fileId: 'f1', hash: 'h1', over: '', synced: '' },
    });
  });

  it('marks nothing on a doc stamped for another file, or not stamped', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('old.md'), 'old\n');
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f9', 'foreign\n');
    await dm.open('b1', 'old.md', 'f1');

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    dm.noteWritten('b1', 'old.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    dm.noteWritten('b1', 'none.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
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

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h2', over: 'h1', synced: '' });

    expect(writes).toEqual([`setOrdered ${WRITTEN}`, `setOrdered ${WRITTEN}`]);
    landed.resolve();
    await flushAsync();
    expect(markIn(idb, dbNameOf('n.md'))).toEqual({
      fileId: 'f1',
      hash: 'h2',
      over: 'h1',
      synced: '',
    });
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

    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual({
      fileId: 'f1',
      hash: 'h1',
      over: '',
      synced: '',
    });
  });

  it('goes with the database when the doc is deleted, and stays behind when it moves', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    await opened(dm, 'm.md', 'f2', 'moved\n');
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    dm.noteWritten('b1', 'm.md', { fileId: 'f2', hash: 'h2', over: '', synced: '' });
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
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
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

describe('DocManager — confirmWritten', () => {
  const mark = { fileId: 'f1', hash: 'h1', over: 'h0', synced: 's0', state: 'AA==' };

  it('puts the mark again with the disk the write went to, through `setOrdered`', async () => {
    const idb = new FakeIndexedDb();
    const ordered: unknown[] = [];
    const factory: PersistenceFactory = (name, doc) => {
      const inner = idb.factory(name, doc) as DocPersistence;
      return {
        ...inner,
        setOrdered: (key, value) => {
          ordered.push(JSON.parse(value));
          return inner.setOrdered!(key, value);
        },
      };
    };
    const dm = new DocManager({ persistenceFactory: factory, idb: idb.registry });
    await opened(dm, 'n.md', 'f1', 'theirs\n');

    dm.noteWritten('b1', 'n.md', mark);
    dm.confirmWritten('b1', 'n.md', mark, '/vault');
    await flushAsync();

    expect(ordered).toEqual([mark, { ...mark, disk: '/vault' }]);
    expect(dm.writtenMarkOf('b1', 'n.md')).toEqual({ ...mark, disk: '/vault' });
    // What the next start of Obsidian finds.
    await expect(idb.manager().peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\n',
      written: { ...mark, disk: '/vault' },
    });
  });

  it('confirms nothing for an unknown disk, or on a doc the mark does not go to', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    await opened(dm, 'm.md', 'f9', 'foreign\n');
    dm.noteWritten('b1', 'n.md', mark);
    await flushAsync();

    dm.confirmWritten('b1', 'n.md', mark, '');
    dm.confirmWritten('b1', 'm.md', mark, '/vault');
    dm.confirmWritten('b1', 'none.md', mark, '/vault');
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual(mark);
    expect(markIn(idb, dbNameOf('m.md'))).toBeUndefined();
    expect(idb.dbs.has(dbNameOf('none.md'))).toBe(false);
  });

  it('is not what the mark put down before the write says, whatever it carries', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');

    dm.noteWritten('b1', 'n.md', { ...mark, disk: '/vault' });
    await flushAsync();

    expect(markIn(idb, dbNameOf('n.md'))).toEqual(mark);
    expect(dm.writtenMarkOf('b1', 'n.md')).toEqual(mark);
  });

  it('takes a disk it cannot read for none: the mark as put down before the write', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    seed(idb, dbNameOf('m.md'), 'theirs\n', 'f1');
    idb.dbs.get(dbNameOf('n.md'))?.custom.set(WRITTEN, JSON.stringify({ ...mark, disk: 7 }));
    idb.dbs.get(dbNameOf('m.md'))?.custom.set(WRITTEN, JSON.stringify({ ...mark, disk: '' }));
    const dm = idb.manager();

    expect((await dm.peek('b1', 'n.md'))?.written).toEqual(mark);
    expect((await dm.peek('b1', 'm.md'))?.written).toEqual(mark);
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
      ?.custom.set(WRITTEN, JSON.stringify({ fileId: 'f1', hash: 'h1', over: '', synced: '' }));
    const dm = idb.manager();

    await expect(dm.peek('b1', 'n.md')).resolves.toEqual({
      owner: 'f1',
      text: 'theirs\r\ntyping\r\n',
      written: { fileId: 'f1', hash: 'h1', over: '', synced: '' },
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

    for (const raw of [
      '{',
      JSON.stringify({ fileId: 'f1', hash: 7, over: '', synced: '' }),
      // Without the record's synced content it was written over.
      JSON.stringify({ fileId: 'f1', hash: 'h1', over: '' }),
      '',
      42,
    ]) {
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

describe('DocManager — the mark of a doc open under the name', () => {
  it('is the one its store held as it loaded, and none for a store without one', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    seed(idb, dbNameOf('m.md'), 'mine\n', 'f2');
    const mark = { fileId: 'f1', hash: 'h1', over: 'h0', synced: 'h0' };
    idb.dbs.get(dbNameOf('n.md'))?.custom.set(WRITTEN, JSON.stringify(mark));
    const dm = idb.manager();

    expect(dm.writtenMarkOf('b1', 'n.md')).toBeNull();
    await dm.open('b1', 'n.md', 'f1');
    await dm.open('b1', 'm.md', 'f2');

    expect(dm.writtenMarkOf('b1', 'n.md')).toEqual(mark);
    expect(dm.writtenMarkOf('b1', 'm.md')).toBeNull();
    expect(dm.writtenMarkOf('b1', 'none.md')).toBeNull();
  });

  it('is dropped, in its store too, unless it is of the text kept', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    const mark = { fileId: 'f1', hash: 'h1', over: '', synced: '' };
    dm.noteWritten('b1', 'n.md', mark);

    dm.forgetWritten('b1', 'n.md', 'h1');
    expect(dm.writtenMarkOf('b1', 'n.md')).toEqual(mark);
    dm.forgetWritten('b1', 'n.md', 'h2');
    await flushAsync();

    expect(dm.writtenMarkOf('b1', 'n.md')).toBeNull();
    expect(idb.dbs.get(dbNameOf('n.md'))?.custom.get(WRITTEN)).toBe('');
    await dm.release('b1', 'n.md');
    await expect(idb.manager().peek('b1', 'n.md')).resolves.toMatchObject({ written: null });
  });

  it('is dropped through `setOrdered`, after the edits handed to the store before', async () => {
    const idb = new FakeIndexedDb();
    const writes: string[] = [];
    const factory: PersistenceFactory = (name, doc) => {
      const inner = idb.factory(name, doc) as DocPersistence;
      return {
        ...inner,
        set: (key, value) => {
          writes.push(`set ${key}`);
          return inner.set!(key, value);
        },
        setOrdered: (key, value) => {
          writes.push(`setOrdered ${key}=${value}`);
          return inner.setOrdered!(key, value);
        },
      };
    };
    const dm = new DocManager({ persistenceFactory: factory, idb: idb.registry });
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    dm.noteWritten('b1', 'n.md', { fileId: 'f1', hash: 'h1', over: '', synced: '' });
    writes.length = 0;

    dm.forgetWritten('b1', 'n.md', 'h2');
    dm.forgetWritten('b1', 'n.md', 'h3');

    expect(writes).toEqual([`setOrdered ${WRITTEN}=`]);
  });

  it('is not dropped for a doc not open under the name: its store is not opened for it', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'theirs\n', 'f1');
    const raw = JSON.stringify({ fileId: 'f1', hash: 'h1', over: '', synced: '' });
    idb.dbs.get(dbNameOf('n.md'))?.custom.set(WRITTEN, raw);
    const dm = idb.manager();

    dm.forgetWritten('b1', 'n.md', 'h2');
    await flushAsync();

    expect(idb.opened).toEqual([]);
    expect(idb.dbs.get(dbNameOf('n.md'))?.custom.get(WRITTEN)).toBe(raw);
  });
});

describe('DocManager — the text a doc had when its state was taken', () => {
  it('is rebuilt without what was typed since, anywhere in the text', () => {
    const dm = new DocManager();
    dm.setText('b1', 'n.md', 'one\ntwo\n');
    const state = dm.stateOf('b1', 'n.md');
    expect(state).not.toBeNull();
    // A teammate types on at the end and in between.
    const { ytext } = dm.get('b1', 'n.md');
    ytext.insert(ytext.length, 'three\n');
    ytext.insert(4, 'one and a half\n');

    expect(dm.textAt('b1', 'n.md', state!)).toBe('one\ntwo\n');
    expect(dm.getText('b1', 'n.md')).toBe('one\none and a half\ntwo\nthree\n');
  });

  it('misses what was deleted since: a doc collects its garbage', () => {
    const dm = new DocManager();
    dm.setText('b1', 'n.md', 'one\ntwo\n');
    const state = dm.stateOf('b1', 'n.md');
    dm.get('b1', 'n.md').ytext.delete(0, 4);

    expect(dm.textAt('b1', 'n.md', state!)).not.toBe('one\ntwo\n');
    expect(dm.getText('b1', 'n.md')).toBe('two\n');
  });

  it('is rebuilt from a history loaded from the store, after a restart', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');
    const state = dm.stateOf('b1', 'n.md');
    const { ytext } = dm.get('b1', 'n.md');
    ytext.insert(ytext.length, 'ahead\n');
    await flushAsync();

    const next = idb.manager();
    await next.open('b1', 'n.md', 'f1');
    expect(next.getText('b1', 'n.md')).toBe('theirs\nahead\n');
    expect(next.textAt('b1', 'n.md', state!)).toBe('theirs\n');
  });

  it('is none for a doc not open, or a state that cannot be read', () => {
    const dm = new DocManager();
    dm.setText('b1', 'n.md', 'one\n');

    expect(dm.stateOf('b1', 'none.md')).toBeNull();
    expect(dm.textAt('b1', 'none.md', dm.stateOf('b1', 'n.md')!)).toBeNull();
    expect(dm.textAt('b1', 'n.md', '!!')).toBeNull();
  });
});

describe('DocManager — claimNew', () => {
  it('stamps a doc started from an empty store, a teammate’s update landed in it first', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    // The engine clears the name and wires the doc; the server's doc of the
    // new note lands before anything opens it.
    await dm.clear('b1', 'n.md');
    const server = new Y.Doc();
    server.getText('content').insert(0, 'theirs\n');
    dm.applyRemoteUpdate('b1', 'n.md', Y.encodeStateAsUpdate(server));

    await dm.claimNew('b1', 'n.md', 'f1');
    await flushAsync();

    expect(dm.ownerOf('b1', 'n.md')).toBe('f1');
    expect(idb.dbs.get(dbNameOf('n.md'))?.custom.get(OWNER)).toBe('f1');
    // A doc opened with a history is left unstamped otherwise: see `open`.
    const other = idb.manager();
    other.applyRemoteUpdate('b1', 'm.md', Y.encodeStateAsUpdate(server));
    await other.open('b1', 'm.md', 'f2');
    expect(other.ownerOf('b1', 'm.md')).toBeNull();
  });

  it('leaves a doc unstamped when its store brought a history in: its delete did not go through', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, dbNameOf('n.md'), 'old note\n');
    const dm = new DocManager({
      persistenceFactory: idb.factory,
      // IndexedDB did not delete the database.
      idb: { list: () => idb.registry.list(), delete: () => Promise.resolve() },
    });
    await dm.clear('b1', 'n.md');
    dm.get('b1', 'n.md');

    await dm.claimNew('b1', 'n.md', 'f1');
    await flushAsync();

    expect(dm.getText('b1', 'n.md')).toBe('old note\n');
    expect(dm.ownerOf('b1', 'n.md')).toBeNull();
    expect(idb.dbs.get(dbNameOf('n.md'))?.custom.has(OWNER)).toBe(false);
  });

  it('leaves a stamp there is alone, and does nothing for a doc not open', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();
    await opened(dm, 'n.md', 'f1', 'theirs\n');

    await dm.claimNew('b1', 'n.md', 'f2');
    await dm.claimNew('b1', 'none.md', 'f3');

    expect(dm.ownerOf('b1', 'n.md')).toBe('f1');
    expect(dm.has('b1', 'none.md')).toBe(false);
    expect(idb.dbs.has(dbNameOf('none.md'))).toBe(false);
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
