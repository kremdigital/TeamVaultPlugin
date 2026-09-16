import * as Y from 'yjs';
import {
  DISK_ORIGIN,
  DocManager,
  REMOTE_ORIGIN,
  type DocPersistence,
  type IdbRegistry,
  type PersistenceFactory,
} from '@/crdt/doc-manager';

class FakePersistence implements DocPersistence {
  static instances: FakePersistence[] = [];
  destroyed = false;
  cleared = false;
  whenSynced: Promise<unknown>;

  constructor(
    public readonly name: string,
    public readonly doc: Y.Doc,
  ) {
    this.whenSynced = Promise.resolve(this);
    FakePersistence.instances.push(this);
  }

  destroy(): void {
    this.destroyed = true;
  }

  // Mirrors y-indexeddb: clearData closes the connection AND deletes the db.
  clearData(): void {
    this.cleared = true;
    this.destroyed = true;
  }
}

/** In-memory stand-in for the renderer's `indexedDB` enumerate/delete seam. */
function makeFakeIdb(initial: string[]): {
  registry: IdbRegistry;
  names: Set<string>;
  deleted: string[];
} {
  const names = new Set(initial);
  const deleted: string[] = [];
  const registry: IdbRegistry = {
    list: () => Promise.resolve([...names]),
    delete: (name) => {
      if (names.delete(name)) deleted.push(name);
      return Promise.resolve();
    },
  };
  return { registry, names, deleted };
}

beforeEach(() => {
  FakePersistence.instances = [];
});

describe('DocManager — whenSynced', () => {
  it('resolves immediately for in-memory docs (no persistence)', async () => {
    const dm = new DocManager();
    await expect(dm.whenSynced('b1', 'note.md')).resolves.toBeUndefined();
  });

  it('waits for the persistence backend to finish loading', async () => {
    let resolveLoad: (() => void) | undefined;
    const factory: PersistenceFactory = (name, doc) => {
      const p = new FakePersistence(name, doc);
      p.whenSynced = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      return p;
    };
    const dm = new DocManager({ persistenceFactory: factory });

    let synced = false;
    const wait = dm.whenSynced('b1', 'note.md').then(() => {
      synced = true;
    });
    await Promise.resolve();
    expect(synced).toBe(false); // still loading

    resolveLoad?.();
    await wait;
    expect(synced).toBe(true);
  });
});

describe('DocManager — caching', () => {
  it('returns the same Y.Doc for repeated get calls', () => {
    const dm = new DocManager();
    const a = dm.get('b1', 'note.md').doc;
    const b = dm.get('b1', 'note.md').doc;
    expect(a).toBe(b);
  });

  it('returns separate docs per (binding, file)', () => {
    const dm = new DocManager();
    const a = dm.get('b1', 'note.md').doc;
    const b = dm.get('b1', 'other.md').doc;
    const c = dm.get('b2', 'note.md').doc;
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('exposes a Y.Text named "content"', () => {
    const dm = new DocManager();
    const { doc, ytext } = dm.get('b1', 'note.md');
    expect(ytext).toBe(doc.getText('content'));
  });

  it('reports membership via has()', () => {
    const dm = new DocManager();
    expect(dm.has('b1', 'note.md')).toBe(false);
    dm.get('b1', 'note.md');
    expect(dm.has('b1', 'note.md')).toBe(true);
  });
});

describe('DocManager — persistence factory', () => {
  it('builds a persistence object on first acquire', () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'note.md');
    expect(FakePersistence.instances).toHaveLength(1);
    expect(FakePersistence.instances[0]?.name).toMatch(/^team-vault-b1-/);
  });

  it('honors a custom dbName builder', () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({
      persistenceFactory: factory,
      dbName: (binding, path) => `custom:${binding}:${path}`,
    });
    dm.get('b1', 'a/b/c.md');
    expect(FakePersistence.instances[0]?.name).toBe('custom:b1:a/b/c.md');
  });

  it('builds a DISTINCT database name for every path (no non-ASCII collision)', () => {
    // Regression for the content-mixing data-corruption incident: the old slug
    // `filePath.replace(/[^a-zA-Z0-9._-]+/g, '_')` collapsed every Cyrillic
    // path onto one name (these four all became `team-vault-b1-_-_.md`), so the
    // files shared one offline store and their Y.Doc contents merged. The
    // default dbName must be injective: distinct paths → distinct names.
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    const paths = [
      'персонажи/андрей-перминов.md',
      'персонажи/иван-воренок.md',
      'персонажи/василий-звенигородский.md',
      'события/порча-зерна.md',
    ];
    for (const p of paths) dm.get('b1', p);
    const names = FakePersistence.instances.map((i) => i.name);
    expect(new Set(names).size).toBe(paths.length);
    // Every name keeps the binding-scoped prefix and is unique.
    for (const name of names) expect(name.startsWith('team-vault-b1-')).toBe(true);
  });

  it('reuses persistence across get() calls', () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'note.md');
    dm.get('b1', 'note.md');
    expect(FakePersistence.instances).toHaveLength(1);
  });
});

describe('DocManager — text mutations', () => {
  it('setText applies a minimal diff and bumps the doc', () => {
    const dm = new DocManager();
    dm.setText('b1', 'note.md', 'hello');
    expect(dm.getText('b1', 'note.md')).toBe('hello');
    dm.setText('b1', 'note.md', 'hello world');
    expect(dm.getText('b1', 'note.md')).toBe('hello world');
  });

  it('setText defaults the origin to DISK_ORIGIN', () => {
    const dm = new DocManager();
    const { doc } = dm.get('b1', 'note.md');
    let seen: unknown = null;
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      seen = origin;
    });
    dm.setText('b1', 'note.md', 'x');
    expect(seen).toBe(DISK_ORIGIN);
  });
});

describe('DocManager — remote update intake', () => {
  it('applyRemoteUpdate brings in another doc’s state', () => {
    const dm = new DocManager();

    // Source doc seeded outside the manager.
    const source = new Y.Doc();
    source.getText('content').insert(0, 'remote text');
    const update = Y.encodeStateAsUpdate(source);

    dm.applyRemoteUpdate('b1', 'note.md', update);
    expect(dm.getText('b1', 'note.md')).toBe('remote text');
  });

  it('does NOT echo remote updates back to local subscribers', () => {
    const dm = new DocManager();
    const cb = jest.fn();
    dm.onLocalUpdate('b1', 'note.md', cb);

    const source = new Y.Doc();
    source.getText('content').insert(0, 'remote');
    dm.applyRemoteUpdate('b1', 'note.md', Y.encodeStateAsUpdate(source));

    expect(cb).not.toHaveBeenCalled();
  });

  it('applyRemoteUpdate uses REMOTE_ORIGIN', () => {
    const dm = new DocManager();
    const { doc } = dm.get('b1', 'note.md');
    let seen: unknown = null;
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      seen = origin;
    });
    const source = new Y.Doc();
    source.getText('content').insert(0, 'r');
    dm.applyRemoteUpdate('b1', 'note.md', Y.encodeStateAsUpdate(source));
    expect(seen).toBe(REMOTE_ORIGIN);
  });
});

describe('DocManager — onLocalUpdate', () => {
  it('fires for direct Y.Text edits', () => {
    const dm = new DocManager();
    const cb = jest.fn();
    dm.onLocalUpdate('b1', 'note.md', cb);
    const { ytext } = dm.get('b1', 'note.md');
    ytext.insert(0, 'hi');
    expect(cb).toHaveBeenCalledTimes(1);
    const arg = cb.mock.calls[0]?.[0] as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(arg.byteLength).toBeGreaterThan(0);
  });

  it('fires for setText (DISK origin is treated as local for fan-out)', () => {
    const dm = new DocManager();
    const cb = jest.fn();
    dm.onLocalUpdate('b1', 'note.md', cb);
    dm.setText('b1', 'note.md', 'hi');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returned unsubscribe function detaches the callback', () => {
    const dm = new DocManager();
    const cb = jest.fn();
    const off = dm.onLocalUpdate('b1', 'note.md', cb);
    const { ytext } = dm.get('b1', 'note.md');
    ytext.insert(0, 'a');
    off();
    ytext.insert(1, 'b');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors so they don’t break the doc', () => {
    const dm = new DocManager();
    const ok = jest.fn();
    dm.onLocalUpdate('b1', 'note.md', () => {
      throw new Error('boom');
    });
    dm.onLocalUpdate('b1', 'note.md', ok);
    const { ytext } = dm.get('b1', 'note.md');
    expect(() => ytext.insert(0, 'x')).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('DocManager — release / destroy', () => {
  it('release destroys persistence and removes from cache', async () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'note.md');
    expect(FakePersistence.instances[0]?.destroyed).toBe(false);
    await dm.release('b1', 'note.md');
    expect(FakePersistence.instances[0]?.destroyed).toBe(true);
    expect(dm.has('b1', 'note.md')).toBe(false);
  });

  it('release is a no-op for an unknown key', async () => {
    const dm = new DocManager();
    await expect(dm.release('b1', 'absent.md')).resolves.toBeUndefined();
  });

  it('releaseBinding drops every entry for that binding', async () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'a.md');
    dm.get('b1', 'b.md');
    dm.get('b2', 'c.md');
    await dm.releaseBinding('b1');
    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(dm.has('b1', 'b.md')).toBe(false);
    expect(dm.has('b2', 'c.md')).toBe(true);
  });

  it('destroy() clears every entry', async () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'a.md');
    dm.get('b2', 'b.md');
    await dm.destroy();
    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(dm.has('b2', 'b.md')).toBe(false);
    expect(FakePersistence.instances.every((p) => p.destroyed)).toBe(true);
  });
});

describe('DocManager — purgeBinding', () => {
  it('clears cached docs through their persistence (clearData, not just destroy)', async () => {
    const factory: PersistenceFactory = (name, doc) => new FakePersistence(name, doc);
    const dm = new DocManager({ persistenceFactory: factory });
    dm.get('b1', 'a.md');
    dm.get('b1', 'b.md');
    const [a, b] = FakePersistence.instances;

    await dm.purgeBinding('b1');

    // clearData (delete), not just destroy (close) — that's the whole fix.
    expect(a?.cleared).toBe(true);
    expect(b?.cleared).toBe(true);
    expect(dm.has('b1', 'a.md')).toBe(false);
    expect(dm.has('b1', 'b.md')).toBe(false);
  });

  it('deletes databases for docs never opened this session', async () => {
    // The common case when deleting a binding: nothing is cached, so the
    // purge must enumerate the binding's databases rather than walk the cache.
    const idb = makeFakeIdb([
      'team-vault-b1-a.md',
      'team-vault-b1-sub_note.md',
      'team-vault-b2-keep.md',
    ]);
    const dm = new DocManager({ idb: idb.registry });

    const deleted = await dm.purgeBinding('b1');

    expect(deleted.sort()).toEqual(['team-vault-b1-a.md', 'team-vault-b1-sub_note.md']);
    expect([...idb.names]).toEqual(['team-vault-b2-keep.md']);
  });

  it('leaves other bindings’ databases untouched (prefix is dash-bounded)', async () => {
    // b10 must survive a purge of b1 — the trailing dash disambiguates them.
    const idb = makeFakeIdb(['team-vault-b1-x.md', 'team-vault-b10-y.md', 'team-vault-b2-z.md']);
    const dm = new DocManager({ idb: idb.registry });

    await dm.purgeBinding('b1');

    expect([...idb.names].sort()).toEqual(['team-vault-b10-y.md', 'team-vault-b2-z.md']);
  });

  it('falls back to knownPaths when enumeration is unavailable', async () => {
    const deleted: string[] = [];
    const idb: IdbRegistry = {
      list: () => Promise.resolve([]), // runtime without indexedDB.databases()
      delete: (name) => {
        deleted.push(name);
        return Promise.resolve();
      },
    };
    const dm = new DocManager({ idb });

    await dm.purgeBinding('b1', ['note.md', 'dir/sub.md']);

    // dbName is now lossless (encodeURIComponent): `/` → `%2F`.
    expect(deleted.sort()).toEqual(['team-vault-b1-dir%2Fsub.md', 'team-vault-b1-note.md']);
  });

  it('is best-effort — a failed delete does not throw', async () => {
    const idb: IdbRegistry = {
      list: () => Promise.resolve(['team-vault-b1-a.md']),
      delete: () => Promise.reject(new Error('blocked')),
    };
    const dm = new DocManager({ idb });

    await expect(dm.purgeBinding('b1')).resolves.toEqual([]);
  });
});

describe('DocManager — encodeStateAsUpdate', () => {
  it('produces a snapshot that can rehydrate another Y.Doc', () => {
    const dm = new DocManager();
    dm.setText('b1', 'note.md', 'hello world');
    const snapshot = dm.encodeStateAsUpdate('b1', 'note.md');

    const target = new Y.Doc();
    Y.applyUpdate(target, snapshot);
    expect(target.getText('content').toString()).toBe('hello world');
  });

  it('with a target state vector returns only the ops the target is missing', () => {
    // Set up two batches of edits, snapshot the state vector between them,
    // then encode against that vector. Applying the resulting delta to a
    // twin doc that holds only the first batch should land at the same
    // final text — proving the delta really is "just the missing ops".
    const dm = new DocManager();
    dm.setText('b1', 'note.md', 'first');
    const initial = dm.encodeStateAsUpdate('b1', 'note.md');
    const targetVec = Y.encodeStateVector(dm.get('b1', 'note.md').doc);

    dm.setText('b1', 'note.md', 'first second');
    const delta = dm.encodeStateAsUpdate('b1', 'note.md', targetVec);

    const twin = new Y.Doc();
    Y.applyUpdate(twin, initial);
    Y.applyUpdate(twin, delta);
    expect(twin.getText('content').toString()).toBe('first second');
    twin.destroy();
  });

  it('returns a near-empty update when the target already has everything', () => {
    const dm = new DocManager();
    dm.setText('b1', 'note.md', 'hello');
    const vec = Y.encodeStateVector(dm.get('b1', 'note.md').doc);
    const delta = dm.encodeStateAsUpdate('b1', 'note.md', vec);
    // The engine's reconnect emit guard checks `length > 2`; a "nothing to
    // send" delta must be small enough to fall under that threshold.
    expect(delta.length).toBeLessThanOrEqual(2);
  });
});
