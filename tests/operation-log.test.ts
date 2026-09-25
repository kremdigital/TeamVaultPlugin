import { APPLIED_LIVE_MAX, OperationLog, type FileMeta } from '@/sync/operation-log';
import type { LogStorage } from '@/utils/file-log-sink';
import { stubWindow } from './window-stub';

let clock = 1_000_000;
const now = (): number => ++clock;

function makeLog(): OperationLog {
  clock = 1_000_000;
  // No storage → memory-only. Persistence gets its own describe below.
  return new OperationLog({ now });
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

describe('OperationLog — format', () => {
  it('reports a stable format version', () => {
    expect(makeLog().schemaVersion()).toBe(1);
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
  });

  it('preserves insertion order', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b1', { opType: 'DELETE', filePath: 'a.md' });
    const ops = log.dequeueOperations('b1');
    expect(ops.map((o) => o.filePath)).toEqual(['a.md', 'b.md', 'a.md']);
    expect(ops.map((o) => o.opType)).toEqual(['CREATE', 'CREATE', 'DELETE']);
  });

  it('isolates operations per binding', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.dequeueOperations('b1')).toHaveLength(1);
    expect(log.dequeueOperations('b2')).toHaveLength(1);
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
  });

  it('markSent removes the listed ids', () => {
    const log = makeLog();
    const op1 = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    const op2 = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'c.md' });
    log.markSent([op1.id, op2.id]);
    expect(log.dequeueOperations('b1')).toHaveLength(1);
    expect(log.dequeueOperations('b1')[0]?.filePath).toBe('c.md');
  });

  it('retargetOperation moves a queued rename’s destination in place', () => {
    const log = makeLog();
    const rename = log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'a.md',
      newPath: 'b.md',
      payload: { fileId: 'f1' },
    });
    const create = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.retargetOperation(rename.id, 'c.md')).toBe(true);
    expect(log.retargetOperation(create.id, 'x.md')).toBe(false);
    expect(log.retargetOperation(999, 'x.md')).toBe(false);
    expect(log.dequeueOperations('b1').map((o) => [o.opType, o.filePath, o.newPath])).toEqual([
      ['RENAME', 'a.md', 'c.md'],
      ['CREATE', 'a.md', null],
    ]);
  });

  it('markSent is a no-op for an empty array', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.markSent([]);
    expect(log.pendingCount('b1')).toBe(1);
  });

  it('reports pending counts', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'c.md' });
    expect(log.pendingCount('b1')).toBe(2);
    expect(log.pendingCount('b2')).toBe(1);
    expect(log.pendingCount()).toBe(3);
  });

  it('uses the injected clock for createdAt', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(op.createdAt).toBe(1_000_001);
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
  });

  it('pendingPaths drops a path once its op is markSent', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.pendingPaths('b1').has('a.md')).toBe(true);
    log.markSent([op.id]);
    expect(log.pendingPaths('b1').has('a.md')).toBe(false);
  });
});

describe('OperationLog — file_meta', () => {
  it('round-trips a meta entry', () => {
    const log = makeLog();
    const meta = makeMeta();
    log.setFileMeta(meta);
    expect(log.getFileMeta('b1', 'note.md')).toEqual(meta);
  });

  it('returns null for missing entries', () => {
    const log = makeLog();
    expect(log.getFileMeta('b1', 'absent.md')).toBeNull();
  });

  it('overwrites on conflict (UPSERT)', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ contentHash: 'h1' }));
    log.setFileMeta(makeMeta({ contentHash: 'h2', size: 100 }));
    const after = log.getFileMeta('b1', 'note.md');
    expect(after?.contentHash).toBe('h2');
    expect(after?.size).toBe(100);
  });

  it('isolates file_meta across bindings', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ bindingId: 'b1' }));
    log.setFileMeta(makeMeta({ bindingId: 'b2' }));
    expect(log.listFileMeta('b1')).toHaveLength(1);
    expect(log.listFileMeta('b2')).toHaveLength(1);
  });

  it('deletes a single meta entry', () => {
    const log = makeLog();
    log.setFileMeta(makeMeta({ relativePath: 'a.md' }));
    log.setFileMeta(makeMeta({ relativePath: 'b.md' }));
    log.deleteFileMeta('b1', 'a.md');
    expect(log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(log.getFileMeta('b1', 'b.md')).not.toBeNull();
  });
});

describe('OperationLog — bindings_state', () => {
  it('returns null for unseen binding', () => {
    const log = makeLog();
    expect(log.getBindingState('b1')).toBeNull();
  });

  it('persists and reads back a vector clock', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 5, n2: 3 });
    const state = log.getBindingState('b1');
    expect(state?.lastVectorClock).toEqual({ n1: 5, n2: 3 });
    expect(state?.lastSyncedAt).toBe(1_000_001);
  });

  it('overwrites on subsequent updates', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 1 });
    log.updateLastVectorClock('b1', { n1: 2, n2: 1 });
    expect(log.getBindingState('b1')?.lastVectorClock).toEqual({ n1: 2, n2: 1 });
  });

  it('honors an explicit syncedAt override', () => {
    const log = makeLog();
    log.updateLastVectorClock('b1', { n1: 1 }, 42);
    expect(log.getBindingState('b1')?.lastSyncedAt).toBe(42);
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
  });

  it('reports zero for a binding that was never seen', () => {
    const log = makeLog();
    expect(log.purgeBinding('ghost')).toEqual({
      pendingOperations: 0,
      fileMeta: 0,
      bindingsState: 0,
    });
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
  });

  it('is empty for a fresh log', () => {
    const log = makeLog();
    expect(log.listBindingIds()).toEqual([]);
  });
});

/** In-memory `LogStorage` that records the call order. */
function makeStorage(seed: Record<string, string> = {}): {
  storage: LogStorage;
  files: Map<string, string>;
  calls: string[];
} {
  const files = new Map(Object.entries(seed));
  const calls: string[] = [];
  const storage: LogStorage = {
    exists: (p) => {
      calls.push(`exists ${p}`);
      return Promise.resolve(files.has(p));
    },
    stat: (p) => Promise.resolve(files.has(p) ? { size: files.get(p)!.length } : null),
    append: (p, data) => {
      files.set(p, (files.get(p) ?? '') + data);
      return Promise.resolve();
    },
    write: (p, data) => {
      calls.push(`write ${p}`);
      files.set(p, data);
      return Promise.resolve();
    },
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`);
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      return Promise.resolve();
    },
    remove: (p) => {
      calls.push(`remove ${p}`);
      files.delete(p);
      return Promise.resolve();
    },
    read: (p) => Promise.resolve(files.get(p) ?? ''),
    mkdir: () => Promise.resolve(),
  };
  return { storage, files, calls };
}

const PATH = '.obsidian/plugins/team-vault/state.json';

describe('OperationLog — persistence', () => {
  it('round-trips every collection through storage', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    const op = log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'old.md',
      newPath: 'new.md',
      payload: { contentHash: 'h1' },
    });
    log.setFileMeta(makeMeta());
    log.updateLastVectorClock('b1', { c1: 7 }, 555);
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();

    expect(reopened.dequeueOperations('b1')).toEqual([
      {
        id: op.id,
        bindingId: 'b1',
        opType: 'RENAME',
        filePath: 'old.md',
        newPath: 'new.md',
        payload: { contentHash: 'h1' },
        createdAt: op.createdAt,
      },
    ]);
    expect(reopened.getFileMeta('b1', 'note.md')).toEqual(makeMeta());
    expect(reopened.getBindingState('b1')).toEqual({
      bindingId: 'b1',
      lastVectorClock: { c1: 7 },
      lastSyncedAt: 555,
    });
    expect(files.has(PATH)).toBe(true);
  });

  it('round-trips the fold marker, and leaves it absent for older entries', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.setFileMeta(makeMeta({ relativePath: 'folded.md', foldedHash: 'fold-1' }));
    log.setFileMeta(makeMeta({ relativePath: 'legacy.md' }));
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.getFileMeta('b1', 'folded.md')?.foldedHash).toBe('fold-1');
    const legacy = reopened.getFileMeta('b1', 'legacy.md');
    expect(legacy).toEqual(makeMeta({ relativePath: 'legacy.md' }));
    expect(legacy && 'foldedHash' in legacy).toBe(false);
  });

  it('keeps operation ids climbing after a reload, like AUTOINCREMENT did', async () => {
    // Reusing an id would let a stale `markSent` ack drop a newer operation.
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    const first = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.markSent([first.id]);
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    const second = reopened.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });

    expect(second.id).toBeGreaterThan(first.id);
  });

  it('schedules the background write on window.setTimeout and cancels it on close', async () => {
    const win = stubWindow();
    try {
      const { storage, files } = makeStorage();
      const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 250 });
      log.setFileMeta(makeMeta());
      log.setFileMeta(makeMeta({ relativePath: 'b.md' }));

      // One timer for the burst, not one per change.
      expect(win.setTimeout.mock.calls.map(([, ms]) => ms)).toEqual([250]);
      await log.close();
      expect(win.clearTimeout).toHaveBeenCalledTimes(1);
      expect(files.has(PATH)).toBe(true);
    } finally {
      win.restore();
    }
  });

  it('writes through a temp file and renames over the target', async () => {
    // `write` truncates first, so a crash mid-write would leave a half
    // document — and the queue inside it is what the server can't rebuild.
    const { storage, calls } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await log.close();

    expect(calls).toContain(`write ${PATH}.tmp`);
    expect(calls).toContain(`rename ${PATH}.tmp ${PATH}`);
    expect(calls.indexOf(`write ${PATH}.tmp`)).toBeLessThan(
      calls.indexOf(`rename ${PATH}.tmp ${PATH}`),
    );
  });

  it('still writes changes that land after close()', async () => {
    // Obsidian does not await onunload: a request an engine had in flight
    // settles after the log is closed. The queue it touches is what the
    // server can't rebuild, and it used to be dropped here.
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    await log.close();

    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'late.md' });
    log.setFileMeta(makeMeta({ relativePath: 'late.md' }));
    await log.flush();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.dequeueOperations('b1').map((o) => o.filePath)).toEqual(['late.md']);
    expect(reopened.getFileMeta('b1', 'late.md')).toEqual(makeMeta({ relativePath: 'late.md' }));
  });

  it('loads the temp file when it finds the log between remove and rename', async () => {
    // The write ends with: remove the file, rename the temp over it. A copy
    // of the plugin that loads in between must not start from nothing.
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await log.close();
    files.set(`${PATH}.tmp`, files.get(PATH)!);
    files.delete(PATH);

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.pendingCount('b1')).toBe(1);
  });

  it('prefers the log itself over a leftover temp file', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await log.close();
    files.set(`${PATH}.tmp`, '{ half-written');

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.pendingCount('b1')).toBe(1);
  });

  it('close() waits for a write that is already under way', async () => {
    // `writeOnce` clears the dirty flag before its first await, so a close
    // right after an immediate write found nothing to do and returned — and
    // the next instance of the plugin read the file without that operation.
    const { storage, files } = makeStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LogStorage = {
      ...storage,
      write: async (p, data) => {
        await gate;
        await storage.write(p, data);
      },
    };
    const log = new OperationLog({ storage: slow, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    let closed = false;
    const closing = log.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await closing;
    expect(files.has(PATH)).toBe(true);
    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.pendingCount('b1')).toBe(1);
  });

  it('stops writing once a newer instance has taken the file over', async () => {
    // A request the old instance had in flight settles after the new one
    // loaded: its snapshot must not overwrite the newer file.
    const { storage } = makeStorage();
    let owner = 'old';
    const old = new OperationLog({ storage, filePath: PATH, now, ownsFile: () => owner === 'old' });
    old.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await old.close();

    owner = 'new';
    const next = new OperationLog({
      storage,
      filePath: PATH,
      now,
      ownsFile: () => owner === 'new',
    });
    await next.load();
    next.markSent(next.dequeueOperations('b1').map((o) => o.id));
    await next.flush();

    old.enqueueOperation('b1', { opType: 'UPDATE', filePath: 'late.md' });
    await old.flush();

    const reread = new OperationLog({ storage, filePath: PATH, now });
    await reread.load();
    expect(reread.pendingCount('b1')).toBe(0);
  });

  it('reads the log itself when the rename lands between the checks and the read', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await log.close();
    const doc = files.get(PATH)!;

    // `state.json` is missing and the temp file is there when checked, but
    // renamed over the file by the time it is read.
    let renamed = false;
    const racing: LogStorage = {
      ...storage,
      exists: (p) => Promise.resolve(renamed ? p === PATH : p === `${PATH}.tmp`),
      read: (p) => {
        if (p === `${PATH}.tmp`) {
          renamed = true;
          return Promise.reject(new Error('ENOENT'));
        }
        return Promise.resolve(doc);
      },
    };
    const errors: unknown[] = [];
    const reopened = new OperationLog({
      storage: racing,
      filePath: PATH,
      now,
      onError: (err) => errors.push(err),
    });
    await reopened.load();
    expect(reopened.pendingCount('b1')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('removes the temp file after falling back to writing the log in place', async () => {
    // Left behind, it would come back as the log once `state.json` is
    // deleted by hand to reset the plugin's state.
    const { storage, files } = makeStorage();
    const failingRename: LogStorage = {
      ...storage,
      rename: () => Promise.reject(new Error('EPERM')),
    };
    const log = new OperationLog({ storage: failingRename, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await log.close();

    expect(files.has(PATH)).toBe(true);
    expect(files.has(`${PATH}.tmp`)).toBe(false);
  });

  it('starts empty — and does not throw — on a corrupt document', async () => {
    // The log is a cache: the connect-time catch-up rebuilds file meta from
    // the server, so refusing to start would be the worse failure.
    const errors: unknown[] = [];
    const { storage } = makeStorage({ [PATH]: '{ truncated' });
    const log = new OperationLog({
      storage,
      filePath: PATH,
      now,
      onError: (err) => errors.push(err),
    });

    await expect(log.load()).resolves.toBeUndefined();
    expect(log.listBindingIds()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('ignores a document from a future format version', async () => {
    const { storage } = makeStorage({
      [PATH]: JSON.stringify({ version: 99, nextOpId: 5, bindings: { b1: { files: [] } } }),
    });
    const log = new OperationLog({ storage, filePath: PATH, now });
    await log.load();

    expect(log.listBindingIds()).toEqual([]);
  });

  it('skips malformed entries but keeps the readable ones', async () => {
    const { storage } = makeStorage({
      [PATH]: JSON.stringify({
        version: 1,
        nextOpId: 3,
        bindings: {
          b1: {
            pending: [
              { id: 1, opType: 'NONSENSE', filePath: 'a.md' },
              { id: 2, opType: 'CREATE', filePath: 'b.md', payload: {}, createdAt: 1 },
            ],
            files: [{ relativePath: 'x.md' }, { ...makeMeta(), relativePath: 'ok.md' }],
            state: null,
          },
        },
      }),
    });
    const log = new OperationLog({ storage, filePath: PATH, now });
    await log.load();

    expect(log.dequeueOperations('b1').map((o) => o.filePath)).toEqual(['b.md']);
    expect(log.listFileMeta('b1').map((m) => m.relativePath)).toEqual(['ok.md']);
  });

  it('does not report a binding whose stored bucket is empty', async () => {
    const { storage } = makeStorage({
      [PATH]: JSON.stringify({
        version: 1,
        nextOpId: 1,
        bindings: { b1: { pending: [], files: [], state: null } },
      }),
    });
    const log = new OperationLog({ storage, filePath: PATH, now });
    await log.load();

    expect(log.listBindingIds()).toEqual([]);
  });

  it('load is a no-op when nothing was ever written', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });

    await log.load();

    expect(log.listBindingIds()).toEqual([]);
    expect(log.pendingCount()).toBe(0);
  });

  it('reports write failures instead of throwing at the call site', async () => {
    const errors: unknown[] = [];
    const failing: LogStorage = {
      ...makeStorage().storage,
      write: () => Promise.reject(new Error('EACCES')),
    };
    const log = new OperationLog({
      storage: failing,
      filePath: PATH,
      now,
      onError: (err) => errors.push(err),
    });

    log.setFileMeta(makeMeta());
    await expect(log.close()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('a memory-only log never touches storage', async () => {
    const log = new OperationLog({ now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(log.pendingCount('b1')).toBe(1);
  });
});

describe('OperationLog — operations applied live', () => {
  it('remembers each operation once, per binding', () => {
    const log = makeLog();
    log.noteAppliedLive('b1', 'l1');
    log.noteAppliedLive('b1', 'l1');
    log.noteAppliedLive('b2', 'l2');
    expect([...log.appliedLiveIds('b1')]).toEqual(['l1']);
    expect([...log.appliedLiveIds('b2')]).toEqual(['l2']);
    expect([...log.appliedLiveIds('b3')]).toEqual([]);
  });

  it('forgets the ones it is told to', () => {
    const log = makeLog();
    for (const id of ['l1', 'l2', 'l3']) log.noteAppliedLive('b1', id);
    log.forgetAppliedLive('b1', new Set(['l1', 'l3', 'l9']));
    expect([...log.appliedLiveIds('b1')]).toEqual(['l2']);
  });

  it(`keeps the newest ${APPLIED_LIVE_MAX}`, () => {
    const log = makeLog();
    for (let i = 1; i <= APPLIED_LIVE_MAX + 5; i++) log.noteAppliedLive('b1', `l${i}`);
    const ids = log.appliedLiveIds('b1');
    expect(ids.size).toBe(APPLIED_LIVE_MAX);
    expect(ids.has('l5')).toBe(false);
    expect(ids.has('l6')).toBe(true);
    expect(ids.has(`l${APPLIED_LIVE_MAX + 5}`)).toBe(true);
  });

  it('survives a reload, and goes with the binding', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.updateLastVectorClock('b1', { d1: 1 });
    log.noteAppliedLive('b1', 'l7');
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect([...reopened.appliedLiveIds('b1')]).toEqual(['l7']);
    reopened.noteAppliedLive('b1', 'l8');
    reopened.purgeBinding('b1');
    expect([...reopened.appliedLiveIds('b1')]).toEqual([]);
  });
});
