import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { ApiClient, ApiError } from '@/client/api';
import type { ApiFile } from '@/client/types';
import {
  OPERATIONS_CATCHUP,
  SocketClient,
  type Ack,
  type FileCreatePayload,
  type FileDeletePayload,
  type FileEvent as SocketFileEvent,
  type FileUpdateBinaryPayload,
  type ServerLogEntry,
  type ServerOperation,
  type YjsUpdateMessage,
  type YjsDocSnapshot,
  type YjsCatchupBatch,
} from '@/client/socket';
import * as Y from 'yjs';
import { DocManager, type MoveResult, type OpenResult } from '@/crdt/doc-manager';
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
  pathKey,
  type PathRejection,
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

/** How many refused server paths a binding remembers as already reported. */
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
  /**
   * Server paths this binding's engines have already refused at `warn` — see
   * `allowServerPath`. The `EngineManager` hands every engine of a binding the
   * same set, kept while the plugin runs: pausing sync or switching the
   * binding off and on spawns a new engine, and with a set of its own that
   * engine reported every such path at `warn` again. Default: a new set.
   */
  reportedRefusals?: Set<string>;
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
 * A file the server has under a name another file still holds here — see
 * `SyncEngine.waitForName`: renamed there (`rename`), or new to this device
 * (`create`).
 */
type WaitingForName =
  | { kind: 'rename'; fileId: string; path: string }
  | {
      kind: 'create';
      fileId: string;
      path: string;
      fileType: FileType;
      /**
       * Known to be another device's: its broadcast named another client, or
       * came before this device had sent its own create of the name.
       */
      foreign?: boolean;
    };

/**
 * What a create of this device's came to (see `SyncEngine.recordCreateAck`):
 * the id the server gave the file, and whether that is a file of another
 * device's with the same content, which the server gave back instead of
 * making a new one (`merged`).
 */
interface CreatedHere {
  fileId: string;
  merged: boolean;
}

/** What {@link SyncEngine.applyServerOperation} knows of the whole catch-up. */
interface Catchup {
  /** Renames, moves and updates a later one of the same file in the catch-up supersedes. */
  superseded: ReadonlySet<ServerOperation>;
  /** File id → every path the catch-up's renames and moves of it start from. */
  renamedFrom: ReadonlyMap<string, ReadonlySet<string>>;
  /** Operations this device applied from their live broadcasts. */
  appliedLive: ReadonlySet<string>;
}

/** A rename missed while the engine was away — see `renamedWhileAway`. */
interface RenamedWhileAway {
  /** The file as this device last synced it, at the old path. */
  meta: IndexedMeta;
  /** Where the server has it now. */
  to: string;
  /** The content the server has, by the listing. */
  serverHash: string;
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
 * Payload of a queued DELETE: the content hashes this device last knew the
 * file by (see `settleOvertakenQueue`). Local to the queue, like
 * {@link RECHECK_DELETE}.
 */
const LAST_SYNCED = 'lastSynced';

/**
 * Payload of a queued DELETE of a note: its history's state vector when it
 * was deleted, client → clock (see `settleOvertakenQueue`). Local to the
 * queue, like {@link RECHECK_DELETE}.
 */
const DOC_STATE = 'docState';

/** How many paths {@link SyncEngine.caseKey} remembers the key of before it starts over. */
const CASE_KEYS_MAX = 50_000;

/**
 * Payload of a queued CREATE: the content hashes it went out with to a
 * server that may have applied it without its ack reaching this device (the
 * connection dropped, the engine stopped). See `SyncEngine.adoptLandedCreates`.
 * Local to the queue, like {@link RECHECK_DELETE}.
 */
const SENT_HASHES = 'sentHashes';

/**
 * Payload of a queued CREATE whose note was renamed here after it went out
 * (see {@link SENT_HASHES}): the name it went out under. The entry itself is
 * under the note's name now.
 */
const SENT_AT = 'sentAt';

/**
 * How many times one snapshot folds a disk that changed under it before it
 * leaves the write to a later snapshot (see `writeDocSnapshot`).
 */
const SNAPSHOT_FOLD_ATTEMPTS = 3;

/** A note deleted between `exists()` and its read — see `readDiskText`. */
const VANISHED = Symbol('vanished');

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
   * folder would arrive as a rename for a file we know nothing about. Files
   * at a path this client never writes (see `allowServerPath`) are kept here
   * for the same reason.
   */
  private outOfScope = new Map<string, { path: string; fileType: FileType }>();

  /**
   * Server paths already refused at `warn` — see `allowServerPath`. Shared
   * with the binding's earlier and later engines (`SyncEngineDeps`).
   */
  private readonly reportedRefusals: Set<string>;

  /**
   * Files renamed on the server to a name this client never writes while the
   * user is asked what to do with the local copy (see `dropLocalCopy`): id →
   * where the server has the file now.
   */
  private readonly movedAway = new Map<string, string>();

  /**
   * Files renamed while this device was away to a name this client never
   * writes, whose local copy may hold edits the server never got: by id. The
   * index refresh leaves them out of the index and asks about them once the
   * engine is connected (see {@link askAboutRetiredWhileAway}); `state.json`
   * keeps their record meanwhile, so a restart asks again.
   */
  private readonly retiredAway = new Map<string, { meta: IndexedMeta; serverHash: string }>();

  /**
   * Copies of files deleted while this device was away that `initialPush`
   * has not settled yet — checked, removed, or asked about: path → the
   * deleted file's id. A file created again under such a name keeps the copy
   * aside first (see {@link applyServerCreate}).
   */
  private readonly awayCopies = new Map<string, string>();

  /**
   * Files renamed while this device was away whose rename the last file index
   * refresh could not apply — see `applyRenamesWhileAway`. By id; the catch-up
   * leaves their RENAME alone until the next connect.
   */
  private renamesLeft = new Set<string>();

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
   * Snapshots that fired and wait for their path's lock, by path, with how
   * many — see {@link snapshotDue}.
   */
  private readonly snapshotsWaiting = new Map<string, number>();

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

  /**
   * The local-update subscription on each doc, by doc path — see
   * {@link wire}. One per path: wiring a path again replaces it.
   */
  private wired = new Map<string, () => void>();

  /**
   * Files renamed on this device whose RENAME still waits in the offline
   * queue: id → the name the file has here. Until the server has the rename,
   * the queue is what says where they are — see {@link queuedRenames}.
   */
  private renamedHere = new Map<string, string>();

  /**
   * Files this connect's catch-up shows deleted and then created again under
   * their id (the server revives a tombstone under its old id) — see
   * {@link notesRecreated} and {@link checkLineage}.
   */
  private recreated = new Set<string>();

  /** The listing of this connect's index refresh, by id. */
  private lastListing = new Map<string, ApiFile>();

  /**
   * Files of {@link lastListing} deleted since it was taken, by id: here (the
   * delete sent, or queued before the listing) or on the server. A create of
   * this device's the server answers with one of them brought its tombstone
   * back: the file is this device's new one (see {@link knownAsAnothers}).
   */
  private readonly deletedSinceListing = new Set<string>();

  /**
   * Notes whose history here has been checked against the server's in this
   * connect (see {@link checkLineage}), or started anew in it. A teammate's
   * edit to any other note waits for that check (see
   * {@link handleServerYjsUpdate}).
   */
  private readonly lineageChecked = new Set<string>();

  /**
   * Notes whose store held another file's history, by id → that file's id:
   * the history was started anew (see {@link afterDocOpen}), and the copy on
   * disk is still that file's until {@link checkLineage} settles it.
   */
  private readonly foreignHistory = new Map<string, string>();

  /** Path → its {@link pathKey}, for the case scans of the index (see {@link caseKey}). */
  private readonly caseKeys = new Map<string, string>();

  /** Teammates' edits waiting for their note's lineage check, by file id. */
  private readonly liveUpdatesWaiting = new Map<string, YjsUpdateMessage[]>();

  /**
   * Notes the last index refresh put under a name this device has no record
   * of them at (see `indexListedFile`). An unstamped history under that name
   * is not taken for theirs without proof from the server's doc (see
   * {@link checkLineage}).
   */
  private newHere = new Set<string>();

  /**
   * Whether {@link fileIndex} has been built: from `state.json` when the
   * engine starts (see {@link loadIndex}), from the listing on each connect.
   */
  private indexLoaded = false;

  /**
   * Renames this engine is making on disk right now, as `from`/`to` pairs —
   * see {@link renameOnDisk}. Obsidian reports each one as a vault `rename`
   * event before the call returns; that is not the user's rename.
   */
  private readonly renamingOnDisk = new Set<string>();

  /**
   * Files a rename from the server is moving on disk right now, by id, with
   * how many such moves are under way — see {@link moveLocalCopy}.
   */
  private readonly movingHere = new Map<string, number>();

  /**
   * Files renamed on this device whose rename has not been acknowledged or
   * queued yet, by id, with how many such renames are under way. The server
   * applies a teammate's rename that reaches this device meanwhile before
   * this one, so it is not applied here (see {@link handleServerRename}).
   */
  private readonly localRenames = new Map<string, number>();

  /**
   * Attachment uploads on their way to the server, by file id: the content
   * hashes sent and not acknowledged yet. A server that does not send
   * `clientId` broadcasts this device's own upload back to it before the ack;
   * one that names a hash on its way is recognised by it (see
   * {@link handleServerFileEvent}).
   */
  private readonly binaryUploads = new Map<string, string[]>();

  /**
   * How many times each file has been renamed on this device, by id. A
   * server rename waiting for the file's names checks it has not moved: a
   * local rename made since reaches the server after it and wins there.
   */
  private readonly renameCount = new Map<string, number>();

  /**
   * Files deleted on this device, by id, in this engine's lifetime — see
   * {@link refreshFileIndex}.
   */
  private readonly deletedIds = new Set<string>();

  /**
   * Notes created on this device whose `file:create` has been sent and not
   * acknowledged yet, by path, with how many — see {@link emitCreate}. The
   * server broadcasts the create to its sender too, before the ack.
   */
  private readonly ownCreates = new Map<string, number>();

  /** Deletes sent and not acknowledged yet, by file id — see {@link emitDelete}. */
  private readonly ownDeletes = new Map<string, number>();

  /** Whether a broadcast under this device's client id it did not send was logged. */
  private twinReported = false;

  /**
   * Local creates under way, by path, from the event until the file is
   * recorded, queued, or found to be gone — a replay of a queued create
   * included — and renames into a path waiting for such a create (see
   * {@link renameAfterCreate}). Each resolves with what the create came to.
   */
  private readonly creating = new Map<string, Promise<CreatedHere | null>>();

  /**
   * Names of notes created here and renamed before their create was
   * acknowledged (see {@link renameAfterCreate}): the copy is under the new
   * name already.
   */
  private readonly renamedAfterCreate = new Set<string>();

  /**
   * Files the server has under a name another file still holds here, by the
   * name — see {@link waitForName}. Rebuilt on each connect.
   */
  private readonly waitingForName = new Map<string, WaitingForName>();

  /**
   * Notes renamed on this device whose history has not moved to the new
   * name yet, by id, in order — see {@link moveRenamedDoc}. Until it has, the
   * doc is under the first move's old name, and remote updates land there.
   */
  private readonly docMoves = new Map<string, Array<{ from: string; to: string }>>();

  /**
   * Paths vacated by deletes made on this device and sent by this connect's
   * queue drain. The server holds a tombstone there now, and `initialPush`
   * skips a tombstoned path as a deleted file still on disk. Not these: the
   * delete was checked against the disk, so a file there now is a new one —
   * a note saved under the name while the plugin was off — and is uploaded.
   */
  private freedHere = new Set<string>();

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
    this.reportedRefusals = deps.reportedRefusals ?? new Set();
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
    // Before the first connect, which may never come this session.
    this.loadIndex();
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
    for (const off of this.wired.values()) off();
    this.wired.clear();
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
   * path. Returns `null` if the engine doesn't know about the file: it is
   * outside the binding's `localFolder`, or this device has never synced it.
   *
   * Used by the History view (Stage 14) to talk to the right file
   * without reaching into engine internals.
   */
  getFileIdForPath(vaultPath: string): string | null {
    this.loadIndex();
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
    // An engine the manager has not started yet takes edits too.
    this.loadIndex();
    // On a disk that takes names differing in case for one file, Obsidian
    // may list a file under another case than the one this device records it
    // by (see `spelledHere`): the events are about that file.
    switch (event.type) {
      case 'create':
        await this.handleLocalCreate(this.spelledHere(event.path));
        break;
      case 'modify':
        await this.handleLocalModify(this.spelledHere(event.path));
        break;
      case 'delete':
        if (event.isFolder) await this.handleLocalFolderDelete(event.path);
        else await this.handleLocalDelete(this.spelledHere(event.path));
        break;
      case 'rename': {
        const oldPath = this.spelledHere(event.oldPath);
        // The disk now spells the file the way this device records it.
        if (oldPath === event.newPath) break;
        await this.handleLocalRename(oldPath, event.newPath);
        break;
      }
    }
  }

  /** Whether the disk takes names that differ only in case for one file (Windows, macOS). */
  private caseInsensitive(): boolean {
    return this.local.vault.isCaseInsensitive?.() === true;
  }

  /**
   * {@link pathKey} of `path`, remembered. The case scans of the index
   * (`nameHolder`, `spelledHere`, the listing's `caseRival`) compare a name
   * with every indexed one; folding each of them every time, the listing of a
   * vault of a thousand notes blocked Obsidian for over half a second at each
   * connect on Windows and macOS, and a vault five times larger for a quarter
   * of a minute.
   */
  private caseKey(path: string): string {
    let key = this.caseKeys.get(path);
    if (key === undefined) {
      if (this.caseKeys.size >= CASE_KEYS_MAX) this.caseKeys.clear();
      key = pathKey(path);
      this.caseKeys.set(path, key);
    }
    return key;
  }

  /**
   * The name this device records the file at `path` by. On a disk that takes
   * names differing only in case for one file, a file can be on disk under
   * another case than its name on the server: a teammate renamed its folder
   * only in case, and the rename here moved the file into the folder the disk
   * already had under the old case. Obsidian lists it so at the next start.
   * Taken for a file of its own, it was uploaded as a new note — every note
   * of the folder, a duplicate for the whole team — and each edit of it went
   * to the duplicate. `path` itself when it is recorded, or when no one
   * recorded name, or more than one, is `path` in another case.
   */
  private spelledHere(path: string): string {
    if (this.fileIndex.byPath.has(path) || !this.caseInsensitive()) return path;
    const key = this.caseKey(path);
    let found: string | undefined;
    for (const indexed of this.fileIndex.byPath.keys()) {
      if (this.caseKey(indexed) !== key) continue;
      if (found !== undefined) return path;
      found = indexed;
    }
    return found ?? path;
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
      this.freedHere.clear();
      // The server's docs may have changed while this device was away: each
      // note's history is checked again (see `checkLineage`).
      this.lineageChecked.clear();
      // A broadcast from before the disconnect never arrives now, and neither
      // does the ack of an operation sent on the old connection: left counted
      // as on its way, a rename kept every teammate's rename of the file from
      // applying, and a create or delete took a teammate's for this device's.
      this.localRenames.clear();
      this.ownCreates.clear();
      this.ownDeletes.clear();
      // Arm the streamed-catch-up completion signal before the join so a fast
      // server stream can't resolve before we're waiting on it.
      const catchupDone = new Promise<void>((resolve) => {
        this.catchupResolve = resolve;
      });

      // Fire `project:join` synchronously (no await before it) so tests can
      // observe the emit immediately and the server starts streaming ASAP;
      // refresh the file index in parallel. `streamYjs: true` asks the server
      // to deliver the catch-up as batched `yjs:catchup` events.
      //
      // Operations applied live before this join: the server's catch-up comes
      // after each of them (see `forgetAppliedLive` below).
      const liveBeforeJoin = this.operationLog.appliedLiveIds(this.binding.id);
      const joinPromise = this.socket.joinProject(this.binding.projectId, this.vectorClock, true);
      const filesPromise = this.refreshFileIndex();
      const [result] = await Promise.all([joinPromise, filesPromise]);
      this.throwIfStopped();
      // Operations this device applied live: the catch-up returns them again.
      const appliedLive = this.operationLog.appliedLiveIds(this.binding.id);
      // Before any catch-up doc is applied: see `checkLineage`.
      this.recreated = notesRecreated(result.ok ? result.operations : [], appliedLive);
      // Before any catch-up doc or operation lands: the files the queue's
      // operations were made to may be gone from under their ids.
      await this.settleOvertakenQueue();
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
      const catchup: Catchup = {
        superseded: supersededOps(result.operations),
        renamedFrom: renameSources(result.operations),
        appliedLive,
      };
      for (const op of result.operations) {
        await this.applyServerOperation(op, catchup);
        this.throwIfStopped();
      }
      // A catch-up that may have left operations out: the server's window of
      // the journal's first rows, or one cut short. Attachments are checked
      // against the listing instead (see `reconcileAttachments`).
      if (result.operationsCatchup !== OPERATIONS_CATCHUP || result.operationsTruncated === true) {
        await this.reconcileAttachments();
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
      // `wire`, а тот через `onLocalUpdate` создаёт документ:
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
          this.wire(meta.fileId, meta.relativePath);
        }
      }
      this.cleanups.push(
        this.docManager.onDocAcquired(this.binding.id, (filePath) => {
          const meta = this.fileIndex.byPath.get(filePath);
          if (meta?.fileType === 'TEXT') this.wire(meta.fileId, filePath);
        }),
      );

      this.persistVectorClock();
      // What the clock took in, no catch-up returns again: the operations this
      // one returned, and after a whole one, every operation applied live
      // before the join — the server's catch-up came after them. Not one
      // applied live since, while the join and the listing were on their way:
      // the server may have made it after its catch-up, and the next one
      // returns it. Forgotten, it was taken for one made while this device was
      // away (a note deleted and made again: an edit made to it offline went
      // into a conflict copy, a rename or delete of it was not sent).
      const seen = new Set(result.operations.map((op) => op.id));
      if (result.operationsCatchup === OPERATIONS_CATCHUP && result.operationsTruncated !== true) {
        for (const id of liveBeforeJoin) seen.add(id);
      }
      this.operationLog.forgetAppliedLive(this.binding.id, seen);
      this.setStatus('connected');

      // Reconnect catch-up tail, kicked off in the background so the
      // `connected` status doesn't wait on every queued upload. Ordering
      // inside is load-bearing — see `drainThenInitialPush`.
      this.detach(this.drainThenInitialPush());
    } catch (err) {
      this.catchupResolve = null;
      // Cut short by `stop()` — not a sync failure.
      if (this.hasStopped) return;
      // Cut short by the connection dropping: the status says so already, and
      // the next connect starts over.
      if (!this.socketLink.isConnected()) return;
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
    await this.openDoc(meta);
    // Deleted while the store loaded. (Renamed, it took the doc along, and
    // `meta` names the new path.)
    if (this.fileIndex.byId.get(snap.fileId) !== meta) return;
    const update = Uint8Array.from(snap.sync1);
    await this.withPathLock(meta.relativePath, async () => {
      await this.checkLineage(meta, this.docPathOf(meta), update);
      await this.noteDiskAgreement(meta);
    });
    this.rememberBaseBeforeRemote(meta);
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
  private pushMissingOps(
    meta: IndexedMeta,
    serverStateVector: number[] | undefined,
    docPath = meta.relativePath,
  ): void {
    if (!serverStateVector || serverStateVector.length === 0) return;
    const missing = this.docManager.encodeStateAsUpdate(
      this.binding.id,
      docPath,
      Uint8Array.from(serverStateVector),
    );
    if (missing.length > 2) {
      this.socket
        .emitYjsUpdate({ projectId: this.binding.projectId, fileId: meta.fileId, update: missing })
        .catch(() => undefined);
    }
  }

  /**
   * Wait for a note's doc to load, and make sure the history in it is this
   * note's (see `DocManager.open`). Every flow that folds into, writes out or
   * pushes back a doc comes through here first.
   *
   * A history found to be another file's is started anew (see
   * {@link afterDocOpen}).
   */
  private async openDoc(meta: IndexedMeta): Promise<void> {
    // A rename may move the file while its doc loads: open it where it is now.
    for (let tries = 0; tries < 3; tries++) {
      const path = meta.relativePath;
      this.afterDocOpen(meta, path, await this.docManager.open(this.binding.id, path, meta.fileId));
      if (meta.relativePath === path) return;
    }
  }

  /**
   * A note's doc was found holding a history that is not the note's, and
   * started anew (see `DocManager.open`). The note's fold marker is set back
   * to its last synced content (see {@link forgetFoldedEdits}): what it named
   * as folded may have gone with that doc, and the next fold merges the disk
   * three-way instead of taking it as folded already. The other file's marker
   * stays: that history is a leftover, and the file's live doc is under its
   * own name (see {@link afterDocMove}).
   */
  private afterDocOpen(meta: IndexedMeta, path: string, opened: OpenResult): void {
    if (!opened.discarded) return;
    this.log.warn('a note’s offline history belonged to another file; starting it anew', {
      path,
      fileId: meta.fileId,
      owner: opened.owner,
    });
    this.forgetFoldedEdits(this.operationLog, meta.fileId);
    if (opened.owner !== null) this.foreignHistory.set(meta.fileId, opened.owner);
  }

  /**
   * Before the server's doc of a note (`server`, its full state) is merged
   * into the note's doc at `docPath`: check that the history there descends
   * from the server's (see `DocManager.verifyLineage`). One that does not is
   * deleted, and the note starts from the server's doc. Merged, the note's
   * text went to disk and back to the server twice, for the whole team.
   *
   * The id does not tell. A server before the fix that continues histories
   * revives a deleted note under its old id with a new history — a note
   * deleted and created again under its name ("Untitled", a template, a note
   * restored from the trash, `write_note` through MCP) while this device was
   * away. A project seeded again, and a doc the server seeds anew from the
   * note's file, hold a new history under the id as well. And a build before
   * 0.3.8 left the history of a note renamed or deleted away under its name,
   * without a stamp: the next note under the name took it for its own. Only
   * the histories themselves tell whether they are one.
   *
   * A note deleted and created again under its id since this device last
   * synced it, as the catch-up shows (see {@link notesRecreated}), is a new
   * note whatever its history: what this device did to the deleted one and
   * never sent is not merged into it, on a server that continues the history
   * on revival either.
   *
   * The copy on disk is then the old history's (see {@link setAsideOldCopy}),
   * and it is settled before the history goes. The other way round, a stop
   * in between — Pause sync, a reload, Obsidian closed while the server's
   * version history was looked up — left the disk with edits the server
   * never got, a fold marker saying they were folded, and no history holding
   * them: the next start wrote the server's text over them.
   *
   * Callers hold the note's path lock.
   */
  private async checkLineage(
    meta: IndexedMeta,
    docPath: string,
    server: Uint8Array,
  ): Promise<void> {
    // The store held another file's history, now gone: for a note this
    // device has no record of, the copy on disk is that history's too — a
    // note renamed away or deleted under the name while this device was
    // away, with `state.json` lost since. Left alone, the empty history took
    // the server's text, and the next fold, without a base, put the copy's
    // text over it for everyone.
    const owner = this.foreignHistory.get(meta.fileId);
    if (owner !== undefined) {
      this.foreignHistory.delete(meta.fileId);
      if (this.newHere.has(meta.fileId)) await this.setAsideOldCopy(meta, textOf(server), owner);
    }
    const found = await this.docManager.lineageOf(this.binding.id, docPath, meta.fileId, server, {
      replaced: this.recreated.has(meta.fileId),
      recorded: !this.newHere.has(meta.fileId),
      // Whether the server had text for the note when this device last synced it.
      hadText: meta.size > 0,
    });
    this.throwIfStopped();
    if (found === null) return;
    this.lineageChecked.add(meta.fileId);
    if (found.related) return;
    this.log.warn('a note’s offline history is not the server’s; starting it from the server', {
      path: meta.relativePath,
      fileId: meta.fileId,
      owner: found.owner,
    });
    this.foldBases.delete(meta.fileId);
    const serverText = textOf(server);
    await this.setAsideOldCopy(meta, serverText);
    await this.docManager.startOver(this.binding.id, docPath, meta.fileId);
    // The size recorded is the old history's. It tells whether the server has
    // content for the note, and a note emptied that way waited for content
    // forever: its snapshot never wrote the empty text over the old one. Moved
    // only now: a stop before the history is gone must find the old size, or
    // the next start took an empty server doc for this note's own.
    const size = new TextEncoder().encode(serverText).byteLength;
    if (meta.size !== size) {
      meta.size = size;
      if (this.fileIndex.byId.get(meta.fileId) === meta) this.operationLog.setFileMeta(meta);
    }
  }

  /**
   * The copy on disk of a note whose local history was not the server's (see
   * {@link checkLineage}). It belongs to that history: the note deleted and
   * created again, the project seeded again.
   *
   * When the server had it — its text now, the last content synced here, or a
   * version in its history — nothing of it is lost: it is marked as folded,
   * and the snapshot that follows writes the server's text over it.
   *
   * Otherwise it holds edits that never reached the server. Made to the very
   * text the server's doc holds — the note's fold marker names it, as after a
   * project seeded again with the same texts — they are folded in three-way,
   * as any save is. Made to another text, folded into the new note they would
   * replace its text for everyone, or scatter pieces of the old note over it:
   * the copy is kept next to the note instead, under a conflict name, the way
   * `keep-both` keeps a file (the next connect's first upload sends it).
   */
  private async setAsideOldCopy(
    meta: IndexedMeta,
    serverText: string,
    owner?: string,
  ): Promise<void> {
    const path = meta.relativePath;
    const disk = await this.readDiskText(path);
    if (typeof disk !== 'string') return;
    const hash = await sha256Hex(disk);
    const serverHad =
      disk === serverText ||
      hash === meta.contentHash ||
      (await this.serverHadVersion(meta.fileId, hash)) ||
      // The file the history was, when it is another one (`owner`): the copy
      // is its text, now or in its version history.
      (owner !== undefined &&
        owner !== meta.fileId &&
        (this.lastListing.get(owner)?.contentHash === hash ||
          (await this.serverHadVersion(owner, hash))));
    this.throwIfStopped();
    if (serverHad) {
      await this.markFolded(meta, disk, hash);
      return;
    }
    if (meta.foldedHash !== undefined && meta.foldedHash === (await sha256Hex(serverText))) return;
    this.forgetFoldedEdits(this.operationLog, meta.fileId);
    await this.commitLocal(async (io) => {
      // Renamed or deleted meanwhile: its own events own the file.
      if (this.fileIndex.byId.get(meta.fileId) !== meta || meta.relativePath !== path) return;
      if (!(await io.vault.exists(path))) return;
      const aside = buildConflictPath(path, this.now());
      this.log.warn('a note’s copy held edits of a history the server no longer has; kept aside', {
        path,
        aside,
      });
      io.echo.mark(path, ECHO_COUNT_RENAME);
      io.echo.mark(aside, ECHO_COUNT_RENAME);
      await io.vault.ensureParentFolder(aside);
      await this.renameOnDisk(io, path, aside);
    });
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
    try {
      await this.initialPush();
    } finally {
      await this.askAboutRetiredWhileAway();
    }
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
    const tombstones = await this.fetchServerTombstones();
    this.throwIfStopped();
    if (tombstones === null) {
      // Couldn't confirm the server's tombstones. Don't risk re-uploading a
      // deleted-but-still-on-disk file — after catch-up merges the delete
      // clock, the server's causal guard can't stop the resurrection. Defer
      // the whole pass; the next reconnect / a live watcher CREATE retries the
      // genuinely-new files.
      this.log.debug('initialPush: tombstone lookup failed; deferring upload pass');
      return;
    }
    const deletedAway = this.deletedWhileAway(tombstones.ids, pending);
    // Copies the server had go first, without a question — before anything
    // here waits: the list is not looked at again. Acted on after the uploads
    // and a question about another copy, it deleted a note created again
    // under the name meanwhile, and the first snapshot of that note had
    // folded the stale copy into it.
    const asks: Array<{ record: FileMeta; serverHash: string }> = [];
    for (const [path, away] of deletedAway) this.awayCopies.set(path, away.record.serverFileId);
    try {
      for (const away of deletedAway.values()) {
        this.throwIfStopped();
        try {
          if ((await this.dropDeletedWhileAway(away.record, away.serverHash, false)) === 'ask') {
            asks.push(away);
          }
        } catch {
          this.throwIfStopped();
          // Left as it is: the next connect finds the record again.
        }
      }
      await this.uploadNewFiles(paths, pending, tombstones.paths, deletedAway);
      for (const away of asks) {
        this.throwIfStopped();
        try {
          await this.dropDeletedWhileAway(away.record, away.serverHash, true);
        } catch {
          this.throwIfStopped();
          // Left as it is: the next connect finds the record again.
        }
      }
    } finally {
      for (const [path, away] of deletedAway) {
        if (this.awayCopies.get(path) === away.record.serverFileId) this.awayCopies.delete(path);
      }
    }
  }

  /** The upload pass of {@link initialPush}. */
  private async uploadNewFiles(
    paths: readonly string[],
    pending: ReadonlySet<string>,
    tombstoned: ReadonlySet<string>,
    deletedAway: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    for (const path of paths) {
      this.throwIfStopped();
      // Watcher events are filtered upstream, but this pass walks the raw
      // vault listing — without the same filter it uploads throw-away
      // artifacts (e.g. Obsidian's orphaned `*.tmp.<pid>.<hex>` files).
      if (this.isIgnoredLocalPath(path)) continue;
      // Or a recorded file under another case (see `spelledHere`).
      if (this.fileIndex.byPath.has(this.spelledHere(path))) continue;
      if (pending.has(path)) continue;
      // Deleted on the server while this device was away: removed, or asked
      // about, not uploaded again.
      if (deletedAway.has(path)) continue;
      if (tombstoned.has(path) && !this.freedHere.has(path)) {
        this.log.debug('initialPush: skipping server-tombstoned path', path);
        continue;
      }
      // A rename from the server may be moving a file into this name right
      // now: its disk step comes before its records, and the file found
      // there in between was uploaded as a new one.
      await this.withPathLock(path, () => Promise.resolve());
      this.throwIfStopped();
      if (this.fileIndex.byPath.has(this.spelledHere(path))) continue;
      try {
        await this.handleLocalCreate(path);
      } catch {
        this.throwIfStopped();
        // Per-file failures are swallowed — the watcher / next reconnect
        // will surface them again.
      }
    }
  }

  /** Whether `path` holds the copy of a file waiting for its question (see {@link retiredAway}). */
  private isRetiredCopy(path: string): boolean {
    for (const { meta } of this.retiredAway.values()) if (meta.relativePath === path) return true;
    return false;
  }

  /**
   * Local copies of files the server deleted while this device was away, by
   * path: `state.json` has them under an id the server holds as a tombstone,
   * and nothing has them in the index.
   *
   * The catch-up misses such a file: it is not in the listing, so its DELETE
   * finds nothing to apply to. Renamed before it was deleted, its tombstone
   * is under the new name, and `initialPush` uploaded the copy under the old
   * one as a new file — the deleted note came back for the whole team. Not
   * renamed, it stayed on disk, never synced again.
   */
  private deletedWhileAway(
    deleted: ReadonlyMap<string, string>,
    pending: ReadonlySet<string>,
  ): Map<string, { record: FileMeta; serverHash: string }> {
    const out = new Map<string, { record: FileMeta; serverHash: string }>();
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      const id = record.serverFileId;
      const serverHash = id === '' ? undefined : deleted.get(id);
      if (serverHash === undefined || this.fileIndex.byId.has(id)) continue;
      const path = record.relativePath;
      if (this.fileIndex.byPath.has(path) || pending.has(path) || !this.isLocalName(path)) {
        continue;
      }
      out.set(path, { record, serverHash });
    }
    return out;
  }

  /**
   * Apply the delete of {@link deletedWhileAway} to the local copy: removed
   * when the server had it, asked about first when it may hold edits the
   * server never got — any change since the last sync, a fold into the doc
   * included: the catch-up pushed nothing back for a file it did not know.
   *
   * The server had it when the copy is its last content (`serverHash`, from
   * the tombstone) or, for a note, one in its version history. A note's
   * `contentHash` moves only when a snapshot writes the file, so a note once
   * edited on this device differs from it for good, and every such note a
   * teammate deleted meanwhile used to ask, one dialog after another, about
   * edits the server had long had.
   *
   * `ask: false` leaves a copy the user must be asked about as it is and
   * returns `'ask'`. A file indexed under the copy's name or id since owns
   * the copy (see `dropLocalCopy`).
   */
  private async dropDeletedWhileAway(
    record: FileMeta,
    serverHash: string,
    ask: boolean,
  ): Promise<'done' | 'ask'> {
    const path = record.relativePath;
    if (ask) {
      this.log.info('asking about the copy of a file deleted while this device was away', { path });
    } else {
      this.log.info('removing the local copy of a file deleted while this device was away', {
        path,
      });
    }
    const serverHad = await this.serverHadCopy(record, serverHash);
    return this.dropLocalCopy({ ...record, fileId: record.serverFileId }, null, {
      pushedBack: false,
      ask,
      away: true,
      ...(serverHad !== null ? { serverHad } : {}),
    });
  }

  /**
   * Vault paths and ids the server currently holds as tombstones
   * (soft-deleted). Used by `initialPush` to avoid resurrecting an
   * intentionally-deleted file that is still on disk. Returns `null` on error
   * (distinct from an empty set) so the caller can fail CLOSED — a failed
   * lookup must not silently re-upload deleted files.
   */
  private async fetchServerTombstones(): Promise<{
    paths: Set<string>;
    /** Id → the content the server last had. */
    ids: Map<string, string>;
  } | null> {
    try {
      const files = await this.api.getProjectFiles(this.binding.projectId, {
        includeDeleted: true,
      });
      const deleted = files.filter((f) => f.deletedAt !== null);
      return {
        paths: new Set(deleted.map((f) => f.path)),
        ids: new Map(deleted.map((f) => [f.id, f.contentHash])),
      };
    } catch {
      this.throwIfStopped();
      return null;
    }
  }

  /**
   * Build the file index from `state.json`, once, before the engine has
   * connected: the files this device synced, under the names they have here
   * — `state.json` follows every rename and delete made on this device.
   * {@link refreshFileIndex} rebuilds it from the server listing on each
   * connect.
   *
   * The index used to come from the listing only. A session that started
   * without network — Obsidian opened on a plane, or Resume sync while
   * offline — never had one: deleting a synced note queued nothing, and the
   * catch-up wrote it back on landing; renaming one queued a rename without
   * the file id, which the drain dropped, and the note was uploaded again
   * under its new name next to the old one.
   *
   * Only records with a server id and a name this binding syncs. A file
   * recorded twice (a step aside cut short, a record a build before 0.3.8
   * left under the old name of a renamed file) is indexed where the offline
   * queue says it is, or else under the first record. A file whose delete is
   * queued is left out, as `refreshFileIndex` leaves it out.
   */
  private loadIndex(): void {
    if (this.indexLoaded || this.hasStopped) return;
    this.indexLoaded = true;
    const deleted = this.queuedDeletes();
    const here = this.queuedRenames(deleted);
    const byPath = new Map<string, IndexedMeta>();
    const byId = new Map<string, IndexedMeta>();
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      const id = record.serverFileId;
      if (id === '' || deleted.has(id) || !this.isLocalName(record.relativePath)) continue;
      const other = byId.get(id);
      if (other !== undefined) {
        if (here.get(id) !== record.relativePath) continue;
        byPath.delete(other.relativePath);
      }
      const meta: IndexedMeta = { ...record, fileId: id };
      byPath.set(record.relativePath, meta);
      byId.set(id, meta);
    }
    this.fileIndex = { byPath, byId };
  }

  private async refreshFileIndex(): Promise<void> {
    const renamesBefore = new Map(this.renameCount);
    const deletesBefore = new Set(this.deletedIds);
    const listed = await this.api.getProjectFiles(this.binding.projectId);
    // A listing that lands after `stop()` must not rewrite the log's file meta.
    this.throwIfStopped();
    this.lastListing = new Map(listed.map((f) => [f.id, f]));
    this.deletedSinceListing.clear();
    // Before anything reads the queue: a create that reached the server
    // without its ack is this device's file.
    this.adoptLandedCreates(listed);
    // A chain of renames back to where it started is no rename at all: read
    // as one, it "won" over a teammate's rename of the note, which was then
    // skipped — and the drain sent nothing (see `collapseQueuedRenames`).
    this.collapseQueuedRenames();
    // Deleted here while offline: gone, as far as this device is concerned.
    const deletedHere = this.queuedDeletes();
    await this.forgetQueuedDeletes(deletedHere);
    // Deleted here while the listing was on its way: sent at once, after the
    // listing was taken. Indexed again from it, the note was written back to
    // disk by the catch-up, and stayed there, never synced again.
    for (const fileId of this.deletedIds) if (!deletesBefore.has(fileId)) deletedHere.add(fileId);
    for (const fileId of deletedHere) this.deletedSinceListing.add(fileId);
    const files = listed.filter((f) => !deletedHere.has(f.id));
    // Renamed here while offline: the queue is what says where these are.
    const here = this.queuedRenames(deletedHere);
    // Renamed here while the listing was on its way: the socket is up, so the
    // rename went out at once, after the listing was taken. Taken for a
    // teammate's rename back to the old name, it was undone on disk.
    for (const [fileId, count] of this.renameCount) {
      if (renamesBefore.get(fileId) === count || deletedHere.has(fileId)) continue;
      const at = this.fileIndex.byId.get(fileId)?.relativePath;
      if (at !== undefined && this.isLocalName(at)) here.set(fileId, at);
    }
    this.renamedHere = here;
    const away = this.renamedWhileAway(files, here);
    this.renamesLeft.clear();
    this.retiredAway.clear();
    this.waitingForName.clear();
    const occupied = await this.clearStaleCopies(files, away, here);
    this.outOfScope.clear();
    this.newHere.clear();
    // Names our files took here: a file the listing has there is not indexed
    // over ours (see `queuedRenames`).
    const takenHere = new Set(here.values());
    // Names of files created here while offline, not sent yet: a file the
    // listing has there that this device has no record of is a teammate's,
    // made meanwhile, and the copy here is not its (see `recordCreateAck`).
    const createdHere = new Set(
      this.operationLog
        .dequeueOperations(this.binding.id)
        .filter((op) => op.opType === 'CREATE')
        .map((op) => op.filePath),
    );
    const renamed: ApiFile[] = [];
    // Old paths of the files renamed while away: whatever the listing shows
    // there now is indexed once our copy has moved out (see `deferred`).
    const vacating = new Set([...away.values()].map((move) => move.meta.relativePath));
    // Names more than one file below may be indexed under in some case: only
    // under those can a listed file meet another one (see `caseRival`).
    const sharedKeys = this.sharedCaseKeys([
      ...files.map((f) => f.path),
      ...[...away.values()].map((move) => move.meta.relativePath),
    ]);
    const deferred: ApiFile[] = [];
    const byPath = new Map<string, FileMeta & { fileId: string }>();
    const byId = new Map<string, FileMeta & { fileId: string }>();
    for (const f of files) {
      const local = here.get(f.id);
      if (local !== undefined && local !== f.path && this.isLocalName(local)) {
        // Indexed under the name it has here, below.
        renamed.push(f);
        continue;
      }
      const moved = away.get(f.id);
      if (moved) {
        // Indexed where our copy still is, as this device last synced it; the
        // rename is applied below, once the index is complete.
        byPath.set(moved.meta.relativePath, moved.meta);
        byId.set(f.id, moved.meta);
        continue;
      }
      // Throw-away artifacts that an older client uploaded (e.g. Obsidian's
      // `*.tmp.<pid>.<hex>` atomic-write leftovers) must stay invisible —
      // indexing them would let server events materialise them on disk. The
      // binding itself is checked separately, just below.
      if (!this.allowServerPath(f.path, 'file index', { requireBinding: false })) {
        // Drop the stale mirror as well: a path we now refuse was written to
        // `state.json` by an older build and would otherwise linger there.
        this.operationLog.deleteFileMeta(this.binding.id, f.path);
        // Known by id all the same, like a file outside the binding: renamed
        // to a name we sync later, it arrives as a file we can adopt.
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        continue;
      }
      if (!isInBinding(f.path, this.binding.localFolder)) {
        // Someone else's folder inside the same project. Remembered by id
        // only — see `outOfScope`.
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        this.operationLog.deleteFileMeta(this.binding.id, f.path);
        continue;
      }
      if (vacating.has(f.path)) {
        // The copy on disk there is still the one of the file that moved
        // away. Indexed now, this file would take over its meta and its
        // disk: the fold would push our old note's text into the new one.
        deferred.push(f);
        continue;
      }
      if (occupied.has(f.path)) {
        // Another file's copy we could not read is still there. Left for the
        // next connect, known by id meanwhile.
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        continue;
      }
      const createdHereFirst =
        createdHere.has(f.path) &&
        this.operationLog.getFileMeta(this.binding.id, f.path)?.serverFileId !== f.id;
      if ((takenHere.has(f.path) && local !== f.path) || createdHereFirst) {
        // Our own file took the name here — renamed or created — and has not
        // told the server yet, which stores it under a conflict name when it
        // does: this file comes in once ours has moved there (see
        // `waitForName`). Known by id meanwhile. Indexed now, it took our copy
        // for its own, and the fold sent our text into it for everyone.
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        this.waitingForName.set(f.path, {
          kind: 'create',
          fileId: f.id,
          path: f.path,
          fileType: f.fileType,
        });
        continue;
      }
      // On a disk that takes names differing only in case for one file, one
      // file per such name: the one this device has there (see `nameHolder`).
      const rival = this.caseRival(f, byPath, sharedKeys);
      if (rival !== undefined) {
        // The one indexed first gives way when this device has no record of
        // it and has one of `f` under its name.
        const yields = this.newHere.has(rival.fileId) && this.recordedAt(f.id, f.path);
        const waiting = yields
          ? { fileId: rival.fileId, path: rival.relativePath, fileType: rival.fileType }
          : { fileId: f.id, path: f.path, fileType: f.fileType };
        if (yields) {
          byPath.delete(rival.relativePath);
          byId.delete(rival.fileId);
          this.newHere.delete(rival.fileId);
          // Mirrored when it was indexed: the next connect would take it for
          // this device's copy.
          this.forgetRecord(this.operationLog, rival.fileId, rival.relativePath);
        }
        this.log.info('a listed name is another file’s here in another case; it waits', waiting);
        this.outOfScope.set(waiting.fileId, { path: waiting.path, fileType: waiting.fileType });
        this.waitingForName.set(waiting.path, { kind: 'create', ...waiting });
        if (!yields) continue;
      }
      this.indexListedFile(f, byPath, byId);
    }
    this.fileIndex = { byPath, byId };
    this.indexLoaded = true;
    for (const f of renamed) await this.indexRenamedHere(f, here.get(f.id) ?? f.path);
    await this.applyRenamesWhileAway(away);
    for (const f of deferred) {
      // A rename that could not be applied keeps its old path — and with it
      // the file there, until the next connect tries again. So does a copy
      // waiting for its question (see `retiredAway`).
      if (this.fileIndex.byPath.has(f.path) || this.isRetiredCopy(f.path)) {
        this.outOfScope.set(f.id, { path: f.path, fileType: f.fileType });
        continue;
      }
      this.indexListedFile(f, this.fileIndex.byPath, this.fileIndex.byId);
    }
  }

  /**
   * On a disk that takes names differing only in case for one file: the file
   * of `byPath` under the name of listed file `f` in another case. `shared`:
   * see {@link sharedCaseKeys}; a name outside it has no such file, and the
   * index is not scanned for it — for every listed file, that cost the time
   * of a scan per name in the vault.
   */
  private caseRival(
    f: ApiFile,
    byPath: ReadonlyMap<string, IndexedMeta>,
    shared: ReadonlySet<string>,
  ): IndexedMeta | undefined {
    if (!this.caseInsensitive()) return undefined;
    const key = this.caseKey(f.path);
    if (!shared.has(key)) return undefined;
    for (const [path, meta] of byPath) {
      if (path !== f.path && this.caseKey(path) === key && meta.fileId !== f.id) return meta;
    }
    return undefined;
  }

  /**
   * On a disk that takes names differing only in case for one file: the
   * {@link pathKey}s two or more of `paths` share, spelled differently. Empty
   * on any other disk.
   */
  private sharedCaseKeys(paths: readonly string[]): Set<string> {
    const shared = new Set<string>();
    if (!this.caseInsensitive()) return shared;
    const first = new Map<string, string>();
    for (const path of paths) {
      const key = this.caseKey(path);
      const seen = first.get(key);
      if (seen === undefined) first.set(key, path);
      else if (seen !== path) shared.add(key);
    }
    return shared;
  }

  /** Whether `state.json` has file `fileId` under `path`: the copy there is its. */
  private recordedAt(fileId: string, path: string): boolean {
    return this.operationLog.getFileMeta(this.binding.id, path)?.serverFileId === fileId;
  }

  /**
   * Queued creates that reached the server without their ack reaching this
   * device (see {@link SENT_HASHES}): the listing has a file under the name
   * one went out under, with the content it went out with. That file is this
   * device's note, and is recorded as such — at the name the note has here,
   * with a rename queued from the name it went out under when it was renamed
   * since (see {@link followQueuedCreate}). The queued creates then go out as
   * saves of it.
   *
   * Taken for another device's, it waited for a name this device held (see
   * `waitForName`), and the queued create went out again: with an edit made
   * since, as a conflict copy of the note for the whole team; renamed since,
   * as a second note under the new name.
   */
  private adoptLandedCreates(listed: readonly ApiFile[]): void {
    const recorded = new Set(
      this.operationLog.listFileMeta(this.binding.id).map((meta) => meta.serverFileId),
    );
    for (const op of this.operationLog.dequeueOperations(this.binding.id)) {
      if (op.opType !== 'CREATE') continue;
      const hashes = sentHashes(op.payload);
      if (hashes.length === 0) continue;
      const sentAt = typeof op.payload[SENT_AT] === 'string' ? op.payload[SENT_AT] : op.filePath;
      const f = listed.find((file) => file.path === sentAt && hashes.includes(file.contentHash));
      if (f === undefined || recorded.has(f.id)) continue;
      const local = op.filePath;
      if (!this.isLocalName(local) || this.operationLog.getFileMeta(this.binding.id, local)) {
        continue;
      }
      this.log.info('a create sent from here reached the server before its ack was lost', {
        path: local,
        sentAt,
        fileId: f.id,
      });
      recorded.add(f.id);
      // What it went out with is what the server seeded the file from: the
      // base for the edits made since.
      this.operationLog.setFileMeta({
        bindingId: this.binding.id,
        relativePath: local,
        serverFileId: f.id,
        contentHash: f.contentHash,
        size: f.size,
        fileType: f.fileType,
        lastSyncedAt: Date.now(),
        ...(f.fileType === 'TEXT' ? { foldedHash: f.contentHash } : {}),
      });
      if (local !== sentAt) {
        this.operationLog.enqueueOperation(this.binding.id, {
          opType: 'RENAME',
          filePath: sentAt,
          newPath: local,
          payload: { fileId: f.id },
        });
      }
    }
  }

  /**
   * Index one file of the listing at its listed path, and mirror it to
   * `state.json`. `recorded`: this device's record of the file, when it is
   * not the one at `f.path`.
   */
  private indexListedFile(
    f: ApiFile,
    byPath: Map<string, IndexedMeta>,
    byId: Map<string, IndexedMeta>,
    recorded: FileMeta | null = this.operationLog.getFileMeta(this.binding.id, f.path),
  ): void {
    // Preserve the client's last-known `contentHash` (the "common
    // ancestor" from the engine's perspective) for files we've synced
    // before — overwriting it with the server's current hash would
    // make `detectBinaryConflict` treat every server-side update as
    // already-known (`storedHash === serverHash`), silently clobbering
    // local edits. New files (no prior meta) fall back to the server's
    // hash so applyServerCreate's binary download starts from a known
    // baseline.
    //
    // Only this file's own record, though. One another file left at the path
    // would hand its hashes to this one: a binary would be taken for synced
    // while the disk holds the other file's bytes, and a note would fold the
    // other file's text into this one (see `clearStaleCopies`). A record with
    // no id comes from an old log and keeps the benefit of the doubt.
    const existing =
      recorded !== null && (recorded.serverFileId === f.id || recorded.serverFileId === '')
        ? recorded
        : null;
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
    if (existing === null) this.newHere.add(f.id);
  }

  /**
   * Files the listing shows at another path than the one this device last
   * synced them at: a teammate renamed or moved them while this engine was
   * not connected. Keyed by file id; `meta` is the file as `state.json` has
   * it, at the old path, and `to` is where the server has it now.
   *
   * Nothing else would catch them. The catch-up skips their RENAME as already
   * applied (the index built from the listing has the new path), the old path
   * stays on disk outside the index, and `initialPush` uploads it as a
   * brand-new file — a duplicate under the old name for the whole team.
   *
   * A file the listing shows at the old path now does not stop the move: the
   * copy there is ours, as `state.json` says, and moves out first.
   */
  private renamedWhileAway(
    files: readonly ApiFile[],
    here: ReadonlyMap<string, string>,
  ): Map<string, RenamedWhileAway> {
    const lastSynced = new Map<string, FileMeta>();
    for (const meta of this.operationLog.listFileMeta(this.binding.id)) {
      if (meta.serverFileId !== '' && !lastSynced.has(meta.serverFileId)) {
        lastSynced.set(meta.serverFileId, meta);
      }
    }
    const moves = new Map<string, RenamedWhileAway>();
    for (const f of files) {
      // Renamed on this device as well: the queued rename wins, as it does on
      // the server when it gets there.
      if (here.has(f.id)) continue;
      const last = lastSynced.get(f.id);
      if (!last || last.relativePath === f.path) continue;
      // Recorded at the new path as well: that copy is the current one.
      if (this.operationLog.getFileMeta(this.binding.id, f.path)?.serverFileId === f.id) continue;
      // Only from a path this binding syncs. The meta comes from `state.json`,
      // which a build without the gate may have written.
      const from = checkVaultPath(last.relativePath, {
        bindingFolder: this.binding.localFolder,
        configDir: this.configDir,
      });
      if (from !== null) continue;
      moves.set(f.id, {
        meta: { ...last, fileId: f.id, fileType: f.fileType },
        to: f.path,
        serverHash: f.contentHash,
      });
    }
    return moves;
  }

  /**
   * Local copies that `state.json` holds at a listed path under another
   * file's id, one that does not move away (see {@link renamedWhileAway}):
   * a file deleted on the server while this device was away, whose name a
   * teammate then gave to another file — renamed there or created anew.
   *
   * Nothing else removes such a copy. The catch-up skips the DELETE (the file
   * is not in the listing, so not in the index), and the listed file then
   * took the copy for its own: a note's fold pushed the deleted note's text
   * into it, a binary counted the deleted file's bytes as synced — or, for a
   * file renamed there, the copy was parked aside as a conflict and uploaded
   * to the whole team, bringing the deleted file back under another name.
   *
   * So it is handled as the server delete it stands for, without a question:
   * a copy the server had is deleted, one with edits it may never have got is
   * parked aside and uploaded as a new file by `initialPush`. Returns the
   * paths still taken by a copy that could not be read — left as they are,
   * for the next connect.
   */
  private async clearStaleCopies(
    files: readonly ApiFile[],
    away: ReadonlyMap<string, RenamedWhileAway>,
    here: ReadonlyMap<string, string>,
  ): Promise<Set<string>> {
    const occupied = new Set<string>();
    for (const f of files) {
      // Where the file will be: renamed while away, it moves into this path.
      if (
        checkVaultPath(f.path, {
          bindingFolder: this.binding.localFolder,
          configDir: this.configDir,
        }) !== null
      ) {
        continue;
      }
      const stale = this.operationLog.getFileMeta(this.binding.id, f.path);
      if (stale === null || stale.serverFileId === '' || stale.serverFileId === f.id) continue;
      // Moved away itself: it vacates the path before anything moves in.
      if (away.has(stale.serverFileId)) continue;
      // Our own file under the name it was given here: its rename is queued.
      if (here.has(stale.serverFileId)) continue;
      if (!(await this.clearStaleCopy(stale, f, away.has(f.id)))) occupied.add(f.path);
      this.throwIfStopped();
    }
    return occupied;
  }

  /**
   * See {@link clearStaleCopies}. `moving`: the listed file moves into the
   * path, bringing its own copy. `false` when the copy is still in the way.
   */
  private async clearStaleCopy(
    stale: FileMeta,
    listed: ApiFile,
    moving: boolean,
  ): Promise<boolean> {
    const path = stale.relativePath;
    const localHash = await this.hashFile(this.vault, path);
    let verdict: 'keep' | 'delete' | 'park' = 'park';
    if (localHash === listed.contentHash) {
      // The listed file's content already: a copy the catch-up would write,
      // or, for one moving in, a copy of what it brings.
      verdict = moving ? 'delete' : 'keep';
    } else if (
      localHash === stale.contentHash ||
      (localHash !== null &&
        stale.fileType === 'TEXT' &&
        (await this.serverHadVersion(stale.serverFileId, localHash)))
    ) {
      // A note's `contentHash` moves only when a snapshot writes the file,
      // and a save goes to the server through the doc: its version history
      // knows whether this text got there.
      verdict = 'delete';
    }
    return this.commitLocal(async (io) => {
      if (!(await io.vault.exists(path))) {
        io.log.deleteFileMeta(this.binding.id, path);
        await this.dropDoc(io.docs, stale.serverFileId, path);
        return true;
      }
      const now = await this.hashFile(io.vault, path);
      // Unreadable: guessing would delete a file never read, or park one
      // that may be the listed file's content.
      if (now === null) {
        this.log.warn('could not read the local copy of a deleted file', { path });
        return false;
      }
      // Changed since the look above: keep the edit.
      const act = now === localHash ? verdict : 'park';
      if (act === 'delete') {
        this.log.info('removing the local copy of a file deleted on the server', {
          path,
          takenBy: listed.path,
        });
        io.echo.mark(path, ECHO_COUNT_DELETE);
        await io.vault.delete(path);
      } else if (act === 'park') {
        const aside = buildConflictPath(path, this.now());
        this.log.warn('a file deleted on the server had local edits; parked aside', {
          path,
          aside,
        });
        io.echo.mark(path, ECHO_COUNT_RENAME);
        io.echo.mark(aside, ECHO_COUNT_RENAME);
        await io.vault.ensureParentFolder(aside);
        await this.renameOnDisk(io, path, aside);
      }
      io.log.deleteFileMeta(this.binding.id, path);
      await this.dropDoc(io.docs, stale.serverFileId, path);
      return true;
    });
  }

  /**
   * Files renamed on this device whose RENAME is still in the offline queue:
   * id → the name the file has here, after the last such rename.
   *
   * The listing still has these under their old names. Taken for renames made
   * on the server, they were moved back on disk; indexed where the listing
   * has them, the catch-up wrote the old name back and `initialPush` uploaded
   * it as a second file once the queue had sent the rename. A new note saved
   * under the old name meanwhile was folded into the renamed one. The queue
   * sends the rename next, and until then it is what says where the file is.
   * A rename into a name this client never writes is left out: the replay
   * sends it as the delete it stands for.
   */
  private queuedRenames(deleted: ReadonlySet<string>): Map<string, string> {
    const here = new Map<string, string>();
    for (const op of this.operationLog.dequeueOperations(this.binding.id)) {
      if (op.opType !== 'RENAME' && op.opType !== 'MOVE') continue;
      const fileId = queuedFileId(op.payload);
      if (fileId === '' || op.newPath === null) continue;
      if (this.isLocalName(op.newPath)) here.set(fileId, op.newPath);
      else here.delete(fileId);
    }
    // Deleted after the rename: nowhere here.
    for (const fileId of deleted) here.delete(fileId);
    return here;
  }

  /**
   * Files deleted on this device whose DELETE still waits in the offline
   * queue, by id (see {@link forgetDeletedHere}). The listing still has them:
   * indexed, the catch-up wrote the deleted note back to disk and a new note
   * under its name was taken for it. So the index refresh leaves them out, as
   * if the server had them deleted already, which the drain makes so next.
   *
   * Not a delete `stop()` handed over before its stale-delete check (see
   * {@link holdLocalDelete}): it may be a stray `unlink` of a file still there,
   * and the replay decides that.
   */
  private queuedDeletes(): Set<string> {
    const deleted = new Set<string>();
    for (const op of this.operationLog.dequeueOperations(this.binding.id)) {
      if (op.opType !== 'DELETE' || op.payload[RECHECK_DELETE] === true) continue;
      const fileId = queuedFileId(op.payload);
      if (fileId !== '') deleted.add(fileId);
    }
    return deleted;
  }

  /**
   * Drop what this device still records of the files in `deleted` (see
   * {@link queuedDeletes}): a DELETE `stop()` handed over while its ack was on
   * the way left the file in `state.json`, and its doc in the store. Only the
   * databases of those files' own names, by name.
   */
  private async forgetQueuedDeletes(deleted: ReadonlySet<string>): Promise<void> {
    if (deleted.size === 0) return;
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      if (!deleted.has(record.serverFileId)) continue;
      const path = record.relativePath;
      this.operationLog.deleteFileMeta(this.binding.id, path);
      if (record.fileType !== 'TEXT') continue;
      await this.dropDoc(this.docManager, record.serverFileId, path);
      this.throwIfStopped();
    }
  }

  /**
   * Queued operations whose file the server no longer has under their id.
   * A queued operation carries only the id, and a teammate who deletes a file
   * and creates one under its name gets that id back: the server revives the
   * tombstone. Sent, the operation hit the teammate's new file — a delete
   * removed it for the whole team, a rename renamed it, an attachment edit
   * wrote the old attachment's bytes over it.
   *
   * The catch-up shows such a file deleted and created again (see
   * {@link notesRecreated}). It can leave that out — a server that lists
   * operations from the first 500 of a project's journal leaves every later
   * one out — so a delete is also held back when the listing shows content
   * this device never had for the file: changed by a teammate since, or made
   * anew. A teammate's edit to a note deleted here offline then brings the
   * note back, rather than going away with it; a new note with the content
   * of the deleted one (two empty "Untitled") is still deleted.
   *
   * Every queued operation of such a file is dropped, and the file the server
   * has comes back here (see {@link takeBackOvertaken}).
   */
  private async settleOvertakenQueue(): Promise<void> {
    const ops = this.operationLog.dequeueOperations(this.binding.id);
    const overtaken = new Set<string>();
    for (const op of ops) {
      const fileId = queuedFileId(op.payload);
      if (fileId === '' || op.opType === 'CREATE' || !this.lastListing.has(fileId)) continue;
      if (this.recreated.has(fileId)) {
        overtaken.add(fileId);
      } else if (op.opType === 'DELETE') {
        const known = lastSyncedHashes(op.payload);
        const now = this.lastListing.get(fileId)?.contentHash ?? '';
        if (known === null || known.includes(now)) continue;
        if (!(await this.serverDocWithin(fileId, op.payload))) overtaken.add(fileId);
        this.throwIfStopped();
      }
    }
    if (overtaken.size === 0) return;
    const dropped = ops.filter(
      (op) => op.opType !== 'CREATE' && overtaken.has(queuedFileId(op.payload)),
    );
    this.operationLog.markSent(dropped.map((op) => op.id));
    for (const fileId of overtaken) {
      const listed = this.lastListing.get(fileId);
      if (listed === undefined) continue;
      this.log.warn('queued changes to a file deleted or changed on the server since; not sent', {
        fileId,
        path: listed.path,
        ops: dropped.filter((op) => queuedFileId(op.payload) === fileId).map((op) => op.opType),
      });
      await this.takeBackOvertaken(listed);
      this.throwIfStopped();
    }
  }

  /**
   * Whether the server's doc of note `fileId` holds nothing that the note's
   * history here lacked when it was deleted (the queued DELETE's
   * {@link DOC_STATE}): no edit from anyone else reached the server since,
   * whatever its text. Its text is then one this device had, though not
   * necessarily one of the hashes it knew it by: an edit made offline moves
   * the note's fold marker past the text an online edit sent, and a note
   * edited online and then offline was never deleted — it came back. `false`
   * when the doc cannot be fetched, or the delete carries no history.
   */
  private async serverDocWithin(
    fileId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const local = payload[DOC_STATE];
    if (typeof local !== 'object' || local === null) return false;
    const seen = local as Record<string, unknown>;
    const fetched = await this.socket.fetchYjsDoc(this.binding.projectId, fileId);
    if (!fetched.ok || !Array.isArray(fetched.stateVector)) return false;
    try {
      for (const [client, clock] of Y.decodeStateVector(Uint8Array.from(fetched.stateVector))) {
        const had = seen[String(client)];
        if (typeof had !== 'number' || had < clock) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * The state vector of note `meta`'s history, client → clock, for a queued
   * delete (see {@link serverDocWithin}); the store is loaded for it when the
   * doc is not open. `null` for an attachment, or when there is no history of
   * the note's to read.
   */
  private async noteStateVector(
    meta: IndexedMeta | undefined,
  ): Promise<Record<string, number> | null> {
    if (meta?.fileType !== 'TEXT') return null;
    const path = this.docPathOf(meta);
    try {
      const opened = await this.docManager.open(this.binding.id, path, meta.fileId);
      if (opened.discarded) return null;
      const { doc } = this.docManager.get(this.binding.id, path);
      const vector: Record<string, number> = {};
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
        vector[String(client)] = clock;
      }
      return Object.keys(vector).length > 0 ? vector : null;
    } catch {
      this.throwIfStopped();
      return null;
    }
  }

  /**
   * The file the server has under the id of queued operations just dropped
   * (see {@link settleOvertakenQueue}) comes back here, under its listed name.
   * What this device still has of the file those operations were about — its
   * copy under the name a queued rename gave it, an attachment edited in
   * place — goes when the server had that content, and otherwise stays as a
   * file of its own: unindexed, the connect's first upload sends it.
   */
  private async takeBackOvertaken(listed: ApiFile): Promise<void> {
    const fileId = listed.id;
    // Its queued rename is gone: the catch-up's renames apply again.
    this.renamedHere.delete(fileId);
    const meta = this.fileIndex.byId.get(fileId);
    if (meta !== undefined) await this.letGoOfOldCopy(meta, listed.path);
    const path = listed.path;
    const shadow = { path, fileType: listed.fileType };
    if (!this.isLocalName(path)) {
      this.outOfScope.set(fileId, shadow);
      return;
    }
    const holder = this.nameHolder(path);
    if (holder !== undefined) {
      this.outOfScope.set(fileId, shadow);
      this.waitForName({ kind: 'create', fileId, path, fileType: listed.fileType }, holder);
      return;
    }
    if (await this.vault.exists(path)) {
      // A file of this device's own is there now, created after the one it
      // deleted. The connect's first upload sends it, the server stores it
      // under a conflict name, and it moves there (see `recordCreateAck`):
      // this file comes in then.
      this.log.info('a file taken back from the server finds its name taken here', { path });
      this.outOfScope.set(fileId, shadow);
      this.waitingForName.set(path, { kind: 'create', fileId, path, fileType: listed.fileType });
      return;
    }
    this.throwIfStopped();
    this.indexListedFile(listed, this.fileIndex.byPath, this.fileIndex.byId, null);
    // A note's text comes with the catch-up; an attachment is downloaded.
    if (listed.fileType === 'BINARY') {
      await this.applyServerCreate({ id: fileId, path, fileType: listed.fileType });
    }
  }

  /**
   * See {@link takeBackOvertaken}: the index, `state.json` and history this
   * device has of `meta` go, and its copy on disk with them when the server
   * had that content. A copy with content the server never had stays, set
   * aside under a conflict name when the file coming back takes its name.
   */
  private async letGoOfOldCopy(meta: IndexedMeta, comingTo: string): Promise<void> {
    const path = meta.relativePath;
    const localHash = await this.hashFile(this.vault, path);
    const serverHad =
      localHash === null ||
      localHash === meta.contentHash ||
      (meta.fileType === 'TEXT' && (await this.serverHadVersion(meta.fileId, localHash)));
    this.throwIfStopped();
    await this.commitLocal(async (io) => {
      if (this.fileIndex.byId.get(meta.fileId) === meta) this.fileIndex.byId.delete(meta.fileId);
      if (this.fileIndex.byPath.get(path) === meta) this.fileIndex.byPath.delete(path);
      this.forgetRecord(io.log, meta.fileId, path);
      await this.dropDoc(io.docs, meta.fileId, path);
      if (!(await io.vault.exists(path))) return;
      if (serverHad && (await this.hashFile(io.vault, path)) === localHash) {
        this.log.info('removing the local copy of a file the server has anew', { path });
        io.echo.mark(path, ECHO_COUNT_DELETE);
        await io.vault.delete(path);
        return;
      }
      if (path !== comingTo) return;
      const aside = buildConflictPath(path, this.now());
      this.log.warn('a file the server has anew had local edits; kept aside', { path, aside });
      io.echo.mark(path, ECHO_COUNT_RENAME);
      io.echo.mark(aside, ECHO_COUNT_RENAME);
      await io.vault.ensureParentFolder(aside);
      await this.renameOnDisk(io, path, aside);
    });
  }

  /** Whether this binding syncs `path` as a name of its own. */
  private isLocalName(path: string): boolean {
    return (
      checkVaultPath(path, {
        bindingFolder: this.binding.localFolder,
        configDir: this.configDir,
      }) === null
    );
  }

  /**
   * Index a listed file under `local`, the name it was given on this device
   * (see {@link queuedRenames}), with this device's record of it — at `local`,
   * or where a build before 0.3.8 left it until the ack, at the listed name.
   * Its doc comes along if it is not there yet.
   */
  private async indexRenamedHere(f: ApiFile, local: string): Promise<void> {
    const atLocal = this.operationLog.getFileMeta(this.binding.id, local);
    const atListed = this.operationLog.getFileMeta(this.binding.id, f.path);
    const recorded =
      atLocal?.serverFileId === f.id ? atLocal : atListed?.serverFileId === f.id ? atListed : null;
    // Where the file was recorded: its doc is there.
    const from = recorded?.relativePath ?? local;
    this.indexListedFile(
      { ...f, path: from },
      this.fileIndex.byPath,
      this.fileIndex.byId,
      recorded,
    );
    const meta = this.fileIndex.byId.get(f.id);
    if (!meta || from === local) return;
    await this.withPathLocks([from, local], () =>
      this.commitLocal((io) => this.relocate(io, meta, local)),
    );
  }

  /** Whether the server's version history of a file holds content hashing to `hash`. */
  private async serverHadVersion(fileId: string, hash: string): Promise<boolean> {
    try {
      const versions = await this.api.getFileVersions(this.binding.projectId, fileId);
      return versions.some((v) => v.contentHash === hash);
    } catch {
      this.throwIfStopped();
      return false;
    }
  }

  /**
   * Apply renames missed while away the way a live rename is applied (see
   * {@link applyServerRename}): the disk move with its collision checks, a
   * move out of the binding, a rename to a name this client never writes.
   *
   * A path is vacated before another file moves into it; names compare
   * without case, as a case-insensitive disk (Windows, macOS) sees them. A
   * cycle — two names swapped — is broken by moving one file to a spare name
   * first. A move that fails (a file locked by another program) is left for
   * the next connect: the file stays indexed under its old name, so it is not
   * uploaded as a new one, and nothing moves into that name meanwhile.
   */
  private async applyRenamesWhileAway(moves: Map<string, RenamedWhileAway>): Promise<void> {
    const pending = [...moves].map(([fileId, move]) => ({
      fileId,
      from: move.meta.relativePath,
      to: move.to,
      serverHash: move.serverHash,
      /** Stepped aside once already (see below). */
      aside: false,
    }));
    // Names compare the way the path gate does — a Mac opens `Λογος` and
    // `ΛΟΓΟΣ`, or `Straße` and `STRASSE`, as one file; `toLowerCase` does not.
    const key = pathKey;
    /** Old paths that stay taken: their move failed or waits on one that did. */
    const stuck = new Set<string>();
    const leave = (move: { fileId: string; from: string }): void => {
      stuck.add(key(move.from));
      this.renamesLeft.add(move.fileId);
    };
    while (pending.length > 0) {
      const doomed = pending.findIndex((move) => stuck.has(key(move.to)));
      if (doomed >= 0) {
        const [move] = pending.splice(doomed, 1);
        if (move) leave(move);
        continue;
      }
      const free = pending.findIndex(
        (move) => !pending.some((other) => other !== move && key(other.from) === key(move.to)),
      );
      if (free < 0) {
        // Every move waits on another: step one file of a cycle aside, and
        // the move into its name is free. A move waiting on a cycle without
        // being on it — two new names the disk takes for one, which the server
        // allows — is not: stepped aside, it would still wait, and step aside
        // again under a name longer each time. Each move steps aside once;
        // one that would have to again is left for the next connect.
        const move = cycleMove(pending, key);
        if (!move) return;
        if (move.aside) {
          pending.splice(pending.indexOf(move), 1);
          leave(move);
          continue;
        }
        move.aside = true;
        const spare = await this.spareMovePath(this.vault, move.from);
        this.throwIfStopped();
        if (
          await this.tryMoveWhileAway(move.fileId, move.from, spare, {
            aside: true,
            serverHash: '',
          })
        ) {
          move.from = spare;
        } else {
          pending.splice(pending.indexOf(move), 1);
          leave(move);
        }
        continue;
      }
      const move = pending[free];
      if (!move) return;
      pending.splice(free, 1);
      this.log.info('file renamed while this device was away', { from: move.from, to: move.to });
      const moved = await this.tryMoveWhileAway(move.fileId, move.from, move.to, {
        aside: false,
        serverHash: move.serverHash,
      });
      if (!moved) {
        leave(move);
      }
    }
  }

  /**
   * One move of {@link applyRenamesWhileAway}: `true` once the file has left
   * `from`. `aside` steps a file of a cycle to a spare name, which goes to
   * `state.json` like any other: stopped right after, the next connect moves
   * the file on from there.
   */
  private async tryMoveWhileAway(
    fileId: string,
    from: string,
    to: string,
    opts: { aside: boolean; serverHash: string },
  ): Promise<boolean> {
    const meta = this.fileIndex.byId.get(fileId);
    if (meta?.relativePath === from) {
      try {
        if (opts.aside) {
          await this.withPathLocks([from, to], () =>
            this.commitLocal((io) => this.moveLocalCopy(io, meta, to)),
          );
        } else {
          await this.applyServerRename(fileId, to, { serverHash: opts.serverHash });
        }
      } catch (err) {
        this.throwIfStopped();
        this.log.warn('could not apply a rename made while away; retrying on the next connect', {
          from,
          to,
          error: describeError(err, 'rename_failed'),
        });
      }
      this.throwIfStopped();
    }
    // Its copy waits for a question under the old name (see `retiredAway`):
    // nothing moves into that name meanwhile.
    if (this.retiredAway.has(fileId)) return false;
    return this.fileIndex.byId.get(fileId)?.relativePath !== from;
  }

  // -- Local → Server -------------------------------------------------------

  private async handleLocalCreate(path: string, from: LocalSource = 'watcher'): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    // The copy of a file renamed away while this device was away, waiting for
    // its question (see `retiredAway`): uploaded, it came back as a new file.
    if (this.isRetiredCopy(path)) return;
    // A create of this name under way here, or a rename into it waiting for
    // one (see `renameAfterCreate`): the file is recorded once it is done.
    const underway = this.creating.get(path);
    if (underway !== undefined) await underway;
    await this.createLocal(path, from);
  }

  /** {@link handleLocalCreate} past its checks: send the create, or the save of a known file. */
  private async createLocal(path: string, from: LocalSource): Promise<void> {
    if (this.fileIndex.byPath.has(path)) {
      // The server already knows about this — treat as a modify.
      await this.handleLocalModify(path, from);
      return;
    }
    const fileType = classifyFileType(path);
    const change = this.hold(from, 'CREATE', path, null, { fileType });
    try {
      await this.trackCreate(path, () => this.sendLocalCreate(path, fileType, change));
    } finally {
      this.settle(change);
    }
  }

  /**
   * Run a create of `path`, known in {@link creating} while it runs: a save,
   * a create or a rename of the name meanwhile waits for it.
   */
  private async trackCreate(
    path: string,
    run: () => Promise<CreatedHere | null>,
  ): Promise<CreatedHere | null> {
    const task = run();
    const tracked = task.then(
      (created) => created,
      () => null,
    );
    this.creating.set(path, tracked);
    try {
      return await task;
    } finally {
      if (this.creating.get(path) === tracked) this.creating.delete(path);
    }
  }

  private async sendLocalCreate(
    path: string,
    fileType: FileType,
    change: HeldChange | null,
  ): Promise<CreatedHere | null> {
    // Stale-create guard: if the file isn't actually on disk anymore,
    // this event is leftover from an atomic-rename write (chokidar saw
    // the intermediate `add` but the file moved away again before we got
    // here). Emitting would upload empty bytes and tip the server into a
    // conflict-rename round-trip.
    if (!(await this.vault.exists(path))) return null;
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);
    const payload = { fileType, contentHash: hash, size: buffer.byteLength };
    if (change) change.payload = payload;
    /** Out to the server, answered or not: it may have applied it. */
    let sent = false;

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
        sent = true;
        // Queued from here on, the entry says it went out (see `SENT_HASHES`).
        if (change) change.payload = { ...payload, [SENT_HASHES]: [hash] };
        const ack = await this.emitCreate({
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
          const created = await this.recordCreateAck(
            path,
            (ack as { outcome?: unknown }).outcome,
            fileType,
            hash,
            buffer.byteLength,
          );
          this.persistVectorClock();
          return created;
        }
        // Refused: nothing of it is on the server.
        sent = false;
      } catch {
        this.throwIfStopped();
        // Staging upload or emit failed (offline / server error) — fall through
        // to the offline queue, which replays on the next reconnect.
        this.log.debug('create staging/emit failed; queueing', path);
      }
    }
    // Offline (or NACK) — queue and bail; the engine will replay on reconnect.
    this.queue('CREATE', path, null, sent ? { ...payload, [SENT_HASHES]: [hash] } : payload);
    return null;
  }

  /**
   * Record what the server made of a create sent from here (`path`): the file
   * under the name asked for, or — the name taken there by another file — under
   * the conflict name the server stored it at. There the local copy follows
   * it, as a rename does (see `followStoredRename`), and the file the server
   * has under the name may come in (see `waitForName`).
   *
   * Left unrecorded under the name asked for, as it used to be, the copy went
   * out again with the next save and the next connect's first upload, one more
   * conflict copy on the server each time, and the file the server has under
   * the name never came in.
   *
   * Two more cases. The note renamed right after it was created (see
   * {@link renameAfterCreate}) is under its new name already: it is recorded
   * at the conflict name, and its rename goes out from there. Recorded
   * nowhere, it went out again as a second create under the new name. And the
   * conflict name already recorded under this very id is the same create,
   * applied before the ack of an earlier try was lost: the copy under the
   * name asked for is a second copy of it, and goes (see
   * {@link dropSecondCopy}). Left there, the name was never given to the file
   * the server has under it, and after a restart that file took the copy for
   * its own: its text was replaced by this note's for everyone.
   */
  private async recordCreateAck(
    path: string,
    outcome: unknown,
    fileType: FileType,
    contentHash: string,
    size: number,
  ): Promise<CreatedHere | null> {
    const o = outcome as { fileId?: unknown; path?: unknown } | null | undefined;
    const fileId = typeof o?.fileId === 'string' ? o.fileId : '';
    if (fileId === '') return null;
    if (typeof o?.path === 'string' && o.path !== '') {
      const merged = this.knownAsAnothers(fileId, o.path);
      await this.recordCreatedFile(fileId, o.path, fileType, contentHash, size);
      if (merged && this.fileIndex.byId.get(fileId)?.relativePath === o.path) {
        await this.materializeMerged(fileId, o.path, fileType);
      }
      return { fileId, merged };
    }
    const conflict = conflictPlacement(outcome);
    if (conflict === null || conflict.asked !== path || conflict.stored === path) return null;
    const stored = conflict.stored;
    if (!this.allowServerPath(stored, 'create ack')) return null;
    if (this.fileIndex.byPath.get(stored)?.fileId === fileId) {
      await this.dropSecondCopy(path, stored);
      return { fileId, merged: false };
    }
    if (
      this.renamedAfterCreate.has(path) &&
      !this.fileIndex.byPath.has(stored) &&
      !(await this.vault.exists(path))
    ) {
      this.log.info('own create stored under a conflict name; renamed here already', {
        path,
        stored,
      });
      await this.recordCreatedFile(fileId, stored, fileType, contentHash, size);
      await this.releaseName(path);
      return { fileId, merged: false };
    }
    const moved = await this.withPathLocks([path, stored], () =>
      this.commitLocal(async (io) => {
        if (this.fileIndex.byPath.has(path) || this.fileIndex.byPath.has(stored)) return false;
        if (!(await io.vault.exists(path)) || (await io.vault.exists(stored))) return false;
        this.log.info('own create stored under a conflict name', { path, stored });
        io.echo.mark(path, ECHO_COUNT_RENAME);
        io.echo.mark(stored, ECHO_COUNT_RENAME);
        await io.vault.ensureParentFolder(stored);
        await this.renameOnDisk(io, path, stored);
        return true;
      }),
    );
    if (!moved) return null;
    await this.recordCreatedFile(fileId, stored, fileType, contentHash, size);
    await this.releaseName(path);
    return { fileId, merged: false };
  }

  /**
   * Whether the file `fileId` the server gave a create of this device's at
   * `path` was another device's before: listed when this device connected, or
   * broadcast as another device's create while this one was on its way (see
   * {@link applyServerCreate}). The server answers a create of a name taken by
   * a file with the same content with that file.
   *
   * Not a listed file deleted since (see {@link deletedSinceListing}): the
   * server brings a tombstone back under its old id for a create of its name,
   * and the file is this device's new one. Taken for another device's, a note
   * renamed right after it was created here ("Untitled" deleted, made again,
   * renamed by a template) went out a second time under its new name, and the
   * old name was written back to disk: the team got the note twice.
   */
  private knownAsAnothers(fileId: string, path: string): boolean {
    if (this.lastListing.has(fileId) && !this.deletedSinceListing.has(fileId)) return true;
    const waiting = this.waitingForName.get(path);
    return waiting?.kind === 'create' && waiting.fileId === fileId && waiting.foreign === true;
  }

  /**
   * Another device's file the server gave back for a create of this device's
   * with the same content (see {@link knownAsAnothers}), recorded at `path`:
   * the copy here may have been renamed away meanwhile (see
   * {@link renameAfterCreate}), and the file is then written out from the
   * server — its broadcast and first update came while it was not recorded.
   */
  private async materializeMerged(fileId: string, path: string, fileType: FileType): Promise<void> {
    if (await this.vault.exists(path)) return;
    if (fileType === 'TEXT') {
      this.skippedDocs.add(fileId);
      this.scheduleSnapshotToDisk(path);
      return;
    }
    await this.applyServerUpdateBinary(fileId);
  }

  /**
   * A create sent again from `path` that the server stored at the conflict
   * name `stored`, where this device already has the file: the same create,
   * applied before an earlier ack was lost (see {@link recordCreateAck}). The
   * copy under `path` goes when it holds what is at `stored` — or moves there
   * when the copy at `stored` has not been written yet — and the name is free
   * for the file the server has under it.
   */
  private async dropSecondCopy(path: string, stored: string): Promise<void> {
    const freed = await this.withPathLocks([path, stored], () =>
      this.commitLocal(async (io) => {
        if (this.fileIndex.byPath.has(path)) return false;
        if (!(await io.vault.exists(path))) return true;
        const here = await this.hashFile(io.vault, path);
        if (!(await io.vault.exists(stored))) {
          this.log.info('own create applied before its ack was lost; moving the copy', {
            path,
            stored,
          });
          io.echo.mark(path, ECHO_COUNT_RENAME);
          io.echo.mark(stored, ECHO_COUNT_RENAME);
          await io.vault.ensureParentFolder(stored);
          await this.renameOnDisk(io, path, stored);
          return true;
        }
        if (here === null || here !== (await this.hashFile(io.vault, stored))) return false;
        this.log.info('own create applied before its ack was lost; removing the second copy', {
          path,
          stored,
        });
        io.echo.mark(path, ECHO_COUNT_DELETE);
        await io.vault.delete(path);
        return true;
      }),
    );
    if (freed) await this.releaseName(path);
  }

  /**
   * Record a freshly server-acknowledged CREATE in the in-memory file
   * index + the SQLite mirror, and wire its Yjs doc when it's text.
   * Shared by the online CREATE path (`handleLocalCreate`) and the
   * offline-queue replay (`replayPending`) so both keep `fileIndex`
   * authoritative — the initial-push pass relies on that to avoid
   * re-uploading files the server already has.
   */
  private async recordCreatedFile(
    fileId: string,
    path: string,
    fileType: FileType,
    contentHash: string,
    size: number,
  ): Promise<void> {
    // The path comes back from the server's ack and may differ from the one
    // we sent (conflict rename). From here it flows into `fileIndex` and
    // `state.json`, which every later disk write reads — so it passes the
    // same gate.
    if (!this.allowServerPath(path, 'create ack')) return;
    // Its broadcast may have come first and been kept waiting (see
    // `applyServerCreate`): it is this file, recorded now.
    this.outOfScope.delete(fileId);
    this.forgetWaiting(fileId);
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
    if (fileType === 'TEXT') await this.startDoc(fileId, path);
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

  /**
   * `file:update-binary`, with its hash in {@link binaryUploads} until the
   * ack comes (or the emit fails).
   */
  private async emitBinaryUpdate(payload: FileUpdateBinaryPayload): Promise<Ack> {
    const { fileId, contentHash } = payload;
    const sending = this.binaryUploads.get(fileId) ?? [];
    sending.push(contentHash);
    this.binaryUploads.set(fileId, sending);
    try {
      return await this.socket.emitFileUpdateBinary(payload);
    } finally {
      const left = this.binaryUploads.get(fileId) ?? [];
      const i = left.indexOf(contentHash);
      if (i >= 0) left.splice(i, 1);
      if (left.length === 0) this.binaryUploads.delete(fileId);
    }
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
      const renamed = await this.withPathLock(path, async (): Promise<boolean> => {
        await this.openDoc(meta);
        // Moved or deleted while the doc loaded: this event is about a name
        // the note no longer has.
        if (this.fileIndex.byPath.get(path) !== meta) return true;
        await this.ensureHydrated(meta);
        // Or while its state was fetched, which can take seconds. Read under
        // the old name, the disk had no file there any more.
        if (this.fileIndex.byPath.get(path) !== meta) return true;
        if (!this.docManager.hasState(this.binding.id, path) && meta.size > 0) {
          this.log.debug('defer text modify until doc hydrates', path);
          return false;
        }
        const content = await this.readDiskText(path);
        // Gone right under the read: its delete or rename event owns it.
        if (typeof content !== 'string') return false;
        await this.foldDiskEditsIntoDoc(path, content);
        // The doc may hold remote edits the disk doesn't have yet. Their own
        // snapshot usually writes them out, but not when it found the note
        // gone right before its write (an unlink + create by git or an editor)
        // and left the path to the watcher — this event. Without a snapshot
        // here, disk and doc would disagree until the next remote edit.
        if (this.docManager.getText(this.binding.id, path) !== content) {
          this.scheduleSnapshotToDisk(path);
        }
        return false;
      });
      // The save is on disk under the note's new name: fold it there, once
      // the rename has carried the note's history over.
      if (renamed && this.fileIndex.byId.get(meta.fileId) === meta && meta.relativePath !== path) {
        await this.handleLocalModify(meta.relativePath, from);
      }
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
        const ack = await this.emitBinaryUpdate({
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
    // The folder on disk may be spelled in another case than the notes in it
    // are recorded by (see `spelledHere`).
    const folderKey = this.caseInsensitive() ? pathKey(folderPath) : null;
    for (const path of this.fileIndex.byPath.keys()) {
      if (
        isInBinding(path, folderPath) ||
        (folderKey !== null && isInBinding(this.caseKey(path), folderKey))
      ) {
        children.push(path);
      }
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
    const meta = this.fileIndex.byPath.get(path);
    const payload = deletePayload(meta?.fileId ?? '', meta);
    return this.hold(
      'watcher',
      'DELETE',
      path,
      null,
      opts.checked ? payload : { ...payload, [RECHECK_DELETE]: true },
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
    if (change) change.payload = deletePayload(fileId, meta);
    // The path may be absent from the local index (a folder-delete child, or
    // a stale index). Resolve the id from the server's live file list before
    // giving up — otherwise the DELETE is queued with an empty fileId and is
    // later dropped as `no_file_id`, so the deletion never propagates.
    if (!fileId && this.socket.isConnected()) {
      fileId = await this.resolveServerFileId(path);
      this.throwIfStopped();
    }
    if (change) change.payload = deletePayload(fileId, meta);
    if (fileId) {
      this.deletedIds.add(fileId);
      this.deletedSinceListing.add(fileId);
    }
    if (this.socket.isConnected() && fileId) {
      let ack: Ack;
      try {
        ack = await this.emitDelete({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          vectorClock: this.bumpClock(),
          fileId,
          filePath: path,
        });
      } catch {
        // The connection dropped before the ack: queued below. A delete the
        // server did apply is a delete of a tombstone when replayed.
        this.throwIfStopped();
        ack = { ok: false, error: 'disconnected' };
      }
      this.throwIfStopped();
      if (ack.ok) {
        // Only what is still this file's: a note renamed onto the name here
        // while the delete was on its way is recorded there at once (see
        // `handleLocalRename`). Wiped unconditionally, its record went, its
        // next save was uploaded as a new file, and its history was deleted.
        if (this.fileIndex.byId.get(fileId)?.relativePath === path) {
          this.fileIndex.byId.delete(fileId);
        }
        this.forgetPath(this.operationLog, fileId, path);
        // A concurrent remote yjs:update may have scheduled a debounced disk
        // snapshot for this path: cancelled, or it would recreate the
        // just-deleted file. The doc and its store go too: left in place, they
        // were the history of the next note created under this name — the
        // same teardown applyServerDelete does.
        await this.dropDoc(this.docManager, fileId, path);
        this.persistVectorClock();
        this.forgetWaiting(fileId);
        await this.releaseName(path);
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
    const docState = await this.noteStateVector(meta);
    this.queue('DELETE', path, null, {
      ...deletePayload(fileId, meta),
      ...(docState !== null ? { [DOC_STATE]: docState } : {}),
    });
    await this.forgetDeletedHere(fileId, path);
    this.forgetWaiting(fileId);
    await this.releaseName(path);
  }

  /**
   * A file deleted here whose DELETE waits in the offline queue: it leaves the
   * index, `state.json` and its doc at once, as an offline rename moves them
   * (see {@link handleLocalRename}); the next connect leaves it out of the
   * listing until the queue has sent the delete (see {@link queuedDeletes}).
   *
   * Left in place until the ack, the file was still this device's under its
   * name: the catch-up wrote the deleted note back to disk, where it stayed
   * after the delete went out, never synced again, and a new note saved under
   * the name meanwhile (Obsidian reuses "Untitled") was folded into the
   * deleted one's doc — its text went to the server as the deleted note's,
   * and the new note itself was never uploaded.
   */
  private async forgetDeletedHere(fileId: string, path: string): Promise<void> {
    await this.commitLocal(async (io) => {
      if (this.fileIndex.byId.get(fileId)?.relativePath === path) {
        this.fileIndex.byId.delete(fileId);
      }
      this.forgetPath(io.log, fileId, path);
      await this.dropDoc(io.docs, fileId, path);
    });
  }

  private async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    // One of this engine's own renames, reported by Obsidian before the call
    // returned (see `renameOnDisk`). The watcher drops these; this is for an
    // event that took another way. Sent on, it renamed the note on the server
    // to the spare name a case-only rename steps through, or started renaming
    // two swapped names back and forth forever.
    if (this.renamingOnDisk.has(renameKey(oldPath, newPath))) return;
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

    let meta = this.fileIndex.byPath.get(oldPath);
    if (meta === undefined ? this.movingHere.size > 0 : this.movingHere.has(meta.fileId)) {
      // A rename from the server is moving files on disk, and Obsidian reports
      // each of its steps as a rename. One that got this far names a name the
      // file is leaving or has left: wait for that rename, then look again.
      const seen = meta;
      await this.withPathLocks([oldPath, newPath], () => Promise.resolve());
      if (
        seen !== undefined &&
        (seen.relativePath !== oldPath || this.fileIndex.byId.get(seen.fileId) !== seen)
      ) {
        return;
      }
      meta = this.fileIndex.byPath.get(oldPath);
    }
    if (meta === undefined) {
      const created = this.creating.get(oldPath);
      if (created !== undefined) {
        await this.renameAfterCreate(created, oldPath, newPath);
        return;
      }
      // Known under the new name already: this rename has been applied.
      if (this.fileIndex.byPath.has(newPath)) return;
      // A file this device never synced: under its new name it is a new file.
      // Queued as a rename without an id, it was dropped by the drain and left
      // for the next connect's first upload.
      await this.handleLocalCreate(newPath);
      return;
    }
    await this.renameRecorded(meta, oldPath, newPath);
  }

  /**
   * A note created here renamed before the server acknowledged its create: a
   * template that renames the note it has just made (Templater's
   * `tp.file.rename`), a title typed in on a slow connection. The rename
   * waits for the create, and goes out as the rename of the note the server
   * has. A create or save under the new name meanwhile waits for it in turn.
   *
   * It used to go out at once as a second create, under the new name: the
   * ack of the first recorded the note under the old name, where the disk had
   * nothing, the whole team got the note twice, and the next start wrote the
   * old name back to disk.
   */
  private async renameAfterCreate(
    created: Promise<CreatedHere | null>,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    this.renamedAfterCreate.add(oldPath);
    try {
      await this.trackCreate(newPath, async (): Promise<CreatedHere | null> => {
        const result = await created;
        // By the id the create came back with, not by the name: another
        // device's file may be indexed under the old name by now. Only a file
        // this device made is renamed; one the server gave back for the same
        // content (two empty "Untitled") keeps its name.
        const meta =
          result !== null && !result.merged ? this.fileIndex.byId.get(result.fileId) : undefined;
        if (meta !== undefined) {
          if (meta.relativePath !== newPath) {
            await this.renameRecorded(meta, meta.relativePath, newPath);
          }
          return result;
        }
        // Queued after it went out, its ack lost: it may be on the server under
        // the old name. The entry follows the note, and says where it went
        // (see `adoptLandedCreates`).
        if (result === null && this.followQueuedCreate(oldPath, newPath)) return null;
        // Not created (queued offline, refused, found gone): the note is new
        // under its new name, and the create queued under the old one finds
        // nothing there.
        await this.createLocal(newPath, 'watcher');
        return null;
      });
    } finally {
      this.renamedAfterCreate.delete(oldPath);
    }
  }

  /**
   * A note renamed from `oldPath` to `newPath` whose create is queued after
   * it went out (see {@link SENT_HASHES}): the entry moves to the new name
   * and keeps the name it went out under. `false` when there is no such entry.
   */
  private followQueuedCreate(oldPath: string, newPath: string): boolean {
    const entry = this.operationLog
      .dequeueOperations(this.binding.id)
      .filter((op) => op.opType === 'CREATE' && op.filePath === oldPath)
      .pop();
    if (entry === undefined || sentHashes(entry.payload).length === 0) return false;
    const sentAt = typeof entry.payload[SENT_AT] === 'string' ? entry.payload[SENT_AT] : oldPath;
    return this.operationLog.amendOperation(entry.id, {
      filePath: newPath,
      payload: { ...entry.payload, [SENT_AT]: sentAt },
    });
  }

  /** {@link handleLocalRename} of a file this device has a record of: `target`. */
  private async renameRecorded(
    target: IndexedMeta,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const { fileId } = target;
    // Renamed here after the server's rename it waited to apply: this one
    // reaches the server after it, and wins there.
    this.forgetWaiting(fileId);
    // A disconnected socket never answers the ack: without holding it, a
    // rename sent just before `stop()` would be lost, and the next engine
    // would upload the new path as a second file.
    const change = this.hold('watcher', 'RENAME', oldPath, newPath, { fileId });
    this.renameCount.set(fileId, (this.renameCount.get(fileId) ?? 0) + 1);
    this.localRenames.set(fileId, (this.localRenames.get(fileId) ?? 0) + 1);
    let docMoved: Promise<void> = Promise.resolve();
    /** What the server made of the rename, once it has acknowledged it. */
    let acked: { outcome: unknown } | null = null;
    try {
      // The note is under its new name on disk already, so it is recorded
      // there at once — whether the server hears of the rename now or from
      // the offline queue, and before anything else happens under either
      // name. Left under the old name until the ack, the old name was written
      // back by the catch-up and uploaded as a second file, and a new note
      // saved under it was folded into this one. Left there until the note's
      // history had moved — which waits for a save being folded in under the
      // old name, up to 15 s for the note's state from the server — a save
      // under the new name was uploaded as a new file, and a second rename
      // went out without the file id.
      this.switchRecords(target, oldPath, newPath);
      // The history follows, under both names' locks.
      docMoved = this.moveRenamedDoc(target, oldPath, newPath);
      if (this.socket.isConnected() && this.supersedeQueuedMoves(fileId, newPath)) {
        try {
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
            this.persistVectorClock();
            acked = { outcome: (ack as { outcome?: unknown }).outcome };
          }
        } catch {
          // The connection dropped before the ack: queued, and the replay is a
          // rename to where the server may have the file already — a no-op.
          this.throwIfStopped();
          this.log.debug('rename emit failed; queueing', { oldPath, newPath });
        }
      }
      if (acked === null) this.queue('RENAME', oldPath, newPath, { fileId });
    } finally {
      this.settle(change);
      // Acknowledged: a teammate's rename broadcast from here on was applied
      // on the server after this one, and is followed.
      this.forgetLocalRename(fileId);
      await docMoved;
    }
    if (acked !== null) await this.followStoredRename(fileId, acked.outcome);
    // The name the note left may be what another file waits for.
    await this.releaseName(oldPath);
  }

  /**
   * A rename of `fileId` to `newPath` about to go out at once, while renames
   * of the file made offline still wait in the queue — sync is connecting, or
   * the drain is held up behind another operation. The server applies a
   * rename by the file's id, whatever name it gives as the source, so this
   * one takes the file where they would have, and they are taken out of the
   * queue (a drain that has one in hand skips it, see {@link replayPending}).
   *
   * Sent after it, the queued rename moved the note back to the name in
   * between for the whole team, and the next connect wrote that name back to
   * disk here: the user's last rename was undone. And with the connection lost
   * first, the queued rename told the next connect the note was under that
   * name, and the copy under the last one was uploaded as a second note.
   *
   * `false` when another file's queued operation still has to vacate
   * `newPath` on the server: the rename then waits in the queue behind them
   * all, in order.
   */
  private supersedeQueuedMoves(fileId: string, newPath: string): boolean {
    const ops = this.operationLog.dequeueOperations(this.binding.id);
    const mine = ops.filter((op) => isQueuedMove(op) && queuedFileId(op.payload) === fileId);
    if (mine.length === 0) return true;
    const target = pathKey(newPath);
    const inTheWay = ops.some(
      (op) =>
        queuedFileId(op.payload) !== fileId &&
        (pathKey(op.filePath) === target ||
          (op.newPath !== null && pathKey(op.newPath) === target)),
    );
    if (inTheWay) return false;
    this.log.debug('queued renames of a file superseded by one going out now', {
      fileId,
      newPath,
      queued: mine.map((op) => `${op.filePath} -> ${op.newPath ?? ''}`),
    });
    this.operationLog.markSent(mine.map((op) => op.id));
    return true;
  }

  /** A local rename of `fileId` is acknowledged or queued: see {@link localRenames}. */
  private forgetLocalRename(fileId: string): void {
    countDown(this.localRenames, fileId);
  }

  /**
   * Record a file renamed on this device under `newPath`: the index and
   * `state.json`, synchronously. Its history follows (see
   * {@link moveRenamedDoc}).
   *
   * Until the history is under the new name, `state.json` gives the note's
   * fold marker as its last synced content. Stopped or killed before the
   * history moves, the next engine finds no history under the new name: with
   * the marker naming what had been folded into the history left behind, it
   * took the disk as folded, and the catch-up wrote the server's text over
   * the edits made offline. With the last synced content, the next fold
   * merges them in three-way.
   */
  private switchRecords(meta: IndexedMeta, oldPath: string, newPath: string): void {
    this.forgetPath(this.operationLog, meta.fileId, oldPath);
    meta.relativePath = newPath;
    this.fileIndex.byPath.set(newPath, meta);
    this.fileIndex.byId.set(meta.fileId, meta);
    this.operationLog.setFileMeta(
      meta.fileType === 'TEXT' && meta.foldedHash !== undefined
        ? { ...meta, foldedHash: meta.contentHash }
        : meta,
    );
    // A remote edit waiting to be written out is written under the new name.
    const pending = this.snapshotDebouncers.get(oldPath);
    if (pending !== undefined) {
      pending.cancel();
      this.snapshotDebouncers.delete(oldPath);
      this.scheduleSnapshotToDisk(newPath);
    }
  }

  /**
   * Carry a renamed note's history to its new name (see `DocManager.move`),
   * under the locks of both names: a save being folded in under the old name
   * finishes first, and a save or a snapshot under the new name waits for the
   * history. Meanwhile the doc is still under the old name, and remote updates
   * land on it there (see {@link docPathOf}): the move carries them along.
   * Never rejects; a history that could not move is logged.
   */
  private moveRenamedDoc(meta: IndexedMeta, oldPath: string, newPath: string): Promise<void> {
    if (meta.fileType !== 'TEXT') return Promise.resolve();
    const { fileId } = meta;
    const step = { from: oldPath, to: newPath };
    const steps = this.docMoves.get(fileId) ?? [];
    steps.push(step);
    this.docMoves.set(fileId, steps);
    const landed = (): void => {
      const list = this.docMoves.get(fileId);
      const i = list?.indexOf(step) ?? -1;
      if (list === undefined || i < 0) return;
      list.splice(i, 1);
      if (list.length === 0) this.docMoves.delete(fileId);
    };
    return this.withPathLocks([oldPath, newPath], () =>
      this.commitLocal(async (io) => {
        const live = this.fileIndex.byId.get(fileId);
        if (live === undefined) {
          // Deleted meanwhile: its history goes with it, not to the new name.
          landed();
          await this.dropDoc(io.docs, fileId, oldPath);
          return;
        }
        const moved = await io.docs.move(
          this.binding.id,
          oldPath,
          newPath,
          fileId,
          () => {
            landed();
            this.carryPathState(io.docs, live, oldPath, newPath);
          },
          // A snapshot due for the note writes from the doc: kept open for it.
          { keepOpen: () => this.snapshotDue(newPath) || this.snapshotDue(oldPath) },
        );
        this.afterDocMove(io.log, live, moved);
        // Its history under its name, the note's fold marker says again what
        // the doc holds (see `switchRecords`).
        if (!this.docMoves.has(fileId) && this.fileIndex.byId.get(fileId) === live) {
          io.log.setFileMeta(live);
        }
      }),
    ).catch((err: unknown) => {
      landed();
      if (this.hasStopped) return;
      this.log.warn('could not move a renamed note’s history to its new name', {
        oldPath,
        newPath,
        error: describeError(err, 'move_failed'),
      });
    });
  }

  /**
   * Where the doc of `meta` is: under its name, or, while a local rename is
   * still carrying its history over (see {@link moveRenamedDoc}), under the
   * name the history is being carried from.
   */
  private docPathOf(meta: IndexedMeta): string {
    return this.docMoves.get(meta.fileId)?.[0]?.from ?? meta.relativePath;
  }

  /**
   * Wire a text file's Yjs doc to the socket so future edits stream upstream.
   * Replaces whatever the path was wired to: the subscription carries the
   * file id, and each wiring used to add one more that lived until the engine
   * stopped — so once a name changed hands, the new note's edits went out
   * under the id of the one renamed away as well.
   */
  private wire(fileId: string, path: string): void {
    this.unwire(path);
    const off = this.docManager.onLocalUpdate(this.binding.id, path, (update) => {
      if (!this.socket.isConnected()) return; // y-indexeddb keeps it; reconnect resends.
      // Lost with the connection, the update is in y-indexeddb: the next
      // catch-up pushes it back.
      this.socket
        .emitYjsUpdate({ projectId: this.binding.projectId, fileId, update })
        .catch(() => undefined);
    });
    // Subscribing creates a doc not cached yet, and `onDocAcquired` wires it
    // right there, inside the call: that nested wiring goes, or every edit of
    // the note went out twice.
    this.unwire(path);
    this.wired.set(path, off);
  }

  private unwire(path: string): void {
    const off = this.wired.get(path);
    if (off === undefined) return;
    this.wired.delete(path);
    off();
  }

  /**
   * A note new under `path` — created here or by a teammate: whatever doc and
   * store another note left under that name is deleted (only that database,
   * by name), then the new note is wired.
   *
   * A note renamed away from the name may not have carried its history off
   * yet (see {@link moveRenamedDoc}): that goes first. Deleted here, the
   * history was lost, and the new note's subscription left with it.
   */
  private async startDoc(fileId: string, path: string): Promise<void> {
    // Nothing of another history is kept: its updates need no check.
    this.lineageChecked.add(fileId);
    if (this.historyLeaving(path, fileId)) {
      await this.withPathLock(path, () => Promise.resolve());
    }
    this.unwire(path);
    await this.docManager.clear(this.binding.id, path);
    // Deleted or moved on meanwhile.
    if (this.fileIndex.byPath.get(path)?.fileId !== fileId) return;
    this.wire(fileId, path);
  }

  /**
   * Whether the history of a note other than `fileId`, renamed on this
   * device, is still to be carried away from `path` (see
   * {@link moveRenamedDoc}). The doc under the name is that note's until then.
   */
  private historyLeaving(path: string, fileId: string): boolean {
    for (const [id, steps] of this.docMoves) {
      if (id !== fileId && steps.some((step) => step.from === path)) return true;
    }
    return false;
  }

  /**
   * `path` no longer belongs to file `fileId` (deleted, or gone out of what
   * this binding syncs): its pending snapshot, fold state, subscription, doc
   * and store go. A pending snapshot would write the file back; a doc left in
   * place was the history of the next note created under this name. Not when
   * another file is indexed there since — the doc is that one's. `docs` is
   * the unfenced manager inside a {@link commitLocal} block.
   */
  private async dropDoc(docs: DocManager, fileId: string, path: string): Promise<void> {
    this.forgetFoldState(fileId);
    const holder = this.fileIndex.byPath.get(path);
    if (holder !== undefined && holder.fileId !== fileId) return;
    this.snapshotDebouncers.get(path)?.cancel();
    this.snapshotDebouncers.delete(path);
    this.unwire(path);
    await docs.clear(this.binding.id, path);
  }

  /**
   * Record a file under `newPath` — the index, `state.json`, and its doc,
   * carried there with its pending snapshot and its subscription. The disk
   * is the caller's. Local phase only; see `DocManager.move` for how the
   * doc goes and why the records move in the same step.
   */
  private async relocate(io: LocalIO, meta: IndexedMeta, newPath: string): Promise<void> {
    const oldPath = meta.relativePath;
    const switchOver = (): void => {
      this.forgetPath(io.log, meta.fileId, oldPath);
      meta.relativePath = newPath;
      io.log.setFileMeta(meta);
      this.fileIndex.byPath.set(newPath, meta);
      this.fileIndex.byId.set(meta.fileId, meta);
      this.carryPathState(io.docs, meta, oldPath, newPath);
    };
    if (meta.fileType !== 'TEXT' || oldPath === newPath) {
      switchOver();
      return;
    }
    // A snapshot pending for the file is written under the new name, from the
    // doc: kept open for it (see `DocManager.move`).
    const moved = await io.docs.move(this.binding.id, oldPath, newPath, meta.fileId, switchOver, {
      keepOpen: () => this.snapshotDue(oldPath),
    });
    this.afterDocMove(io.log, meta, moved);
  }

  /**
   * Move what the engine keeps by path for a file: a pending snapshot is
   * rescheduled under the new name (the remote edit it was for is in the
   * doc carried there), the subscription is known under the new name.
   *
   * A doc the move brought to the new name without a subscription — the note
   * had none open under the old one — is wired here: `DocManager.move` opens
   * it for itself, so `onDocAcquired` never fires for it, and the note's
   * edits stayed on this device until the next reconnect. A subscription
   * another file left under the new name is dropped.
   */
  private carryPathState(
    docs: DocManager,
    meta: IndexedMeta,
    oldPath: string,
    newPath: string,
  ): void {
    const pending = this.snapshotDebouncers.get(oldPath);
    this.snapshotDebouncers.delete(oldPath);
    const wired = this.wired.get(oldPath);
    this.wired.delete(oldPath);
    if (this.wired.get(newPath) !== wired) this.unwire(newPath);
    if (wired !== undefined) this.wired.set(newPath, wired);
    // Not after `stop()`: it has dropped every subscription and cancelled
    // every snapshot already.
    if (this.hasStopped) return;
    if (wired === undefined && meta.fileType === 'TEXT' && docs.has(this.binding.id, newPath)) {
      this.wire(meta.fileId, newPath);
    }
    if (pending === undefined) return;
    pending.cancel();
    this.scheduleSnapshotToDisk(newPath);
  }

  /**
   * After a note's doc was moved (see `DocManager.move`): a history that was
   * under the old name and did not come along — a store that did not load in
   * time, or one stamped for another file — leaves the fold marker naming
   * disk content that may have been only in it. Set back to the last synced
   * content, the next fold merges the disk three-way against a verified base
   * instead of taking it as folded: a catch-up would otherwise overwrite an
   * edit folded while offline.
   *
   * Only then. With nothing under the old name — a note whose disk matched
   * the server, so the catch-up never opened its doc; a store lost to a
   * cleared IndexedDB; one a build before 0.3.8 left under an earlier name —
   * the marker is right as it is, and set back it made the next fold merge a
   * disk that already matched the server against an older base: a teammate's
   * edit arriving next was deleted for everyone, or the note's own last edit
   * doubled.
   *
   * Nor the marker of any other file: a history of another file found under
   * either name is a leftover, and that file's live doc is under its own name.
   */
  private afterDocMove(log: OperationLog, meta: IndexedMeta, moved: MoveResult): void {
    if (moved.found && !moved.carried) this.forgetFoldedEdits(log, meta.fileId);
  }

  /**
   * Stop trusting what file `fileId` had folded into its doc: its fold marker
   * goes back to the last synced content, in the index and in `state.json`.
   * `log` is the unfenced one inside a {@link commitLocal} block.
   */
  private forgetFoldedEdits(log: OperationLog, fileId: string): void {
    this.foldBases.delete(fileId);
    const reset = (meta: FileMeta): boolean => {
      if (meta.fileType !== 'TEXT' || meta.foldedHash === undefined) return false;
      if (meta.foldedHash === meta.contentHash) return false;
      meta.foldedHash = meta.contentHash;
      return true;
    };
    const live = this.fileIndex.byId.get(fileId);
    if (live && reset(live)) log.setFileMeta(live);
    for (const recorded of log.listFileMeta(this.binding.id)) {
      if (recorded.serverFileId !== fileId) continue;
      if (live && recorded.relativePath === live.relativePath) continue;
      if (reset(recorded)) log.setFileMeta(recorded);
    }
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
   * A path is logged at `warn` the first time the binding's engines refuse it
   * while the plugin runs, and at `debug` after that. The file index is
   * re-read on every reconnect, and the `.DS_Store` files an older version
   * uploaded — one per folder a Mac user opened in Finder — otherwise filled
   * `sync.log` with the same lines on each one, crowding out the entries worth
   * reading. The set of reported paths outlives the engine (see
   * `SyncEngineDeps.reportedRefusals`): pausing and resuming sync runs a new
   * engine, which must not report them all again.
   *
   * A path counts as reported only once its `warn` line is written. With Log
   * level set to Errors only that line is dropped, and a path remembered all
   * the same never showed at `warn`: the set outlives the engine, so neither a
   * resume nor switching the binding off and on brought it back. Left out of
   * the set, it is logged at the first reconnect or resume after the level
   * goes up.
   */
  private allowServerPath(
    path: string,
    context: string,
    opts: { requireBinding?: boolean } = {},
  ): boolean {
    return this.refuseServerPath(path, context, opts) === null;
  }

  /** {@link allowServerPath} that says why: `null` when the path may be used. */
  private refuseServerPath(
    path: string,
    context: string,
    opts: { requireBinding?: boolean } = {},
  ): PathRejection | null {
    const rejection = checkVaultPath(path, {
      ...(opts.requireBinding === false ? {} : { bindingFolder: this.binding.localFolder }),
      configDir: this.configDir,
    });
    if (rejection === null) return null;
    const details = { context, path, reason: rejection, configDir: this.configDir };
    const key = `${rejection}\u0000${path}`;
    if (this.reportedRefusals.has(key)) {
      this.log.debug('refused a path supplied by the server', details);
      return rejection;
    }
    // Refused either way; recorded only once the warn line is really written.
    if (!this.log.isEnabled('warn')) return rejection;
    // Paths come from the server: cap the memory they can take.
    if (this.reportedRefusals.size >= MAX_REPORTED_REFUSALS) this.reportedRefusals.clear();
    this.reportedRefusals.add(key);
    this.log.warn('refused a path supplied by the server', details);
    return rejection;
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
      await this.applyServerFileEvent(event);
      this.noteAppliedLive(event);
    } catch (err) {
      // Cut short by `stop()` — not a failure to apply.
      if (this.hasStopped) return;
      this.setStatus('error', describeError(err, 'apply_failed'));
    }
  }

  /**
   * Remember a file broadcast as applied here (see
   * `OperationLog.noteAppliedLive`): the next catch-up returns its operation
   * again, and it is not taken for one that happened while this device was
   * away (see {@link applyServerOperation} and {@link notesRecreated}).
   *
   * Only the operations the catch-up looks up so: creates, renames and moves.
   * An attachment update replayed finds its version synced here by its hash,
   * and a delete replayed finds nothing to delete. Remembered all the same,
   * the updates of an attachment a teammate kept saving (a canvas, by the
   * hundred a day) pushed the rest out of the list (see `APPLIED_LIVE_MAX`).
   */
  private noteAppliedLive(event: SocketFileEvent): void {
    if (event.type !== 'created' && event.type !== 'renamed' && event.type !== 'moved') return;
    const log = event.log as Partial<ServerLogEntry> | undefined;
    if (typeof log?.id !== 'string' || log.id === '') return;
    this.operationLog.noteAppliedLive(this.binding.id, log.id);
  }

  private async applyServerFileEvent(event: SocketFileEvent): Promise<void> {
    // The server sends each operation to its sender too, before the ack.
    // This device's own: the ack does what is left to do.
    const own = this.isOwnBroadcast(event);
    if (own && event.type !== 'renamed' && event.type !== 'moved') return;
    // From a server that does not say who sent it: an attachment upload
    // this device has on its way. Taken for a teammate's, the version just
    // uploaded was downloaded again and written over a newer one saved
    // meanwhile.
    if (
      event.type === 'updated-binary' &&
      event.clientId === undefined &&
      this.binaryUploads.get(event.fileId)?.includes(event.contentHash) === true
    ) {
      return;
    }
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
        await this.applyServerCreate(
          {
            id: outcome.fileId,
            path: outcome.path,
            // Server doesn't ship the file type; classify locally. Good
            // enough for the markdown / text vs. binary split we care
            // about here.
            fileType: classifyFileType(outcome.path),
          },
          // Another client's, or before this device sent a create of the
          // name: not its own, which a server without `clientId` sends
          // back too.
          {
            foreign: event.clientId !== undefined || !this.ownCreates.has(outcome.path),
          },
        );
        break;
      }
      case 'updated-binary':
        await this.applyServerUpdateBinary(event.fileId, event.contentHash);
        break;
      case 'deleted':
        await this.applyServerDelete(event.fileId);
        break;
      case 'renamed':
      case 'moved':
        await this.handleServerRename(event.fileId, event.newPath, event.outcome, own);
        break;
    }
  }

  /**
   * Whether a file broadcast is this device's own: it carries this device's
   * client id, and the operation is on its way from here — sent and not
   * acknowledged yet, which is when the server broadcasts it back.
   *
   * The id alone does not tell. A vault copied to another computer along with
   * its `data.json` takes the id with it, and the copy's operations came back
   * as this device's own: its new notes, deletes and renames did not reach
   * this device until the next connect. A broadcast under this device's id
   * that it has nothing on its way for is the other device's, and is applied.
   */
  private isOwnBroadcast(event: SocketFileEvent): boolean {
    if (event.clientId !== this.clientId) return false;
    let sent: boolean;
    switch (event.type) {
      case 'created': {
        const outcome = (event.result as { outcome?: { path?: unknown; originalPath?: unknown } })
          ?.outcome;
        const asked = outcome?.path ?? outcome?.originalPath;
        sent = typeof asked === 'string' && this.ownCreates.has(asked);
        break;
      }
      case 'deleted':
        sent = this.ownDeletes.has(event.fileId);
        break;
      case 'updated-binary':
        sent = this.binaryUploads.get(event.fileId)?.includes(event.contentHash) === true;
        break;
      case 'renamed':
      case 'moved':
        sent = this.renamePendingHere(event.fileId);
        break;
    }
    if (!sent && !this.twinReported) {
      this.twinReported = true;
      this.log.warn(
        'a file event carries this device’s client id, but this device did not send it: another device uses the same id (a vault copied along with its data.json?)',
        { type: event.type },
      );
    }
    return sent;
  }

  /**
   * `file:create`, with its path in {@link ownCreates} until the ack comes
   * (or the emit fails).
   */
  private async emitCreate(payload: FileCreatePayload): Promise<Ack> {
    const path = payload.filePath;
    this.ownCreates.set(path, (this.ownCreates.get(path) ?? 0) + 1);
    try {
      return await this.socket.emitFileCreate(payload);
    } finally {
      countDown(this.ownCreates, path);
    }
  }

  /** `file:delete`, with its file id in {@link ownDeletes} until the ack comes. */
  private async emitDelete(payload: FileDeletePayload): Promise<Ack> {
    const { fileId } = payload;
    this.ownDeletes.set(fileId, (this.ownDeletes.get(fileId) ?? 0) + 1);
    try {
      return await this.socket.emitFileDelete(payload);
    } finally {
      countDown(this.ownDeletes, fileId);
    }
  }

  /**
   * A `file:renamed` / `file:moved` broadcast. The server sends it to the
   * whole room, the sender included, right before the ack.
   *
   * Applied as it came, this device's own renames came back to it. Since
   * 0.3.8 a rename made offline records the note under its new name at once,
   * so the broadcast of a step of a chain sent from the queue (`a → b`, then
   * `b → c`) moved the note on disk back to `b` — parking another note found
   * there aside as a conflict copy, uploaded as a duplicate — and, with
   * Obsidian's echo of that move, the server renamed the note `b ↔ c` for
   * good. So:
   *
   *   - This device's own rename (`own`, see {@link isOwnBroadcast}) is left
   *     alone: the note is where this device put it, or where it has moved it
   *     since. Unless the server stored it under a conflict name, where it
   *     follows.
   *   - A rename of a file whose own rename is queued or on its way here is
   *     left alone too: the server applies that one after it, and it wins.
   *     From a server that does not send `clientId`, this is also how this
   *     device's own renames are told apart: the server broadcasts a rename
   *     before it acknowledges it, on the same connection, so the broadcast
   *     always finds it on its way. One that finds no rename on its way is a
   *     teammate's — a rename back to a name the note had here earlier too.
   *   - A rename is applied under the name the server stored the file at.
   *     A server without `clientId` broadcast the name asked for, even when
   *     it stored the file under a conflict name; `outcome` has that one.
   */
  private async handleServerRename(
    fileId: string,
    newPath: string,
    outcome: unknown,
    own: boolean,
  ): Promise<void> {
    const stored = storedRenamePath(newPath, outcome);
    if (own) {
      await this.followStoredRename(fileId, outcome);
      return;
    }
    if (this.renamePendingHere(fileId)) {
      this.log.debug('server rename left to a local rename of the same file', { fileId, stored });
      return;
    }
    await this.applyServerRename(fileId, stored);
  }

  /**
   * A rename this device sent that the server stored under a conflict name
   * (the name was taken there by a file this device had not heard of yet):
   * the note follows it there. Called with the outcome of the broadcast of
   * this device's own rename (see {@link handleServerRename}) and with the
   * ack's: a server that does not send `clientId` is heard only through the
   * ack — its broadcast arrives while the rename is on its way, and is left
   * alone. Left at the name asked for, the note stayed there until the next
   * connect, and the file the server has under that name did not reach this
   * device until then.
   */
  private async followStoredRename(fileId: string, outcome: unknown): Promise<void> {
    const conflict = conflictPlacement(outcome);
    if (conflict === null || conflict.stored === conflict.asked) return;
    const meta = this.fileIndex.byId.get(fileId);
    if (meta === undefined || meta.relativePath !== conflict.asked) return;
    this.log.info('own rename stored under a conflict name', {
      path: meta.relativePath,
      stored: conflict.stored,
    });
    await this.applyServerRename(fileId, conflict.stored);
  }

  /** Whether a rename of `fileId` made here is on its way to the server or queued. */
  private renamePendingHere(fileId: string): boolean {
    if ((this.localRenames.get(fileId) ?? 0) > 0) return true;
    return this.operationLog
      .dequeueOperations(this.binding.id)
      .some((op) => isQueuedMove(op) && queuedFileId(op.payload) === fileId);
  }

  private handleServerYjsUpdate(msg: YjsUpdateMessage): void {
    if (this.hasStopped) return;
    const meta = this.fileIndex.byId.get(msg.fileId);
    if (!meta) return;
    const docPath = this.docPathOf(meta);
    if (this.historyLeaving(docPath, meta.fileId)) {
      // The doc under the name is still the history of a note renamed away
      // from it: applied now, this update would go into that note's text.
      this.detach(
        this.withPathLock(docPath, () => {
          this.handleServerYjsUpdate(msg);
          return Promise.resolve();
        }),
      );
      return;
    }
    if (!this.lineageChecked.has(meta.fileId) && this.canFetch()) {
      this.applyAfterLineageCheck(meta, msg);
      return;
    }
    this.rememberBaseBeforeRemote(meta, docPath);
    this.docManager.applyRemoteUpdate(this.binding.id, docPath, msg.update);
    this.scheduleSnapshotToDisk(meta.relativePath);
  }

  /**
   * A teammate's edit to a note whose history here has not been checked
   * against the server's in this connect (see {@link checkLineage}): most
   * often one the catch-up skipped because the disk matched the server. The
   * history is checked first, against the server's doc fetched for it, and
   * the edit applied after; edits arriving meanwhile wait in order.
   *
   * Applied at once, the edit gave the history here a client in common with
   * the server's, and the check that followed took them for one history: a
   * note deleted and created again under its name while this device was away
   * got the deleted note's text back, for the whole team, as soon as a
   * teammate typed into it during the catch-up.
   */
  private applyAfterLineageCheck(meta: IndexedMeta, msg: YjsUpdateMessage): void {
    const waiting = this.liveUpdatesWaiting.get(meta.fileId);
    if (waiting !== undefined) {
      waiting.push(msg);
      return;
    }
    const queue = [msg];
    this.liveUpdatesWaiting.set(meta.fileId, queue);
    const check = this.checkLineageLive(meta.fileId).catch((err: unknown) => {
      if (!this.hasStopped) {
        this.log.debug('lineage check before a teammate’s edit failed', meta.relativePath, err);
      }
    });
    this.detach(
      check.then(() => {
        this.liveUpdatesWaiting.delete(meta.fileId);
        if (this.hasStopped) return;
        // Checked, or it could not be: either way the edits go in now.
        this.lineageChecked.add(meta.fileId);
        for (const waited of queue) this.handleServerYjsUpdate(waited);
      }),
    );
  }

  /** The check of {@link applyAfterLineageCheck}: the server's doc, fetched and merged in. */
  private async checkLineageLive(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (meta === undefined) return;
    const fetched = await this.fetchServerDoc(meta);
    if (fetched === null) return;
    await this.withPathLock(this.docPathOf(meta), async () => {
      const current = this.fileIndex.byId.get(fileId);
      if (current === undefined) return;
      await this.openDoc(current);
      await this.applyFetchedDoc(current, fetched);
    });
  }

  /** Whether `yjs:fetch` can be asked now. */
  private canFetch(): boolean {
    return this.socket.isConnected() && !this.yjsFetchUnavailable;
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
   *
   * The catch-up also returns what this device applied live (see
   * `OperationLog.noteAppliedLive`): a live broadcast does not move the
   * clock. A rename applied so is not applied again: replayed, it moved the
   * note back from where this device had renamed it since. An attachment
   * update replayed finds the version it brought synced here already (see
   * `applyServerUpdateBinary`); it wrote that version over an edit made here
   * since, which then went nowhere — its bytes "unchanged".
   */
  private async applyServerOperation(op: ServerOperation, catchup: Catchup): Promise<void> {
    const live = catchup.appliedLive.has(op.id);
    switch (op.opType) {
      case 'CREATE': {
        const payload = (op.payload ?? {}) as { fileType?: FileType; fileId?: string };
        const fileId = payload.fileId ?? this.fileIndex.byPath.get(op.filePath)?.fileId ?? '';
        if (!fileId) break;
        // Stale-CREATE guard: if `fileId` isn't currently on the server
        // (per `refreshFileIndex`), the file was created and later
        // deleted; re-applying would inflate the index with a phantom
        // entry (TEXT) or 404 on the binary download.
        //
        // The same check keeps out files of other folders: the index holds
        // this binding's files only. By id, not by the path the file was
        // created at — a binary created elsewhere and moved into the folder
        // since is ours now, and its MOVE is skipped as already applied, so
        // this CREATE is the one chance to download it.
        const known = this.fileIndex.byId.get(fileId);
        if (!known) break;
        await this.applyServerCreate({
          id: fileId,
          path: op.filePath,
          fileType: known.fileType,
        });
        break;
      }
      case 'UPDATE': {
        const payload = (op.payload ?? {}) as { fileId?: unknown; contentHash?: unknown };
        const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
        if (!fileId) break;
        // Stale-UPDATE guard: same logic — if the file is gone from the
        // server, the binary download will 404 and crash the catch-up.
        const meta = this.fileIndex.byId.get(fileId);
        if (!meta) break;
        // A note's text comes with its doc, in this same catch-up. A server
        // before 0.3.8's lists the UPDATE of a note written through REST or
        // MCP; replayed as an attachment's, its bytes were downloaded and
        // compared over the merge of the doc — a "content conflict" whose
        // every answer did worse than the merge.
        if (meta.fileType === 'TEXT') break;
        // A later update of the file in this catch-up brings what the server
        // has now; this one's version is gone (see `supersededOps`).
        if (catchup.superseded.has(op)) break;
        await this.applyServerUpdateBinary(
          fileId,
          typeof payload.contentHash === 'string' ? payload.contentHash : undefined,
        );
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
        if (!meta || live) break;
        if (meta.relativePath === op.newPath) break;
        // A later rename in this catch-up moves the file on, so this name is
        // history: applied, it would move the local copy there and back — or,
        // for a name this client never writes, delete it and fetch it again.
        if (catchup.superseded.has(op)) break;
        // The listing has the file under a name none of this catch-up's
        // renames of it starts from: a rename after them moved it on — this
        // device's own, which the catch-up leaves out once a later operation
        // of this device's clock covers it. Applied, this one moved the note
        // back from where the user had renamed it.
        const listed = this.lastListing.get(fileId)?.path;
        if (
          listed !== undefined &&
          listed !== op.newPath &&
          catchup.renamedFrom.get(fileId)?.has(listed) !== true
        ) {
          this.log.debug('catch-up rename skipped: the file has moved on since', {
            fileId,
            to: op.newPath,
            listed,
          });
          break;
        }
        // Left under its old name by the index refresh (see
        // `applyRenamesWhileAway`): a file locked by another program, or one
        // whose new name that file still holds. Tried again here, it failed
        // the whole connect, or took over the name of the file in its way.
        if (this.renamesLeft.has(fileId)) break;
        // Renamed on this device as well, and the queue sends that rename
        // next (see `queuedRenames`): applied, this one moved the file there
        // and the replay moved it back.
        if (this.renamedHere.has(fileId)) break;
        await this.applyServerRename(fileId, op.newPath);
        break;
      }
    }
    if (op.vectorClock) {
      this.vectorClock = mergeClocks(this.vectorClock, op.vectorClock);
    }
  }

  /**
   * Attachments checked against the listing, after a catch-up that may have
   * left operations out: a server that gives the window of the journal's
   * first 500 rows (every server before 0.3.8's; a project with a longer
   * journal gets no new operations from it at all), or a catch-up cut short
   * to its newest operations. An attachment reaches this device only through
   * its CREATE or UPDATE — neither the listing nor the docs carry its bytes.
   *
   * One missing here is downloaded: its CREATE was left out, and it never
   * came. Not only one new to this device (see {@link newHere}): the index
   * refresh records a listed file at once, so one whose download failed (a
   * server error, the connection lost, Pause) was not new at the next
   * connect and never came — nor did one an older version recorded without
   * downloading it. One the server has changed since this device synced it
   * goes through the update of its new version (see
   * {@link applyServerUpdateBinary}): with an edit made here meanwhile, the
   * user is asked. Left to the queue, that edit went out over the teammate's
   * version, which was lost for everyone.
   */
  private async reconcileAttachments(): Promise<void> {
    for (const meta of [...this.fileIndex.byId.values()]) {
      if (meta.fileType !== 'BINARY') continue;
      const listed = this.lastListing.get(meta.fileId);
      if (listed === undefined) continue;
      // Deleted since the pass began: not brought back.
      if (this.fileIndex.byId.get(meta.fileId) !== meta) continue;
      try {
        if (!(await this.vault.exists(meta.relativePath))) {
          await this.applyServerCreate({
            id: meta.fileId,
            path: meta.relativePath,
            fileType: 'BINARY',
          });
        } else if (listed.contentHash !== meta.contentHash) {
          await this.applyServerUpdateBinary(meta.fileId, listed.contentHash);
        }
      } catch {
        // The next connect checks again.
        this.throwIfStopped();
      }
      this.throwIfStopped();
    }
  }

  /**
   * `released`: the name was free when {@link releaseName} let the file in.
   * `foreign`: see {@link WaitingForName}.
   */
  private async applyServerCreate(
    payload: {
      id: string;
      path: string;
      fileType: FileType;
    },
    opts: { released?: boolean; foreign?: boolean } = {},
  ): Promise<void> {
    // Catch-up CREATE replays hit files `refreshFileIndex` already indexed
    // (the stale-CREATE guard requires it). Reuse that entry — resetting
    // its contentHash/size to zero would break every downstream three-way
    // compare (`detectBinaryConflict`, `foldDiskEditsIntoDoc`, the
    // unhydrated-doc guard in `handleLocalModify`).
    const known = this.fileIndex.byId.get(payload.id);
    // The path the file lives at NOW. A catch-up CREATE carries the path the
    // file was created at, and a later rename in the same catch-up is skipped
    // as already applied — the listing has the new name. Writing a binary at
    // the old one left the new name missing and the old one for `initialPush`
    // to upload as a second file (or, with the old name taken by another file
    // since, put these bytes under that file's name).
    const path = known?.relativePath ?? payload.path;
    // Mirror of the refreshFileIndex filter for live events: never
    // materialise a throw-away artifact another client uploaded.
    if (!this.allowServerPath(path, 'create')) return;
    if (
      !known &&
      opts.released !== true &&
      (this.creating.has(path) || this.ownCreates.has(path))
    ) {
      // This device is creating a file under the name, not recorded yet: its
      // own create coming back from a server without `clientId`, or another
      // device's the server applied first. Indexed now, it took the copy here
      // for its own, and the first snapshot folded that copy into it — its
      // text replaced for everyone. It waits for the create's ack: this
      // device's file is recorded then, under the name or the conflict name
      // the server gave it, and the name is let go (see `recordCreateAck`).
      this.log.info('a file the server has under a name being created here waits for it', {
        fileId: payload.id,
        path,
      });
      this.outOfScope.set(payload.id, { path, fileType: payload.fileType });
      this.waitingForName.set(path, {
        kind: 'create',
        fileId: payload.id,
        path,
        fileType: payload.fileType,
        foreign: opts.foreign === true,
      });
      return;
    }
    const holder = known ? undefined : this.nameHolder(path);
    if (holder !== undefined) {
      // Another file's copy is under the name here (see `waitForName`): taken
      // for this file's, a note's first snapshot folded it in without a base,
      // and its text went to the server as this one's. Known by id meanwhile.
      this.outOfScope.set(payload.id, { path, fileType: payload.fileType });
      this.waitForName(
        { kind: 'create', fileId: payload.id, path, fileType: payload.fileType },
        holder,
      );
      return;
    }
    const meta: IndexedMeta = known ?? {
      bindingId: this.binding.id,
      relativePath: path,
      serverFileId: payload.id,
      fileId: payload.id,
      contentHash: '',
      size: 0,
      fileType: payload.fileType,
      lastSyncedAt: Date.now(),
    };
    this.fileIndex.byPath.set(path, meta);
    this.fileIndex.byId.set(payload.id, meta);

    // The copy of a file deleted while away, which the user is being asked
    // about, is on disk under this name: kept aside first. Taken for this
    // file's, a note's first snapshot folded it in without a base — its text
    // over the new note's, for everyone — and a binary counted it as synced.
    // Under the path's lock, taken now: the snapshot of the note's first
    // update waits for it.
    const setAside =
      !known && this.awayCopies.has(path)
        ? this.withPathLock(path, () => this.keepAwayCopyAside(path))
        : null;

    // Pull initial bytes — Yjs takes over for text after the first
    // snapshot, but the file on disk needs to exist.
    if (payload.fileType === 'TEXT') {
      // New here: a doc under this name is another note's history. Dropped
      // right away, before the update that follows the event lands on it. A
      // catch-up CREATE of a file the listing gave us keeps the doc it has,
      // and leaves it closed: the catch-up of its doc opens it when the disk
      // differs from the server's text. Wired here, every note created since
      // the clock — the whole project, for a new device — got a doc and a
      // database at once, and the catch-up could no longer skip a note whose
      // disk matched the server (see `catchupDocIsRedundant`).
      if (!known) await this.startDoc(payload.id, path);
      await setAside;
    } else {
      await setAside;
      // Catch-up replays can fire applyServerCreate for a binary file the
      // client already has on disk (synced earlier). `createBinary` throws
      // on existing paths, so just bail — meta is already up-to-date from
      // refreshFileIndex.
      if (await this.vault.exists(path)) return;
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
        io.echo.mark(path, ECHO_COUNT_CREATE);
        await io.vault.ensureParentFolder(path);
        await io.vault.createBinary(path, buf);
      });
    }
  }

  /**
   * Move the copy at `path` of a file deleted while away aside, under a
   * conflict name (see {@link applyServerCreate}): it may hold edits the
   * server never got, which is why the user is asked about it. The question
   * finds the name taken and decides nothing; the next connect's first upload
   * sends the copy as a file of its own.
   */
  private async keepAwayCopyAside(path: string): Promise<void> {
    try {
      await this.commitLocal(async (io) => {
        if (!(await io.vault.exists(path))) return;
        const aside = buildConflictPath(path, this.now());
        this.log.warn('a file was created again under the name of a copy being asked about', {
          path,
          aside,
        });
        io.echo.mark(path, ECHO_COUNT_RENAME);
        io.echo.mark(aside, ECHO_COUNT_RENAME);
        await io.vault.ensureParentFolder(aside);
        await this.renameOnDisk(io, path, aside);
      });
    } catch (err) {
      // Stopped, or the file is locked: the question still sees the copy.
      if (!this.hasStopped) {
        this.log.warn('could not keep a copy aside', {
          path,
          error: describeError(err, 'rename_failed'),
        });
      }
    }
  }

  /**
   * An attachment's new version on the server: downloaded and written here,
   * through the conflict modal when the copy here has changed too.
   * `versionHash`: the content the update brought, when the broadcast or the
   * catch-up operation says.
   */
  private async applyServerUpdateBinary(fileId: string, versionHash?: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    // Before the download: a refused path shouldn't cost a multi-megabyte
    // transfer. An entry can predate the gate — it comes back from
    // `state.json` written by an older build.
    if (!this.allowServerPath(meta.relativePath, 'update')) return;
    // The version this device last synced: nothing to download. A catch-up
    // replays every update since the clock, those this device downloaded or
    // uploaded itself included.
    if (versionHash !== undefined && versionHash !== '' && versionHash === meta.contentHash) {
      return;
    }
    const newBuf = await this.downloadFile(fileId);
    this.throwIfStopped();
    const newHash = await sha256Hex(newBuf);
    /** Where `keep-both` parks the local edits. */
    let aside: string | null = null;

    // Conflict detection — only triggers when the user has uncommitted edits.
    // Stopped anywhere up to the write below, nothing has changed yet: the
    // next catch-up replays this UPDATE and starts over.
    if (await this.vault.exists(meta.relativePath)) {
      // The server still has what this device last synced: the copy here is
      // that version, or an edit of it made since, which is the newer one and
      // goes out with the queue. Written over, the edit was lost — and its
      // queued update then found the bytes "unchanged" and sent nothing.
      if (newHash === meta.contentHash) return;
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
              await this.emitBinaryUpdate({
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
        await this.renameOnDisk(io, path, parkAt);
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
    this.forgetWaiting(fileId);
    this.deletedSinceListing.add(fileId);
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const holder = this.fileIndex.byPath.get(meta.relativePath);
    if (holder !== undefined && holder.fileId !== fileId) {
      // The name has gone to another file since: a note renamed onto it here
      // while this file's delete, made here too, was on its way — a server
      // that does not send `clientId` broadcasts that delete back before its
      // ack. The copy under the name is the other file's: taken for this
      // one, it was deleted, or the user was asked whether to delete it.
      await this.commitLocal(async (io) => {
        if (this.fileIndex.byId.get(fileId) === meta) this.fileIndex.byId.delete(fileId);
        this.forgetRecord(io.log, fileId, meta.relativePath);
        await this.dropDoc(io.docs, fileId, meta.relativePath);
      });
      return;
    }
    // Deleting is a write too: a stale index entry naming the config folder
    // must not let the server erase files there.
    if (!this.allowServerPath(meta.relativePath, 'delete')) return;
    const path = meta.relativePath;
    await this.dropLocalCopy(meta, null);
    // The name the file left may be what another file waits for.
    if (this.fileIndex.byPath.get(path) !== meta) await this.releaseName(path);
  }

  /**
   * The local copy of a file that has left what this client syncs: deleted on
   * the server (`movedTo` null), or renamed there to `movedTo`, a name this
   * client never writes (see {@link retireMovedAway}).
   *
   * `ask: false` leaves a copy that may hold unsent edits as it is and returns
   * `'ask'`: the caller asks later, once nothing else waits on it. `away`: the
   * copy is of a file deleted while this device was away, which the index no
   * longer has (see {@link deletedWhileAway}). A file indexed under its name
   * or its id since — the note revived, or created anew under the name — owns
   * the copy now, and it is left to that file: checked in each local phase,
   * after every wait.
   */
  private async dropLocalCopy(
    meta: IndexedMeta,
    movedTo: string | null,
    opts: { pushedBack: boolean; serverHad?: string; ask?: boolean; away?: boolean } = {
      pushedBack: true,
    },
  ): Promise<'done' | 'ask'> {
    const taken = (): boolean =>
      opts.away === true &&
      (this.fileIndex.byId.has(meta.fileId) || this.fileIndex.byPath.has(meta.relativePath));
    // One local phase, from the check to the delete. A delete stopped before
    // it reaches the disk is not replayed: the next catch-up no longer finds
    // the file in the listing and has nothing to apply it to, so the local
    // copy would stay behind, never synced again. Only a conflict leaves the
    // phase — to ask the user, which can take any time.
    const conflict = await this.commitLocal(async (io) => {
      if (taken()) return null;
      // Delete-vs-update guard: if the local file still exists and has
      // uncommitted edits, ask the user before clobbering them.
      if (await io.vault.exists(meta.relativePath)) {
        const localBuf = await io.vault.readBinary(meta.relativePath);
        const localHash = await sha256Hex(localBuf);
        // The server had this very content: nothing to lose. Changed since
        // that was looked up, the copy is asked about.
        if (
          localHash !== opts.serverHad &&
          this.mayHoldUnsentEdits(meta, localHash, opts.pushedBack)
        ) {
          return { localBuf, localHash };
        }
      }
      await this.removeLocalCopy(io, meta, movedTo);
      return null;
    });
    if (!conflict) return 'done';
    if (opts.ask === false) return 'ask';

    const { localBuf, localHash } = conflict;
    if (movedTo !== null) this.movedAway.set(meta.fileId, movedTo);
    const resolution = await this.conflictResolver.resolveDeleteConflict({
      filePath: meta.relativePath,
      localSize: localBuf.byteLength,
    });
    this.throwIfStopped();
    // Another file holds the name now; the copy, if still there, is its own
    // business (see `applyServerCreate`).
    if (taken()) return 'done';
    if (movedTo !== null) {
      // Where the server has the file now: a later rename to another name we
      // never write moves it on, one to a name we sync ends the question.
      const away = this.movedAway.get(meta.fileId);
      this.movedAway.delete(meta.fileId);
      // Renamed to a name we sync while the user was deciding: that rename
      // took the local copy along, and nothing is left to decide.
      if (away === undefined) return 'done';
      if (resolution === 'restore-server') {
        await this.restoreMovedAway(meta, away);
        return 'done';
      }
      await this.commitLocal((io) => this.removeLocalCopy(io, meta, away));
      return 'done';
    }
    if (resolution === 'restore-server') {
      // Push the local content as a fresh CREATE so the server
      // un-deletes it. The recipient broadcast will reset our state.
      if (this.socket.isConnected()) {
        try {
          const data = await this.stageBinaryBlob(meta.fileType, localHash, localBuf);
          this.throwIfStopped();
          const ack = await this.emitCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            filePath: meta.relativePath,
            fileType: meta.fileType,
            contentHash: localHash,
            size: localBuf.byteLength,
            ...(data !== undefined ? { data } : {}),
          });
          this.throwIfStopped();
          const outcome = ack.ok
            ? (ack as { outcome?: { fileId?: string; path?: string } }).outcome
            : undefined;
          if (outcome?.fileId && outcome.path) {
            // The server revived the file under its id from this copy, the way
            // a note created here starts: recorded from the ack, its doc and
            // store dropped — by the exact name — for the server's. Kept, the
            // note's history here met the server's again on the next connect:
            // a server that continues the history on revival has this copy's
            // text in it once more, and the edits not sent before came back
            // doubled; one that replaces it merged the two. And unindexed, the
            // next save went out as a second CREATE.
            await this.recordCreatedFile(
              outcome.fileId,
              outcome.path,
              meta.fileType,
              localHash,
              localBuf.byteLength,
            );
            this.persistVectorClock();
          }
        } catch {
          this.throwIfStopped();
          this.log.debug('restore-server push failed; reconcile on reconnect', meta.relativePath);
        }
      }
      // Don't drop the local copy — we want the file to stay.
      return 'done';
    }
    // 'delete-local'.
    await this.commitLocal((io) => this.removeLocalCopy(io, meta));
    return 'done';
  }

  /**
   * Whether the local copy of a file may hold edits the server does not have
   * — the question before a server delete, or a rename this client cannot
   * follow, removes it.
   *
   * `contentHash` is the last content synced for a binary. For a note it is
   * the last content a snapshot wrote or the listing named: a save does not
   * move it — the save is folded into the doc and goes to the server from
   * there. So a note whose disk matches the fold marker has nothing unsent
   * either, and asking about it offered to undo a teammate's delete or
   * rename over edits the server already had. Only once connected, though:
   * until the catch-up has pushed the doc back, a save folded while offline
   * has not reached the server. `pushedBack: false` for a note the catch-up
   * did not push back at all — one deleted on the server while away.
   */
  private mayHoldUnsentEdits(meta: IndexedMeta, localHash: string, pushedBack = true): boolean {
    if (!detectDeleteConflict({ storedHash: meta.contentHash, localHash })) return false;
    if (meta.fileType !== 'TEXT' || this.status !== 'connected' || !pushedBack) return true;
    return localHash !== meta.foldedHash;
  }

  /**
   * Delete the local copy of a file the server deleted, bookkeeping included.
   * `movedTo`: the file was renamed to a name this client never writes; it is
   * remembered by id there, so a rename back is recognised.
   */
  private async removeLocalCopy(
    io: LocalIO,
    meta: IndexedMeta,
    movedTo: string | null = null,
  ): Promise<void> {
    const path = meta.relativePath;
    // One delete fires Obsidian onDelete + chokidar `unlink`.
    io.echo.mark(path, ECHO_COUNT_DELETE);
    if (await io.vault.exists(path)) {
      await io.vault.delete(path);
    }
    this.forgetPath(io.log, meta.fileId, path);
    // Only its own entry: a record left by a file deleted while away is not
    // what the index has under this id.
    if (this.fileIndex.byId.get(meta.fileId)?.relativePath === path) {
      this.fileIndex.byId.delete(meta.fileId);
    }
    if (movedTo !== null) {
      this.outOfScope.set(meta.fileId, { path: movedTo, fileType: meta.fileType });
    }
    await this.dropDoc(io.docs, meta.fileId, path);
  }

  /**
   * `away`: a rename made while this device was away, applied by the index
   * refresh (see {@link applyRenamesWhileAway}), with what the listing says the
   * server has of the file.
   */
  private async applyServerRename(
    fileId: string,
    newPath: string,
    away?: { serverHash: string },
  ): Promise<void> {
    // Hard checks first — they hold wherever the file ends up. The binding is
    // NOT one of them: a rename is the server telling us a file we already
    // sync has moved, and refusing it would leave our copy behind for
    // `initialPush` to upload again as a brand-new file (a duplicate for the
    // whole team).
    const refused = this.refuseServerPath(newPath, 'rename', { requireBinding: false });
    if (refused !== null) {
      // A name on the ignore list, or one Windows opens as another file: the
      // file has left what this client syncs. A path that is garbage instead
      // (`../x`, `/etc/x`) changes nothing here.
      if (refused === 'ignored' || refused === 'invalid') {
        await this.retireMovedAway(fileId, newPath, away);
      }
      return;
    }
    // Back to a name we sync while the user is still asked about the local
    // copy (see `dropLocalCopy`), or before the question came (see
    // `retiredAway`): the move below takes that copy along.
    this.movedAway.delete(fileId);
    this.reindexRetired(fileId);
    // Where the server has the file now: a move it waited to make is history.
    this.forgetWaiting(fileId);
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) {
      await this.adoptRenamedFile(fileId, newPath);
      return;
    }
    const oldPath = meta.relativePath;
    // The source is metadata rather than a fresh server string, but metadata
    // can come from `state.json` written by a build without the gate.
    if (!this.allowServerPath(oldPath, 'rename source', { requireBinding: false })) return;

    // Everything from here on is one local phase, the disk checks included.
    // A rename cut anywhere in it leaves the old path on disk while the next
    // engine's listing already shows the new one: that engine counts the
    // rename as applied, writes the new path from the catch-up, and uploads
    // the old one as a brand-new file — a duplicate for the whole team.
    //
    // After a save being folded into the note under its old name, too: the
    // doc moves with the file, and a fold finishing on the old name after the
    // move would land in a doc nobody reads again. And under the new name's
    // lock: a save or snapshot there waits for the history to arrive.
    const renamedHere = this.renameCount.get(fileId) ?? 0;
    let movedMeanwhile = false;
    let holder: IndexedMeta | undefined;
    await this.withPathLocks([oldPath, newPath], () => {
      // Renamed on this device while this waited: that rename reaches the
      // server after this one, and wins there.
      if ((this.renameCount.get(fileId) ?? 0) !== renamedHere) return Promise.resolve();
      // Moved by another rename from the server while this waited (or the
      // index was rebuilt): the names looked up above are stale. Taken as
      // they were, a rename back to where the note had been was dropped as
      // already done, and a second rename to the name the note had just got
      // took the note's copy there for another file with the same content —
      // and deleted it.
      if (this.fileIndex.byId.get(fileId) !== meta || meta.relativePath !== oldPath) {
        movedMeanwhile = true;
        return Promise.resolve();
      }
      if (oldPath === newPath) return Promise.resolve();
      holder = this.nameHolder(newPath, meta);
      if (holder !== undefined) return Promise.resolve();
      return this.commitLocal((io) => this.moveLocalCopy(io, meta, newPath));
    });
    if (holder !== undefined) {
      this.waitForName({ kind: 'rename', fileId, path: newPath }, holder);
      return;
    }
    // Looked up again, under the names the note has now.
    if (movedMeanwhile) {
      await this.applyServerRename(fileId, newPath);
      return;
    }
    // The name the file left may be what another file waits for.
    if (this.fileIndex.byId.get(fileId) !== meta || meta.relativePath !== oldPath) {
      await this.releaseName(oldPath);
    }
  }

  /**
   * The file indexed here under `path`, other than `self`. As spelled: the
   * server tells names apart by case, and on a disk that does too, `Y.bin`
   * and `y.bin` are two files.
   *
   * On a disk that does not (Windows, macOS), a file indexed under the name
   * in another case holds it as well: `A.md` opens `a.md` there. Taken for a
   * free name, a teammate's `A.md` next to `a.md` parked the copy of `a.md`
   * aside while its record stayed on the name, which then opened the other
   * file: the next edit of `a.md` put that file's text into it for everyone.
   * A new note under such a name took the copy of `a.md` for its own, and its
   * first snapshot replaced its text with that one for everyone.
   */
  private nameHolder(path: string, self?: IndexedMeta): IndexedMeta | undefined {
    const holder = this.fileIndex.byPath.get(path);
    if (holder !== undefined) return holder === self ? undefined : holder;
    if (!this.caseInsensitive()) return undefined;
    const key = this.caseKey(path);
    for (const meta of this.fileIndex.byPath.values()) {
      if (meta !== self && this.caseKey(meta.relativePath) === key) return meta;
    }
    return undefined;
  }

  /**
   * The move of {@link waitingForName} into `path`, or, on a disk that takes
   * names differing only in case for one file, into `path` in another case.
   */
  private waitingFor(path: string): WaitingForName | undefined {
    const move = this.waitingForName.get(path);
    if (move !== undefined || !this.caseInsensitive()) return move;
    const key = this.caseKey(path);
    for (const [waiting, other] of this.waitingForName) {
      if (this.caseKey(waiting) === key) return other;
    }
    return undefined;
  }

  /**
   * The server has a file under a name another file still holds here: `move`
   * — renamed there, or new to this device. The file this device has under
   * the name has a rename of its own on its way to the server, which stores it
   * under a conflict name: an offline rename to a name a teammate gave
   * another note meanwhile, or two renames to one name crossing on the way.
   * The move waits for the name to be free here (see {@link releaseName}).
   *
   * It used to go ahead. The copy under the name was parked aside as an
   * anonymous conflict copy while its record went to the file moving in; the
   * rename's ack then moved the copy of the file that had moved in to the
   * conflict name, under the other file's id, and the fold pushed that text
   * into it — every teammate's copy of the note held the other note's text,
   * and the parked copy was uploaded as a duplicate.
   */
  private waitForName(move: WaitingForName, holder: IndexedMeta): void {
    this.log.info('a file’s name here is still another file’s; its move waits for it', {
      fileId: move.fileId,
      path: move.path,
      holder: holder.relativePath,
      renamedHere: this.renamePendingHere(holder.fileId),
    });
    this.waitingForName.set(move.path, move);
  }

  /** A file of {@link waitingForName} deleted or renamed on the server meanwhile. */
  private forgetWaiting(fileId: string): void {
    for (const [path, move] of this.waitingForName) {
      if (move.fileId === fileId) this.waitingForName.delete(path);
    }
  }

  /**
   * `path` is free here now: the file that held it moved on or was deleted. A
   * file that waited for the name moves in (see {@link waitForName}).
   */
  private async releaseName(path: string): Promise<void> {
    const move = this.waitingFor(path);
    if (move === undefined || this.nameHolder(move.path) !== undefined) return;
    this.waitingForName.delete(move.path);
    if (move.kind === 'rename') {
      if (!this.fileIndex.byId.has(move.fileId)) return;
      this.log.info('a file moves into the name it waited for', move);
      await this.applyServerRename(move.fileId, move.path);
      return;
    }
    if (this.fileIndex.byId.has(move.fileId) || !this.outOfScope.has(move.fileId)) return;
    this.log.info('a file moves into the name it waited for', move);
    this.outOfScope.delete(move.fileId);
    await this.applyServerCreate(
      { id: move.fileId, path: move.path, fileType: move.fileType },
      { released: true },
    );
    if (move.fileType !== 'TEXT' || this.fileIndex.byId.get(move.fileId) === undefined) return;
    // Its content never reached this device — the catch-up, or the update
    // that follows a new note's broadcast, found it out of the index: pulled
    // from the server by the snapshot.
    this.skippedDocs.add(move.fileId);
    this.scheduleSnapshotToDisk(move.path);
  }

  /**
   * The server renamed a file we sync to `newPath`, a name this client never
   * writes: on the ignore list, or one Windows opens as another file. The
   * server refuses few of those names on input, and a 0.3.7 client, the MCP
   * server or the REST API sends such renames.
   *
   * Handled like the local counterpart README describes — renaming a note to
   * a name on the list works like moving it to the trash: here the file is
   * treated as deleted on the server. Left in place, the copy under the old
   * name dropped out of the index on the next connect and `initialPush`
   * uploaded it as a new file, bringing the old name back for everyone. It is
   * never moved to `newPath` either: that could be the config folder.
   */
  private async retireMovedAway(
    fileId: string,
    newPath: string,
    away?: { serverHash: string },
  ): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) {
      // Not a file we sync; keep its shadow entry current (see `outOfScope`).
      const shadow = this.outOfScope.get(fileId);
      if (shadow) this.outOfScope.set(fileId, { ...shadow, path: newPath });
      return;
    }
    // The user is already being asked about this copy: only the name moves on.
    if (this.movedAway.has(fileId)) {
      this.movedAway.set(fileId, newPath);
      return;
    }
    if (!this.allowServerPath(meta.relativePath, 'rename source', { requireBinding: false })) {
      return;
    }
    this.log.info('file renamed to a name that is never synced; removing the local copy', {
      path: meta.relativePath,
      newPath,
    });
    if (away === undefined) {
      await this.dropLocalCopy(meta, newPath);
      return;
    }
    // Renamed while away: applied by the index refresh, and a question there
    // held the whole connect — the index, the catch-up, every other note —
    // until it was answered. Asked about once connected, and only about a copy
    // the server never had: the catch-up pushed nothing back for it.
    const serverHad = await this.serverHadCopy(meta, away.serverHash);
    const asked = await this.dropLocalCopy(meta, newPath, {
      pushedBack: false,
      ask: false,
      ...(serverHad !== null ? { serverHad } : {}),
    });
    if (asked === 'done') return;
    // Out of the index until then: the catch-up neither writes the note nor
    // folds its copy, and the name is not given to another file. Known by id,
    // so a rename back to a name we sync finds it.
    this.retiredAway.set(fileId, { meta, serverHash: away.serverHash });
    if (this.fileIndex.byPath.get(meta.relativePath) === meta) {
      this.fileIndex.byPath.delete(meta.relativePath);
    }
    if (this.fileIndex.byId.get(fileId) === meta) this.fileIndex.byId.delete(fileId);
    this.outOfScope.set(fileId, { path: newPath, fileType: meta.fileType });
  }

  /**
   * The hash of the local copy of `meta` when the server had that content:
   * `serverHash` (what it has now) or, for a note, a version in its history.
   * A note's `contentHash` moves only when a snapshot writes the file, so a
   * note edited here once differs from it for good. `null` otherwise.
   */
  private async serverHadCopy(meta: FileMeta, serverHash: string): Promise<string | null> {
    const localHash = await this.hashFile(this.vault, meta.relativePath);
    if (localHash === null || localHash === meta.contentHash) return null;
    if (localHash === serverHash) return localHash;
    if (meta.fileType !== 'TEXT') return null;
    return (await this.serverHadVersion(meta.serverFileId, localHash)) ? localHash : null;
  }

  /**
   * A file renamed while away whose question waits (see {@link retiredAway})
   * goes back into the index under its old name — renamed back to a name we
   * sync, or when the question comes. `false` when it was not waiting, or
   * another file holds the name now.
   */
  private reindexRetired(fileId: string): boolean {
    const retired = this.retiredAway.get(fileId);
    if (retired === undefined) return false;
    this.retiredAway.delete(fileId);
    const { meta } = retired;
    if (this.fileIndex.byId.has(fileId) || this.fileIndex.byPath.has(meta.relativePath)) {
      return false;
    }
    this.outOfScope.delete(fileId);
    this.fileIndex.byPath.set(meta.relativePath, meta);
    this.fileIndex.byId.set(fileId, meta);
    return true;
  }

  /**
   * Ask about the copies of files renamed while away to a name this client
   * never writes (see {@link retiredAway}), now that the engine is connected:
   * the question a live rename asks (see {@link dropLocalCopy}). Where the
   * server has the file then is the name it moved on to.
   */
  private async askAboutRetiredWhileAway(): Promise<void> {
    for (const [fileId, { meta, serverHash }] of [...this.retiredAway]) {
      this.throwIfStopped();
      const movedTo = this.outOfScope.get(fileId)?.path;
      if (!this.reindexRetired(fileId) || movedTo === undefined) continue;
      try {
        const serverHad = await this.serverHadCopy(meta, serverHash);
        await this.dropLocalCopy(meta, movedTo, {
          pushedBack: false,
          ...(serverHad !== null ? { serverHad } : {}),
        });
      } catch {
        this.throwIfStopped();
        // Left as it is: the next connect finds the rename again.
      }
    }
  }

  /**
   * "Restore on server" for a file renamed to a name this client never writes
   * (see {@link retireMovedAway}): the local copy has edits, so move the file
   * back to the name it has here, then send them. Creating it anew instead
   * would start a second history next to the one the local doc carries — the
   * doubled-text incidents. Offline, or refused by the server, nothing
   * changes: the copy stays indexed under the old name, so it is not uploaded
   * as a new file, and the next connect asks again.
   */
  private async restoreMovedAway(meta: IndexedMeta, movedTo: string): Promise<void> {
    const path = meta.relativePath;
    if (!this.socket.isConnected()) return;
    try {
      // On its way from here: its broadcast is this device's own.
      this.localRenames.set(meta.fileId, (this.localRenames.get(meta.fileId) ?? 0) + 1);
      let ack: Ack;
      try {
        ack = await this.socket.emitFileRename({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          vectorClock: this.bumpClock(),
          fileId: meta.fileId,
          filePath: movedTo,
          newPath: path,
        });
      } finally {
        this.forgetLocalRename(meta.fileId);
      }
      this.throwIfStopped();
      if (!ack.ok) {
        this.log.warn('could not move a renamed file back', { path, movedTo, error: ack.error });
        return;
      }
    } catch {
      this.throwIfStopped();
      this.log.debug('moving a renamed file back failed; asking again on reconnect', path);
      return;
    }
    this.persistVectorClock();
    await this.handleLocalModify(path);
  }

  /**
   * Apply a server rename to the disk, the index and the note's doc. Local
   * phase only.
   */
  private async moveLocalCopy(io: LocalIO, meta: IndexedMeta, newPath: string): Promise<void> {
    // Obsidian reports each disk step as a rename: see `handleLocalRename`.
    const { fileId } = meta;
    this.movingHere.set(fileId, (this.movingHere.get(fileId) ?? 0) + 1);
    try {
      await this.moveLocalCopySteps(io, meta, newPath);
    } finally {
      const left = (this.movingHere.get(fileId) ?? 0) - 1;
      if (left > 0) this.movingHere.set(fileId, left);
      else this.movingHere.delete(fileId);
    }
  }

  private async moveLocalCopySteps(io: LocalIO, meta: IndexedMeta, newPath: string): Promise<void> {
    const { fileId } = meta;
    const oldPath = meta.relativePath;
    // Nothing to move. Taken for a move, the file was found at its
    // destination already — itself — and deleted as a duplicate.
    if (oldPath === newPath) return;
    /** Where the file stepped aside to, if it did. */
    let spare: string | null = null;
    if (await io.vault.exists(oldPath)) {
      /** Where the file is on disk until the rename proper. */
      let source = oldPath;
      if (oldPath !== newPath && pathKey(oldPath) === pathKey(newPath)) {
        // Only the case or the spelling changes (`Photo.png` → `photo.png`,
        // `Λογος` → `ΛΟΓΟΣ`, NFD → NFC). On a disk that takes both for one name
        // (Windows, macOS) the new name "exists" — it is this very file — and
        // the collision check below compared the file with itself, found them
        // equal and deleted the only copy. Step it aside first: afterwards the
        // new name exists only if it is another file. Names compare the way
        // the path gate compares them: `toLowerCase` kept the final sigma,
        // `ß`/`SS` and NFD/NFC apart, and a Mac disk merges each pair.
        spare = await this.spareMovePath(io.vault, oldPath);
        io.echo.mark(oldPath, ECHO_COUNT_RENAME);
        io.echo.mark(spare, ECHO_COUNT_RENAME);
        await this.renameOnDisk(io, oldPath, spare);
        // Recorded there at once. The rename proper failing (a file locked by
        // another program) or the app killed before it used to leave the file
        // under the spare name with no record of it, for the next connect to
        // upload as a new file. Now that connect moves it on from there.
        this.recordStepAside(io.log, meta, oldPath, spare);
        source = spare;
      }
      let moved: boolean;
      try {
        moved = await this.moveOnDisk(io, source, oldPath, newPath);
      } catch (err) {
        if (spare !== null) await this.stepBack(io, meta, spare, oldPath);
        throw err;
      }
      if (!moved) {
        if (spare !== null) await this.stepBack(io, meta, spare, oldPath);
        return;
      }
    }
    if (spare !== null) this.forgetRecord(io.log, fileId, spare);

    if (!isInBinding(newPath, this.binding.localFolder)) {
      // The file left our folder. It stays on disk where the server says it
      // is, but it is no longer ours to track: keeping it in `fileIndex` would
      // mirror a foreign path into `state.json`, and forgetting it entirely
      // would make a later move back in look like an unknown file. Its doc
      // goes: moved back in, it is fetched again.
      this.forgetPath(io.log, fileId, oldPath);
      if (this.fileIndex.byId.get(fileId) === meta) this.fileIndex.byId.delete(fileId);
      this.outOfScope.set(fileId, { path: newPath, fileType: meta.fileType });
      await this.dropDoc(io.docs, fileId, oldPath);
      this.log.info('file moved out of the binding folder', { oldPath, newPath });
      return;
    }
    await this.relocate(io, meta, newPath);
  }

  /**
   * Record in `state.json` that a file stepped aside to `spare` (see
   * {@link moveLocalCopy}). The index keeps the old name, and the doc stays
   * there: both move once, to the new name, when the rename proper is done.
   */
  private recordStepAside(
    log: OperationLog,
    meta: IndexedMeta,
    oldPath: string,
    spare: string,
  ): void {
    this.forgetRecord(log, meta.fileId, oldPath);
    log.setFileMeta({ ...meta, relativePath: spare });
  }

  /** Undo {@link recordStepAside} when the rename proper did not happen: best effort. */
  private async stepBack(
    io: LocalIO,
    meta: IndexedMeta,
    spare: string,
    oldPath: string,
  ): Promise<void> {
    try {
      if (await io.vault.exists(spare)) {
        io.echo.mark(spare, ECHO_COUNT_RENAME);
        io.echo.mark(oldPath, ECHO_COUNT_RENAME);
        await this.renameOnDisk(io, spare, oldPath);
      }
    } catch (err) {
      // Left under the spare name, recorded there: the next connect moves it on.
      this.log.warn('could not move a file back from a spare name', {
        path: spare,
        oldPath,
        error: describeError(err, 'rename_failed'),
      });
      return;
    }
    this.forgetRecord(io.log, meta.fileId, spare);
    io.log.setFileMeta({ ...meta, relativePath: oldPath });
  }

  /**
   * The disk part of {@link moveLocalCopy}: move the file from `source` to
   * `newPath`. `false` when it could not compare the two local files and
   * left both alone — the index is then left as it is too, and the next
   * reconnect retries from the listing.
   */
  private async moveOnDisk(
    io: LocalIO,
    source: string,
    oldPath: string,
    newPath: string,
  ): Promise<boolean> {
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
      const sourceHash = await this.hashFile(io.vault, source);
      const destHash = sourceHash === null ? null : await this.hashFile(io.vault, newPath);
      if (sourceHash === null || destHash === null) {
        // Couldn't read one of them (locked file, antivirus, dropped network
        // drive). Guessing here either deletes a file we never read or parks
        // a file that is in fact identical — leave both alone, and leave the
        // index untouched so the next reconnect retries from the listing.
        this.log.warn('server rename: could not compare the local files', { oldPath, newPath });
        return false;
      }
      // Echo budgets are claimed only once the disk is actually about to
      // change: every early return above would otherwise leave a live budget
      // behind that swallows a genuine external edit.
      io.echo.mark(source, ECHO_COUNT_RENAME);
      io.echo.mark(newPath, ECHO_COUNT_RENAME);
      if (sourceHash === destHash) {
        await io.vault.delete(source);
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
        await this.renameOnDisk(io, newPath, aside);
        await io.vault.ensureParentFolder(newPath);
        await this.renameOnDisk(io, source, newPath);
      }
    } else {
      io.echo.mark(source, ECHO_COUNT_RENAME);
      io.echo.mark(newPath, ECHO_COUNT_RENAME);
      await io.vault.ensureParentFolder(newPath);
      await this.renameOnDisk(io, source, newPath);
    }
    return true;
  }

  /**
   * Every rename this engine makes on disk goes through here. Obsidian
   * reports each `adapter.rename` as a vault `rename` event, inside the call
   * (app.js 1.13.7: `FileSystemAdapter.rename` triggers `renamed`,
   * `Vault.onChange` turns it into `rename`). Taken for the user's rename, it
   * went to the server: a teammate's case-only rename left the note on the
   * server under the spare name it stepped through, and names swapped while
   * away were renamed back and forth forever. The pair is registered for the
   * watcher to drop that one event (see `RecentlyApplied.expectRename`), and
   * kept here while the call runs (see `handleLocalRename`). The path
   * markers for the watchers' other echoes are the caller's.
   */
  private async renameOnDisk(io: LocalIO, from: string, to: string): Promise<void> {
    const key = renameKey(from, to);
    this.renamingOnDisk.add(key);
    io.echo.expectRename(from, to);
    try {
      await io.vault.rename(from, to);
    } finally {
      this.renamingOnDisk.delete(key);
      // Consumed by the watcher if it came; if not, it is not coming.
      io.echo.forgetRename(from, to);
    }
  }

  /**
   * Drop `path` from the index and `state.json` as the place of file
   * `fileId` — unless another file has been recorded there since: a file
   * listed at the old name of one renamed while away (see
   * {@link refreshFileIndex}) must not lose its entry to that move.
   */
  private forgetPath(log: OperationLog, fileId: string, path: string): void {
    const indexed = this.fileIndex.byPath.get(path);
    if (indexed === undefined || indexed.fileId === fileId) this.fileIndex.byPath.delete(path);
    this.forgetRecord(log, fileId, path);
  }

  /** {@link forgetPath} for `state.json` only. */
  private forgetRecord(log: OperationLog, fileId: string, path: string): void {
    const recorded = log.getFileMeta(this.binding.id, path);
    if (recorded !== null && (recorded.serverFileId === fileId || recorded.serverFileId === '')) {
      log.deleteFileMeta(this.binding.id, path);
    }
  }

  /**
   * A free name next to `path` to keep a file on for a moment: a rename that
   * changes only the case (see {@link moveLocalCopy}), or two names swapped
   * (see {@link applyRenamesWhileAway}). Takes the vault it checks: inside a
   * {@link commitLocal} block that is the unfenced one.
   */
  private async spareMovePath(vault: VaultAdapter, path: string): Promise<string> {
    for (let n = this.now(); ; n += 1) {
      const spare = buildMovePath(path, n);
      if (this.fileIndex.byPath.has(spare)) continue;
      if (!(await vault.exists(spare))) return spare;
    }
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
   * `log` is the unfenced one inside a {@link commitLocal} block.
   */
  private setFoldedHash(
    meta: IndexedMeta,
    hash: string,
    log: OperationLog = this.operationLog,
  ): void {
    const live = this.fileIndex.byId.get(meta.fileId);
    if (live !== meta) meta.foldedHash = hash;
    if (!live || live.foldedHash === hash) return;
    live.foldedHash = hash;
    log.setFileMeta(live);
  }

  /**
   * Capture the doc's text right before remote state lands on it, as a base
   * candidate for the next fold: until the snapshot writes that remote edit
   * out, it is the last text disk and doc can have agreed on. Only the first
   * update after an agreement is captured, and the candidate is checked
   * against the marker before use — a doc still loading from IndexedDB
   * (partial text) simply fails the check.
   */
  private rememberBaseBeforeRemote(meta: IndexedMeta, docPath = meta.relativePath): void {
    if (this.foldBases.has(meta.fileId)) return;
    if (!this.docManager.has(this.binding.id, docPath)) return;
    if (!this.docManager.hasState(this.binding.id, docPath)) return;
    this.foldBases.set(meta.fileId, {
      text: this.docManager.getText(this.binding.id, docPath),
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
    const path = this.docPathOf(meta);
    if (this.docManager.hasPendingRemoteUpdates(this.binding.id, path)) return true;
    return meta.size > 0 && !this.docManager.hasState(this.binding.id, path);
  }

  private async hydrate(meta: IndexedMeta): Promise<void> {
    const fetched = await this.fetchServerDoc(meta);
    if (fetched !== null) await this.applyFetchedDoc(meta, fetched);
  }

  /** The server's doc of a note, by `yjs:fetch`; `null` when it cannot be had. */
  private async fetchServerDoc(
    meta: IndexedMeta,
  ): Promise<{ sync1: number[]; stateVector?: number[] } | null> {
    if (!this.canFetch()) return null;
    const result = await this.socket.fetchYjsDoc(this.binding.projectId, meta.fileId);
    this.throwIfStopped();
    if (!result.ok) {
      // A server that predates `yjs:fetch` never answers; don't make every
      // later save wait out the timeout again before the next connect.
      if (result.error === 'timeout') this.yjsFetchUnavailable = true;
      this.log.debug('yjs:fetch failed', meta.relativePath, result.error);
      return null;
    }
    return result;
  }

  /**
   * Merge a fetched server doc (see {@link fetchServerDoc}) into a note's doc,
   * its lineage checked first. Callers hold the note's path lock.
   */
  private async applyFetchedDoc(
    meta: IndexedMeta,
    result: { sync1: number[]; stateVector?: number[] },
  ): Promise<void> {
    // The file may have been deleted or renamed while the request was out. A
    // rename made here may still be carrying the doc over: it is under the
    // old name until then.
    const current = this.fileIndex.byId.get(meta.fileId);
    if (!current) return;
    const docPath = this.docPathOf(current);
    if (!this.docManager.has(this.binding.id, docPath)) return;
    const update = Uint8Array.from(result.sync1);
    await this.checkLineage(current, docPath, update);
    // Moved, deleted or closed while that was checked: the next need fetches again.
    if (
      this.fileIndex.byId.get(meta.fileId) !== current ||
      this.docPathOf(current) !== docPath ||
      !this.docManager.has(this.binding.id, docPath)
    ) {
      return;
    }
    this.rememberBaseBeforeRemote(current, docPath);
    this.docManager.applyRemoteUpdate(this.binding.id, docPath, update);
    this.skippedDocs.delete(current.fileId);
    this.pushMissingOps(current, result.stateVector, docPath);
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
    // The file the snapshot is for: renamed while the snapshot waits for the
    // path, it is written under the new name (see `followRename`).
    const expected = this.fileIndex.byPath.get(path);
    this.snapshotsWaiting.set(path, (this.snapshotsWaiting.get(path) ?? 0) + 1);
    return this.withPathLock(path, () => this.writeDocSnapshot(path, expected)).finally(() => {
      const left = (this.snapshotsWaiting.get(path) ?? 0) - 1;
      if (left > 0) this.snapshotsWaiting.set(path, left);
      else this.snapshotsWaiting.delete(path);
    });
  }

  /** Whether a snapshot of `path` is pending or waiting for the path's lock. */
  private snapshotDue(path: string): boolean {
    return this.snapshotDebouncers.has(path) || this.snapshotsWaiting.has(path);
  }

  /**
   * A snapshot for `path` found the file `meta` moved on to another name
   * while it waited: schedule it there, and `true`. The rename reschedules a
   * snapshot still pending (see `carryPathState`), but not one that had
   * already fired and was waiting for the path: the remote edit it was for
   * stayed off the disk, and out of the editor, until the next edit. The
   * move keeps the doc open for it (see {@link snapshotDue}).
   */
  private followRename(meta: IndexedMeta, path: string): boolean {
    const live = this.fileIndex.byId.get(meta.fileId);
    if (live === undefined || live.relativePath === path) return false;
    if (!this.hasStopped) this.scheduleSnapshotToDisk(live.relativePath);
    return true;
  }

  /**
   * Run `task` exclusively for `path` — every sequence that reads the disk,
   * folds it into the doc and moves the fold marker goes through here. The
   * fold awaits (hashing, `yjs:fetch`, version history), so a local-save fold
   * racing a snapshot of the same file could fold one edit twice or record a
   * marker for content the disk no longer holds.
   */
  private withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    return this.withPathLocks([path], task);
  }

  /**
   * {@link withPathLock} for several paths at once — a rename holds both of
   * its names. Taken together, in one step: two renames waiting on each
   * other's names (a swap) queue up instead of locking each other out.
   */
  private withPathLocks<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
    const keys = [...new Set(paths)];
    const prev = Promise.all(
      keys.map((p) => (this.pathLocks.get(p) ?? Promise.resolve()).catch(() => undefined)),
    );
    const next = prev.then(task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    for (const p of keys) this.pathLocks.set(p, tail);
    void tail.then(() => {
      for (const p of keys) if (this.pathLocks.get(p) === tail) this.pathLocks.delete(p);
    });
    return next;
  }

  private async writeDocSnapshot(path: string, expected?: IndexedMeta): Promise<void> {
    if (expected !== undefined && this.followRename(expected, path)) return;
    if (!this.docManager.has(this.binding.id, path)) return;
    // Last line of defence for text content: catch-up, live `yjs:update` and
    // hydration all end up here. Before `ensureHydrated`, so a refused path
    // doesn't even trigger a `yjs:fetch`.
    if (!this.allowServerPath(path, 'snapshot')) return;
    // Never snapshot a doc whose offline store is still loading — its text
    // is a partial view and the write would destroy the full copy on disk.
    const meta = this.fileIndex.byPath.get(path);
    if (meta) {
      await this.openDoc(meta);
      // Moved or deleted meanwhile: the snapshot goes with it.
      if (this.fileIndex.byPath.get(path) !== meta) {
        this.followRename(meta, path);
        return;
      }
    } else {
      await this.docManager.whenSynced(this.binding.id, path);
    }
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
    const first = await this.readDiskText(path);
    // Deleted right under the read: the delete event owns the path. Taken for
    // a note not written yet, it used to be created again, and the delete,
    // finding the file there, was never sent.
    if (first === VANISHED) return;
    let diskText = first;
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
          this.recordSnapshotMeta(this.operationLog, meta, text, hash);
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
      if (current === null || current === VANISHED) return;
      if (attempt >= SNAPSHOT_FOLD_ATTEMPTS) {
        // Still changing. The doc keeps the remote edits in the meantime, and
        // a later snapshot folds whatever the disk settles on. Scheduled
        // first: a stopped engine refuses there, before promising a retry.
        this.scheduleSnapshotToDisk(path);
        this.log.info('disk keeps changing under the snapshot, retrying later', path);
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
    // One local phase from the file meta to the fold marker. A `stop()` landing
    // on the write used to let the file be written while the marker, refused
    // by the fence, kept naming the old disk — next to a `contentHash` of the
    // new text. The next engine then folded that disk against a base it does
    // not descend from: a remote edit that reached the doc during the write
    // was deleted everywhere, or doubled. `stop()` waits for the phase now.
    const written = text;
    const overwrite = diskText !== null;
    await this.commitLocal(async (io) => {
      // Update meta BEFORE the write, same as `applyServerUpdateBinary`: the
      // watcher echo of this write must find the file already recorded.
      if (meta) this.recordSnapshotMeta(io.log, meta, written, hash);
      // See `applyServerUpdateBinary` — a single overwrite can fan out into
      // Obsidian onModify + chokidar `change` OR Obsidian onModify + chokidar
      // `unlink` + `add` (atomic-rename split). Budget for the worst case so
      // a stray `unlink` doesn't trigger handleLocalDelete and a stray `add`
      // doesn't then find an empty fileIndex and emit a phantom file:create.
      // The createText branch only sees create-style echoes (Obsidian
      // onCreate + chokidar `add`), so the smaller CREATE budget is exact.
      if (overwrite) {
        io.echo.mark(path, ECHO_COUNT_WRITE);
        await io.vault.writeText(path, written);
      } else {
        await io.vault.ensureParentFolder(path);
        io.echo.mark(path, ECHO_COUNT_CREATE);
        await io.vault.createText(path, written);
      }
      // Only after the write succeeded: disk and doc now agree on `text`. A
      // base recorded before a failed write would make the next fold read the
      // old disk as local deletions of everything this snapshot was bringing in.
      if (meta) {
        this.foldBases.set(meta.fileId, { text: written, hash });
        this.setFoldedHash(meta, hash, io.log);
      }
    });
  }

  /**
   * The note's text on disk: `null` when there is no file, {@link VANISHED}
   * when it was there and got deleted before it could be read. The snapshot
   * leaves such a note to its delete event rather than fail — and with it the
   * whole catch-up. Any other read error still surfaces.
   */
  private async readDiskText(path: string): Promise<string | null | typeof VANISHED> {
    if (!(await this.vault.exists(path))) return null;
    try {
      return await this.vault.readText(path);
    } catch (err) {
      this.throwIfStopped();
      if (!(await this.vault.exists(path))) return VANISHED;
      throw err;
    }
  }

  /** Record `text` (hashed to `hash`) as the file's synced content. */
  private recordSnapshotMeta(
    log: OperationLog,
    meta: IndexedMeta,
    text: string,
    hash: string,
  ): void {
    meta.contentHash = hash;
    meta.size = new TextEncoder().encode(text).byteLength;
    log.setFileMeta(meta);
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
    this.collapseQueuedRenames();
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
   * Turn each chain of queued renames of one file (`a → b`, `b → c`) into one
   * rename, `a → c`, in the place of the first; a chain back to where it
   * started (`a → b → a`) goes altogether. Sent step by step, every step came
   * back as a broadcast, and a note long since at `c` was moved back to `b`
   * on disk — another note given the name `b` meanwhile was parked aside and
   * uploaded as a duplicate.
   *
   * Only while nothing queued in between for another file involves the names
   * the chain goes through or ends at: `a → b`, `c → a`, `b → c` stays as it
   * is, since `c` is free only once the rename in between has gone out.
   */
  private collapseQueuedRenames(): void {
    const ops = this.operationLog.dequeueOperations(this.binding.id);
    const absorbed = new Set<number>();
    for (let i = 0; i < ops.length; i++) {
      const first = ops[i];
      if (first === undefined || absorbed.has(first.id) || !isQueuedMove(first)) continue;
      const fileId = queuedFileId(first.payload);
      if (fileId === '' || first.newPath === null) continue;
      let target = first.newPath;
      /** Names other files' queued operations involve, since `first`. */
      const involved = new Set<string>();
      const chain: number[] = [];
      for (let j = i + 1; j < ops.length; j++) {
        const op = ops[j];
        if (op === undefined || absorbed.has(op.id)) continue;
        if (queuedFileId(op.payload) !== fileId) {
          involved.add(pathKey(op.filePath));
          if (op.newPath !== null) involved.add(pathKey(op.newPath));
          continue;
        }
        if (!isQueuedMove(op)) {
          // An edit of the file goes by its id; a delete ends the chain.
          if (op.opType === 'DELETE') break;
          continue;
        }
        if (op.filePath !== target || op.newPath === null) break;
        if (involved.has(pathKey(target)) || involved.has(pathKey(op.newPath))) break;
        chain.push(op.id);
        target = op.newPath;
      }
      if (chain.length === 0) continue;
      for (const id of chain) absorbed.add(id);
      if (target === first.filePath) absorbed.add(first.id);
      else this.operationLog.retargetOperation(first.id, target);
      this.log.debug('offline renames of one file sent as one', {
        from: first.filePath,
        to: target,
        steps: chain.length + 1,
      });
    }
    if (absorbed.size > 0) this.operationLog.markSent([...absorbed]);
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
    /** The queue entry's id; absent for an operation not taken from the queue. */
    id?: number;
    opType: OperationType;
    filePath: string;
    newPath: string | null;
    payload: Record<string, unknown>;
  }): Promise<ReplayOutcome> {
    // Taken out of the queue while the drain was on its way to it: a rename
    // of the file made since went out in its place (see
    // `supersedeQueuedMoves`).
    if (op.id !== undefined && !this.operationLog.isPending(this.binding.id, op.id)) {
      return { ok: true };
    }
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
          // Known in `creating` like a live create: a save or a rename of the
          // note while this one waits for its ack waits for it. Taken for a
          // note the server has never heard of, a save went out as a second
          // create — a conflict copy for everyone — and a rename left the old
          // name on the server.
          const sent: { ack?: Ack } = {};
          await this.trackCreate(op.filePath, async () => {
            // Out from here, answered or not (see `SENT_HASHES`).
            if (op.id !== undefined) this.noteCreateSent(op.id, op.payload, contentHash);
            const ack = await this.emitCreate({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              vectorClock: this.bumpClock(),
              filePath: op.filePath,
              fileType,
              contentHash,
              size: data.byteLength,
              ...(inlineData !== undefined ? { data: inlineData } : {}),
            });
            sent.ack = ack;
            this.throwIfStopped();
            if (!ack.ok) return null;
            // Keep `fileIndex` authoritative so the initial-push pass that
            // runs right after the drain skips this file instead of
            // re-uploading it.
            return this.recordCreateAck(
              op.filePath,
              (ack as { outcome?: unknown }).outcome,
              fileType,
              contentHash,
              data.byteLength,
            );
          });
          return ackToOutcome(sent.ack ?? { ok: false, error: 'no_ack' });
        }
        case 'UPDATE': {
          const fileId = queuedFileId(op.payload);
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          // Where the file is now: renamed since — by a teammate while away,
          // or here — it is not at the queued path any more, and the edit was
          // dropped as "missing".
          const path = this.currentPathOf(fileId, op.filePath);
          // Deleted since: a later DELETE in the queue carries that. Retrying a
          // read that cannot succeed used to halt the drain on this entry for
          // good, with every edit behind it.
          if (!(await this.vault.exists(path))) {
            return { ok: false, retryable: false, error: 'local_file_missing' };
          }
          const data = await this.vault.readBinary(path);
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
          const ack = await this.emitBinaryUpdate({
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
          let fileId = queuedFileId(op.payload);
          // Checked where the file is now: moved by a rename made while away,
          // it is not at the queued path, and the stray `unlink` went out as a
          // delete of a live file.
          if (
            op.payload[RECHECK_DELETE] === true &&
            (await this.vault.exists(this.currentPathOf(fileId, op.filePath)))
          ) {
            return { ok: false, retryable: false, error: 'local_file_present' };
          }
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
          const ack = await this.emitDelete({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
          });
          this.throwIfStopped();
          if (ack.ok) {
            // Checked against the disk, when it was queued or just above: a
            // file there now is a new one.
            this.freedHere.add(op.filePath);
            const at = this.currentPathOf(fileId, op.filePath);
            if (this.fileIndex.byId.get(fileId)?.relativePath === at) {
              this.fileIndex.byId.delete(fileId);
            }
            this.forgetPath(this.operationLog, fileId, at);
            if (at !== op.filePath) this.forgetPath(this.operationLog, fileId, op.filePath);
            // Drop the doc + any pending snapshot so a debounced write can't
            // recreate the deleted file (see handleLocalDelete).
            await this.dropDoc(this.docManager, fileId, at);
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
            // Out of the queue at once: the server has applied it, so a
            // teammate's rename of the file broadcast from now on came after
            // it and is followed (see `renamePendingHere`), not left to it.
            if (op.id !== undefined) this.operationLog.markSent([op.id]);
            // The index has the file under the name it has here already (see
            // `queuedRenames`). One still under the queued source — a queue
            // entry the index refresh did not take up — moves now, so the
            // post-drain initial-push pass recognises the file at its new path
            // instead of re-uploading it. If the server actually
            // conflict-renamed (a genuine concurrent rename onto the same
            // target), the note follows it to the real path.
            const meta = this.fileIndex.byId.get(fileId);
            if (meta && meta.relativePath === op.filePath) {
              await this.withPathLocks([op.filePath, newPath], () =>
                this.commitLocal((io) => this.relocate(io, meta, newPath)),
              );
            }
            await this.followStoredRename(fileId, (ack as { outcome?: unknown }).outcome);
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

  /** Record in queued CREATE `opId` that it went out with `hash` (see {@link SENT_HASHES}). */
  private noteCreateSent(opId: number, payload: Record<string, unknown>, hash: string): void {
    const hashes = sentHashes(payload);
    if (hashes.includes(hash)) return;
    this.operationLog.amendOperation(opId, {
      payload: { ...payload, [SENT_HASHES]: [...hashes, hash] },
    });
  }

  /** Where file `fileId` is now, by the index; `queued` when it is not indexed. */
  private currentPathOf(fileId: string, queued: string): string {
    return (fileId !== '' ? this.fileIndex.byId.get(fileId)?.relativePath : undefined) ?? queued;
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
   * meta, a download's meta and its write, a note snapshot's meta, write and
   * fold marker. Checks for `stop()` once, before the first step, and hands
   * the block the dependencies without the fence, so a `stop()` landing in
   * between waits for it instead of cutting it.
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

/** The text of a note's doc given as its full state. */
function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText('content').toJSON();
  } finally {
    doc.destroy();
  }
}

/**
 * Files the catch-up shows deleted and then created again under their id:
 * the server revives a tombstone under its old id. A server that continues a
 * note's history on revival marks such a CREATE `revived: true` (see
 * `sync-protocol.md`, "CREATE на существующий tombstone"); one before that
 * replaced the history and marked nothing. Either way the file under the id
 * is a new one.
 *
 * Not when this device applied the CREATE live (`appliedLive`): the note it
 * has is that new one already, and what it did to it since — an edit, a
 * rename, a delete, made offline — is about the new note. Taken for a note
 * recreated while it was away, the edit went into a conflict copy and the
 * rename and the delete were dropped.
 */
function notesRecreated(
  ops: readonly ServerOperation[],
  appliedLive: ReadonlySet<string>,
): Set<string> {
  const deleted = new Set<string>();
  const recreated = new Set<string>();
  for (const op of ops) {
    const payload = (op.payload ?? {}) as { fileId?: unknown };
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    if (fileId === '') continue;
    if (op.opType === 'DELETE') deleted.add(fileId);
    else if (op.opType === 'CREATE' && deleted.delete(fileId) && !appliedLive.has(op.id)) {
      recreated.add(fileId);
    }
  }
  return recreated;
}

/**
 * The payload of a local delete of `fileId`: with the hashes `meta`, the
 * file's record, last knew its content by (see `settleOvertakenQueue`).
 */
function deletePayload(fileId: string, meta: FileMeta | undefined): Record<string, unknown> {
  if (meta === undefined) return { fileId };
  const known = [meta.contentHash, meta.foldedHash].filter(
    (hash): hash is string => typeof hash === 'string' && hash !== '',
  );
  return { fileId, [LAST_SYNCED]: [...new Set(known)] };
}

/**
 * The hashes a queued DELETE carries (see {@link deletePayload}); `null` for
 * one queued by an older build, or parsed back from `state.json` malformed.
 */
function lastSyncedHashes(payload: Record<string, unknown>): string[] | null {
  const value = payload[LAST_SYNCED];
  if (!Array.isArray(value) || value.length === 0) return null;
  const hashes = value.filter((hash): hash is string => typeof hash === 'string' && hash !== '');
  return hashes.length === value.length ? hashes : null;
}

/** The hashes a queued CREATE went out with (see {@link SENT_HASHES}); none when it did not. */
function sentHashes(payload: Record<string, unknown>): string[] {
  const value = payload[SENT_HASHES];
  if (!Array.isArray(value)) return [];
  return value.filter((hash): hash is string => typeof hash === 'string' && hash !== '');
}

/**
 * The `fileId` a queued operation carries. The queue is parsed back from
 * `state.json`, so the field is trusted only as a string: anything else used
 * to go out as `String(value)` — `"[object Object]"` for an object.
 */
function queuedFileId(payload: Record<string, unknown>): string {
  const value = payload['fileId'];
  return typeof value === 'string' ? value : '';
}

/** A queued RENAME or MOVE. */
function isQueuedMove(op: { opType: OperationType }): boolean {
  return op.opType === 'RENAME' || op.opType === 'MOVE';
}

/** Take one off `key`'s count in `counts`, dropping it at zero. */
function countDown(counts: Map<string, number>, key: string): void {
  const left = (counts.get(key) ?? 0) - 1;
  if (left > 0) counts.set(key, left);
  else counts.delete(key);
}

/** Key of a rename in {@link SyncEngine.renamingOnDisk}. */
function renameKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * Where a rename broadcast says the server stored the file: `outcome` of a
 * rename or of one moved to a conflict name, or else `newPath`. A server that
 * predates `clientId` sent the path asked for as `newPath`, even when it
 * stored the file under a conflict name.
 */
function storedRenamePath(newPath: string, outcome: unknown): string {
  const conflict = conflictPlacement(outcome);
  if (conflict !== null) return conflict.stored;
  const o = outcome as { kind?: unknown; to?: unknown } | null | undefined;
  if (o?.kind === 'renamed' && typeof o.to === 'string' && o.to !== '') return o.to;
  return newPath;
}

/** The names of a rename the server stored under a conflict name, or `null`. */
function conflictPlacement(outcome: unknown): { asked: string; stored: string } | null {
  const o = outcome as
    | { kind?: unknown; originalPath?: unknown; finalPath?: unknown }
    | null
    | undefined;
  if (o?.kind !== 'conflict_create_renamed') return null;
  if (typeof o.originalPath !== 'string' || typeof o.finalPath !== 'string') return null;
  if (o.finalPath === '') return null;
  return { asked: o.originalPath, stored: o.finalPath };
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

/** File id → every path the catch-up's renames and moves of that file start from. */
function renameSources(ops: readonly ServerOperation[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.opType !== 'RENAME' && op.opType !== 'MOVE') continue;
    const fileId = (op.payload as { fileId?: unknown } | null)?.fileId;
    if (typeof fileId !== 'string' || fileId === '') continue;
    let from = out.get(fileId);
    if (from === undefined) {
      from = new Set();
      out.set(fileId, from);
    }
    from.add(op.filePath);
  }
  return out;
}

/**
 * The operations of a catch-up that a later one of the same kind of the same
 * file supersedes: renames and moves, and updates. The operations come in the
 * order the server applied them.
 *
 * An update superseded so brought a version the server no longer has: its
 * download fetches the file as it is now, the bytes the last update brings.
 * Downloaded for each, an attachment a teammate saved ten times was fetched
 * nine times at the next connect, the same bytes each time — also when this
 * device had them already, from the saves it applied live.
 */
function supersededOps(ops: readonly ServerOperation[]): Set<ServerOperation> {
  const keyOf = (op: ServerOperation): string | null => {
    const kind =
      op.opType === 'RENAME' || op.opType === 'MOVE'
        ? 'move'
        : op.opType === 'UPDATE'
          ? 'update'
          : null;
    if (kind === null) return null;
    const fileId = (op.payload as { fileId?: unknown } | null)?.fileId;
    return typeof fileId === 'string' && fileId !== '' ? `${kind}:${fileId}` : null;
  };
  const last = new Map<string, ServerOperation>();
  for (const op of ops) {
    const key = keyOf(op);
    if (key !== null) last.set(key, op);
  }
  const superseded = new Set<ServerOperation>();
  for (const op of ops) {
    const key = keyOf(op);
    if (key !== null && last.get(key) !== op) superseded.add(op);
  }
  return superseded;
}

/**
 * A sibling name a file steps aside to for the length of a rename:
 * `notes/foo.png` + 1700000000000 → `notes/foo.moving-1700000000000.png`.
 * Visible and synced on purpose: were the process killed between the two
 * renames, the file is found there rather than lost under a hidden name.
 */
function buildMovePath(filePath: string, n: number): string {
  const slash = filePath.lastIndexOf('/');
  const dir = filePath.slice(0, slash + 1);
  // A file stepped aside before keeps one suffix, not one more each time.
  const basename = filePath.slice(slash + 1).replace(/\.moving-\d+(?=\.[^.]*$|$)/, '');
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return `${dir}${basename}.moving-${n}`;
  return `${dir}${basename.slice(0, dot)}.moving-${n}${basename.slice(dot)}`;
}

/**
 * A move of `applyRenamesWhileAway` that stands on a cycle, when every move
 * waits on another: following each move to the one whose old name its new
 * name takes, the first move met twice. `null` when there is none.
 */
function cycleMove<T extends { from: string; to: string }>(
  pending: readonly T[],
  key: (path: string) => string,
): T | null {
  const next = (move: T): T | undefined =>
    pending.find((other) => other !== move && key(other.from) === key(move.to));
  const seen = new Set<T>();
  let move = pending[0];
  while (move !== undefined && !seen.has(move)) {
    seen.add(move);
    move = next(move);
  }
  return move ?? null;
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
