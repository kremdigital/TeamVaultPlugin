import type { ApiClient, ApiFile } from '@/client/api';
import type { OperationLog, PendingOperation, FileMeta } from './operation-log';

/**
 * Reconnect / catch-up helpers — pulled out of `SyncEngine` for two reasons:
 *
 *   1. Each piece (pending-queue replay, deep-sync diff) is independently
 *      reusable: a future "Sync now" command (Stage 10) will call them
 *      directly, without going through the full engine reconnect cycle.
 *
 *   2. They're easier to test in isolation than the orchestrator — see
 *      `tests/reconnect.test.ts`.
 *
 * Catch-up apply (server operations + Yjs hydrate) stays inside the engine
 * because it touches engine-private state (the file index, doc manager
 * subscriptions). Lifting that out would require re-plumbing private fields,
 * which the existing sync-engine tests already cover end-to-end.
 */

// -- Pending queue replay -----------------------------------------------------

/** Per-op outcome reported by the emitter. */
export type ReplayOutcome = { ok: true } | { ok: false; retryable: boolean; error: string };

/**
 * Fed one pending op at a time. Returns `ok: true` when the server ack'd,
 * `ok: false` otherwise. The caller can mark `retryable: false` to discard
 * a permanently failing op (e.g. the file was renamed away on the server).
 */
export type PendingEmitter = (op: PendingOperation) => Promise<ReplayOutcome>;

export interface FlushResult {
  /** Number of operations the server acknowledged. */
  sent: number;
  /** First op the server rejected as non-retryable, if any. */
  dropped: PendingOperation | null;
  /** First op that failed retryably (we stop and leave the rest queued). */
  haltedOn: PendingOperation | null;
  /** Total ops still in the queue after this drain. */
  remaining: number;
}

/**
 * Drain `pending_operations` for a binding through the supplied emitter.
 *
 * Stops at the first **retryable** failure — a transient 5xx must not
 * cause the user's offline edits to silently disappear. **Non-retryable**
 * failures (the op no longer makes sense — file deleted on the server,
 * for example) are removed from the queue and reported as `dropped` so
 * the caller can log them.
 */
export async function flushPendingQueue(
  bindingId: string,
  log: OperationLog,
  emit: PendingEmitter,
): Promise<FlushResult> {
  const pending = log.dequeueOperations(bindingId);
  const sentIds: number[] = [];
  let dropped: PendingOperation | null = null;
  let haltedOn: PendingOperation | null = null;

  for (const op of pending) {
    const outcome = await safeEmit(op, emit);
    if (outcome.ok) {
      sentIds.push(op.id);
      continue;
    }
    if (outcome.retryable) {
      haltedOn = op;
      break;
    }
    // Non-retryable: drop it and keep going. We track only the first one
    // for reporting; the rest are still surfaced via `remaining`.
    sentIds.push(op.id);
    if (!dropped) dropped = op;
  }

  if (sentIds.length > 0) log.markSent(sentIds);
  return {
    sent: sentIds.length - (dropped ? 1 : 0),
    dropped,
    haltedOn,
    remaining: log.pendingCount(bindingId),
  };
}

async function safeEmit(op: PendingOperation, emit: PendingEmitter): Promise<ReplayOutcome> {
  try {
    return await emit(op);
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// -- Deep-sync diff -----------------------------------------------------------

export interface DeepSyncDiff {
  /** Files the server has but the local cache doesn't. Need to be downloaded. */
  serverOnly: ApiFile[];
  /** Local cached paths the server doesn't know about. Either we missed an
   *  upload (offline create) or the server purged them. The caller decides. */
  localOnly: FileMeta[];
  /** Same path on both sides but the content hash differs. The engine needs
   *  to reconcile (text via CRDT merge, binary via the conflict modal). */
  hashMismatches: Array<{ server: ApiFile; local: FileMeta }>;
}

/**
 * Compare the server's authoritative file list against the local cache
 * inside `operationLog`. Used by the long-offline flow
 * to surface every divergence so the engine can replay the correct
 * operation per file.
 */
export async function computeDeepSyncDiff(
  bindingId: string,
  projectId: string,
  apiClient: Pick<ApiClient, 'getProjectFiles'>,
  operationLog: Pick<OperationLog, 'listFileMeta'>,
): Promise<DeepSyncDiff> {
  const [serverFiles, localMetas] = await Promise.all([
    apiClient.getProjectFiles(projectId),
    Promise.resolve(operationLog.listFileMeta(bindingId)),
  ]);

  const serverByPath = new Map(serverFiles.map((f) => [f.path, f]));
  const localByPath = new Map(localMetas.map((m) => [m.relativePath, m]));

  const serverOnly: ApiFile[] = [];
  const localOnly: FileMeta[] = [];
  const hashMismatches: Array<{ server: ApiFile; local: FileMeta }> = [];

  for (const file of serverFiles) {
    const local = localByPath.get(file.path);
    if (!local) {
      serverOnly.push(file);
    } else if (local.contentHash !== file.contentHash) {
      hashMismatches.push({ server: file, local });
    }
  }
  for (const meta of localMetas) {
    if (!serverByPath.has(meta.relativePath)) localOnly.push(meta);
  }

  return { serverOnly, localOnly, hashMismatches };
}
