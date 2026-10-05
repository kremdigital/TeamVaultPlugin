import type { LogStorage } from '@/utils/file-log-sink';
import { uuid } from '@/utils/id';
import type { VectorClock } from './vector-clock';

/**
 * Local operation log — the offline-first backbone of the plugin.
 *
 * Three logical concerns:
 *
 *   1. **binding state** — per-binding sync cursor (`lastVectorClock`,
 *      `lastSyncedAt`). Used at reconnect to ask the server "what changed
 *      since this point".
 *
 *   2. **pending operations** — operations produced locally that haven't
 *      been confirmed by the server yet. Drained on reconnect.
 *
 *   3. **file meta** — local mirror of server-side metadata for every file
 *      we track: server file id, content hash, size, type. Lets us decide
 *      whether an incoming UPDATE actually changes anything and what to do
 *      at conflict time.
 *
 *   4. **operations in flight** — live operations sent (or about to be sent)
 *      and not answered yet, each written here before it goes out (see
 *      {@link OperationLog.recordInFlight}). A restart finds them back in the
 *      queue, under the same `opId`, and asks the server what became of them.
 *
 * ## Operation ids
 *
 * Every operation carries an `opId` (UUID v4), given once when the operation
 * is recorded and kept across every resend until the server declares it
 * voided (see `sync-protocol.md`, «Идемпотентность операций»). The server
 * applies an `opId` at most once and answers a resend with the original
 * outcome, so an operation whose answer was lost can be sent again safely,
 * and the next connect asks the server (`ops:status`) which of the
 * unanswered ones it applied.
 *
 * ## Why this isn't SQLite any more
 *
 * Through 0.2.x this was `better-sqlite3` against `state.db`. That is a
 * **native** module: a compiled `.node` binary that can't be bundled into
 * `main.js` and has to be `require`d from `<plugin>/node_modules/`. The
 * Obsidian Community directory installs exactly three files — `main.js`,
 * `manifest.json`, `styles.css` — so on any install that wasn't hand-built
 * the require threw and the whole plugin failed to load. The dependency had
 * to go before the plugin could be published (or, for that matter, installed
 * from our own GitHub releases).
 *
 * The replacement keeps the entire API **synchronous** — the engine reads
 * the log on hot paths and an async API would ripple through every call
 * site — by holding state in memory and persisting a single JSON document
 * in the background. {@link load} must be awaited once at startup;
 * everything after that is plain in-memory work plus a debounced write.
 *
 * Volume is modest by design: one entry per tracked file (a 1000-note vault
 * lands around 160 KB) plus a queue that is normally empty.
 */

export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
export type FileType = 'TEXT' | 'BINARY';

export interface PendingOperationInput {
  opType: OperationType;
  filePath: string;
  /** Set for RENAME / MOVE; null otherwise. */
  newPath?: string | null;
  /** Arbitrary structured data for the operation (e.g. contentHash, size). */
  payload?: Record<string, unknown>;
  /** The operation's key (UUID v4); a new one is given when absent. */
  opId?: string;
  /**
   * The operation answers a question to the user (**Restore on server**, a
   * file moved back): it is never replayed. A late answer closes it; voided,
   * it goes, and the question comes again.
   */
  settleOnly?: true;
}

export interface PendingOperation {
  id: number;
  bindingId: string;
  /**
   * Idempotency key, UUID v4 in lower case: given once, sent with every try
   * of the operation, changed only when the server declared it voided (see
   * {@link OperationLog.rotateOpId}).
   */
  opId: string;
  opType: OperationType;
  filePath: string;
  newPath: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
  /** See {@link PendingOperationInput.settleOnly}. */
  settleOnly?: true;
}

/** An operation as recorded in flight (see {@link OperationLog.recordInFlight}). */
export type InFlightInput = PendingOperationInput & { opId: string };

export interface FileMeta {
  bindingId: string;
  /** Vault-relative path. */
  relativePath: string;
  serverFileId: string;
  contentHash: string;
  size: number;
  fileType: FileType;
  lastSyncedAt: number;
  /**
   * Text files only: sha256 of the last disk content whose edits are already
   * in the local `Y.Doc` — the common ancestor the engine diffs the disk
   * against when it folds new disk edits in. Kept apart from `contentHash`,
   * which stays "last synced" for the delete-vs-edit conflict check and may
   * come from the server listing. Absent in logs written before 0.3.2 until
   * the file's next sync; meanwhile the engine folds as it used to.
   */
  foldedHash?: string;
  /**
   * The file's content has not reached this disk yet: the engine indexed it
   * from the server — its listing, or a teammate's create — while no file was
   * under its name here, and has not written it since. A file saved under
   * that name meanwhile is another one, this device's own: it is sent as a
   * new file, and this one waits for the name (see `SyncEngine.createLocal`).
   * Taken for this file's copy, it went to the server as its new version,
   * over the teammate's. Cleared once the engine writes the content, or finds
   * it on disk.
   */
  notOnDisk?: true;
}

export interface BindingState {
  bindingId: string;
  lastVectorClock: VectorClock;
  lastSyncedAt: number;
}

/**
 * How many operations applied live a binding remembers (see
 * {@link OperationLog.noteAppliedLive}). The oldest go first: a catch-up cut
 * short to its newest operations never returns the older ones, and the list
 * would grow without end.
 */
export const APPLIED_LIVE_MAX = 1000;

/**
 * How many files a binding remembers as asked about after a server delete
 * (see {@link OperationLog.noteDeleteAsked}). The oldest go first.
 */
export const DELETE_ASKED_MAX = 1000;

/** Whether `value` is an operation id: a UUID v4, in lower case. */
export function isOpId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

/** A new operation id. */
export function newOpId(): string {
  return uuid().toLowerCase();
}

/**
 * {@link OperationLog.persistNow} could not put the log on disk: the write
 * failed, or a newer instance of the plugin has taken the file over.
 */
export class StateNotWrittenError extends Error {
  constructor(reason: 'write_failed' | 'taken_over') {
    super(`state_not_written: ${reason}`);
    this.name = 'StateNotWrittenError';
  }
}

/** Per-collection row counts removed by {@link OperationLog.purgeBinding}. */
export interface PurgeResult {
  pendingOperations: number;
  fileMeta: number;
  bindingsState: number;
}

/**
 * On-disk format version. Bumped only when the JSON shape changes in a way
 * {@link OperationLog.load} can't read; a document from the future is
 * discarded rather than misread (the log is a cache — see {@link load}).
 */
const FORMAT_VERSION = 1;

/** Default debounce for the background write. */
const DEFAULT_FLUSH_DELAY_MS = 500;

export interface OperationLogOptions {
  /**
   * Vault-relative path of the JSON document, e.g.
   * `.obsidian/plugins/team-vault/state.json`. Omit (together with
   * {@link storage}) for a memory-only log — that's what tests use.
   */
  filePath?: string;
  /** Storage seam, shared with the file log sink. Omit for memory-only. */
  storage?: LogStorage;
  /** Optional clock injection — tests substitute a deterministic source. */
  now?: () => number;
  /** Debounce before the background write. Default 500 ms. */
  flushDelayMs?: number;
  /** Persistence failures are reported here instead of throwing at call sites. */
  onError?: (err: unknown) => void;
  /**
   * Whether this instance may still write the file. After a reload or an
   * update, the next instance of the plugin takes `state.json` over while this
   * one may still be settling requests it had in flight; from then on this
   * returns false, and those late changes stay in memory instead of
   * overwriting the newer file with an older snapshot. Default: always.
   */
  ownsFile?: () => boolean;
}

/** Everything the log knows about one binding. */
interface BindingBucket {
  pending: PendingOperation[];
  /**
   * Live operations recorded before they went out and not answered yet (see
   * {@link OperationLog.recordInFlight}). Not in {@link pending}: the drain
   * does not replay them, the emit waiting for their answer settles them.
   */
  inflight: PendingOperation[];
  files: Map<string, FileMeta>;
  state: BindingState | null;
  /** Ids of operations applied live (see {@link OperationLog.noteAppliedLive}); oldest first. */
  appliedLive: string[];
  /** Ids of files asked about after a server delete (see {@link OperationLog.noteDeleteAsked}). */
  deleteAsked: string[];
}

export class OperationLog {
  private readonly now: () => number;
  private readonly storage: LogStorage | null;
  private readonly filePath: string | null;
  private readonly flushDelayMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly ownsFile: () => boolean;

  private readonly bindings = new Map<string, BindingBucket>();
  /** Mirrors SQLite AUTOINCREMENT: ids keep climbing across deletes. */
  private nextOpId = 1;

  private dirty = false;
  private timer: number | null = null;
  /**
   * Serializes writes so two flushes can't interleave on the same file. Never
   * rejects: resolves with whether the last write put the document on disk.
   */
  private chain: Promise<boolean> = Promise.resolve(true);
  /** Writes under way — see {@link hasUnwrittenChanges}. */
  private writing = 0;
  /** Counts the changes to the document: one more on each. */
  private generation = 0;
  /** The {@link generation} the last successful write put on disk. */
  private writtenGeneration = 0;
  /**
   * Operations queued or in flight by `opId`: the {@link generation} that
   * gave the entry its `opId` — 0 for one loaded with it from the disk. See
   * {@link queuedWritten}; an `opId` missing here is taken for one not on
   * disk.
   */
  private readonly opIdGeneration = new Map<string, number>();
  /**
   * The {@link generation} of the `opId`s {@link hydrate} gave a queue of an
   * older build; 0 when it gave none. Written by the next write, or by the
   * first {@link persistNow} — the file is not rewritten only because it was
   * read.
   */
  private givenGeneration = 0;
  private closed = false;

  constructor(options: OperationLogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.storage = options.storage ?? null;
    this.filePath = options.filePath ?? null;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.onError = options.onError ?? ((): void => undefined);
    this.ownsFile = options.ownsFile ?? ((): boolean => true);
  }

  /** True when this instance has somewhere to persist to. */
  private get persistent(): boolean {
    return this.storage !== null && this.filePath !== null;
  }

  /**
   * Read the document from storage. Call once, before the log is used.
   *
   * Deliberately forgiving: a missing, truncated, malformed or
   * future-versioned document leaves the log empty rather than throwing.
   * The log is a **cache** — the connect-time catch-up rebuilds file meta
   * from the server, which is exactly what happened (successfully) when
   * `state.db` was deleted by hand during the 2026-09-04 incident. Refusing
   * to start would be a far worse failure than re-syncing.
   */
  async load(): Promise<void> {
    if (!this.persistent) return;
    const storage = this.storage!;
    const path = this.filePath!;
    let raw: string;
    try {
      // The write replaces the file in three steps (write `.tmp`, remove the
      // file, rename). A load that lands between the last two — another copy
      // of the plugin starting while this one is still shutting down, or a
      // crash — finds only the `.tmp`, which is the newest complete state.
      const tmp = `${path}.tmp`;
      if (await storage.exists(path)) raw = await storage.read(path);
      else if (await storage.exists(tmp)) {
        try {
          raw = await storage.read(tmp);
        } catch {
          // The rename landed between the two calls: the file is back.
          raw = await storage.read(path);
        }
      } else return;
    } catch (err) {
      this.onError(err);
      return;
    }
    try {
      this.hydrate(JSON.parse(raw));
    } catch (err) {
      this.onError(err);
      this.bindings.clear();
      this.nextOpId = 1;
    }
  }

  /** Format version of the in-memory document — useful in tests. */
  schemaVersion(): number {
    return FORMAT_VERSION;
  }

  /** Flush pending changes and stop the background timer. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  // -- pending operations -----------------------------------------------------

  /** Queue an operation; it gets a new `opId` unless `op` carries one. */
  enqueueOperation(bindingId: string, op: PendingOperationInput): PendingOperation {
    const entry = this.entryOf(bindingId, op);
    this.bucket(bindingId).pending.push(entry);
    // The queue is the one part of the log that can't be reconstructed from
    // the server, so it doesn't wait out the debounce.
    this.touch({ immediate: true });
    this.opIdGeneration.set(entry.opId, this.generation);
    return copyOf(entry);
  }

  /**
   * Record a live operation about to go out, before it does: from here until
   * its answer the log holds it in flight, and a restart finds it back in the
   * queue under the same `opId`. Written at once — the caller awaits
   * {@link persistNow} before the emit. Its `id` comes from the queue's
   * sequence, so it keeps its place among queued operations when it goes back
   * there (see {@link requeueInFlight}).
   */
  recordInFlight(bindingId: string, op: InFlightInput): PendingOperation {
    const entry = this.entryOf(bindingId, op);
    this.bucket(bindingId).inflight.push(entry);
    this.touch({ immediate: true });
    this.opIdGeneration.set(entry.opId, this.generation);
    return copyOf(entry);
  }

  /**
   * Whether operation `opId`, in flight, is on disk already: a write that
   * began after it was recorded went through. Operations recorded together
   * go out one after another without a write each (a folder deleted: one
   * write for all its files).
   */
  inFlightWritten(bindingId: string, opId: string): boolean {
    if (!this.isInFlight(bindingId, opId)) return false;
    if (!this.persistent) return true;
    const recorded = this.opIdGeneration.get(opId);
    return recorded !== undefined && recorded <= this.writtenGeneration;
  }

  /**
   * Whether queued operation `opId` is on disk under this `opId` already:
   * loaded so, or a write that began after it got the id went through. The
   * drain sends such an entry without a write of its own — before, each one
   * waited for a whole `state.json` write, one after another. `false` when a
   * newer instance of the plugin has the file: {@link persistNow} says so.
   */
  queuedWritten(bindingId: string, opId: string): boolean {
    if (!(this.bindings.get(bindingId)?.pending.some((op) => op.opId === opId) ?? false)) {
      return false;
    }
    if (!this.persistent) return true;
    if (!this.ownsFile()) return false;
    const recorded = this.opIdGeneration.get(opId);
    return recorded !== undefined && recorded <= this.writtenGeneration;
  }

  /**
   * Replace the payload of operation `opId` in flight with `payload`, when it
   * differs: recorded ahead of the checks it waited for (a folder's deletes,
   * see `SyncEngine.recordDeletesAhead`), it carries what they found. On disk
   * with the next write, not before: {@link inFlightWritten} says so until
   * then, and the operation waits for that write before it goes out. `false`
   * when no such operation is in flight, or it carries that payload already.
   */
  amendInFlight(bindingId: string, opId: string, payload: Record<string, unknown>): boolean {
    const entry = this.bindings.get(bindingId)?.inflight.find((op) => op.opId === opId);
    if (!entry || sameValue(entry.payload, payload)) return false;
    entry.payload = { ...payload };
    this.touch({ immediate: true });
    this.opIdGeneration.set(opId, this.generation);
    return true;
  }

  /**
   * The answer of an operation in flight came, and what it settled is
   * recorded: the entry goes. The write waits out the debounce, and takes the
   * entry's result — recorded in the same synchronous block — along with it.
   */
  clearInFlight(bindingId: string, opId: string): boolean {
    const bucket = this.bindings.get(bindingId);
    const at = bucket?.inflight.findIndex((op) => op.opId === opId) ?? -1;
    if (!bucket || at < 0) return false;
    bucket.inflight.splice(at, 1);
    this.opIdGeneration.delete(opId);
    this.touch();
    return true;
  }

  /**
   * An operation in flight goes back to the queue, where its `id` puts it:
   * its answer will not come in this session (the connection dropped, the
   * server asked for a retry). `rotate`: the server voided its `opId`, so it
   * gets a new one. `null` when no such operation is in flight.
   */
  requeueInFlight(
    bindingId: string,
    opId: string,
    opts: { rotate?: boolean } = {},
  ): PendingOperation | null {
    const bucket = this.bindings.get(bindingId);
    const at = bucket?.inflight.findIndex((op) => op.opId === opId) ?? -1;
    if (!bucket || at < 0) return null;
    const [entry] = bucket.inflight.splice(at, 1);
    if (!entry) return null;
    // Not rotated, it is on disk as soon as its record in flight is: a load
    // puts what was in flight back in the queue.
    if (opts.rotate === true) {
      this.opIdGeneration.delete(opId);
      entry.opId = newOpId();
    }
    insertById(bucket.pending, entry);
    this.touch({ immediate: true });
    if (opts.rotate === true) this.opIdGeneration.set(entry.opId, this.generation);
    return copyOf(entry);
  }

  /** The operations of a binding in flight, oldest first. */
  inFlightOperations(bindingId: string): PendingOperation[] {
    return (this.bindings.get(bindingId)?.inflight ?? []).map(copyOf);
  }

  /** Whether operation `opId` is in flight for a binding. */
  isInFlight(bindingId: string, opId: string): boolean {
    return this.bindings.get(bindingId)?.inflight.some((op) => op.opId === opId) ?? false;
  }

  /** The queued or in-flight operation of a binding with this `opId`, if any. */
  findByOpId(bindingId: string, opId: string): PendingOperation | null {
    const bucket = this.bindings.get(bindingId);
    const found =
      bucket?.pending.find((op) => op.opId === opId) ??
      bucket?.inflight.find((op) => op.opId === opId);
    return found ? copyOf(found) : null;
  }

  /**
   * Give queued operation `entryId` a new `opId`: the server voided the old
   * one, which it will never apply now. Returns the new one; `''` when no such
   * operation is queued.
   */
  rotateOpId(bindingId: string, entryId: number): string {
    const entry = this.bindings.get(bindingId)?.pending.find((op) => op.id === entryId);
    if (!entry) return '';
    this.opIdGeneration.delete(entry.opId);
    entry.opId = newOpId();
    this.touch({ immediate: true });
    this.opIdGeneration.set(entry.opId, this.generation);
    return entry.opId;
  }

  /**
   * Put another operation in the place of queued operation `entryId`: same
   * `id` and place in the queue, a new `opId`. `null` when no such operation
   * is queued.
   */
  replaceOperation(
    bindingId: string,
    entryId: number,
    op: PendingOperationInput,
  ): PendingOperation | null {
    const bucket = this.bindings.get(bindingId);
    const at = bucket?.pending.findIndex((queued) => queued.id === entryId) ?? -1;
    const old = at < 0 ? undefined : bucket?.pending[at];
    if (!bucket || !old) return null;
    const entry: PendingOperation = {
      id: old.id,
      bindingId,
      opId: op.opId ?? newOpId(),
      opType: op.opType,
      filePath: op.filePath,
      newPath: op.newPath ?? null,
      payload: { ...(op.payload ?? {}) },
      createdAt: this.now(),
      ...(op.settleOnly === true ? { settleOnly: true as const } : {}),
    };
    bucket.pending[at] = entry;
    this.touch({ immediate: true });
    if (entry.opId !== old.opId) {
      this.opIdGeneration.delete(old.opId);
      this.opIdGeneration.set(entry.opId, this.generation);
    }
    return copyOf(entry);
  }

  /**
   * Return all pending operations for a binding in insertion order. Does not
   * delete them — call `markSent(ids)` once the server has acknowledged the
   * batch. Operations in flight are not among them.
   */
  dequeueOperations(bindingId: string): PendingOperation[] {
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return [];
    return bucket.pending.map(copyOf);
  }

  /** Whether queue entry `entryId` is still queued for a binding. */
  isPending(bindingId: string, entryId: number): boolean {
    return this.bindings.get(bindingId)?.pending.some((op) => op.id === entryId) ?? false;
  }

  /**
   * Number of queued operations for one binding, or across all of them.
   * Operations in flight are not counted: see {@link inFlightOperations}.
   */
  pendingCount(bindingId?: string): number {
    if (bindingId === undefined) {
      let total = 0;
      for (const bucket of this.bindings.values()) total += bucket.pending.length;
      return total;
    }
    return this.bindings.get(bindingId)?.pending.length ?? 0;
  }

  /**
   * Number of queued operations of a binding the drain replays: every one but
   * the answers to questions (`settleOnly`), which wait for the next connect.
   */
  replayableCount(bindingId: string): number {
    return (this.bindings.get(bindingId)?.pending ?? []).filter((op) => op.settleOnly !== true)
      .length;
  }

  /**
   * Point a queued RENAME or MOVE at another destination, keeping its place in
   * the queue and its `opId`: a chain of renames of one file is sent as one
   * (see `SyncEngine.collapseQueuedRenames`). `false` when no such operation
   * is queued.
   */
  retargetOperation(entryId: number, newPath: string): boolean {
    for (const bucket of this.bindings.values()) {
      const op = bucket.pending.find((p) => p.id === entryId);
      if (!op) continue;
      if (op.opType !== 'RENAME' && op.opType !== 'MOVE') return false;
      op.newPath = newPath;
      this.touch({ immediate: true });
      return true;
    }
    return false;
  }

  /**
   * Change a queued operation in place, keeping its place in the queue and its
   * `opId`: its path, or its payload (replaced whole). `false` when no such
   * operation is queued.
   */
  amendOperation(
    entryId: number,
    amend: { filePath?: string; payload?: Record<string, unknown> },
  ): boolean {
    for (const bucket of this.bindings.values()) {
      const op = bucket.pending.find((p) => p.id === entryId);
      if (!op) continue;
      if (amend.filePath !== undefined) op.filePath = amend.filePath;
      if (amend.payload !== undefined) op.payload = { ...amend.payload };
      this.touch({ immediate: true });
      return true;
    }
    return false;
  }

  /** Take queue entries `entryIds` out of the queue: sent, or dropped. */
  markSent(entryIds: readonly number[]): void {
    if (entryIds.length === 0) return;
    const drop = new Set(entryIds);
    let removed = false;
    for (const bucket of this.bindings.values()) {
      const kept: PendingOperation[] = [];
      for (const op of bucket.pending) {
        if (!drop.has(op.id)) kept.push(op);
        else this.opIdGeneration.delete(op.opId);
      }
      if (kept.length !== bucket.pending.length) removed = true;
      bucket.pending = kept;
    }
    if (removed) this.touch({ immediate: true });
  }

  /**
   * Distinct file paths that still have a queued or in-flight operation —
   * both the source `filePath` and any RENAME/MOVE `newPath`. The
   * initial-push pass consults this so it never re-uploads a file whose
   * CREATE/RENAME is still waiting in the queue (e.g. after a drain halted on
   * a transient failure) or waiting for its answer; the operation is the
   * source of truth there.
   */
  pendingPaths(bindingId: string): Set<string> {
    const out = new Set<string>();
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return out;
    for (const op of [...bucket.pending, ...bucket.inflight]) {
      out.add(op.filePath);
      if (op.newPath) out.add(op.newPath);
    }
    return out;
  }

  /**
   * Whether a create is queued for a binding under `path`: a new file of this
   * device's the server has not heard of yet. Operations in flight are not
   * looked at. `keyOf`: names it gives one key are one name — on a disk that
   * takes names differing only in case for one file.
   */
  queuesCreate(bindingId: string, path: string, keyOf?: (path: string) => string): boolean {
    return this.queuedCreates(bindingId, path, keyOf).length > 0;
  }

  /** The entries of the creates {@link queuesCreate} looks at, by `id`, in queue order. */
  queuedCreates(bindingId: string, path: string, keyOf?: (path: string) => string): number[] {
    const pending = this.bindings.get(bindingId)?.pending ?? [];
    const key = keyOf?.(path);
    return pending
      .filter(
        (op) =>
          op.opType === 'CREATE' &&
          (op.filePath === path || (keyOf !== undefined && keyOf(op.filePath) === key)),
      )
      .map((op) => op.id);
  }

  // -- file meta --------------------------------------------------------------

  getFileMeta(bindingId: string, path: string): FileMeta | null {
    const meta = this.bindings.get(bindingId)?.files.get(path);
    return meta ? { ...meta } : null;
  }

  setFileMeta(meta: FileMeta): void {
    this.bucket(meta.bindingId).files.set(meta.relativePath, { ...meta });
    this.touch();
  }

  deleteFileMeta(bindingId: string, path: string): void {
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return;
    if (bucket.files.delete(path)) this.touch();
  }

  listFileMeta(bindingId: string): FileMeta[] {
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return [];
    return [...bucket.files.values()]
      .map((meta) => ({ ...meta }))
      .sort((a, b) =>
        a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
      );
  }

  // -- binding state ----------------------------------------------------------

  getBindingState(bindingId: string): BindingState | null {
    const state = this.bindings.get(bindingId)?.state;
    return state ? { ...state, lastVectorClock: { ...state.lastVectorClock } } : null;
  }

  /**
   * Persist a new vector clock for a binding. `syncedAt` defaults to the
   * configured clock; pass an explicit value when replaying historical state
   * (e.g. tests).
   */
  updateLastVectorClock(bindingId: string, vc: VectorClock, syncedAt?: number): void {
    this.bucket(bindingId).state = {
      bindingId,
      lastVectorClock: { ...vc },
      lastSyncedAt: syncedAt ?? this.now(),
    };
    this.touch();
  }

  // -- operations applied live ------------------------------------------------

  /**
   * Remember that the server operation `id` (its log row) was applied on this
   * device from its live broadcast. Live broadcasts do not move the vector
   * clock — a catch-up that is not whole would take the operations it left
   * out for seen — so a later `project:join` catch-up returns the operation
   * again; the engine uses this to tell it from one that happened while it
   * was away.
   */
  noteAppliedLive(bindingId: string, id: string): void {
    const bucket = this.bucket(bindingId);
    if (bucket.appliedLive.includes(id)) return;
    bucket.appliedLive.push(id);
    if (bucket.appliedLive.length > APPLIED_LIVE_MAX) {
      bucket.appliedLive.splice(0, bucket.appliedLive.length - APPLIED_LIVE_MAX);
    }
    this.touch();
  }

  /** The operations {@link noteAppliedLive} remembers for a binding. */
  appliedLiveIds(bindingId: string): Set<string> {
    return new Set(this.bindings.get(bindingId)?.appliedLive ?? []);
  }

  /**
   * Forget operations applied live that no catch-up returns again: the ones
   * a catch-up returned (the clock took them in), and, after a catch-up of the
   * whole journal, every one remembered before it (see `SyncEngine`).
   */
  forgetAppliedLive(bindingId: string, ids: ReadonlySet<string>): void {
    const bucket = this.bindings.get(bindingId);
    if (!bucket || bucket.appliedLive.length === 0) return;
    const kept = bucket.appliedLive.filter((id) => !ids.has(id));
    if (kept.length === bucket.appliedLive.length) return;
    bucket.appliedLive = kept;
    this.touch();
  }

  // -- copies asked about after a server delete -------------------------------

  /**
   * Remember that the user is asked about this device's copy of file
   * `fileId`, which the server deleted: the copy may hold edits the server
   * never had, and `state.json` keeps its record until the question is
   * settled. The question can outlive the plugin — Obsidian closed before an
   * answer, or **Restore on server** chosen without a connection — and by
   * then the vector clock may have taken the DELETE in, so no catch-up
   * returns it again. A file the server lists under the id later is a new one
   * (a tombstone brought back), not the one this device holds a copy of; the
   * engine uses this to tell.
   */
  noteDeleteAsked(bindingId: string, fileId: string): void {
    const bucket = this.bucket(bindingId);
    if (bucket.deleteAsked.includes(fileId)) return;
    bucket.deleteAsked.push(fileId);
    if (bucket.deleteAsked.length > DELETE_ASKED_MAX) {
      bucket.deleteAsked.splice(0, bucket.deleteAsked.length - DELETE_ASKED_MAX);
    }
    this.touch();
  }

  /** The files {@link noteDeleteAsked} remembers for a binding. */
  deleteAskedIds(bindingId: string): Set<string> {
    return new Set(this.bindings.get(bindingId)?.deleteAsked ?? []);
  }

  /** Forget files of {@link noteDeleteAsked}: their question is settled. */
  forgetDeleteAsked(bindingId: string, ids: Iterable<string>): void {
    const bucket = this.bindings.get(bindingId);
    if (!bucket || bucket.deleteAsked.length === 0) return;
    const gone = new Set(ids);
    const kept = bucket.deleteAsked.filter((id) => !gone.has(id));
    if (kept.length === bucket.deleteAsked.length) return;
    bucket.deleteAsked = kept;
    this.touch();
  }

  // -- cross-collection maintenance -------------------------------------------

  /**
   * Erase every trace of a binding from the log — its pending operations,
   * file metadata, and sync cursor. Called when a binding is removed from
   * settings: without this, deleting a binding leaks state. Worse, its
   * CREATE/UPDATE ops sit in the queue forever (the engine that would drain
   * them no longer exists), so it only ever grows. Idempotent; returns how
   * many entries each collection shed.
   */
  purgeBinding(bindingId: string): PurgeResult {
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return { pendingOperations: 0, fileMeta: 0, bindingsState: 0 };
    const result: PurgeResult = {
      pendingOperations: bucket.pending.length + bucket.inflight.length,
      fileMeta: bucket.files.size,
      bindingsState: bucket.state ? 1 : 0,
    };
    for (const op of [...bucket.pending, ...bucket.inflight]) this.opIdGeneration.delete(op.opId);
    this.bindings.delete(bindingId);
    this.touch({ immediate: true });
    return result;
  }

  /**
   * Distinct binding ids with any state in the log. The startup orphan-sweep
   * diffs this against the bindings in settings to find dead state left
   * behind by earlier plugin versions (which never purged on delete) and
   * hands each orphan to {@link purgeBinding}.
   */
  listBindingIds(): string[] {
    const out: string[] = [];
    for (const [id, bucket] of this.bindings) {
      if (
        bucket.pending.length > 0 ||
        bucket.inflight.length > 0 ||
        bucket.files.size > 0 ||
        bucket.state
      ) {
        out.push(id);
      }
    }
    return out;
  }

  // -- persistence ------------------------------------------------------------

  /**
   * Write the document now, if anything changed. Awaiting this is only
   * necessary at shutdown ({@link close}) or in tests — normal mutations
   * schedule the write themselves.
   */
  async flush(): Promise<void> {
    if (!this.persistent) return;
    // Wait for a write already under way even when nothing new is dirty:
    // `writeOnce` clears the flag before its first await, and `close()` must
    // not return — letting the next instance of the plugin read the file —
    // while the last change is still on its way to disk.
    if (this.dirty) this.chain = this.chain.then(() => this.writeOnce());
    await this.chain;
  }

  /**
   * Put every change made so far on disk and wait for it: the write-ahead step
   * before an operation goes out (see {@link recordInFlight}). Rejects with
   * {@link StateNotWrittenError} when the write failed, or when a newer
   * instance of the plugin has taken the file over — the operation must not
   * go out then. A log without storage resolves at once.
   */
  async persistNow(): Promise<void> {
    if (!this.persistent) return;
    if (!this.ownsFile()) throw new StateNotWrittenError('taken_over');
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    // Ids given at load, not on disk yet: one of them may be about to go out.
    if (this.givenGeneration > this.writtenGeneration) this.dirty = true;
    if (this.dirty) this.chain = this.chain.then(() => this.writeOnce());
    const written = await this.chain;
    if (!this.ownsFile()) throw new StateNotWrittenError('taken_over');
    if (!written) throw new StateNotWrittenError('write_failed');
  }

  /**
   * Whether a change has not reached the disk yet: waiting out the debounce,
   * or on its way. Obsidian's quit waits for such a change (see `main.ts`).
   * A debounce timer left after {@link flush} wrote the change is none: the
   * quit would show "Saving..." for nothing.
   */
  hasUnwrittenChanges(): boolean {
    return this.persistent && (this.dirty || this.writing > 0);
  }

  /** Mark the document dirty and schedule (or force) a write. */
  private touch(opts: { immediate?: boolean } = {}): void {
    if (!this.persistent) return;
    this.generation += 1;
    this.dirty = true;
    // After `close()` there is no timer to wait for — but Obsidian does not
    // await `onunload`, so work an engine had already started (a catch-up, a
    // queued edit) can still mutate the log. Dropping those mutations lost the
    // offline queue; write them straight away instead.
    if (opts.immediate || this.closed) {
      void this.flush().catch((err: unknown) => this.onError(err));
      return;
    }
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush().catch((err: unknown) => this.onError(err));
    }, this.flushDelayMs);
  }

  /**
   * Serialize and write. Written to a sibling `.tmp` first and renamed over
   * the target: `write` truncates before it writes, so a crash mid-write
   * would otherwise leave a half-document — and the queue in it is the part
   * the server can't reconstruct. If the rename dance fails (an adapter that
   * won't replace an existing file, say) we fall back to writing in place,
   * which is still better than dropping the change.
   */
  private async writeOnce(): Promise<boolean> {
    if (!this.persistent || !this.dirty) return true;
    if (!this.ownsFile()) {
      // A newer instance of the plugin has the file now (see `ownsFile`).
      this.dirty = false;
      return false;
    }
    this.writing += 1;
    try {
      return await this.writeDocument();
    } finally {
      this.writing -= 1;
    }
  }

  /** {@link writeOnce} past its checks: `true` once the document is on disk. */
  private async writeDocument(): Promise<boolean> {
    const storage = this.storage!;
    const path = this.filePath!;
    const generation = this.generation;
    let payload: string;
    try {
      payload = JSON.stringify(this.serialize());
    } catch (err) {
      this.onError(err);
      return false;
    }
    // Clear BEFORE the await: mutations that land while the write is in
    // flight must set the flag again and trigger their own write, rather
    // than being swallowed by this one.
    this.dirty = false;
    const tmp = `${path}.tmp`;
    try {
      await storage.mkdir(path);
      await storage.write(tmp, payload);
      if (await storage.exists(path)) await storage.remove(path);
      await storage.rename(tmp, path);
    } catch (err) {
      this.onError(err);
      try {
        await storage.write(path, payload);
      } catch (fallbackErr) {
        this.onError(fallbackErr);
        // Keep the change queued for the next attempt.
        this.dirty = true;
        return false;
      }
      // A temp file left behind would outlive the file it was meant to
      // replace: `load` reads it when `state.json` is gone.
      try {
        if (await storage.exists(tmp)) await storage.remove(tmp);
      } catch (cleanupErr) {
        this.onError(cleanupErr);
      }
    }
    this.writtenGeneration = Math.max(this.writtenGeneration, generation);
    return true;
  }

  private bucket(bindingId: string): BindingBucket {
    let bucket = this.bindings.get(bindingId);
    if (!bucket) {
      bucket = {
        pending: [],
        inflight: [],
        files: new Map(),
        state: null,
        appliedLive: [],
        deleteAsked: [],
      };
      this.bindings.set(bindingId, bucket);
    }
    return bucket;
  }

  /** A new entry for `op`, next in the queue's sequence. */
  private entryOf(bindingId: string, op: PendingOperationInput): PendingOperation {
    return {
      id: this.nextOpId++,
      bindingId,
      opId: op.opId ?? newOpId(),
      opType: op.opType,
      filePath: op.filePath,
      newPath: op.newPath ?? null,
      payload: { ...(op.payload ?? {}) },
      createdAt: this.now(),
      ...(op.settleOnly === true ? { settleOnly: true as const } : {}),
    };
  }

  private serialize(): unknown {
    const bindings: Record<string, unknown> = {};
    for (const [id, bucket] of this.bindings) {
      bindings[id] = {
        pending: bucket.pending,
        ...(bucket.inflight.length > 0 ? { inflight: bucket.inflight } : {}),
        files: [...bucket.files.values()].map((meta) => ({
          relativePath: meta.relativePath,
          serverFileId: meta.serverFileId,
          contentHash: meta.contentHash,
          size: meta.size,
          fileType: meta.fileType,
          lastSyncedAt: meta.lastSyncedAt,
          ...(meta.foldedHash !== undefined ? { foldedHash: meta.foldedHash } : {}),
          ...(meta.notOnDisk === true ? { notOnDisk: true } : {}),
        })),
        state: bucket.state
          ? {
              lastVectorClock: bucket.state.lastVectorClock,
              lastSyncedAt: bucket.state.lastSyncedAt,
            }
          : null,
        ...(bucket.appliedLive.length > 0 ? { appliedLive: bucket.appliedLive } : {}),
        ...(bucket.deleteAsked.length > 0 ? { deleteAsked: bucket.deleteAsked } : {}),
      };
    }
    return { version: FORMAT_VERSION, nextOpId: this.nextOpId, bindings };
  }

  /** Rebuild state from a parsed document, skipping anything malformed. */
  private hydrate(doc: unknown): void {
    if (!isRecord(doc)) return;
    if (doc.version !== FORMAT_VERSION) return;
    const bindings = doc.bindings;
    if (!isRecord(bindings)) return;

    let maxId = 0;
    const opIds = new Set<string>();
    /** The `opId`s given here: not on disk until the next write. */
    const given: string[] = [];
    for (const [bindingId, rawBucket] of Object.entries(bindings)) {
      if (!isRecord(rawBucket)) continue;
      const bucket = this.bucket(bindingId);

      // What was in flight when the document was written goes back to the
      // queue, in its place: its answer never comes to this instance, and the
      // next connect asks the server what became of it.
      const rawOps: unknown[] = [
        ...(Array.isArray(rawBucket.pending) ? (rawBucket.pending as unknown[]) : []),
        ...(Array.isArray(rawBucket.inflight) ? (rawBucket.inflight as unknown[]) : []),
      ];
      for (const rawOp of rawOps) {
        const op = toPendingOperation(bindingId, rawOp);
        if (!op) continue;
        // An entry whose id is missing or malformed (a damaged file), or an
        // id seen twice: a new one, which the server has never seen.
        if (!isOpId(op.opId) || opIds.has(op.opId)) {
          op.opId = newOpId();
          given.push(op.opId);
        } else {
          this.opIdGeneration.set(op.opId, 0);
        }
        opIds.add(op.opId);
        bucket.pending.push(op);
        if (op.id > maxId) maxId = op.id;
      }
      bucket.pending.sort((a, b) => a.id - b.id);

      if (Array.isArray(rawBucket.files)) {
        for (const rawMeta of rawBucket.files) {
          const meta = toFileMeta(bindingId, rawMeta);
          if (meta) bucket.files.set(meta.relativePath, meta);
        }
      }

      if (isRecord(rawBucket.state)) {
        bucket.state = {
          bindingId,
          lastVectorClock: toVectorClock(rawBucket.state.lastVectorClock),
          lastSyncedAt: toNumber(rawBucket.state.lastSyncedAt, 0),
        };
      }

      if (Array.isArray(rawBucket.appliedLive)) {
        for (const id of rawBucket.appliedLive) {
          if (typeof id === 'string' && id !== '') bucket.appliedLive.push(id);
        }
        bucket.appliedLive.splice(0, Math.max(0, bucket.appliedLive.length - APPLIED_LIVE_MAX));
      }

      if (Array.isArray(rawBucket.deleteAsked)) {
        for (const id of rawBucket.deleteAsked) {
          if (typeof id === 'string' && id !== '' && !bucket.deleteAsked.includes(id)) {
            bucket.deleteAsked.push(id);
          }
        }
        bucket.deleteAsked.splice(0, Math.max(0, bucket.deleteAsked.length - DELETE_ASKED_MAX));
      }

      // A bucket that turned out to hold nothing readable shouldn't make the
      // binding look alive to `listBindingIds` — drop it.
      if (bucket.pending.length === 0 && bucket.files.size === 0 && !bucket.state) {
        this.bindings.delete(bindingId);
      }
    }

    this.nextOpId = Math.max(toNumber(doc.nextOpId, 1), maxId + 1);
    if (given.length > 0) {
      // Written with the next write, or by the `persistNow` before one of
      // them goes out: an id sent before it reached the disk would be a new
      // one again after a restart, and the server would apply it twice.
      this.generation += 1;
      this.givenGeneration = this.generation;
      for (const opId of given) this.opIdGeneration.set(opId, this.generation);
    }
  }
}

// -- helpers ------------------------------------------------------------------

const OP_TYPES: ReadonlySet<string> = new Set(['CREATE', 'UPDATE', 'DELETE', 'RENAME', 'MOVE']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whether `a` and `b` hold the same values, whatever the order of their keys. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameValue(value, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]),
  );
}

/** A copy of `op` the caller may change without touching the log. */
function copyOf(op: PendingOperation): PendingOperation {
  return { ...op, payload: { ...op.payload } };
}

/** Put `entry` into `queue`, kept in `id` order, after entries with a smaller `id`. */
function insertById(queue: PendingOperation[], entry: PendingOperation): void {
  const at = queue.findIndex((op) => op.id > entry.id);
  if (at < 0) queue.push(entry);
  else queue.splice(at, 0, entry);
}

function toPendingOperation(bindingId: string, raw: unknown): PendingOperation | null {
  if (!isRecord(raw)) return null;
  const { id, opType, filePath } = raw;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  if (typeof opType !== 'string' || !OP_TYPES.has(opType)) return null;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  return {
    id,
    bindingId,
    // Checked by `hydrate`, which gives a new one to an entry without one.
    opId: typeof raw.opId === 'string' ? raw.opId : '',
    opType: opType as OperationType,
    filePath,
    newPath: typeof raw.newPath === 'string' ? raw.newPath : null,
    payload: isRecord(raw.payload) ? { ...raw.payload } : {},
    createdAt: toNumber(raw.createdAt, 0),
    ...(raw.settleOnly === true ? { settleOnly: true as const } : {}),
  };
}

function toFileMeta(bindingId: string, raw: unknown): FileMeta | null {
  if (!isRecord(raw)) return null;
  const { relativePath, serverFileId, contentHash, fileType } = raw;
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  if (typeof serverFileId !== 'string' || typeof contentHash !== 'string') return null;
  if (fileType !== 'TEXT' && fileType !== 'BINARY') return null;
  return {
    bindingId,
    relativePath,
    serverFileId,
    contentHash,
    size: toNumber(raw.size, 0),
    fileType,
    lastSyncedAt: toNumber(raw.lastSyncedAt, 0),
    ...(typeof raw.foldedHash === 'string' ? { foldedHash: raw.foldedHash } : {}),
    ...(raw.notOnDisk === true ? { notOnDisk: true as const } : {}),
  };
}

function toVectorClock(raw: unknown): VectorClock {
  const out: VectorClock = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
