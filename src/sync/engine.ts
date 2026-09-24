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
import * as Y from 'yjs';
import { DocManager } from '@/crdt/doc-manager';
import { mergeText3 } from '@/crdt/text-merge';
import {
  OperationLog,
  type FileMeta,
  type OperationType,
  type PendingOperationInput,
} from './operation-log';
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
import {
  DEFAULT_CONFIG_DIR,
  checkVaultPath,
  isAlwaysIgnored,
  isInBinding,
} from '@/watcher/path-utils';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import { Logger, type LogSink } from '@/utils/logger';
import { EngineStoppedError, fence } from './stop-fence';

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

/** How many refused server paths an engine remembers as already reported. */
const MAX_REPORTED_REFUSALS = 1000;

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
 *
 * An engine is single-use: once {@link SyncEngine.stop} has run, nothing it
 * had started may touch the vault, the operation log, a Y.Doc or the network
 * again, and it never starts again — the `EngineManager` spawns a fresh one.
 * Every dependency is held through a stop fence (see `stop-fence.ts`), so the
 * check after each `await` is built in: a flow that wakes up after `stop()`
 * refuses on its next call and unwinds.
 *
 * Two things are not cut off, because cutting them loses data:
 *
 *   - A local change the engine took on and has not settled yet (sent and
 *     acknowledged, queued, or found to be a no-op) is handed to the offline
 *     queue by `stop()` itself, before the fence closes — see
 *     {@link SyncEngine.hold}. The next engine replays it.
 *   - A server change whose disk part has begun is finished: the whole local
 *     phase runs through {@link SyncEngine.commitLocal}, and `stop()` waits
 *     for it. A rename stopped between its disk steps would leave the old
 *     path behind for the next engine to upload as a new file.
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
   * Obsidian's config folder (`Vault.configDir`). Paths inside it are never
   * written, whatever the server says — that folder holds our own
   * `data.json` with the API key. Default `.obsidian`.
   */
  configDir?: string;
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

type IndexedMeta = FileMeta & { fileId: string };

/**
 * A local change the engine has taken on but not settled yet — the offline
 * queue entry `stop()` writes for it. Mutable: a handler fills the payload in
 * as it learns more (a binary edit's hash, say). The replay reads the disk
 * again anyway, so an entry handed over early is still correct.
 */
type HeldChange = Required<PendingOperationInput>;

/**
 * Where a local change comes from. A `queue` replay is held by the offline
 * queue itself — its entry stays until the drain marks it sent — so the
 * handler must not hold it a second time.
 */
type LocalSource = 'watcher' | 'queue';

/**
 * The engine's local state without the stop fence. Only a
 * {@link SyncEngine.commitLocal} block gets it: that block runs to the end
 * even when `stop()` lands in the middle.
 */
interface LocalIO {
  vault: VaultAdapter;
  log: OperationLog;
  echo: RecentlyApplied;
  docs: DocManager;
}

interface FileMetaIndex {
  byPath: Map<string, IndexedMeta>;
  byId: Map<string, IndexedMeta>;
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

/**
 * Payload flag of a queued DELETE that `stop()` handed over before the
 * stale-delete check had run: the replay runs that check first. Local to the
 * queue — the replay never sends it to the server.
 */
const RECHECK_DELETE = 'recheck';

/**
 * How many times one snapshot folds a disk that changed under it before it
 * leaves the write to a later snapshot (see `writeDocSnapshot`).
 */
const SNAPSHOT_FOLD_ATTEMPTS = 3;

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
  /**
   * The same client as {@link socket}, unfenced — only `stop()` uses it, to
   * disconnect after the fence has closed.
   */
  private readonly socketLink: SocketClient;
  /**
   * Aborted by `stop()`, with an {@link EngineStoppedError} as the reason.
   * Closes the fence around every dependency and cancels binary transfers
   * still in flight.
   */
  private readonly lifetime = new AbortController();
  /** The dependencies without the fence — for {@link commitLocal} blocks only. */
  private readonly local: LocalIO;
  /** Local changes taken on and not settled yet — see {@link hold}. */
  private readonly held = new Set<HeldChange>();
  /** Local phases still running — see {@link commitLocal}. `stop()` waits for them. */
  private readonly localCommits = new Set<Promise<unknown>>();
  private readonly diskSnapshotDebounceMs: number;
  private readonly conflictResolver: ConflictResolver;
  private readonly now: () => number;
  /** Binding-scoped logger — carries `component=engine bindingId=…` context. */
  private readonly log: Logger;
  private readonly configDir: string;
  /**
   * Project files that live OUTSIDE this binding's folder: id → path.
   *
   * In memory only, rebuilt on every `refreshFileIndex`. They are not in
   * `fileIndex` (so catch-up never hydrates hundreds of foreign docs and
   * `state.json` stays about our folder) and never reach the disk — but the
   * engine still has to recognise them, otherwise a file moved back INTO the
   * folder would arrive as a rename for a file we know nothing about.
   */
  private outOfScope = new Map<string, { path: string; fileType: FileType }>();

  /** Server paths already refused at `warn` — see `allowServerPath`. */
  private readonly reportedRefusals = new Set<string>();

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
   * Per-path tail of the disk↔doc work chain — see {@link withPathLock}. Two
   * snapshots, or a snapshot and a local-save fold, of the same file never
   * interleave their read-fold-write sequences.
   */
  private pathLocks = new Map<string, Promise<void>>();

  /**
   * Candidate fold bases, keyed by file id: the text of the last disk content
   * folded into the doc (`hash` known), or the doc's text captured just before
   * a remote update landed on it (`hash` computed on first use). Only ever
   * trusted when its hash equals the file's persisted marker — see
   * {@link resolveFoldBase}. In memory only; after a restart the base is
   * recovered from the disk or the doc when either still matches the marker.
   */
  private foldBases = new Map<string, { text: string; hash: string | null }>();

  /**
   * File ids whose catch-up was skipped because the disk already matched the
   * server — their local `Y.Doc` was never brought up to date this session.
   * The first time such a doc is needed it is pulled with `yjs:fetch` (see
   * {@link ensureHydrated}); a stale offline copy must not take part in a fold.
   */
  private skippedDocs = new Set<string>();

  /** In-flight {@link ensureHydrated} runs, keyed by file id. */
  private hydrations = new Map<string, Promise<void>>();

  /** Set when a `yjs:fetch` timed out; cleared on the next connect. */
  private yjsFetchUnavailable = false;

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
    // Everything the engine can act on goes through the fence: the shared
    // vault, log, docs and echo set (a paused engine's successor uses the same
    // ones), the network, and the conflict modal.
    const { signal } = this.lifetime;
    this.local = {
      vault: deps.vault,
      log: deps.operationLog,
      echo: deps.recentlyApplied,
      docs: deps.docManager,
    };
    this.vault = fence(deps.vault, signal);
    this.operationLog = fence(deps.operationLog, signal);
    this.docManager = fence(deps.docManager, signal);
    this.recentlyApplied = fence(deps.recentlyApplied, signal);
    this.api = fence(deps.apiClient ?? new ApiClient(deps.server), signal);
    this.socketLink =
      deps.socketClient ?? new SocketClient({ server: deps.server, clientId: deps.clientId });
    this.socket = fence(this.socketLink, signal);
    this.diskSnapshotDebounceMs = deps.diskSnapshotDebounceMs ?? 500;
    this.conflictResolver = fence(deps.conflictResolver ?? defaultConflictResolver, signal);
    this.now = deps.now ?? Date.now;
    this.configDir = deps.configDir ?? DEFAULT_CONFIG_DIR;
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
    // Single use — see the class comment. A restart would hand the new socket
    // to flows of the previous run.
    if (this.hasStopped) return;
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
    this.cleanups.push(
      this.socket.onYjsCatchup((batch) => this.detach(this.handleYjsCatchup(batch))),
    );

    this.socket.connect();
  }

  /**
   * Stop for good (plugin disabled or reloaded, sync paused, binding switched
   * off or removed).
   *
   * Work already under way cannot be interrupted: it sits on socket acks,
   * `requestUrl` calls and disk reads. Aborting the lifetime signal makes sure
   * none of it has any further effect. Binary transfers in flight are
   * cancelled; everything else refuses at the fence the moment a flow wakes
   * up, so a late answer is dropped without writing the vault, the operation
   * log or a Y.Doc and without another request.
   *
   * Two exceptions keep that from losing data (see the class comment). Local
   * changes still held go to the offline queue first — synchronously, before
   * the fence closes, so it is the engine's last write rather than a write
   * after stop. And a local phase already running is waited for. Once the
   * returned promise settles, the engine has written for the last time.
   *
   * The operation the drain had in flight stays queued, and a held change the
   * server had in fact already applied is queued as well: the next engine
   * sends both again. When that is a no-op on the server and when it is not:
   * {@link replayPending}.
   */
  async stop(): Promise<void> {
    if (!this.hasStopped) {
      this.handOverHeldChanges();
      this.lifetime.abort(new EngineStoppedError());
    }
    for (const cb of this.cleanups) cb();
    this.cleanups = [];
    for (const d of this.snapshotDebouncers.values()) d.cancel();
    this.snapshotDebouncers.clear();
    this.pathLocks.clear();
    this.foldBases.clear();
    this.skippedDocs.clear();
    this.hydrations.clear();
    this.socketLink.disconnect();
    this.setStatus('stopped');
    // Local only (see `commitLocal`), so this wait is short. The plugin's
    // teardown closes the operation log once every engine has stopped, and
    // the phase may still be writing file meta.
    await Promise.allSettled([...this.localCommits]);
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
    // An event that was already on its way when the engine stopped. Queueing
    // it would be a write from a plugin that is off, so it counts as an edit
    // made while the plugin was off.
    if (this.hasStopped) return;
    try {
      await this.dispatchVaultEvent(event);
    } catch (err) {
      // `stop()` landed while the event was being handled — nothing to report.
      if (this.hasStopped) return;
      throw err;
    }
  }

  private async dispatchVaultEvent(event: VaultEvent): Promise<void> {
    // Outgoing side of the same gate. The watchers filter too, but events also
    // arrive from the offline queue and from re-queued NACKs, and a build that
    // predates the gate could have recorded a path we must never upload — the
    // config folder holds `data.json` with the API key.
    const paths = event.type === 'rename' ? [event.oldPath, event.newPath] : [event.path];
    if (paths.some((p) => this.isIgnoredLocalPath(p))) {
      this.log.warn('refused to sync an ignored local path', {
        context: `local ${event.type}`,
        paths,
        configDir: this.configDir,
      });
      return;
    }
    switch (event.type) {
      case 'create':
        await this.handleLocalCreate(event.path);
        break;
      case 'modify':
        await this.handleLocalModify(event.path);
        break;
      case 'delete':
        if (event.isFolder) await this.handleLocalFolderDelete(event.path);
        else await this.handleLocalDelete(event.path);
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
      this.yjsFetchUnavailable = false;
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
      this.throwIfStopped();

      // Index is ready — let catch-up batches through, draining any that
      // arrived during the join↔refresh window.
      this.indexReady = true;
      const buffered = this.pendingCatchup;
      this.pendingCatchup = [];
      for (const batch of buffered) {
        await this.processCatchupBatch(batch);
        this.throwIfStopped();
      }

      if (!result.ok) {
        this.catchupResolve = null;
        this.setStatus('error', result.error);
        return;
      }

      // Apply server-side operations the client missed.
      for (const op of result.operations) {
        await this.applyServerOperation(op);
        this.throwIfStopped();
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
          this.throwIfStopped();
        }
      }
      this.throwIfStopped();

      // Подписка на отправку локальных правок — ЛЕНИВО.
      //
      // Раньше здесь был проход по всем текстовым файлам проекта с вызовом
      // `wireYjsForTextFile`, а тот через `onLocalUpdate` создаёт документ:
      // `Y.Doc` плюс отдельная база `y-indexeddb` на КАЖДЫЙ файл. На вальте в
      // 1062 файла это занимало поток интерфейса на десятки секунд, из-за чего
      // пропускался heartbeat, соединение рвалось и catch-up начинался заново —
      // лайвлок (инцидент 2026-08-06: фазы `syncing` 46 → 30 → 174 → 94 с).
      //
      // Теперь: уже поднятые документы подписываем сразу, а остальные — в
      // момент, когда они действительно понадобятся (открытие заметки, правка,
      // применение серверного апдейта).
      for (const meta of this.fileIndex.byPath.values()) {
        if (meta.fileType === 'TEXT' && this.docManager.has(this.binding.id, meta.relativePath)) {
          this.wireYjsForTextFile(meta.fileId, meta.relativePath);
        }
      }
      this.cleanups.push(
        this.docManager.onDocAcquired(this.binding.id, (filePath) => {
          const meta = this.fileIndex.byPath.get(filePath);
          if (meta?.fileType === 'TEXT') this.wireYjsForTextFile(meta.fileId, filePath);
        }),
      );

      this.persistVectorClock();
      this.setStatus('connected');

      // Reconnect catch-up tail, kicked off in the background so the
      // `connected` status doesn't wait on every queued upload. Ordering
      // inside is load-bearing — see `drainThenInitialPush`.
      this.detach(this.drainThenInitialPush());
    } catch (err) {
      this.catchupResolve = null;
      // Cut short by `stop()` — not a sync failure.
      if (this.hasStopped) return;
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
      this.throwIfStopped();
    }
    if (batch.done) {
      this.catchupResolve?.();
      this.catchupResolve = null;
    }
  }

  /**
   * Нужно ли вообще гидратировать документ из catch-up.
   *
   * Раньше `project:join` прогонял ВСЕ документы проекта: на каждый создавался
   * `Y.Doc` со своей базой IndexedDB (одна на файл) и делалась запись на диск.
   * На вальте в 1062 файла это блокировало поток интерфейса на десятки секунд —
   * Obsidian «висел», пропускал heartbeat, получал разрыв и переподключался,
   * запуская полный catch-up заново. Лайвлок: замеренные фазы `syncing` —
   * 46 с → 30 с → 174 с → 94 с, 796 с CPU (инцидент 2026-08-06).
   *
   * Работа не нужна, когда файл на диске уже побайтово равен серверной версии:
   * гидратировать нечего, локальных операций для отправки нет. Пропускаем
   * такой документ целиком — ни `Y.Doc`, ни IndexedDB, ни записи на диск.
   *
   * Пропуск НЕ применяется, если:
   * - документ уже загружен (открытая заметка, живые правки) — у него может
   *   быть история, которой нет у сервера;
   * - хэши расходятся — это и есть случай, ради которого catch-up нужен;
   * - файла нет на диске или его не прочитать — пусть отработает обычный путь.
   */
  private async catchupDocIsRedundant(meta: IndexedMeta, snap: YjsDocSnapshot): Promise<boolean> {
    if (this.docManager.has(this.binding.id, meta.relativePath)) return false;
    try {
      if (!(await this.vault.exists(meta.relativePath))) return false;
      const disk = await this.vault.readText(meta.relativePath);
      // Снимок разворачивается в ОДНОРАЗОВЫЙ Y.Doc — без y-indexeddb и без
      // записи на диск. Дорогая часть catch-up именно в них, а не в разборе
      // апдейта, поэтому такая проба остаётся дешёвой.
      //
      // Сравниваем содержимое, а НЕ contentHash из списка файлов: тот может
      // отставать от состояния Yjs-документа, и пропуск по хэшу отбросил бы
      // более новый серверный текст — тихий откат (ловится тестом
      // «catch-up still applies newer server content…»).
      const probe = new Y.Doc();
      let same: boolean;
      try {
        Y.applyUpdate(probe, Uint8Array.from(snap.sync1));
        same = probe.getText('content').toJSON() === disk;
      } finally {
        probe.destroy();
      }
      if (same) {
        // Диск совпал с сервером — это общий предок для следующих правок
        // диска, фиксируем его отметкой. Сам текст не держим: на большом
        // вальте это копия всего текста в памяти. Локальный `Y.Doc` при
        // этом не поднимался и мог отстать от сервера — при первой
        // надобности его подтянет `ensureHydrated`.
        this.recordFoldedHash(meta, await sha256Hex(disk));
        this.skippedDocs.add(meta.fileId);
      }
      return same;
    } catch {
      this.throwIfStopped();
      return false;
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
    if (await this.catchupDocIsRedundant(meta, snap)) return;
    // The offline doc store (y-indexeddb) loads asynchronously. Applying the
    // server's state to a doc that hasn't finished loading computes a bogus
    // push-back diff and snapshots a local-history-less merge over the file
    // on disk — a silent rollback.
    await this.docManager.whenSynced(this.binding.id, meta.relativePath);
    await this.withPathLock(meta.relativePath, () => this.noteDiskAgreement(meta));
    this.rememberBaseBeforeRemote(meta);
    const update = Uint8Array.from(snap.sync1);
    this.docManager.applyRemoteUpdate(this.binding.id, meta.relativePath, update);
    this.skippedDocs.delete(meta.fileId);
    await this.snapshotDocToDisk(meta.relativePath);
    this.pushMissingOps(meta, snap.stateVector);
  }

  /**
   * Push back the ops a doc has that the server lacks, given the server's
   * state vector for it. An "empty" Yjs delta is ~2 bytes (zero-struct,
   * zero-delete markers); anything larger is local history to ship.
   */
  private pushMissingOps(meta: IndexedMeta, serverStateVector: number[] | undefined): void {
    if (!serverStateVector || serverStateVector.length === 0) return;
    const missing = this.docManager.encodeStateAsUpdate(
      this.binding.id,
      meta.relativePath,
      Uint8Array.from(serverStateVector),
    );
    if (missing.length > 2) {
      void this.socket.emitYjsUpdate({
        projectId: this.binding.projectId,
        fileId: meta.fileId,
        update: missing,
      });
    }
  }

  /**
   * Waits for the streamed catch-up to finish, but never hangs the whole
   * connect on a stalled stream — after {@link CATCHUP_TIMEOUT_MS} we proceed
   * to `connected` regardless (the initial-push drain reconciles the rest).
   */
  private waitForCatchup(done: Promise<void>): Promise<void> {
    const { signal } = this.lifetime;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.catchupResolve = null;
        resolve();
      };
      const timer = window.setTimeout(finish, CATCHUP_TIMEOUT_MS);
      // `stop()` ends the wait at once: the connect flow unwinds instead of
      // holding the engine in memory until the guard fires.
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
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
      // A drain stopped with the engine ends the tail here.
      this.throwIfStopped();
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
    // Paths the server currently holds as tombstones. Re-uploading one would
    // resurrect an intentionally-deleted file: initialPush walks the raw disk,
    // and a file the server deleted but that is still on disk would come back
    // as a fresh CREATE. Honour the server's tombstones instead.
    const tombstoned = await this.fetchServerTombstones();
    this.throwIfStopped();
    if (tombstoned === null) {
      // Couldn't confirm the server's tombstones. Don't risk re-uploading a
      // deleted-but-still-on-disk file — after catch-up merges the delete
      // clock, the server's causal guard can't stop the resurrection. Defer
      // the whole pass; the next reconnect / a live watcher CREATE retries the
      // genuinely-new files.
      this.log.debug('initialPush: tombstone lookup failed; deferring upload pass');
      return;
    }
    for (const path of paths) {
      this.throwIfStopped();
      // Watcher events are filtered upstream, but this pass walks the raw
      // vault listing — without the same filter it uploads throw-away
      // artifacts (e.g. Obsidian's orphaned `*.tmp.<pid>.<hex>` files).
      if (this.isIgnoredLocalPath(path)) continue;
      if (this.fileIndex.byPath.has(path)) continue;
      if (pending.has(path)) continue;
      if (tombstoned.has(path)) {
        this.log.debug('initialPush: skipping server-tombstoned path', path);
        continue;
      }
      try {
        await this.handleLocalCreate(path);
      } catch {
        this.throwIfStopped();
        // Per-file failures are swallowed — the watcher / next reconnect
        // will surface them again.
      }
    }
  }

  /**
   * Vault paths the server currently holds as tombstones (soft-deleted). Used
   * by `initialPush` to avoid resurrecting an intentionally-deleted file that
   * is still on disk. Returns `null` on error (distinct from an empty set) so
   * the caller can fail CLOSED — a failed lookup must not silently re-upload
   * deleted files.
   */
  private async fetchServerTombstones(): Promise<Set<string> | null> {
    try {
      const files = await this.api.getProjectFiles(this.binding.projectId, {
        includeDeleted: true,
      });
      return new Set(files.filter((f) => f.deletedAt !== null).map((f) => f.path));
    } catch {
      this.throwIfStopped();
      return null;
    }
  }

  private async refreshFileIndex(): Promise<void> {
    const files = await this.api.getProjectFiles(this.binding.projectId);
    // A listing that lands after `stop()` must not rewrite the log's file meta.
    this.throwIfStopped();
    this.outOfScope.clear();
    const byPath = new Map<string, FileMeta & { fileId: string }>();
    const byId = new Map<string, FileMeta & { fileId: string }>();
    for (const f of files) {
      // Throw-away artifacts that an older client uploaded (e.g. Obsidian's
      // `*.tmp.<pid>.<hex>` atomic-write leftovers) must stay invisible —
      // indexing them would let server events materialise them on disk. The
      // binding itself is checked separately, just below.
      if (!this.allowServerPath(f.path, 'file index', { requireBinding: false })) {
        // Drop the stale mirror as well: a path we now refuse was written to
        // `state.json` by an older build and would otherwise linger there.
        this.operationLog.deleteFileMeta(this.binding.id, f.path);
        continue;
      }
      if (!isInBinding(f.path, this.binding.localFolder)) {
        // Someone else's folder inside the same project. Remembered by id
        // only — see `outOfScope`.
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        this.operationLog.deleteFileMeta(this.binding.id, f.path);
        continue;
      }
      // Preserve the client's last-known `contentHash` (the "common
      // ancestor" from the engine's perspective) for files we've synced
      // before — overwriting it with the server's current hash would
      // make `detectBinaryConflict` treat every server-side update as
      // already-known (`storedHash === serverHash`), silently clobbering
      // local edits. New files (no prior meta) fall back to the server's
      // hash so applyServerCreate's binary download starts from a known
      // baseline.
      const existing = this.operationLog.getFileMeta(this.binding.id, f.path);
      const meta: IndexedMeta = {
        bindingId: this.binding.id,
        relativePath: f.path,
        serverFileId: f.id,
        fileId: f.id,
        contentHash: existing?.contentHash ?? f.contentHash,
        size: existing?.size ?? f.size,
        fileType: f.fileType,
        lastSyncedAt: existing?.lastSyncedAt ?? Date.now(),
        // The fold marker is local knowledge the server listing can't restore;
        // dropping it on reconnect would bring back the reverted-edit bug.
        ...(existing?.foldedHash !== undefined ? { foldedHash: existing.foldedHash } : {}),
      };
      byPath.set(f.path, meta);
      byId.set(f.id, meta);
      // Mirror into SQLite so the next reconnect has it.
      this.operationLog.setFileMeta(meta);
    }
    this.fileIndex = { byPath, byId };
  }

  // -- Local → Server -------------------------------------------------------

  private async handleLocalCreate(path: string, from: LocalSource = 'watcher'): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    if (this.fileIndex.byPath.has(path)) {
      // The server already knows about this — treat as a modify.
      await this.handleLocalModify(path, from);
      return;
    }
    const fileType = classifyFileType(path);
    const change = this.hold(from, 'CREATE', path, null, { fileType });
    try {
      await this.sendLocalCreate(path, fileType, change);
    } finally {
      this.settle(change);
    }
  }

  private async sendLocalCreate(
    path: string,
    fileType: FileType,
    change: HeldChange | null,
  ): Promise<void> {
    // Stale-create guard: if the file isn't actually on disk anymore,
    // this event is leftover from an atomic-rename write (chokidar saw
    // the intermediate `add` but the file moved away again before we got
    // here). Emitting would upload empty bytes and tip the server into a
    // conflict-rename round-trip.
    if (!(await this.vault.exists(path))) return;
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);
    const payload = { fileType, contentHash: hash, size: buffer.byteLength };
    if (change) change.payload = payload;

    // Join-window guard: between socket connect and the fileIndex refresh
    // the index can't tell a NEW file from a server-known one — emitting
    // CREATE here makes the server conflict-rename every path whose hash
    // diverged (the 2026-06-12 burst: Obsidian's startup create-flood hit
    // this window and minted 120 `<name>.conflict-<clientId>.md` copies in
    // two seconds). Queue instead — the post-connect drain consults the
    // refreshed index and routes server-known paths through modify.
    if (this.socket.isConnected() && this.indexReady) {
      try {
        // Binary bytes are staged over REST; text rides inline (small).
        const data = await this.stageBinaryBlob(fileType, hash, buffer);
        this.throwIfStopped();
        const ack = await this.socket.emitFileCreate({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          vectorClock: this.bumpClock(),
          filePath: path,
          fileType,
          contentHash: hash,
          size: buffer.byteLength,
          ...(data !== undefined ? { data } : {}),
        });
        this.throwIfStopped();
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
      } catch {
        this.throwIfStopped();
        // Staging upload or emit failed (offline / server error) — fall through
        // to the offline queue, which replays on the next reconnect.
        this.log.debug('create staging/emit failed; queueing', path);
      }
    }
    // Offline (or NACK) — queue and bail; the engine will replay on reconnect.
    this.queue('CREATE', path, null, payload);
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
    // The path comes back from the server's ack and may differ from the one
    // we sent (conflict rename). From here it flows into `fileIndex` and
    // `state.json`, which every later disk write reads — so it passes the
    // same gate.
    if (!this.allowServerPath(path, 'create ack')) return;
    const meta: FileMeta & { fileId: string } = {
      bindingId: this.binding.id,
      relativePath: path,
      serverFileId: fileId,
      fileId,
      contentHash,
      size,
      fileType,
      lastSyncedAt: Date.now(),
      // The server seeds the file's CRDT from exactly these bytes, so they are
      // already "folded" — the base for the first local edit.
      ...(fileType === 'TEXT' ? { foldedHash: contentHash } : {}),
    };
    this.fileIndex.byPath.set(path, meta);
    this.fileIndex.byId.set(fileId, meta);
    this.operationLog.setFileMeta(meta);
    if (fileType === 'TEXT') this.wireYjsForTextFile(fileId, path);
  }

  /**
   * Stage a binary file's bytes over REST (`PUT /blobs/:hash`) so the follow-up
   * `file:create` / `file:update-binary` socket op can omit them — keeping
   * multi-megabyte blobs off the Socket.IO channel (sized for tiny Yjs ops).
   * Returns the value to inline as the op's `data`: the buffer for TEXT (rides
   * inline, small), `undefined` for BINARY (already staged by hash). Throws on
   * upload failure so callers fall back to the offline queue / retry.
   */
  private async stageBinaryBlob(
    fileType: FileType,
    contentHash: string,
    buffer: ArrayBuffer,
  ): Promise<ArrayBuffer | undefined> {
    if (fileType !== 'BINARY') return buffer;
    await this.uploadBlob(contentHash, buffer);
    return undefined;
  }

  /** `PUT /blobs/:hash`, cancelled by `stop()` — see {@link lifetime}. */
  private uploadBlob(contentHash: string, buffer: ArrayBuffer): Promise<void> {
    return this.api.uploadBlob(this.binding.projectId, contentHash, buffer, {
      signal: this.lifetime.signal,
    });
  }

  /** Download a file's current bytes, cancelled by `stop()`. */
  private downloadFile(fileId: string): Promise<ArrayBuffer> {
    return this.api.downloadFile(this.binding.projectId, fileId, {
      signal: this.lifetime.signal,
    });
  }

  private async handleLocalModify(path: string, from: LocalSource = 'watcher'): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    const meta = this.fileIndex.byPath.get(path);
    if (!meta) {
      // No server record yet — promote to a CREATE.
      await this.handleLocalCreate(path, from);
      return;
    }
    if (meta.fileType === 'TEXT') {
      // Text edits flow through Yjs. Read the disk content and fold it into
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
      //     on every client. Pull the doc's state first (`ensureHydrated`);
      //     if that isn't possible (offline, a server without `yjs:fetch`),
      //     defer: the doc hydrates via the catch-up stream or the live
      //     seed broadcast, and that snapshot folds the disk edits in.
      //
      // The fold itself is three-way — see `foldDiskEditsIntoDoc` for the
      // reverted-edit bug a plain doc↔disk diff caused.
      await this.withPathLock(path, async () => {
        await this.docManager.whenSynced(this.binding.id, path);
        await this.ensureHydrated(meta);
        if (!this.docManager.hasState(this.binding.id, path) && meta.size > 0) {
          this.log.debug('defer text modify until doc hydrates', path);
          return;
        }
        const content = await this.vault.readText(path);
        await this.foldDiskEditsIntoDoc(path, content);
        // The doc may hold remote edits the disk doesn't have yet. Their own
        // snapshot usually writes them out, but not when it found the note
        // gone right before its write (an unlink + create by git or an editor)
        // and left the path to the watcher — this event. Without a snapshot
        // here, disk and doc would disagree until the next remote edit.
        if (this.docManager.getText(this.binding.id, path) !== content) {
          this.scheduleSnapshotToDisk(path);
        }
      });
      return;
    }
    // Text needs no holding: an edit the fold did not reach stays on disk,
    // and the next fold (the catch-up's, at the latest) takes it in.
    const change = this.hold(from, 'UPDATE', path, null, { fileId: meta.fileId });
    try {
      await this.sendLocalBinaryUpdate(path, meta, change);
    } finally {
      this.settle(change);
    }
  }

  private async sendLocalBinaryUpdate(
    path: string,
    meta: IndexedMeta,
    change: HeldChange | null,
  ): Promise<void> {
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);
    if (hash === meta.contentHash) return; // nothing changed
    const payload = { fileId: meta.fileId, contentHash: hash, size: buffer.byteLength };
    if (change) change.payload = payload;

    if (this.socket.isConnected()) {
      try {
        // Binary bytes go to the REST staging area; the socket op is metadata-only.
        await this.uploadBlob(hash, buffer);
        this.throwIfStopped();
        const ack = await this.socket.emitFileUpdateBinary({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          vectorClock: this.bumpClock(),
          fileId: meta.fileId,
          contentHash: hash,
          size: buffer.byteLength,
        });
        this.throwIfStopped();
        if (ack.ok) {
          meta.contentHash = hash;
          meta.size = buffer.byteLength;
          this.operationLog.setFileMeta(meta);
          this.persistVectorClock();
          return;
        }
      } catch {
        this.throwIfStopped();
        this.log.debug('binary update staging/emit failed; queueing', path);
      }
    }
    this.queue('UPDATE', path, null, payload);
  }

  /**
   * A whole folder was deleted in Obsidian. Obsidian emits one delete for the
   * `TFolder` (never one per child), and the chokidar `unlink` events for the
   * children are unreliable under a burst of hundreds. So enumerate every
   * indexed path under the folder and delete each one explicitly — that is
   * what makes a folder delete propagate durably to the server.
   */
  private async handleLocalFolderDelete(folderPath: string): Promise<void> {
    if (!isInBinding(folderPath, this.binding.localFolder)) return;
    const children: string[] = [];
    for (const path of this.fileIndex.byPath.keys()) {
      if (isInBinding(path, folderPath)) children.push(path);
    }
    if (children.length === 0) return;
    this.log.debug('folder delete → expanding', folderPath, `(${children.length} files)`);
    // Hold every child's delete up front. They go out one ack at a time, and
    // a `stop()` halfway through must queue the ones not sent yet — the next
    // catch-up would otherwise write them back to disk. Checked already: the
    // folder is gone, so none of them can still be on disk.
    const held = children.map((path) => this.holdLocalDelete(path, { checked: true }));
    try {
      for (const change of held) {
        // Obsidian delivered one event (the folder); the per-child unlinks come
        // from chokidar, and the FS-watcher's Obsidian-dedupe only registered the
        // folder path. Pre-mark each child so its chokidar `unlink` echo is
        // swallowed instead of dispatching a second, racing handleLocalDelete.
        this.recentlyApplied.mark(change.filePath);
        await this.handleLocalDelete(change.filePath, change);
      }
    } finally {
      for (const change of held) this.settle(change);
    }
  }

  /**
   * Resolve a file's server id by vault path from the live project listing.
   * Used when a delete fires for a path missing from the local index (a
   * folder-delete child that was never individually indexed, or a stale
   * index). Returns '' when the server has no live file at that path.
   */
  private async resolveServerFileId(path: string): Promise<string> {
    try {
      const files = await this.api.getProjectFiles(this.binding.projectId);
      return files.find((f) => f.path === path)?.id ?? '';
    } catch {
      this.throwIfStopped();
      return '';
    }
  }

  /**
   * `from` is where the delete comes from, or the change a folder delete
   * already holds for this path.
   */
  private async handleLocalDelete(
    path: string,
    from: LocalSource | HeldChange = 'watcher',
  ): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    // Held before the stale-delete check below: that is a disk read `stop()`
    // can land on. Until the check passes, the held entry asks the replay to
    // repeat it (see `holdLocalDelete`).
    const change =
      from === 'queue'
        ? null
        : from === 'watcher'
          ? this.holdLocalDelete(path, { checked: false })
          : from;
    try {
      await this.sendLocalDelete(path, change);
    } finally {
      this.settle(change);
    }
  }

  /**
   * Hold a local delete. `checked: false` while the stale-delete check has not
   * passed yet: handed over in that state, the entry carries
   * {@link RECHECK_DELETE}, and the replay drops it if the file is on disk.
   * Only then — a plain queued DELETE goes out whatever the disk holds.
   *
   * The recheck errs on the safe side. The catch-up that runs before the drain
   * writes a text file the server still holds back to disk, so a real delete
   * handed over during that one disk read brings the note back instead of
   * going out. The other way round, a stray `unlink` sent as a delete would
   * erase the file for the whole team.
   */
  private holdLocalDelete(path: string, opts: { checked: boolean }): HeldChange {
    const fileId = this.fileIndex.byPath.get(path)?.fileId ?? '';
    return this.hold(
      'watcher',
      'DELETE',
      path,
      null,
      opts.checked ? { fileId } : { fileId, [RECHECK_DELETE]: true },
    );
  }

  private async sendLocalDelete(path: string, change: HeldChange | null): Promise<void> {
    // Stale-delete guard: if the file is still on disk, the watcher
    // event is almost certainly a stray chokidar `unlink` from an
    // atomic-rename overwrite (the matching `add` lands a beat later).
    // Without this check the engine emits `file:delete`, the server
    // applies it, broadcasts `file:deleted` back, our applyServerDelete
    // strips the path out of `fileIndex` — and the next watcher event
    // then finds an empty index and dispatches a phantom `file:create`.
    if (await this.vault.exists(path)) return;
    const meta = this.fileIndex.byPath.get(path);
    let fileId = meta?.fileId ?? '';
    // Checked: from here on `stop()` hands it over as a plain DELETE.
    if (change) change.payload = { fileId };
    // The path may be absent from the local index (a folder-delete child, or
    // a stale index). Resolve the id from the server's live file list before
    // giving up — otherwise the DELETE is queued with an empty fileId and is
    // later dropped as `no_file_id`, so the deletion never propagates.
    if (!fileId && this.socket.isConnected()) {
      fileId = await this.resolveServerFileId(path);
      this.throwIfStopped();
    }
    if (change) change.payload = { fileId };
    if (this.socket.isConnected() && fileId) {
      const ack = await this.socket.emitFileDelete({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId,
        filePath: path,
      });
      this.throwIfStopped();
      if (ack.ok) {
        this.fileIndex.byPath.delete(path);
        this.fileIndex.byId.delete(fileId);
        this.operationLog.deleteFileMeta(this.binding.id, path);
        // A concurrent remote yjs:update may have scheduled a debounced disk
        // snapshot for this path. With meta gone but the doc still live,
        // writeDocSnapshot's `docManager.has` guard stays true and (no `!meta`
        // guard) it would recreate the just-deleted file. Cancel the pending
        // snapshot and release the doc — the same teardown applyServerDelete does.
        this.snapshotDebouncers.get(path)?.cancel();
        this.snapshotDebouncers.delete(path);
        this.forgetFoldState(fileId);
        await this.docManager.release(this.binding.id, path);
        this.persistVectorClock();
        return;
      }
    }
    if (!fileId) {
      // No live server file at this path (already deleted, or never synced).
      // Nothing to propagate — but log it rather than silently swallowing a
      // delete that couldn't be resolved.
      this.log.debug('local delete: no server fileId, nothing to propagate', path);
      return;
    }
    this.queue('DELETE', path, null, { fileId });
  }

  private async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    // Переименование в интерфейсе Obsidian порождает ТРИ события: собственное
    // `vault.on('rename')` (мы здесь) плюс пару от сторожа — `unlink` старого
    // пути и `add` нового. Без пометки эти два доходят до движка, и `unlink`
    // успевает попасть в `handleLocalDelete` РАНЬШЕ, чем вернётся ack на
    // rename: индекс ещё содержит старый путь, `fileId` находится — и уходит
    // `file:delete`. Сервер применяет его следом за переименованием и убивает
    // только что переименованный файл, а затем рассылает удаление обратно,
    // стирая его и на диске.
    //
    // Проявляется тем сильнее, чем дольше ходит ack (удалённый сервер).
    // Воспроизведено 2026-08-06 на проде: переименование и перемещение через
    // UI уничтожали заметку, в журнале операций RENAME, следом DELETE.
    //
    // Серверные аппликаторы (`applyServerRename`) метят оба пути ровно так же.
    this.recentlyApplied.mark(oldPath, ECHO_COUNT_RENAME);
    this.recentlyApplied.mark(newPath, ECHO_COUNT_RENAME);

    const meta = this.fileIndex.byPath.get(oldPath);
    const fileId = meta?.fileId ?? '';
    // A disconnected socket never answers the ack: without holding it, a
    // rename sent just before `stop()` would be lost, and the next engine
    // would upload the new path as a second file.
    const change = this.hold('watcher', 'RENAME', oldPath, newPath, { fileId });
    try {
      if (this.socket.isConnected() && fileId) {
        const ack = await this.socket.emitFileRename({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          vectorClock: this.bumpClock(),
          fileId,
          filePath: oldPath,
          newPath,
        });
        this.throwIfStopped();
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
    } finally {
      this.settle(change);
    }
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

  // -- Path gate ------------------------------------------------------------

  /**
   * Gate for every path that arrives from the server: the file index, the
   * catch-up operations and the live socket events all funnel through here
   * before anything is written, downloaded or recorded.
   *
   * The server is not trusted to name a local path. A project member could
   * rename their file to `.obsidian/plugins/team-vault/data.json`; every
   * other client used to retarget its metadata onto its own settings file,
   * and the next "restore on server" uploaded that file — API key included
   * (fixed in 0.3.3). The same gate keeps writes inside the binding folder and
   * out of `.trash`.
   *
   * Refusal is never fatal: it logs and returns `false`, because the caller
   * chain of `handleServerFileEvent` turns a throw into engine status
   * `error`.
   *
   * A path is logged at `warn` the first time this engine refuses it and at
   * `debug` after that. The file index is re-read on every reconnect, and the
   * `.DS_Store` files an older version uploaded — one per folder a Mac user
   * opened in Finder — otherwise filled `sync.log` with the same lines on each
   * one, crowding out the entries worth reading.
   */
  private allowServerPath(
    path: string,
    context: string,
    opts: { requireBinding?: boolean } = {},
  ): boolean {
    const rejection = checkVaultPath(path, {
      ...(opts.requireBinding === false ? {} : { bindingFolder: this.binding.localFolder }),
      configDir: this.configDir,
    });
    if (rejection === null) return true;
    const details = { context, path, reason: rejection, configDir: this.configDir };
    const key = `${rejection}\u0000${path}`;
    if (this.reportedRefusals.has(key)) {
      this.log.debug('refused a path supplied by the server', details);
      return false;
    }
    // Paths come from the server: cap the memory they can take.
    if (this.reportedRefusals.size >= MAX_REPORTED_REFUSALS) this.reportedRefusals.clear();
    this.reportedRefusals.add(key);
    this.log.warn('refused a path supplied by the server', details);
    return false;
  }

  /** Local counterpart: throw-away artifacts and never-synced folders. */
  private isIgnoredLocalPath(path: string): boolean {
    return isAlwaysIgnored(path, this.configDir);
  }

  /**
   * Content hash of a vault file, or `null` when it can't be read. Takes the
   * vault it reads: inside a {@link commitLocal} block that is the unfenced one.
   */
  private async hashFile(vault: VaultAdapter, path: string): Promise<string | null> {
    try {
      if (!(await vault.exists(path))) return null;
      return await sha256Hex(await vault.readBinary(path));
    } catch {
      return null;
    }
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
      // Cut short by `stop()` — not a failure to apply.
      if (this.hasStopped) return;
      this.setStatus('error', describeError(err, 'apply_failed'));
    }
  }

  private handleServerYjsUpdate(msg: YjsUpdateMessage): void {
    if (this.hasStopped) return;
    const meta = this.fileIndex.byId.get(msg.fileId);
    if (!meta) return;
    this.rememberBaseBeforeRemote(meta);
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
    if (!this.allowServerPath(payload.path, 'create')) return;
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
      const buf = await this.downloadFile(payload.id);
      this.throwIfStopped();
      const hash = await sha256Hex(buf);
      // Meta and file go together — a meta recorded for a file that never
      // reached the disk would look like a synced copy.
      await this.commitLocal(async (io) => {
        // Same ordering as `applyServerUpdateBinary` — meta first, then the
        // disk write, so the watcher echo's hash compare short-circuits.
        meta.size = buf.byteLength;
        meta.contentHash = hash;
        io.log.setFileMeta(meta);
        // One createBinary fires Obsidian onCreate + chokidar 'add' — two
        // echoes that both need consuming.
        io.echo.mark(payload.path, ECHO_COUNT_CREATE);
        await io.vault.ensureParentFolder(payload.path);
        await io.vault.createBinary(payload.path, buf);
      });
    }
  }

  private async applyServerUpdateBinary(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    // Before the download: a refused path shouldn't cost a multi-megabyte
    // transfer. An entry can predate the gate — it comes back from
    // `state.json` written by an older build.
    if (!this.allowServerPath(meta.relativePath, 'update')) return;
    const newBuf = await this.downloadFile(fileId);
    this.throwIfStopped();
    const newHash = await sha256Hex(newBuf);
    /** Where `keep-both` parks the local edits. */
    let aside: string | null = null;

    // Conflict detection — only triggers when the user has uncommitted edits.
    // Stopped anywhere up to the write below, nothing has changed yet: the
    // next catch-up replays this UPDATE and starts over.
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
        // The modal can be answered long after the plugin went away.
        this.throwIfStopped();
        if (resolution === 'keep-local') {
          // Push our local content as the new server version. Bump clock,
          // emit; if offline, queue. The server will then broadcast it
          // back as `file:updated-binary` — by then `meta.contentHash`
          // matches the local hash, so the second pass is a no-op.
          if (this.socket.isConnected()) {
            try {
              await this.uploadBlob(localHash, localBuf);
              this.throwIfStopped();
              await this.socket.emitFileUpdateBinary({
                projectId: this.binding.projectId,
                clientId: this.clientId,
                vectorClock: this.bumpClock(),
                fileId,
                contentHash: localHash,
                size: localBuf.byteLength,
              });
              this.throwIfStopped();
            } catch {
              this.throwIfStopped();
              this.log.debug(
                'keep-local binary push failed; reconcile on reconnect',
                meta.relativePath,
              );
            }
          }
          meta.contentHash = localHash;
          meta.size = localBuf.byteLength;
          this.operationLog.setFileMeta(meta);
          return;
        }
        if (resolution === 'keep-both') {
          // Move the local edits aside, then write the server's version.
          aside = buildConflictPath(meta.relativePath, this.now());
        }
        // 'keep-server' falls through to the standard apply path below.
      }
    }

    // One local phase: the park-aside, the meta and the write. Stopped after
    // the meta, the log would claim bytes the disk never got, and the next
    // local edit would upload the old ones over the server's version.
    const parkAt = aside;
    await this.commitLocal(async (io) => {
      const path = meta.relativePath;
      if (parkAt !== null) {
        // A rename fires Obsidian onRename + chokidar 'unlink' (old) +
        // 'add' (new) — both paths need their own echo budgets, or the
        // engine's own handlers will turn the echo into a real
        // file:delete / file:create round-trip to the server.
        io.echo.mark(path, ECHO_COUNT_RENAME);
        io.echo.mark(parkAt, ECHO_COUNT_RENAME);
        await io.vault.ensureParentFolder(parkAt);
        await io.vault.rename(path, parkAt);
        // Note: the renamed file is NOT auto-uploaded — the user can
        // decide what to do with it; if they keep it, the next vault
        // event picks it up as a fresh CREATE.
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
      io.log.setFileMeta(meta);
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
      if (await io.vault.exists(path)) {
        io.echo.mark(path, ECHO_COUNT_WRITE);
        await io.vault.writeBinary(path, newBuf);
      } else {
        await io.vault.ensureParentFolder(path);
        io.echo.mark(path, ECHO_COUNT_CREATE);
        await io.vault.createBinary(path, newBuf);
      }
    });
  }

  private async applyServerDelete(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    // Deleting is a write too: a stale index entry naming the config folder
    // must not let the server erase files there.
    if (!this.allowServerPath(meta.relativePath, 'delete')) return;

    // One local phase, from the check to the delete. A delete stopped before
    // it reaches the disk is not replayed: the next catch-up no longer finds
    // the file in the listing and has nothing to apply it to, so the local
    // copy would stay behind, never synced again. Only a conflict leaves the
    // phase — to ask the user, which can take any time.
    const conflict = await this.commitLocal(async (io) => {
      // Delete-vs-update guard: if the local file still exists and has
      // uncommitted edits, ask the user before clobbering them.
      if (await io.vault.exists(meta.relativePath)) {
        const localBuf = await io.vault.readBinary(meta.relativePath);
        const localHash = await sha256Hex(localBuf);
        if (detectDeleteConflict({ storedHash: meta.contentHash, localHash })) {
          return { localBuf, localHash };
        }
      }
      await this.removeLocalCopy(io, meta);
      return null;
    });
    if (!conflict) return;

    const { localBuf, localHash } = conflict;
    const resolution = await this.conflictResolver.resolveDeleteConflict({
      filePath: meta.relativePath,
      localSize: localBuf.byteLength,
    });
    this.throwIfStopped();
    if (resolution === 'restore-server') {
      // Push the local content as a fresh CREATE so the server
      // un-deletes it. The recipient broadcast will reset our state.
      if (this.socket.isConnected()) {
        try {
          const data = await this.stageBinaryBlob(meta.fileType, localHash, localBuf);
          this.throwIfStopped();
          await this.socket.emitFileCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            filePath: meta.relativePath,
            fileType: meta.fileType,
            contentHash: localHash,
            size: localBuf.byteLength,
            ...(data !== undefined ? { data } : {}),
          });
        } catch {
          this.throwIfStopped();
          this.log.debug('restore-server push failed; reconcile on reconnect', meta.relativePath);
        }
      }
      // Don't drop local state — we want the file to stay.
      return;
    }
    // 'delete-local'.
    await this.commitLocal((io) => this.removeLocalCopy(io, meta));
  }

  /** Delete the local copy of a file the server deleted, bookkeeping included. */
  private async removeLocalCopy(io: LocalIO, meta: IndexedMeta): Promise<void> {
    const path = meta.relativePath;
    // One delete fires Obsidian onDelete + chokidar `unlink`.
    io.echo.mark(path, ECHO_COUNT_DELETE);
    if (await io.vault.exists(path)) {
      await io.vault.delete(path);
    }
    this.fileIndex.byPath.delete(path);
    this.fileIndex.byId.delete(meta.fileId);
    io.log.deleteFileMeta(this.binding.id, path);
    this.forgetFoldState(meta.fileId);
    await io.docs.release(this.binding.id, path);
  }

  private async applyServerRename(fileId: string, newPath: string): Promise<void> {
    // Hard checks first — they hold wherever the file ends up. The binding is
    // NOT one of them: a rename is the server telling us a file we already
    // sync has moved, and refusing it would leave our copy behind for
    // `initialPush` to upload again as a brand-new file (a duplicate for the
    // whole team).
    if (!this.allowServerPath(newPath, 'rename', { requireBinding: false })) return;
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) {
      await this.adoptRenamedFile(fileId, newPath);
      return;
    }
    const oldPath = meta.relativePath;
    if (oldPath === newPath) return;
    // The source is metadata rather than a fresh server string, but metadata
    // can come from `state.json` written by a build without the gate.
    if (!this.allowServerPath(oldPath, 'rename source', { requireBinding: false })) return;

    // Everything from here on is one local phase, the disk checks included.
    // A rename cut anywhere in it leaves the old path on disk while the next
    // engine's listing already shows the new one: that engine counts the
    // rename as applied, writes the new path from the catch-up, and uploads
    // the old one as a brand-new file — a duplicate for the whole team.
    await this.commitLocal((io) => this.moveLocalCopy(io, meta, newPath));
  }

  /** Apply a server rename to the disk and the index. Local phase only. */
  private async moveLocalCopy(io: LocalIO, meta: IndexedMeta, newPath: string): Promise<void> {
    const { fileId } = meta;
    const oldPath = meta.relativePath;
    if (await io.vault.exists(oldPath)) {
      if (await io.vault.exists(newPath)) {
        // Destination already materialised locally — e.g. an initial-push
        // pass created it, or this rename was partially applied before.
        // `adapter.rename` throws "Destination file already exists" here,
        // which would otherwise crash the engine to `error` status.
        //
        // Dropping the source used to be the answer, but that is a silent
        // local data loss driven by a remote event: whoever controls the
        // server picks the file to destroy (fixed in 0.3.3). Identical content is
        // the benign case and stays a delete; differing content parks the
        // local destination aside, the way `keep-both` does for binary
        // conflicts, so nothing disappears.
        const sourceHash = await this.hashFile(io.vault, oldPath);
        const destHash = sourceHash === null ? null : await this.hashFile(io.vault, newPath);
        if (sourceHash === null || destHash === null) {
          // Couldn't read one of them (locked file, antivirus, dropped network
          // drive). Guessing here either deletes a file we never read or parks
          // a file that is in fact identical — leave both alone, and leave the
          // index untouched so the next reconnect retries from the listing.
          this.log.warn('server rename: could not compare the local files', { oldPath, newPath });
          return;
        }
        // Echo budgets are claimed only once the disk is actually about to
        // change: every early return above would otherwise leave a live budget
        // behind that swallows a genuine external edit.
        io.echo.mark(oldPath, ECHO_COUNT_RENAME);
        io.echo.mark(newPath, ECHO_COUNT_RENAME);
        if (sourceHash === destHash) {
          await io.vault.delete(oldPath);
        } else {
          const aside = buildConflictPath(newPath, this.now());
          this.log.warn('server rename collided with a different local file', {
            oldPath,
            newPath,
            aside,
          });
          // `newPath` takes part in TWO renames here (as the source of the
          // park-aside and as the destination of the real rename), so it needs
          // a second echo budget — `mark` adds to what is left. Without it the
          // leftover `unlink` reaches `handleLocalDelete` for a path that has
          // just become a live file: the 2026-08-06 incident.
          io.echo.mark(aside, ECHO_COUNT_RENAME);
          io.echo.mark(newPath, ECHO_COUNT_RENAME);
          await io.vault.ensureParentFolder(aside);
          await io.vault.rename(newPath, aside);
          await io.vault.ensureParentFolder(newPath);
          await io.vault.rename(oldPath, newPath);
        }
      } else {
        io.echo.mark(oldPath, ECHO_COUNT_RENAME);
        io.echo.mark(newPath, ECHO_COUNT_RENAME);
        await io.vault.ensureParentFolder(newPath);
        await io.vault.rename(oldPath, newPath);
      }
    }

    io.log.deleteFileMeta(this.binding.id, oldPath);
    this.fileIndex.byPath.delete(oldPath);
    if (!isInBinding(newPath, this.binding.localFolder)) {
      // The file left our folder. It stays on disk where the server says it
      // is, but it is no longer ours to track: keeping it in `fileIndex` would
      // mirror a foreign path into `state.json`, and forgetting it entirely
      // would make a later move back in look like an unknown file.
      this.fileIndex.byId.delete(fileId);
      this.outOfScope.set(fileId, { path: newPath, fileType: meta.fileType });
      await io.docs.release(this.binding.id, oldPath);
      this.forgetFoldState(fileId);
      this.log.info('file moved out of the binding folder', { oldPath, newPath });
      return;
    }
    meta.relativePath = newPath;
    io.log.setFileMeta(meta);
    this.fileIndex.byPath.set(newPath, meta);
  }

  /**
   * A rename for a file we don't track: it lives outside the binding folder
   * (see `outOfScope`). Moving into our folder makes it ours — materialise it
   * exactly like a fresh CREATE; moving elsewhere just updates the shadow
   * entry. Anything else is not our file and is ignored.
   */
  private async adoptRenamedFile(fileId: string, newPath: string): Promise<void> {
    const known = this.outOfScope.get(fileId);
    if (!known) return;
    if (!isInBinding(newPath, this.binding.localFolder)) {
      this.outOfScope.set(fileId, { ...known, path: newPath });
      return;
    }
    this.outOfScope.delete(fileId);
    this.log.info('file moved into the binding folder', { fileId, newPath });
    await this.applyServerCreate({ id: fileId, path: newPath, fileType: known.fileType });
  }

  // -- Yjs disk snapshotting ------------------------------------------------

  private scheduleSnapshotToDisk(path: string): void {
    // No new timers after `stop()` — it has already cancelled the existing ones.
    this.throwIfStopped();
    let d = this.snapshotDebouncers.get(path);
    if (!d) {
      d = debounce<[]>(() => {
        this.snapshotDebouncers.delete(path);
        this.detach(this.snapshotDocToDisk(path));
      }, this.diskSnapshotDebounceMs);
      this.snapshotDebouncers.set(path, d);
    }
    d();
  }

  /**
   * Fold disk edits the `Y.Doc` hasn't seen into it — on every local save
   * (`handleLocalModify`) and before a snapshot overwrites the file. The doc
   * only learns about local edits through this fold; anything written while
   * the plugin was off — git checkout, an external agent, edits still inside
   * the watcher's debounce window — exists ONLY on disk. Snapshotting without
   * it rolls the file back to the doc's (stale) state: the 2026-06-12
   * mass-rollback incident, where a catch-up rewrote 56 freshly-edited files
   * with old server content. The folded ops then ride the local-update
   * fan-out (live) or the catch-up push-back (reconnect) to the server.
   *
   * `diskText` is the disk content the caller already read (`null` when
   * the file doesn't exist) — one read shared between fold and the
   * write-skip compare keeps the race window minimal.
   *
   * The fold is three-way. `meta.foldedHash` marks the last disk content
   * already folded in, so the disk's edits are whatever changed since that
   * base — while the doc may meanwhile hold remote edits the disk hasn't
   * received (a teammate's change waiting for its snapshot write). Until
   * 0.3.2 the doc was diffed straight against the disk, and with a stale
   * marker every such remote edit looked like a local deletion: it was
   * removed from the CRDT, the removal shipped to the server, and the
   * teammate's edit vanished everywhere.
   *
   * A base text is trusted only when its hash equals the marker (see
   * {@link resolveFoldBase}). With none — a log from an older plugin, or both
   * sides changed while the plugin was off — the disk content wins as it
   * always did, and that is logged: it drops the doc's unwritten remote edits.
   */
  private async foldDiskEditsIntoDoc(path: string, diskText: string | null): Promise<void> {
    const meta = this.fileIndex.byPath.get(path);
    if (!meta || meta.fileType !== 'TEXT') return;
    if (diskText === null) return;
    if (diskText === this.docManager.getText(this.binding.id, path)) {
      await this.markFolded(meta, diskText);
      return;
    }
    const marker = meta.foldedHash;
    const diskHash = await sha256Hex(diskText);
    // Logs from before 0.3.2 have no marker yet. `contentHash` still answers
    // "is the disk unchanged since the last sync", as it always did — but it
    // may come straight from the server listing for a file this device never
    // wrote, so it must never pick a merge base: a base the disk doesn't
    // descend from turns divergence into doubled text.
    if (diskHash === (marker ?? meta.contentHash)) {
      // Nothing on disk the doc hasn't seen — the doc is the one ahead.
      if (marker !== undefined) this.foldBases.set(meta.fileId, { text: diskText, hash: diskHash });
      return;
    }
    const base = marker === undefined ? null : await this.resolveFoldBase(meta, marker);
    this.throwIfStopped();
    // Remote updates keep landing while the awaits above yield, so the doc is
    // read only now, and everything from here to `setText` is synchronous — a
    // merge computed against an older doc text would delete what arrived since.
    const docText = this.docManager.getText(this.binding.id, path);
    let next = diskText;
    if (base === null) {
      if (diskText !== docText) {
        this.log.info('fold without a verified base, disk content wins', path);
      }
    } else if (base !== docText) {
      next = mergeText3(base, diskText, docText);
    }
    this.docManager.setText(this.binding.id, path, next);
    await this.markFolded(meta, diskText, diskHash);
  }

  /**
   * The last folded disk text, if it can be recovered and proven by `marker`:
   * a cached base or pre-remote capture ({@link foldBases}), the doc itself
   * when it hasn't moved since, or the server's version history, which
   * usually holds the folded content (text is versioned once edits settle).
   * `null` when nothing matches — never a guess: a base missing text both
   * sides already have would re-insert it (the duplication incidents), one
   * with extra text would delete it.
   */
  private async resolveFoldBase(meta: IndexedMeta, marker: string): Promise<string | null> {
    const cached = this.foldBases.get(meta.fileId);
    if (cached) {
      const hash = cached.hash ?? (await sha256Hex(cached.text));
      if (hash === marker) return cached.text;
      this.foldBases.delete(meta.fileId);
    }
    const docText = this.docManager.getText(this.binding.id, meta.relativePath);
    if ((await sha256Hex(docText)) === marker) return docText;
    return this.loadBaseFromHistory(meta, marker);
  }

  /** Download the server version whose hash is `marker`, verified. `null` on any miss. */
  private async loadBaseFromHistory(meta: IndexedMeta, marker: string): Promise<string | null> {
    try {
      const versions = await this.api.getFileVersions(this.binding.projectId, meta.fileId);
      this.throwIfStopped();
      const match = versions.find((v) => v.contentHash === marker);
      if (!match) return null;
      const bytes = await this.api.downloadFileVersion(
        this.binding.projectId,
        meta.fileId,
        match.id,
        { signal: this.lifetime.signal },
      );
      // Keep a BOM as a character so the re-encoded bytes (and hash) match.
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      return (await sha256Hex(text)) === marker ? text : null;
    } catch {
      this.throwIfStopped();
      return null;
    }
  }

  /** Record `text` — now fully in the doc — as the base for the next fold. */
  private async markFolded(meta: IndexedMeta, text: string, hash?: string): Promise<void> {
    const cached = this.foldBases.get(meta.fileId);
    const folded =
      hash ??
      (cached && cached.text === text && cached.hash !== null
        ? cached.hash
        : await sha256Hex(text));
    this.foldBases.set(meta.fileId, { text, hash: folded });
    this.setFoldedHash(meta, folded);
  }

  /** Move the fold marker when the base text itself isn't worth keeping in memory. */
  private recordFoldedHash(meta: IndexedMeta, hash: string): void {
    if (this.foldBases.get(meta.fileId)?.hash !== hash) this.foldBases.delete(meta.fileId);
    this.setFoldedHash(meta, hash);
  }

  /**
   * Persist the marker on the file's LIVE index entry. Callers get here after
   * awaits: meanwhile the file may have been deleted (writing its meta back
   * would resurrect a ghost entry in the log) or the index rebuilt on
   * reconnect (the object in hand is no longer the one folds will read).
   */
  private setFoldedHash(meta: IndexedMeta, hash: string): void {
    const live = this.fileIndex.byId.get(meta.fileId);
    if (live !== meta) meta.foldedHash = hash;
    if (!live || live.foldedHash === hash) return;
    live.foldedHash = hash;
    this.operationLog.setFileMeta(live);
  }

  /**
   * Capture the doc's text right before remote state lands on it, as a base
   * candidate for the next fold: until the snapshot writes that remote edit
   * out, it is the last text disk and doc can have agreed on. Only the first
   * update after an agreement is captured, and the candidate is checked
   * against the marker before use — a doc still loading from IndexedDB
   * (partial text) simply fails the check.
   */
  private rememberBaseBeforeRemote(meta: IndexedMeta): void {
    if (this.foldBases.has(meta.fileId)) return;
    if (!this.docManager.has(this.binding.id, meta.relativePath)) return;
    if (!this.docManager.hasState(this.binding.id, meta.relativePath)) return;
    this.foldBases.set(meta.fileId, {
      text: this.docManager.getText(this.binding.id, meta.relativePath),
      hash: null,
    });
  }

  /**
   * A loaded doc and the disk holding the same text is a verified base —
   * record it before catch-up moves the doc. This is what gives a file last
   * synced by an older plugin (no `foldedHash` yet) a trustworthy base.
   */
  private async noteDiskAgreement(meta: IndexedMeta): Promise<void> {
    const path = meta.relativePath;
    if (!this.docManager.hasState(this.binding.id, path)) return;
    try {
      if (!(await this.vault.exists(path))) return;
      const disk = await this.vault.readText(path);
      if (disk === this.docManager.getText(this.binding.id, path)) {
        await this.markFolded(meta, disk);
      }
    } catch {
      this.throwIfStopped();
      // Unreadable disk — no agreement to record; the fold copes without.
    }
  }

  private forgetFoldState(fileId: string): void {
    this.foldBases.delete(fileId);
    this.skippedDocs.delete(fileId);
    this.hydrations.delete(fileId);
  }

  /**
   * Bring a doc up to the server's state with `yjs:fetch` when it can't be
   * trusted as is: no history for a file that has content, remote updates
   * parked on a history gap, or a copy the catch-up skipped this session.
   * Before 0.3.2 such a doc waited for the next reconnect — a teammate's
   * edit to a note the catch-up had skipped never reached the disk, because
   * the live delta had nothing to attach to. Best effort: offline, or on a
   * server without the event, callers keep their existing guards.
   */
  private ensureHydrated(meta: IndexedMeta): Promise<void> {
    if (!this.needsHydration(meta)) return Promise.resolve();
    const running = this.hydrations.get(meta.fileId);
    if (running) return running;
    const run = this.hydrate(meta)
      .catch((err: unknown) => {
        // A hydration cut short by `stop()` failed nothing; whoever waits on
        // it refuses at its own next step.
        if (!this.hasStopped) this.log.debug('hydration failed', meta.relativePath, err);
      })
      .finally(() => {
        if (this.hydrations.get(meta.fileId) === run) this.hydrations.delete(meta.fileId);
      });
    this.hydrations.set(meta.fileId, run);
    return run;
  }

  private needsHydration(meta: IndexedMeta): boolean {
    if (meta.fileType !== 'TEXT') return false;
    if (this.skippedDocs.has(meta.fileId)) return true;
    const path = meta.relativePath;
    if (this.docManager.hasPendingRemoteUpdates(this.binding.id, path)) return true;
    return meta.size > 0 && !this.docManager.hasState(this.binding.id, path);
  }

  private async hydrate(meta: IndexedMeta): Promise<void> {
    if (!this.socket.isConnected() || this.yjsFetchUnavailable) return;
    const result = await this.socket.fetchYjsDoc(this.binding.projectId, meta.fileId);
    this.throwIfStopped();
    if (!result.ok) {
      // A server that predates `yjs:fetch` never answers; don't make every
      // later save wait out the timeout again before the next connect.
      if (result.error === 'timeout') this.yjsFetchUnavailable = true;
      this.log.debug('yjs:fetch failed', meta.relativePath, result.error);
      return;
    }
    // The file may have been deleted or renamed while the request was out.
    const current = this.fileIndex.byId.get(meta.fileId);
    if (!current || !this.docManager.has(this.binding.id, current.relativePath)) return;
    this.rememberBaseBeforeRemote(current);
    this.docManager.applyRemoteUpdate(
      this.binding.id,
      current.relativePath,
      Uint8Array.from(result.sync1),
    );
    this.skippedDocs.delete(current.fileId);
    this.pushMissingOps(current, result.stateVector);
    // The fetched state may carry edits the disk hasn't seen; a snapshot that
    // finds nothing new doesn't touch the file. Not while updates stay parked:
    // that snapshot would hydrate again, and again.
    if (!this.needsHydration(current)) this.scheduleSnapshotToDisk(current.relativePath);
  }

  /**
   * Per-path serialization for snapshots. A live `yjs:update` debounce and
   * a catch-up batch can both want to snapshot the same path; running the
   * two read-fold-write sequences concurrently interleaves their disk I/O
   * and can clobber one side's fold. Chain them instead.
   */
  private snapshotDocToDisk(path: string): Promise<void> {
    return this.withPathLock(path, () => this.writeDocSnapshot(path));
  }

  /**
   * Run `task` exclusively for `path` — every sequence that reads the disk,
   * folds it into the doc and moves the fold marker goes through here. The
   * fold awaits (hashing, `yjs:fetch`, version history), so a local-save fold
   * racing a snapshot of the same file could fold one edit twice or record a
   * marker for content the disk no longer holds.
   */
  private withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const prev = this.pathLocks.get(path) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.pathLocks.set(path, tail);
    void tail.then(() => {
      if (this.pathLocks.get(path) === tail) this.pathLocks.delete(path);
    });
    return next;
  }

  private async writeDocSnapshot(path: string): Promise<void> {
    if (!this.docManager.has(this.binding.id, path)) return;
    // Last line of defence for text content: catch-up, live `yjs:update` and
    // hydration all end up here. Before `ensureHydrated`, so a refused path
    // doesn't even trigger a `yjs:fetch`.
    if (!this.allowServerPath(path, 'snapshot')) return;
    // Never snapshot a doc whose offline store is still loading — its text
    // is a partial view and the write would destroy the full copy on disk.
    await this.docManager.whenSynced(this.binding.id, path);
    const meta = this.fileIndex.byPath.get(path);
    // A doc with a history gap, or one the catch-up skipped, is pulled from
    // the server first — a live delta for such a note otherwise has nothing
    // to attach to and never reaches the disk.
    if (meta) await this.ensureHydrated(meta);
    // Half-applied docs must never reach the disk. Two flavors:
    //  - op-less doc for a file the server has content for — its catch-up
    //    batch / seed broadcast hasn't landed yet; writing now would
    //    truncate the file to the doc's empty text;
    //  - integrated ops with *pending* remote updates (out-of-order
    //    delivery) — the visible text is a stale subset; writing now is
    //    exactly the "files rolled back to old versions" incident.
    // Skip when hydration couldn't fix it — the missing update arrives, fires
    // its own snapshot, and that one folds + writes the complete state.
    if (meta && meta.size > 0 && !this.docManager.hasState(this.binding.id, path)) return;
    if (this.docManager.hasPendingRemoteUpdates(this.binding.id, path)) return;
    let diskText = await this.readDiskText(path);
    let text: string;
    let hash = '';
    for (let attempt = 1; ; attempt++) {
      await this.foldDiskEditsIntoDoc(path, diskText);
      text = this.docManager.getText(this.binding.id, path);
      if (meta) hash = await sha256Hex(text);
      // Disk already matches the doc — don't rewrite the file. The catch-up
      // used to rewrite EVERY text file on EVERY connect: a mass write storm
      // that churned Obsidian's atomic-write temp files (the orphaned
      // `*.tmp.<pid>.<hex>` artifacts) and left hundreds of live echo
      // budgets in `recentlyApplied`, where they swallowed genuine external
      // edits arriving in the same window (the silent-rollback incident).
      if (diskText !== null && diskText === text) {
        if (meta) {
          this.recordSnapshotMeta(meta, text, hash);
          await this.markFolded(meta, text, hash);
        }
        return;
      }
      // The fold and the hashing yield, and the disk may change meanwhile. A
      // save landing now is on disk but not in `text`: the write would roll it
      // back, and the open editor, which reloads the file, with it. A delete
      // landing now would be undone. Look again right before the write.
      const current = await this.readDiskText(path);
      if (current === diskText) break;
      // Deleted: the delete event owns the path now.
      if (current === null) return;
      if (attempt >= SNAPSHOT_FOLD_ATTEMPTS) {
        // Still changing. The doc keeps the remote edits in the meantime, and
        // a later snapshot folds whatever the disk settles on.
        this.log.info('disk keeps changing under the snapshot, retrying later', path);
        this.scheduleSnapshotToDisk(path);
        return;
      }
      // A save. Its base is the text this snapshot was about to write over:
      // the fold above took it into the doc, which is why the write could
      // replace it. For a note without a fold marker yet (a log from before
      // 0.3.2, a cleared IndexedDB) that fold left no base behind, and the save
      // would be folded without one — disk wins, deleting the doc's unwritten
      // remote edits everywhere. Record it, then fold the save three-way.
      if (meta && diskText !== null) await this.markFolded(meta, diskText);
      diskText = current;
    }
    // Update meta BEFORE the write, same as `applyServerUpdateBinary`: the
    // watcher echo of this write must find the file already recorded.
    if (meta) this.recordSnapshotMeta(meta, text, hash);
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
    // Only after the write succeeded: disk and doc now agree on `text`. A base
    // recorded before a failed write would make the next fold read the old
    // disk as local deletions of everything this snapshot was bringing in.
    if (meta) await this.markFolded(meta, text, meta.contentHash);
  }

  /** The note's text on disk, `null` when there is no file. */
  private async readDiskText(path: string): Promise<string | null> {
    return (await this.vault.exists(path)) ? await this.vault.readText(path) : null;
  }

  /** Record `text` (hashed to `hash`) as the file's synced content. */
  private recordSnapshotMeta(meta: IndexedMeta, text: string, hash: string): void {
    meta.contentHash = hash;
    meta.size = new TextEncoder().encode(text).byteLength;
    this.operationLog.setFileMeta(meta);
  }

  // -- Pending queue --------------------------------------------------------

  private queue(
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): void {
    // The fence refuses this too; spelled out because the queue is what the
    // next engine replays without asking.
    this.throwIfStopped();
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
    const result = await flushPendingQueue(this.binding.id, this.operationLog, emit, {
      signal: this.lifetime.signal,
    });
    // A halted drain used to be invisible: the queue simply stopped moving and
    // nothing said so. Surface it — one stuck operation holds back every edit
    // queued behind it.
    if (result.dropped) {
      this.log.warn('dropped a rejected queued operation', {
        opType: result.dropped.opType,
        path: result.dropped.filePath,
        remaining: result.remaining,
      });
    }
    if (result.haltedOn) {
      this.log.warn('offline queue drain halted', {
        opType: result.haltedOn.opType,
        path: result.haltedOn.filePath,
        remaining: result.remaining,
      });
    }
  }

  /**
   * Replay one queued operation.
   *
   * A queued CREATE or binary UPDATE records that a file changed, not its
   * bytes: the replay reads the disk again and sends what is there now. An
   * entry the disk no longer bears out is dropped rather than sent — a CREATE
   * or UPDATE whose file is gone, an UPDATE whose bytes still match the last
   * sync, a DELETE handed over before its stale-delete check whose file is
   * still there. `stop()` hands such entries over (see {@link hold}), and a
   * missing file used to halt the drain on that entry for good.
   *
   * Some entries reach the server twice: the operation a drain had in flight
   * when the engine stopped, and a change `stop()` handed over whose ack was
   * still on the way. Sent again right away, that changes nothing on the
   * server: a CREATE for a path it holds with the same hash is an idempotent
   * replay (and the drain routes a path it already knows through modify), a
   * DELETE of a tombstone and a RENAME to the file's current path are no-ops,
   * a binary UPDATE rewrites the same bytes (and is skipped when the catch-up
   * has already brought them down).
   *
   * Not so after a gap in which a teammate changed the same file: the server
   * applies DELETE and RENAME by file id without comparing clocks. A resent
   * DELETE removes a note the teammate re-created at that path in the meantime
   * (a CREATE revives the tombstone under the same id), and a resent RENAME
   * moves the file back from where the teammate had moved it since. A binary
   * UPDATE is covered by the catch-up that runs first: it brings the newer
   * version down (through the conflict modal), and the replay then finds the
   * disk at the last sync and sends nothing — unless the user keeps their own
   * copy.
   *
   * Resends used to be more frequent: the drain marked a pass sent only at
   * its end, and an ack cut off by the disconnect never came, so a stop
   * resent every operation of the pass. Now it is the one the drain had in
   * flight, plus a live change whose ack was still on the way — without the
   * hand-over, lost whenever the server had not got it. Refusing a stale resend takes a
   * precondition the server checks: the expected source path, or the state
   * the file was deleted in.
   */
  private async replayPending(op: {
    opType: OperationType;
    filePath: string;
    newPath: string | null;
    payload: Record<string, unknown>;
  }): Promise<ReplayOutcome> {
    // A queued op outlives the build that queued it: `state.json` survives the
    // upgrade. Anything the gate refuses today is handled here rather than
    // retried forever — that is how a `data.json` enqueued by an older build
    // would otherwise still reach the server (fixed in 0.3.3).
    if (this.isIgnoredLocalPath(op.filePath)) {
      this.log.warn('dropped a queued operation for an ignored path', {
        opType: op.opType,
        path: op.filePath,
        configDir: this.configDir,
      });
      return { ok: false, retryable: false, error: 'ignored_path' };
    }
    if (op.newPath !== null && this.isIgnoredLocalPath(op.newPath)) {
      // A queued rename INTO an ignored folder is what "move to Obsidian
      // trash" looked like to a build without the gate. Dropping it would
      // resurrect the note: the server still holds it, and the next catch-up
      // writes it back to disk. Send the delete the user actually meant.
      this.log.warn('queued rename into an ignored folder — sending a delete instead', {
        opType: op.opType,
        path: op.filePath,
        newPath: op.newPath,
      });
      await this.handleLocalDelete(op.filePath, 'queue');
      this.throwIfStopped();
      return { ok: true };
    }
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
            await this.handleLocalModify(op.filePath, 'queue');
            this.throwIfStopped();
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
          let inlineData: ArrayBuffer | undefined;
          try {
            // Binary bytes go to the REST staging area; text rides inline.
            inlineData = await this.stageBinaryBlob(fileType, contentHash, data);
          } catch {
            this.throwIfStopped();
            return { ok: false, retryable: true, error: 'blob_staging_failed' };
          }
          this.throwIfStopped();
          const ack = await this.socket.emitFileCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            filePath: op.filePath,
            fileType,
            contentHash,
            size: data.byteLength,
            ...(inlineData !== undefined ? { data: inlineData } : {}),
          });
          this.throwIfStopped();
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
          const fileId = queuedFileId(op.payload);
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          // Deleted (or renamed away) since: a later DELETE or RENAME in the
          // queue carries that. Retrying a read that cannot succeed used to
          // halt the drain on this entry for good, with every edit behind it.
          if (!(await this.vault.exists(op.filePath))) {
            return { ok: false, retryable: false, error: 'local_file_missing' };
          }
          const data = await this.vault.readBinary(op.filePath);
          // Hash the bytes being sent, not the stale enqueue-time snapshot
          // — same reasoning as the CREATE case above.
          const contentHash = await sha256Hex(data);
          // Still the bytes of the last sync — an edit undone, or a change
          // `stop()` handed over before its handler got to compare hashes.
          // Nothing to send; sending would overwrite a newer server version
          // with the old one.
          if (contentHash === this.fileIndex.byId.get(fileId)?.contentHash) return { ok: true };
          try {
            await this.uploadBlob(contentHash, data);
          } catch {
            this.throwIfStopped();
            return { ok: false, retryable: true, error: 'blob_staging_failed' };
          }
          this.throwIfStopped();
          const ack = await this.socket.emitFileUpdateBinary({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            contentHash,
            size: data.byteLength,
          });
          this.throwIfStopped();
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
          // Handed over by `stop()` before the stale-delete check had run
          // (see `holdLocalDelete`): run it now. The event may have been a
          // stray `unlink` of a file that is still there. Only for such an
          // entry — the catch-up that has just run writes every text file
          // the server still holds back to disk, an offline delete included.
          if (op.payload[RECHECK_DELETE] === true && (await this.vault.exists(op.filePath))) {
            return { ok: false, retryable: false, error: 'local_file_present' };
          }
          let fileId = queuedFileId(op.payload);
          // A queued DELETE can carry an empty fileId (the path wasn't indexed
          // when it was enqueued). Resolve it from the now-refreshed index
          // before giving up, and log the drop rather than losing it silently.
          if (!fileId) fileId = this.fileIndex.byPath.get(op.filePath)?.fileId ?? '';
          if (!fileId) {
            this.log.debug(
              'replay DELETE dropped: no fileId (already gone server-side)',
              op.filePath,
            );
            return { ok: false, retryable: false, error: 'no_file_id' };
          }
          const ack = await this.socket.emitFileDelete({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
          });
          this.throwIfStopped();
          if (ack.ok) {
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) this.fileIndex.byPath.delete(meta.relativePath);
            this.fileIndex.byId.delete(fileId);
            this.operationLog.deleteFileMeta(this.binding.id, op.filePath);
            // Release the doc + drop any pending snapshot so a debounced write
            // can't recreate the deleted file (see handleLocalDelete).
            this.snapshotDebouncers.get(op.filePath)?.cancel();
            this.snapshotDebouncers.delete(op.filePath);
            this.forgetFoldState(fileId);
            await this.docManager.release(this.binding.id, op.filePath);
          }
          return ackToOutcome(ack);
        }
        case 'RENAME':
        case 'MOVE': {
          const fileId = queuedFileId(op.payload);
          if (!fileId || !op.newPath) {
            return { ok: false, retryable: false, error: 'missing_target' };
          }
          const newPath = op.newPath;
          const payload = {
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
            newPath,
          };
          const ack =
            op.opType === 'RENAME'
              ? await this.socket.emitFileRename(payload)
              : await this.socket.emitFileMove(payload);
          this.throwIfStopped();
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
      // Stopped mid-replay: the drain ends here and the op stays queued.
      this.throwIfStopped();
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

  /**
   * True once `stop()` has run. Not the same as status `stopped`, which is
   * also where a never-started engine sits (and queues offline edits).
   */
  private get hasStopped(): boolean {
    return this.lifetime.signal.aborted;
  }

  /**
   * End the calling flow if `stop()` ran while it was waiting. Used right
   * after an answer arrives (an ack, a listing, a download, the conflict
   * modal) and first thing in `catch` blocks that would otherwise fall back
   * to something else: queueing, a retry, a fold without a base. The fence
   * refuses those anyway; this makes the flow leave where it resumed.
   */
  private throwIfStopped(): void {
    this.lifetime.signal.throwIfAborted();
  }

  /**
   * Take on a local change: until {@link settle} releases it, `stop()` hands
   * it to the offline queue. A handler holds a change from the moment it
   * accepts the event until the change is acknowledged, queued, or found to
   * be a no-op — the stretch in which `stop()` would otherwise lose it: a
   * transfer it cancels, an ack a disconnected socket never delivers, a disk
   * read it lands on. `null` for a change replayed from the queue, which the
   * queue holds already.
   */
  private hold(
    from: 'watcher',
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): HeldChange;
  private hold(
    from: LocalSource,
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): HeldChange | null;
  private hold(
    from: LocalSource,
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): HeldChange | null {
    // Nothing new is taken on once stopped: `stop()` has already handed over
    // what it holds.
    this.throwIfStopped();
    if (from === 'queue') return null;
    const change: HeldChange = { opType, filePath, newPath, payload };
    this.held.add(change);
    return change;
  }

  private settle(change: HeldChange | null): void {
    if (change) this.held.delete(change);
  }

  /**
   * Queue every change still held, in the order they were taken on. Runs in
   * `stop()` before the fence closes — the engine's last write, not a write
   * after stop. The replay reads the disk again (see {@link replayPending}),
   * so an entry handed over before its handler had read the file is still
   * right, and one the disk has since overtaken is dropped there.
   */
  private handOverHeldChanges(): void {
    for (const change of this.held) {
      try {
        this.operationLog.enqueueOperation(this.binding.id, {
          ...change,
          payload: { ...change.payload },
        });
      } catch (err) {
        this.log.warn('could not queue a change held at stop', {
          opType: change.opType,
          path: change.filePath,
          err,
        });
      }
    }
    this.held.clear();
  }

  /**
   * Run a local phase to the end: the disk and bookkeeping steps of one
   * change that must not be torn apart — a rename's disk moves and its file
   * meta, a download's meta and its write. Checks for `stop()` once, before
   * the first step, and hands the block the dependencies without the fence,
   * so a `stop()` landing in between waits for it instead of cutting it.
   *
   * The block must stay local: no request, no emit, no modal, no
   * `throwIfStopped`, no nested `commitLocal` — any of those would hold up
   * `stop()` or tear the phase after all.
   */
  private async commitLocal<T>(block: (io: LocalIO) => Promise<T>): Promise<T> {
    this.throwIfStopped();
    const run = block(this.local);
    this.localCommits.add(run);
    try {
      return await run;
    } finally {
      this.localCommits.delete(run);
    }
  }

  /**
   * Run a flow nobody awaits. Being cut short by `stop()` is not a failure
   * and ends it silently; any other rejection surfaces as it did before.
   */
  private detach(flow: Promise<void>): void {
    void flow.catch((err: unknown) => {
      if (!this.hasStopped) throw err;
    });
  }

  private bumpClock(): VectorClock {
    this.vectorClock = increment(this.vectorClock, this.clientId);
    return this.vectorClock;
  }

  private persistVectorClock(): void {
    this.operationLog.updateLastVectorClock(this.binding.id, this.vectorClock);
  }

  private setStatus(status: EngineStatus, detail?: string): void {
    // A flow that wakes up after `stop()` has nothing left to report: the
    // engine stays `stopped`.
    if (this.hasStopped && status !== 'stopped') return;
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
 * The `fileId` a queued operation carries. The queue is parsed back from
 * `state.json`, so the field is trusted only as a string: anything else used
 * to go out as `String(value)` — `"[object Object]"` for an object.
 */
function queuedFileId(payload: Record<string, unknown>): string {
  const value = payload['fileId'];
  return typeof value === 'string' ? value : '';
}

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
  // Domain refusals the server states with a machine code: a retry cannot
  // change the answer. `invalid_path` is the path itself being refused
  // (reserved folder, traversal, absolute), `path_is_directory` is a folder
  // sitting where the file should go. Treating either as retryable halted the
  // whole offline queue on every reconnect, silently.
  const permanent =
    error.endsWith('_not_found') ||
    error === 'forbidden' ||
    error === 'invalid_path' ||
    error === 'path_is_directory';
  const retryable = !permanent;
  return { ok: false, retryable, error };
}
