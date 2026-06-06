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
  vectorClock: VectorClock;
  payload: unknown;
  /** Wire format from the server is a Date string, not a Date object. */
  createdAt: string;
}

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

export type JoinResult =
  | {
      ok: true;
      operations: ServerOperation[];
      /** Inline catch-up (legacy / non-streaming servers). */
      yjsDocs?: YjsDocSnapshot[];
      /** Set when the server is streaming the catch-up via `yjs:catchup`. */
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

export type FileEvent =
  | { type: 'created'; result: unknown; log: ServerLogEntry }
  | { type: 'updated-binary'; fileId: string; contentHash: string; log: ServerLogEntry }
  | { type: 'deleted'; fileId: string; log: ServerLogEntry }
  | {
      type: 'renamed';
      fileId: string;
      newPath: string;
      outcome: unknown;
      log: ServerLogEntry;
    }
  | {
      type: 'moved';
      fileId: string;
      newPath: string;
      outcome: unknown;
      log: ServerLogEntry;
    };

export interface YjsUpdateMessage {
  fileId: string;
  /** Decoded Yjs binary update. */
  update: Uint8Array;
}

// -- Outgoing payloads --------------------------------------------------------

interface BaseEnvelope {
  projectId: string;
  /** Stable per-device identifier — also used as the vector clock key. */
  clientId: string;
  /** The pre-bump clock; the server bumps `clientId`'s counter itself. */
  vectorClock?: VectorClock;
}

export interface FileCreatePayload extends BaseEnvelope {
  filePath: string;
  fileType: 'TEXT' | 'BINARY';
  mimeType?: string | null;
  contentHash: string;
  size: number;
  data: ArrayBuffer;
}

export interface FileUpdateBinaryPayload extends BaseEnvelope {
  fileId: string;
  contentHash: string;
  size: number;
  data: ArrayBuffer;
}

export interface FileDeletePayload extends BaseEnvelope {
  fileId: string;
  filePath: string;
}

export interface FileMovePayload extends BaseEnvelope {
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

const defaultFactory: SocketFactory = (url, options) =>
  ioFactory(url, options) as unknown as SocketLike;

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
      for (const cb of this.connectCbs) cb();
    });
    socket.on('disconnect', (reason: unknown) => {
      const r = typeof reason === 'string' ? reason : 'unknown';
      for (const cb of this.disconnectCbs) cb(r);
    });
    socket.on('connect_error', (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err ?? 'connect_error'));
      for (const cb of this.errorCbs) cb(e);
    });

    // File events — translate the per-event names into the union we expose.
    socket.on('file:created', (raw: unknown) => {
      const data = raw as { result: unknown; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, { type: 'created', result: data.result, log: data.log });
    });
    socket.on('file:updated-binary', (raw: unknown) => {
      const data = raw as { fileId: string; contentHash: string; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, {
        type: 'updated-binary',
        fileId: data.fileId,
        contentHash: data.contentHash,
        log: data.log,
      });
    });
    socket.on('file:deleted', (raw: unknown) => {
      const data = raw as { fileId: string; log: ServerLogEntry } | undefined;
      if (!data) return;
      this.fan(this.fileEventCbs, { type: 'deleted', fileId: data.fileId, log: data.log });
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

    // Streamed Yjs catch-up after a `project:join` with `streamYjs: true`.
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

  /** Tear everything down. The instance is reusable — `connect()` rebuilds. */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
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

  joinProject(
    projectId: string,
    sinceVectorClock: VectorClock | null = null,
    streamYjs = false,
  ): Promise<JoinResult> {
    return this.emitWithAck<JoinResult>('project:join', {
      projectId,
      sinceVectorClock,
      streamYjs,
    });
  }

  leaveProject(projectId: string): Promise<{ ok: true }> {
    return this.emitWithAck<{ ok: true }>('project:leave', { projectId });
  }

  emitFileCreate(payload: FileCreatePayload): Promise<Ack> {
    return this.emitWithAck<Ack>('file:create', this.envelopeFor(payload, { data: payload.data }));
  }

  emitFileUpdateBinary(payload: FileUpdateBinaryPayload): Promise<Ack> {
    return this.emitWithAck<Ack>(
      'file:update-binary',
      this.envelopeFor(payload, { data: payload.data }),
    );
  }

  emitFileDelete(payload: FileDeletePayload): Promise<Ack> {
    return this.emitWithAck<Ack>('file:delete', this.envelopeFor(payload, {}));
  }

  emitFileRename(payload: FileMovePayload): Promise<Ack> {
    return this.emitWithAck<Ack>('file:rename', this.envelopeFor(payload, {}));
  }

  emitFileMove(payload: FileMovePayload): Promise<Ack> {
    return this.emitWithAck<Ack>('file:move', this.envelopeFor(payload, {}));
  }

  emitYjsUpdate(payload: YjsEmitPayload): Promise<Ack<{ changed: boolean }>> {
    return this.emitWithAck<Ack<{ changed: boolean }>>('yjs:update', {
      projectId: payload.projectId,
      fileId: payload.fileId,
      update: Array.from(payload.update),
    });
  }

  // -- Internals ------------------------------------------------------------

  private envelopeFor<T extends BaseEnvelope & { data?: ArrayBuffer }>(
    raw: T,
    extras: { data?: ArrayBuffer },
  ): Record<string, unknown> {
    const envelope: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (extras.data !== undefined) {
      envelope.data = Array.from(new Uint8Array(extras.data));
    } else {
      delete envelope.data;
    }
    return envelope;
  }

  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('socket_not_connected'));
        return;
      }
      this.socket.emit(event, payload, (ack: T) => resolve(ack));
    });
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
