import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { ApiClient, ApiError } from '@/client/api';
import type { ApiFile } from '@/client/types';
import {
  JOIN_FAILED,
  OPS_STATUS_MAX,
  SocketClient,
  type AckOk,
  type AppliedOperation,
  type FileAck,
  type FileCreatePayload,
  type FileDeletePayload,
  type FileEvent as SocketFileEvent,
  type OpsStatusResult,
  type ServerLogEntry,
  type ServerOperation,
  type YjsUpdateMessage,
  type YjsDocSnapshot,
  type YjsCatchupBatch,
} from '@/client/socket';
import * as Y from 'yjs';
import { DocManager, type MoveResult, type OpenResult, type WrittenMark } from '@/crdt/doc-manager';
import { mergeText3 } from '@/crdt/text-merge';
import {
  OperationLog,
  newOpId,
  type FileMeta,
  type OperationType,
  type PendingOperation,
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
  type FlushResult,
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
import { normalizeFolderPath } from '@/settings/folder-utils';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import { Logger, type LogSink } from '@/utils/logger';
import { EngineStoppedError, SyncPausedError, childController, fence } from './stop-fence';

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
 * Pause sync does not stop it: {@link SyncEngine.pause} closes the connection
 * and keeps the engine taking local changes as it does with the network down,
 * and {@link SyncEngine.resume} connects again.
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
  /** This vault's client id. Same value goes into the vector clock keys. */
  clientId: string;
  /**
   * The ids this vault sent operations under before `clientId` (see
   * `settings/client-identity.ts`), the latest first. A queued operation may
   * have gone out under one of them, its answer lost: once the server says it
   * applied it, this device's counter under that id moves up to the one the
   * operation was logged with, as under `clientId` (see
   * `SyncEngine.adoptOwnCounter`). Never an id this vault did not send under:
   * a copy's queue came from its original, whose operations under its own id
   * — in use — are to reach the copy in a catch-up. Default: none.
   */
  previousClientIds?: readonly string[];
  /**
   * Called, once per engine, when an operation under `clientId` turns up that
   * this device did not send: another device uses the id (see
   * `SyncEngine.reportTwin`). The plugin gives the vault a new id on its next
   * start.
   */
  onTwinDetected?: (clientId: string) => void;
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
   * same set, kept while the plugin runs: switching the binding off and on
   * spawns a new engine, and with a set of its own that engine reported every
   * such path at `warn` again. Default: a new set.
   */
  reportedRefusals?: Set<string>;
  /**
   * The pauses (ms) before each new try of an `ops:status` the server answered
   * `busy` or never answered (see `SyncEngine.settleUnanswered`). Default: 2,
   * 5 and 15 s.
   */
  opsStatusRetryMs?: readonly number[];
  /**
   * How long one `ops:status` waits for its answer (see
   * `SocketClient.opsStatus`). Default: `OPS_STATUS_TIMEOUT_MS`, 15 s.
   */
  opsStatusTimeoutMs?: number;
  /**
   * The pauses (ms) before each new try of the offline queue after the server
   * refused a file operation with `busy` (see `SyncEngine.queueFirst`); the
   * last one repeats. Default: 2, 5, 15 and 30 s.
   */
  queueRetryMs?: readonly number[];
  /**
   * The pause (ms) between the tries of the queue once new changes no longer
   * wait behind it after `busy`, the queue halted on another error (see
   * `SyncEngine.queueStuck`). Default: 5 minutes.
   */
  queueStuckRetryMs?: number;
  /**
   * The pauses (ms) before each new try of the connect flow, on the same
   * connection, after the server refused `project:join` with a refusal that
   * asking again may get past (`join_failed`, see
   * `SyncEngine.joinAgainLater`); the last one repeats. Default: 2, 5, 15, 30
   * and 60 s.
   */
  joinRetryMs?: readonly number[];
}

/** See {@link SyncEngineDeps.opsStatusRetryMs}. */
const OPS_STATUS_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000];

/** See {@link SyncEngineDeps.joinRetryMs}. */
const JOIN_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * The refusals of `project:join` that asking again may get past
 * (`sync-protocol.md`, «Подключение», «Отказ»): the server could not read
 * what its answer needs. Every other one answers the request itself, and
 * asking again changes nothing.
 */
const JOIN_RETRYABLE: ReadonlySet<string> = new Set([JOIN_FAILED]);

/**
 * A new try of the connect flow on the connection `link`, the `attempt`-th
 * one in a row (see {@link SyncEngine.joinAgainLater}).
 */
interface JoinRetry {
  link: AbortController;
  attempt: number;
}

/** See {@link SyncEngineDeps.queueRetryMs}. */
const QUEUE_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/**
 * How many tries of the queue in a row, after `busy`, may halt on another
 * error before new changes go out again without waiting for the queue (see
 * `SyncEngine.afterDrain`).
 */
const QUEUE_FAILURES_MAX = 3;

/** See {@link SyncEngineDeps.queueStuckRetryMs}. */
const QUEUE_STUCK_RETRY_MS = 5 * 60 * 1000;

/**
 * How many passes one drain makes over a queue that keeps filling up while
 * it runs before new changes go out again without waiting for it (see
 * `SyncEngine.drainQueue`).
 */
const DRAIN_PASSES_MAX = 50;

/**
 * The status detail while new changes wait in the queue behind ones the
 * server refused with `busy` (see `SyncEngine.queueFirst`).
 */
const QUEUE_FIRST_DETAIL = 'server_busy';

/**
 * How one drain of the queue ended (see `SyncEngine.drainQueue`): the queue
 * sent (`empty`); halted on an operation that failed for now, with its error;
 * a pass that sent nothing and halted on nothing (`stalled`); still filling
 * up after {@link DRAIN_PASSES_MAX} passes (`capped`); or the connection gone
 * (`offline`).
 */
type DrainOutcome =
  | { kind: 'empty' }
  | { kind: 'halted'; error: string }
  | { kind: 'stalled' }
  | { kind: 'capped' }
  | { kind: 'offline' };

/**
 * What the server says when it refuses `ops:status` for good: the status
 * shows it as the join would (see {@link SyncEngine.opsStatusFailure}).
 */
const OPS_STATUS_REFUSALS: ReadonlySet<string> = new Set(['project_not_found', 'forbidden']);

/**
 * A file operation about to go out through {@link SyncEngine.sendOp}: what
 * `state.json` records while it is on its way.
 */
interface OutgoingOp {
  opType: OperationType;
  filePath: string;
  newPath: string | null;
  payload: Record<string, unknown>;
  opId: string;
  /** An answer to a question: see `PendingOperationInput.settleOnly`. */
  settleOnly?: true;
  /**
   * Sent by the drain's replay of a queue entry (see `replayPending`): the
   * head of the queue, it goes out while new changes wait behind the ones
   * the server refused (see `SyncEngine.queueFirst`).
   */
  fromQueue?: true;
}

/**
 * What became of an operation {@link SyncEngine.sendOp} sent: acknowledged
 * (with what its handler made of the answer), refused for good by the server,
 * or back in the offline queue (`entry`; `null` when it was not written
 * there).
 */
type SendResult<T> =
  | { kind: 'acked'; value: T }
  | { kind: 'refused'; error: string }
  | { kind: 'queued'; entry: PendingOperation | null };

/**
 * `ops:status` could not be answered in this connect: the connect flow ends
 * with the status `error` (see {@link SyncEngine.settleUnanswered}).
 * `reason`: the last try's error; `answered`: whether the server answered any
 * try at all (`busy`, a refusal) — a server older than the question never
 * does.
 */
class OpsStatusError extends Error {
  constructor(
    readonly reason: string,
    readonly answered: boolean,
  ) {
    super('ops_status_failed');
    this.name = 'OpsStatusError';
  }
}

export type EngineStatus = 'stopped' | 'connecting' | 'syncing' | 'connected' | 'error' | 'offline';

export type StatusListener = (status: EngineStatus, detail?: string) => void;

type IndexedMeta = FileMeta & { fileId: string };

/**
 * A local change the engine has taken on but not settled yet — the offline
 * queue entry `stop()` writes for it. Mutable: a handler fills the payload in
 * as it learns more (a binary edit's hash, say). The replay reads the disk
 * again anyway, so an entry handed over early is still correct. Its `opId`,
 * given when it is taken on, is the one it goes out with, and the one it is
 * queued under.
 */
type HeldChange = Required<Omit<PendingOperationInput, 'opId' | 'settleOnly'>> & {
  opId: string;
};

/**
 * What became of a delete claimed in {@link SyncEngine.deleteClaims}: `gone`
 * — sent, queued, refused by the server for good, or nothing to delete;
 * `kept` — nothing went out for it: the file was still on disk when its
 * handler looked, or the handler gave up before sending. A handler that
 * joined the claim looks again itself only after `kept`.
 */
type DeleteOutcome = 'gone' | 'kept';

/** The delete of one file under way on this device — see {@link SyncEngine.deleteClaims}. */
interface DeleteClaim {
  readonly fileId: string;
  /** The `opId` of the change whose handler sends the delete. */
  readonly opId: string;
  readonly done: Promise<DeleteOutcome>;
  /** Resolve {@link done} (the first call counts) and drop the claim, if it is still the file's. */
  end(outcome: DeleteOutcome): void;
}

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
    };

/**
 * What a create of this device's came to (see `SyncEngine.recordCreateAck`):
 * the id the server gave the file, and whether that is a file of another
 * device's with the same content, which the server gave back instead of
 * making a new one (`merged`, the server says so in the outcome).
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
 * How long {@link SyncEngine.resume} waits for the flows of the connection
 * Pause sync closed to end before it connects anyway. They end at their next
 * step; one can wait longer only on a request that hangs or on a question to
 * the user.
 */
const RESUME_WAIT_MS = 30_000;

/** The status detail of an engine on Pause sync. */
const PAUSED_DETAIL = 'paused';

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

/**
 * Payload of a queued attachment UPDATE that answers **Keep local**: the
 * server's version the user chose the copy here over (see
 * `SyncEngine.keepLocalVersion`). Local to the queue, like
 * {@link RECHECK_DELETE}.
 */
const KEEP_OVER = 'keepOver';

/**
 * Payload of a queued DELETE, RENAME or MOVE: the folder that vanished with
 * it here (see `SyncEngine.vanishedFolderOf`). Sent as the operation's
 * `folder` when the queue replays it.
 */
const FOLDER = 'folder';

/**
 * How many folders {@link SyncEngine.prunedHere} keeps whose `delete` Obsidian
 * has not reported, before it starts over.
 */
const PRUNED_MAX = 1000;

/** How many paths {@link SyncEngine.caseKey} remembers the key of before it starts over. */
const CASE_KEYS_MAX = 50_000;

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
  /** See {@link SyncEngineDeps.previousClientIds}. */
  private readonly previousClientIds: readonly string[];
  /** See {@link SyncEngineDeps.onTwinDetected}. */
  private readonly onTwinDetected: ((clientId: string) => void) | undefined;
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
  /**
   * The connection's own lifetime: aborted by {@link pause} with a
   * {@link SyncPausedError}, and with {@link lifetime} by `stop()`. It ends the
   * work of the connection at its next step — the connect flow, the drain and
   * the first upload (see {@link onSocketConnect}) — and cancels binary
   * transfers. {@link resume} starts a new one.
   */
  private online: AbortController;
  /** Set by {@link pause}, cleared by {@link resume}. */
  private paused = false;
  /** Set by {@link start}: only a started engine connects on {@link resume}. */
  private started = false;
  /**
   * The connect flows still running (see {@link trackConnectFlow}), each as a
   * promise that never rejects. {@link resume} waits for them.
   */
  private readonly connectFlows = new Set<Promise<void>>();
  /** How many times {@link resume} has run: a later call takes over from an earlier one. */
  private resumes = 0;
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
   * has not settled yet — checked, removed, or asked about — and of files a
   * teammate deleted whose question is open (see {@link askingDeleted}): path
   * → the deleted file's id. A file created again under such a name keeps the
   * copy aside first (see {@link applyServerCreate}).
   */
  private readonly awayCopies = new Map<string, string>();

  /**
   * Files a teammate deleted while this device holds edits of them the server
   * may never have had, whose question is open (see {@link dropLocalCopy}):
   * id → the path of the copy. Out of the index meanwhile, and out of it after
   * a listing that still has them; a file created again under the id or the
   * name while the user decides keeps the copy aside (see `awayCopies`).
   */
  private readonly askingDeleted = new Map<string, string>();

  /**
   * Copies of deleted files the user is being asked about (see
   * {@link dropLocalCopy}), deleted live or while this device was away: path →
   * the deleted file's id. A save or a create of such a copy meanwhile is left
   * to the answer (see {@link handleLocalCreate}).
   */
  private readonly askedCopies = new Map<string, string>();

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
   * Notes whose history here has been checked against the server's in this
   * connect (see {@link checkLineage}), or started anew in it. A teammate's
   * edit to any other note waits for that check (see
   * {@link handleServerYjsUpdate}).
   */
  private readonly lineageChecked = new Set<string>();

  /**
   * Notes whose history was started anew from the server's broadcasts since
   * this connect's `project:join` went out (see {@link startDoc}): created or
   * revived by a teammate, or created here. The catch-up's doc of such a note
   * is left out (see {@link applyCatchupDoc}).
   */
  private readonly startedSinceJoin = new Set<string>();

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
   * acknowledged yet, by path, with how many — see {@link emitCreate}. A file
   * the server broadcasts under such a name meanwhile waits for the ack (see
   * {@link applyServerCreate}).
   */
  private readonly ownCreates = new Map<string, number>();

  /**
   * Deletes sent and not acknowledged yet, by file id — see {@link emitDelete}
   * and {@link deletingHere}.
   */
  private readonly ownDeletes = new Map<string, number>();

  /**
   * Deletes of files under way on this device, by file id. The handler that
   * sends one claims it before its first `await`, and the claim ends as soon
   * as the file is out of the index — the delete acknowledged or queued — or
   * the handler has found nothing to send. Another handler of the same file
   * joins the claim instead of sending a delete of its own (see
   * {@link joinDelete}).
   *
   * One file's delete comes to the engine several times. Obsidian 1.13.7
   * reports a folder deleted with what is in it as a `delete` of every file
   * and subfolder in it, in the order they were listed — a subfolder before
   * its files — and of the folder last (`reconcileDeletion` in `app.js`), and
   * the engine expands each folder into its files' deletes (see
   * {@link handleLocalFolderDelete}); chokidar reports each file's `unlink`
   * besides, before Obsidian's or after. Each of these sent a delete of its
   * own, under an `opId` of its own: the first file of the folder and the
   * files of each subfolder went to the server twice (2026-09-28, a folder of
   * a note, two attachments and a subfolder), and so did `state.json`'s queue
   * when offline. The server logs a delete of a tombstone like any other, and
   * one that came late deleted the file a teammate had created again under
   * the name meanwhile: the server gives it the deleted file's id.
   */
  private readonly deleteClaims = new Map<string, DeleteClaim>();

  /**
   * The checks of {@link vanishedFolderOf}, chained: one at a time, in the
   * order the local deletes and renames that wait for them came. Each such
   * operation goes out after its check; without the chain, a check that took
   * longer on disk let a later rename of the same note go out first.
   */
  private folderChecks: Promise<unknown> = Promise.resolve();

  /**
   * Folders this engine removed from disk as ones a teammate deleted or
   * renamed (see {@link pruneVanishedFolder}), by {@link folderKey}, whose
   * `delete` Obsidian has not reported yet. Its watcher reports the removal a
   * moment later, as it reports a folder the user deleted, and the engine
   * expands a folder's delete into its files' deletes (see
   * {@link handleLocalFolderDelete}). Nothing was indexed under the folder
   * when it was removed; a file indexed under its name since — a teammate's
   * new one, still downloading — would have gone out as deleted by the user.
   * Kept until the report comes: its time is Obsidian's. A report that never
   * comes — the folder back before Obsidian looked — leaves the entry for the
   * user's own delete of the folder later: the files written to this disk
   * since go then all the same.
   */
  private readonly prunedHere = new Set<string>();

  /**
   * The removals of {@link pruneVanishedFolder}, chained: one at a time, in
   * the order they are asked for. A teammate's deletes of a folder's files
   * are applied side by side, and the last two could both find nothing left
   * under the folder and both go to remove it. The second found it gone —
   * its `rmdir` failed — and took it out of {@link prunedHere}, though the
   * first had removed it: Obsidian's report of the folder then went out as
   * the user's delete, a teammate's file recorded under it since included.
   */
  private folderPrunes: Promise<unknown> = Promise.resolve();

  /**
   * Folders the catch-up's deletes, renames and moves say vanished at their
   * authors' (see {@link pruneVanishedFolder}): folder → the path of the file
   * of the first of them. Removed only at the end of the connect's tail (see
   * {@link drainThenInitialPush}): the copies of files deleted while this
   * device was away are still on disk during the catch-up, and go only then
   * (see {@link initialPush}). Kept for the next connect's tail when this
   * one's is cut short (Pause sync, the connection lost), and when its first
   * upload could not remove the copies (see {@link pruneCatchupFolders}): the
   * catch-up does not bring those operations again.
   */
  private readonly catchupFolders = new Map<string, string>();

  /**
   * Whether an operation under this device's client id that it did not send
   * was logged (see {@link reportTwin}).
   */
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
   * So are the names of files deleted on the server whose content never
   * reached this disk (see `FileMeta.notOnDisk`).
   */
  private freedHere = new Set<string>();

  /**
   * The checks at start of records of files never written here whose file
   * is on disk (see {@link startWrittenCheck}), by path, while they run.
   */
  private readonly writtenChecks = new Map<string, Promise<void>>();

  /** All of {@link writtenChecks}: resolves once they are done, never rejects. */
  private writtenCheck: Promise<void> = Promise.resolve();

  /** Subscriber tear-down list. */
  private cleanups: Array<() => void> = [];

  /**
   * The tear-down of the subscription that wires each doc opened (see
   * {@link onSocketConnect}): one for the engine's lifetime, replaced on each
   * connect.
   */
  private docsAcquiredOff: (() => void) | null = null;

  /**
   * Resolves the in-flight streamed Yjs catch-up once the server's final
   * `yjs:catchup` batch (`done`) arrives. Armed before each `project:join`,
   * cleared when the stream finishes (or times out).
   */
  private catchupResolve: (() => void) | null = null;
  /** True once the file index is refreshed — gates catch-up batch processing
   *  so a doc always finds its metadata (no join↔refresh race). */
  private indexReady = false;
  /** `yjs:catchup` batches that arrived before the index was ready. */
  private pendingCatchup: YjsCatchupBatch[] = [];

  /**
   * `opId`s of the operations sent and not answered yet — live ones and the
   * drain's. A broadcast carrying one of them is this device's own.
   */
  private readonly sending = new Set<string>();

  /**
   * Whether this connect has checked the queued operations with the server
   * — some of them may have lost their answers (see {@link settleUnanswered});
   * cleared on each connect. Until then a live change is queued, not sent.
   */
  private opsSettled = false;

  /**
   * `opId`s of this device's operations the server is known to have applied
   * in this connect: closed by {@link settleUnanswered}, or answered since.
   */
  private readonly ownKnown = new Set<string>();

  /**
   * `opId`s of the operations this engine recorded in flight and has not
   * cleared nor put back in the queue: `stop()` puts them back (see
   * {@link handOverHeldChanges}), for the next engine to settle.
   */
  private readonly inflightHere = new Set<string>();

  /** See {@link SyncEngineDeps.opsStatusRetryMs}. */
  private readonly opsStatusRetryMs: readonly number[];

  /** See {@link SyncEngineDeps.opsStatusTimeoutMs}. */
  private readonly opsStatusTimeoutMs: number | undefined;

  /** Wakes each flow waiting in {@link liveOpsSettled} when {@link inflightHere} shrinks. */
  private readonly flightWaiters = new Set<() => void>();

  /**
   * Whether new file changes wait in the offline queue behind the ones the
   * server refused with `busy`, instead of going out at once: from the
   * refusal (see {@link closeGate}) until the queue has gone out (see
   * {@link afterDrain}), or until the next connect.
   *
   * A server whose project queue did not reach an operation in time refuses
   * it and every later file operation of the connection with `busy`, until
   * its queue has passed them (`sync-protocol.md`, «Порядок операций одного
   * соединения»), and expects them again in their order, before anything new.
   * A change sent at once meanwhile overtook them: a note renamed onto the
   * name of one whose delete was refused, or a new "Untitled" made right after
   * a refused rename of the last one, found the name taken on the server and
   * went to everyone under a conflict name. And the refused ones waited for
   * the next connect — hours, maybe — the queue being sent only then.
   */
  private queueFirst = false;

  /** The timer of the next try of the queue after `busy` (see {@link schedulePump}). */
  private pumpTimer: number | null = null;

  /** Which pause of {@link queueRetryMs} the next try waits (see {@link schedulePump}). */
  private pumpStep = 0;

  /** Tries of the queue in a row, after `busy`, that halted on another error. */
  private pumpFailures = 0;

  /**
   * Whether the tries of the queue after `busy` stopped holding new changes
   * behind it, the queue halted on another error {@link QUEUE_FAILURES_MAX}
   * times in a row (see {@link afterDrain}): new changes go out at once
   * again, and the queue is tried again every {@link queueStuckRetryMs} —
   * until it has gone out, `busy` holds new changes behind it again, or the
   * next connect.
   *
   * It used to wait for the next connect, hours maybe, with the changes the
   * server had refused `busy` in it: they did not reach the team, and every
   * change made meanwhile overtook them. The upload of an attachment at the
   * head of the queue fails more often just when the server is overloaded
   * enough to refuse with `busy`, and it is back a minute later.
   */
  private queueStuck = false;

  /**
   * The drain of the queue running now, the connect's or a try after `busy`
   * (see {@link runDrain}), as a promise that never rejects: one at a time.
   */
  private draining: Promise<void> | null = null;

  /** A try of the queue came while a drain ran: another follows it (see {@link runDrain}). */
  private drainAgain = false;

  /**
   * The signal of the drain running now (see {@link runDrain}): aborted, it
   * sends nothing more (see {@link emitQueued}).
   */
  private drainSignal: AbortSignal | null = null;

  /**
   * Whether this connect has handed the queue to its drain (see
   * {@link onSocketConnect}). Until it has, a `busy` only puts new changes
   * behind the queue: the drain sends the queue once the catch-up is done.
   * Sent earlier, in the middle of the catch-up, a queued create of a file the
   * listing has just shown the server to have went out as a create — a
   * conflict copy — and a queued delete missed the checks the connect runs
   * before the drain (see `settleOvertakenQueue`).
   */
  private drainHandedOver = false;

  /**
   * The connection open now: aborted when it drops, and with {@link online}
   * by Pause sync and `stop()`; a new one on each connect. The drains end
   * with it (see {@link runDrain}): one of a connection gone, still running
   * when the next connects, would send the queue beside that one's drain and
   * undo what that connect settled.
   */
  private link: AbortController | null = null;

  /** See {@link SyncEngineDeps.queueRetryMs}. */
  private readonly queueRetryMs: readonly number[];

  /** See {@link SyncEngineDeps.queueStuckRetryMs}. */
  private readonly queueStuckRetryMs: number;

  /** See {@link SyncEngineDeps.joinRetryMs}. */
  private readonly joinRetryMs: readonly number[];

  /** The detail of the last status reported (see {@link setStatus}). */
  private statusDetail: string | undefined = undefined;

  constructor(deps: SyncEngineDeps) {
    this.binding = deps.binding;
    this.server = deps.server;
    this.clientId = deps.clientId;
    this.previousClientIds = (deps.previousClientIds ?? []).filter((id) => id !== deps.clientId);
    this.onTwinDetected = deps.onTwinDetected;
    // Everything the engine can act on goes through the fence: the shared
    // vault, log, docs and echo set (the engine spawned after this one uses the
    // same ones), the network, and the conflict modal.
    const { signal } = this.lifetime;
    this.online = childController(signal);
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
    this.opsStatusRetryMs = deps.opsStatusRetryMs ?? OPS_STATUS_RETRY_MS;
    this.opsStatusTimeoutMs = deps.opsStatusTimeoutMs;
    this.queueRetryMs = deps.queueRetryMs ?? QUEUE_RETRY_MS;
    this.queueStuckRetryMs = deps.queueStuckRetryMs ?? QUEUE_STUCK_RETRY_MS;
    this.joinRetryMs = deps.joinRetryMs ?? JOIN_RETRY_MS;
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
   * no-op. An engine paused before it started (see {@link pause}) takes local
   * changes from here on, and connects on {@link resume}.
   */
  async start(): Promise<void> {
    // Single use — see the class comment. A restart would hand the new socket
    // to flows of the previous run.
    if (this.hasStopped) return;
    if (this.status !== 'stopped' && this.status !== 'error') return;
    this.started = true;
    // Before the first connect, which may never come this session.
    this.loadIndex();
    if (this.paused) this.setStatus('offline', PAUSED_DETAIL);
    else this.setStatus('connecting');

    this.cleanups.push(this.socket.onConnect(() => this.trackConnectFlow(this.onSocketConnect())));
    this.cleanups.push(
      this.socket.onDisconnect((reason) => {
        // What was tied to the connection ends with it (see `link`); the next
        // connect sends the queue.
        this.link?.abort(new Error('disconnected'));
        this.clearPumpTimer();
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
      this.socket.onYjsCatchup((batch) => this.trackConnectFlow(this.handleYjsCatchup(batch))),
    );
    this.cleanups.push(() => {
      this.docsAcquiredOff?.();
      this.docsAcquiredOff = null;
    });

    if (!this.paused) this.socket.connect();
  }

  /**
   * Pause sync: close the connection and keep it closed until {@link resume},
   * while the engine goes on taking local changes exactly as it does when the
   * network drops — the file index from `state.json`, the offline queue, a
   * chain of renames of one file sent as one, a delete that takes the file out
   * of the records at once, a save folded into the note's history. The engine
   * used to be stopped instead, and every change made meanwhile was lost as an
   * intent: a note renamed while paused was uploaded again under its new name
   * on resume, the old name coming back from the server, and a note deleted
   * while paused came back.
   *
   * The socket is closed on purpose, so socket.io does not reconnect it. Emits
   * waiting for an ack fail, and a `yjs:fetch` is answered at once; each change
   * they carried is queued, as when the connection drops. The work of the
   * connection — the connect flow, the catch-up, the drain and the first
   * upload — ends at its next step (see {@link online}); the operation the
   * drain had in flight stays queued and goes out on resume, once. Binary
   * transfers are cancelled, and an upload cut short is queued. A local phase
   * already running ends as it would anyway.
   */
  pause(): void {
    if (this.hasStopped || this.paused) return;
    this.paused = true;
    this.clearPumpTimer();
    this.online.abort(new SyncPausedError());
    this.socketLink.disconnect();
    // Never started: `start()` finds the engine paused.
    if (this.started) this.setStatus('offline', PAUSED_DETAIL);
  }

  /**
   * Resume sync after {@link pause}: connect again through the normal connect
   * flow — the join with the catch-up flag, the catch-up, the drain of what
   * was queued meanwhile, the first upload. Only once the previous
   * connection's flows have ended (they end at their next step; after
   * {@link RESUME_WAIT_MS} the engine connects anyway): one still running
   * would share the file index, the queue and the catch-up with the new one's.
   * A pause, a stop or another resume meanwhile takes over.
   */
  async resume(): Promise<void> {
    if (this.hasStopped || !this.paused) return;
    this.paused = false;
    const attempt = ++this.resumes;
    if (this.started) this.setStatus('connecting');
    await this.connectFlowsEnded();
    if (this.hasStopped || this.paused || attempt !== this.resumes) return;
    this.online = childController(this.lifetime.signal);
    if (this.started) this.socket.connect();
  }

  /** Whether sync is paused (see {@link pause}). */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Keep a flow of the connection known to {@link resume} until it ends, and
   * run it as {@link detach} does. A flow that does not reject (the connect
   * flow catches its own errors) is only tracked.
   */
  private trackConnectFlow(flow: Promise<void>, opts: { detach?: boolean } = {}): void {
    const ended = flow.then(
      () => undefined,
      () => undefined,
    );
    this.connectFlows.add(ended);
    void ended.then(() => this.connectFlows.delete(ended));
    if (opts.detach !== false) this.detach(flow);
  }

  /** Resolves once no connect flow is running, or after {@link RESUME_WAIT_MS}. */
  private async connectFlowsEnded(): Promise<void> {
    const deadline = Date.now() + RESUME_WAIT_MS;
    while (this.connectFlows.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.log.warn('connecting again while the previous connection’s work still runs', {
          flows: this.connectFlows.size,
        });
        return;
      }
      let timer: number | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, left);
      });
      try {
        await Promise.race([Promise.all([...this.connectFlows]), waited]);
      } finally {
        window.clearTimeout(timer);
      }
    }
  }

  /**
   * Stop for good (plugin disabled or reloaded, binding switched off or
   * removed).
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
   * The operation the drain had in flight stays queued, and so does every
   * live one still waiting for its answer, under its `opId`: the next engine
   * asks the server what became of them (see {@link settleUnanswered}) and
   * sends only what it did not apply.
   */
  async stop(): Promise<void> {
    if (!this.hasStopped) {
      this.clearPumpTimer();
      this.handOverHeldChanges();
      this.lifetime.abort(new EngineStoppedError());
      // What was under way is queued now: a delete that joined one waits for
      // nothing more (see `joinDelete`).
      for (const claim of [...this.deleteClaims.values()]) claim.end('gone');
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
      // Nor a transfer Pause sync cancelled: the change is recorded already,
      // and what the transfer was for comes with the next connect.
      if (this.hasStopped || err instanceof SyncPausedError) return;
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

  /**
   * The connect flow: `ops:status` for the queue, the join with its
   * catch-up, the drain. Run on each connect, and again on the same
   * connection (`retry`) after a join the server could not answer (see
   * {@link joinAgainLater}).
   */
  private async onSocketConnect(retry?: JoinRetry): Promise<void> {
    // The connection this flow works for: Pause sync ends it (see `online`),
    // and the flow then unwinds at its next step.
    const online = this.online.signal;
    // A connection of its own for this connect's drains (see `link`). The
    // queue goes out anew from this connect: what the server refused with
    // `busy` on the connection gone, it has forgotten, and `ops:status`
    // below voids; the drain sends it first.
    this.link?.abort(new Error('disconnected'));
    const link = childController(online);
    this.link = link;
    this.drainHandedOver = false;
    this.clearPumpTimer();
    this.queueFirst = false;
    this.queueStuck = false;
    this.pumpStep = 0;
    this.pumpFailures = 0;
    /** This connect's catch-up completion signal, while it is the armed one. */
    let armed: (() => void) | null = null;
    try {
      // A new try keeps the error on show until its join is taken: flipped
      // to `syncing` and back at each try, it had the plugin announce the
      // same error again every minute while the server stayed down.
      if (retry === undefined) this.setStatus('syncing');
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
      // A new try on the same connection has had the answers of what went
      // out on it (see `joinAgain`).
      this.localRenames.clear();
      this.ownCreates.clear();
      this.ownDeletes.clear();
      // Whether this binding had synced before: without a record of it (a
      // first connect, `state.json` lost), the catch-up brings this device's
      // own old operations back as ones it does not know (see `ownRows`).
      const hadState = this.operationLog.getBindingState(this.binding.id) !== null;
      // What became of the queued operations, some of which may have lost
      // their answers — the server is asked before anything else (see
      // `settleUnanswered`). Live changes are queued meanwhile. Nothing is
      // asked when nothing waits: the join goes out at once. What the server
      // answered on this connection stays known on a new try on it: sent
      // while the refused join was on its way and answered, a change is in
      // neither the queue nor on its way, and its row in the new catch-up
      // would be taken for another device's under this device's id.
      this.opsSettled = false;
      if (retry === undefined) this.ownKnown.clear();
      const unanswered = this.operationLog.dequeueOperations(this.binding.id);
      if (unanswered.length > 0) {
        try {
          await this.settleUnanswered(unanswered, link.signal);
        } catch (err) {
          if (!(err instanceof OpsStatusError)) throw err;
          link.signal.throwIfAborted();
          this.log.warn('could not check the queued operations with the server', {
            error: err.reason,
          });
          // The join that tells the server's kind (see `opsStatusFailure`)
          // may be refused with `join_failed` too.
          const failure = await this.opsStatusFailure(err, online);
          this.setStatus('error', failure);
          this.joinAgainLater(failure, link, retry);
          return;
        }
        link.signal.throwIfAborted();
      }
      this.opsSettled = true;
      // Arm the streamed-catch-up completion signal before the join so a fast
      // server stream can't resolve before we're waiting on it.
      const catchupDone = new Promise<void>((resolve) => {
        armed = resolve;
        this.catchupResolve = resolve;
      });

      // Fire `project:join` synchronously (no await before it) so tests can
      // observe the emit immediately and the server starts streaming ASAP;
      // refresh the file index in parallel. The server streams the text docs
      // after its answer, as batched `yjs:catchup` events.
      //
      // Operations applied live before this join: the server's catch-up comes
      // after each of them (see `forgetAppliedLive` below).
      const liveBeforeJoin = this.operationLog.appliedLiveIds(this.binding.id);
      this.startedSinceJoin.clear();
      // A server that does not keep operations idempotent (see below): live
      // changes are queued from its answer on, not from the end of the
      // listing — on a large vault seconds later, and a rename or a delete
      // made meanwhile went to it.
      const joinPromise = this.socket
        .joinProject(this.binding.projectId, this.vectorClock)
        .then((joined) => {
          if (joined.ok && joined.opIdempotency === undefined) this.opsSettled = false;
          return joined;
        });
      const filesPromise = this.refreshFileIndex(online);
      // Known to `resume()` on its own: a join failed by a pause ends this
      // flow at once, while the listing is still on its way.
      this.trackConnectFlow(filesPromise, { detach: false });
      const [result] = await Promise.all([joinPromise, filesPromise]);
      link.signal.throwIfAborted();
      // A new try's join is taken: from here on it syncs as any connect does.
      if (retry !== undefined && result.ok) this.setStatus('syncing');
      // A server that does not keep operations idempotent (`opIdempotency`)
      // would apply a resend twice: nothing is sent to it — the queue keeps
      // what is made here until the server is updated.
      if (result.ok && result.opIdempotency === undefined) {
        this.opsSettled = false;
        this.catchupResolve = null;
        this.setStatus('error', 'server_outdated');
        return;
      }
      const operations = result.ok ? result.operations : [];
      // This device's own operations among them, known by their `opId`s: none
      // but a safeguard, since this device's counter in the join's clock is
      // the one the server logged its last known operation with.
      const own = this.ownRows(operations, hadState);
      // Operations this device applied live: the catch-up returns them again.
      const appliedLive = this.operationLog.appliedLiveIds(this.binding.id);
      // Before any catch-up doc is applied: see `checkLineage`. Not from this
      // device's own operations: a note it created under the name of a
      // deleted one is the note it has.
      this.recreated = notesRecreated(
        operations.filter((op) => !own.has(op)),
        appliedLive,
        { truncated: result.ok && result.operationsTruncated === true },
      );
      // Replaced by a teammate while this device was away (see
      // `reconcileAttachments`).
      const replacedAway: ReadonlySet<string> = new Set(this.recreated);
      const askedBack = this.deleteAskedBack();
      for (const id of askedBack) this.recreated.add(id);
      // Before any catch-up doc or operation lands: the files the queue's
      // operations were made to may be gone from under their ids.
      await this.settleOvertakenQueue(online);
      link.signal.throwIfAborted();

      // Index is ready — let catch-up batches through, draining any that
      // arrived during the join↔refresh window.
      this.indexReady = true;
      const buffered = this.pendingCatchup;
      this.pendingCatchup = [];
      for (const batch of buffered) {
        await this.processCatchupBatch(batch, link.signal);
        link.signal.throwIfAborted();
      }

      if (!result.ok) {
        this.catchupResolve = null;
        this.setStatus('error', result.error);
        this.joinAgainLater(result.error, link, retry);
        return;
      }

      // Apply server-side operations the client missed. This device's own
      // are history in the server's order, and only their clocks are taken in.
      const catchup: Catchup = {
        superseded: supersededOps(result.operations),
        renamedFrom: renameSources(result.operations),
        appliedLive,
      };
      for (const op of result.operations) {
        if (own.has(op)) this.mergeClock(op);
        else await this.applyServerOperation(op, catchup);
        link.signal.throwIfAborted();
      }
      // A catch-up cut short to its newest operations may have left some out:
      // attachments are checked against the listing instead (see
      // `reconcileAttachments`). After a whole one, the attachments new to
      // this device only, and those deleted and created again under their id.
      const partial = result.operationsTruncated === true;
      await this.reconcileAttachments(online, { onlyNew: !partial, replaced: replacedAway });
      link.signal.throwIfAborted();

      // Hydrate Yjs docs: the server streams them via `yjs:catchup` (handled
      // by `handleYjsCatchup`); we wait for the `done` batch here. An answer
      // that announces no stream brings no docs.
      if (result.yjsStream === true) await this.waitForCatchup(catchupDone, link.signal);
      else this.catchupResolve = null;
      link.signal.throwIfAborted();

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
      // One subscription at a time. Added on each connect, they piled up for
      // the engine's lifetime — a reconnect or Pause sync and Resume sync
      // each added one — and every doc opened was wired once for each.
      this.docsAcquiredOff?.();
      this.docsAcquiredOff = this.docManager.onDocAcquired(this.binding.id, (filePath) => {
        const meta = this.fileIndex.byPath.get(filePath);
        if (meta?.fileType === 'TEXT') this.wire(meta.fileId, filePath);
      });

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
      if (!partial) {
        for (const id of liveBeforeJoin) seen.add(id);
      }
      this.operationLog.forgetAppliedLive(this.binding.id, seen);
      // Taken for new files by this connect: under the id is the new one now.
      this.operationLog.forgetDeleteAsked(this.binding.id, askedBack);
      // A change of this connect's refused `busy` meanwhile has put the new
      // ones behind the queue (see `queueFirst`).
      this.setStatus('connected', this.queueFirst ? QUEUE_FIRST_DETAIL : undefined);

      // Reconnect catch-up tail, kicked off in the background so the
      // `connected` status doesn't wait on every queued upload. Ordering
      // inside is load-bearing — see `drainThenInitialPush`. From here on a
      // `busy` has the queue tried again (see `schedulePump`).
      this.drainHandedOver = true;
      this.trackConnectFlow(this.drainThenInitialPush(online, link));
    } catch (err) {
      if (this.catchupResolve === armed) this.catchupResolve = null;
      // Cut short by `stop()` or by Pause sync — not a sync failure.
      if (online.aborted) return;
      // Cut short by the connection dropping: the status says so already, and
      // the next connect starts over — maybe running by now, its status its
      // own.
      if (link.signal.aborted || !this.socketLink.isConnected()) return;
      this.setStatus('error', describeError(err, 'sync_failed'));
    }
  }

  /**
   * After a refusal of the join that asking again may get past (`error` in
   * {@link JOIN_RETRYABLE}: the server could not read what its answer
   * needs), run the connect flow again on the same connection once the next
   * of {@link joinRetryMs} has passed, the last one again and again until a
   * join is taken. The server has taken the socket out of the project's room:
   * until then no teammate's change reaches this device. It used to stay so
   * until Pause sync and Resume sync, or until the connection dropped.
   *
   * Changes made meanwhile wait in the queue, as they wait while a connect
   * checks the queue, and go out after the catch-up of the join taken. Sent
   * at once, one could still be on its way when the try reads the listing,
   * which has the file where it was: a rename was undone on disk.
   *
   * The try belongs to the connection (`link`): it is called off when the
   * connection drops, on Pause sync, on `stop()` and by a new connect, whose
   * own flow runs instead. `retry`: the try the refused flow was, if any.
   */
  private joinAgainLater(error: string, link: AbortController, retry: JoinRetry | undefined): void {
    if (!JOIN_RETRYABLE.has(error)) return;
    this.opsSettled = false;
    const attempt = (retry?.attempt ?? 0) + 1;
    const pauses = this.joinRetryMs;
    const pause = pauses[Math.min(attempt, pauses.length) - 1] ?? 0;
    this.log.warn('the server could not answer the join; joining again', {
      error,
      attempt,
      pause,
    });
    this.trackConnectFlow(this.joinAgain({ link, attempt }, pause));
  }

  /**
   * The try {@link joinAgainLater} set up, once `pause` has passed and every
   * change that went out on the connection before the refusal has its answer
   * (see {@link liveOpsSettled}): the listing the try reads has them all.
   */
  private async joinAgain(retry: JoinRetry, pause: number): Promise<void> {
    const { link } = retry;
    try {
      await waitFor(pause, link.signal);
      // Throws, too, when the link ended right as the pause passed.
      await this.liveOpsSettled(link.signal);
    } catch {
      // The connection dropped, sync was paused or stopped, or a new connect
      // came: whatever joins now is that one's.
      return;
    }
    await this.onSocketConnect(retry);
  }

  // -- Queued operations, some of which may have lost their answers ---------

  /**
   * Ask the server (`ops:status`) what became of the operations in the queue
   * whose answers may have been lost — each one the queue holds: a restart
   * does not know which of them went out. For each one the server applied,
   * `state.json` takes what the answer would have brought (see
   * {@link settleLanded}); each one it did not, it voids — it never applies
   * it now, not even from a packet of the old connection that reaches it
   * later — and the entry is sent again under a new `opId`. An answer to a
   * question (`settleOnly`) the server did not apply is dropped: the question
   * comes again.
   *
   * Operations recorded in flight by this engine are not asked about: their
   * emit, buffered by socket.io, reaches the server before this question, and
   * their answer comes.
   *
   * Before the join and the listing: what they bring is read against a queue
   * that holds only what the server has not applied. Throws
   * {@link OpsStatusError} when the server cannot answer.
   */
  private async settleUnanswered(
    entries: readonly PendingOperation[],
    online: AbortSignal,
  ): Promise<void> {
    let applied = 0;
    let voided = 0;
    for (let i = 0; i < entries.length; i += OPS_STATUS_MAX) {
      const batch = entries.slice(i, i + OPS_STATUS_MAX).map((entry) => entry.opId);
      const answer = await this.askOpsStatus(batch, online);
      for (const row of answer.applied) {
        const entry = this.operationLog.findByOpId(this.binding.id, row.opId);
        this.ownKnown.add(row.opId);
        // Recorded before the entry leaves the queue (its first write takes
        // the counter along): a `state.json` without the entry and with the
        // old counter made the next start's catch-up return the operation as
        // one of another device under this device's id.
        this.adoptOwnCounter(row.vectorClock);
        this.persistVectorClock();
        if (entry === null || this.operationLog.isInFlight(this.binding.id, row.opId)) continue;
        applied += 1;
        await this.settleLanded(entry, row);
        online.throwIfAborted();
      }
      for (const opId of answer.voided) {
        const entry = this.operationLog.findByOpId(this.binding.id, opId);
        if (entry === null || this.operationLog.isInFlight(this.binding.id, opId)) continue;
        voided += 1;
        if (entry.settleOnly === true) this.operationLog.markSent([entry.id]);
        else this.operationLog.rotateOpId(this.binding.id, entry.id);
      }
    }
    // `applied`: the server applied them and their answers were lost; what
    // each would have brought is taken in now (and logged one by one, see
    // `settleLanded`). `voided`: the server never got them — queued while
    // offline or paused, or lost on their way — and they go out again under
    // new `opId`s. The line said `operations whose answers were lost,
    // settled` before, for changes that had only waited in the queue too.
    this.log.info('queued operations checked with the server', {
      asked: entries.length,
      applied,
      voided,
    });
    // Before anything goes out again: the new ids are on disk.
    await this.operationLog.persistNow();
  }

  /**
   * One `ops:status`, asked again after each of {@link opsStatusRetryMs} when
   * the server is busy or does not answer. A lost connection ends the connect
   * flow (the next connect asks again); anything else is an
   * {@link OpsStatusError}.
   */
  private async askOpsStatus(
    opIds: readonly string[],
    online: AbortSignal,
  ): Promise<Extract<OpsStatusResult, { ok: true }>> {
    /** Whether the server answered a try: `timeout` is the client's own. */
    let answered = false;
    for (let attempt = 0; ; attempt++) {
      const answer = await this.socket.opsStatus(
        this.binding.projectId,
        opIds,
        this.opsStatusTimeoutMs,
      );
      online.throwIfAborted();
      if (answer.ok) return answer;
      if (answer.error === 'disconnected') throw new Error('disconnected');
      if (answer.error !== 'timeout') answered = true;
      const pause = this.opsStatusRetryMs[attempt];
      const again = answer.error === 'busy' || answer.error === 'timeout';
      if (!again || pause === undefined) throw new OpsStatusError(answer.error, answered);
      this.log.debug('ops:status not answered; asking again', { error: answer.error, pause });
      await waitFor(pause, online);
    }
  }

  /**
   * The status detail for an `ops:status` that failed ({@link OpsStatusError}).
   * The server's own refusal (`project_not_found`, `forbidden`) as the join
   * would give it. A server that answered no try at all may be one older than
   * the question — it has no handler for it, and says nothing: a join without
   * catch-up (`skipOperations`, `skipYjsCatchup`, as the web editor's) tells.
   * Without `opIdempotency` in its answer it is `server_outdated`, as when the
   * queue is empty, and nothing goes out to it. With it, the server is one
   * that could not answer: out of its room again, since its broadcasts would
   * be read against a queue not settled, and `ops_status_failed` — the next
   * connect asks again.
   */
  private async opsStatusFailure(err: OpsStatusError, online: AbortSignal): Promise<string> {
    if (OPS_STATUS_REFUSALS.has(err.reason)) return err.reason;
    if (err.answered) return 'ops_status_failed';
    const probe = await this.socket.probeProject(this.binding.projectId);
    online.throwIfAborted();
    if (!probe.ok) return probe.error;
    if (probe.opIdempotency === undefined) return 'server_outdated';
    void this.socket.leaveProject(this.binding.projectId).catch(() => undefined);
    return 'ops_status_failed';
  }

  /**
   * An operation of the queue the server applied while its answer was lost
   * (`row`, from `ops:status`): what its answer would have recorded here is
   * recorded, from the data alone — `state.json`, the index, the queue. The
   * disk is left as the live answer leaves it; the listing that comes next
   * brings the paths along.
   */
  private async settleLanded(entry: PendingOperation, row: AppliedOperation): Promise<void> {
    const outcome = (row.outcome ?? {}) as Record<string, unknown>;
    this.log.info('an operation sent from here was applied before its answer was lost', {
      opType: entry.opType,
      path: entry.filePath,
      outcome: outcome.kind,
    });
    switch (entry.opType) {
      case 'CREATE':
        await this.settleLandedCreate(entry, outcome);
        return;
      case 'UPDATE':
        this.settleLandedUpdate(entry, outcome);
        return;
      case 'DELETE':
        await this.settleLandedDelete(entry, outcome);
        return;
      case 'RENAME':
      case 'MOVE':
        // The file stays here where it is. Where the server put it (a
        // conflict name) and a teammate's later rename come with the listing.
        this.operationLog.markSent([entry.id]);
        return;
    }
  }

  /**
   * A create of the queue the server applied (see {@link settleLanded}): the
   * file `F` it stored under `S`, asked for as `A`; the entry says where the
   * file is here now (`L`: a rename made here since moves the entry along).
   *
   * **Restore on server** (`settleOnly`) applied settles its question the way
   * its live answer does: the copy is recorded as the file the server brought
   * back from it, its history under the name started anew from the server's
   * — also when a restart found the file's record from before the question
   * in `state.json`. Kept, the copy's history here met the one the server
   * made from its bytes: the text came back doubled.
   */
  private async settleLandedCreate(
    entry: PendingOperation,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    const F = stringOf(outcome.fileId);
    const conflict = outcome.kind === 'conflict_create_renamed';
    const S = conflict ? stringOf(outcome.finalPath) : stringOf(outcome.path);
    const A = conflict ? stringOf(outcome.originalPath) : stringOf(outcome.path);
    const L = entry.filePath;
    if (F === '' || (S === '' && A === '')) {
      this.operationLog.markSent([entry.id]);
      return;
    }
    const restored = entry.settleOnly === true;
    /** The entry is closed as applied: so is the question it answered. */
    const closed = (): void => {
      if (restored) this.deleteAskedSettled(F);
    };
    const H = stringOf(outcome.contentHash) || stringOf(entry.payload['contentHash']);
    const size =
      typeof outcome.size === 'number'
        ? outcome.size
        : typeof entry.payload['size'] === 'number'
          ? entry.payload['size']
          : 0;
    const typed = outcome.fileType ?? entry.payload['fileType'];
    const fileType: FileType =
      typed === 'TEXT' || typed === 'BINARY' ? typed : classifyFileType(S || A || L);
    const merged = outcome.merged === true;
    // Recorded already: its answer came after all, or it was recorded from
    // another operation's.
    if (this.fileIndex.byId.has(F) && !restored) {
      this.operationLog.markSent([entry.id]);
      return;
    }
    // Where the file is here now: under the name the entry has, under the one
    // the server stored it at (a live answer's move there cut short), or
    // under the one it went out under. Not a name another file holds.
    let here: string | null = null;
    for (const candidate of new Set([L, S, A])) {
      if (candidate === '') continue;
      const holder = this.fileIndex.byPath.get(candidate);
      if (holder !== undefined && holder.fileId !== F) continue;
      if (await this.vault.exists(candidate)) {
        here = candidate;
        break;
      }
    }
    if (here === null) {
      // Deleted here since it went out: the file the server has goes too.
      this.operationLog.replaceOperation(this.binding.id, entry.id, {
        opType: 'DELETE',
        filePath: L,
        payload: H !== '' ? { fileId: F, [LAST_SYNCED]: [H] } : { fileId: F },
      });
      closed();
      return;
    }
    if (merged && here !== A) {
      // The server gave back another device's file under the name asked for;
      // the file here moved on since, and is a note of its own: a create
      // under a new id, in the entry's place.
      this.operationLog.replaceOperation(this.binding.id, entry.id, {
        opType: 'CREATE',
        filePath: here,
        payload: entry.payload,
      });
      closed();
      return;
    }
    const at = here;
    if (at === A || at === S) {
      // Where the answer would have recorded it. Still under the name asked
      // for while the server stored it under a conflict name: the listing
      // moves it there, and the teammate's file under the name comes in.
      let recorded = false;
      await this.recordCreatedFile(F, at, fileType, H, size, () => {
        recorded = true;
        // A note saved since is folded in when its doc comes (the catch-up).
        if (fileType === 'BINARY') this.recheckAttachment(entry, F, at);
        else this.operationLog.markSent([entry.id]);
        closed();
      });
      if (!recorded) this.operationLog.markSent([entry.id]);
      return;
    }
    // Renamed here since it went out: the rename goes out now.
    let recorded = false;
    await this.recordCreatedFile(F, at, fileType, H, size, () => {
      recorded = true;
      this.operationLog.replaceOperation(this.binding.id, entry.id, {
        opType: 'RENAME',
        filePath: S,
        newPath: at,
        payload: { fileId: F },
      });
      closed();
    });
    if (!recorded) this.operationLog.markSent([entry.id]);
  }

  /** An attachment update of the queue the server applied (see {@link settleLanded}). */
  private settleLandedUpdate(entry: PendingOperation, outcome: Record<string, unknown>): void {
    const F = stringOf(outcome.fileId) || queuedFileId(entry.payload);
    const H = stringOf(outcome.contentHash) || stringOf(entry.payload['contentHash']);
    if (outcome.kind === 'updated' && F !== '' && H !== '') {
      // A later delete of the file here knew the file by this version too.
      for (const later of this.operationLog.dequeueOperations(this.binding.id)) {
        if (later.id <= entry.id || later.opType !== 'DELETE') continue;
        if (queuedFileId(later.payload) !== F) continue;
        const known = lastSyncedHashes(later.payload) ?? [];
        if (known.includes(H)) continue;
        this.operationLog.amendOperation(later.id, {
          payload: { ...later.payload, [LAST_SYNCED]: [...known, H] },
        });
      }
      const meta = this.fileIndex.byId.get(F);
      if (meta !== undefined) {
        meta.contentHash = H;
        if (meta.fileType !== 'TEXT' && typeof outcome.size === 'number') {
          meta.size = outcome.size;
        }
        this.operationLog.setFileMeta(meta);
        if (meta.fileType !== 'TEXT') {
          this.recheckAttachment(entry, F, meta.relativePath);
          return;
        }
      }
    }
    this.operationLog.markSent([entry.id]);
  }

  /**
   * An attachment whose create or update the server applied while its answer
   * was lost, recorded at `path` by the version it went out with: its entry
   * stays in the queue, in its place and under a new id, as an update the
   * drain reads the disk for. A save made since — while the plugin was off,
   * with no event to tell — goes out then; with none, nothing does. Taken out
   * of the queue, the save stayed on this disk only.
   */
  private recheckAttachment(entry: PendingOperation, fileId: string, path: string): void {
    this.operationLog.replaceOperation(this.binding.id, entry.id, {
      opType: 'UPDATE',
      filePath: path,
      payload: { fileId },
    });
  }

  /** A delete of the queue the server applied (see {@link settleLanded}). */
  private async settleLandedDelete(
    entry: PendingOperation,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    const F = stringOf(outcome.fileId) || queuedFileId(entry.payload);
    // Checked against the disk when it was made: a file there now is a new one.
    this.freedHere.add(entry.filePath);
    const meta = F !== '' ? this.fileIndex.byId.get(F) : undefined;
    if (meta === undefined) {
      this.operationLog.markSent([entry.id]);
      return;
    }
    const at = meta.relativePath;
    this.fileIndex.byId.delete(F);
    this.forgetPath(this.operationLog, F, at);
    this.operationLog.markSent([entry.id]);
    // Its history goes by its exact name, as the answer's would.
    await this.dropDoc(this.docManager, F, at);
  }

  /**
   * This device's counter in the vector clock, moved up to its counter in
   * `clock` — the one the server logged an operation of this device's with,
   * one past the one it went out with. A catch-up then leaves this device's
   * own operations out. The other clients' counters are not taken: the
   * catch-up brings their operations.
   *
   * The counters under the ids this vault sent operations under before
   * ({@link previousClientIds}) too: an operation of the queue that went out
   * under one of them is logged under it. Left behind, it came back in a
   * catch-up after the id changed — once the connect that settled it had
   * dropped before its catch-up, its `opId` was known no more — and was
   * applied as a teammate's. Only the counter of an operation the server
   * applied for this user under an `opId` of this device's queue gets here.
   */
  private adoptOwnCounter(clock: VectorClock | undefined): void {
    if (clock === undefined) return;
    for (const id of [this.clientId, ...this.previousClientIds]) {
      const counter = clock[id];
      if (typeof counter !== 'number' || !Number.isSafeInteger(counter)) continue;
      if (counter <= (this.vectorClock[id] ?? 0)) continue;
      this.vectorClock = { ...this.vectorClock, [id]: counter };
    }
  }

  /**
   * The rows of a catch-up that are this device's own operations: those with
   * an `opId` it knows (see {@link knowsOpId}), whatever client id they went
   * out under — one of the queue may have gone out under an id this vault had
   * before its id changed (see {@link previousClientIds}). None is applied
   * here again — the file is where this device put it, or has moved it since
   * — and there should be none: this device's counter in the join's clock is
   * the one the server logged its last known operation with (see
   * {@link adoptOwnCounter}).
   *
   * A row under this device's client id with an `opId` it does not know is
   * another device's that uses the same id (a vault copied along with its
   * `data.json`): applied as a teammate's, and reported once (see
   * {@link reportTwin}) — unless the binding had no record of syncing before
   * this connect (`hadState`), when every row of this device's own is one it
   * does not know. So is a row under an id this vault had before, and a row
   * the server logged before it recorded the client (`clientId: null`), with
   * nothing reported.
   */
  private ownRows(ops: readonly ServerOperation[], hadState: boolean): Set<ServerOperation> {
    const own = new Set<ServerOperation>();
    for (const op of ops) {
      if (typeof op.opId === 'string' && this.knowsOpId(op.opId)) own.add(op);
      else if (op.clientId === this.clientId && hadState) {
        this.reportTwin('catch-up', { opType: op.opType, opId: op.opId });
      }
    }
    return own;
  }

  /**
   * Whether `opId` is an operation of this device's: one the server applied
   * that this connect settled or got the answer of ({@link ownKnown}), one on
   * its way ({@link sending}), or one the queue holds.
   */
  private knowsOpId(opId: string): boolean {
    return (
      this.ownKnown.has(opId) ||
      this.sending.has(opId) ||
      this.operationLog.findByOpId(this.binding.id, opId) !== null
    );
  }

  /**
   * An operation under this device's client id that this device did not send
   * (see {@link ownRows}, {@link isOwnBroadcast}): another device uses the
   * same id. Its operations are applied as a teammate's; this is logged once,
   * with the operation that told, and the plugin gives the vault a new id on
   * its next start ({@link SyncEngineDeps.onTwinDetected}).
   */
  private reportTwin(where: string, detail: Record<string, unknown>): void {
    if (this.twinReported) return;
    this.twinReported = true;
    this.log.warn(
      'an operation carries this device’s client id, but this device did not send it: another device uses the same id (a vault copied along with its data.json?); the id changes on the next start',
      { where, clientId: this.clientId, ...detail },
    );
    try {
      this.onTwinDetected?.(this.clientId);
    } catch (err) {
      this.log.warn('could not record that another device uses this device’s client id', {
        err,
      });
    }
  }

  /** Take the clock of catch-up operation `op` in. */
  private mergeClock(op: ServerOperation): void {
    if (op.vectorClock) this.vectorClock = mergeClocks(this.vectorClock, op.vectorClock);
  }

  /** Whether a live operation can go out now: connected, and past `ops:status`. */
  private canSendLive(): boolean {
    return this.socket.isConnected() && this.opsSettled;
  }

  /**
   * Whether a local change can go out now: {@link canSendLive}, and no
   * change the server refused with `busy` waits in the queue ahead of it
   * (see {@link queueFirst}) — it is queued behind them then. A change the
   * drain replays from the queue (`from` `queue`) is the head of the queue,
   * and goes out.
   */
  private mayEmitLive(from: LocalSource): boolean {
    return this.canSendLive() && (from === 'queue' || !this.queueFirst);
  }

  /**
   * Whether operation `op` can go out now (see {@link mayEmitLive}). An
   * answer to a question (`settleOnly`) is never queued to be replayed: it
   * goes out whatever waits in the queue, and one the server refuses is
   * asked again at the next connect.
   */
  private mayEmitOp(op: OutgoingOp): boolean {
    if (op.settleOnly === true) return this.canSendLive();
    return this.mayEmitLive(op.fromQueue === true ? 'queue' : 'watcher');
  }

  /**
   * Send one live file operation, written ahead to `state.json`:
   *
   *   1. recorded in flight (`opId`, payload) and the log written to disk —
   *      a restart finds it in the queue and asks the server about it; no
   *      write, no emit (it goes out with the drain);
   *   2. emitted with its `opId`, known in {@link sending} until answered;
   *   3. answered: `onAck` records the result and calls `settle` in the same
   *      synchronous block as its last write to `state.json` — the entry
   *      leaves the log together with the result it brought (and this
   *      device's counter moves up to the one the server logged it with). A
   *      handler that records nothing is settled when it returns; one that
   *      throws leaves the entry for the next connect to settle;
   *   4. refused for good (`*_not_found`, …): the entry goes; for another
   *      try (`busy`, …) or with no answer (the connection dropped, Pause
   *      sync): the entry goes back to the queue — under a new `opId` when
   *      the server voided the old one. `stop()` puts every entry still in
   *      flight back there (see {@link handOverHeldChanges}).
   *
   * An answer to a question (`settleOnly`) the server refused goes: the
   * question comes again.
   */
  private async sendOp<T>(
    op: OutgoingOp,
    emit: (opId: string) => Promise<FileAck>,
    onAck: (
      ack: AckOk<{ outcome?: unknown; log?: ServerLogEntry }>,
      settle: () => void,
    ) => Promise<T> | T,
  ): Promise<SendResult<T | undefined>> {
    const bindingId = this.binding.id;
    // Recorded ahead with others (see `handleLocalFolderDelete`), it goes
    // back to its place in the queue (see `queueOp`).
    if (!this.mayEmitOp(op)) return { kind: 'queued', entry: this.queueOp(op) };
    if (!this.operationLog.isInFlight(bindingId, op.opId)) {
      this.operationLog.recordInFlight(bindingId, op);
    }
    this.inflightHere.add(op.opId);
    try {
      // Written together with others recorded ahead: nothing to wait for.
      if (!this.operationLog.inFlightWritten(bindingId, op.opId)) {
        await this.operationLog.persistNow();
      }
    } catch (err) {
      this.throwIfStopped();
      this.log.warn('state.json not written; the operation waits in the queue', {
        opType: op.opType,
        path: op.filePath,
        error: describeError(err, 'state_not_written'),
      });
      return { kind: 'queued', entry: this.requeueInFlight(op.opId) };
    }
    this.throwIfStopped();
    this.dropIfDrainGone(op);
    // Offline meanwhile, or another change was refused `busy`: this one goes
    // behind it, in its place.
    if (!this.mayEmitOp(op)) return { kind: 'queued', entry: this.requeueInFlight(op.opId) };
    let ack: FileAck;
    this.sending.add(op.opId);
    try {
      ack = await emit(op.opId);
    } catch {
      // No answer: the connection dropped, Pause sync closed it, or the engine
      // stopped (which put the entry back itself).
      this.throwIfStopped();
      return { kind: 'queued', entry: this.requeueInFlight(op.opId) };
    } finally {
      this.sending.delete(op.opId);
    }
    this.throwIfStopped();
    if (!ack.ok) return this.afterRefusal(op, ack.error);
    if (ack.duplicate === true) {
      this.log.warn('a live operation was answered as a resend', { opType: op.opType });
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      this.adoptOwnCounter(ack.log?.vectorClock);
      this.persistVectorClock();
      this.operationLog.clearInFlight(bindingId, op.opId);
      this.leftFlight(op.opId);
      this.ownKnown.add(op.opId);
    };
    try {
      const value = await onAck(ack, settle);
      settle();
      return { kind: 'acked', value };
    } catch (err) {
      // Applied, and its result not recorded: the next connect settles it.
      if (!settled && !this.hasStopped) this.requeueInFlight(op.opId);
      throw err;
    }
  }

  /**
   * `op`, sent by a replay of the queue (`fromQueue`) and recorded in flight,
   * is not sent when the drain's connection is gone (see `link`): the queue
   * entry it came from stays for the next connect's drain, and nothing of
   * `op` is kept. Throws the connection's end, as {@link emitQueued} does.
   *
   * The drain's own emits stopped with its connection; what its replay sent
   * through the live handlers did not — a queued create of a file the server
   * has went out as an update of it, a rename into Obsidian's trash as a
   * delete (see `replayPending`). An attachment's version whose upload
   * outlasted the connection went out over the next one, ahead of its
   * catch-up and its drain: over a teammate's newer version that catch-up
   * was asking the user about.
   */
  private dropIfDrainGone(op: OutgoingOp): void {
    const drain = this.drainSignal;
    if (op.fromQueue !== true || drain === null || !drain.aborted) return;
    if (this.operationLog.clearInFlight(this.binding.id, op.opId)) this.leftFlight(op.opId);
    drain.throwIfAborted();
  }

  /** {@link sendOp} refused by the server: see there. */
  private afterRefusal(op: OutgoingOp, error: string): SendResult<never> {
    if (error === 'invalid_op_id') {
      this.log.warn('the server refused an operation id', { opType: op.opType, opId: op.opId });
    }
    const outcome = ackToOutcome({ ok: false, error });
    // Nothing of it was applied: an answer to a question goes, and so does
    // an operation refused for good.
    if (op.settleOnly === true || (!outcome.ok && !outcome.retryable)) {
      this.operationLog.clearInFlight(this.binding.id, op.opId);
      this.leftFlight(op.opId);
      this.log.debug('operation refused by the server', { opType: op.opType, error });
      return { kind: 'refused', error };
    }
    const entry = this.requeueInFlight(op.opId, { rotate: error === 'op_voided' });
    if (error === 'busy') {
      // The server refuses every later file operation of this connection
      // until its queue has passed this one: later changes wait behind it,
      // and the queue goes out again shortly (see `queueFirst`).
      this.closeGate();
      this.schedulePump();
    }
    return { kind: 'queued', entry };
  }

  /** Put operation `opId`, recorded in flight here, back in the queue. */
  private requeueInFlight(opId: string, opts: { rotate?: boolean } = {}): PendingOperation | null {
    // Waiters look again once this call has returned: the entry is queued by then.
    this.leftFlight(opId);
    return this.operationLog.requeueInFlight(this.binding.id, opId, opts);
  }

  /**
   * `opId` is not in flight here any more (see {@link inflightHere}): a
   * drain waiting for that (see {@link liveOpsSettled}) looks again.
   */
  private leftFlight(opId: string): void {
    if (!this.inflightHere.delete(opId)) return;
    for (const wake of [...this.flightWaiters]) wake();
  }

  /**
   * Queue `op` under its `opId`, unless the queue has it already. One recorded
   * in flight ahead and not sent — a folder's delete (see
   * `recordDeletesAhead`) — goes back to its place in the queue. Taken for
   * queued already, it stayed in flight, and the folder's delete took it off
   * as never sent: the files of a folder whose delete met a dropped
   * connection, Pause sync or a `busy` halfway through were deleted here and
   * never on the server, and came back with the next connect.
   */
  private queueOp(op: OutgoingOp): PendingOperation | null {
    if (this.operationLog.isInFlight(this.binding.id, op.opId)) {
      const entry = this.requeueInFlight(op.opId);
      if (entry === null) return null;
      // With what the caller has learnt of it since it was recorded: a
      // note's state when it was deleted (see `DOC_STATE`).
      this.operationLog.amendOperation(entry.id, { payload: op.payload });
      return { ...entry, payload: { ...op.payload } };
    }
    const known = this.operationLog.findByOpId(this.binding.id, op.opId);
    if (known !== null) return known;
    this.throwIfStopped();
    return this.operationLog.enqueueOperation(this.binding.id, op);
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
    // It came on the connection open now.
    await this.processCatchupBatch(batch, this.online.signal);
  }

  /**
   * Applies a catch-up batch's docs; the final `done` batch ends the wait.
   * `online`: the connection the batch came on (see `online`).
   */
  private async processCatchupBatch(batch: YjsCatchupBatch, online: AbortSignal): Promise<void> {
    for (const snap of batch.docs) {
      await this.applyCatchupDoc(snap);
      online.throwIfAborted();
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
        //
        // Текст заметки на диске, значит, она здесь есть (см. `notOnDisk`).
        if (meta.notOnDisk === true) {
          delete meta.notOnDisk;
          if (this.fileIndex.byId.get(meta.fileId) === meta) this.operationLog.setFileMeta(meta);
        }
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
   *
   * Not for a note whose history was started anew from the server's
   * broadcasts since the join went out (see {@link startedSinceJoin}): each
   * change to it since reaches this device live, and the catch-up's doc of it
   * may be older than that. The server encodes each batch as it sends it, and
   * one encoded before a teammate deleted the note and created it again under
   * its name holds the deleted note's history — on a server that replaces the
   * history on revival (every one before 0.3.8's), a history of its own. The
   * engine keeps batches that come before the listing, and a slow listing of
   * a large vault lets the revival's broadcasts through first. Applied after
   * them, the old history was taken for the note's, the new one was deleted,
   * and the deleted note's text came back to disk; the next edit here went to
   * the server on the old history, and once the two histories met there, the
   * note's text was doubled for the whole team.
   */
  private async applyCatchupDoc(snap: YjsDocSnapshot): Promise<void> {
    const meta = this.fileIndex.byId.get(snap.fileId);
    // Only a note has a history (see `handleServerYjsUpdate`).
    if (meta?.fileType !== 'TEXT') return;
    // Deleted, or started anew, since the doc was picked up. (Renamed, it
    // took the doc along, and `meta` names the new path.)
    const overtaken = (): boolean =>
      this.fileIndex.byId.get(snap.fileId) !== meta || this.startedSinceJoin.has(snap.fileId);
    if (this.startedSinceJoin.has(snap.fileId)) {
      this.log.debug('catch-up doc of a note started anew since the join left out', {
        path: meta.relativePath,
      });
      return;
    }
    if (await this.catchupDocIsRedundant(meta, snap)) return;
    // The offline doc store (y-indexeddb) loads asynchronously. Applying the
    // server's state to a doc that hasn't finished loading computes a bogus
    // push-back diff and snapshots a local-history-less merge over the file
    // on disk — a silent rollback.
    await this.openDoc(meta);
    if (overtaken()) return;
    const update = Uint8Array.from(snap.sync1);
    const checked = await this.withPathLock(meta.relativePath, async (): Promise<boolean> => {
      if (overtaken()) return false;
      await this.checkLineage(meta, this.docPathOf(meta), update);
      await this.noteDiskAgreement(meta);
      return true;
    });
    if (!checked || overtaken()) return;
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
   * in between — a reload, the plugin turned off, Obsidian closed while the
   * server's version history was looked up — left the disk with edits the
   * server never got, a fold marker saying they were folded, and no history
   * holding them: the next start wrote the server's text over them.
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
    const replaced = this.recreated.has(meta.fileId);
    const found = await this.docManager.lineageOf(this.binding.id, docPath, meta.fileId, server, {
      replaced,
      recorded: !this.newHere.has(meta.fileId),
      // Whether the server had text for the note when this device last synced it.
      hadText: meta.size > 0,
    });
    this.throwIfStopped();
    if (found === null) return;
    this.lineageChecked.add(meta.fileId);
    if (found.related && !replaced) return;
    this.foldBases.delete(meta.fileId);
    const serverText = textOf(server);
    if (found.related) {
      // A note deleted and created again whose history this device never had:
      // the catch-up skipped its doc while the disk matched the server's (see
      // `catchupDocIsRedundant`), and a save made offline since stayed on disk
      // only (see `handleLocalModify`). There is no history to start anew, but
      // the copy on disk is the deleted note's all the same. Taken for the new
      // note's, the next fold put its text over the new note's for the whole
      // team — without a base, or merged three-way with one from the version
      // history — and kept no copy of it.
      this.log.info('a note deleted and created again has no history here; settling its copy', {
        path: meta.relativePath,
        fileId: meta.fileId,
      });
      await this.setAsideOldCopy(meta, serverText);
    } else {
      this.log.warn('a note’s offline history is not the server’s; starting it from the server', {
        path: meta.relativePath,
        fileId: meta.fileId,
        owner: found.owner,
      });
      await this.setAsideOldCopy(meta, serverText);
      await this.docManager.startOver(this.binding.id, docPath, meta.fileId);
    }
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
   * `connection`: the connection the catch-up comes on (see `link`).
   */
  private waitForCatchup(done: Promise<void>, connection: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        connection.removeEventListener('abort', finish);
        this.catchupResolve = null;
        resolve();
      };
      const timer = window.setTimeout(finish, CATCHUP_TIMEOUT_MS);
      // `stop()`, Pause sync and the connection dropping end the wait at
      // once: the connect flow unwinds instead of waiting out the guard for
      // batches that no longer come. Waited out, a pause during the catch-up
      // reported the binding connected five minutes later, and its drain ran
      // while paused. A connection dropped during the catch-up of a large
      // vault left the flow waiting beside the next connect's: the guard
      // then took the next catch-up's signal away — that connect waited five
      // minutes more — and the flow reported the binding connected in the
      // middle of the next catch-up.
      if (connection.aborted) finish();
      else connection.addEventListener('abort', finish, { once: true });
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
   *
   * A drain still running from before — a try of the queue after `busy`
   * (see {@link runDrain}) — is waited for, not skipped: skipped, the upload
   * pass went ahead of the queue.
   */
  private async drainThenInitialPush(online: AbortSignal, link: AbortController): Promise<void> {
    try {
      await this.runDrain(link, 'connect');
    } catch {
      // A drain stopped with the engine or by Pause sync ends the tail here:
      // the first upload of a paused connection would queue every new file.
      online.throwIfAborted();
      // A failed drain must not block the initial-push pass — pre-existing
      // files still need their first upload, and whatever stayed queued is
      // retried on the next reconnect. `initialPush` itself skips paths
      // that are still queued.
    }
    // The connection is gone: the next connect's tail uploads. Run on, the
    // upload pass sent new files over that connection ahead of its drain.
    if (link.signal.aborted) return;
    try {
      const unsettled = await this.initialPush(online);
      // The copies of files deleted while away are gone by now, but for those
      // the first upload could not settle.
      await this.pruneCatchupFolders(unsettled);
    } finally {
      await this.askAboutRetiredWhileAway(online);
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
   *
   * The paths of copies of files deleted while this device was away (see
   * {@link deletedWhileAway}) it could not settle — left as they are for the
   * next connect — or `null` when it settled none: the server's deleted files
   * could not be looked up.
   */
  private async initialPush(online: AbortSignal): Promise<ReadonlySet<string> | null> {
    const paths = await this.vault.list(this.binding.localFolder);
    const pending = this.operationLog.pendingPaths(this.binding.id);
    // Paths the server currently holds as tombstones. Re-uploading one would
    // resurrect an intentionally-deleted file: initialPush walks the raw disk,
    // and a file the server deleted but that is still on disk would come back
    // as a fresh CREATE. Honour the server's tombstones instead.
    const tombstones = await this.fetchServerTombstones();
    online.throwIfAborted();
    if (tombstones === null) {
      // Couldn't confirm the server's tombstones. Don't risk re-uploading a
      // deleted-but-still-on-disk file — after catch-up merges the delete
      // clock, the server's causal guard can't stop the resurrection. Defer
      // the whole pass; the next reconnect / a live watcher CREATE retries the
      // genuinely-new files.
      this.log.debug('initialPush: tombstone lookup failed; deferring upload pass');
      return null;
    }
    const unsettled = new Set<string>();
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
        online.throwIfAborted();
        try {
          if ((await this.dropDeletedWhileAway(away.record, away.serverHash, false)) === 'ask') {
            asks.push(away);
          }
        } catch {
          online.throwIfAborted();
          // Left as it is: the next connect finds the record again.
          unsettled.add(away.record.relativePath);
        }
      }
      await this.uploadNewFiles(paths, pending, tombstones.paths, deletedAway, online);
      for (const away of asks) {
        online.throwIfAborted();
        try {
          await this.dropDeletedWhileAway(away.record, away.serverHash, true);
        } catch {
          online.throwIfAborted();
          // Left as it is: the next connect finds the record again.
          unsettled.add(away.record.relativePath);
        }
      }
    } finally {
      for (const [path, away] of deletedAway) {
        if (this.awayCopies.get(path) === away.record.serverFileId) this.awayCopies.delete(path);
      }
    }
    return unsettled;
  }

  /** The upload pass of {@link initialPush}. */
  private async uploadNewFiles(
    paths: readonly string[],
    pending: ReadonlySet<string>,
    tombstoned: ReadonlySet<string>,
    deletedAway: ReadonlyMap<string, unknown>,
    online: AbortSignal,
  ): Promise<void> {
    for (const path of paths) {
      online.throwIfAborted();
      // Watcher events are filtered upstream, but this pass walks the raw
      // vault listing — without the same filter it uploads throw-away
      // artifacts (e.g. Obsidian's orphaned `*.tmp.<pid>.<hex>` files).
      if (this.isIgnoredLocalPath(path)) continue;
      // Or a recorded file under another case (see `spelledHere`).
      if (this.knownHere(path)) continue;
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
      online.throwIfAborted();
      if (this.knownHere(path)) continue;
      try {
        await this.handleLocalCreate(path);
      } catch {
        online.throwIfAborted();
        // Per-file failures are swallowed — the watcher / next reconnect
        // will surface them again.
      }
    }
  }

  /**
   * Whether the file on disk at `path` is the copy of an indexed file, in
   * this case or another (see `spelledHere`). Not under the name of a file
   * whose content never reached this disk: the file there is another one, one
   * whose create event was missed (see `yieldNameNotWritten`).
   */
  private knownHere(path: string): boolean {
    const meta = this.fileIndex.byPath.get(this.spelledHere(path));
    return meta !== undefined && !(meta.notOnDisk === true && meta.relativePath === path);
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
      // Asked about already, since a teammate deleted it live.
      if (this.askingDeleted.has(id)) continue;
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
    this.startWrittenCheck();
  }

  /**
   * Settle the records of files never written here whose file is on disk
   * (see {@link settleWrittenHere}) as the engine starts, against what they
   * are known by without the listing: the disk, `state.json` and the note's
   * offline history. Checked only at connect, such a file was taken for
   * another one at its first save before then — and a crash, or a "Reload
   * app without saving", brings the user back to the note they were at. The
   * save went up as a new file, a conflict copy for the whole team, and the
   * note's offline history, the one proof that the text on disk was the
   * teammate's, was deleted with it (see `yieldNameNotWritten`). Offline, or
   * before a slow listing, that is the first thing to happen.
   *
   * A save of such a file waits for its check (see {@link createLocal}); the
   * connect waits for all of them before it checks what is left against the
   * listing (see {@link recordWrittenAfterAll}).
   */
  private startWrittenCheck(): void {
    const signal = this.lifetime.signal;
    const checks: Array<Promise<void>> = [];
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      const path = record.relativePath;
      if (record.notOnDisk !== true) continue;
      if (this.fileIndex.byPath.get(path)?.fileId !== record.serverFileId) continue;
      const done = this.settleWrittenHere(record, [record.contentHash], signal).catch(
        (err: unknown) => {
          // Stopped meanwhile: nothing failed.
          if (this.hasStopped) return;
          this.log.debug('check of a file not written here failed', path, err);
        },
      );
      this.writtenChecks.set(path, done);
      void done.then(() => {
        if (this.writtenChecks.get(path) === done) this.writtenChecks.delete(path);
      });
      checks.push(done);
    }
    if (checks.length > 0) this.writtenCheck = Promise.all(checks).then(() => undefined);
  }

  /** `online`: the connection the refresh is for (see `online`). */
  private async refreshFileIndex(online: AbortSignal): Promise<void> {
    const renamesBefore = new Map(this.renameCount);
    const deletesBefore = new Set(this.deletedIds);
    const listed = await this.api.getProjectFiles(this.binding.projectId);
    // A listing that lands after `stop()` must not rewrite the log's file meta,
    // nor one that lands after Pause sync the index the paused engine keeps
    // recording local changes in.
    online.throwIfAborted();
    this.lastListing = new Map(listed.map((f) => [f.id, f]));
    // What the check at start settles is settled first (see `startWrittenCheck`).
    await this.writtenCheck;
    online.throwIfAborted();
    await this.recordWrittenAfterAll(online);
    // Records of files never written here (see `FileMeta.notOnDisk`) hold no
    // copy to settle: a file under such a name is another one. Taken for a
    // copy, it was moved along with the teammate's rename of the file, or the
    // user was asked whether to delete it with the file. Only one the listing
    // has under that very name is kept, for the index below to tell whether a
    // file was saved there since.
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      if (record.notOnDisk !== true) continue;
      const listedAt = this.lastListing.get(record.serverFileId)?.path;
      if (listedAt === record.relativePath) continue;
      this.operationLog.deleteFileMeta(this.binding.id, record.relativePath);
      // Deleted on the server: a file under the name is a new one whatever
      // tombstone is there, and the first upload sends it (see `freedHere`).
      if (listedAt === undefined) this.freedHere.add(record.relativePath);
    }
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
    // Deleted by a teammate while the user is asked about the copy here (see
    // `askingDeleted`): a listing taken before the delete still has the file.
    const files = listed.filter((f) => !deletedHere.has(f.id) && !this.askingDeleted.has(f.id));
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
    const absent = await this.absentHere(files);
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
      // Recorded as never written here, and a file is under the name now:
      // saved while Obsidian was closed or the plugin off — another one,
      // which the first upload sends as such (see `yieldNameNotWritten`).
      const savedOver = !absent.has(f.id) && this.recordedNotOnDisk(f.id, f.path);
      if (savedOver) this.forgetRecord(this.operationLog, f.id, f.path);
      if ((takenHere.has(f.path) && local !== f.path) || createdHereFirst || savedOver) {
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
      this.indexListedFile(f, byPath, byId, undefined, absent.has(f.id));
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
      // The copy that was there has moved out just now.
      const gone = !(await this.vault.exists(f.path));
      this.indexListedFile(f, this.fileIndex.byPath, this.fileIndex.byId, undefined, gone);
    }
  }

  /**
   * Records of files never written here (see `FileMeta.notOnDisk`) whose
   * content is under their name after all: the engine wrote it, and the
   * record of the write was lost. Each is settled by {@link settleWrittenHere},
   * against the content the listing gives it now as well (the catch-up can
   * bring a newer one than the listing did when it was recorded). After the
   * check at start (see {@link startWrittenCheck}), which settles what it can
   * without the listing. `online`: see `refreshFileIndex`.
   */
  private async recordWrittenAfterAll(online: AbortSignal): Promise<void> {
    for (const record of this.operationLog.listFileMeta(this.binding.id)) {
      if (record.notOnDisk !== true) continue;
      const listed = this.lastListing.get(record.serverFileId)?.contentHash;
      await this.settleWrittenHere(record, [record.contentHash, listed], online);
    }
  }

  /**
   * A record of a file never written here (see `FileMeta.notOnDisk`) whose
   * content is under its name after all: the engine wrote it, and the record
   * of the write was lost. `state.json` takes a change of a record after a
   * moment's delay, and neither a crash nor Obsidian's "Reload app without
   * saving" (a reload of the window: no `quit`, no unload) waits for it. A
   * teammate's file written in that moment stayed recorded as never come.
   * Taken for a file saved under the name, it went up as a new file — once
   * the teammate had edited theirs, a conflict copy with the old content for
   * the whole team; once they had deleted it, the file back for everyone.
   *
   * The file under the name is the teammate's when its content is one it is
   * known by (`known`: the content the listing gave when it was recorded, the
   * content the listing gives now); a file of the user's with that very
   * content is the same file. A teammate typing on in the moment after the
   * listing leaves the content on disk known by nothing but this device's
   * own proof: the note's offline history (see
   * {@link writtenByThisDevice}). An attachment has none; the listing's hash
   * of it moves with its bytes.
   *
   * Recorded then as a copy, synced at that content, and the content kept as
   * the note's fold base: a save of the note before its catch-up is folded
   * against it (see `resolveFoldBase`) — without one, the save replaced the
   * teammate's text the offline history holds beyond the disk, for everyone.
   * `signal`: the connection the check is for, or the engine's lifetime.
   */
  private async settleWrittenHere(
    record: FileMeta,
    known: ReadonlyArray<string | undefined>,
    signal: AbortSignal,
  ): Promise<void> {
    const path = record.relativePath;
    let hash: string;
    let size: number;
    let text: string | null = null;
    try {
      if (!(await this.vault.exists(path))) return;
      if (record.fileType === 'TEXT') {
        text = await this.vault.readText(path);
        hash = await sha256Hex(text);
        size = new TextEncoder().encode(text).byteLength;
      } else {
        const data = await this.vault.readBinary(path);
        hash = await sha256Hex(data);
        size = data.byteLength;
      }
    } catch {
      // Unreadable now: left as it is, for the index to go by the record.
      signal.throwIfAborted();
      return;
    }
    signal.throwIfAborted();
    let by: 'listing' | 'text' | 'mark' | null = known.includes(hash) ? 'listing' : null;
    if (by === null && text !== null) {
      by = await this.writtenByThisDevice(record, text, hash);
      signal.throwIfAborted();
    }
    if (by === null) return;
    // Changed while the file was read: that change stands.
    const now = this.operationLog.getFileMeta(this.binding.id, path);
    if (
      now?.notOnDisk !== true ||
      now.serverFileId !== record.serverFileId ||
      now.contentHash !== record.contentHash
    ) {
      return;
    }
    if (by === 'listing') {
      this.log.info('a file recorded as not written here is on disk; taken for its copy', {
        path,
        fileId: record.serverFileId,
      });
    } else {
      this.log.info(
        'a file recorded as not written here matches its offline history; taken for its copy',
        { path, fileId: record.serverFileId, by },
      );
    }
    // The text is in the note's history here, or comes with the server's.
    const folded = record.fileType === 'TEXT' ? { foldedHash: hash } : {};
    const copy: FileMeta = { ...now, contentHash: hash, size, ...folded };
    delete copy.notOnDisk;
    this.operationLog.setFileMeta(copy);
    const indexed = this.fileIndex.byPath.get(path);
    if (indexed?.fileId === record.serverFileId && indexed.notOnDisk === true) {
      delete indexed.notOnDisk;
      Object.assign(indexed, { contentHash: hash, size, ...folded });
    }
    if (text !== null) this.foldBases.set(record.serverFileId, { text, hash });
  }

  /**
   * Whether the note on disk under the name of `record`, `text` (hashed to
   * `hash`), is what this device wrote there from the note's offline history
   * (y-indexeddb): the history under that very name is stamped for the note
   * (see `DocManager.open`) and holds that text byte for byte — or holds the
   * mark the engine put there right before it wrote this very text (see
   * `DocManager.noteWritten`), when the teammate typed on after the write.
   * The mark need not be confirmed by the write (see
   * `DocManager.confirmWritten`): a crash can take the confirmation, and a
   * disk holding the very text marked is that text either way.
   * The history reaches IndexedDB with each edit, the disk half a second
   * after the last one at the earliest, and `state.json` a moment after
   * that: after a crash, the history has the text on disk, and more.
   *
   * Byte for byte: the engine writes the doc's text as it is, line ends and
   * all, and a file whose line ends were changed since is the user's.
   * `null` when it is not, or when there is no history to tell — no store
   * under the name, or none that loaded in time.
   */
  private async writtenByThisDevice(
    record: FileMeta,
    text: string,
    hash: string,
  ): Promise<'text' | 'mark' | null> {
    const stored = await this.docManager.peek(this.binding.id, record.relativePath);
    if (stored === null || stored.owner !== record.serverFileId) return null;
    if (stored.text === text) return 'text';
    const mark = stored.written;
    return mark !== null && mark.fileId === record.serverFileId && mark.hash === hash
      ? 'mark'
      : null;
  }

  /**
   * The files of `files` this device has no record of and no file under the
   * name of: new to this device, their content not on its disk yet (see
   * `FileMeta.notOnDisk`). By id.
   */
  private async absentHere(files: readonly ApiFile[]): Promise<Set<string>> {
    const absent = new Set<string>();
    const onDisk = new Set(await this.vault.list(this.binding.localFolder));
    for (const f of files) {
      if (onDisk.has(f.path) || !this.isLocalName(f.path)) continue;
      const recorded = this.operationLog.getFileMeta(this.binding.id, f.path);
      if (
        recorded !== null &&
        recorded.notOnDisk !== true &&
        (recorded.serverFileId === f.id || recorded.serverFileId === '')
      ) {
        continue;
      }
      // Obsidian lists the vault from its own index, which can be a step
      // behind the disk.
      if (!(await this.vault.exists(f.path))) absent.add(f.id);
    }
    return absent;
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
    const recorded = this.operationLog.getFileMeta(this.binding.id, path);
    return recorded?.serverFileId === fileId && recorded.notOnDisk !== true;
  }

  /** Whether `state.json` has file `fileId` under `path` as never written here. */
  private recordedNotOnDisk(fileId: string, path: string): boolean {
    const recorded = this.operationLog.getFileMeta(this.binding.id, path);
    return recorded?.serverFileId === fileId && recorded.notOnDisk === true;
  }

  /**
   * Index one file of the listing at its listed path, and mirror it to
   * `state.json`. `recorded`: this device's record of the file, when it is
   * not the one at `f.path`. `absent`: no file is under its name here (see
   * `FileMeta.notOnDisk`).
   */
  private indexListedFile(
    f: ApiFile,
    byPath: Map<string, IndexedMeta>,
    byId: Map<string, IndexedMeta>,
    recorded: FileMeta | null = this.operationLog.getFileMeta(this.binding.id, f.path),
    absent = false,
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
    // no id comes from an old log and keeps the benefit of the doubt. One of
    // a file never written here is no record of a copy (see `notOnDisk`).
    const existing =
      recorded !== null &&
      recorded.notOnDisk !== true &&
      (recorded.serverFileId === f.id || recorded.serverFileId === '')
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
      ...(existing === null && absent ? { notOnDisk: true as const } : {}),
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
   * {@link notesRecreated}). It can leave that out — one cut short to its
   * newest operations leaves the older ones out — so a delete is also held
   * back when the listing shows content this device never had for the file:
   * changed by a teammate since, or made anew. A teammate's edit to a note
   * deleted here offline then brings the note back, rather than going away
   * with it; a new note with the content of the deleted one (two empty
   * "Untitled") is still deleted.
   *
   * Every queued operation of such a file is dropped, and the file the server
   * has comes back here (see {@link takeBackOvertaken}).
   */
  private async settleOvertakenQueue(online: AbortSignal): Promise<void> {
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
        const within = await this.serverDocWithin(fileId, op.payload);
        // Paused while the server's doc was asked for: no answer, not a "no".
        // Taken for one, the delete was dropped and the note came back.
        online.throwIfAborted();
        if (!within) overtaken.add(fileId);
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
      online.throwIfAborted();
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
    if (meta !== undefined) await this.letGoOfOldCopy(meta, listed);
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
    this.indexListedFile(listed, this.fileIndex.byPath, this.fileIndex.byId, null, true);
    // A note's text comes with the catch-up; an attachment is downloaded.
    if (listed.fileType === 'BINARY') {
      await this.applyServerCreate({ id: fileId, path, fileType: listed.fileType });
    }
  }

  /**
   * See {@link takeBackOvertaken}: the index, `state.json` and history this
   * device has of `meta` go, and its copy on disk with them when the server
   * had that content. A copy with content the server never had stays, set
   * aside under a conflict name when the file coming back (`coming`) takes its
   * name.
   *
   * A copy with the content of the file coming back is that file: written
   * here from its broadcast just before the process ended, and the record of
   * the write lost with it. Kept aside, it went to the server as a new file —
   * a copy of the teammate's file for the whole team.
   */
  private async letGoOfOldCopy(meta: IndexedMeta, coming: ApiFile): Promise<void> {
    const path = meta.relativePath;
    const localHash = await this.hashFile(this.vault, path);
    const serverHad =
      localHash === null ||
      localHash === meta.contentHash ||
      localHash === coming.contentHash ||
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
      if (path !== coming.path) return;
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
    // The copy of a deleted file the user is being asked about (see
    // `askedCopies`), out of the index meanwhile: a save of it that was still
    // on its way — Obsidian's, held in the watcher's debounce when the
    // question came — is left to the answer, which reads the copy as it is
    // then. Sent as a create, it brought the note back for the whole team
    // before the user answered, and **Delete locally** was then ignored: the
    // file under the name was another's.
    if (this.askedCopies.has(path) && !this.fileIndex.byPath.has(path)) return;
    // A create of this name under way here, or a rename into it waiting for
    // one (see `renameAfterCreate`): the file is recorded once it is done.
    const underway = this.creating.get(path);
    if (underway !== undefined) await underway;
    await this.createLocal(path, from);
  }

  /** {@link handleLocalCreate} past its checks: send the create, or the save of a known file. */
  private async createLocal(path: string, from: LocalSource): Promise<void> {
    // A file never written here waits for its check at start: it may be the
    // one the engine wrote, the record of the write lost (see
    // `startWrittenCheck`). Taken for another first, it went up as a new file,
    // and its note's offline history — the proof — went with the name.
    const checking =
      this.fileIndex.byPath.get(path)?.notOnDisk === true
        ? this.writtenChecks.get(path)
        : undefined;
    if (checking !== undefined) await checking;
    const known = this.fileIndex.byPath.get(path);
    // No file here after all: a stray event, nothing to send.
    if (known?.notOnDisk === true && (await this.yieldNameNotWritten(known)) === 'none') return;
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
   * A file saved here under the name of `meta`, a file whose content has not
   * reached this disk (see `FileMeta.notOnDisk`): a teammate's, listed at a
   * connect that the pause, the connection lost or a restart cut short before
   * its catch-up wrote it, or broadcast and not downloaded yet. The file here
   * is another one, this device's own. It goes to the server as a new file,
   * which stores it under a conflict name, and moves there (see
   * `recordCreateAck`); `meta` leaves the index meanwhile and waits for the
   * name (see {@link waitForName}), as a file listed under the name of a file
   * created here offline does (see `refreshFileIndex`).
   *
   * Taken for a save of that file, the file here went to the server as its
   * new version when sync resumed — a note's text replaced the teammate's,
   * an attachment's bytes theirs, for the whole team, and no copy kept.
   *
   * `'yielded'`; `'none'` when there is no file under the name after all;
   * `'changed'` when `meta` was written, moved or dropped meanwhile.
   */
  private async yieldNameNotWritten(meta: IndexedMeta): Promise<'yielded' | 'none' | 'changed'> {
    const path = meta.relativePath;
    return this.withPathLock(path, () =>
      this.commitLocal(async (io): Promise<'yielded' | 'none' | 'changed'> => {
        // The engine writes a file's content after it clears the flag.
        if (this.fileIndex.byPath.get(path) !== meta || meta.notOnDisk !== true) return 'changed';
        if (!(await io.vault.exists(path))) return 'none';
        if (this.fileIndex.byPath.get(path) !== meta || meta.notOnDisk !== true) return 'changed';
        this.log.info(
          'a file saved under the name of a file not on this disk yet; that one waits',
          {
            path,
            fileId: meta.fileId,
          },
        );
        this.fileIndex.byPath.delete(path);
        if (this.fileIndex.byId.get(meta.fileId) === meta) this.fileIndex.byId.delete(meta.fileId);
        this.newHere.delete(meta.fileId);
        this.forgetRecord(io.log, meta.fileId, path);
        // Its history here holds nothing but the server's, if anything.
        if (meta.fileType === 'TEXT') await this.dropDoc(io.docs, meta.fileId, path);
        this.outOfScope.set(meta.fileId, { path, fileType: meta.fileType });
        this.waitingForName.set(path, {
          kind: 'create',
          fileId: meta.fileId,
          path,
          fileType: meta.fileType,
        });
        return 'yielded';
      }),
    );
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
    let buffer: ArrayBuffer;
    try {
      buffer = await this.vault.readBinary(path);
    } catch (err) {
      // Gone between the check and the read: renamed or deleted right after
      // it was made (a template renaming the note it has just created). The
      // same stale create: the rename goes out as the create of the new name
      // (see `renameAfterCreate`), a delete sends nothing. Thrown on, it
      // ended the handler with an error in the console and nothing sent.
      if (await this.vault.exists(path)) throw err;
      this.log.debug('create of a file gone before it was read; nothing to send', path);
      return null;
    }
    const hash = await sha256Hex(buffer);
    const payload = { fileType, contentHash: hash, size: buffer.byteLength };
    if (change) change.payload = payload;
    const opId = change?.opId ?? newOpId();
    // A replay of the queue's (see `hold`): the head of the queue.
    const from: LocalSource = change === null ? 'queue' : 'watcher';

    // Join-window guard: between socket connect and the fileIndex refresh
    // the index can't tell a NEW file from a server-known one — emitting
    // CREATE here makes the server conflict-rename every path whose hash
    // diverged (the 2026-06-12 burst: Obsidian's startup create-flood hit
    // this window and minted 120 `<name>.conflict-<clientId>.md` copies in
    // two seconds). Queue instead — the post-connect drain consults the
    // refreshed index and routes server-known paths through modify.
    if (this.mayEmitLive(from) && this.indexReady) {
      let data: ArrayBuffer | undefined;
      try {
        // Binary bytes are staged over REST; text rides inline (small).
        data = await this.stageBinaryBlob(fileType, hash, buffer);
      } catch {
        this.throwIfStopped();
        // Offline or a server error: the offline queue replays it.
        this.log.debug('create staging failed; queueing', path);
        this.queue('CREATE', path, null, payload, opId);
        return null;
      }
      this.throwIfStopped();
      const sent = await this.sendOp(
        {
          opType: 'CREATE',
          filePath: path,
          newPath: null,
          payload,
          opId,
          ...(from === 'queue' ? { fromQueue: true as const } : {}),
        },
        (id) =>
          this.emitCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            opId: id,
            vectorClock: this.bumpClock(),
            filePath: path,
            fileType,
            contentHash: hash,
            size: buffer.byteLength,
            ...(data !== undefined ? { data } : {}),
          }),
        // Server ack carries `outcome.{fileId, path}` — record the file in
        // the local index immediately. Without this the broadcast event
        // that follows would treat the file as new and try to BINARY-
        // download it (404), and the next CREATE pass on this path would
        // re-upload (creating server-side conflict-renamed copies).
        (ack, settle) =>
          this.recordCreateAck(path, ack.outcome, fileType, hash, buffer.byteLength, settle),
      );
      return sent.kind === 'acked' ? (sent.value ?? null) : null;
    }
    // Offline — queue and bail; the engine will replay on reconnect.
    this.queue('CREATE', path, null, payload, opId);
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
   * One more case. The note renamed right after it was created (see
   * {@link renameAfterCreate}) is under its new name already: it is recorded
   * at the conflict name, and its rename goes out from there. Recorded
   * nowhere, it went out again as a second create under the new name.
   *
   * The server answers a create of a name a live file with the same non-empty
   * content has with that file (`merged` in the outcome): another device's,
   * recorded here under the name (see {@link materializeMerged}).
   */
  private async recordCreateAck(
    path: string,
    outcome: unknown,
    fileType: FileType,
    contentHash: string,
    size: number,
    /** What the answer settles, called with the file's record (see `sendOp`). */
    settle?: () => void,
  ): Promise<CreatedHere | null> {
    const o = outcome as { fileId?: unknown; path?: unknown; merged?: unknown } | null | undefined;
    const fileId = typeof o?.fileId === 'string' ? o.fileId : '';
    if (fileId === '') return null;
    if (typeof o?.path === 'string' && o.path !== '') {
      const merged = o.merged === true;
      await this.recordCreatedFile(fileId, o.path, fileType, contentHash, size, settle);
      if (merged && this.fileIndex.byId.get(fileId)?.relativePath === o.path) {
        await this.materializeMerged(fileId, o.path, fileType);
      }
      return { fileId, merged };
    }
    const conflict = conflictPlacement(outcome);
    if (conflict === null || conflict.asked !== path || conflict.stored === path) return null;
    const stored = conflict.stored;
    if (!this.allowServerPath(stored, 'create ack')) return null;
    if (
      this.renamedAfterCreate.has(path) &&
      !this.fileIndex.byPath.has(stored) &&
      !(await this.vault.exists(path))
    ) {
      this.log.info('own create stored under a conflict name; renamed here already', {
        path,
        stored,
      });
      await this.recordCreatedFile(fileId, stored, fileType, contentHash, size, settle);
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
    // Moved on disk first: stopped in between, the next connect finds the
    // file under the conflict name (see `settleLandedCreate`).
    await this.recordCreatedFile(fileId, stored, fileType, contentHash, size, settle);
    await this.releaseName(path);
    return { fileId, merged: false };
  }

  /**
   * Another device's file the server gave back for a create of this device's
   * with the same content (`merged`, see {@link recordCreateAck}), recorded at
   * `path`: the copy here may have been renamed away meanwhile (see
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
    /**
     * Called right after the record is written, in the same synchronous
     * block: what the create's answer settles (see `sendOp`). Not called when
     * nothing is recorded.
     */
    onRecorded?: () => void,
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
    onRecorded?.();
    if (fileType === 'TEXT') {
      this.startedSinceJoin.add(fileId);
      await this.startDoc(fileId, path);
    }
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
   * `PUT /blobs/:hash`, cancelled by `stop()` and by Pause sync — see
   * {@link online}. Cut short, the change it carries is queued.
   */
  private uploadBlob(contentHash: string, buffer: ArrayBuffer): Promise<void> {
    return this.api.uploadBlob(this.binding.projectId, contentHash, buffer, {
      signal: this.online.signal,
    });
  }

  /**
   * Download a file's current bytes, cancelled by `stop()` and by Pause sync;
   * the next connect's catch-up brings them.
   */
  private downloadFile(fileId: string): Promise<ArrayBuffer> {
    return this.api.downloadFile(this.binding.projectId, fileId, {
      signal: this.online.signal,
    });
  }

  private async handleLocalModify(path: string, from: LocalSource = 'watcher'): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    const meta = this.fileIndex.byPath.get(path);
    // The file recorded under the name is being deleted from here (see
    // `deleteClaims`), its delete waiting for its checks — behind every
    // folder check before it, seconds after a folder renamed. A file saved
    // under the name meanwhile is a new one once the delete has gone out, and
    // the same file if the delete found it on disk after all. Taken for a save
    // of the deleted file, it went to the server as that file's new version,
    // the delete took it along, and the new file never reached the server.
    const deleting = meta === undefined ? undefined : this.deleteClaims.get(meta.fileId);
    if (deleting !== undefined) {
      await deleting.done;
      await this.handleLocalModify(path, from);
      return;
    }
    // No server record yet — promote to a CREATE. So for a file whose content
    // never reached this disk: the file here is another one (see
    // `yieldNameNotWritten`).
    if (!meta || meta.notOnDisk === true) {
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
    const payload: Record<string, unknown> = {
      fileId: meta.fileId,
      contentHash: hash,
      size: buffer.byteLength,
    };
    if (change) change.payload = payload;
    const opId = change?.opId ?? newOpId();
    // A replay of the queue's (see `hold`): the head of the queue.
    const from: LocalSource = change === null ? 'queue' : 'watcher';

    if (this.mayEmitLive(from)) {
      try {
        // Binary bytes go to the REST staging area; the socket op is metadata-only.
        await this.uploadBlob(hash, buffer);
      } catch {
        this.throwIfStopped();
        this.log.debug('binary update staging failed; queueing', path);
        this.queue('UPDATE', path, null, payload, opId);
        return;
      }
      this.throwIfStopped();
      await this.sendOp(
        {
          opType: 'UPDATE',
          filePath: path,
          newPath: null,
          payload,
          opId,
          ...(from === 'queue' ? { fromQueue: true as const } : {}),
        },
        (id) =>
          this.socket.emitFileUpdateBinary({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            opId: id,
            vectorClock: this.bumpClock(),
            fileId: meta.fileId,
            contentHash: hash,
            size: buffer.byteLength,
          }),
        (_ack, settle) => {
          meta.contentHash = hash;
          meta.size = buffer.byteLength;
          this.operationLog.setFileMeta(meta);
          settle();
        },
      );
      return;
    }
    this.queue('UPDATE', path, null, payload, opId);
  }

  /**
   * A whole folder was deleted in Obsidian. Obsidian 1.13.7 reports a
   * `delete` of every file and subfolder in it, in the order they were
   * listed — a subfolder before its files, a file renamed since after the
   * rest — and then one of the folder (`reconcileDeletion` in `app.js`). A
   * file's own event can still be missed — the watcher swallows it as the
   * echo of this plugin's own write a moment before — and the chokidar
   * `unlink` events for the children are unreliable under a burst of
   * hundreds. So enumerate every indexed path under the folder and delete
   * each one explicitly — that is what makes a folder delete propagate
   * durably to the server.
   *
   * A file's own event may come before the folder's or after it, and so may
   * its chokidar `unlink`; a subfolder's expansion takes its files before the
   * folder's does. Each file's delete goes out once (see {@link deleteClaims}):
   * a child whose delete is under way already is left to it, and an event of
   * a child that comes after this one joins this one's.
   *
   * Each delete says which folder went with it (see {@link vanishedFolderOf}).
   * A folder this engine removed itself, as one a teammate removed (see
   * {@link prunedHere}), Obsidian reports all the same: nothing goes for
   * what was never on this disk.
   */
  private async handleLocalFolderDelete(folderPath: string): Promise<void> {
    if (!isInBinding(folderPath, this.binding.localFolder)) return;
    let children = this.indexedUnder(folderPath);
    if (this.prunedHere.delete(this.folderKey(folderPath))) {
      // Removed here as a teammate's, with nothing recorded under it. What is
      // recorded under it since and has not reached this disk — a teammate's
      // new file on its way — is not the user's to delete.
      //
      // The report may be the user's own delete of the folder, though: the
      // removal made here was never reported when the folder was back before
      // Obsidian looked (a teammate's file written into it right after), and
      // its entry stayed. Passed over, the files written into the folder
      // since were deleted from disk and nowhere else — a file's own event is
      // swallowed as the echo of this plugin's write to it a moment before,
      // which is what the expansion is for — and came back with the next
      // connect. So they go as any child does: each still on disk stays (see
      // `sendLocalDelete`). One being written right now is recorded as on
      // this disk a moment before its bytes land: waited for.
      const written = (): string[] =>
        children.filter((path) => {
          const meta = this.fileIndex.byPath.get(path);
          return meta !== undefined && meta.notOnDisk !== true;
        });
      children = written();
      if (children.length > 0) {
        await Promise.allSettled([...this.localCommits]);
        children = written();
      }
      if (children.length === 0) {
        this.log.debug('folder delete: a folder removed here as a teammate’s, nothing to send', {
          folder: folderPath,
        });
        return;
      }
      this.log.debug(
        'folder delete: a folder removed here as a teammate’s holds files written since',
        {
          folder: folderPath,
          files: children.length,
        },
      );
    }
    if (children.length === 0) return;
    // Hold every child's delete up front. They go out one ack at a time, and
    // a `stop()` halfway through must queue the ones not sent yet — the next
    // catch-up would otherwise write them back to disk. Checked already: the
    // folder is gone, so none of them can still be on disk.
    //
    // Claimed up front too, before the first `await`: an event of a child
    // that comes after this one joins its delete. A child whose delete is
    // claimed already — its own event came first, or its subfolder's — is
    // neither held nor recorded here: held twice, `stop()` queued it twice,
    // and it went out twice.
    const held: HeldChange[] = [];
    const claimed = new Map<HeldChange, DeleteClaim>();
    const underWay: Array<{ path: string; claim: DeleteClaim }> = [];
    for (const path of children) {
      const fileId = this.fileIndex.byPath.get(path)?.fileId ?? '';
      const claim = fileId === '' ? undefined : this.deleteClaims.get(fileId);
      if (claim !== undefined) {
        underWay.push({ path, claim });
        continue;
      }
      const change = this.holdLocalDelete(path, { checked: true });
      held.push(change);
      if (fileId !== '') claimed.set(change, this.claimDelete(fileId, change.opId));
    }
    this.log.debug(
      'folder delete → expanding',
      folderPath,
      `(${children.length} files, ${underWay.length} on their way already)`,
    );
    // The folder that went — this one, or one above it that went with it —
    // in the records made ahead too: from them, the queue sends it.
    if (held.length > 0) {
      const folder = await this.vanishedFolderOf(folderPath);
      for (const change of held) change.payload = withFolder(change.payload, folder);
    }
    const ahead = await this.recordDeletesAhead(held);
    try {
      for (const change of held) {
        // Out of the index since: deleted or moved by a teammate meanwhile.
        // Nothing to send, and nothing to look up — looked up in the
        // server's listing, each such file cost a listing of the whole
        // project.
        if (this.fileIndex.byPath.get(change.filePath)?.fileId !== queuedFileId(change.payload)) {
          this.releaseDelete(change);
          claimed.get(change)?.end('gone');
          continue;
        }
        // A chokidar `unlink` of a child can still follow. Pre-mark each
        // child so that echo is swallowed instead of dispatching a second
        // handleLocalDelete. Marked as its turn comes: a mark made ahead
        // would take Obsidian's own event of a subfolder's file, which comes
        // after the subfolder's, instead of the `unlink`.
        this.recentlyApplied.mark(change.filePath);
        await this.handleLocalDelete(change.filePath, change);
      }
      for (const { path, claim } of underWay) {
        if ((await claim.done) === 'gone') continue;
        // Its handler found it still on disk, or gave up before sending: the
        // folder is gone, so it is deleted from here.
        if (!this.fileIndex.byPath.has(path)) continue;
        this.recentlyApplied.mark(path);
        await this.handleLocalDelete(path, this.holdLocalDelete(path, { checked: true }));
      }
    } finally {
      for (const change of held) {
        this.settle(change);
        // Not reached: nothing went out for it, unless `stop()` has queued it.
        claimed.get(change)?.end(this.hasStopped ? 'gone' : 'kept');
      }
      // Recorded ahead and never sent: nothing went out for them.
      if (!this.hasStopped) {
        for (const opId of ahead) {
          if (this.sending.has(opId)) continue;
          if (this.operationLog.clearInFlight(this.binding.id, opId)) this.leftFlight(opId);
        }
      }
    }
  }

  /**
   * Every path recorded under `folderPath`, in the index's order. The folder
   * on disk may be spelled in another case than the notes in it are recorded
   * by (see `spelledHere`).
   */
  private indexedUnder(folderPath: string): string[] {
    const children: string[] = [];
    const folderKey = this.caseInsensitive() ? pathKey(folderPath) : null;
    for (const path of this.fileIndex.byPath.keys()) {
      if (
        isInBinding(path, folderPath) ||
        (folderKey !== null && isInBinding(this.caseKey(path), folderKey))
      ) {
        children.push(path);
      }
    }
    return children;
  }

  /**
   * The deletes of a folder's files, recorded in flight all at once and
   * written to `state.json` in one go, before the first of them goes out:
   * they go out one after another (see `sendOp`), and a write before each
   * cost a folder of hundreds of files seconds. The `opId`s recorded; none
   * when nothing can go out now.
   */
  private async recordDeletesAhead(held: readonly HeldChange[]): Promise<string[]> {
    if (!this.mayEmitLive('watcher')) return [];
    const bindingId = this.binding.id;
    const ahead: string[] = [];
    for (const change of held) {
      const fileId = queuedFileId(change.payload);
      if (fileId === '') continue;
      this.operationLog.recordInFlight(bindingId, { ...change, payload: { ...change.payload } });
      this.inflightHere.add(change.opId);
      ahead.push(change.opId);
    }
    if (ahead.length === 0) return ahead;
    try {
      await this.operationLog.persistNow();
    } catch {
      this.throwIfStopped();
      // Each one tries on its own (see `sendOp`).
    }
    return ahead;
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

  /**
   * `change`: held by the caller (`null` for a queue replay). The delete is
   * claimed before the first `await` (see {@link deleteClaims}): when another
   * handler has claimed this file's already, this one joins it.
   *
   * The delete is of the file recorded under the name when it came, by its
   * id, whatever is recorded under the name by the time it goes out. The
   * checks below wait — the look at the folder waits for the checks of every
   * delete and rename before it, hundreds after a folder renamed — and a note
   * renamed onto the name meanwhile is recorded there at once (see
   * {@link handleLocalRename}). Read from the name after the checks, the
   * delete went out as that note's: the server deleted it for the whole team,
   * its history was dropped here, and the file deleted here stayed on the
   * server under its name, where the rename of the other one was refused.
   */
  private async sendLocalDelete(path: string, change: HeldChange | null): Promise<void> {
    const opId = change?.opId ?? newOpId();
    const indexed = this.fileIndex.byPath.get(path)?.fileId ?? '';
    const underWay = this.deleteClaimedByOther(indexed, opId);
    if (underWay !== undefined) {
      await this.joinDelete(path, change, underWay);
      return;
    }
    let claim = indexed === '' ? null : this.claimDelete(indexed, opId);
    // Nothing recorded under the name: the file a create of the name under
    // way here records, once it has, is the one deleted (see below).
    const created = indexed === '' ? this.createdUnder(path) : { fileId: '' };
    let outcome: DeleteOutcome = 'kept';
    try {
      // Stale-delete guard: if the file is still on disk, the watcher
      // event is almost certainly a stray chokidar `unlink` from an
      // atomic-rename overwrite (the matching `add` lands a beat later).
      // Without this check the engine emits `file:delete`, the server
      // applies it, broadcasts `file:deleted` back, our applyServerDelete
      // strips the path out of `fileIndex` — and the next watcher event
      // then finds an empty index and dispatches a phantom `file:create`.
      if (await this.vault.exists(path)) return;
      // The folder that went with the file, if it did: its teammates remove
      // it too (see `vanishedFolderOf`).
      const folder = await this.vanishedFolderOf(parentFolder(path));
      // The file claimed, if it is still recorded under the name; out of it
      // since — deleted or renamed by a teammate — there is nothing to send
      // for it. Any other file recorded under the name since came after the
      // file was gone from here, and is not deleted with it.
      const meta =
        indexed !== ''
          ? this.indexedAt(indexed, path)
          : created.fileId !== ''
            ? this.indexedAt(created.fileId, path)
            : undefined;
      let fileId = meta?.fileId ?? '';
      // Checked: from here on `stop()` hands it over as a plain DELETE.
      if (change) change.payload = withFolder(deletePayload(fileId, meta), folder);
      // The path may be absent from the local index (a folder-delete child, or
      // a stale index). Resolve the id from the server's live file list before
      // giving up — otherwise the DELETE is queued with an empty fileId and is
      // later dropped as `no_file_id`, so the deletion never propagates.
      // Not a name a file of the server's waits for (see `waitForName`): the
      // file deleted here was another one, and the server's was never here.
      // Nor one a new file of this device's holds, its create queued (see
      // `createQueuedAt`): that is the file deleted here, which the server has
      // not heard of — what it lists under the name is another device's, its
      // broadcast on its way or waiting for the name. Looked up, it was
      // deleted for the whole team.
      // Only when nothing was recorded under the name when the delete came.
      if (
        !fileId &&
        indexed === '' &&
        this.socket.isConnected() &&
        this.waitingFor(path) === undefined &&
        !this.createQueuedAt(path)
      ) {
        fileId = await this.resolveServerFileId(path);
        this.throwIfStopped();
        // A file this device records is known here under its own name: not
        // the one deleted here, unless its create from here landed meanwhile.
        // The server may list a note renamed onto the name here already.
        if (fileId !== '' && fileId !== created.fileId && this.fileIndex.byId.has(fileId)) {
          this.log.debug('local delete: the server lists a file recorded here under the name', {
            path,
            fileId,
          });
          fileId = '';
        }
        // Nor a file this device keeps out of the index (see `outOfScope`):
        // one that came under the name while the listing was on its way, and
        // waits for it (see `waitForName`) — a create from here went back to
        // the queue meanwhile, turned away `busy`. Never on this disk, it is
        // not the file deleted here.
        if (fileId !== '' && this.outOfScope.has(fileId)) {
          this.log.debug('local delete: the server lists a file kept out of the index here', {
            path,
            fileId,
          });
          fileId = '';
        }
      }
      // Looked up in the listing, or recorded by the create of the name:
      // claimed now, before the next `await`.
      if (fileId !== '' && claim?.fileId !== fileId) {
        const taken = this.deleteClaimedByOther(fileId, opId);
        if (taken !== undefined) {
          await this.joinDelete(path, change, taken);
          return;
        }
        claim = this.claimDelete(fileId, opId);
      }
      // From here on the delete is sent, queued, or there is none to make.
      outcome = 'gone';
      const payload = withFolder(deletePayload(fileId, meta), folder);
      if (change) change.payload = payload;
      if (fileId) this.deletedIds.add(fileId);
      const sending = claim;
      // A replay of the queue's (see `hold`): the head of the queue.
      const from: LocalSource = change === null ? 'queue' : 'watcher';
      if (this.mayEmitLive(from) && fileId) {
        const sent = await this.sendOp(
          {
            opType: 'DELETE',
            filePath: path,
            newPath: null,
            payload,
            opId,
            ...(from === 'queue' ? { fromQueue: true as const } : {}),
          },
          (id) =>
            this.emitDelete({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId: id,
              vectorClock: this.bumpClock(),
              fileId,
              filePath: path,
              ...folderField(folder),
            }),
          async (_ack, settle) => {
            // Only what is still this file's: a note renamed onto the name here
            // while the delete was on its way is recorded there at once (see
            // `handleLocalRename`). Wiped unconditionally, its record went, its
            // next save was uploaded as a new file, and its history was deleted.
            if (this.fileIndex.byId.get(fileId)?.relativePath === path) {
              this.fileIndex.byId.delete(fileId);
            }
            this.forgetPath(this.operationLog, fileId, path);
            settle();
            // Out of the index: a delete of the file from now on is another
            // one — the server gives a file created under the name again the
            // deleted one's id.
            sending?.end('gone');
            // A concurrent remote yjs:update may have scheduled a debounced disk
            // snapshot for this path: cancelled, or it would recreate the
            // just-deleted file. The doc and its store go too: left in place,
            // they were the history of the next note created under this name —
            // the same teardown applyServerDelete does.
            await this.dropDoc(this.docManager, fileId, path);
            this.forgetWaiting(fileId);
            await this.releaseName(path);
          },
        );
        if (sent.kind === 'acked') return;
        if (sent.kind === 'queued' && sent.entry !== null) {
          // Back in the queue, as a delete made offline is queued.
          const docState = await this.noteStateVector(meta);
          if (docState !== null) {
            this.operationLog.amendOperation(sent.entry.id, {
              payload: { ...sent.entry.payload, [DOC_STATE]: docState },
            });
          }
        }
        // Queued, or refused for good (the server has no such file): gone here.
        await this.forgetDeletedHere(fileId, path, sending);
        this.forgetWaiting(fileId);
        await this.releaseName(path);
        return;
      }
      if (!fileId) {
        // No live server file at this path (already deleted, or never synced).
        // Nothing to propagate — but log it rather than silently swallowing a
        // delete that couldn't be resolved.
        this.log.debug('local delete: no server fileId, nothing to propagate', path);
        // A new file whose create was queued: a file the server has under the
        // name may wait for it (see `createQueuedAt`).
        await this.releaseName(path);
        return;
      }
      const docState = await this.noteStateVector(meta);
      this.queue(
        'DELETE',
        path,
        null,
        {
          ...payload,
          ...(docState !== null ? { [DOC_STATE]: docState } : {}),
        },
        opId,
      );
      await this.forgetDeletedHere(fileId, path, sending);
      this.forgetWaiting(fileId);
      await this.releaseName(path);
    } finally {
      claim?.end(outcome);
    }
  }

  /** File `fileId`'s record in the index, if it is under `path`. */
  private indexedAt(fileId: string, path: string): IndexedMeta | undefined {
    const meta = this.fileIndex.byId.get(fileId);
    return meta?.relativePath === path ? meta : undefined;
  }

  /**
   * The file a create of `path` under way here (see {@link creating}) records,
   * once it has: its `fileId`, `''` until then — and for good when no create
   * of the name is under way, or it records none (queued, refused, found gone).
   */
  private createdUnder(path: string): { fileId: string } {
    const created = { fileId: '' };
    void this.creating.get(path)?.then((done) => {
      if (done !== null) created.fileId = done.fileId;
    });
    return created;
  }

  /**
   * Another handler is deleting the file at `path` (see {@link deleteClaims}):
   * this delete is that one, and waits for it. Only when nothing went out for
   * it — the file was still on disk when that handler looked — does this one
   * look again, as a delete of its own.
   */
  private async joinDelete(
    path: string,
    change: HeldChange | null,
    claim: DeleteClaim,
  ): Promise<void> {
    // Let go at once: held by both, `stop()` queued both, and both went out.
    this.releaseDelete(change);
    this.log.debug('local delete: already on its way', path);
    if ((await claim.done) === 'gone') return;
    const again =
      change === null
        ? null
        : this.holdLocalDelete(path, { checked: change.payload[RECHECK_DELETE] !== true });
    try {
      await this.sendLocalDelete(path, again);
    } finally {
      this.settle(again);
    }
  }

  /**
   * Let go of the held delete `change`: nothing goes out for it, not even
   * from the queue after `stop()` — nor for the record of it in flight a
   * folder delete made ahead (see {@link recordDeletesAhead}). Left there,
   * `stop()` put it in the queue, and the next connect sent it under a new
   * `opId`.
   */
  private releaseDelete(change: HeldChange | null): void {
    if (change === null) return;
    this.settle(change);
    if (this.sending.has(change.opId)) return;
    if (this.operationLog.clearInFlight(this.binding.id, change.opId)) {
      this.leftFlight(change.opId);
    }
  }

  /**
   * Claim the delete of `fileId` for the change `opId` (see
   * {@link deleteClaims}): the claim it has already, if any.
   */
  private claimDelete(fileId: string, opId: string): DeleteClaim {
    const known = this.deleteClaims.get(fileId);
    if (known !== undefined && known.opId === opId) return known;
    let resolve!: (outcome: DeleteOutcome) => void;
    const done = new Promise<DeleteOutcome>((r) => {
      resolve = r;
    });
    const claim: DeleteClaim = {
      fileId,
      opId,
      done,
      end: (outcome) => {
        if (this.deleteClaims.get(fileId) === claim) this.deleteClaims.delete(fileId);
        resolve(outcome);
      },
    };
    this.deleteClaims.set(fileId, claim);
    return claim;
  }

  /** The claim on the delete of `fileId` held for another change than `opId`, if any. */
  private deleteClaimedByOther(fileId: string, opId: string): DeleteClaim | undefined {
    if (fileId === '') return undefined;
    const claim = this.deleteClaims.get(fileId);
    return claim !== undefined && claim.opId !== opId ? claim : undefined;
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
   *
   * `claim`, the delete's (see {@link deleteClaims}), ends as the file leaves
   * the index.
   */
  private async forgetDeletedHere(
    fileId: string,
    path: string,
    claim: DeleteClaim | null,
  ): Promise<void> {
    await this.commitLocal(async (io) => {
      if (this.fileIndex.byId.get(fileId)?.relativePath === path) {
        this.fileIndex.byId.delete(fileId);
      }
      this.forgetPath(io.log, fileId, path);
      claim?.end('gone');
      await this.dropDoc(io.docs, fileId, path);
    });
  }

  /**
   * The topmost folder that vanished from disk with a file of `folder`, the
   * folder the file was in, for its delete, rename or move (`folder` in
   * `sync-protocol.md`, «Папки»): the folder the user deleted, renamed or
   * moved — in Obsidian, to its trash or out of the binding — or the one above
   * it that went with it. `null` when `folder` is still there: only the file
   * went, and its folder stays for every teammate too. Never the binding's own
   * folder; for a rename, never where the file went (`newPath`).
   *
   * Obsidian removes a folder on disk before it reports anything about it, a
   * folder deleted and one renamed alike (`reconcileDeletion`, `rename` in
   * `app.js` 1.13.7), so the disk tells when a file's event comes. Checked one
   * at a time, in the order they are asked for (see {@link folderChecks}).
   */
  private vanishedFolderOf(folder: string, newPath: string | null = null): Promise<string | null> {
    const check = this.folderChecks.then(() => this.vanishedFolderNow(folder, newPath));
    this.folderChecks = check.catch(() => undefined);
    return check;
  }

  /** {@link vanishedFolderOf}, looked up now. */
  private async vanishedFolderNow(folder: string, newPath: string | null): Promise<string | null> {
    const root = normalizeFolderPath(this.binding.localFolder);
    let gone: string | null = null;
    for (
      let dir = folder;
      dir !== '' && dir !== root && isInBinding(dir, root);
      dir = parentFolder(dir)
    ) {
      let there: boolean;
      try {
        there = await this.vault.exists(dir);
      } catch {
        this.throwIfStopped();
        return null;
      }
      if (there) break;
      gone = dir;
    }
    // The folder the file went to has not vanished, nor has one it is in.
    if (gone !== null && newPath !== null && isInBinding(newPath, gone)) return null;
    return gone;
  }

  /**
   * `folder`, which vanished at its author's with a teammate's delete, rename
   * or move of a file that was at `from` (`null` when this device did not have
   * it): removed from disk here with the folders under it, if nothing is left
   * in any of them (`sync-protocol.md`, «Папки»). The teammate removed the
   * folder; a folder only emptied by a teammate's delete or move carries no
   * `folder`, and stays, as it stayed at theirs.
   *
   * Never a folder that holds anything on disk but empty folders — a file this
   * client does not sync included — nor one under which this device has a
   * file recorded, a teammate's new one on its way to the disk included (see
   * {@link holdsFiles}): looked at again right before each folder goes. The
   * path is checked as any path from the server is, and a folder outside the
   * binding, or the binding's own, is left alone.
   *
   * Obsidian reports the folder gone a moment later, as a `delete` of the
   * folder: nothing the user did, and nothing goes to the server for it (see
   * {@link prunedHere}). One removal at a time (see {@link folderPrunes}).
   */
  private async pruneVanishedFolder(
    folder: string | undefined,
    from: string | null,
  ): Promise<void> {
    if (folder === undefined || folder === '') return;
    if (this.local.vault.removeEmptyFolders === undefined) return;
    // Another binding's folder, or none of this client's.
    if (!isInBinding(folder, this.binding.localFolder)) return;
    if (this.refuseServerPath(folder, 'vanished folder') !== null) return;
    if (folder === normalizeFolderPath(this.binding.localFolder)) return;
    // The server keeps only a folder of where the file was: anything else is
    // not this operation's.
    if (from !== null && !from.startsWith(`${folder}/`)) return;
    const run = this.folderPrunes.then(() => this.removeVanishedFolder(folder));
    this.folderPrunes = run.catch(() => undefined);
    await run;
  }

  /** {@link pruneVanishedFolder} of `folder`, checked, in its turn. */
  private async removeVanishedFolder(folder: string): Promise<void> {
    if (this.holdsFiles(folder)) {
      this.log.debug('a folder a teammate removed holds files here; kept', { folder });
      return;
    }
    /** The folders this call is about to remove, as it goes: see `prunedHere`. */
    const tried: string[] = [];
    let removed: string[];
    try {
      removed = await this.commitLocal(
        async (io) =>
          (await io.vault.removeEmptyFolders?.(folder, (dir) => {
            if (this.holdsFiles(folder)) return false;
            // Before the folder goes: Obsidian's report may come before the
            // rest have gone.
            this.notePruned(dir);
            tried.push(dir);
            return true;
          })) ?? [],
      );
    } catch (err) {
      this.throwIfStopped();
      this.log.debug('could not remove a folder a teammate removed', { folder, err });
      removed = [];
    }
    // Not removed after all: nothing will report it.
    for (const dir of tried) {
      if (!removed.includes(dir)) this.prunedHere.delete(this.folderKey(dir));
    }
    if (removed.length === 0) {
      // Gone already: removed with another file of it, or by the user.
      let there = true;
      try {
        there = await this.vault.exists(folder);
      } catch {
        this.throwIfStopped();
      }
      this.log.debug(
        there
          ? 'a folder a teammate removed is not empty here; kept'
          : 'a folder a teammate removed is gone here already',
        { folder },
      );
      return;
    }
    this.log.info('removed a folder a teammate deleted or renamed', {
      folder,
      folders: removed.length,
    });
  }

  /**
   * The folders of the catch-up (see {@link catchupFolders}), each removed
   * if nothing is left in it, once the first upload has removed the copies
   * of files deleted while this device was away. `unsettled`: the copies it
   * could not settle, `null` when it settled none (see {@link initialPush}).
   * A folder that holds such a copy is kept for the next connect's tail,
   * which removes the copy: the catch-up does not bring the folder's
   * operations again. Given up on, as it used to be, the folder stayed here
   * for good once the copy went.
   */
  private async pruneCatchupFolders(unsettled: ReadonlySet<string> | null): Promise<void> {
    if (unsettled === null) {
      if (this.catchupFolders.size > 0) {
        this.log.debug('folders a teammate removed are left for the next connect', {
          folders: this.catchupFolders.size,
        });
      }
      return;
    }
    for (const [folder, from] of [...this.catchupFolders]) {
      if ([...unsettled].some((path) => this.isUnder(path, folder))) {
        this.log.debug(
          'a folder a teammate removed holds a copy not removed yet; left for the next connect',
          {
            folder,
          },
        );
        continue;
      }
      this.catchupFolders.delete(folder);
      await this.pruneVanishedFolder(folder, from);
    }
  }

  /** Whether `path` is under `folder`: in any case, on a disk that takes names in any case. */
  private isUnder(path: string, folder: string): boolean {
    if (!this.caseInsensitive()) return path.startsWith(`${folder}/`);
    return this.caseKey(path).startsWith(`${pathKey(folder)}/`);
  }

  /**
   * A catch-up delete, rename or move whose folder vanished at its author's
   * (`payload.folder`, see {@link pruneVanishedFolder}): noted for the end of
   * the connect's tail. Whether this device had the file or not — one deleted
   * while it was away is not in the listing, and its copy goes in
   * `initialPush` — and from a catch-up cut short to its newest operations
   * too (`sync-protocol.md`, «Папки»): the folder goes only if nothing is
   * left in it, on disk or in the index the connect's listing made. Only an
   * operation the cut left out says nothing, and its folder stays.
   */
  private noteCatchupFolder(op: ServerOperation): void {
    if (op.opType !== 'DELETE' && op.opType !== 'RENAME' && op.opType !== 'MOVE') return;
    const folder = stringOf((op.payload as { folder?: unknown } | null)?.folder);
    if (folder === '' || this.catchupFolders.has(folder)) return;
    this.catchupFolders.set(folder, op.filePath);
  }

  /**
   * Whether this device has a file under `folder`: indexed — one never
   * written here yet included — being created, or a copy asked about. Under
   * the folder in any case, on a disk that takes names in any case.
   */
  private holdsFiles(folder: string): boolean {
    const insensitive = this.caseInsensitive();
    const prefix = `${insensitive ? pathKey(folder) : folder}/`;
    const under = (path: string): boolean =>
      (insensitive ? this.caseKey(path) : path).startsWith(prefix);
    for (const paths of [
      this.fileIndex.byPath.keys(),
      this.creating.keys(),
      this.awayCopies.keys(),
      this.askedCopies.keys(),
    ]) {
      for (const path of paths) if (under(path)) return true;
    }
    return false;
  }

  /** Folder `path` is being removed here: see {@link prunedHere}. */
  private notePruned(path: string): void {
    if (this.prunedHere.size >= PRUNED_MAX) this.prunedHere.clear();
    this.prunedHere.add(this.folderKey(path));
  }

  /** How {@link prunedHere} knows folder `path`: in any case, on a disk that takes any. */
  private folderKey(path: string): string {
    return this.caseInsensitive() ? pathKey(path) : path;
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
      // Its create went out and is queued, the ack lost with the connection or
      // a Pause: the entry follows the note, keeping its `opId`, and the next
      // connect asks the server what became of it (see `settleLandedCreate`).
      // Queued again as a create under the new name, the note went to the
      // whole team twice, under both names. The name it left may be what
      // another file waits for (see `createQueuedAt`).
      if (this.followQueuedCreate(oldPath, newPath)) {
        await this.releaseName(oldPath);
        return;
      }
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
        // the old name. The entry follows the note, and the next connect asks
        // the server about it (see `settleLandedCreate`).
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
   * A note renamed from `oldPath` to `newPath` whose create is queued: every
   * create queued under the old name moves to the new one, each keeping its
   * `opId` — `false` when there is none. One of them may have gone out, its
   * answer lost: the next connect asks the server about it by its id, and
   * the server's answer says the name it went out under (see
   * `settleLandedCreate`, which sends the rename from there).
   *
   * Every create queued under the old name moves along. A save made offline
   * since queues one more, which never went out: taken for the note's only
   * entry, it left the one that went out under the old name, and the next
   * connect recorded the note the server has there under that name — gone
   * from the disk here, written back by the catch-up — while the rename went
   * out as a second create under the new one: the note twice, for the whole
   * team.
   */
  private followQueuedCreate(oldPath: string, newPath: string): boolean {
    let followed = false;
    for (const entry of this.operationLog.dequeueOperations(this.binding.id)) {
      if (entry.opType !== 'CREATE' || entry.filePath !== oldPath) continue;
      if (this.operationLog.amendOperation(entry.id, { filePath: newPath })) followed = true;
    }
    return followed;
  }

  /** {@link handleLocalRename} of a file this device has a record of: `target`. */
  private async renameRecorded(
    target: IndexedMeta,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const { fileId } = target;
    // Asked for at once: renames go out in the order they came (see
    // `folderChecks`).
    const vanished = this.vanishedFolderOf(parentFolder(oldPath), newPath);
    // Awaited below; a throw before that is the one reported.
    vanished.catch(() => undefined);
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
    const acked: { outcome?: unknown } = {};
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
      // The folder the file left, if it went too: a folder renamed or moved.
      const folder = await vanished;
      const payload = withFolder({ fileId }, folder);
      change.payload = payload;
      /** Sent, and whatever became of it is settled or queued already. */
      let sent = false;
      if (this.mayEmitLive('watcher') && this.supersedeQueuedMoves(fileId, newPath)) {
        sent = true;
        const result = await this.sendOp(
          {
            opType: 'RENAME',
            filePath: oldPath,
            newPath,
            payload,
            opId: change.opId,
          },
          (id) =>
            this.socket.emitFileRename({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId: id,
              vectorClock: this.bumpClock(),
              fileId,
              filePath: oldPath,
              newPath,
              ...folderField(folder),
            }),
          (ack, settle) => {
            // The records moved already (see `switchRecords`).
            settle();
            acked.outcome = ack.outcome ?? null;
          },
        );
        if (result.kind === 'queued') {
          // No answer: queued, and the next connect asks the server whether it
          // applied it (see `settleUnanswered`).
          this.log.debug('rename emit failed; queued', { oldPath, newPath });
        }
      }
      if (!sent) this.queue('RENAME', oldPath, newPath, payload, change.opId);
    } finally {
      this.settle(change);
      // Acknowledged: a teammate's rename broadcast from here on was applied
      // on the server after this one, and is followed.
      this.forgetLocalRename(fileId);
      await docMoved;
    }
    if ('outcome' in acked) await this.followStoredRename(fileId, acked.outcome);
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
    // Not one the drain has on its way: the server applies it before this
    // one, and its answer takes it out of the queue.
    this.operationLog.markSent(mine.filter((op) => !this.sending.has(op.opId)).map((op) => op.id));
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
   *
   * The new doc is stamped for the note once its store turns out empty (see
   * `DocManager.claimNew`): the server's doc of a teammate's note lands in it
   * right away, and a doc opened with a history is left unstamped — as was
   * this one, all session, and the mark of its writes to disk never went to
   * its store (see `DocManager.noteWritten`).
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
    void this.docManager.claimNew(this.binding.id, path, fileId);
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
      // Cut short by `stop()`, or its download by Pause sync — not a failure
      // to apply: the next connect's catch-up brings the change again.
      if (this.hasStopped || err instanceof SyncPausedError) return;
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
    switch (event.type) {
      case 'created': {
        // Where the server stored the file: the broadcast says so, and the
        // outcome it carries too — under `finalPath` when the name was taken
        // and the file went under a conflict name. Skip a file already known
        // here: the server gave back one this device has (`merged`).
        const outcome = (event.result as { outcome?: Record<string, unknown> } | undefined)
          ?.outcome;
        const fileId = event.fileId ?? stringOf(outcome?.fileId);
        const path = event.path ?? (stringOf(outcome?.path) || stringOf(outcome?.finalPath));
        if (fileId === '' || path === '') break;
        if (this.fileIndex.byId.has(fileId)) break;
        await this.applyServerCreate({
          id: fileId,
          path,
          // The server's; classified here only when the broadcast lacks it.
          fileType: event.fileType ?? classifyFileType(path),
        });
        break;
      }
      case 'updated-binary':
        await this.applyServerUpdateBinary(event.fileId, event.contentHash);
        break;
      case 'deleted': {
        const from = this.fileIndex.byId.get(event.fileId)?.relativePath ?? null;
        await this.applyServerDelete(event.fileId);
        // The folder, if the teammate deleted it (see `pruneVanishedFolder`).
        await this.pruneVanishedFolder(event.folder, from);
        break;
      }
      case 'renamed':
      case 'moved': {
        const from = this.fileIndex.byId.get(event.fileId)?.relativePath ?? null;
        await this.handleServerRename(event.fileId, event.newPath, event.outcome, own);
        // This device's own: the folder went here already.
        if (!own) await this.pruneVanishedFolder(event.folder, from);
        break;
      }
    }
  }

  /**
   * Whether a file broadcast is this device's own: it carries the `opId` of
   * an operation on its way from here ({@link sending}) — sent and not
   * answered yet, which is when the server broadcasts it back.
   *
   * The client id alone does not tell. A vault copied to another computer
   * along with its `data.json` takes the id with it, and the copy's operations
   * came back as this device's own: its new notes, deletes and renames did not
   * reach this device until the next connect. A broadcast under this device's
   * id that it has nothing on its way for is the other device's, and is
   * applied (see {@link reportTwin}).
   */
  private isOwnBroadcast(event: SocketFileEvent): boolean {
    if (event.opId !== undefined && this.sending.has(event.opId)) return true;
    if (event.clientId === this.clientId) {
      this.reportTwin('broadcast', { type: event.type, opId: event.opId });
    }
    return false;
  }

  /**
   * `file:create`, with its path in {@link ownCreates} until the ack comes
   * (or the emit fails).
   */
  private async emitCreate(payload: FileCreatePayload): Promise<FileAck> {
    const path = payload.filePath;
    this.ownCreates.set(path, (this.ownCreates.get(path) ?? 0) + 1);
    try {
      return await this.socket.emitFileCreate(payload);
    } finally {
      countDown(this.ownCreates, path);
    }
  }

  /** `file:delete`, with its file id in {@link ownDeletes} until the ack comes. */
  private async emitDelete(payload: FileDeletePayload): Promise<FileAck> {
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
   *     One that finds no rename on its way is a teammate's — a rename back
   *     to a name the note had here earlier too.
   *   - A rename is applied under the name the server stored the file at,
   *     which the broadcast's `newPath` is.
   */
  private async handleServerRename(
    fileId: string,
    newPath: string,
    outcome: unknown,
    own: boolean,
  ): Promise<void> {
    if (own) {
      await this.followStoredRename(fileId, outcome);
      return;
    }
    if (this.renamePendingHere(fileId)) {
      this.log.debug('server rename left to a local rename of the same file', {
        fileId,
        newPath,
      });
      return;
    }
    await this.applyServerRename(fileId, newPath);
  }

  /**
   * A rename this device sent that the server stored under a conflict name
   * (the name was taken there by a file this device had not heard of yet):
   * the note follows it there. Called with the outcome of the broadcast of
   * this device's own rename (see {@link handleServerRename}) and with the
   * ack's, whichever comes first. Left at the name asked for, the note stayed
   * there until the next connect, and the file the server has under that name
   * did not reach this device until then.
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
    // Only a note has a history. An attachment's bytes come with its own
    // update (see `applyServerUpdateBinary`). A `yjs:update` for one — a
    // server that did not refuse it (`not_text`) passed it on — is ignored:
    // applied, it opened a doc under the attachment's name, and the snapshot
    // wrote the doc's text over the attachment's bytes.
    if (meta.fileType !== 'TEXT') {
      this.log.debug('yjs:update for an attachment ignored', { path: meta.relativePath });
      return;
    }
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
    this.noteCatchupFolder(op);
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
        const payload = (op.payload ?? {}) as {
          fileId?: unknown;
          contentHash?: unknown;
          size?: unknown;
        };
        const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
        if (!fileId) break;
        // Stale-UPDATE guard: same logic — if the file is gone from the
        // server, the binary download will 404 and crash the catch-up.
        const meta = this.fileIndex.byId.get(fileId);
        if (!meta) break;
        // A note's text comes with its doc, in this same catch-up: its UPDATE,
        // which a server before 0.3.8's lists, is left alone (see
        // `applyServerUpdateBinary`).
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
    this.mergeClock(op);
  }

  /**
   * Attachments checked against the listing, after a catch-up that may have
   * left operations out: one cut short to its newest operations (the server
   * gives the whole journal otherwise). An attachment reaches this device
   * only through its CREATE or UPDATE — neither the listing nor the docs
   * carry its bytes.
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
   *
   * Not one this device is deleting (see {@link deletingHere}): its copy is
   * missing because the user deleted it. A folder delete sends its files'
   * deletes one ack at a time, and each file leaves the index only with its
   * own ack. Downloaded again, the files not sent yet were back on disk when
   * their turn came, and a delete of a file still on disk is not sent (see
   * `sendLocalDelete`): the folder came back here, and its files stayed on the
   * server for the whole team.
   *
   * `onlyNew`, after a catch-up of the whole journal: only the attachments
   * new to this device, missing here. Such a catch-up leaves out a CREATE the
   * clock took in at a connect that did not apply it: the file waited for a
   * name this device's own file held (see `waitForName`), and its download
   * failed when the name came free — the connection lost, Pause sync. The
   * listing indexed it at the next connect, recorded as synced, and it never
   * came; a file saved under the name here was then sent as its new version,
   * over the teammate's.
   *
   * `replaced`: attachments the catch-up shows deleted and created again under
   * their id (see `notesRecreated`) — a teammate deleted one and added another
   * under its name while this device was away — are checked too. The catch-up
   * skips the DELETE of a file it lists, and the CREATE of one on this disk
   * downloads nothing (see {@link applyServerCreate}): the teammate's file
   * came only with their next version, and this device's copy of the deleted
   * one stayed under the name meanwhile.
   */
  private async reconcileAttachments(
    online: AbortSignal,
    opts: { onlyNew?: boolean; replaced?: ReadonlySet<string> } = {},
  ): Promise<void> {
    for (const meta of [...this.fileIndex.byId.values()]) {
      if (meta.fileType !== 'BINARY') continue;
      if (
        opts.onlyNew === true &&
        !this.newHere.has(meta.fileId) &&
        opts.replaced?.has(meta.fileId) !== true
      ) {
        continue;
      }
      const listed = this.lastListing.get(meta.fileId);
      if (listed === undefined) continue;
      // Deleted since the pass began: not brought back.
      if (this.fileIndex.byId.get(meta.fileId) !== meta) continue;
      if (this.deletingHere(meta.fileId, meta.relativePath)) continue;
      try {
        if (!(await this.vault.exists(meta.relativePath))) {
          await this.applyServerCreate(
            { id: meta.fileId, path: meta.relativePath, fileType: 'BINARY' },
            { restore: true },
          );
        } else if (listed.contentHash !== meta.contentHash) {
          await this.applyServerUpdateBinary(meta.fileId, listed.contentHash);
        }
      } catch {
        // The next connect checks again.
        online.throwIfAborted();
      }
      online.throwIfAborted();
    }
  }

  /**
   * Whether the user has deleted file `fileId` at `path` here and the delete
   * is under way: held (a folder delete holds every file of the folder, and
   * sends one at a time), claimed (see {@link deleteClaims}), or sent and not
   * acknowledged yet. Once acknowledged or queued, the file is out of the
   * index.
   */
  private deletingHere(fileId: string, path: string): boolean {
    if (this.ownDeletes.has(fileId) || this.deleteClaims.has(fileId)) return true;
    for (const change of this.held) {
      if (change.opType === 'DELETE' && change.filePath === path) return true;
    }
    return false;
  }

  /**
   * `released`: the name was free when {@link releaseName} let the file in.
   * `adopted`: a file renamed into what this binding syncs from a folder it
   * does not (see {@link adoptRenamedFile}). `restore`: an attachment this
   * device has, missing from its disk (see {@link reconcileAttachments}) — not
   * written when the user has deleted it by the time its download is in.
   */
  private async applyServerCreate(
    payload: {
      id: string;
      path: string;
      fileType: FileType;
    },
    opts: { released?: boolean; adopted?: boolean; restore?: boolean } = {},
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
      (this.creating.has(path) || this.ownCreates.has(path) || this.createQueuedAt(path))
    ) {
      // This device is creating a file under the name, not recorded yet — or
      // has created one whose create waits in the queue (see
      // `createQueuedAt`): another device's create the server applied first.
      // Indexed now, it took the copy here for its own: the first snapshot
      // folded that copy into it — its text replaced for everyone — and a
      // rename or delete of the copy went to the server as one of that file.
      // It waits for the create's ack: this device's file is recorded then,
      // under the name or the conflict name the server gave it, and the name
      // is let go (see `recordCreateAck`).
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
      // Until its content is written: a file saved under the name meanwhile
      // is another one (see `yieldNameNotWritten`).
      notOnDisk: true,
    };
    this.fileIndex.byPath.set(path, meta);
    this.fileIndex.byId.set(payload.id, meta);
    // Brought back under its id while the user is asked about its copy: the
    // file under the id is this new one (see `leaveIndexWhileAsked`).
    this.askingDeleted.delete(payload.id);
    if (!known) this.deleteAskedSettled(payload.id);

    // The copy of a file deleted while away, or by a teammate, which the user
    // is being asked about, is on disk under this name: kept aside first.
    // Taken for this file's, a note's first snapshot folded it in without a
    // base — its text over the new note's, for everyone — and a binary
    // counted it as synced.
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
      if (!known) {
        // Its content comes with the update that follows the broadcast of a
        // create. One let into its name, or renamed in from a folder this
        // binding does not sync, has no such update: its content comes from
        // the server's doc (see `releaseName`, `adoptRenamedFile`), and the
        // catch-up's doc of it is as good.
        if (opts.released !== true && opts.adopted !== true) this.startedSinceJoin.add(payload.id);
        await this.startDoc(payload.id, path);
      }
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
        // Gone from the index while it came down: deleted, or the name given
        // up to a file saved under it here (see `yieldNameNotWritten`).
        // Written, the bytes went over that file.
        if (this.fileIndex.byId.get(payload.id) !== meta) return;
        // Deleted by the user while it came down, the delete on its way.
        if (opts.restore === true && this.deletingHere(payload.id, path)) return;
        // A file saved under the name meanwhile: another one, which its own
        // event sends as such (see `yieldNameNotWritten`).
        if (await io.vault.exists(path)) return;
        // Same ordering as `applyServerUpdateBinary` — meta first, then the
        // disk write, so the watcher echo's hash compare short-circuits.
        meta.size = buf.byteLength;
        meta.contentHash = hash;
        delete meta.notOnDisk;
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
    // A note's text comes through its doc, never as bytes. A server before
    // 0.3.8's broadcasts `file:updated-binary` for a note when a 0.3.x client
    // answers "Keep local" about it, and lists such an UPDATE, or one written
    // through REST or MCP, in the catch-up. Taken as an attachment's, the
    // note's bytes were downloaded and written over the disk beside its doc,
    // or compared with the disk: a "Content conflict" prompt whose every
    // answer did worse than the merge of the doc — and "Keep local" sent the
    // note's bytes on as an attachment update.
    if (meta.fileType === 'TEXT') {
      this.log.debug('attachment update of a note ignored; its text comes with its doc', {
        path: meta.relativePath,
      });
      return;
    }
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
    if (versionHash !== undefined && versionHash !== '' && this.keptOver(fileId, versionHash)) {
      return;
    }
    // A file never written here, with a file under its name: that one is
    // another (see `yieldNameNotWritten`). Compared with it, the user was
    // asked to choose between two different files.
    if (meta.notOnDisk === true && (await this.vault.exists(meta.relativePath))) return;
    const newBuf = await this.downloadFile(fileId);
    this.throwIfStopped();
    const newHash = await sha256Hex(newBuf);
    // The server still has what this device last synced: nothing is written.
    // The copy here is that version, or an edit of it made since, which is the
    // newer one and goes out with the queue — written over, the edit was lost,
    // and its queued update then found the bytes "unchanged" and sent nothing.
    // Or the copy is gone, deleted here: written back, a version this device
    // had already let go of came back to its disk.
    if (newHash === meta.contentHash) return;
    // The user chose the copy here over this very version; the update that
    // says so waits to go out.
    if (this.keptOver(fileId, newHash)) return;
    /** Where `keep-both` parks the local edits. */
    let aside: string | null = null;

    // Conflict detection — only triggers when the user has uncommitted edits.
    // Stopped anywhere up to the write below, nothing has changed yet: the
    // next catch-up replays this UPDATE and starts over. Not for a file never
    // written here: a file saved under its name while the version came down
    // is another one, left alone at the write below.
    if (meta.notOnDisk !== true && (await this.vault.exists(meta.relativePath))) {
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
          // Push our local content as the new server version: an attachment
          // update like any other, which the record takes only once the
          // server has it. The server broadcasts it back before the ack; that
          // is this device's own and changes nothing here.
          await this.keepLocalVersion(meta, localBuf, localHash, newHash);
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
      // Out of the index while it came down: its name given up to a file saved
      // under it (see `yieldNameNotWritten`), or the file deleted. The file
      // under the name is another one.
      if (this.fileIndex.byId.get(fileId) !== meta) return;
      if (meta.notOnDisk === true && (await io.vault.exists(path))) return;
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
      delete meta.notOnDisk;
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

  /**
   * **Keep local** about attachment `meta`: the copy here (`localHash`) goes
   * to the server over its version `serverHash`, as an attachment update.
   * `state.json` takes the new version only from the ack: sent and not
   * answered, or not sent at all, the update waits in the queue, and until it
   * goes out a catch-up bringing that same version asks nothing again (see
   * {@link keptOver}); a newer version of a teammate's does.
   */
  private async keepLocalVersion(
    meta: IndexedMeta,
    localBuf: ArrayBuffer,
    localHash: string,
    serverHash: string,
  ): Promise<void> {
    const { fileId } = meta;
    const payload: Record<string, unknown> = {
      fileId,
      contentHash: localHash,
      size: localBuf.byteLength,
      [KEEP_OVER]: serverHash,
    };
    const opId = newOpId();
    if (!this.mayEmitLive('watcher')) {
      this.queue('UPDATE', meta.relativePath, null, payload, opId);
      return;
    }
    try {
      await this.uploadBlob(localHash, localBuf);
    } catch {
      this.throwIfStopped();
      this.log.debug('keep-local binary push failed; queued', meta.relativePath);
      this.queue('UPDATE', meta.relativePath, null, payload, opId);
      return;
    }
    this.throwIfStopped();
    await this.sendOp(
      { opType: 'UPDATE', filePath: meta.relativePath, newPath: null, payload, opId },
      (id) =>
        this.socket.emitFileUpdateBinary({
          projectId: this.binding.projectId,
          clientId: this.clientId,
          opId: id,
          vectorClock: this.bumpClock(),
          fileId,
          contentHash: localHash,
          size: localBuf.byteLength,
        }),
      (_ack, settle) => {
        meta.contentHash = localHash;
        meta.size = localBuf.byteLength;
        this.operationLog.setFileMeta(meta);
        settle();
      },
    );
  }

  /**
   * Whether an attachment update of file `fileId` waiting to go out, or on
   * its way, is **Keep local** about version `hash` of the server's (see
   * {@link keepLocalVersion}): the user has chosen the copy here over that
   * very version already.
   */
  private keptOver(fileId: string, hash: string): boolean {
    const bindingId = this.binding.id;
    return [
      ...this.operationLog.dequeueOperations(bindingId),
      ...this.operationLog.inFlightOperations(bindingId),
    ].some(
      (op) =>
        op.opType === 'UPDATE' &&
        queuedFileId(op.payload) === fileId &&
        op.payload[KEEP_OVER] === hash,
    );
  }

  private async applyServerDelete(fileId: string): Promise<void> {
    this.forgetWaiting(fileId);
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const holder = this.fileIndex.byPath.get(meta.relativePath);
    if (holder !== undefined && holder.fileId !== fileId) {
      // The name has gone to another file since: a note renamed onto it here
      // while this file's delete, made here too, was on its way. The copy
      // under the name is the other file's: taken for this one, it was
      // deleted, or the user was asked whether to delete it.
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
   *
   * A copy asked about after a teammate's delete leaves the index while the
   * question is open (see {@link leaveIndexWhileAsked}), and is then left to
   * a file indexed under its name or id the same way. Kept there, the file
   * the teammate created again under the name meanwhile — the server brings
   * the tombstone back under its id — was taken for the one deleted: its
   * broadcast was dropped as known, and its history met the deleted note's
   * here, offline edits included. The two were merged for the whole team, or
   * the new note's text was lost to the old one's.
   */
  private async dropLocalCopy(
    meta: IndexedMeta,
    movedTo: string | null,
    opts: { pushedBack: boolean; serverHad?: string; ask?: boolean; away?: boolean } = {
      pushedBack: true,
    },
  ): Promise<'done' | 'ask'> {
    /** Out of the index while the user is asked (see `leaveIndexWhileAsked`). */
    let asked = false;
    const taken = (): boolean =>
      (opts.away === true || asked) &&
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

    const path = meta.relativePath;
    if (movedTo !== null) {
      this.movedAway.set(meta.fileId, movedTo);
    } else {
      // Kept until the question is settled, across restarts (see
      // `deleteAskedBack`).
      this.operationLog.noteDeleteAsked(this.binding.id, meta.fileId);
      if (opts.away !== true) {
        asked = true;
        this.leaveIndexWhileAsked(meta);
      }
      this.askedCopies.set(path, meta.fileId);
    }
    try {
      return await this.settleAskedCopy(meta, movedTo, conflict, taken);
    } finally {
      if (asked) this.doneAsking(meta);
      if (this.askedCopies.get(path) === meta.fileId) this.askedCopies.delete(path);
    }
  }

  /**
   * The question of {@link dropLocalCopy} about the copy of `meta` (`asked`:
   * its content), and what its answer does. `taken`: whether a file indexed
   * under the copy's name or id since owns it now.
   */
  private async settleAskedCopy(
    meta: IndexedMeta,
    movedTo: string | null,
    asked: { localBuf: ArrayBuffer; localHash: string },
    taken: () => boolean,
  ): Promise<'done'> {
    const resolution = await this.conflictResolver.resolveDeleteConflict({
      filePath: meta.relativePath,
      localSize: asked.localBuf.byteLength,
    });
    this.throwIfStopped();
    // Another file holds the name now; the copy, if still there, is its own
    // business (see `applyServerCreate`).
    if (taken()) {
      this.deleteAskedSettled(meta.fileId);
      return 'done';
    }
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
    // The copy as it is now, not as it was when the question came: a save of
    // it made meanwhile was left to this answer (see `askedCopies`). Gone
    // since, there is nothing to restore.
    const restoring =
      resolution === 'restore-server' && (await this.vault.exists(meta.relativePath));
    this.throwIfStopped();
    if (restoring) {
      const localBuf = await this.vault.readBinary(meta.relativePath);
      const localHash = await sha256Hex(localBuf);
      this.throwIfStopped();
      // Push the local content as a fresh CREATE so the server
      // un-deletes it. The recipient broadcast will reset our state. An
      // answer to the question: never replayed. Its answer lost, the next
      // connect closes it if the server applied it, and asks again if not.
      // Nor queued behind changes the server refused with `busy` (see
      // `mayEmitOp`): refused itself meanwhile, it is asked again then too.
      if (this.canSendLive()) {
        let data: ArrayBuffer | undefined;
        try {
          data = await this.stageBinaryBlob(meta.fileType, localHash, localBuf);
        } catch {
          this.throwIfStopped();
          this.log.debug(
            'restore-server push failed; asking again on reconnect',
            meta.relativePath,
          );
          return 'done';
        }
        this.throwIfStopped();
        await this.sendOp(
          {
            opType: 'CREATE',
            filePath: meta.relativePath,
            newPath: null,
            payload: {
              fileType: meta.fileType,
              contentHash: localHash,
              size: localBuf.byteLength,
            },
            opId: newOpId(),
            settleOnly: true,
          },
          (id) =>
            this.emitCreate({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId: id,
              vectorClock: this.bumpClock(),
              filePath: meta.relativePath,
              fileType: meta.fileType,
              contentHash: localHash,
              size: localBuf.byteLength,
              ...(data !== undefined ? { data } : {}),
            }),
          async (ack, settle) => {
            const outcome = ack.outcome as { fileId?: unknown; path?: unknown } | undefined;
            const fileId = stringOf(outcome?.fileId);
            const path = stringOf(outcome?.path);
            if (fileId === '' || path === '') return;
            // The server revived the file under its id from this copy, the way
            // a note created here starts: recorded from the ack, its doc and
            // store dropped — by the exact name — for the server's. Kept, the
            // note's history here met the server's again on the next connect:
            // a server that continues the history on revival has this copy's
            // text in it once more, and the edits not sent before came back
            // doubled; one that replaces it merged the two. And unindexed, the
            // next save went out as a second CREATE.
            await this.recordCreatedFile(
              fileId,
              path,
              meta.fileType,
              localHash,
              localBuf.byteLength,
              () => {
                this.deleteAskedSettled(meta.fileId);
                settle();
              },
            );
          },
        );
      }
      // Don't drop the local copy — we want the file to stay.
      return 'done';
    }
    // 'delete-local', or a copy gone since.
    await this.commitLocal(async (io) => {
      if (!taken()) await this.removeLocalCopy(io, meta);
    });
    this.deleteAskedSettled(meta.fileId);
    return 'done';
  }

  /**
   * The question about the copy of deleted file `fileId` is settled: the copy
   * is gone, restored on the server, or another file's (see
   * `OperationLog.noteDeleteAsked`). Not when **Restore on server** could not
   * reach the server: the copy stays the deleted note's, and the next connect
   * asks again.
   */
  private deleteAskedSettled(fileId: string): void {
    this.operationLog.forgetDeleteAsked(this.binding.id, [fileId]);
  }

  /**
   * The copy of `meta`, a note or attachment a teammate deleted, is asked
   * about (see {@link dropLocalCopy}): the file leaves the index until the
   * question is settled, and `state.json` keeps its record — a restart asks
   * again (see {@link deletedWhileAway}). Its history stays in the store under
   * the name, unwired: nothing reaches it from the server meanwhile, and a
   * snapshot due for the note is dropped with it.
   *
   * A file created under the name or the id meanwhile — the teammate's new
   * note, which the server gives the deleted one's id — comes in as the new
   * file it is (see {@link applyServerCreate}): the copy goes aside under a
   * conflict name first, and the new note's history starts anew.
   */
  private leaveIndexWhileAsked(meta: IndexedMeta): void {
    const path = meta.relativePath;
    if (this.fileIndex.byId.get(meta.fileId) === meta) this.fileIndex.byId.delete(meta.fileId);
    if (this.fileIndex.byPath.get(path) === meta) this.fileIndex.byPath.delete(path);
    this.snapshotDebouncers.get(path)?.cancel();
    this.snapshotDebouncers.delete(path);
    this.unwire(path);
    this.askingDeleted.set(meta.fileId, path);
    this.awayCopies.set(path, meta.fileId);
  }

  /**
   * Files whose copy an earlier session asked about after a server delete,
   * the question never settled (see `OperationLog.noteDeleteAsked`), that the
   * server lists again: a tombstone brought back — a teammate's new note
   * under the name. The copy here, and the history under its name, are the
   * deleted note's, with the edits the question was about: the file under
   * the id is a new one (see {@link notesRecreated}).
   *
   * The catch-up can leave the DELETE out — the clock took it in when it was
   * applied — and then only a CREATE marked `revived` tells, which counts
   * only in a catch-up cut short. Without this, a question left open when
   * Obsidian closed, or **Restore on server** chosen without a connection,
   * had the note's offline edits merged into the teammate's new note on the
   * server that continues its history, for the whole team.
   *
   * Not one asked about in this session and still open (see
   * {@link askingDeleted}): out of the index, it comes in as the new file it
   * is (see {@link applyServerCreate}).
   */
  private deleteAskedBack(): Set<string> {
    const back = new Set<string>();
    for (const id of this.operationLog.deleteAskedIds(this.binding.id)) {
      if (this.lastListing.has(id) && !this.askingDeleted.has(id)) back.add(id);
    }
    return back;
  }

  /** The question of {@link leaveIndexWhileAsked} is settled. */
  private doneAsking(meta: IndexedMeta): void {
    if (this.askingDeleted.get(meta.fileId) === meta.relativePath) {
      this.askingDeleted.delete(meta.fileId);
    }
    if (this.awayCopies.get(meta.relativePath) === meta.fileId) {
      this.awayCopies.delete(meta.relativePath);
    }
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
   * server has of the file. `released`: the rename waited for `newPath`, and
   * {@link releaseName} let it in.
   */
  private async applyServerRename(
    fileId: string,
    newPath: string,
    away?: { serverHash: string },
    opts: { released?: boolean } = {},
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
    /** A new file of this device's is under the name, its create queued. */
    let createdHere = false;
    await this.withPathLocks([oldPath, newPath], async () => {
      // Let in by `releaseName`: whether the new file whose create waits in
      // the queue under the name is still gone from the disk. Read before the
      // checks below, which hold until the next await.
      const gone = opts.released === true && (await this.queuedCreateGone(newPath));
      // Renamed on this device while this waited: that rename reaches the
      // server after this one, and wins there.
      if ((this.renameCount.get(fileId) ?? 0) !== renamedHere) return;
      // Moved by another rename from the server while this waited (or the
      // index was rebuilt): the names looked up above are stale. Taken as
      // they were, a rename back to where the note had been was dropped as
      // already done, and a second rename to the name the note had just got
      // took the note's copy there for another file with the same content —
      // and deleted it.
      if (this.fileIndex.byId.get(fileId) !== meta || meta.relativePath !== oldPath) {
        movedMeanwhile = true;
        return;
      }
      if (oldPath === newPath) return;
      holder = this.nameHolder(newPath, meta);
      if (holder !== undefined) return;
      // A new file here whose create waits in the queue holds the name (see
      // `createQueuedAt`). Moved in, this file parked it aside, unsent, and
      // its create went out as a save of this one. Deleted, it holds nothing:
      // its create finds no file to send. Held for it all the same, this file
      // waited again each time the name was let go, until the next connect.
      createdHere = this.createQueuedAt(newPath) && !gone;
      if (createdHere) return;
      await this.commitLocal((io) => this.moveLocalCopy(io, meta, newPath));
    });
    if (holder !== undefined || createdHere) {
      this.waitForName({ kind: 'rename', fileId, path: newPath }, holder ?? null);
      return;
    }
    // Looked up again, under the names the note has now.
    if (movedMeanwhile) {
      await this.applyServerRename(fileId, newPath, undefined, opts);
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
   *
   * `holder`: the file indexed under the name; `null` for a new file whose
   * create waits in the queue (see {@link createQueuedAt}).
   */
  private waitForName(move: WaitingForName, holder: IndexedMeta | null): void {
    this.log.info('a file’s name here is still another file’s; its move waits for it', {
      fileId: move.fileId,
      path: move.path,
      ...(holder !== null
        ? { holder: holder.relativePath, renamedHere: this.renamePendingHere(holder.fileId) }
        : { createQueued: true }),
    });
    this.waitingForName.set(move.path, move);
  }

  /**
   * Whether a create of a file of this device's waits in the queue under
   * `path`: made offline, or while new changes wait behind the ones the
   * server refused `busy` (see {@link queueFirst}). The file on this disk
   * under the name is that one, and a file the server has there is another,
   * which waits for the name (see {@link waitForName}), as it does at a
   * connect (see `refreshFileIndex`).
   *
   * The connect's listing looked in the queue; a file the server announced
   * later did not. Recorded under the name, it took the new file here for its
   * own: renamed, that went out as a rename of the teammate's file — and
   * deleted, as its delete, from every device — while the create was dropped
   * as finding nothing (a new note given its title while the server was busy,
   * and a teammate's new "Untitled" broadcast meanwhile).
   */
  private createQueuedAt(path: string): boolean {
    return this.operationLog.queuesCreate(this.binding.id, path);
  }

  /**
   * Whether the new file under `path` whose create waits in the queue (see
   * {@link createQueuedAt}) is gone from the disk: deleted, it holds the name
   * no more. `false` when no create is queued under the name — the disk is
   * not read then — and when a file came under the name again while the disk
   * was read: a new note there, its create queued or on its way. Taken for
   * gone, the other file moved in over it.
   */
  private async queuedCreateGone(path: string): Promise<boolean> {
    const queued = this.operationLog.queuedCreates(this.binding.id, path);
    if (queued.length === 0) return false;
    const underWay = this.creating.get(path);
    if (await this.vault.exists(path)) return false;
    const creating = this.creating.get(path);
    if (creating !== undefined && creating !== underWay) return false;
    return this.operationLog
      .queuedCreates(this.binding.id, path)
      .every((entry) => queued.includes(entry));
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
    // A new file whose create waits in the queue holds the name while it is
    // on disk (see `createQueuedAt`). Deleted, it holds nothing: its create
    // finds no file to send (see `replayPending`).
    if (this.createQueuedAt(move.path)) {
      if (!(await this.queuedCreateGone(move.path))) return;
      if (this.waitingFor(path) !== move || this.nameHolder(move.path) !== undefined) return;
    }
    this.waitingForName.delete(move.path);
    if (move.kind === 'rename') {
      if (!this.fileIndex.byId.has(move.fileId)) return;
      this.log.info('a file moves into the name it waited for', move);
      // Past a create still queued under the name whose file is gone: it
      // leaves the queue only when the drain gets to it, and a move that
      // waited for it again was let in by nothing before the next connect.
      await this.applyServerRename(move.fileId, move.path, undefined, { released: true });
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
  private async askAboutRetiredWhileAway(online: AbortSignal): Promise<void> {
    for (const [fileId, { meta, serverHash }] of [...this.retiredAway]) {
      online.throwIfAborted();
      const movedTo = this.outOfScope.get(fileId)?.path;
      if (!this.reindexRetired(fileId) || movedTo === undefined) continue;
      try {
        const serverHad = await this.serverHadCopy(meta, serverHash);
        await this.dropLocalCopy(meta, movedTo, {
          pushedBack: false,
          ...(serverHad !== null ? { serverHad } : {}),
        });
      } catch {
        online.throwIfAborted();
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
    // An answer to the question: not queued behind changes the server refused
    // with `busy` either (see `mayEmitOp`).
    if (!this.canSendLive()) return;
    let result: SendResult<void>;
    // On its way from here: its broadcast is this device's own.
    this.localRenames.set(meta.fileId, (this.localRenames.get(meta.fileId) ?? 0) + 1);
    try {
      // An answer to the question: never replayed (see `sendOp`).
      result = await this.sendOp(
        {
          opType: 'RENAME',
          filePath: movedTo,
          newPath: path,
          payload: { fileId: meta.fileId },
          opId: newOpId(),
          settleOnly: true,
        },
        (id) =>
          this.socket.emitFileRename({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            opId: id,
            vectorClock: this.bumpClock(),
            fileId: meta.fileId,
            filePath: movedTo,
            newPath: path,
          }),
        (_ack, settle) => settle(),
      );
    } finally {
      this.forgetLocalRename(meta.fileId);
    }
    if (result.kind === 'refused') {
      this.log.warn('could not move a renamed file back', { path, movedTo, error: result.error });
      return;
    }
    if (result.kind === 'queued') {
      this.log.debug('moving a renamed file back failed; asking again on reconnect', path);
      return;
    }
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
    // A file never written here has no copy to move: a file under its old
    // name is another one (see `yieldNameNotWritten`).
    if (meta.notOnDisk !== true && (await io.vault.exists(oldPath))) {
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
    await this.applyServerCreate(
      { id: fileId, path: newPath, fileType: known.fileType },
      { adopted: true },
    );
    const meta = this.fileIndex.byId.get(fileId);
    if (known.fileType !== 'TEXT' || meta?.relativePath !== newPath) return;
    // What the listing says of it: a note with text is not written out empty
    // when its doc cannot be had.
    const listed = this.lastListing.get(fileId);
    if (listed !== undefined && meta.size === 0) meta.size = listed.size;
    // No update follows a rename: the note's text is pulled from the server
    // by the snapshot. Left to the next teammate's edit or the next connect,
    // the note was missing from this device's disk until then.
    if (!this.canFetch()) return;
    this.skippedDocs.add(fileId);
    this.scheduleSnapshotToDisk(newPath);
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
   *
   * The marker is the one `state.json` gave, unless the engine's last write
   * of the note — the teammate's text it wrote from the doc — went through
   * and did not reach `state.json` (see {@link lostWriteMark}): then it is the
   * hash of that text.
   * Folded against the older marker, the disk that write left looked like
   * local edits made to the text before it: without a base it replaced the
   * note's text for everyone — the teammate's text typed since, gone — and
   * with one from the version history, the teammate's lines were merged in
   * twice.
   */
  private async foldDiskEditsIntoDoc(path: string, diskText: string | null): Promise<void> {
    const meta = this.fileIndex.byPath.get(path);
    if (!meta || meta.fileType !== 'TEXT') return;
    if (diskText === null) return;
    if (diskText === this.docManager.getText(this.binding.id, path)) {
      await this.markFolded(meta, diskText);
      return;
    }
    const diskHash = await sha256Hex(diskText);
    const lost = this.lostWriteMark(meta, path, diskHash);
    const marker = lost?.hash ?? meta.foldedHash;
    // Logs from before 0.3.2 have no marker yet. `contentHash` still answers
    // "is the disk unchanged since the last sync", as it always did — but it
    // may come straight from the server listing for a file this device never
    // wrote, so it must never pick a merge base: a base the disk doesn't
    // descend from turns divergence into doubled text.
    if (diskHash === (marker ?? meta.contentHash)) {
      if (lost !== null) {
        // The disk is the engine's last write, the doc the one ahead: the
        // marker `state.json` lost is recorded again.
        this.log.info('a note on disk is this device’s last write of it; its record was lost', {
          path,
          fileId: meta.fileId,
        });
        await this.markFolded(meta, diskText, diskHash);
        return;
      }
      // Nothing on disk the doc hasn't seen — the doc is the one ahead.
      if (marker !== undefined) this.foldBases.set(meta.fileId, { text: diskText, hash: diskHash });
      return;
    }
    const base = marker === undefined ? null : await this.resolveFoldBase(meta, marker, lost);
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
      // A rewrite on either side merges by lines or one span, within bounded
      // time: every edit is kept, but a teammate's edit inside the rewritten
      // part keeps its text, not necessarily its place — worth a line.
      next = mergeText3(base, diskText, docText, {
        onCoarse: (paths) => this.log.warn('coarse merge', { path, ...paths }),
      });
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
   *
   * A marker from the mark of the engine's last write (`lost`, see
   * {@link lostWriteMark}) names the text written: the doc gives it back,
   * rebuilt at the state it was taken at (see `DocManager.textAt`), when the
   * teammate typed on since — the doc is ahead of it then.
   */
  private async resolveFoldBase(
    meta: IndexedMeta,
    marker: string,
    lost: WrittenMark | null = null,
  ): Promise<string | null> {
    const cached = this.foldBases.get(meta.fileId);
    if (cached) {
      const hash = cached.hash ?? (await sha256Hex(cached.text));
      if (hash === marker) return cached.text;
      this.foldBases.delete(meta.fileId);
    }
    const docText = this.docManager.getText(this.binding.id, meta.relativePath);
    if ((await sha256Hex(docText)) === marker) return docText;
    if (lost?.state !== undefined && lost.hash === marker) {
      const written = this.docManager.textAt(this.binding.id, meta.relativePath, lost.state);
      if (written !== null && (await sha256Hex(written)) === marker) return written;
    }
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
   * `log` and `docs` are the unfenced ones inside a {@link commitLocal} block.
   *
   * A marker naming another text than the engine's last write of the note
   * drops the mark of that write (see `DocManager.forgetWritten`): the disk
   * has moved on from it. Kept, it took that very text back on disk later —
   * `git checkout`, a backup, File Recovery — for the write, and the doc's
   * text went over it.
   */
  private setFoldedHash(
    meta: IndexedMeta,
    hash: string,
    log: OperationLog = this.operationLog,
    docs: DocManager = this.docManager,
  ): void {
    const live = this.fileIndex.byId.get(meta.fileId);
    if (live !== meta) meta.foldedHash = hash;
    if (live) docs.forgetWritten(this.binding.id, this.docPathOf(live), hash);
    if (!live || live.foldedHash === hash) return;
    live.foldedHash = hash;
    log.setFileMeta(live);
  }

  /**
   * The mark of the engine's last write of the note at `path` to disk (see
   * `DocManager.noteWritten`) when `state.json` did not take that write: a
   * crash, or Obsidian's "Reload app without saving", in the moment after it.
   * The note's fold marker still names the text the write went over then,
   * and the fold takes the mark's text for the one folded instead (see
   * {@link foldDiskEditsIntoDoc}). `null` otherwise.
   *
   * The mark says only that the engine wrote that text from this history
   * over that record, not that the text on disk may be written over now. So
   * it is taken only while the record is as it was right before the write —
   * the same marker, the same synced content. A marker moved to another text
   * since drops the mark (see {@link setFoldedHash}); a record moved on
   * without the doc open — the catch-up takes a disk agreeing with the
   * server as synced without it (see `catchupDocIsRedundant`) — no longer
   * matches it. A note new here when written — no marker, no content
   * recorded, as a teammate's note created live is until its first write —
   * has no content to match: its record is the listing's after a crash, and
   * without a marker.
   *
   * Nor does it say the write took place. It goes down right before the
   * write, and a write given up on — the disk changing under it at every
   * look, the file gone, `stop()` — leaves it, the record as it was then: the
   * mark of a text the disk never got. It tells a disk holding that very text
   * (`diskHash`); a disk holding another descends from the text written — its
   * base for the fold — only when the write went through to this vault's
   * disk (see `DocManager.confirmWritten`). Taken for the disk's base
   * otherwise, the fold read the disk, which never had the teammate's text
   * the write was bringing in, as the deletion of it, for everyone; and so it
   * did in a copy of the vault in another folder, which shares the note's
   * database with the one that wrote.
   */
  private lostWriteMark(meta: IndexedMeta, path: string, diskHash: string): WrittenMark | null {
    const mark = this.docManager.writtenMarkOf(this.binding.id, path);
    if (mark === null || mark.fileId !== meta.fileId) return null;
    const marker = meta.foldedHash ?? '';
    if (mark.hash === marker || mark.over !== marker) return null;
    const newHere = mark.over === '' && mark.synced === '';
    if (!newHere && mark.synced !== meta.contentHash) return null;
    if (diskHash !== mark.hash && !this.writtenToThisDisk(mark)) return null;
    return mark;
  }

  /** Whether the write `mark` is of went through to this vault's disk (see `lostWriteMark`). */
  private writtenToThisDisk(mark: WrittenMark): boolean {
    const disk = this.vault.getBasePath();
    return disk !== '' && mark.disk === disk;
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
      // A server that did not answer in time (a jammed one): don't make every
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
    // The mark of the write about to happen (see below), `null` for none.
    let mark: WrittenMark | null;
    for (let attempt = 1; ; attempt++) {
      // A note never written here, with a file under its name: that one is
      // another, which its own event sends as such (see
      // `yieldNameNotWritten`). Folded in, its text went to the server as
      // this note's, over the teammate's.
      if (
        meta?.notOnDisk === true &&
        diskText !== null &&
        diskText !== this.docManager.getText(this.binding.id, path)
      ) {
        this.log.debug('snapshot left out: another file is under the name of a note', path);
        return;
      }
      await this.foldDiskEditsIntoDoc(path, diskText);
      text = this.docManager.getText(this.binding.id, path);
      // Which of the doc's operations make the text about to be written, for
      // its mark (see below): taken with the text, before anything else lands.
      const state =
        meta && diskText !== text && this.docPathOf(meta) === path
          ? this.docManager.stateOf(this.binding.id, path)
          : null;
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
      // In the note's offline history before the write, where a crash leaves
      // it: the record of the write reaches `state.json` a moment after it
      // (see `settleWrittenHere`, `lostWriteMark`). Not waited for. Only a
      // write that goes through confirms it (below): one given up on leaves
      // the mark of a text the disk never got.
      mark =
        meta && this.docPathOf(meta) === path
          ? {
              fileId: meta.fileId,
              hash,
              over: meta.foldedHash ?? '',
              synced: meta.contentHash,
              ...(state !== null ? { state } : {}),
            }
          : null;
      if (mark !== null) this.docManager.noteWritten(this.binding.id, path, mark);
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
    const marked = mark;
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
      // The mark of the write likewise: confirmed only now, for this vault's
      // disk (see `lostWriteMark`).
      if (marked !== null) {
        io.docs.confirmWritten(this.binding.id, path, marked, io.vault.getBasePath());
      }
      if (meta) {
        this.foldBases.set(meta.fileId, { text: written, hash });
        this.setFoldedHash(meta, hash, io.log, io.docs);
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
    // On disk now: the write comes right after, or the disk has it already.
    delete meta.notOnDisk;
    log.setFileMeta(meta);
  }

  // -- Pending queue --------------------------------------------------------

  /**
   * Queue a local change for the drain. `opId`: the change's (see
   * `HeldChange`); a new one when absent. A change the queue holds already
   * under that id — put back there by `sendOp` — is not queued twice.
   */
  private queue(
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
    opId: string = newOpId(),
  ): void {
    // The fence refuses this too; spelled out because the queue is what the
    // next engine replays without asking.
    this.throwIfStopped();
    this.queueOp({ opType, filePath, newPath, payload, opId });
  }

  /**
   * Send the queue, one drain at a time: the connect's (see
   * {@link drainThenInitialPush}), or a try after `busy` (see
   * {@link pumpQueue}). `link`: the connection the drain works for — it ends
   * with it, and what it came to is acted on only while that connection is
   * the one open (see {@link afterDrain}). The connect's drain waits for one
   * still running; a try that comes while one runs is made after it.
   */
  private async runDrain(link: AbortController, kind: 'connect' | 'pump'): Promise<void> {
    if (this.draining !== null && kind === 'pump') {
      this.drainAgain = true;
      return;
    }
    while (this.draining !== null) {
      await this.draining;
      link.signal.throwIfAborted();
    }
    let finished!: () => void;
    this.draining = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.drainSignal = link.signal;
    try {
      this.afterDrain(await this.drainQueue(link.signal), link);
    } finally {
      this.drainSignal = null;
      this.draining = null;
      finished();
      if (this.drainAgain) {
        this.drainAgain = false;
        if (
          link === this.link &&
          !link.signal.aborted &&
          this.operationLog.replayableCount(this.binding.id) > 0
        ) {
          this.schedulePump();
        }
      }
    }
  }

  /**
   * Replay the queue until it is empty, pass after pass (see
   * {@link flushPendingOperations}): changes queued while a pass runs — new
   * ones behind those the server refused with `busy` (see {@link queueFirst}),
   * or a live one put back — go out with the next. Before a pass while new
   * changes wait behind the queue, the ones this engine has on their way are
   * waited for (see {@link liveOpsSettled}).
   */
  private async drainQueue(signal: AbortSignal): Promise<DrainOutcome> {
    for (let pass = 0; this.operationLog.replayableCount(this.binding.id) > 0; pass++) {
      if (pass >= DRAIN_PASSES_MAX) return { kind: 'capped' };
      if (this.queueFirst) await this.liveOpsSettled(signal);
      if (!this.canSendLive()) return { kind: 'offline' };
      const result = await this.flushPendingOperations(signal);
      if (result.haltedOn !== null) {
        return { kind: 'halted', error: result.haltedError ?? 'unknown' };
      }
      if (result.sent + result.droppedCount === 0) return { kind: 'stalled' };
    }
    return { kind: 'empty' };
  }

  /**
   * What a drain of the queue (see {@link runDrain}) came to, acted on while
   * the connection it worked for is the one open — the next connect starts
   * over (see {@link onSocketConnect}):
   *
   *   - the queue sent: new changes go out at once again;
   *   - halted on `busy`: new changes wait behind the queue, which is tried
   *     again after a pause (see {@link schedulePump});
   *   - halted on another error while new changes wait behind the queue:
   *     tried again, and after {@link QUEUE_FAILURES_MAX} such tries in a row
   *     new changes go out at once again, and the queue is tried again after
   *     a long pause until it goes out (see {@link queueStuck}); a drain
   *     halted so otherwise waits for the next connect, as it always has;
   *   - a pass that sent nothing, the queue not empty: tried again;
   *   - still filling up after {@link DRAIN_PASSES_MAX} passes: new changes go
   *     out at once again, and the rest of the queue is tried after a pause.
   */
  private afterDrain(outcome: DrainOutcome, link: AbortController): void {
    if (link !== this.link || link.signal.aborted) return;
    switch (outcome.kind) {
      case 'empty':
        if (this.queueStuck) this.log.info('queued changes held up after busy sent');
        this.queueStuck = false;
        this.openGate('sent');
        return;
      case 'halted':
        if (outcome.error === 'busy') {
          this.closeGate();
          this.pumpFailures = 0;
          this.schedulePump();
          return;
        }
        // Halted so with nothing waiting behind the queue: it waits for the
        // next connect, as it always has — unless it holds changes the
        // server refused `busy` (see `queueStuck`).
        if (!this.queueFirst) {
          if (this.queueStuck) this.schedulePump();
          return;
        }
        this.pumpFailures += 1;
        if (this.pumpFailures < QUEUE_FAILURES_MAX) {
          this.schedulePump();
          return;
        }
        this.log.warn(
          'queue drain halted after busy; new changes go out again, and the queue is tried again later',
          {
            error: outcome.error,
            waiting: this.operationLog.replayableCount(this.binding.id),
            retryInMs: this.queueStuckRetryMs,
          },
        );
        this.openGate('given up');
        this.queueStuck = true;
        this.schedulePump();
        return;
      case 'stalled':
        if (this.queueFirst) this.schedulePump();
        return;
      case 'capped':
        this.log.warn(
          'changes keep coming faster than the queue goes out; new changes go out again',
          {
            waiting: this.operationLog.replayableCount(this.binding.id),
          },
        );
        this.openGate('given up');
        this.schedulePump();
        return;
      case 'offline':
        return;
    }
  }

  /**
   * The server refused a file operation of this device with `busy`: new
   * changes wait in the queue behind it (see {@link queueFirst}), and the
   * status says so.
   */
  private closeGate(): void {
    // Tried again after the long pause (see `queueStuck`): after the short
    // ones from here on.
    if (this.queueStuck) {
      this.queueStuck = false;
      this.clearPumpTimer();
    }
    if (this.queueFirst) return;
    this.queueFirst = true;
    this.log.info('server busy: new file changes wait in the queue behind the refused ones', {
      waiting: this.operationLog.replayableCount(this.binding.id),
    });
    if (this.status === 'connected') this.setStatus('connected', QUEUE_FIRST_DETAIL);
  }

  /**
   * New changes go out at once again (see {@link queueFirst}): the queue has
   * gone out (`sent`), or the engine has stopped waiting for it (`given up`).
   */
  private openGate(how: 'sent' | 'given up'): void {
    this.pumpStep = 0;
    this.pumpFailures = 0;
    if (!this.queueFirst) return;
    this.queueFirst = false;
    if (how === 'sent')
      this.log.info('changes the server refused as busy sent; new ones go out again');
    if (this.status === 'connected' && this.statusDetail === QUEUE_FIRST_DETAIL) {
      this.setStatus('connected');
    }
  }

  /**
   * Try the queue again after the next pause of {@link queueRetryMs}, or of
   * {@link queueStuckRetryMs} once stuck (see {@link queueStuck}), on the
   * connection open now (see {@link pumpQueue}). Not before this connect
   * has handed the queue to its drain (see {@link drainHandedOver}); nor
   * offline, on Pause sync or once stopped — the next connect sends it.
   */
  private schedulePump(): void {
    if (this.pumpTimer !== null || this.hasStopped || this.paused || !this.started) return;
    if (!this.drainHandedOver) return;
    const link = this.link;
    if (link === null || link.signal.aborted) return;
    const pauses = this.queueRetryMs;
    const delay = this.queueStuck
      ? this.queueStuckRetryMs
      : (pauses[Math.min(this.pumpStep, pauses.length - 1)] ?? 0);
    this.pumpStep += 1;
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = null;
      this.trackConnectFlow(this.pumpQueue(link));
    }, delay);
  }

  /** Call off the try of the queue {@link schedulePump} set up, if any. */
  private clearPumpTimer(): void {
    if (this.pumpTimer === null) return;
    window.clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }

  /**
   * A try of the queue after `busy` (see {@link schedulePump}): a drain on
   * the connection `link`, while it is the one open. Cut short with it, by
   * Pause sync or by `stop()`, it ends silently: the next connect sends the
   * queue.
   */
  private async pumpQueue(link: AbortController): Promise<void> {
    if (link !== this.link || link.signal.aborted || this.hasStopped) return;
    try {
      await this.runDrain(link, 'pump');
    } catch (err) {
      if (link.signal.aborted || this.hasStopped) return;
      this.log.warn('could not send the queue again', {
        error: describeError(err, 'drain_failed'),
      });
    }
  }

  /**
   * Resolves once none of the changes this engine sent live is on its way —
   * recorded in flight and neither answered nor queued yet (answers to
   * questions aside). A try of the queue after `busy` goes after them: the
   * server may still refuse one of them `busy` after the pause, and it goes
   * back to the queue in its place, ahead of the changes queued since. The
   * pause alone was no guarantee: an answer late by more than it, and the
   * refused change went out after the ones made after it.
   */
  private async liveOpsSettled(signal: AbortSignal): Promise<void> {
    while (this.liveInFlight()) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.flightWaiters.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        this.flightWaiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  /** Whether a change of this engine's is on its way (see {@link liveOpsSettled}). */
  private liveInFlight(): boolean {
    if (this.inflightHere.size === 0) return false;
    return this.operationLog
      .inFlightOperations(this.binding.id)
      .some((op) => op.settleOnly !== true && this.inflightHere.has(op.opId));
  }

  /**
   * Replay every pending operation for this binding via the shared
   * `flushPendingQueue` helper from `reconnect.ts`. Splitting the loop
   * out of the engine lets us reuse the same drain machinery from a
   * future "Sync now" command.
   */
  private async flushPendingOperations(signal: AbortSignal): Promise<FlushResult> {
    this.collapseQueuedRenames();
    const emit: PendingEmitter = (op) => this.replayPending(op);
    // Pause sync ends the drain like `stop()`: the operation in flight stays
    // queued and goes out once on resume, and the drain is not reported as
    // halted on it. So does a connection lost (see `link`).
    const result = await flushPendingQueue(this.binding.id, this.operationLog, emit, { signal });
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
      // `busy` is said once, when changes start waiting behind the queue (see
      // `closeGate`), and the queue is tried again: a line for each try, every
      // half a minute of a long stall, only buried the rest of `sync.log`.
      const detail = {
        opType: result.haltedOn.opType,
        path: result.haltedOn.filePath,
        error: result.haltedError,
        remaining: result.remaining,
      };
      if (result.haltedError === 'busy' || this.queueStuck) {
        this.log.debug('offline queue drain halted', detail);
      } else this.log.warn('offline queue drain halted', detail);
    }
    return result;
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
      /** The folders the steps left that went with them (see `vanishedFolderOf`). */
      const folders: string[] = [];
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
        const folder = queuedFolder(op.payload);
        if (folder !== null) folders.push(folder);
        target = op.newPath;
      }
      if (chain.length === 0) continue;
      for (const id of chain) absorbed.add(id);
      // None of them has reached the server. The connect asked about each one
      // queued before it (see `settleUnanswered`), and in the same connection
      // an operation comes back to the queue only without having been
      // applied: refused (`busy` among others), queued behind the ones the
      // server refused (see `queueFirst`), or not sent at all. A live rename
      // the server answered is settled before anything can throw (see
      // `renameRecorded`), so never goes back. The chain goes out as `first`,
      // under its `opId`.
      if (target === first.filePath) absorbed.add(first.id);
      else {
        this.operationLog.retargetOperation(first.id, target);
        // The folder the note left that went with one of the steps — the
        // folder renamed after the note was: the topmost that is still a
        // folder of where the chain starts, and not one of where it ends.
        const own = queuedFolder(first.payload);
        const left =
          [...(own === null ? [] : [own]), ...folders]
            .filter((f) => first.filePath.startsWith(`${f}/`) && !isInBinding(target, f))
            .sort((a, b) => a.length - b.length)[0] ?? null;
        if (left !== own) {
          this.operationLog.amendOperation(first.id, {
            payload: withFolder(first.payload, left),
          });
        }
      }
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
   * Every entry goes out under its `opId`, and none the server has applied
   * already: the connect asked the server about each one before the drain
   * (see `settleUnanswered`), took in what it had applied, and gave the
   * others new ids. A resend of one the drain had in flight is answered with
   * the outcome it had, and applied once.
   */
  private async replayPending(op: PendingOperation): Promise<ReplayOutcome> {
    // Taken out of the queue while the drain was on its way to it: a rename
    // of the file made since went out in its place (see
    // `supersedeQueuedMoves`).
    if (!this.operationLog.isPending(this.binding.id, op.id)) {
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
            // dropping the op is the right thing. A file the server has under
            // the name may wait for it (see `createQueuedAt`).
            await this.releaseName(op.filePath);
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
          // `payload.contentHash` captured at enqueue time: a file created
          // then edited while offline enqueues several CREATEs whose payload
          // hashes diverge. The first to go out records the file, and the
          // others go through modify (above).
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
          const sent: { ack?: FileAck } = {};
          await this.trackCreate(op.filePath, async () => {
            const ack = await this.emitQueued(op, (opId) =>
              this.emitCreate({
                projectId: this.binding.projectId,
                clientId: this.clientId,
                opId,
                vectorClock: this.bumpClock(),
                filePath: op.filePath,
                fileType,
                contentHash,
                size: data.byteLength,
                ...(inlineData !== undefined ? { data: inlineData } : {}),
              }),
            );
            sent.ack = ack;
            this.throwIfStopped();
            if (!ack.ok) return null;
            let settled = false;
            // Keep `fileIndex` authoritative so the initial-push pass that
            // runs right after the drain skips this file instead of
            // re-uploading it.
            const created = await this.recordCreateAck(
              op.filePath,
              ack.outcome,
              fileType,
              contentHash,
              data.byteLength,
              () => {
                settled = true;
                this.settleDrained(op, ack);
              },
            );
            if (!settled) this.settleDrained(op, ack);
            return created;
          });
          const ack = sent.ack ?? { ok: false, error: 'no_ack' };
          return ack.ok ? { ok: true } : this.drainRefusal(op, ack.error);
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
          // A note's edit goes through its doc, never as an attachment
          // update: sent so, the note's bytes went to the server beside its
          // doc, and every client of the project took them for an attachment
          // version. Should the queue hold one (`state.json` outlives the
          // build that wrote it), the save is folded in as any save is.
          if (this.fileIndex.byId.get(fileId)?.fileType === 'TEXT') {
            await this.handleLocalModify(path, 'queue');
            this.throwIfStopped();
            return { ok: true };
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
          const ack = await this.emitQueued(op, (opId) =>
            this.socket.emitFileUpdateBinary({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId,
              vectorClock: this.bumpClock(),
              fileId,
              contentHash,
              size: data.byteLength,
            }),
          );
          this.throwIfStopped();
          if (!ack.ok) return this.drainRefusal(op, ack.error);
          const meta = this.fileIndex.byId.get(fileId);
          if (meta) {
            meta.contentHash = contentHash;
            meta.size = data.byteLength;
            this.operationLog.setFileMeta(meta);
          }
          this.settleDrained(op, ack);
          return { ok: true };
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
          const deleted = fileId;
          const ack = await this.emitQueued(op, (opId) =>
            this.emitDelete({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId,
              vectorClock: this.bumpClock(),
              fileId: deleted,
              filePath: op.filePath,
              ...folderField(queuedFolder(op.payload)),
            }),
          );
          this.throwIfStopped();
          if (!ack.ok) return this.drainRefusal(op, ack.error);
          // Checked against the disk, when it was queued or just above: a
          // file there now is a new one.
          this.freedHere.add(op.filePath);
          const at = this.currentPathOf(fileId, op.filePath);
          if (this.fileIndex.byId.get(fileId)?.relativePath === at) {
            this.fileIndex.byId.delete(fileId);
          }
          this.forgetPath(this.operationLog, fileId, at);
          if (at !== op.filePath) this.forgetPath(this.operationLog, fileId, op.filePath);
          this.settleDrained(op, ack);
          // Drop the doc + any pending snapshot so a debounced write can't
          // recreate the deleted file (see handleLocalDelete).
          await this.dropDoc(this.docManager, fileId, at);
          return { ok: true };
        }
        case 'RENAME':
        case 'MOVE': {
          const fileId = queuedFileId(op.payload);
          if (!fileId || !op.newPath) {
            return { ok: false, retryable: false, error: 'missing_target' };
          }
          const newPath = op.newPath;
          const ack = await this.emitQueued(op, (opId) => {
            const payload = {
              projectId: this.binding.projectId,
              clientId: this.clientId,
              opId,
              vectorClock: this.bumpClock(),
              fileId,
              filePath: op.filePath,
              newPath,
              ...folderField(queuedFolder(op.payload)),
            };
            return op.opType === 'RENAME'
              ? this.socket.emitFileRename(payload)
              : this.socket.emitFileMove(payload);
          });
          this.throwIfStopped();
          if (!ack.ok) return this.drainRefusal(op, ack.error);
          {
            // Out of the queue at once: the server has applied it, so a
            // teammate's rename of the file broadcast from now on came after
            // it and is followed (see `renamePendingHere`), not left to it.
            this.settleDrained(op, ack);
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
            await this.followStoredRename(fileId, ack.outcome);
          }
          return { ok: true };
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
   * Emit queued operation `op` for the drain: written ahead — its `opId` is
   * on disk before it goes out (a write that fails halts the drain on it) —
   * and known in {@link sending} until answered. An entry on disk under its
   * `opId` already goes out without a write: waited for before each entry,
   * the write the previous entry's answer asked for made the drain of a large
   * queue take a write per entry, one after another.
   */
  private async emitQueued(
    op: PendingOperation,
    emit: (opId: string) => Promise<FileAck>,
  ): Promise<FileAck> {
    if (!this.operationLog.queuedWritten(this.binding.id, op.opId)) {
      await this.operationLog.persistNow();
    }
    this.throwIfStopped();
    // The drain's connection is gone (see `link`): the next connect's drain
    // sends it.
    this.drainSignal?.throwIfAborted();
    this.sending.add(op.opId);
    try {
      return await emit(op.opId);
    } finally {
      this.sending.delete(op.opId);
    }
  }

  /**
   * The drain's operation `op` answered, what it brought recorded: out of the
   * queue, in the same synchronous block as that last record, and this
   * device's counter moves up to the one the server logged it with.
   */
  private settleDrained(op: PendingOperation, ack: FileAck): void {
    if (!ack.ok) return;
    this.adoptOwnCounter(ack.log?.vectorClock);
    this.persistVectorClock();
    this.operationLog.markSent([op.id]);
    this.ownKnown.add(op.opId);
  }

  /**
   * The drain's operation `op` refused: see `ackToOutcome`. Voided — sent
   * again after `ops:status` voided it, a packet of a connection gone that
   * came late — it gets a new id for its next try.
   */
  private drainRefusal(op: PendingOperation, error: string): ReplayOutcome {
    if (error === 'op_voided') this.operationLog.rotateOpId(this.binding.id, op.id);
    // New changes wait behind it; the end of the drain has the queue tried
    // again (see `afterDrain`).
    if (error === 'busy') this.closeGate();
    return ackToOutcome({ ok: false, error });
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
    const change: HeldChange = { opType, filePath, newPath, payload, opId: newOpId() };
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
    const bindingId = this.binding.id;
    for (const change of this.held) {
      try {
        // On its way, or queued already after a try: it is there under its id.
        if (this.operationLog.findByOpId(bindingId, change.opId) !== null) continue;
        this.operationLog.enqueueOperation(bindingId, {
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
    // Every operation this engine has on its way goes back to the queue, in
    // its place: its answer never reaches a stopped engine, and the next one
    // asks the server what became of it (see `settleUnanswered`).
    for (const opId of this.inflightHere) {
      try {
        this.operationLog.requeueInFlight(bindingId, opId);
      } catch (err) {
        this.log.warn('could not queue an operation in flight at stop', { opId, err });
      }
    }
    this.inflightHere.clear();
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
   * Run a flow nobody awaits. Being cut short by `stop()` or by Pause sync is
   * not a failure and ends it silently; any other rejection surfaces as it
   * did before.
   */
  private detach(flow: Promise<void>): void {
    void flow.catch((err: unknown) => {
      if (!this.hasStopped && !(err instanceof SyncPausedError)) throw err;
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
    this.statusDetail = detail;
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
 * A marked CREATE without its DELETE counts only in a catch-up cut short to
 * its newest operations (`truncated`): that one can leave the DELETE out, and
 * that server continues the history — without the mark, what this device had
 * done to the deleted note and never sent was merged into the new one. In any
 * other catch-up a DELETE left out is one the clock has seen: applied here on
 * an earlier connect, the deleted note is gone from this device already, and
 * the file under the id is the one it has now. Counted, a note this device
 * created under the name of a deleted one ("Untitled"), whose ack and
 * broadcast were lost with the connection, was taken for a teammate's: the
 * rename queued for it was dropped and the old name came back — with an edit
 * made since, as a second note for the whole team. Without the mark, and
 * without the DELETE, nothing is concluded: the histories themselves tell
 * then (see `DocManager.lineageOf`).
 *
 * Not when this device applied the CREATE live (`appliedLive`), nor from a
 * create of its own — the caller leaves this device's own operations out of
 * `ops` (see `SyncEngine.ownRows`): the note it has is that new one already,
 * and what it did to it since — an edit, a rename, a delete, made offline —
 * is about the new note. Taken for a note recreated while it was away, the
 * edit went into a conflict copy and the rename and the delete were dropped.
 */
function notesRecreated(
  ops: readonly ServerOperation[],
  appliedLive: ReadonlySet<string>,
  opts: { truncated: boolean },
): Set<string> {
  const deleted = new Set<string>();
  const recreated = new Set<string>();
  for (const op of ops) {
    const payload = (op.payload ?? {}) as { fileId?: unknown; revived?: unknown };
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    if (fileId === '') continue;
    if (op.opType === 'DELETE') {
      deleted.add(fileId);
    } else if (op.opType === 'CREATE') {
      const revived = deleted.delete(fileId) || (opts.truncated && payload.revived === true);
      if (revived && !appliedLive.has(op.id)) recreated.add(fileId);
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
 * The folder a queued DELETE, RENAME or MOVE says vanished with it (see
 * {@link FOLDER}); `null` for none, or one parsed back from `state.json`
 * malformed.
 */
function queuedFolder(payload: Record<string, unknown>): string | null {
  const value = payload[FOLDER];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `payload` with {@link FOLDER} set to `folder`, or without it for `null`. */
function withFolder(
  payload: Record<string, unknown>,
  folder: string | null,
): Record<string, unknown> {
  const { [FOLDER]: _dropped, ...rest } = payload;
  return folder === null ? rest : { ...rest, [FOLDER]: folder };
}

/** `folder` of a `file:delete`, `file:rename` or `file:move`, when there is one. */
function folderField(folder: string | null): { folder?: string } {
  return folder === null ? {} : { folder };
}

/** The folder vault path `path` is in; `''` for the vault's root. */
function parentFolder(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** `value` when it is a string, else `''`: for fields that come off the wire. */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolves after `ms`, or rejects with the reason of `signal` once it aborts. */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
    error === 'path_is_directory' ||
    // The id belongs to another client's or another kind of operation (see
    // `sync-protocol.md`, «Идемпотентность операций»): a resend gets the same.
    error === 'op_id_conflict' ||
    error === 'not_text';
  const retryable = !permanent;
  return { ok: false, retryable, error };
}
