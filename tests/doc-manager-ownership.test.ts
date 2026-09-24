/**
 * `DocManager` ties a doc to its file: an owner stamp in the doc's own
 * database, a move that carries the history to the file's new name, and a
 * delete of exactly one database by its name — IndexedDB is one store for
 * every vault on the machine.
 */
import * as Y from 'yjs';
import { DocManager } from '@/crdt/doc-manager';
import { FakeIndexedDb, dbNameOf, flushAsync } from './engine-test-kit';

const OWNER = 'team-vault-file-id';

/** A database holding `text`, optionally stamped for `owner`. */
function seed(idb: FakeIndexedDb, path: string, text: string, owner?: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  idb.dbs.set(dbNameOf(path), {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map(owner === undefined ? [] : [[OWNER, owner]]),
  });
  return doc;
}

describe('DocManager — open', () => {
  it('takes an unstamped store for the file and stamps it', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n');
    const dm = idb.manager();

    await expect(dm.open('b1', 'a.md', 'f1')).resolves.toEqual({ discarded: false, owner: null });
    await flushAsync();

    expect(dm.getText('b1', 'a.md')).toBe('mine\n');
    expect(dm.ownerOf('b1', 'a.md')).toBe('f1');
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f1');
  });

  it('starts anew over a store stamped for another file, keeping the subscribers', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'foreign\n', 'f9');
    const dm = idb.manager();
    const sent: Uint8Array[] = [];
    dm.onLocalUpdate('b1', 'a.md', (u) => sent.push(u));

    await expect(dm.open('b1', 'a.md', 'f1')).resolves.toEqual({ discarded: true, owner: 'f9' });
    await flushAsync();

    expect(dm.getText('b1', 'a.md')).toBe('');
    expect(idb.deleted).toEqual([dbNameOf('a.md')]);
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f1');
    // The foreign history never went out as this file's edits.
    expect(sent).toEqual([]);
    dm.setText('b1', 'a.md', 'new\n');
    expect(sent).toHaveLength(1);
    expect(idb.textOf(dbNameOf('a.md'))).toBe('new\n');
  });

  it('does not send a store’s history as local edits when it loads', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'stored\n');
    const dm = idb.manager();
    const sent: Uint8Array[] = [];
    dm.onLocalUpdate('b1', 'a.md', (u) => sent.push(u));

    await dm.whenSynced('b1', 'a.md');

    expect(dm.getText('b1', 'a.md')).toBe('stored\n');
    expect(sent).toEqual([]);
  });
});

describe('DocManager — claimStored (a file new to this device under the name)', () => {
  it('discards an unstamped history: another note left it there', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'left behind\n');
    const dm = idb.manager();

    await expect(dm.claimStored('b1', 'a.md', 'f3')).resolves.toEqual({
      discarded: true,
      owner: null,
    });
    await flushAsync();

    expect(dm.getText('b1', 'a.md')).toBe('');
    expect(idb.deleted).toEqual([dbNameOf('a.md')]);
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f3');
  });

  it('keeps a history stamped for the file itself', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f3');
    const dm = idb.manager();

    await expect(dm.claimStored('b1', 'a.md', 'f3')).resolves.toEqual({
      discarded: false,
      owner: null,
    });

    expect(dm.getText('b1', 'a.md')).toBe('mine\n');
    expect(idb.deleted).toEqual([]);
  });

  it('opens no store where none is listed', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'other.md', 'x\n');
    const opened: string[] = [];
    const dm = new DocManager({
      persistenceFactory: (name, doc) => {
        opened.push(name);
        return idb.factory(name, doc);
      },
      idb: idb.registry,
    });

    await expect(dm.claimStored('b1', 'a.md', 'f3')).resolves.toBeNull();

    expect(opened).toEqual([]);
    expect(dm.has('b1', 'a.md')).toBe(false);
  });
});

describe('DocManager — clear', () => {
  it('finishes a second delete of a name with a doc acquired in between', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'old\n');
    const dm = idb.manager();
    await dm.whenSynced('b1', 'a.md');

    const first = dm.clear('b1', 'a.md');
    const second = dm.clear('b1', 'a.md');
    // Acquired while the second delete waits on the first: its store opens
    // only once that delete is through.
    dm.getText('b1', 'a.md');
    const done = await Promise.race([
      Promise.all([first, second]).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 200)),
    ]);

    expect(done).toBe('done');
    await dm.whenSynced('b1', 'a.md');
    expect(dm.getText('b1', 'a.md')).toBe('');
    expect(idb.textOf(dbNameOf('a.md')) ?? '').toBe('');
  });

  it('deletes exactly the one database, and a doc opened meanwhile starts empty', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'old\n');
    seed(idb, 'a.md.bak', 'other\n');
    idb.dbs.set('team-vault-b2-a.md', { updates: [], custom: new Map() });
    const dm = idb.manager();
    await dm.whenSynced('b1', 'a.md');

    const clearing = dm.clear('b1', 'a.md');
    // Acquired again before the delete has gone through.
    dm.getText('b1', 'a.md');
    await clearing;
    await dm.whenSynced('b1', 'a.md');

    expect(dm.getText('b1', 'a.md')).toBe('');
    expect(idb.deleted).toEqual([dbNameOf('a.md')]);
    expect(idb.dbs.has(dbNameOf('a.md.bak'))).toBe(true);
    expect(idb.dbs.has('team-vault-b2-a.md')).toBe(true);
  });

  it('deletes a database it never opened, by name', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'old\n');
    const dm = idb.manager();

    await dm.clear('b1', 'a.md');

    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
  });
});

describe('DocManager — move', () => {
  it('carries the history as the same operations, and the subscribers with it', async () => {
    const idb = new FakeIndexedDb();
    const server = seed(idb, 'a.md', 'A\n');
    const dm = idb.manager();
    await dm.open('b1', 'a.md', 'f1');
    dm.setText('b1', 'a.md', 'A\nmine\n');
    const sent: Uint8Array[] = [];
    dm.onLocalUpdate('b1', 'a.md', (u) => sent.push(u));
    const order: string[] = [];

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => {
      order.push(`switch:${dm.getText('b1', 'b.md')}`);
    });
    await flushAsync();

    expect(moved).toEqual({ carried: true, lost: false, foreign: null, displaced: null });
    expect(order).toEqual(['switch:A\nmine\n']);
    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.textOf(dbNameOf('b.md'))).toBe('A\nmine\n');
    expect(idb.dbs.get(dbNameOf('b.md'))?.custom.get(OWNER)).toBe('f1');
    // The same operations: merged with the server's doc, nothing doubles.
    Y.applyUpdate(server, dm.encodeStateAsUpdate('b1', 'b.md'));
    expect(server.getText('content').toJSON()).toBe('A\nmine\n');
    // Carried silently; later edits reach the subscriber under the new name.
    expect(sent).toEqual([]);
    dm.setText('b1', 'b.md', 'A\nmine\nmore\n');
    expect(sent).toHaveLength(1);
  });

  it('does not carry a history stamped for another file', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'foreign\n', 'f9');
    const dm = idb.manager();

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);

    expect(moved).toMatchObject({ carried: false, foreign: 'f9' });
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    expect(idb.textOf(dbNameOf('b.md')) ?? '').toBe('');
  });

  it('deletes what another file left under the new name, and reports it', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'a.md', 'mine\n', 'f1');
    seed(idb, 'b.md', 'left\n', 'f7');
    seed(idb, 'c.md', 'old store\n');
    const dm = idb.manager();

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);
    const unstamped = await dm.move('b1', 'b.md', 'c.md', 'f1', () => undefined);

    expect(moved).toMatchObject({ carried: true, displaced: 'f7' });
    // A store without a stamp under the new name is not taken for the file's.
    expect(unstamped).toMatchObject({ carried: true, displaced: null });
    expect(idb.textOf(dbNameOf('c.md'))).toBe('mine\n');
  });

  it('keeps the file’s own history already under the new name (a move cut short)', async () => {
    const idb = new FakeIndexedDb();
    seed(idb, 'b.md', 'mine\n', 'f1');
    const dm = idb.manager();

    const moved = await dm.move('b1', 'a.md', 'b.md', 'f1', () => undefined);
    await dm.whenSynced('b1', 'b.md');

    expect(moved).toMatchObject({ carried: true, displaced: null });
    expect(dm.getText('b1', 'b.md')).toBe('mine\n');
  });
});
