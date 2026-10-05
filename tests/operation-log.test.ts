import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLIED_LIVE_MAX,
  DELETE_ASKED_MAX,
  OperationLog,
  StateNotWrittenError,
  isOpId,
  newOpId,
  type FileMeta,
} from '@/sync/operation-log';
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

  it('counts the operations the drain replays: not the answers to questions, not those in flight', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md', settleOnly: true });
    log.recordInFlight('b1', { opType: 'DELETE', filePath: 'c.md', opId: newOpId() });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'd.md' });
    expect(log.pendingCount('b1')).toBe(2);
    expect(log.replayableCount('b1')).toBe(1);
    expect(log.replayableCount('b3')).toBe(0);
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

  it('knows a create queued under a path: of that binding, queued, and a create', () => {
    const log = makeLog();
    const created = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'RENAME', filePath: 'b.md', newPath: 'c.md' });
    log.recordInFlight('b1', { opType: 'CREATE', filePath: 'd.md', opId: newOpId() });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'e.md' });
    expect(log.queuesCreate('b1', 'a.md')).toBe(true);
    expect(log.queuesCreate('b1', 'A.md')).toBe(false);
    expect(log.queuesCreate('b1', 'b.md')).toBe(false);
    expect(log.queuesCreate('b1', 'c.md')).toBe(false);
    expect(log.queuesCreate('b1', 'd.md')).toBe(false);
    expect(log.queuesCreate('b1', 'e.md')).toBe(false);
    expect(log.queuesCreate('b3', 'a.md')).toBe(false);
    log.amendOperation(created.id, { filePath: 'f.md' });
    expect(log.queuesCreate('b1', 'a.md')).toBe(false);
    expect(log.queuesCreate('b1', 'f.md')).toBe(true);
    log.markSent([created.id]);
    expect(log.queuesCreate('b1', 'f.md')).toBe(false);
  });

  it('lists the entries of the creates queued under a path, in queue order', () => {
    const log = makeLog();
    const first = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'UPDATE', filePath: 'a.md' });
    log.recordInFlight('b1', { opType: 'CREATE', filePath: 'a.md', opId: newOpId() });
    log.enqueueOperation('b2', { opType: 'CREATE', filePath: 'a.md' });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'A.md' });
    const second = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    expect(log.queuedCreates('b1', 'a.md')).toEqual([first.id, second.id]);
    expect(log.queuedCreates('b3', 'a.md')).toEqual([]);
    log.markSent([first.id]);
    expect(log.queuedCreates('b1', 'a.md')).toEqual([second.id]);
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
        opId: op.opId,
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

  it('round-trips the mark of a file whose content never reached the disk', async () => {
    // Lost on a reload, the file came back from `state.json` as one this
    // device had a copy of, and a file saved under its name was sent as its
    // new version.
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.setFileMeta(makeMeta({ relativePath: 'theirs.png', notOnDisk: true }));
    log.setFileMeta(makeMeta({ relativePath: 'mine.png' }));
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.getFileMeta('b1', 'theirs.png')?.notOnDisk).toBe(true);
    const mine = reopened.getFileMeta('b1', 'mine.png');
    expect(mine).toEqual(makeMeta({ relativePath: 'mine.png' }));
    expect(mine && 'notOnDisk' in mine).toBe(false);
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

describe('OperationLog — copies asked about after a server delete', () => {
  it('remembers each file once, per binding, and forgets the ones it is told to', () => {
    const log = makeLog();
    log.noteDeleteAsked('b1', 'f1');
    log.noteDeleteAsked('b1', 'f1');
    log.noteDeleteAsked('b1', 'f2');
    log.noteDeleteAsked('b2', 'f3');
    expect([...log.deleteAskedIds('b1')]).toEqual(['f1', 'f2']);
    expect([...log.deleteAskedIds('b2')]).toEqual(['f3']);
    log.forgetDeleteAsked('b1', ['f1', 'f9']);
    expect([...log.deleteAskedIds('b1')]).toEqual(['f2']);
    expect([...log.deleteAskedIds('b3')]).toEqual([]);
  });

  it(`keeps the newest ${DELETE_ASKED_MAX}`, () => {
    const log = makeLog();
    for (let i = 1; i <= DELETE_ASKED_MAX + 2; i++) log.noteDeleteAsked('b1', `f${i}`);
    const ids = log.deleteAskedIds('b1');
    expect(ids.size).toBe(DELETE_ASKED_MAX);
    expect(ids.has('f2')).toBe(false);
    expect(ids.has('f3')).toBe(true);
  });

  it('survives a reload, and goes with the binding', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.setFileMeta(makeMeta());
    log.noteDeleteAsked('b1', 'f7');
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect([...reopened.deleteAskedIds('b1')]).toEqual(['f7']);
    reopened.purgeBinding('b1');
    expect([...reopened.deleteAskedIds('b1')]).toEqual([]);
  });
});

describe('OperationLog — operation ids', () => {
  it('gives each queued operation an opId, and keeps one it is given', () => {
    const log = makeLog();
    const a = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    const b = log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'b.md',
      opId: '0f8d7c6b-5a4e-4d3c-8b2a-1f0e9d8c7b6a',
    });
    expect(isOpId(a.opId)).toBe(true);
    expect(b.opId).toBe('0f8d7c6b-5a4e-4d3c-8b2a-1f0e9d8c7b6a');
    expect(log.dequeueOperations('b1').map((op) => op.opId)).toEqual([a.opId, b.opId]);
  });

  it('keeps the opId when a queued operation is retargeted or amended', () => {
    const log = makeLog();
    const op = log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'a.md',
      newPath: 'b.md',
      payload: { fileId: 'f1' },
    });
    log.retargetOperation(op.id, 'c.md');
    log.amendOperation(op.id, { filePath: 'z.md', payload: { fileId: 'f1', x: 1 } });
    expect(log.dequeueOperations('b1')).toEqual([
      expect.objectContaining({ id: op.id, opId: op.opId, filePath: 'z.md', newPath: 'c.md' }),
    ]);
  });

  it('keeps operations in flight out of the queue the drain reads', () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'queued.md' });
    const out = log.recordInFlight('b1', {
      opType: 'RENAME',
      filePath: 'a.md',
      newPath: 'b.md',
      payload: { fileId: 'f1' },
      opId: 'c1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8',
    });
    expect(log.dequeueOperations('b1').map((op) => op.filePath)).toEqual(['queued.md']);
    expect(log.inFlightOperations('b1').map((op) => op.opId)).toEqual([out.opId]);
    expect(log.isInFlight('b1', out.opId)).toBe(true);
    expect(log.findByOpId('b1', out.opId)).toEqual(out);
    // Not queued, but unsettled: its paths are not uploaded as new files.
    expect(log.pendingCount('b1')).toBe(1);
    expect([...log.pendingPaths('b1')].sort()).toEqual(['a.md', 'b.md', 'queued.md']);
    expect(log.listBindingIds()).toEqual(['b1']);
  });

  it('clears an operation in flight once answered', () => {
    const log = makeLog();
    const out = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'a.md', opId: opIdOf(1) });
    expect(log.clearInFlight('b1', out.opId)).toBe(true);
    expect(log.clearInFlight('b1', out.opId)).toBe(false);
    expect(log.inFlightOperations('b1')).toEqual([]);
    expect(log.pendingCount('b1')).toBe(0);
  });

  it('puts an operation in flight back in the queue at its place, rotated when voided', () => {
    const log = makeLog();
    const first = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'first.md' });
    const out = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'a.md', opId: opIdOf(1) });
    const later = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'later.md' });
    const back = log.requeueInFlight('b1', out.opId);
    expect(back?.opId).toBe(out.opId);
    expect(log.dequeueOperations('b1').map((op) => op.id)).toEqual([first.id, out.id, later.id]);

    const again = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'x.md', opId: opIdOf(2) });
    const rotated = log.requeueInFlight('b1', again.opId, { rotate: true });
    expect(rotated?.id).toBe(again.id);
    expect(isOpId(rotated?.opId)).toBe(true);
    expect(rotated?.opId).not.toBe(again.opId);
    expect(log.requeueInFlight('b1', again.opId)).toBeNull();
  });

  it('rotates an opId and replaces an operation in its place', () => {
    const log = makeLog();
    const a = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    const b = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'b.md' });
    const c = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'c.md' });
    const rotated = log.rotateOpId('b1', b.id);
    expect(isOpId(rotated)).toBe(true);
    expect(rotated).not.toBe(b.opId);
    expect(log.rotateOpId('b1', 999)).toBe('');

    const replaced = log.replaceOperation('b1', b.id, {
      opType: 'RENAME',
      filePath: 'x.md',
      newPath: 'b.md',
      payload: { fileId: 'f2' },
    });
    expect(replaced?.id).toBe(b.id);
    expect(replaced?.opId).not.toBe(rotated);
    expect(log.dequeueOperations('b1').map((op) => `${op.id} ${op.opType} ${op.filePath}`)).toEqual(
      [`${a.id} CREATE a.md`, `${b.id} RENAME x.md`, `${c.id} CREATE c.md`],
    );
    expect(log.replaceOperation('b1', 999, { opType: 'DELETE', filePath: 'q.md' })).toBeNull();
  });

  it('keeps the settle-only mark of an answer to a question', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    const out = log.recordInFlight('b1', {
      opType: 'CREATE',
      filePath: 'asked.md',
      opId: opIdOf(3),
      settleOnly: true,
    });
    await log.close();
    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.dequeueOperations('b1')).toEqual([
      expect.objectContaining({ opId: out.opId, settleOnly: true }),
    ]);
  });
});

/** A fixed operation id: `n` in its last group. */
function opIdOf(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface StoredDoc {
  bindings: {
    b1: { pending: Array<{ opId: string }>; inflight?: Array<{ opId: string }>; files: unknown[] };
  };
}

describe('OperationLog — operations in flight on disk', () => {
  it('amends the payload of an operation in flight: on disk only once a write after it went through', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    const out = log.recordInFlight('b1', {
      opType: 'DELETE',
      filePath: 'dir/c.png',
      payload: { fileId: 'f1', lastSynced: ['h1'], recheck: true, folder: 'dir' },
      opId: opIdOf(1),
    });
    await log.persistNow();
    expect(log.inFlightWritten('b1', out.opId)).toBe(true);

    // The same values, whatever the order of their keys: nothing to write.
    expect(
      log.amendInFlight('b1', out.opId, {
        folder: 'dir',
        recheck: true,
        lastSynced: ['h1'],
        fileId: 'f1',
      }),
    ).toBe(false);
    expect(log.inFlightWritten('b1', out.opId)).toBe(true);

    // Writes stay on their way until released.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = storage.write.bind(storage);
    storage.write = async (p, data): Promise<void> => {
      await held;
      return write(p, data);
    };
    expect(
      log.amendInFlight('b1', out.opId, { fileId: 'f1', lastSynced: ['h1'], folder: 'dir' }),
    ).toBe(true);
    // Not on disk yet: the operation waits for the write.
    expect(log.inFlightWritten('b1', out.opId)).toBe(false);
    expect(log.findByOpId('b1', out.opId)?.payload).toEqual({
      fileId: 'f1',
      lastSynced: ['h1'],
      folder: 'dir',
    });
    const written = log.persistNow();
    release();
    await written;
    expect(log.inFlightWritten('b1', out.opId)).toBe(true);
    const doc = JSON.parse(files.get(PATH) ?? '{}') as {
      bindings: { b1: { inflight: Array<{ opId: string; payload: Record<string, unknown> }> } };
    };
    expect(doc.bindings.b1.inflight.map((op) => op.payload)).toEqual([
      { fileId: 'f1', lastSynced: ['h1'], folder: 'dir' },
    ]);

    // Back in the queue, or never in flight: nothing to amend.
    log.requeueInFlight('b1', out.opId);
    expect(log.amendInFlight('b1', out.opId, { fileId: 'f2' })).toBe(false);
    expect(log.amendInFlight('b1', opIdOf(2), { fileId: 'f2' })).toBe(false);
    expect(log.dequeueOperations('b1').map((op) => op.payload)).toEqual([
      { fileId: 'f1', lastSynced: ['h1'], folder: 'dir' },
    ]);
    await log.close();
  });

  it('writes an operation in flight at once, before its emit', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    const out = log.recordInFlight('b1', {
      opType: 'RENAME',
      filePath: 'a.md',
      newPath: 'b.md',
      payload: { fileId: 'f1' },
      opId: opIdOf(1),
    });
    await log.persistNow();
    const doc = JSON.parse(files.get(PATH) ?? '{}') as StoredDoc;
    expect((doc.bindings.b1.inflight ?? []).map((op) => op.opId)).toEqual([out.opId]);
    await log.close();
  });

  it('loads operations in flight back into the queue, in id order', async () => {
    const { storage } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now });
    const a = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    const out = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'b.md', opId: opIdOf(2) });
    const c = log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'c.md' });
    await log.close();

    const reopened = new OperationLog({ storage, filePath: PATH, now });
    await reopened.load();
    expect(reopened.inFlightOperations('b1')).toEqual([]);
    expect(reopened.dequeueOperations('b1').map((op) => [op.id, op.opId])).toEqual([
      [a.id, a.opId],
      [out.id, out.opId],
      [c.id, c.opId],
    ]);
    // New operations keep climbing past both.
    expect(reopened.enqueueOperation('b1', { opType: 'CREATE', filePath: 'd.md' }).id).toBe(
      c.id + 1,
    );
  });

  it('loads a state.json written by 0.4.0 as it is', async () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'state-0.4.0.json'), 'utf8');
    const { storage, files } = makeStorage({ [PATH]: raw });
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    await log.load();

    // What was in flight is back in the queue, at its place, ids and payloads kept.
    expect(log.inFlightOperations('b1')).toEqual([]);
    expect(
      log
        .dequeueOperations('b1')
        .map((op) => [op.id, op.opType, op.opId, op.payload, op.settleOnly]),
    ).toEqual([
      [21, 'RENAME', '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6', { fileId: 'f3' }, undefined],
      [
        22,
        'UPDATE',
        '1a2b3c4d-5e6f-4a7b-9c8d-e0f1a2b3c4d5',
        { fileId: 'f7', contentHash: 'h-photo-2', size: 2048 },
        undefined,
      ],
      [
        23,
        'CREATE',
        '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f70819',
        { fileType: 'TEXT', contentHash: 'h-asked', size: 6 },
        true,
      ],
    ]);
    expect(log.getFileMeta('b1', 'Notes/a.md')).toMatchObject({
      serverFileId: 'f3',
      foldedHash: 'h-a',
    });
    expect(log.getFileMeta('b1', 'img/photo.png')).toMatchObject({
      fileType: 'BINARY',
      size: 1024,
    });
    expect(log.getFileMeta('b1', 'Theirs.md')?.notOnDisk).toBe(true);
    expect(log.getBindingState('b1')?.lastVectorClock).toEqual({ 'device-1': 21, 'device-2': 4 });
    expect([...log.appliedLiveIds('b1')]).toEqual(['cl_31', 'cl_32']);
    expect([...log.deleteAskedIds('b1')]).toEqual(['f5']);
    // Nothing to write: every id was there, and the file is not rewritten on load.
    for (const op of log.dequeueOperations('b1'))
      expect(log.queuedWritten('b1', op.opId)).toBe(true);
    expect(log.hasUnwrittenChanges()).toBe(false);
    await log.flush();
    expect(files.get(PATH)).toBe(raw);
    // New operations keep climbing past the file's counter.
    expect(log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'n.md' }).id).toBe(24);
    await log.close();
  });

  it('gives a new id to an entry whose id is malformed or seen twice', async () => {
    const doc = {
      version: 1,
      nextOpId: 4,
      bindings: {
        b1: {
          pending: [
            { id: 1, opType: 'DELETE', filePath: 'a.md', payload: {}, opId: 'NOT-A-UUID' },
            { id: 2, opType: 'DELETE', filePath: 'b.md', payload: {}, opId: opIdOf(7) },
          ],
          inflight: [{ id: 3, opType: 'DELETE', filePath: 'c.md', payload: {}, opId: opIdOf(7) }],
        },
      },
    };
    const { storage } = makeStorage({ [PATH]: JSON.stringify(doc) });
    const log = new OperationLog({ storage, filePath: PATH, now });
    await log.load();
    const ids = log.dequeueOperations('b1').map((op) => op.opId);
    expect(ids[1]).toBe(opIdOf(7));
    expect(ids.every((id) => isOpId(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('OperationLog — persistNow and unwritten changes', () => {
  it('resolves at once for a log without storage', async () => {
    const log = makeLog();
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    await expect(log.persistNow()).resolves.toBeUndefined();
    expect(log.hasUnwrittenChanges()).toBe(false);
  });

  it('writes what waits out the debounce, and reports nothing unwritten after', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    log.setFileMeta(makeMeta());
    expect(log.hasUnwrittenChanges()).toBe(true);
    expect(files.has(PATH)).toBe(false);
    await log.persistNow();
    expect(files.has(PATH)).toBe(true);
    expect(log.hasUnwrittenChanges()).toBe(false);
    await log.close();
  });

  // Obsidian's quit shows "Saving..." while the plugin's task runs (see
  // `main.ts`): a delay left running after the change was written is nothing
  // to wait for.
  it('reports nothing unwritten once a flush wrote a change still waiting out its delay', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    log.setFileMeta(makeMeta());
    await log.flush();
    expect(files.has(PATH)).toBe(true);
    expect(log.hasUnwrittenChanges()).toBe(false);
    await log.close();
  });

  it('counts a write under way as unwritten', async () => {
    const { storage } = makeStorage();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const write = storage.write.bind(storage);
    storage.write = async (p, data): Promise<void> => {
      await held;
      return write(p, data);
    };
    const log = new OperationLog({ storage, filePath: PATH, now });
    log.enqueueOperation('b1', { opType: 'CREATE', filePath: 'a.md' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(log.hasUnwrittenChanges()).toBe(true);
    release();
    await log.flush();
    expect(log.hasUnwrittenChanges()).toBe(false);
  });

  it('rejects when the write fails, and the operation must not go out', async () => {
    const { storage } = makeStorage();
    storage.write = (): Promise<void> => Promise.reject(new Error('disk full'));
    const errors: unknown[] = [];
    const log = new OperationLog({
      storage,
      filePath: PATH,
      now,
      onError: (err) => errors.push(err),
    });
    log.recordInFlight('b1', { opType: 'DELETE', filePath: 'a.md', opId: opIdOf(1) });
    await expect(log.persistNow()).rejects.toBeInstanceOf(StateNotWrittenError);
    expect(errors.length).toBeGreaterThan(0);
    expect(log.hasUnwrittenChanges()).toBe(true);
  });

  it('rejects once a newer instance has taken the file over', async () => {
    const { storage, files } = makeStorage();
    let owns = true;
    const log = new OperationLog({ storage, filePath: PATH, now, ownsFile: () => owns });
    owns = false;
    log.recordInFlight('b1', { opType: 'DELETE', filePath: 'a.md', opId: opIdOf(1) });
    await expect(log.persistNow()).rejects.toThrow('taken_over');
    expect(files.has(PATH)).toBe(false);
  });

  it('rejects when the file is taken over while the write is on its way', async () => {
    const { storage } = makeStorage();
    let owns = true;
    const exists = storage.exists.bind(storage);
    storage.exists = (p): Promise<boolean> => {
      owns = false;
      return exists(p);
    };
    const log = new OperationLog({ storage, filePath: PATH, now, ownsFile: () => owns });
    log.setFileMeta(makeMeta());
    await expect(log.persistNow()).rejects.toBeInstanceOf(StateNotWrittenError);
  });

  it('tells whether an operation in flight is on disk yet: once a write begun after it went through', async () => {
    const { storage } = makeStorage();
    let failing = false;
    const write = storage.write.bind(storage);
    storage.write = (p, data): Promise<void> =>
      failing ? Promise.reject(new Error('disk full')) : write(p, data);
    const log = new OperationLog({
      storage,
      filePath: PATH,
      now,
      flushDelayMs: 60_000,
      onError: () => undefined,
    });
    const a = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'a.md', opId: opIdOf(1) });
    const b = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'b.md', opId: opIdOf(2) });
    expect(log.inFlightWritten('b1', a.opId)).toBe(false);
    await log.persistNow();
    // Recorded together, written together: the second needs no write of its own.
    expect(log.inFlightWritten('b1', a.opId)).toBe(true);
    expect(log.inFlightWritten('b1', b.opId)).toBe(true);
    // Recorded after that write, and the next one fails: not on disk.
    failing = true;
    const c = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'c.md', opId: opIdOf(3) });
    await expect(log.persistNow()).rejects.toBeInstanceOf(StateNotWrittenError);
    expect(log.inFlightWritten('b1', c.opId)).toBe(false);
    failing = false;
    await log.persistNow();
    expect(log.inFlightWritten('b1', c.opId)).toBe(true);
    // Not in flight any more: answered, or back in the queue.
    log.clearInFlight('b1', a.opId);
    log.requeueInFlight('b1', b.opId);
    expect(log.inFlightWritten('b1', a.opId)).toBe(false);
    expect(log.inFlightWritten('b1', b.opId)).toBe(false);
    // A log without storage has nothing to wait for.
    const memory = makeLog();
    const d = memory.recordInFlight('b1', { opType: 'DELETE', filePath: 'd.md', opId: opIdOf(4) });
    expect(memory.inFlightWritten('b1', d.opId)).toBe(true);
    await log.close();
  });

  it('tells whether a queued operation is on disk under its opId: loaded, or written since it got it', async () => {
    const { storage } = makeStorage();
    let failing = false;
    const write = storage.write.bind(storage);
    storage.write = (p, data): Promise<void> =>
      failing ? Promise.reject(new Error('disk full')) : write(p, data);
    let owns = true;
    const options = {
      storage,
      filePath: PATH,
      now,
      flushDelayMs: 60_000,
      onError: (): void => undefined,
      ownsFile: (): boolean => owns,
    };
    const log = new OperationLog(options);
    failing = true;
    const a = log.enqueueOperation('b1', { opType: 'DELETE', filePath: 'a.md' });
    const b = log.enqueueOperation('b1', { opType: 'DELETE', filePath: 'b.md' });
    // The immediate write failed: neither is on disk.
    await expect(log.persistNow()).rejects.toBeInstanceOf(StateNotWrittenError);
    expect(log.queuedWritten('b1', a.opId)).toBe(false);
    failing = false;
    await log.persistNow();
    expect(log.queuedWritten('b1', a.opId)).toBe(true);
    expect(log.queuedWritten('b1', b.opId)).toBe(true);
    // Another change since does not take them off the disk.
    log.setFileMeta(makeMeta());
    expect(log.queuedWritten('b1', a.opId)).toBe(true);

    // A new id is on disk only once a write after it went through.
    failing = true;
    const rotated = log.rotateOpId('b1', a.id);
    const replaced = log.replaceOperation('b1', b.id, { opType: 'DELETE', filePath: 'c.md' });
    await expect(log.persistNow()).rejects.toBeInstanceOf(StateNotWrittenError);
    expect(log.queuedWritten('b1', rotated)).toBe(false);
    expect(log.queuedWritten('b1', replaced?.opId ?? '')).toBe(false);
    // Not queued any more (the id before the rotation, too).
    expect(log.queuedWritten('b1', a.opId)).toBe(false);
    failing = false;
    await log.persistNow();
    expect(log.queuedWritten('b1', rotated)).toBe(true);
    expect(log.queuedWritten('b1', replaced?.opId ?? '')).toBe(true);

    // Put back from flight: on disk as its record in flight was; rotated, not.
    const out = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'd.md', opId: opIdOf(9) });
    await log.persistNow();
    expect(log.requeueInFlight('b1', out.opId)?.opId).toBe(out.opId);
    expect(log.queuedWritten('b1', out.opId)).toBe(true);
    const e = log.recordInFlight('b1', { opType: 'DELETE', filePath: 'e.md', opId: opIdOf(10) });
    await log.persistNow();
    const back = log.requeueInFlight('b1', e.opId, { rotate: true });
    expect(log.queuedWritten('b1', back?.opId ?? '')).toBe(false);
    await log.persistNow();
    expect(log.queuedWritten('b1', back?.opId ?? '')).toBe(true);

    // Loaded from the disk: there already.
    await log.close();
    const loaded = new OperationLog(options);
    await loaded.load();
    for (const op of loaded.dequeueOperations('b1')) {
      expect(loaded.queuedWritten('b1', op.opId)).toBe(true);
    }
    // A newer instance has the file: the caller writes, and hears so.
    owns = false;
    expect(loaded.queuedWritten('b1', rotated)).toBe(false);
    owns = true;
    // Sent: not queued.
    loaded.markSent([a.id]);
    expect(loaded.queuedWritten('b1', rotated)).toBe(false);
    // A log without storage has nothing to wait for.
    const memory = makeLog();
    const m = memory.enqueueOperation('b1', { opType: 'DELETE', filePath: 'm.md' });
    expect(memory.queuedWritten('b1', m.opId)).toBe(true);
    await loaded.close();
  });

  it('puts the ids it gives a queue on disk before one of them can go out', async () => {
    // Entries without an id, or with one seen twice: a damaged file.
    const raw = JSON.stringify({
      version: 1,
      nextOpId: 4,
      bindings: {
        b1: {
          pending: [
            { id: 1, opType: 'DELETE', filePath: 'a.md', payload: { fileId: 'f1' } },
            { id: 2, opType: 'DELETE', filePath: 'b.md', payload: {}, opId: opIdOf(7) },
            { id: 3, opType: 'DELETE', filePath: 'c.md', payload: {}, opId: opIdOf(7) },
          ],
        },
      },
    });
    const { storage, files } = makeStorage({ [PATH]: raw });
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    await log.load();
    const [first] = log.dequeueOperations('b1');
    expect(first).toBeDefined();
    expect(log.queuedWritten('b1', first?.opId ?? '')).toBe(false);
    // Not written only because it was read.
    expect(log.hasUnwrittenChanges()).toBe(false);
    await log.flush();
    expect(files.get(PATH)).toBe(raw);
    await log.persistNow();
    expect(log.queuedWritten('b1', first?.opId ?? '')).toBe(true);
    const onDisk = JSON.parse(files.get(PATH) ?? '{}') as StoredDoc;
    expect(onDisk.bindings.b1.pending.map((op) => op.opId)).toEqual(
      log.dequeueOperations('b1').map((op) => op.opId),
    );
    await log.close();
  });

  it('writes an answered operation’s removal with the debounce, together with its result', async () => {
    const { storage, files } = makeStorage();
    const log = new OperationLog({ storage, filePath: PATH, now, flushDelayMs: 60_000 });
    const out = log.recordInFlight('b1', { opType: 'CREATE', filePath: 'n.md', opId: opIdOf(4) });
    await log.persistNow();
    // The answer: its result and the removal in one synchronous block.
    log.setFileMeta(makeMeta({ relativePath: 'n.md', serverFileId: 'f9' }));
    log.clearInFlight('b1', out.opId);
    const before = JSON.parse(files.get(PATH) ?? '{}') as StoredDoc;
    // Still the snapshot from before the answer: the entry, not the result.
    expect(before.bindings.b1.inflight).toHaveLength(1);
    expect(before.bindings.b1.files).toEqual([]);
    expect(log.hasUnwrittenChanges()).toBe(true);
    await log.persistNow();
    const after = JSON.parse(files.get(PATH) ?? '{}') as StoredDoc;
    expect(after.bindings.b1.inflight).toBeUndefined();
    expect(after.bindings.b1.files).toHaveLength(1);
    await log.close();
  });
});
