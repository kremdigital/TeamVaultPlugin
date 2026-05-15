import * as Y from 'yjs';
import {
  DISK_ORIGIN,
  DocManager,
  REMOTE_ORIGIN,
  type DocPersistence,
  type PersistenceFactory,
} from '@/crdt/doc-manager';

class FakePersistence implements DocPersistence {
  static instances: FakePersistence[] = [];
  destroyed = false;
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
}

beforeEach(() => {
  FakePersistence.instances = [];
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
    expect(FakePersistence.instances[0]?.name).toMatch(/^obsidian-team-b1-/);
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
