import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { ApiClient, ApiError } from '@/client/api';
import {
  SocketClient,
  type FileEvent as SocketFileEvent,
  type ServerOperation,
  type YjsUpdateMessage,
  type YjsDocSnapshot,
  type YjsCatchupBatch,
} from '@/client/socket';
import { DocManager } from '@/crdt/doc-manager';
import { OperationLog, type FileMeta, type OperationType } from './operation-log';
import { classifyFileType, type FileType } from './file-type';
import { sha256Hex } from './hash';
import { increment, type VectorClock } from './vector-clock';
import type { VaultAdapter } from './vault-adapter';
import {
  computeDeepSyncDiff,
  flushPendingQueue,
  type DeepSyncDiff,
  type PendingEmitter,
  type ReplayOutcome,
} from './reconnect';
import {
  buildConflictPath,
  defaultConflictResolver,
  detectBinaryConflict,
  detectDeleteConflict,
  type ConflictResolver,
} from './conflict';
import type { VaultEvent } from '@/watcher/obsidian-events';
import type { RecentlyApplied } from '@/watcher/recently-applied';
import { isAlwaysIgnored, isInBinding } from '@/watcher/path-utils';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import { Logger, type LogSink } from '@/utils/logger';

/**
 * Silent fallback so the engine always has a logger to call, even when one
 * isn't injected (most unit tests construct `SyncEngine` without one).
 * Production wires the real `Logger` through the `EngineManager`.
 */
const NOOP_LOG_SINK: LogSink = {
  write() {
    /* discard — silent fallback when no logger is injected */
  },
};
const SILENT_LOGGER = new Logger('error', NOOP_LOG_SINK);

/**
 * Per-binding sync engine — the central orchestrator.
 *
 * One `SyncEngine` runs per `VaultBinding`. Top-level wiring (a future
 * `EngineManager` on Stage 9-10) creates one per active binding and feeds
 * vault events to all of them; each engine filters by its own binding id.
 *
 * Responsibilities:
 *
 *   - Open the Socket.IO connection, do `project:join`, apply the
 *     catch-up payload (operation log + Yjs sync-step1).
 *   - Translate vault watcher events into REST/Socket emits with proper
 *     vector clock bumps; queue offline edits in the operation log.
 *   - Translate server-pushed `FileEvent` / Yjs updates back into vault
 *     mutations, marking each path in `RecentlyApplied` to break echo.
 *
 * Construction is deeply DI-friendly so unit tests can drive every flow
 * without a real server, real Yjs persistence, or a real Obsidian vault.
 */

export interface SyncEngineDeps {
  binding: VaultBinding;
  server: ServerConfig;
  /** Stable per-device id. Same value goes into the vector clock keys. */
  clientId: string;
  vault: VaultAdapter;
  operationLog: OperationLog;
  docManager: DocManager;
  recentlyApplied: RecentlyApplied;
  /** Test seam — defaults to a real `ApiClient` for the server config. */
  apiClient?: ApiClient;
  /** Test seam — defaults to a real `SocketClient`. */
  socketClient?: SocketClient;
  /** Debounce window (ms) for "Yjs update applied → write file to disk". Default 500. */
  diskSnapshotDebounceMs?: number;
  /** UI hook for binary / delete conflicts. Defaults to keep-server. */
  conflictResolver?: ConflictResolver;
  /** Test seam — `Date.now` substitute. Used for `buildConflictPath`. */
  now?: () => number;
  /**
   * Logger for status transitions — errors at `error`, the rest at `debug`.
   * Defaults to a silent logger; the `EngineManager` injects the real one
   * so per-binding sync failures land in `sync.log` / DevTools instead of
   * only flipping the status bar.
   */
  logger?: Logger;
}

export type EngineStatus = 'stopped' | 'connecting' | 'syncing' | 'connected' | 'error' | 'offline';

export type StatusListener = (status: EngineStatus, detail?: string) => void;

interface FileMetaIndex {
  byPath: Map<string, FileMeta & { fileId: string }>;
  byId: Map<string, FileMeta & { fileId: string }>;
}

/**
 * How many watcher echoes a single system-applied disk operation can
 * trigger — both Obsidian's `vault.on(...)` and chokidar fire for the
 * same write, and chokidar can split an overwrite into `unlink` + `add`
 * (the atomic-rename pattern Obsidian uses on some platforms). We use
 * these counts in `recentlyApplied.mark(path, count)` so that every echo
 * for a single write is suppressed instead of dispatching as a real
 * `file:delete` or `file:create` round-trip to the server.
 *
 * If the count is *too low*, a fall-through `unlink` clears the path
 * from `fileIndex` and the next echo emits a phantom `file:create` (the
 * bug this constant family was added to prevent). If it's too high,
 * a genuine external edit that lands within the 2 s TTL window may be
 * suppressed — small, recoverable downside.
 */
/** Obsidian onModify + chokidar `change` (or `unlink` + `add` split). */
const ECHO_COUNT_WRITE = 3;
/** Obsidian onCreate + chokidar `add`. */
const ECHO_COUNT_CREATE = 2;
/** Obsidian onDelete + chokidar `unlink`. */
const ECHO_COUNT_DELETE = 2;
/** Per path: Obsidian onRename (fires take on both) + chokidar `unlink`/`add`. */
const ECHO_COUNT_RENAME = 2;

/** Safety cap on waiting for a streamed Yjs catch-up before proceeding. */
const CATCHUP_TIMEOUT_MS = 5 * 60 * 1000;

export class SyncEngine {
  private readonly binding: VaultBinding;
  private readonly server: ServerConfig;
  private readonly clientId: string;
  private readonly vault: VaultAdapter;
  private readonly operationLog: OperationLog;
  private readonly docManager: DocManager;
  private readonly recentlyApplied: RecentlyApplied;
  private readonly api: ApiClient;
  private readonly socket: SocketClient;
  private readonly diskSnapshotDebounceMs: number;
  private readonly conflictResolver: ConflictResolver;
  private readonly now: () => number;
  /** Binding-scoped logger — carries `component=engine bindingId=…` context. */
  private readonly log: Logger;

  /** Local vector clock for the binding — bumped before each outgoing op. */
  private vectorClock: VectorClock;

  private status: EngineStatus = 'stopped';
  private statusListeners = new Set<StatusListener>();

  /**
   * In-memory mirror of `file_meta` rows for this binding, plus the
   * server-side `fileId`. We keep both for fast lookup during event
   * dispatch (path → id, id → path).
   */
  private fileIndex: FileMetaIndex = { byPath: new Map(), byId: new Map() };

  /**
   * `Y.Doc` → file snapshot debouncers, keyed by file path. We persist
   * disk snapshots after Yjs updates settle so the file-on-disk stays
   * in lockstep with the editor's CRDT state.
   */
  private snapshotDebouncers = new Map<string, DebouncedFunction<[]>>();

  /**
   * Per-path tail of the in-flight snapshot chain — `snapshotDocToDisk`
   * appends to it so two snapshots of the same file never interleave
   * their read-fold-write sequences.
   */
  private snapshotChains = new Map<string, Promise<void>>();

  /** Subscriber tear-down list. */
  private cleanups: Array<() => void> = [];

  /**
   * Resolves the in-flight streamed Yjs catch-up once the server's final
   * `yjs:catchup` batch (`done`) arrives. Armed before each `project:join`
   * with `streamYjs`, cleared when the stream finishes (or times out).
   */
  private catchupResolve: (() => void) | null = null;
  /** True once the file index is refreshed — gates catch-up batch processing
   *  so a doc always finds its metadata (no join↔refresh race). */
  private indexReady = false;
  /** `yjs:catchup` batches that arrived before the index was ready. */
  private pendingCatchup: YjsCatchupBatch[] = [];

  constructor(deps: SyncEngineDeps) {
    this.binding = deps.binding;
    this.server = deps.server;
    this.clientId = deps.clientId;
    this.vault = deps.vault;
    this.operationLog = deps.operationLog;
    this.docManager = deps.docManager;
    this.recentlyApplied = deps.recentlyApplied;
    this.api = deps.apiClient ?? new ApiClient(deps.server);
    this.socket =
      deps.socketClient ?? new SocketClient({ server: deps.server, clientId: deps.clientId });
    this.diskSnapshotDebounceMs = deps.diskSnapshotDebounceMs ?? 500;
    this.conflictResolver = deps.conflictResolver ?? defaultConflictResolver;
    this.now = deps.now ?? Date.now;
    this.log = (deps.logger ?? SILENT_LOGGER).child({
      component: 'engine',
      bindingId: this.binding.id,
    });

    const persisted = this.operationLog.getBindingState(this.binding.id);
    this.vectorClock = persisted?.lastVectorClock ?? this.binding.lastVectorClock ?? {};
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Connect to the server, run the catch-up handshake, drain any queued
   * pending operations. Idempotent — calling on a started engine is a
   * no-op.
   */
  async start(): Promise<void> {
    if (this.status !== 'stopped' && this.status !== 'error') return;
    this.setStatus('connecting');

    this.cleanups.push(this.socket.onConnect(() => void this.onSocketConnect()));
    this.cleanups.push(
      this.socket.onDisconnect((reason) => {
        this.setStatus('offline', reason);
      }),
    );
    this.cleanups.push(
      this.socket.onError((err) => {
        this.setStatus('error', describeError(err, 'connect_error'));
      }),
    );
    this.cleanups.push(this.socket.onFileEvent((event) => void this.handleServerFileEvent(event)));
    this.cleanups.push(this.socket.onYjsUpdate((msg) => this.handleServerYjsUpdate(msg)));
    this.cleanups.push(this.socket.onYjsCatchup((batch) => void this.handleYjsCatchup(batch)));

    this.socket.connect();
  }

  async stop(): Promise<void> {
    for (const cb of this.cleanups) cb();
    this.cleanups = [];
    for (const d of this.snapshotDebouncers.values()) d.cancel();
    this.snapshotDebouncers.clear();
    this.snapshotChains.clear();
    this.socket.disconnect();
    this.setStatus('stopped');
  }

  /** Subscribe to status transitions. Returns an unsubscribe handle. */
  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getBindingId(): string {
    return this.binding.id;
  }

  /**
   * Look up the server-side file id the engine has cached for a vault
   * path. Returns `null` if the engine doesn't know about the file
   * (either it's outside the binding's `localFolder`, or the file
   * index hasn't been refreshed yet — usually because the engine isn't
   * connected).
   *
   * Used by the History view (Stage 14) to talk to the right file
   * without reaching into engine internals.
   */
  getFileIdForPath(vaultPath: string): string | null {
    return this.fileIndex.byPath.get(vaultPath)?.fileId ?? null;
  }

  /**
   * Entry point for events coming out of the watchers. The engine filters
   * by binding id and dispatches to the per-type handler.
   */
  async handleVaultEvent(event: VaultEvent): Promise<void> {
    if (event.bindingId !== this.binding.id) return;
    if (!this.binding.enabled) return;
    switch (event.type) {
      case 'create':
        await this.handleLocalCreate(event.path);
        break;
      case 'modify':
        await this.handleLocalModify(event.path);
        break;
      case 'delete':
        await this.handleLocalDelete(event.path);
        break;
      case 'rename':
        await this.handleLocalRename(event.oldPath, event.newPath);
        break;
    }
  }

  // -- Connection / catch-up -----------------------------------------------

  private async onSocketConnect(): Promise<void> {
    try {
      this.setStatus('syncing');
      // Re-gate streamed catch-up for this connect: batches that arrive before
      // the file index is ready get buffered (see `handleYjsCatchup`).
      this.indexReady = false;
      this.pendingCatchup = [];
      // Arm the streamed-catch-up completion signal before the join so a fast
      // server stream can't resolve before we're waiting on it.
      const catchupDone = new Promise<void>((resolve) => {
        this.catchupResolve = resolve;
      });

      // Fire `project:join` synchronously (no await before it) so tests can
      // observe the emit immediately and the server starts streaming ASAP;
      // refresh the file index in parallel. `streamYjs: true` asks the server
      // to deliver the catch-up as batched `yjs:catchup` events.
      const joinPromise = this.socket.joinProject(this.binding.projectId, this.vectorClock, true);
      const filesPromise = this.refreshFileIndex();
      const [result] = await Promise.all([joinPromise, filesPromise]);

      // Index is ready — let catch-up batches through, draining any that
      // arrived during the join↔refresh window.
      this.indexReady = true;
      const buffered = this.pendingCatchup;
      this.pendingCatchup = [];
      for (const batch of buffered) {
        await this.processCatchupBatch(batch);
      }

      if (!result.ok) {
        this.catchupResolve = null;
        this.setStatus('error', result.error);
        return;
      }

      // Apply server-side operations the client missed.
      for (const op of result.operations) {
        await this.applyServerOperation(op);
      }

      // Hydrate Yjs docs. New servers STREAM them via `yjs:catchup` (handled by
      // `handleYjsCatchup`); we wait for the `done` batch here. Legacy servers
      // return them inline in the ack — apply those directly.
      if (result.yjsStream) {
        await this.waitForCatchup(catchupDone);
      } else {
        this.catchupResolve = null;
        for (const snap of result.yjsDocs ?? []) {
          await this.applyCatchupDoc(snap);
        }
      }

      // Subscribe each known text doc to local-update emits — Yjs will
      // start broadcasting from here on out.
      for (const meta of this.fileIndex.byPath.values()) {
        if (meta.fileType === 'TEXT') this.wireYjsForTextFile(meta.fileId, meta.relativePath);
      }

      this.persistVectorClock();
      this.setStatus('connected');

      // Reconnect catch-up tail, kicked off in the background so the
      // `connected` status doesn't wait on every queued upload. Ordering
      // inside is load-bearing — see `drainThenInitialPush`.
      void this.drainThenInitialPush();
    } catch (err) {
      this.catchupResolve = null;
      this.setStatus('error', describeError(err, 'sync_failed'));
    }
  }

  /**
   * Receives one streamed `yjs:catchup` batch. Each batch is its own socket
   * message, so the event loop yields between them — a 600-file catch-up never
   * blocks the heartbeat or the UI (the livelock the old all-at-once ack
   * caused). Batches that beat the file-index refresh are buffered.
   */
  private async handleYjsCatchup(batch: YjsCatchupBatch): Promise<void> {
    if (batch.projectId !== this.binding.projectId) return;
    if (!this.indexReady) {
      this.pendingCatchup.push(batch);
      return;
    }
    await this.processCatchupBatch(batch);
  }

  /** Applies a catch-up batch's docs; the final `done` batch ends the wait. */
  private async processCatchupBatch(batch: YjsCatchupBatch): Promise<void> {
    for (const snap of batch.docs) {
      await this.applyCatchupDoc(snap);
    }
    if (batch.done) {
      this.catchupResolve?.();
      this.catchupResolve = null;
    }
  }

  /**
   * Applies one doc's sync-step1 snapshot and, in the same pass, pushes back
   * anything the server is missing. y-indexeddb keeps offline text edits across
   * reloads but the local-update fan-out only fires for *future* edits, so
   * without this round-trip offline ops stay stuck client-side forever and the
   * server treats every subsequent live edit as a no-op replay (parent structs
   * missing).
   */
  private async applyCatchupDoc(snap: YjsDocSnapshot): Promise<void> {
    const meta = this.fileIndex.byId.get(snap.fileId);
    if (!meta) return;
    // The offline doc store (y-indexeddb) loads asynchronously. Applying the
    // server's state to a doc that hasn't finished loading computes a bogus
    // push-back diff and snapshots a local-history-less merge over the file
    // on disk — a silent rollback.
    await this.docManager.whenSynced(this.binding.id, meta.relativePath);
    const update = Uint8Array.from(snap.sync1);
    this.docManager.applyRemoteUpdate(this.binding.id, meta.relativePath, update);
    await this.snapshotDocToDisk(meta.relativePath);

    if (snap.stateVector && snap.stateVector.length > 0) {
      const serverVector = Uint8Array.from(snap.stateVector);
      const missing = this.docManager.encodeStateAsUpdate(
        this.binding.id,
        meta.relativePath,
        serverVector,
      );
      // An "empty" Yjs delta is ~2 bytes (zero-struct, zero-delete markers).
      // A larger buffer means we have local ops the server lacks — push them.
      if (missing.length > 2) {
        void this.socket.emitYjsUpdate({
          projectId: this.binding.projectId,
          fileId: meta.fileId,
          update: missing,
        });
      }
    }
  }

  /**
   * Waits for the streamed catch-up to finish, but never hangs the whole
   * connect on a stalled stream — after {@link CATCHUP_TIMEOUT_MS} we proceed
   * to `connected` regardless (the initial-push drain reconciles the rest).
   */
  private waitForCatchup(done: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.catchupResolve = null;
        resolve();
      };
      const timer = setTimeout(finish, CATCHUP_TIMEOUT_MS);
      void done.then(finish);
    });
  }

  /**
   * Reconnect catch-up tail. The pending-operation queue **must** drain
   * before the initial-push pass runs — they used to race, and the race
   * is exactly the S4 offline-drain bug: `initialPush` walks the vault
   * and re-uploads a file that already has a queued CREATE/RENAME, so the
   * server sees two operations for one path and conflict-renames the
   * duplicate into `<name>.conflict-<clientId>`.
   *
   * Draining first means the queued ops (the user's real intent, in
   * order) win, and `replayPending` keeps `fileIndex` authoritative as it
   * goes — so the `initialPush` that follows recognises every file the
   * queue already synced and skips it.
   */
  private async drainThenInitialPush(): Promise<void> {
    try {
      await this.flushPendingOperations();
    } catch {
      // A failed drain must not block the initial-push pass — pre-existing
      // files still need their first upload, and whatever stayed queued is
      // retried on the next reconnect. `initialPush` itself skips paths
      // that are still queued.
    }
    await this.initialPush();
  }

  /**
   * Walk the binding's local folder, upload anything not in the server's
   * file index. Idempotent — files already mirrored on the server are
   * skipped via the `fileIndex` lookup, and files whose CREATE/RENAME is
   * still queued are skipped via `pendingPaths` (the queue is the source
   * of truth for those — re-uploading here would duplicate them on the
   * server). Errors per-file are swallowed so one bad file doesn't block
   * the rest.
   */
  private async initialPush(): Promise<void> {
    const paths = await this.vault.list(this.binding.localFolder);
    const pending = this.operationLog.pendingPaths(this.binding.id);
    for (const path of paths) {
      // Watcher events are filtered upstream, but this pass walks the raw
      // vault listing — without the same filter it uploads throw-away
      // artifacts (e.g. Obsidian's orphaned `*.tmp.<pid>.<hex>` files).
      if (isAlwaysIgnored(path)) continue;
      if (this.fileIndex.byPath.has(path)) continue;
      if (pending.has(path)) continue;
      try {
        await this.handleLocalCreate(path);
      } catch {
        // Per-file failures are swallowed — the watcher / next reconnect
        // will surface them again.
      }
    }
  }

  private async refreshFileIndex(): Promise<void> {
    const files = await this.api.getProjectFiles(this.binding.projectId);
    const byPath = new Map<string, FileMeta & { fileId: string }>();
    const byId = new Map<string, FileMeta & { fileId: string }>();
    for (const f of files) {
      // Throw-away artifacts that an older client uploaded (e.g. Obsidian's
      // `*.tmp.<pid>.<hex>` atomic-write leftovers) must stay invisible —
      // indexing them would let server events materialise them on disk.
      if (isAlwaysIgnored(f.path)) continue;
      // Preserve the client's last-known `contentHash` (the "common
      // ancestor" from the engine's perspective) for files we've synced
      // before — overwriting it with the server's current hash would
      // make `detectBinaryConflict` treat every server-side update as
      // already-known (`storedHash === serverHash`), silently clobbering
      // local edits. New files (no prior meta) fall back to the server's
      // hash so applyServerCreate's binary download starts from a known
      // baseline.
      const existing = this.operationLog.getFileMeta(this.binding.id, f.path);
      const meta: FileMeta & { fileId: string } = {
        bindingId: this.binding.id,
        relativePath: f.path,
        serverFileId: f.id,
        fileId: f.id,
        contentHash: existing?.contentHash ?? f.contentHash,
        size: existing?.size ?? f.size,
        fileType: f.fileType,
        lastSyncedAt: existing?.lastSyncedAt ?? Date.now(),
      };
      byPath.set(f.path, meta);
      byId.set(f.id, meta);
      // Mirror into SQLite so the next reconnect has it.
      this.operationLog.setFileMeta(meta);
    }
    this.fileIndex = { byPath, byId };
  }

  // -- Local → Server -------------------------------------------------------

  private async handleLocalCreate(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    if (this.fileIndex.byPath.has(path)) {
      // The server already knows about this — treat as a modify.
      await this.handleLocalModify(path);
      return;
    }
    // Stale-create guard: if the file isn't actually on disk anymore,
    // this event is leftover from an atomic-rename write (chokidar saw
    // the intermediate `add` but the file moved away again before we got
    // here). Emitting would upload empty bytes and tip the server into a
    // conflict-rename round-trip.
    if (!(await this.vault.exists(path))) return;
    const fileType = classifyFileType(path);
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);

    if (this.socket.isConnected()) {
      const ack = await this.socket.emitFileCreate({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        filePath: path,
        fileType,
        contentHash: hash,
        size: buffer.byteLength,
        data: buffer,
      });
      if (ack.ok) {
        // Server ack carries `outcome.{fileId, path}` — record the file in
        // the local index immediately. Without this the broadcast event
        // that follows would treat the file as new and try to BINARY-
        // download it (404), and the next CREATE pass on this path would
        // re-upload (creating server-side conflict-renamed copies).
        const outcome = (ack as { outcome?: { fileId?: string; path?: string } }).outcome;
        if (outcome?.fileId && outcome?.path) {
          this.recordCreatedFile(outcome.fileId, outcome.path, fileType, hash, buffer.byteLength);
        }
        this.persistVectorClock();
        return;
      }
    }
    // Offline (or NACK) — queue and bail; the engine will replay on reconnect.
    this.queue('CREATE', path, null, {
      fileType,
      contentHash: hash,
      size: buffer.byteLength,
    });
  }

  /**
   * Record a freshly server-acknowledged CREATE in the in-memory file
   * index + the SQLite mirror, and wire its Yjs doc when it's text.
   * Shared by the online CREATE path (`handleLocalCreate`) and the
   * offline-queue replay (`replayPending`) so both keep `fileIndex`
   * authoritative — the initial-push pass relies on that to avoid
   * re-uploading files the server already has.
   */
  private recordCreatedFile(
    fileId: string,
    path: string,
    fileType: FileType,
    contentHash: string,
    size: number,
  ): void {
    const meta: FileMeta & { fileId: string } = {
      bindingId: this.binding.id,
      relativePath: path,
      serverFileId: fileId,
      fileId,
      contentHash,
      size,
      fileType,
      lastSyncedAt: Date.now(),
    };
    this.fileIndex.byPath.set(path, meta);
    this.fileIndex.byId.set(fileId, meta);
    this.operationLog.setFileMeta(meta);
    if (fileType === 'TEXT') this.wireYjsForTextFile(fileId, path);
  }

  private async handleLocalModify(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    const meta = this.fileIndex.byPath.get(path);
    if (!meta) {
      // No server record yet — promote to a CREATE.
      await this.handleLocalCreate(path);
      return;
    }
    if (meta.fileType === 'TEXT') {
      // Text edits flow through Yjs. Read the disk content and diff into
      // the doc — the docManager fan-out will ship a `yjs:update` for us.
      //
      // Two guards against the "doubled content" corruption (2026-06-04:
      // 203 files, 2026-06-12: 101 files — every file's text duplicated
      // under itself):
      //
      //  1. Wait for the offline store. Diffing against a doc whose
      //     y-indexeddb state is still loading sees an empty text and
      //     re-inserts the entire file; when the stored ops finish
      //     loading, the merge keeps BOTH copies.
      //  2. Never diff a server-known non-empty file into an op-less doc.
      //     The server holds its own insertion of this content (the
      //     CREATE-time seed), so a local full-content insert is a second
      //     independent copy — Yjs merge keeps both, server-side and then
      //     on every client. Defer instead: the doc hydrates via the
      //     catch-up stream or the live seed broadcast, and the next
      //     snapshot folds the disk edits in as a minimal diff
      //     (`foldDiskEditsIntoDoc`).
      await this.docManager.whenSynced(this.binding.id, path);
      if (!this.docManager.hasState(this.binding.id, path) && meta.size > 0) {
        this.log.debug('defer text modify until doc hydrates', path);
        return;
      }
      const content = await this.vault.readText(path);
      this.docManager.setText(this.binding.id, path, content);
      return;
    }
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);
    if (hash === meta.contentHash) return; // nothing changed

    if (this.socket.isConnected()) {
      const ack = await this.socket.emitFileUpdateBinary({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId: meta.fileId,
        contentHash: hash,
        size: buffer.byteLength,
        data: buffer,
      });
      if (ack.ok) {
        meta.contentHash = hash;
        meta.size = buffer.byteLength;
        this.operationLog.setFileMeta(meta);
        this.persistVectorClock();
        return;
      }
    }
    this.queue('UPDATE', path, null, {
      fileId: meta.fileId,
      contentHash: hash,
      size: buffer.byteLength,
    });
  }

  private async handleLocalDelete(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    // Stale-delete guard: if the file is still on disk, the watcher
    // event is almost certainly a stray chokidar `unlink` from an
    // atomic-rename overwrite (the matching `add` lands a beat later).
    // Without this check the engine emits `file:delete`, the server
    // applies it, broadcasts `file:deleted` back, our applyServerDelete
    // strips the path out of `fileIndex` — and the next watcher event
    // then finds an empty index and dispatches a phantom `file:create`.
    if (await this.vault.exists(path)) return;
    const meta = this.fileIndex.byPath.get(path);
    const fileId = meta?.fileId ?? '';
    if (this.socket.isConnected() && fileId) {
      const ack = await this.socket.emitFileDelete({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId,
        filePath: path,
      });
      if (ack.ok) {
        this.fileIndex.byPath.delete(path);
        this.fileIndex.byId.delete(fileId);
        this.operationLog.deleteFileMeta(this.binding.id, path);
        this.persistVectorClock();
        return;
      }
    }
    this.queue('DELETE', path, null, { fileId });
  }

  private async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    const meta = this.fileIndex.byPath.get(oldPath);
    const fileId = meta?.fileId ?? '';
    if (this.socket.isConnected() && fileId) {
      const ack = await this.socket.emitFileRename({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId,
        filePath: oldPath,
        newPath,
      });
      if (ack.ok) {
        if (meta) {
          this.operationLog.deleteFileMeta(this.binding.id, oldPath);
          meta.relativePath = newPath;
          this.operationLog.setFileMeta(meta);
          this.fileIndex.byPath.delete(oldPath);
          this.fileIndex.byPath.set(newPath, meta);
        }
        this.persistVectorClock();
        return;
      }
    }
    this.queue('RENAME', oldPath, newPath, { fileId });
  }

  /** Wire a text file's Yjs doc to the socket so future edits stream upstream. */
  private wireYjsForTextFile(fileId: string, path: string): void {
    const off = this.docManager.onLocalUpdate(this.binding.id, path, (update) => {
      if (!this.socket.isConnected()) return; // y-indexeddb keeps it; reconnect resends.
      void this.socket.emitYjsUpdate({
        projectId: this.binding.projectId,
        fileId,
        update,
      });
    });
    this.cleanups.push(off);
  }

  // -- Server → Local -------------------------------------------------------

  private async handleServerFileEvent(event: SocketFileEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'created': {
          // Server broadcasts `{ result: { outcome, log }, log }`. Pull
          // fileId + path out of `result.outcome`. Skip if we already
          // know about this file — that's the echo of our own push.
          const outcome = (
            event.result as
              | { outcome?: { fileId?: string; path?: string; kind?: string } }
              | undefined
          )?.outcome;
          if (!outcome?.fileId || !outcome?.path) break;
          if (this.fileIndex.byId.has(outcome.fileId)) break;
          await this.applyServerCreate({
            id: outcome.fileId,
            path: outcome.path,
            // Server doesn't ship the file type; classify locally. Good
            // enough for the markdown / text vs. binary split we care
            // about here.
            fileType: classifyFileType(outcome.path),
          });
          break;
        }
        case 'updated-binary':
          await this.applyServerUpdateBinary(event.fileId);
          break;
        case 'deleted':
          await this.applyServerDelete(event.fileId);
          break;
        case 'renamed':
        case 'moved':
          await this.applyServerRename(event.fileId, event.newPath);
          break;
      }
    } catch (err) {
      this.setStatus('error', describeError(err, 'apply_failed'));
    }
  }

  private handleServerYjsUpdate(msg: YjsUpdateMessage): void {
    const meta = this.fileIndex.byId.get(msg.fileId);
    if (!meta) return;
    this.docManager.applyRemoteUpdate(this.binding.id, meta.relativePath, msg.update);
    this.scheduleSnapshotToDisk(meta.relativePath);
  }

  /**
   * Apply one operation from the project:join catch-up.
   *
   * Per-op stale guards keyed off `fileIndex` (the post-`refreshFileIndex`
   * snapshot of what's actually live on the server). When the catch-up
   * replay returns ops for files that have since been deleted, recreated,
   * or renamed, the ops are skipped instead of re-applied. Without these
   * guards a `bindings_state` reset (or a very-first project:join after
   * a long offline gap) replays the full history and produces spurious
   * delete-vs-update modals, 404s from binary downloads of soft-deleted
   * files, and inflated fileIndex entries for paths that no longer exist.
   *
   * Live real-time events still flow through `handleServerFileEvent` and
   * bypass these guards entirely — concurrent ops always apply.
   */
  private async applyServerOperation(op: ServerOperation): Promise<void> {
    switch (op.opType) {
      case 'CREATE': {
        if (!isInBinding(op.filePath, this.binding.localFolder)) return;
        const payload = (op.payload ?? {}) as { fileType?: FileType; fileId?: string };
        const fileId = payload.fileId ?? this.fileIndex.byPath.get(op.filePath)?.fileId ?? '';
        if (!fileId) return;
        // Stale-CREATE guard: if `fileId` isn't currently on the server
        // (per `refreshFileIndex`), the file was created and later
        // deleted; re-applying would inflate the index with a phantom
        // entry (TEXT) or 404 on the binary download.
        if (!this.fileIndex.byId.has(fileId)) break;
        await this.applyServerCreate({
          id: fileId,
          path: op.filePath,
          fileType: payload.fileType ?? 'TEXT',
        });
        break;
      }
      case 'UPDATE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (!fileId) break;
        // Stale-UPDATE guard: same logic — if the file is gone from the
        // server, the binary download will 404 and crash the catch-up.
        if (!this.fileIndex.byId.has(fileId)) break;
        await this.applyServerUpdateBinary(fileId);
        break;
      }
      case 'DELETE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (!fileId) break;
        // Stale-DELETE guard: if `fileId` IS in our index, the file has
        // been re-created since (tombstone-revival keeps the same id);
        // re-applying would wipe a live local copy or pop a spurious
        // delete-vs-update modal.
        if (this.fileIndex.byId.has(fileId)) break;
        await this.applyServerDelete(fileId);
        break;
      }
      case 'RENAME':
      case 'MOVE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (!fileId || !op.newPath) break;
        // Stale-RENAME guard: if `fileId`'s current server path is
        // already `newPath`, the rename has been applied or superseded.
        // Also skip if the file is gone — nothing to rename.
        const meta = this.fileIndex.byId.get(fileId);
        if (!meta) break;
        if (meta.relativePath === op.newPath) break;
        await this.applyServerRename(fileId, op.newPath);
        break;
      }
    }
    if (op.vectorClock) {
      this.vectorClock = mergeClocks(this.vectorClock, op.vectorClock);
    }
  }

  private async applyServerCreate(payload: {
    id: string;
    path: string;
    fileType: FileType;
  }): Promise<void> {
    // Mirror of the refreshFileIndex filter for live events: never
    // materialise a throw-away artifact another client uploaded.
    if (isAlwaysIgnored(payload.path)) return;
    // Catch-up CREATE replays hit files `refreshFileIndex` already indexed
    // (the stale-CREATE guard requires it). Reuse that entry — resetting
    // its contentHash/size to zero would break every downstream three-way
    // compare (`detectBinaryConflict`, `foldDiskEditsIntoDoc`, the
    // unhydrated-doc guard in `handleLocalModify`).
    const meta: FileMeta & { fileId: string } = this.fileIndex.byId.get(payload.id) ?? {
      bindingId: this.binding.id,
      relativePath: payload.path,
      serverFileId: payload.id,
      fileId: payload.id,
      contentHash: '',
      size: 0,
      fileType: payload.fileType,
      lastSyncedAt: Date.now(),
    };
    this.fileIndex.byPath.set(meta.relativePath, meta);
    this.fileIndex.byId.set(payload.id, meta);

    // Pull initial bytes — Yjs takes over for text after the first
    // snapshot, but the file on disk needs to exist. `meta.relativePath`
    // (not `payload.path`) so a reused index entry keeps its current name.
    if (payload.fileType === 'TEXT') {
      this.wireYjsForTextFile(payload.id, meta.relativePath);
    } else {
      // Catch-up replays can fire applyServerCreate for a binary file the
      // client already has on disk (synced earlier). `createBinary` throws
      // on existing paths, so just bail — meta is already up-to-date from
      // refreshFileIndex.
      if (await this.vault.exists(payload.path)) return;
      const buf = await this.api.downloadFile(this.binding.projectId, payload.id);
      // Same ordering as `applyServerUpdateBinary` — meta first, then the
      // disk write, so the watcher echo's hash compare short-circuits.
      meta.size = buf.byteLength;
      meta.contentHash = await sha256Hex(buf);
      this.operationLog.setFileMeta(meta);
      // One createBinary fires Obsidian onCreate + chokidar 'add' — two
      // echoes that both need consuming.
      this.recentlyApplied.mark(payload.path, ECHO_COUNT_CREATE);
      await this.vault.ensureParentFolder(payload.path);
      await this.vault.createBinary(payload.path, buf);
    }
  }

  private async applyServerUpdateBinary(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const newBuf = await this.api.downloadFile(this.binding.projectId, fileId);
    const newHash = await sha256Hex(newBuf);

    // Conflict detection — only triggers when the user has uncommitted edits.
    if (await this.vault.exists(meta.relativePath)) {
      const localBuf = await this.vault.readBinary(meta.relativePath);
      const localHash = await sha256Hex(localBuf);
      const conflict = detectBinaryConflict({
        storedHash: meta.contentHash,
        localHash,
        serverHash: newHash,
      });
      if (conflict) {
        const resolution = await this.conflictResolver.resolveBinaryConflict({
          filePath: meta.relativePath,
          localSize: localBuf.byteLength,
          serverSize: newBuf.byteLength,
        });
        if (resolution === 'keep-local') {
          // Push our local content as the new server version. Bump clock,
          // emit; if offline, queue. The server will then broadcast it
          // back as `file:updated-binary` — by then `meta.contentHash`
          // matches the local hash, so the second pass is a no-op.
          if (this.socket.isConnected()) {
            await this.socket.emitFileUpdateBinary({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              vectorClock: this.bumpClock(),
              fileId,
              contentHash: localHash,
              size: localBuf.byteLength,
              data: localBuf,
            });
          }
          meta.contentHash = localHash;
          meta.size = localBuf.byteLength;
          this.operationLog.setFileMeta(meta);
          return;
        }
        if (resolution === 'keep-both') {
          // Move the local edits aside, then write the server's version.
          const aside = buildConflictPath(meta.relativePath, this.now());
          // A rename fires Obsidian onRename + chokidar 'unlink' (old) +
          // 'add' (new) — both paths need their own echo budgets, or the
          // engine's own handlers will turn the echo into a real
          // file:delete / file:create round-trip to the server.
          this.recentlyApplied.mark(meta.relativePath, ECHO_COUNT_RENAME);
          this.recentlyApplied.mark(aside, ECHO_COUNT_RENAME);
          await this.vault.ensureParentFolder(aside);
          await this.vault.rename(meta.relativePath, aside);
          // Note: the renamed file is NOT auto-uploaded — the user can
          // decide what to do with it; if they keep it, the next vault
          // event picks it up as a fresh CREATE.
        }
        // 'keep-server' falls through to the standard apply path below.
      }
    }

    // Update `meta` BEFORE the disk write. The watcher echo loop is
    // unavoidable — chokidar + Obsidian's `vault.on('modify')` BOTH fire
    // for the same write, and `recentlyApplied.take` consumes only one of
    // them. The second fires through to `handleLocalModify`, which uses
    // `hash === meta.contentHash` as its short-circuit. If meta is still
    // the *old* hash at that moment, the echo emits an UPDATE → server
    // applies → broadcasts → `applyServerUpdateBinary` runs again → write
    // → another echo → ... infinite loop. Setting meta first means the
    // echo's hash compare matches and the short-circuit fires.
    meta.size = newBuf.byteLength;
    meta.contentHash = newHash;
    this.operationLog.setFileMeta(meta);
    // Overwrite writes can split into chokidar `unlink` + `add` (the
    // atomic-rename pattern some editors and OS-level write paths use),
    // so the writeBinary branch budgets for one Obsidian echo plus up to
    // two chokidar echoes. A stray `unlink` falling through would dispatch
    // a real `file:delete` and clear the path from `fileIndex`, which is
    // exactly how a phantom `file:create` round-trip starts (the next
    // watcher event finds an empty fileIndex and treats the path as
    // brand-new). The createBinary branch only fires create-style echoes
    // (Obsidian onCreate + chokidar `add`), so the smaller CREATE budget
    // is exact — using WRITE there would leave a stale mark that could
    // suppress a genuine next-second edit.
    if (await this.vault.exists(meta.relativePath)) {
      this.recentlyApplied.mark(meta.relativePath, ECHO_COUNT_WRITE);
      await this.vault.writeBinary(meta.relativePath, newBuf);
    } else {
      await this.vault.ensureParentFolder(meta.relativePath);
      this.recentlyApplied.mark(meta.relativePath, ECHO_COUNT_CREATE);
      await this.vault.createBinary(meta.relativePath, newBuf);
    }
  }

  private async applyServerDelete(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;

    // Delete-vs-update guard: if the local file still exists and has
    // uncommitted edits, ask the user before clobbering them.
    if (await this.vault.exists(meta.relativePath)) {
      const localBuf = await this.vault.readBinary(meta.relativePath);
      const localHash = await sha256Hex(localBuf);
      const conflict = detectDeleteConflict({
        storedHash: meta.contentHash,
        localHash,
      });
      if (conflict) {
        const resolution = await this.conflictResolver.resolveDeleteConflict({
          filePath: meta.relativePath,
          localSize: localBuf.byteLength,
        });
        if (resolution === 'restore-server') {
          // Push the local content as a fresh CREATE so the server
          // un-deletes it. The recipient broadcast will reset our state.
          if (this.socket.isConnected()) {
            await this.socket.emitFileCreate({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              vectorClock: this.bumpClock(),
              filePath: meta.relativePath,
              fileType: meta.fileType,
              contentHash: localHash,
              size: localBuf.byteLength,
              data: localBuf,
            });
          }
          // Don't drop local state — we want the file to stay.
          return;
        }
        // 'delete-local' falls through.
      }
    }

    // One delete fires Obsidian onDelete + chokidar `unlink`.
    this.recentlyApplied.mark(meta.relativePath, ECHO_COUNT_DELETE);
    if (await this.vault.exists(meta.relativePath)) {
      await this.vault.delete(meta.relativePath);
    }
    this.fileIndex.byPath.delete(meta.relativePath);
    this.fileIndex.byId.delete(fileId);
    this.operationLog.deleteFileMeta(this.binding.id, meta.relativePath);
    await this.docManager.release(this.binding.id, meta.relativePath);
  }

  private async applyServerRename(fileId: string, newPath: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const oldPath = meta.relativePath;
    if (oldPath === newPath) return;
    // Rename fires Obsidian onRename + chokidar `unlink` (old) + `add`
    // (new). Each path needs its own echo budget — see the keep-both
    // branch above for the same reasoning.
    this.recentlyApplied.mark(oldPath, ECHO_COUNT_RENAME);
    this.recentlyApplied.mark(newPath, ECHO_COUNT_RENAME);
    if (await this.vault.exists(oldPath)) {
      if (await this.vault.exists(newPath)) {
        // Destination already materialised locally — e.g. an initial-push
        // pass created it, or this rename was partially applied before.
        // `adapter.rename` throws "Destination file already exists" here,
        // which would otherwise crash the engine to `error` status. The
        // server is authoritative and `newPath` is the canonical name, so
        // drop the stale source instead of colliding into it.
        await this.vault.delete(oldPath);
      } else {
        await this.vault.ensureParentFolder(newPath);
        await this.vault.rename(oldPath, newPath);
      }
    }
    this.operationLog.deleteFileMeta(this.binding.id, oldPath);
    meta.relativePath = newPath;
    this.operationLog.setFileMeta(meta);
    this.fileIndex.byPath.delete(oldPath);
    this.fileIndex.byPath.set(newPath, meta);
  }

  // -- Yjs disk snapshotting ------------------------------------------------

  private scheduleSnapshotToDisk(path: string): void {
    let d = this.snapshotDebouncers.get(path);
    if (!d) {
      d = debounce<[]>(() => {
        this.snapshotDebouncers.delete(path);
        void this.snapshotDocToDisk(path);
      }, this.diskSnapshotDebounceMs);
      this.snapshotDebouncers.set(path, d);
    }
    d();
  }

  /**
   * Fold out-of-band disk edits into the `Y.Doc` before a snapshot
   * overwrites the file. The doc only learns about local edits through
   * watcher events (`handleLocalModify` → `setText`); anything written
   * while the plugin was off — git checkout, an external agent, edits
   * still inside the watcher's debounce window — exists ONLY on disk.
   * Snapshotting without this fold rolls the file back to the doc's
   * (stale) state: the 2026-06-12 mass-rollback incident, where a
   * catch-up rewrote 56 freshly-edited files with old server content.
   *
   * `diskText` is the disk content the caller already read (`null` when
   * the file doesn't exist) — one read shared between fold and the
   * write-skip compare keeps the race window minimal.
   *
   * `meta.contentHash` is the last state the engine itself synced or
   * wrote. A different disk hash means the bytes on disk are ahead of the
   * doc, so they're diffed in as local ops — those then ride the normal
   * local-update fan-out (live) or the catch-up push-back (reconnect) to
   * the server. When the disk still matches the last-synced hash the doc
   * is the one that's ahead (an incoming remote edit) and no fold happens.
   */
  private async foldDiskEditsIntoDoc(path: string, diskText: string | null): Promise<void> {
    const meta = this.fileIndex.byPath.get(path);
    if (!meta || meta.fileType !== 'TEXT') return;
    if (diskText === null) return;
    if (diskText === this.docManager.getText(this.binding.id, path)) return;
    const diskHash = await sha256Hex(diskText);
    if (diskHash === meta.contentHash) return;
    this.docManager.setText(this.binding.id, path, diskText);
  }

  /**
   * Per-path serialization for snapshots. A live `yjs:update` debounce and
   * a catch-up batch can both want to snapshot the same path; running the
   * two read-fold-write sequences concurrently interleaves their disk I/O
   * and can clobber one side's fold. Chain them instead.
   */
  private snapshotDocToDisk(path: string): Promise<void> {
    const prev = this.snapshotChains.get(path) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.writeDocSnapshot(path));
    const chained = next
      .catch(() => undefined)
      .then(() => {
        if (this.snapshotChains.get(path) === chained) this.snapshotChains.delete(path);
      });
    this.snapshotChains.set(path, chained);
    return next;
  }

  private async writeDocSnapshot(path: string): Promise<void> {
    if (!this.docManager.has(this.binding.id, path)) return;
    // Never snapshot a doc whose offline store is still loading — its text
    // is a partial view and the write would destroy the full copy on disk.
    await this.docManager.whenSynced(this.binding.id, path);
    const meta = this.fileIndex.byPath.get(path);
    // Half-applied docs must never reach the disk. Two flavors:
    //  - op-less doc for a file the server has content for — its catch-up
    //    batch / seed broadcast hasn't landed yet; writing now would
    //    truncate the file to the doc's empty text;
    //  - integrated ops with *pending* remote updates (out-of-order
    //    delivery) — the visible text is a stale subset; writing now is
    //    exactly the "files rolled back to old versions" incident.
    // Skip — the missing update arrives, fires its own snapshot, and that
    // one folds + writes the complete state.
    if (meta && meta.size > 0 && !this.docManager.hasState(this.binding.id, path)) return;
    if (this.docManager.hasPendingRemoteUpdates(this.binding.id, path)) return;
    const diskText = (await this.vault.exists(path)) ? await this.vault.readText(path) : null;
    await this.foldDiskEditsIntoDoc(path, diskText);
    const text = this.docManager.getText(this.binding.id, path);
    if (meta) {
      // Update meta BEFORE the write so the watcher echo's hash compare
      // in `handleLocalModify` short-circuits — same reasoning as in
      // `applyServerUpdateBinary`.
      meta.contentHash = await sha256Hex(text);
      meta.size = new TextEncoder().encode(text).byteLength;
      this.operationLog.setFileMeta(meta);
    }
    // Disk already matches the doc — don't rewrite the file. The catch-up
    // used to rewrite EVERY text file on EVERY connect: a mass write storm
    // that churned Obsidian's atomic-write temp files (the orphaned
    // `*.tmp.<pid>.<hex>` artifacts) and left hundreds of live echo
    // budgets in `recentlyApplied`, where they swallowed genuine external
    // edits arriving in the same window (the silent-rollback incident).
    if (diskText !== null && diskText === text) return;
    // See `applyServerUpdateBinary` — a single overwrite can fan out into
    // Obsidian onModify + chokidar `change` OR Obsidian onModify + chokidar
    // `unlink` + `add` (atomic-rename split). Budget for the worst case so
    // a stray `unlink` doesn't trigger handleLocalDelete and a stray `add`
    // doesn't then find an empty fileIndex and emit a phantom file:create.
    // The createText branch only sees create-style echoes (Obsidian
    // onCreate + chokidar `add`), so the smaller CREATE budget is exact.
    if (diskText !== null) {
      this.recentlyApplied.mark(path, ECHO_COUNT_WRITE);
      await this.vault.writeText(path, text);
    } else {
      await this.vault.ensureParentFolder(path);
      this.recentlyApplied.mark(path, ECHO_COUNT_CREATE);
      await this.vault.createText(path, text);
    }
  }

  // -- Pending queue --------------------------------------------------------

  private queue(
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.operationLog.enqueueOperation(this.binding.id, {
      opType,
      filePath,
      newPath,
      payload,
    });
  }

  /**
   * Replay every pending operation for this binding via the shared
   * `flushPendingQueue` helper from `reconnect.ts`. Splitting the loop
   * out of the engine lets us reuse the same drain machinery from a
   * future "Sync now" command.
   */
  private async flushPendingOperations(): Promise<void> {
    const emit: PendingEmitter = (op) => this.replayPending(op);
    await flushPendingQueue(this.binding.id, this.operationLog, emit);
  }

  private async replayPending(op: {
    opType: OperationType;
    filePath: string;
    newPath: string | null;
    payload: Record<string, unknown>;
  }): Promise<ReplayOutcome> {
    try {
      switch (op.opType) {
        case 'CREATE': {
          if (!(await this.vault.exists(op.filePath))) {
            // The file was deleted locally before we managed to flush —
            // dropping the op is the right thing.
            return { ok: false, retryable: false, error: 'local_file_missing' };
          }
          // The drain runs after `refreshFileIndex`, so a path the server
          // already tracks means this CREATE was queued while offline for a
          // file the server knew all along (e.g. a git checkout touching
          // synced files). Replaying it as CREATE makes the server
          // conflict-rename the duplicate (`<name>.conflict-<clientId>` —
          // 56 junk copies in the 2026-06-12 incident). Route through the
          // modify path instead: Yjs diff for text, binary UPDATE otherwise.
          if (this.fileIndex.byPath.has(op.filePath)) {
            await this.handleLocalModify(op.filePath);
            return { ok: true };
          }
          const data = await this.vault.readBinary(op.filePath);
          // Hash the bytes we're *actually* sending, not the stale
          // `payload.contentHash` captured at enqueue time. A file created
          // then edited while offline enqueues several CREATEs whose
          // payload hashes diverge; replaying those stale hashes makes the
          // server see "same path, different hash" and conflict-rename
          // every retry. A fresh hash matches the bytes, so the server's
          // idempotent-replay path collapses the duplicates instead.
          const fileType = (op.payload['fileType'] as FileType) ?? classifyFileType(op.filePath);
          const contentHash = await sha256Hex(data);
          const ack = await this.socket.emitFileCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            filePath: op.filePath,
            fileType,
            contentHash,
            size: data.byteLength,
            data,
          });
          if (ack.ok) {
            // Keep `fileIndex` authoritative so the initial-push pass that
            // runs right after the drain skips this file instead of
            // re-uploading it.
            const outcome = (ack as { outcome?: { fileId?: string; path?: string } }).outcome;
            if (outcome?.fileId && outcome?.path) {
              this.recordCreatedFile(
                outcome.fileId,
                outcome.path,
                fileType,
                contentHash,
                data.byteLength,
              );
            }
          }
          return ackToOutcome(ack);
        }
        case 'UPDATE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          const data = await this.vault.readBinary(op.filePath);
          // Hash the bytes being sent, not the stale enqueue-time snapshot
          // — same reasoning as the CREATE case above.
          const contentHash = await sha256Hex(data);
          const ack = await this.socket.emitFileUpdateBinary({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            contentHash,
            size: data.byteLength,
            data,
          });
          if (ack.ok) {
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) {
              meta.contentHash = contentHash;
              meta.size = data.byteLength;
              this.operationLog.setFileMeta(meta);
            }
          }
          return ackToOutcome(ack);
        }
        case 'DELETE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          const ack = await this.socket.emitFileDelete({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
          });
          if (ack.ok) {
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) this.fileIndex.byPath.delete(meta.relativePath);
            this.fileIndex.byId.delete(fileId);
            this.operationLog.deleteFileMeta(this.binding.id, op.filePath);
          }
          return ackToOutcome(ack);
        }
        case 'RENAME':
        case 'MOVE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId || !op.newPath) {
            return { ok: false, retryable: false, error: 'missing_target' };
          }
          const newPath = op.newPath;
          const event =
            op.opType === 'RENAME' ? this.socket.emitFileRename : this.socket.emitFileMove;
          const ack = await event.call(this.socket, {
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
            newPath,
          });
          if (ack.ok) {
            // Move the index entry so the post-drain initial-push pass
            // recognises the file at its new path instead of re-uploading
            // it. If the server actually conflict-renamed (a genuine
            // concurrent rename onto the same target), the broadcast
            // `renamed` event reconciles `fileIndex` to the real path
            // afterwards.
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) {
              this.operationLog.deleteFileMeta(this.binding.id, meta.relativePath);
              this.fileIndex.byPath.delete(meta.relativePath);
              meta.relativePath = newPath;
              this.fileIndex.byPath.set(newPath, meta);
              this.operationLog.setFileMeta(meta);
            }
          }
          return ackToOutcome(ack);
        }
      }
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  /**
   * Compare local file metadata against the server's authoritative list.
   * Used by the long-offline catch-up flow and exposed
   * for the future "Deep sync" command (Stage 10).
   */
  async runDeepSyncDiff(): Promise<DeepSyncDiff> {
    return computeDeepSyncDiff(
      this.binding.id,
      this.binding.projectId,
      this.api,
      this.operationLog,
    );
  }

  // -- Misc internals -------------------------------------------------------

  private bumpClock(): VectorClock {
    this.vectorClock = increment(this.vectorClock, this.clientId);
    return this.vectorClock;
  }

  private persistVectorClock(): void {
    this.operationLog.updateLastVectorClock(this.binding.id, this.vectorClock);
  }

  private setStatus(status: EngineStatus, detail?: string): void {
    this.status = status;
    // Observability: surface every transition through the logger so a sync
    // failure is diagnosable from sync.log / DevTools, not just the status
    // bar. `error` logs at error level (always written to the file sink);
    // every other transition at debug (mirrored to console only when
    // logLevel=debug). `detail` carries the cause — `project_not_found`, an
    // HTTP code, a socket disconnect reason — and `bindingId` rides in the
    // logger context so a multi-binding log stays greppable.
    if (status === 'error') {
      this.log.error('sync error', detail ?? '(no detail)');
    } else {
      this.log.debug('status', status, ...(detail !== undefined ? [detail] : []));
    }
    for (const cb of this.statusListeners) {
      try {
        cb(status, detail);
      } catch {
        // swallow
      }
    }
  }
}

// -- Local helpers ------------------------------------------------------------

/**
 * Render an error into a diagnostic `detail` string for the status bar and
 * the error log. An `ApiError` carries its HTTP status separately from a
 * bland `.message` ("Not found"), so we fold the code in —
 * `not_found (HTTP 404)` makes a deleted project / file distinguishable
 * from any other failure when reading `sync.log`. Generic errors fall back
 * to their message; non-`Error` throws to the supplied `fallback` code.
 */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.kind} (HTTP ${err.status})`;
  if (err instanceof Error) return err.message;
  return fallback;
}

function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k] ?? 0;
    if (v > cur) out[k] = v;
  }
  return out;
}

/**
 * Translate the socket ack ({ ok: true } | { ok: false, error }) into the
 * `ReplayOutcome` shape that `flushPendingQueue` expects. We classify
 * server errors heuristically: `*_not_found` is non-retryable (the op no
 * longer makes sense), everything else is retryable (transient).
 */
function ackToOutcome(ack: { ok: true } | { ok: false; error: string }): ReplayOutcome {
  if (ack.ok) return { ok: true };
  const error = ack.error;
  const retryable = !error.endsWith('_not_found') && error !== 'forbidden';
  return { ok: false, retryable, error };
}
