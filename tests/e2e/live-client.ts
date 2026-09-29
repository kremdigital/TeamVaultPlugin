/**
 * A device of the end-to-end suite: the plugin's `SyncEngine` with real REST
 * and Socket.IO clients against the sync stand, on an in-memory vault.
 *
 * What is real: the engine, its operation log on a `state.json` (written with
 * the plugin's 500 ms debounce), its docs over an IndexedDB stand-in that
 * survives a restart, the `ObsidianWatcher` its renames go through, the
 * socket.io client, the server. What stands in: the disk ({@link MemoryVault}),
 * the network ({@link NetSwitch}) and the socket's emits ({@link ChaosSockets}).
 *
 * The user acts as in Obsidian: a change lands on disk and its event goes to
 * the engine, and the next action does not wait for the plugin to handle it.
 * A scenario waits for a state ({@link LiveClient.settled}, `eventually`).
 */
import { ApiClient, type BinaryRequestFn, type RequestFn } from '@/client/api';
import { SocketClient } from '@/client/socket';
import type { DocManager } from '@/crdt/doc-manager';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { ConflictResolver } from '@/sync/conflict';
import { SyncEngine, type EngineStatus } from '@/sync/engine';
import type { OperationLog, PendingOperation } from '@/sync/operation-log';
import { Logger, formatLogEntry, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import { RecentlyApplied } from '@/watcher/recently-applied';
import {
  FakeIndexedDb,
  FakeStorage,
  MemoryVault,
  encode,
  logOn,
  watchVault,
  type EchoRoute,
} from '../engine-test-kit';
import { ChaosSockets, NetSwitch } from './chaos';
import { eventually, type EventuallyOptions } from './eventually';
import type { Stand } from './stand';

/** The binding every live client syncs: the whole vault, to the scenario's project. */
const BINDING_ID = 'b1';

/** The status detail while new changes wait behind ones the server refused `busy`. */
export const SERVER_BUSY = 'server_busy';

/** What the engine logs once it checked its queue with the server (`settleUnanswered`). */
const QUEUE_CHECKED = 'queued operations checked with the server';

/** Set to print every client's log to stderr as it goes. */
const TRACE = process.env.TV_E2E_TRACE === '1';

export interface LiveClientOptions {
  stand: Stand;
  projectId: string;
  apiKey: string;
  /** The device's client id; two devices of one user share the API key, not this. */
  clientId: string;
  /** `SyncEngineDeps.queueRetryMs`: short by default, the plugin's are 2 to 30 s. */
  queueRetryMs?: readonly number[];
  /** `SyncEngineDeps.diskSnapshotDebounceMs`: the plugin's 500 ms by default. */
  diskSnapshotDebounceMs?: number;
}

/** A REST call without the network fails as `fetch` does. */
function offlineError(): TypeError {
  return new TypeError('fetch failed');
}

/** Headers of a `fetch` response, as `requestUrl` gives them. */
function headersOf(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export class LiveClient {
  readonly vault = new MemoryVault();
  /** The device's IndexedDB: kept across a restart of the process. */
  readonly idb = new FakeIndexedDb();
  readonly echo = new RecentlyApplied();
  readonly chaos = new ChaosSockets();
  /** Everything the engines of this device logged, in order. */
  readonly entries: LogEntry[] = [];
  /** Conflict questions the engine asked the user (answered with the defaults). */
  readonly questions: string[] = [];
  /** Client ids another device turned out to use (`onTwinDetected`). */
  readonly twins: string[] = [];
  readonly binding: VaultBinding;
  readonly route: EchoRoute;
  /** The disk under `state.json`. A restart goes on with a copy (see {@link crashRestart}). */
  storage = new FakeStorage();
  log!: OperationLog;
  docs!: DocManager;
  engine!: SyncEngine;
  status: EngineStatus = 'stopped';
  detail: string | undefined;

  private constructor(
    readonly name: string,
    readonly opts: LiveClientOptions,
    readonly net: NetSwitch,
  ) {
    this.binding = {
      id: BINDING_ID,
      serverId: 's1',
      projectId: opts.projectId,
      projectName: 'E2E',
      localFolder: '/',
      enabled: true,
      lastSyncedAt: 0,
      lastVectorClock: {},
    };
    this.route = watchVault(this.vault, this.echo, this.binding);
  }

  /** A device named `name` (in logs and messages), its engine built, not started. */
  static async open(name: string, opts: LiveClientOptions): Promise<LiveClient> {
    const client = new LiveClient(name, opts, await NetSwitch.open(opts.stand.port));
    await client.build();
    return client;
  }

  get clientId(): string {
    return this.opts.clientId;
  }

  // -- Lifecycle ----------------------------------------------------------------------

  async start(): Promise<void> {
    await this.engine.start();
  }

  /**
   * Until the device has nothing left to do: connected with no change
   * waiting behind a refused one, no vault event being handled, nothing in the
   * queue or on its way.
   */
  async settled(opts?: EventuallyOptions): Promise<void> {
    await eventually(() => {
      if (!this.isSettled()) throw new Error(`${this.name} not settled: ${this.describe()}`);
    }, opts);
  }

  /**
   * Until the engine has handled every vault event so far — what a user who
   * waits a moment between two actions leaves it (a note created, then
   * renamed once its title is typed).
   */
  async handled(): Promise<void> {
    await eventually(() => {
      if (this.route.inflight.size > 0) throw new Error(`${this.name}: ${this.describe()}`);
    });
  }

  isSettled(): boolean {
    return (
      this.status === 'connected' &&
      this.detail !== SERVER_BUSY &&
      this.route.inflight.size === 0 &&
      this.queue().length === 0 &&
      this.inFlight().length === 0
    );
  }

  pause(): void {
    this.engine.pause();
  }

  async resume(): Promise<void> {
    await this.engine.resume();
  }

  /**
   * The process dies now, and Obsidian starts again: the next start finds the
   * vault and `state.json` as they are on disk at this moment, not what the
   * process held — a new operation log from that disk, new docs over the same
   * IndexedDB, a new socket. The old sockets drop and stay down; the old
   * engine is stopped only so that it does nothing more (what it writes goes to
   * the old disk, which nobody reads). Then the new engine starts.
   */
  async crashRestart(): Promise<void> {
    const disk = this.storage.snapshot();
    this.chaos.killAll();
    await this.engine.stop();
    this.storage = disk;
    await this.build();
    await this.start();
  }

  async close(): Promise<void> {
    this.chaos.killAll();
    await this.engine.stop();
    await this.net.close();
  }

  // -- The user, in Obsidian -------------------------------------------------------------

  /** Save note `path` with `text`: created if it is new. */
  write(path: string, text: string): void {
    this.put(path, encode(text));
  }

  /** Save attachment `path` with `bytes`. */
  writeBinary(path: string, bytes: Uint8Array): void {
    this.put(path, bytes.slice().buffer);
  }

  /** Rename or move file `from` to `to`: its `rename` event goes through the watcher. */
  async rename(from: string, to: string): Promise<void> {
    await this.vault.rename(from, to);
  }

  /** Delete file `path`. */
  remove(path: string): void {
    this.vault.files.delete(path);
    this.dispatch({ bindingId: BINDING_ID, type: 'delete', path, source: 'obsidian' });
  }

  /**
   * Delete folder `path` with what is in it. Everything goes from disk first,
   * then Obsidian reports each file and folder in it — a folder before what is
   * in it — and the folder itself last (`reconcileDeletion`, app.js 1.13.7),
   * one after another, none waiting for the plugin.
   */
  removeFolder(path: string): void {
    const events: VaultEvent[] = [];
    const walk = (folder: string): void => {
      const inside = (p: string): boolean =>
        p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/');
      for (const file of [...this.vault.files.keys()].filter(inside).sort()) {
        events.push({ bindingId: BINDING_ID, type: 'delete', path: file, source: 'obsidian' });
      }
      for (const sub of [...this.vault.folders].filter(inside).sort()) {
        events.push({
          bindingId: BINDING_ID,
          type: 'delete',
          path: sub,
          source: 'obsidian',
          isFolder: true,
        });
        walk(sub);
      }
    };
    walk(path);
    events.push({
      bindingId: BINDING_ID,
      type: 'delete',
      path,
      source: 'obsidian',
      isFolder: true,
    });
    this.vault.removeFolder(path);
    for (const event of events) this.dispatch(event);
  }

  // -- What the device holds ---------------------------------------------------------------

  /** The note's text on disk; `null` when there is no such file. */
  text(path: string): string | null {
    return this.vault.text(path);
  }

  bytes(path: string): Uint8Array | null {
    const buf = this.vault.files.get(path);
    return buf === undefined ? null : new Uint8Array(buf);
  }

  /** The files on disk, sorted. */
  paths(): string[] {
    return [...this.vault.files.keys()].sort();
  }

  /** The offline queue. */
  queue(): PendingOperation[] {
    return this.log.dequeueOperations(BINDING_ID);
  }

  /** Operations sent and not answered yet. */
  inFlight(): PendingOperation[] {
    return this.log.inFlightOperations(BINDING_ID);
  }

  /** The entries logged with `message`, in order. */
  logged(message: string): LogEntry[] {
    return this.entries.filter((e) => e.message === message);
  }

  /**
   * What each check of the queue with the server (`ops:status` at a connect)
   * found, in order: `{ asked, applied, voided }`. A scenario takes the ones
   * after a mark: `queueChecks().slice(before)`.
   */
  queueChecks(): unknown[] {
    return this.logged(QUEUE_CHECKED).map((e) => e.args[0]);
  }

  describe(): string {
    const queue = this.queue().map((op) => `${op.opType} ${op.filePath}`);
    const flight = this.inFlight().map((op) => `${op.opType} ${op.filePath}`);
    return (
      `status ${this.status}${this.detail ? ` (${this.detail})` : ''}, ` +
      `${this.route.inflight.size} event(s) handled, queue [${queue.join(', ')}], ` +
      `in flight [${flight.join(', ')}]`
    );
  }

  // -- Internals -------------------------------------------------------------------

  private put(path: string, content: ArrayBuffer): void {
    const existed = this.vault.files.has(path);
    this.vault.files.set(path, content);
    this.dispatch({
      bindingId: BINDING_ID,
      type: existed ? 'modify' : 'create',
      path,
      source: 'obsidian',
    });
  }

  /** Hand `event` to the engine as the watcher does: not awaited, its handler tracked. */
  private dispatch(event: VaultEvent): void {
    const engine = this.route.engine;
    if (!engine) return;
    const run = engine.handleVaultEvent(event).catch((err: unknown) => {
      this.route.errors.push(err);
    });
    this.route.inflight.add(run);
    void run.finally(() => this.route.inflight.delete(run));
  }

  /** A new engine over this device's disk (see {@link crashRestart}). */
  private async build(): Promise<void> {
    const { stand, apiKey, clientId } = this.opts;
    this.log = await logOn(this.storage, 500);
    this.docs = this.idb.manager();
    const server: ServerConfig = { id: 's1', name: 'E2E', url: stand.url, apiKey, addedAt: 0 };
    const logger = new Logger('debug', {
      write: (entry) => {
        this.entries.push(entry);
        if (TRACE) process.stderr.write(`[${this.name}] ${formatLogEntry(entry)}\n`);
      },
    });
    const resolver: ConflictResolver = {
      resolveBinaryConflict: (context) => {
        this.questions.push(`binary ${context.filePath}`);
        return Promise.resolve('keep-server');
      },
      resolveDeleteConflict: (context) => {
        this.questions.push(`delete ${context.filePath}`);
        return Promise.resolve('delete-local');
      },
    };
    const socket = new SocketClient({
      server: { url: this.net.url, apiKey },
      clientId,
      reconnect: { initialDelayMs: 50, maxDelayMs: 300 },
      factory: this.chaos.factory,
    });
    const engine = new SyncEngine({
      binding: this.binding,
      server,
      clientId,
      onTwinDetected: (id) => this.twins.push(id),
      vault: this.vault,
      operationLog: this.log,
      docManager: this.docs,
      recentlyApplied: this.echo,
      apiClient: new ApiClient(server, this.requestFn, this.binaryRequestFn),
      socketClient: socket,
      conflictResolver: resolver,
      logger,
      opsStatusRetryMs: [200, 500, 1000],
      opsStatusTimeoutMs: 5000,
      queueRetryMs: this.opts.queueRetryMs ?? [300, 600, 1200],
      ...(this.opts.diskSnapshotDebounceMs !== undefined
        ? { diskSnapshotDebounceMs: this.opts.diskSnapshotDebounceMs }
        : {}),
    });
    engine.onStatus((status, detail) => {
      if (this.engine !== engine) return;
      this.status = status;
      this.detail = detail;
    });
    this.engine = engine;
    this.status = engine.getStatus();
    this.detail = undefined;
    this.route.engine = engine;
  }

  /** JSON calls: `requestUrl` in the plugin, `fetch` here — offline, they fail. */
  private readonly requestFn: RequestFn = async (params) => {
    if (this.net.isOffline) throw offlineError();
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    if (params.contentType !== undefined) headers['content-type'] = params.contentType;
    const res = await fetch(params.url, {
      method: params.method ?? 'GET',
      headers,
      ...(params.body !== undefined ? { body: params.body } : {}),
    });
    const arrayBuffer = await res.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Binary or empty.
    }
    return { status: res.status, json, arrayBuffer, headers: headersOf(res), text };
  };

  /** Binary transfers: `fetch`, as in the plugin; offline, they fail. */
  private readonly binaryRequestFn: BinaryRequestFn = async (params) => {
    if (this.net.isOffline) throw offlineError();
    const res = await fetch(params.url, {
      method: params.method,
      headers: params.headers,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    const arrayBuffer = await res.arrayBuffer();
    let json: unknown = null;
    let text = '';
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      text = new TextDecoder().decode(arrayBuffer);
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, arrayBuffer, headers: headersOf(res), text };
  };
}
