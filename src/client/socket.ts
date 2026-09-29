import { io as ioFactory } from 'socket.io-client';
import type { ServerConfig } from '@/settings/settings';
import type { VectorClock } from '@/sync/vector-clock';

/**
 * Socket.IO client wrapper.
 *
 * Wraps the raw `socket.io-client` socket with:
 *   - X-API-Key handshake auth (matches `server/src/socket/auth.ts`),
 *   - typed event subscriptions (`onConnect` / `onDisconnect` / `onError` and
 *     server broadcast streams),
 *   - request/ack helpers (`joinProject`, `emitFileCreate`, …) that resolve
 *     a Promise with the server's ack payload,
 *   - exponential-backoff reconnect (1s → 30s, infinite attempts) so the
 *     plugin survives the typical Wi-Fi blip without the user noticing.
 *
 * The underlying socket factory is injectable so tests can run without a
 * real network — see `tests/socket.test.ts`.
 */

// -- Wire types ---------------------------------------------------------------
// Mirrored from `server/src/socket/handlers/*`. Kept in sync by hand; the
// shapes are small enough that a codegen step isn't worth it yet.

export interface ServerLogEntry {
  id: string;
  vectorClock: VectorClock;
  /** Serialized as ISO-8601 over the wire. */
  createdAt: string;
}

export interface ServerOperation {
  id: string;
  opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
  filePath: string;
  newPath: string | null;
  authorId: string | null;
  /**
   * The client the operation came from: a device's `clientId`, or
   * `rest:<userId>` for a write through REST. `null` on rows logged before the
   * server recorded it.
   */
  clientId: string | null;
  /** The operation's idempotency key; `null` on rows logged before the server recorded it. */
  opId: string | null;
  vectorClock: VectorClock;
  payload: unknown;
  /** Wire format from the server is a Date string, not a Date object. */
  createdAt: string;
}

/**
 * What the server made of a file operation (`ApplyOutcome` on the server, see
 * `sync-protocol.md`): the ack's `outcome`, stored with the operation's log
 * row, so a resend of the same `opId` gets it again. Read defensively — it
 * comes off the wire.
 */
export type OpOutcome =
  | {
      kind: 'created';
      fileId: string;
      path: string;
      contentHash?: string;
      size?: number;
      fileType?: 'TEXT' | 'BINARY';
      /** The server gave back a live file with the same non-empty content under the name. */
      merged?: true;
    }
  | {
      kind: 'conflict_create_renamed';
      fileId: string;
      originalPath: string;
      finalPath: string;
      contentHash?: string;
      size?: number;
      fileType?: 'TEXT' | 'BINARY';
    }
  | { kind: 'updated'; fileId: string; contentHash?: string; size?: number }
  | { kind: 'no_op'; reason: string; fileId?: string }
  | { kind: 'deleted'; fileId: string }
  | { kind: 'renamed'; fileId: string; from: string; to: string };

export interface YjsDocSnapshot {
  fileId: string;
  /** Yjs sync-step1 update encoded as a number array. */
  sync1: number[];
  /**
   * Server's `Y.encodeStateVector(doc)` so the client can compute the
   * inverse — `Y.encodeStateAsUpdate(localDoc, stateVector)` returns the
   * ops the server is missing, which the engine then pushes back via
   * `yjs:update`. Required for offline edits to make it upstream on
   * reconnect; without it the server's changed-detection silently no-ops
   * every subsequent live edit (parent structs missing).
   */
  stateVector?: number[];
}

/**
 * `operationsCatchup` of a `project:join`. The server gives every join the
 * operations the client's vector clock has not seen, from the whole journal,
 * and streams the text docs after its answer (`yjs:catchup`), whatever the
 * join says (see `sync-protocol.md`, «Подключение»): the engine checks each
 * operation against where files are now, and does not apply again what it
 * applied from a live broadcast. The join still says `operationsCatchup: 2`
 * and `streamYjs: true` — what the server read before 0.4.1 — so a server
 * rolled back to 0.4.0 answers it the same way, instead of the window of the
 * journal's first 500 rows and every doc of the vault built into one answer.
 */
export const OPERATIONS_CATCHUP = 2;

/**
 * The server keeps operations idempotent by `opId` and answers `ops:status`
 * when it says `opIdempotency` in the join ack; this client needs one that
 * does (see `SyncEngine`, `server_outdated`).
 */
export const OP_IDEMPOTENCY = 1;

/**
 * The refusal of a `project:join` the server could not answer: it failed to
 * read what the answer needs (its database, say). Unlike the other refusals
 * (`invalid_payload`, `project_not_found`, `user_not_found`, `forbidden`),
 * asking again may get the answer, on the same connection
 * (`sync-protocol.md`, «Подключение», «Отказ»). The server has taken the
 * socket out of the project's room: none of its broadcasts reaches this
 * device until a join is taken.
 */
export const JOIN_FAILED = 'join_failed';

export type JoinResult =
  | {
      ok: true;
      operations: ServerOperation[];
      /**
       * {@link OP_IDEMPOTENCY} from a server that keeps operations idempotent;
       * absent from an older one.
       */
      opIdempotency?: number;
      /**
       * The client had more unseen operations than one catch-up carries:
       * `operations` holds the newest of them, the older ones were left out.
       */
      operationsTruncated?: boolean;
      /**
       * The text docs follow the answer as `yjs:catchup` batches, the last
       * one `done`: at every join that does not skip them (`skipYjsCatchup`).
       */
      yjsStream?: boolean;
      /** Number of docs that will stream (for progress). */
      yjsCount?: number;
    }
  | { ok: false; error: string };

/** One streamed Yjs catch-up batch (`yjs:catchup`), mirrors the server. */
export interface YjsCatchupBatch {
  projectId: string;
  docs: YjsDocSnapshot[];
  /** True on the final batch — catch-up is complete. */
  done: boolean;
}

/**
 * Who made the change a file event reports: the `clientId` of the device
 * whose operation it was (`rest:<userId>` for a write through REST), and the
 * operation's `opId`. The server broadcasts an operation to the whole project
 * room, its sender included, and a client recognises its own by the `opId` of
 * an operation it has on its way. Absent from servers that predate them.
 */
export interface FileEventOrigin {
  clientId?: string;
  opId?: string;
}

export type FileEvent = FileEventOrigin &
  (
    | {
        type: 'created';
        result: unknown;
        log: ServerLogEntry;
        /** The file's id, where the server stored it and its type; absent from older servers. */
        fileId?: string;
        path?: string;
        fileType?: 'TEXT' | 'BINARY';
      }
    | { type: 'updated-binary'; fileId: string; contentHash: string; log: ServerLogEntry }
    | ({ type: 'deleted'; fileId: string; log: ServerLogEntry } & VanishedFolder)
    | ({
        type: 'renamed';
        fileId: string;
        /**
         * Where the server put the file. Servers that predate `clientId` sent
         * the path the client asked for, even when a collision made the
         * server store the file under a conflict name; `outcome` has that.
         */
        newPath: string;
        outcome: unknown;
        log: ServerLogEntry;
      } & VanishedFolder)
    | ({
        type: 'moved';
        fileId: string;
        newPath: string;
        outcome: unknown;
        log: ServerLogEntry;
      } & VanishedFolder)
  );

/**
 * `folder` of a delete, rename or move (`sync-protocol.md`, «Папки»): the
 * topmost folder that vanished on the author's device together with the
 * operation — the folder deleted or renamed there. Folders are not synced as
 * such, the server knows files only: without it, a folder a teammate deleted
 * or renamed stayed behind, empty, on every other device. A receiver removes
 * it only if nothing is left in it. Absent when the author deleted or moved
 * only the file, and from a server that does not keep it.
 */
export interface VanishedFolder {
  folder?: string;
}

export interface YjsUpdateMessage {
  fileId: string;
  /** Decoded Yjs binary update. */
  update: Uint8Array;
}

/**
 * `yjs:fetch` ack — one doc's full server state, same encoding as a catch-up
 * {@link YjsDocSnapshot}. `error: 'timeout'` is synthesized client-side when
 * the server does not answer in time.
 */
export type YjsFetchResult =
  | { ok: true; sync1: number[]; stateVector?: number[] }
  | { ok: false; error: string };

/** How long {@link SocketClient.fetchYjsDoc} waits for the ack. */
export const YJS_FETCH_TIMEOUT_MS = 15_000;

/**
 * `ops:status` ack: the operations of the ones asked about that the server
 * applied — with what it made of them, in the order it applied them — and the
 * ones it voided (it never applies them now). `error: 'timeout'` and
 * `'disconnected'` are synthesized client-side.
 */
export type OpsStatusResult =
  | { ok: true; applied: AppliedOperation[]; voided: string[] }
  | { ok: false; error: string };

/** One operation `ops:status` reports applied (see {@link OpsStatusResult}). */
export interface AppliedOperation {
  opId: string;
  opType: ServerOperation['opType'];
  /** The id of its log row. */
  logId: string;
  filePath: string;
  newPath: string | null;
  outcome: unknown;
  vectorClock: VectorClock;
  createdAt: string;
}

/** How long {@link SocketClient.opsStatus} waits for the ack. */
export const OPS_STATUS_TIMEOUT_MS = 15_000;

/** The most operations one `ops:status` asks about (the server refuses more). */
export const OPS_STATUS_MAX = 500;

/** The `clientId` and `opId` a file event carries, when they are non-empty strings. */
function originOf(data: object): FileEventOrigin {
  const { clientId, opId } = data as { clientId?: unknown; opId?: unknown };
  return {
    ...(typeof clientId === 'string' && clientId !== '' ? { clientId } : {}),
    ...(typeof opId === 'string' && opId !== '' ? { opId } : {}),
  };
}

/** `folder` of a file event (see {@link VanishedFolder}), when it is a non-empty string. */
function folderOf(data: object): VanishedFolder {
  const { folder } = data as { folder?: unknown };
  return typeof folder === 'string' && folder !== '' ? { folder } : {};
}

/** The top-level fields of `file:created` that say where the file went. */
function createdPlacement(data: object): {
  fileId?: string;
  path?: string;
  fileType?: 'TEXT' | 'BINARY';
} {
  const { fileId, path, fileType } = data as {
    fileId?: unknown;
    path?: unknown;
    fileType?: unknown;
  };
  return {
    ...(typeof fileId === 'string' && fileId !== '' ? { fileId } : {}),
    ...(typeof path === 'string' && path !== '' ? { path } : {}),
    ...(fileType === 'TEXT' || fileType === 'BINARY' ? { fileType } : {}),
  };
}

const OPERATION_TYPES: ReadonlySet<unknown> = new Set([
  'CREATE',
  'UPDATE',
  'DELETE',
  'RENAME',
  'MOVE',
]);

/** A row of `ops:status`'s `applied`, or `null` when it is not one. */
function toAppliedOperation(raw: unknown): AppliedOperation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const { opId, opType, logId, filePath, newPath, vectorClock, createdAt } = row;
  if (typeof opId !== 'string' || typeof filePath !== 'string') return null;
  if (!OPERATION_TYPES.has(opType)) return null;
  const clock: VectorClock = {};
  if (typeof vectorClock === 'object' && vectorClock !== null) {
    for (const [k, v] of Object.entries(vectorClock)) {
      if (typeof v === 'number' && Number.isFinite(v)) clock[k] = v;
    }
  }
  return {
    opId,
    opType: opType as ServerOperation['opType'],
    logId: typeof logId === 'string' ? logId : '',
    filePath,
    newPath: typeof newPath === 'string' ? newPath : null,
    outcome: row.outcome ?? null,
    vectorClock: clock,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
  };
}

// -- Outgoing payloads --------------------------------------------------------

interface BaseEnvelope {
  projectId: string;
  /** Stable per-device identifier — also used as the vector clock key. */
  clientId: string;
  /**
   * The device's clock, its own counter already moved on for this operation.
   * The server logs the operation with that counter one up
   * (`increment(vectorClock, clientId)`) and says so in the ack's `log`.
   */
  vectorClock?: VectorClock;
  /**
   * The operation's idempotency key (UUID v4, lower case): the same on every
   * try, so the server applies it at most once and answers a resend with the
   * outcome it gave (`duplicate: true`).
   */
  opId: string;
}

export interface FileCreatePayload extends BaseEnvelope {
  filePath: string;
  fileType: 'TEXT' | 'BINARY';
  mimeType?: string | null;
  contentHash: string;
  size: number;
  // Inline bytes (sent as number[] by `envelopeFor`). Present for TEXT (small);
  // omitted for BINARY, whose bytes are staged over REST and referenced by
  // hash — keeping multi-megabyte payloads off the socket. `envelopeFor` drops
  // the field entirely when this is undefined.
  data?: ArrayBuffer;
}

export interface FileUpdateBinaryPayload extends BaseEnvelope {
  fileId: string;
  contentHash: string;
  size: number;
  data?: ArrayBuffer;
}

/** `folder`: see {@link VanishedFolder} — a strict ancestor of `filePath`. */
export interface FileDeletePayload extends BaseEnvelope, VanishedFolder {
  fileId: string;
  filePath: string;
}

/**
 * `folder`: see {@link VanishedFolder} — a strict ancestor of `filePath`, and
 * never `newPath` nor one of its folders: the folder the file went to is there.
 */
export interface FileMovePayload extends BaseEnvelope, VanishedFolder {
  fileId: string;
  filePath: string;
  newPath: string;
}

export interface YjsEmitPayload {
  projectId: string;
  fileId: string;
  update: Uint8Array;
}

export type AckOk<T = unknown> = { ok: true } & T;
export type AckErr = { ok: false; error: string };
export type Ack<T = unknown> = AckOk<T> | AckErr;

/**
 * Ack of a file operation (`file:*`): what the server made of it and its log
 * row — the clock it logged the operation with. `duplicate`: the `opId` had
 * been applied already, and this is the answer it got then; nothing was
 * applied again. Fields come off the wire: `outcome` and `log` are read
 * defensively.
 */
export type FileAck = AckOk<{ outcome?: unknown; log?: ServerLogEntry; duplicate?: true }> | AckErr;

// -- DI seam for tests --------------------------------------------------------

export interface SocketLike {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): SocketLike;
  off(event: string, listener?: (...args: unknown[]) => void): SocketLike;
  emit(event: string, ...args: unknown[]): SocketLike;
  connect(): SocketLike;
  disconnect(): SocketLike;
}

export interface SocketFactoryOptions {
  auth: { apiKey: string };
  transports: string[];
  reconnection: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  randomizationFactor: number;
  /** Auto-connect on construction. We turn this off to control timing. */
  autoConnect: boolean;
}

export type SocketFactory = (url: string, options: SocketFactoryOptions) => SocketLike;

const defaultFactory: SocketFactory = (url, options) => ioFactory(url, options);

// -- Reconnect knobs ----------------------------------------------------------

export interface ReconnectStrategy {
  /** First reconnect delay in ms (default 1000). */
  initialDelayMs: number;
  /** Cap on reconnect delay (default 30 000). */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT: ReconnectStrategy = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
};

// -- Wrapper ------------------------------------------------------------------

export interface SocketClientOptions {
  server: Pick<ServerConfig, 'url' | 'apiKey'>;
  /** Used to label operations + as a vector clock key. */
  clientId: string;
  reconnect?: Partial<ReconnectStrategy>;
  /** Test seam — production code uses the default `socket.io-client` factory. */
  factory?: SocketFactory;
}

type EventCb<T = unknown> = (data: T) => void;

/** An emit waiting for its ack; see {@link SocketClient.emitWithAck}. */
interface PendingAck {
  reject(err: Error): void;
  /** Out on a connection: its ack is lost if that connection drops. */
  sent: boolean;
}

export class SocketClient {
  private readonly factory: SocketFactory;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly clientId: string;
  private readonly reconnect: ReconnectStrategy;

  private socket: SocketLike | null = null;

  // Listener registries (we hand back unsubscribe fns rather than expose the raw socket).
  private connectCbs = new Set<EventCb<void>>();
  private disconnectCbs = new Set<EventCb<string>>();
  private errorCbs = new Set<EventCb<Error>>();
  private fileEventCbs = new Set<EventCb<FileEvent>>();
  private yjsCbs = new Set<EventCb<YjsUpdateMessage>>();
  private yjsCatchupCbs = new Set<EventCb<YjsCatchupBatch>>();
  /** Emits waiting for their acks — see {@link emitWithAck}. */
  private readonly pendingAcks = new Set<PendingAck>();
  /** `yjs:fetch` requests waiting for their answer — see {@link fetchYjsDoc}. */
  private readonly pendingFetches = new Set<(result: YjsFetchResult) => void>();
  /** `ops:status` requests waiting for their answer — see {@link opsStatus}. */
  private readonly pendingStatuses = new Set<(result: OpsStatusResult) => void>();

  constructor(options: SocketClientOptions) {
    this.factory = options.factory ?? defaultFactory;
    this.url = options.server.url.replace(/\/+$/, '');
    this.apiKey = options.server.apiKey;
    this.clientId = options.clientId;
    this.reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  /** Stable per-device identifier. */
  getClientId(): string {
    return this.clientId;
  }

  isConnected(): boolean {
    return this.socket?.connected === true;
  }

  /**
   * Lazily build the underlying socket and trigger the connect handshake.
   * Idempotent — calling it again on a connected client is a no-op.
   */
  connect(): void {
    if (this.socket) {
      // Already constructed; ensure it's actually connected.
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    const socket = this.factory(this.url, {
      auth: { apiKey: this.apiKey },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: this.reconnect.initialDelayMs,
      reconnectionDelayMax: this.reconnect.maxDelayMs,
      // No jitter — the backoff is short enough that a stampeding-thunder
      // problem doesn't realistically happen for a single user's plugin.
      randomizationFactor: 0,
      autoConnect: false,
    });
    this.socket = socket;

    socket.on('connect', () => {
      // socket.io sends what was emitted while disconnected once it connects.
      for (const pending of this.pendingAcks) pending.sent = true;
      for (const cb of this.connectCbs) cb();
    });
    socket.on('disconnect', (reason: unknown) => {
      const r = typeof reason === 'string' ? reason : 'unknown';
      for (const cb of this.disconnectCbs) cb(r);
      this.failPendingAcks((pending) => pending.sent);
      // Asked on the connection that dropped: its answer never comes.
      this.settleStatuses({ ok: false, error: 'disconnected' });
    });
    socket.on('connect_error', (err: unknown) => {
      // socket.io hands over an Error; anything else keeps a readable message
      // instead of the "[object Object]" String() used to produce.
      const e =
        err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'connect_error');
      for (const cb of this.errorCbs) cb(e);
    });

    // File events — translate the per-event names into the union we expose.
    socket.on('file:created', (raw: unknown) => {
      const data = raw as { result: unknown; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'created',
        result: data.result,
        log: data.log,
        ...createdPlacement(data),
        ...originOf(data),
      });
    });
    socket.on('file:updated-binary', (raw: unknown) => {
      const data = raw as { fileId: string; contentHash: string; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'updated-binary',
        fileId: data.fileId,
        contentHash: data.contentHash,
        log: data.log,
        ...originOf(data),
      });
    });
    socket.on('file:deleted', (raw: unknown) => {
      const data = raw as { fileId: string; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'deleted',
        fileId: data.fileId,
        log: data.log,
        ...folderOf(data),
        ...originOf(data),
      });
    });
    socket.on('file:renamed', (raw: unknown) => {
      const data = raw as
        | { fileId: string; newPath: string; outcome: unknown; log: ServerLogEntry }
        | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'renamed',
        fileId: data.fileId,
        newPath: data.newPath,
        outcome: data.outcome,
        log: data.log,
        ...folderOf(data),
        ...originOf(data),
      });
    });
    socket.on('file:moved', (raw: unknown) => {
      const data = raw as
        | { fileId: string; newPath: string; outcome: unknown; log: ServerLogEntry }
        | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'moved',
        fileId: data.fileId,
        newPath: data.newPath,
        outcome: data.outcome,
        log: data.log,
        ...folderOf(data),
        ...originOf(data),
      });
    });

    // Yjs broadcast — server emits `yjs:update` (no separate name per direction).
    socket.on('yjs:update', (raw: unknown) => {
      const data = raw as { fileId: string; update: number[] } | undefined;
      if (!data || !Array.isArray(data.update)) return;
      this.fan(this.yjsCbs, {
        fileId: data.fileId,
        update: Uint8Array.from(data.update),
      });
    });

    // The text docs a `project:join` brings, streamed after its answer.
    socket.on('yjs:catchup', (raw: unknown) => {
      const data = raw as
        | { projectId?: string; docs?: YjsDocSnapshot[]; done?: boolean }
        | undefined;
      if (!data || typeof data.projectId !== 'string' || !Array.isArray(data.docs)) return;
      this.fan(this.yjsCatchupCbs, {
        projectId: data.projectId,
        docs: data.docs,
        done: data.done === true,
      });
    });

    socket.connect();
  }

  /**
   * Tear everything down. The instance is reusable — `connect()` rebuilds.
   * socket.io does not reconnect a socket closed this way: nothing goes out
   * until the next `connect()` (Pause sync and Resume sync rely on it).
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    // Nothing emitted on this socket is sent or answered any more.
    this.failPendingAcks(() => true);
    // Nor a `yjs:fetch`: answered now rather than by its timeout, which kept a
    // save of the note waiting and took the server for one without the event.
    for (const settle of [...this.pendingFetches]) {
      settle({ ok: false, error: 'disconnected' });
    }
    this.settleStatuses({ ok: false, error: 'disconnected' });
  }

  // -- Subscriptions --------------------------------------------------------

  onConnect(cb: () => void): () => void {
    this.connectCbs.add(cb);
    return () => this.connectCbs.delete(cb);
  }
  onDisconnect(cb: (reason: string) => void): () => void {
    this.disconnectCbs.add(cb);
    return () => this.disconnectCbs.delete(cb);
  }
  onError(cb: (err: Error) => void): () => void {
    this.errorCbs.add(cb);
    return () => this.errorCbs.delete(cb);
  }
  onFileEvent(cb: (event: FileEvent) => void): () => void {
    this.fileEventCbs.add(cb);
    return () => this.fileEventCbs.delete(cb);
  }
  onYjsUpdate(cb: (msg: YjsUpdateMessage) => void): () => void {
    this.yjsCbs.add(cb);
    return () => this.yjsCbs.delete(cb);
  }
  onYjsCatchup(cb: (batch: YjsCatchupBatch) => void): () => void {
    this.yjsCatchupCbs.add(cb);
    return () => this.yjsCatchupCbs.delete(cb);
  }

  // -- Outgoing emits -------------------------------------------------------

  /**
   * Join the project with its catch-up: the operations `sinceVectorClock` has
   * not seen in the answer, the text docs after it as `yjs:catchup` batches
   * (see {@link OPERATIONS_CATCHUP} for the flags it still sends).
   */
  joinProject(projectId: string, sinceVectorClock: VectorClock | null = null): Promise<JoinResult> {
    return this.emitWithAck<JoinResult>('project:join', {
      projectId,
      sinceVectorClock,
      streamYjs: true,
      operationsCatchup: OPERATIONS_CATCHUP,
    });
  }

  /**
   * A `project:join` that brings no catch-up (`skipOperations`,
   * `skipYjsCatchup`, as the web editor joins): only its answer — whether the
   * project is there for this user, and whether the server keeps operations
   * idempotent (`opIdempotency`). The socket is in the project's room after
   * it, as after any join: {@link leaveProject} takes it out.
   */
  probeProject(projectId: string): Promise<JoinResult> {
    return this.emitWithAck<JoinResult>('project:join', {
      projectId,
      sinceVectorClock: null,
      skipOperations: true,
      skipYjsCatchup: true,
    });
  }

  leaveProject(projectId: string): Promise<{ ok: true }> {
    return this.emitWithAck<{ ok: true }>('project:leave', { projectId });
  }

  emitFileCreate(payload: FileCreatePayload): Promise<FileAck> {
    return this.emitWithAck<FileAck>(
      'file:create',
      this.envelopeFor(payload, { data: payload.data }),
    );
  }

  emitFileUpdateBinary(payload: FileUpdateBinaryPayload): Promise<FileAck> {
    return this.emitWithAck<FileAck>(
      'file:update-binary',
      this.envelopeFor(payload, { data: payload.data }),
    );
  }

  emitFileDelete(payload: FileDeletePayload): Promise<FileAck> {
    return this.emitWithAck<FileAck>('file:delete', this.envelopeFor(payload, {}));
  }

  emitFileRename(payload: FileMovePayload): Promise<FileAck> {
    return this.emitWithAck<FileAck>('file:rename', this.envelopeFor(payload, {}));
  }

  emitFileMove(payload: FileMovePayload): Promise<FileAck> {
    return this.emitWithAck<FileAck>('file:move', this.envelopeFor(payload, {}));
  }

  /**
   * Ask the server what became of operations sent from here whose answers
   * never came (`ops:status`, at most {@link OPS_STATUS_MAX} at a time): the
   * ones it applied, and the ones it voids now — it never applies those, and
   * the client sends them again under new ids. The server answers once every
   * operation it received before the question is applied. Never rejects: no
   * socket, a server error, a lost connection (`disconnected`) and a missing
   * ack (`timeout`) all resolve to `ok: false`.
   */
  opsStatus(
    projectId: string,
    opIds: readonly string[],
    timeoutMs = OPS_STATUS_TIMEOUT_MS,
  ): Promise<OpsStatusResult> {
    return new Promise<OpsStatusResult>((resolve) => {
      if (!this.socket) {
        resolve({ ok: false, error: 'socket_not_connected' });
        return;
      }
      let timer: number | undefined;
      const settle = (result: OpsStatusResult): void => {
        if (!this.pendingStatuses.delete(settle)) return;
        window.clearTimeout(timer);
        resolve(result);
      };
      this.pendingStatuses.add(settle);
      timer = window.setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);
      this.socket.emit('ops:status', { projectId, opIds: [...opIds] }, (ack: unknown) =>
        settle(toOpsStatusResult(ack)),
      );
    });
  }

  emitYjsUpdate(payload: YjsEmitPayload): Promise<Ack<{ changed: boolean }>> {
    return this.emitWithAck<Ack<{ changed: boolean }>>('yjs:update', {
      projectId: payload.projectId,
      fileId: payload.fileId,
      update: Array.from(payload.update),
    });
  }

  /**
   * Pull one doc's full state (`yjs:fetch`, read-gated on the server). The
   * engine uses it to hydrate a single note on demand — one the catch-up
   * skipped because its disk copy already matched — instead of waiting for
   * the next `project:join`. Never rejects: no socket, a server error and a
   * missing ack all resolve to `ok: false`.
   */
  fetchYjsDoc(
    projectId: string,
    fileId: string,
    timeoutMs = YJS_FETCH_TIMEOUT_MS,
  ): Promise<YjsFetchResult> {
    return new Promise<YjsFetchResult>((resolve) => {
      if (!this.socket) {
        resolve({ ok: false, error: 'socket_not_connected' });
        return;
      }
      let timer: number | undefined;
      const settle = (result: YjsFetchResult): void => {
        if (!this.pendingFetches.delete(settle)) return;
        window.clearTimeout(timer);
        resolve(result);
      };
      this.pendingFetches.add(settle);
      timer = window.setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);
      this.socket.emit('yjs:fetch', { projectId, fileId }, (ack: YjsFetchResult) => settle(ack));
    });
  }

  // -- Internals ------------------------------------------------------------

  private envelopeFor<T extends BaseEnvelope & { data?: ArrayBuffer }>(
    raw: T,
    extras: { data?: ArrayBuffer | undefined },
  ): Record<string, unknown> {
    const envelope: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (extras.data !== undefined) {
      envelope.data = Array.from(new Uint8Array(extras.data));
    } else {
      delete envelope.data;
    }
    return envelope;
  }

  /**
   * Emit and resolve with the server's ack. Rejects with `disconnected` when
   * the connection the emit went out on drops before the ack came: the server
   * never answers it on the next one, and socket.io drops a plain ack callback
   * on disconnect without calling it. Waiting for it held the caller forever —
   * a note created and renamed right away was never renamed, and the drain of
   * the offline queue stopped for the session. What the server did with it is
   * unknown then: the caller queues the operation, and its replay is one the
   * server takes again.
   *
   * An emit made while disconnected is sent once the socket connects, and
   * waits for its ack from then on.
   */
  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('socket_not_connected'));
        return;
      }
      const pending: PendingAck = { reject, sent: this.socket.connected };
      this.pendingAcks.add(pending);
      this.socket.emit(event, payload, (ack: T) => {
        if (!this.pendingAcks.delete(pending)) return;
        resolve(ack);
      });
    });
  }

  /** Answer every `ops:status` still waiting with `result`. */
  private settleStatuses(result: OpsStatusResult): void {
    for (const settle of [...this.pendingStatuses]) settle(result);
  }

  /** Reject the acks {@link emitWithAck} waits for that `which` picks. */
  private failPendingAcks(which: (pending: PendingAck) => boolean): void {
    for (const pending of [...this.pendingAcks]) {
      if (!which(pending)) continue;
      this.pendingAcks.delete(pending);
      pending.reject(new Error('disconnected'));
    }
  }

  private fan<T>(set: Set<EventCb<T>>, value: T): void {
    for (const cb of set) {
      try {
        cb(value);
      } catch {
        // Listener errors must not propagate back into the socket — they'd
        // tear down the connection. We silently swallow; the engine logs
        // failures explicitly when it cares.
      }
    }
  }
}

/** The `ops:status` ack as {@link OpsStatusResult}; a malformed one is an error. */
function toOpsStatusResult(ack: unknown): OpsStatusResult {
  if (typeof ack !== 'object' || ack === null) return { ok: false, error: 'invalid_ack' };
  const raw = ack as { ok?: unknown; error?: unknown; applied?: unknown; voided?: unknown };
  if (raw.ok !== true) {
    return { ok: false, error: typeof raw.error === 'string' ? raw.error : 'invalid_ack' };
  }
  if (!Array.isArray(raw.applied) || !Array.isArray(raw.voided)) {
    return { ok: false, error: 'invalid_ack' };
  }
  const applied: AppliedOperation[] = [];
  for (const row of raw.applied as unknown[]) {
    const parsed = toAppliedOperation(row);
    if (parsed) applied.push(parsed);
  }
  const voided = (raw.voided as unknown[]).filter((id): id is string => typeof id === 'string');
  return { ok: true, applied, voided };
}
