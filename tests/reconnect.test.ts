import { computeDeepSyncDiff, flushPendingQueue, type PendingEmitter } from '@/sync/reconnect';
import Database from 'better-sqlite3';
import { OperationLog, type FileMeta } from '@/sync/operation-log';
import type { ApiFile } from '@/client/api';

describe('flushPendingQueue', () => {
  function buildLog(
    enqueued: Array<{
      opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
      filePath: string;
      newPath?: string | null;
      payload?: Record<string, unknown>;
    }>,
  ): OperationLog {
    const log = new OperationLog({ filePath: ':memory:', Database });
    for (const op of enqueued) {
      const input: {
        opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
        filePath: string;
        newPath?: string | null;
        payload?: Record<string, unknown>;
      } = { opType: op.opType, filePath: op.filePath };
      if (op.newPath !== undefined) input.newPath = op.newPath;
      if (op.payload !== undefined) input.payload = op.payload;
      log.enqueueOperation('b1', input);
    }
    return log;
  }

  it('drains every successful op and clears them from the queue', async () => {
    const log = buildLog([
      { opType: 'CREATE', filePath: 'a.md' },
      { opType: 'CREATE', filePath: 'b.md' },
    ]);
    const emit: PendingEmitter = async () => ({ ok: true });
    const result = await flushPendingQueue('b1', log, emit);
    expect(result.sent).toBe(2);
    expect(result.haltedOn).toBeNull();
    expect(result.dropped).toBeNull();
    expect(result.remaining).toBe(0);
  });

  it('halts on the first retryable failure and leaves later ops queued', async () => {
    const log = buildLog([
      { opType: 'CREATE', filePath: 'a.md' },
      { opType: 'CREATE', filePath: 'b.md' },
      { opType: 'CREATE', filePath: 'c.md' },
    ]);
    let i = 0;
    const emit: PendingEmitter = async () => {
      i++;
      if (i === 1) return { ok: true };
      return { ok: false, retryable: true, error: 'boom' };
    };
    const result = await flushPendingQueue('b1', log, emit);
    expect(result.sent).toBe(1);
    expect(result.haltedOn?.filePath).toBe('b.md');
    expect(result.remaining).toBe(2); // b.md and c.md still queued
  });

  it('drops a non-retryable failure and continues with the rest', async () => {
    const log = buildLog([
      { opType: 'CREATE', filePath: 'a.md' },
      { opType: 'CREATE', filePath: 'b.md' },
      { opType: 'CREATE', filePath: 'c.md' },
    ]);
    let i = 0;
    const emit: PendingEmitter = async () => {
      i++;
      if (i === 2) return { ok: false, retryable: false, error: 'forbidden' };
      return { ok: true };
    };
    const result = await flushPendingQueue('b1', log, emit);
    expect(result.sent).toBe(2); // a + c, b dropped
    expect(result.dropped?.filePath).toBe('b.md');
    expect(result.remaining).toBe(0);
  });

  it('treats thrown errors as retryable failures', async () => {
    const log = buildLog([{ opType: 'CREATE', filePath: 'a.md' }]);
    const emit: PendingEmitter = async () => {
      throw new Error('network down');
    };
    const result = await flushPendingQueue('b1', log, emit);
    expect(result.sent).toBe(0);
    expect(result.haltedOn).not.toBeNull();
    expect(result.remaining).toBe(1);
  });

  it('reports zero with an empty queue', async () => {
    const log = new OperationLog({ filePath: ':memory:', Database });
    const emit: PendingEmitter = async () => ({ ok: true });
    const result = await flushPendingQueue('b1', log, emit);
    expect(result).toEqual({ sent: 0, dropped: null, haltedOn: null, remaining: 0 });
  });

  it('handles long-offline scenario — 50 queued ops drain in a single call', async () => {
    const ops: Array<{
      opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
      filePath: string;
    }> = [];
    for (let i = 0; i < 50; i++) ops.push({ opType: 'CREATE', filePath: `f${i}.md` });
    const log = buildLog(ops);
    const emit: PendingEmitter = async () => ({ ok: true });
    const result = await flushPendingQueue('b1', log, emit);
    expect(result.sent).toBe(50);
    expect(log.pendingCount('b1')).toBe(0);
  });
});

describe('computeDeepSyncDiff', () => {
  function makeMeta(over: Partial<FileMeta> = {}): FileMeta {
    return {
      bindingId: 'b1',
      relativePath: 'note.md',
      serverFileId: 'sf-1',
      contentHash: 'h-local',
      size: 10,
      fileType: 'TEXT',
      lastSyncedAt: 0,
      ...over,
    };
  }
  function makeFile(over: Partial<ApiFile> = {}): ApiFile {
    return {
      id: 'sf-1',
      path: 'note.md',
      fileType: 'TEXT',
      contentHash: 'h-server',
      size: 10,
      mimeType: null,
      deletedAt: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      lastModifiedById: null,
      ...over,
    };
  }

  function makeApi(files: ApiFile[]): { getProjectFiles: () => Promise<ApiFile[]> } {
    return { getProjectFiles: async () => files };
  }
  function makeLog(metas: FileMeta[]): { listFileMeta: (id: string) => FileMeta[] } {
    return { listFileMeta: () => metas };
  }

  it('returns empty diff when both sides agree', async () => {
    const file = makeFile({ contentHash: 'h-same' });
    const meta = makeMeta({ contentHash: 'h-same' });
    const diff = await computeDeepSyncDiff('b1', 'p1', makeApi([file]), makeLog([meta]));
    expect(diff.serverOnly).toEqual([]);
    expect(diff.localOnly).toEqual([]);
    expect(diff.hashMismatches).toEqual([]);
  });

  it('reports server-only files', async () => {
    const file = makeFile({ id: 'sf-2', path: 'fresh.md' });
    const diff = await computeDeepSyncDiff('b1', 'p1', makeApi([file]), makeLog([]));
    expect(diff.serverOnly).toHaveLength(1);
    expect(diff.serverOnly[0]?.path).toBe('fresh.md');
  });

  it('reports local-only metas (offline create not yet uploaded)', async () => {
    const meta = makeMeta({ relativePath: 'pending.md' });
    const diff = await computeDeepSyncDiff('b1', 'p1', makeApi([]), makeLog([meta]));
    expect(diff.localOnly).toHaveLength(1);
    expect(diff.localOnly[0]?.relativePath).toBe('pending.md');
  });

  it('reports hash mismatches as conflicts', async () => {
    const file = makeFile({ contentHash: 'h-server' });
    const meta = makeMeta({ contentHash: 'h-local' });
    const diff = await computeDeepSyncDiff('b1', 'p1', makeApi([file]), makeLog([meta]));
    expect(diff.hashMismatches).toHaveLength(1);
    expect(diff.hashMismatches[0]?.server.path).toBe('note.md');
    expect(diff.hashMismatches[0]?.local.contentHash).toBe('h-local');
  });

  it('returns a mix on a long-offline scenario', async () => {
    const files: ApiFile[] = [
      makeFile({ id: 'sf-1', path: 'shared.md', contentHash: 'h-server' }),
      makeFile({ id: 'sf-2', path: 'server-new.md' }),
    ];
    const metas: FileMeta[] = [
      makeMeta({ relativePath: 'shared.md', contentHash: 'h-local' }),
      makeMeta({ relativePath: 'local-new.md', serverFileId: 'sf-stale' }),
    ];
    const diff = await computeDeepSyncDiff('b1', 'p1', makeApi(files), makeLog(metas));
    expect(diff.serverOnly.map((f) => f.path)).toEqual(['server-new.md']);
    expect(diff.localOnly.map((m) => m.relativePath)).toEqual(['local-new.md']);
    expect(diff.hashMismatches.map((m) => m.server.path)).toEqual(['shared.md']);
  });
});
