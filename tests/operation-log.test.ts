import Database from 'better-sqlite3';
import { OperationLog, type FileMeta } from '@/sync/operation-log';

let clock = 1_000_000;
const now = (): number => ++clock;

function makeLog(): OperationLog {
  clock = 1_000_000;
  // Inject the Database constructor explicitly — production code lazy-loads
  // it through `native-loader`, which isn't reachable from Jest.
  return new OperationLog({ filePath: ':memory:', now, Database });
}

function makeMeta(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    bindingId: 'b1',
    relativePath: 'note.md',
    serverFileId: 'srv-1',
    contentHash: 'hash-1',
    size: 42,
    fileType: 'TEXT',
    lastSyncedAt: 1234,
    ...overrides,
  };
}

describe('OperationLog — schema', () => {
  it('runs all migrations and reports a stable schema version', () => {
    const log = makeLog();
    expect(log.schemaVersion()).toBeGreaterThan(0);
    log.close();
  });

  it('runMigrations is idempotent across reopens', () => {
    const log1 = makeLog();
    const v1 = log1.schemaVersion();
    log1.close();
    // Re-opening the same `:memory:` URL gives a fresh DB, so we just check
    // that the second instance applies migrations to the same version.
    const log2 = makeLog();
    expect(log2.schemaVersion()).toBe(v1);
    log2.close();
  });
});

describe('OperationLog — pending operations', () => {
  it('round-trips an enqueued operation', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', {
      opType: 'CREATE',
      filePath: 'note.md',
      payload: { contentHash: 'h1', size: 10 },
    });
    expect(op.id).toBeGreaterThan(0);
    expect(op.bindingId).toBe('b1');
    expect(op.payload).toEqual({ contentHash: 'h1', size: 10 });

    const all = log.dequeueOperations('b1');
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(op.id);
    expect(all[0]?.opType).toBe('CREATE');
    expect(all[0]?.newPath).toBeNull();
    log.close();
  });

  it('preserves insertion order', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b1', { opType: 'DELETE', filePath: 'a.md' });
    const ops = log.dequeueOperations('b1');
    expect(ops.map((o) => o.filePath)).toEqual(['a.md', 'b.md', 'a.md']);
    expect(ops.map((o) => o.opType)).toEqual(['CREATE', 'CREATE', 'DELETE']);
    log.close();
  });

  it('isolates operations per binding', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.dequeueOperations('b1')).toHaveLength(1);
    expect(log.dequeueOperations('b2')).toHaveLength(1);
    log.close();
  });

  it('stores newPath for RENAME / MOVE', () => {
    const log = makeLog();
    log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'old.md',
      newPath: 'new.md',
    });
    const ops = log.dequeueOperations('b1');
    expect(ops[0]?.newPath).toBe('new.md');
    log.close();
  });

  it('markSent removes the listed ids', () => {
    const log = makeLog();
    const op1 = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    const op2 = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'c.md' });
    log.markSent([op1.id, op2.id]);
    expect(log.dequeueOperations('b1')).toHaveLength(1);
    expect(log.dequeueOperations('b1')[0]?.filePath).toBe('c.md');
    log.close();
  });

  it('markSent is a no-op for an empty array', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.markSent([]);
    expect(log.pendingCount('b1')).toBe(1);
    log.close();
  });

  it('reports pending counts', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'c.md' });
    expect(log.pendingCount('b1')).toBe(2);
    expect(log.pendingCount('b2')).toBe(1);
    expect(log.pendingCount()).toBe(3);
    log.close();
  });

  it('uses the injected clock for createdAt', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(op.createdAt).toBe(1_000_001);
    log.close();
  });

  it('pendingPaths reports queued filePaths and RENAME newPaths', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'RENAME', filePath: 'b.md', newPath: 'c.md' });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'other.md' });
    const paths = log.pendingPaths('b1');
    expect(paths).toEqual(new Set(['a.md', 'b.md', 'c.md']));
    // Binding isolation — b2's path must not leak in.
    expect(paths.has('other.md')).toBe(false);
    log.close();
  });

  it('pendingPaths drops a path once its op is markSent', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.pendingPaths('b1').has('a.md')).toBe(true);
    log.markSent([op.id]);
    expect(log.pendingPaths('b1').has('a.md')).toBe(false);
    log.close();
  });
});

describe('OperationLog — file_meta', () => {
  it('round-trips a meta entry', () => {
    const log = makeLog();
    const meta = makeMeta();
    log.setFileMeta(meta);
    expect(log.getFileMeta('b1', 'note.md')).toEqual(meta);
    log.close();
  });

  it('returns null for missing entries', () => {
    const log = makeLog();
    expect(log.getFileMeta('b1', 'absent.md')).toBeNull();
    log.close();
  });

  it('overwrites on conflict (UPSERT)', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ contentHash: 'h1' }));
    log.setFileMeta(makeMeta({ contentHash: 'h2', size: 100 }));
    const after = log.getFileMeta('b1', 'note.md');
    expect(after?.contentHash).toBe('h2');
    expect(after?.size).toBe(100);
    log.close();
  });

  it('isolates file_meta across bindings', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ bindingId: 'b1' }));
    log.setFileMeta(makeMeta({ bindingId: 'b2' }));
    expect(log.listFileMeta('b1')).toHaveLength(1);
    expect(log.listFileMeta('b2')).toHaveLength(1);
    log.close();
  });

  it('deletes a single meta entry', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ relativePath: 'a.md' }));
    log.setFileMeta(makeMeta({ relativePath: 'b.md' }));
    log.deleteFileMeta('b1', 'a.md');
    expect(log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(log.getFileMeta('b1', 'b.md')).not.toBeNull();
    log.close();
  });
});

describe('OperationLog — bindings_state', () => {
  it('returns null for unseen binding', () => {
    const log = makeLog();
    expect(log.getBindingState('b1')).toBeNull();
    log.close();
  });

  it('persists and reads back a vector clock', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 5, n2: 3 });
    const state = log.getBindingState('b1');
    expect(state?.lastVectorClock).toEqual({ n1: 5, n2: 3 });
    expect(state?.lastSyncedAt).toBe(1_000_001);
    log.close();
  });

  it('overwrites on subsequent updates', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 1 });
    log.updateLastVectorClock('b1', { n1: 2, n2: 1 });
    expect(log.getBindingState('b1')?.lastVectorClock).toEqual({ n1: 2, n2: 1 });
    log.close();
  });

  it('honors an explicit syncedAt override', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 1 }, 42);
    expect(log.getBindingState('b1')?.lastSyncedAt).toBe(42);
    log.close();
  });
});

describe('OperationLog — purgeBinding', () => {
  it('removes every trace of a binding across all three tables', () => {
    const log = makeLog();
    // b1: two pending ops, one meta row, one sync cursor.
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'UPDATE', filePath: 'a.md' });
    log.setFileMeta(makeMeta({ bindingId: 'b1', relativePath: 'a.md' }));
    log.updateLastVectorClock('b1', { n1: 3 });
    // b2: must survive the purge untouched.
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'keep.md' });
    log.setFileMeta(makeMeta({ bindingId: 'b2', relativePath: 'keep.md' }));
    log.updateLastVectorClock('b2', { n1: 1 });

    const removed = log.purgeBinding('b1');
    expect(removed).toEqual({ pendingOperations: 2, fileMeta: 1, bindingsState: 1 });

    expect(log.pendingCount('b1')).toBe(0);
    expect(log.listFileMeta('b1')).toHaveLength(0);
    expect(log.getBindingState('b1')).toBeNull();

    // b2 is fully intact.
    expect(log.pendingCount('b2')).toBe(1);
    expect(log.listFileMeta('b2')).toHaveLength(1);
    expect(log.getBindingState('b2')?.lastVectorClock).toEqual({ n1: 1 });
    log.close();
  });

  it('is idempotent — a second purge removes nothing', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.setFileMeta(makeMeta({ bindingId: 'b1', relativePath: 'a.md' }));
    log.purgeBinding('b1');
    expect(log.purgeBinding('b1')).toEqual({
      pendingOperations: 0,
      fileMeta: 0,
      bindingsState: 0,
    });
    log.close();
  });

  it('reports zero for a binding that was never seen', () => {
    const log = makeLog();
    expect(log.purgeBinding('ghost')).toEqual({
      pendingOperations: 0,
      fileMeta: 0,
      bindingsState: 0,
    });
    log.close();
  });
});

describe('OperationLog — listBindingIds', () => {
  it('returns distinct ids drawn from any of the three tables', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' }); // pending only
    log.setFileMeta(makeMeta({ bindingId: 'b2' })); // file_meta only
    log.updateLastVectorClock('b3', { n1: 1 }); // bindings_state only
    // b1 also picks up meta + cursor — it must still appear exactly once.
    log.setFileMeta(makeMeta({ bindingId: 'b1', relativePath: 'a.md' }));
    log.updateLastVectorClock('b1', { n1: 2 });

    expect([...log.listBindingIds()].sort()).toEqual(['b1', 'b2', 'b3']);
    log.close();
  });

  it('is empty for a fresh log', () => {
    const log = makeLog();
    expect(log.listBindingIds()).toEqual([]);
    log.close();
  });
});
