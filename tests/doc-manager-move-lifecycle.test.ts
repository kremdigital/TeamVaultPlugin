/**
 * `DocManager.move` and `clear` around what is open and what can be deleted:
 * a move says whether there was anything to carry, closes a doc it opened
 * only for itself, and a store IndexedDB refuses to delete does not fail it.
 */
import * as Y from 'yjs';
import { DocManager } from '@/crdt/doc-manager';
import { FakeIndexedDb, dbNameOf } from './engine-test-kit';

const OWNER = 'team-vault-file-id';

function seed(idb: FakeIndexedDb, path: string, text: string, owner?: string): void {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  idb.dbs.set(dbNameOf(path), {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map(owner === undefined ? [] : [[OWNER, owner]]),
  });
}

describe('DocManager — move', () => {
  it('reports nothing found when the old name has no store', async () => {
    const idb = new FakeIndexedDb();
    const dm = idb.manager();

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(moved).toMatchObject({ found: false, carried: false, lost: false, foreign: null });
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.dbs.has(dbNameOf('b.md'))).toBe(false);
  });

  it('reports nothing found for an empty store', async () => {
    const idb = new FakeIndexedDb();
    idb.dbs.set(dbNameOf('a.md'), { updates: [], custom: new Map() });
    const dm = idb.manager();

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(moved.found).toBe(false);
  });

  it('closes a doc it opened only for the move, its history and stamp stored', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    const dm = idb.manager();
    let openDuringSwitch: boolean | null = null;

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => {
      openDuringSwitch = dm.has('b1', 'b.md');
    });

    expect(moved).toMatchObject({ found: true, carried: true });
    expect(openDuringSwitch).toBe(false);
    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(dm.has('b1', 'b.md')).toBe(false);
    expect(idb.textOf(dbNameOf('b.md'))).toBe('mine\n');
    expect(idb.dbs.get(dbNameOf('b.md'))?.custom.get(OWNER)).toBe('f1');
    // Opened again, it is the file's own.
    await expect(dm.open('b1', 'b.md', 'f1')).resolves.toEqual({ discarded: false, owner: null });
    expect(dm.getText('b1', 'b.md')).toBe('mine\n');
  });

  it('keeps open a doc holding updates it could not integrate yet', async () => {
    // The store holds "a", and an edit that builds on an operation missing
    // from it: loaded, that edit waits in the doc, not in the store.
    const remote = new Y.Doc();
    const text = remote.getText('content');
    text.insert(0, 'a');
    const first = Y.encodeStateAsUpdate(remote);
    text.insert(1, 'b');
    const second = Y.encodeStateVector(remote);
    text.insert(2, 'c');
    const gap = Y.encodeStateAsUpdate(remote, second);
    const idb = new FakeIndexedDb();
    idb.dbs.set(dbNameOf('a.md'), { updates: [first, gap], custom: new Map([[OWNER, 'f1']]) });
    const dm = idb.manager();

    await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(dm.has('b1', 'b.md')).toBe(true);
    expect(dm.hasPendingRemoteUpdates('b1', 'b.md')).toBe(true);
  });

  it('keeps open a doc the caller still needs', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    const dm = idb.manager();

    await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined, { keepOpen: () => true });

    expect(dm.has('b1', 'b.md')).toBe(true);
  });

  it('keeps open a doc that was open under the old name', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    const dm = idb.manager();
    await dm.open('b1', 'a.md', 'f1');

    await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(dm.has('b1', 'b.md')).toBe(true);
    expect(dm.getText('b1', 'b.md')).toBe('mine\n');
  });
});

describe('DocManager — a store IndexedDB refuses to delete', () => {
  function refusing(idb: FakeIndexedDb): DocManager {
    return new DocManager({
      persistenceFactory: (name, doc) => {
        const p = idb.factory(name, doc);
        if (p) {
          p.clearData = () => Promise.reject(new Error('UnknownError'));
          p.destroy = () => Promise.reject(new Error('UnknownError'));
        }
        return p;
      },
      idb: idb.registry,
    });
  }

  it('is deleted by name instead, without an error', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    const dm = refusing(idb);
    await dm.open('b1', 'a.md', 'f1');

    await expect(dm.clear('b1', 'a.md')).resolves.toBeUndefined();

    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
  });

  it('does not fail a move', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    const dm = refusing(idb);
    await dm.open('b1', 'a.md', 'f1');

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(moved.carried).toBe(true);
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(dm.getText('b1', 'b.md')).toBe('mine\n');
  });
});
