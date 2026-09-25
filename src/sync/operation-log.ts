import type { LogStorage } from '@/utils/file-log-sink';
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
}

export interface PendingOperation {
  id: number;
  bindingId: string;
  opType: OperationType;
  filePath: string;
  newPath: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

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
}

export interface BindingState {
  bindingId: string;
  lastVectorClock: VectorClock;
  lastSyncedAt: number;
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
  files: Map<string, FileMeta>;
  state: BindingState | null;
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
  /** Serializes writes so two flushes can't interleave on the same file. */
  private chain: Promise<void> = Promise.resolve();
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

  enqueueOperation(bindingId: string, op: PendingOperationInput): PendingOperation {
    const entry: PendingOperation = {
      id: this.nextOpId++,
      bindingId,
      opType: op.opType,
      filePath: op.filePath,
      newPath: op.newPath ?? null,
      payload: op.payload ?? {},
      createdAt: this.now(),
    };
    this.bucket(bindingId).pending.push(entry);
    // The queue is the one part of the log that can't be reconstructed from
    // the server, so it doesn't wait out the debounce.
    this.touch({ immediate: true });
    return { ...entry, payload: { ...entry.payload } };
  }

  /**
   * Return all pending operations for a binding in insertion order. Does not
   * delete them — call `markSent(ids)` once the server has acknowledged the
   * batch.
   */
  dequeueOperations(bindingId: string): PendingOperation[] {
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return [];
    return bucket.pending.map((op) => ({ ...op, payload: { ...op.payload } }));
  }

  /** Number of pending operations for one binding, or across all of them. */
  pendingCount(bindingId?: string): number {
    if (bindingId === undefined) {
      let total = 0;
      for (const bucket of this.bindings.values()) total += bucket.pending.length;
      return total;
    }
    return this.bindings.get(bindingId)?.pending.length ?? 0;
  }

  /**
   * Point a queued RENAME or MOVE at another destination, keeping its place in
   * the queue: a chain of renames of one file is sent as one (see
   * `SyncEngine.collapseQueuedRenames`). `false` when no such operation is
   * queued.
   */
  retargetOperation(opId: number, newPath: string): boolean {
    for (const bucket of this.bindings.values()) {
      const op = bucket.pending.find((p) => p.id === opId);
      if (!op) continue;
      if (op.opType !== 'RENAME' && op.opType !== 'MOVE') return false;
      op.newPath = newPath;
      this.touch({ immediate: true });
      return true;
    }
    return false;
  }

  markSent(opIds: readonly number[]): void {
    if (opIds.length === 0) return;
    const drop = new Set(opIds);
    let removed = false;
    for (const bucket of this.bindings.values()) {
      const before = bucket.pending.length;
      bucket.pending = bucket.pending.filter((op) => !drop.has(op.id));
      if (bucket.pending.length !== before) removed = true;
    }
    if (removed) this.touch({ immediate: true });
  }

  /**
   * Distinct file paths that still have a queued operation — both the
   * source `filePath` and any RENAME/MOVE `newPath`. The initial-push
   * pass consults this so it never re-uploads a file whose CREATE/RENAME
   * is still waiting in the queue (e.g. after a drain halted on a
   * transient failure); the queued op is the source of truth there.
   */
  pendingPaths(bindingId: string): Set<string> {
    const out = new Set<string>();
    const bucket = this.bindings.get(bindingId);
    if (!bucket) return out;
    for (const op of bucket.pending) {
      out.add(op.filePath);
      if (op.newPath) out.add(op.newPath);
    }
    return out;
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
      pendingOperations: bucket.pending.length,
      fileMeta: bucket.files.size,
      bindingsState: bucket.state ? 1 : 0,
    };
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
      if (bucket.pending.length > 0 || bucket.files.size > 0 || bucket.state) out.push(id);
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

  /** Mark the document dirty and schedule (or force) a write. */
  private touch(opts: { immediate?: boolean } = {}): void {
    if (!this.persistent) return;
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
  private async writeOnce(): Promise<void> {
    if (!this.persistent || !this.dirty) return;
    if (!this.ownsFile()) {
      // A newer instance of the plugin has the file now (see `ownsFile`).
      this.dirty = false;
      return;
    }
    const storage = this.storage!;
    const path = this.filePath!;
    const payload = JSON.stringify(this.serialize());
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
        return;
      }
      // A temp file left behind would outlive the file it was meant to
      // replace: `load` reads it when `state.json` is gone.
      try {
        if (await storage.exists(tmp)) await storage.remove(tmp);
      } catch (cleanupErr) {
        this.onError(cleanupErr);
      }
    }
  }

  private bucket(bindingId: string): BindingBucket {
    let bucket = this.bindings.get(bindingId);
    if (!bucket) {
      bucket = { pending: [], files: new Map(), state: null };
      this.bindings.set(bindingId, bucket);
    }
    return bucket;
  }

  private serialize(): unknown {
    const bindings: Record<string, unknown> = {};
    for (const [id, bucket] of this.bindings) {
      bindings[id] = {
        pending: bucket.pending,
        files: [...bucket.files.values()].map((meta) => ({
          relativePath: meta.relativePath,
          serverFileId: meta.serverFileId,
          contentHash: meta.contentHash,
          size: meta.size,
          fileType: meta.fileType,
          lastSyncedAt: meta.lastSyncedAt,
          ...(meta.foldedHash !== undefined ? { foldedHash: meta.foldedHash } : {}),
        })),
        state: bucket.state
          ? {
              lastVectorClock: bucket.state.lastVectorClock,
              lastSyncedAt: bucket.state.lastSyncedAt,
            }
          : null,
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
    for (const [bindingId, rawBucket] of Object.entries(bindings)) {
      if (!isRecord(rawBucket)) continue;
      const bucket = this.bucket(bindingId);

      if (Array.isArray(rawBucket.pending)) {
        for (const rawOp of rawBucket.pending) {
          const op = toPendingOperation(bindingId, rawOp);
          if (!op) continue;
          bucket.pending.push(op);
          if (op.id > maxId) maxId = op.id;
        }
        bucket.pending.sort((a, b) => a.id - b.id);
      }

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

      // A bucket that turned out to hold nothing readable shouldn't make the
      // binding look alive to `listBindingIds` — drop it.
      if (bucket.pending.length === 0 && bucket.files.size === 0 && !bucket.state) {
        this.bindings.delete(bindingId);
      }
    }

    this.nextOpId = Math.max(toNumber(doc.nextOpId, 1), maxId + 1);
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

function toPendingOperation(bindingId: string, raw: unknown): PendingOperation | null {
  if (!isRecord(raw)) return null;
  const { id, opType, filePath } = raw;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  if (typeof opType !== 'string' || !OP_TYPES.has(opType)) return null;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  return {
    id,
    bindingId,
    opType: opType as OperationType,
    filePath,
    newPath: typeof raw.newPath === 'string' ? raw.newPath : null,
    payload: isRecord(raw.payload) ? raw.payload : {},
    createdAt: toNumber(raw.createdAt, 0),
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
