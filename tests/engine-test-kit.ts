/**
 * Test bench for `SyncEngine`: an in-memory vault whose calls can be held, a
 * Socket.IO stand-in whose acks the test answers, REST routes read at request
 * time, and a record of every call the engine makes into its dependencies.
 *
 * The same bench as in `engine-stop.test.ts`, shared by the suites written
 * after it. `buildHarness(predecessor)` builds the engine the `EngineManager`
 * spawns after a pause: a fresh one on the same vault, log, docs and echo set.
 *
 * Three things real Obsidian and the real server do are part of the bench,
 * because tests that left them out passed on code that looped in production:
 *
 *   - Obsidian's echo. Every `adapter.rename` — the plugin's own included —
 *     comes back as a vault `rename` event, fired inside the call before its
 *     promise resolves (app.js 1.13.7: `FileSystemAdapter.rename` triggers
 *     `renamed`, `Vault.onChange` turns it into `rename`). `MemoryVault.rename`
 *     does the same, and the event goes through a real `ObsidianWatcher` to
 *     the engine, the way `main.ts` wires them. A user's rename in Obsidian is
 *     that same call ({@link userRename}); a file moved while Obsidian was
 *     closed is {@link MemoryVault.move}.
 *   - The server's broadcasts. The server sends every file operation to the
 *     whole project room, the sender included, right before its ack. The
 *     {@link FakeServer} does that, in the current format (the sender's
 *     `clientId`, the path the file was stored at) or the old one.
 *   - A start without network. `offline: true` builds an engine whose socket
 *     cannot connect until {@link goOnline}.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { SyncEngine, type EngineStatus } from '@/sync/engine';
import { OperationLog } from '@/sync/operation-log';
import {
  DocManager,
  type DocPersistence,
  type IdbRegistry,
  type PersistenceFactory,
} from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import {
  ObsidianWatcher,
  type VaultEvent,
  type WatchableFile,
  type WatchableVault,
} from '@/watcher/obsidian-events';
import { ApiClient, type RequestUrlResponse } from '@/client/api';
import type { ApiFile } from '@/client/types';
import {
  SocketClient,
  type ServerOperation,
  type SocketFactory,
  type SocketLike,
  type YjsDocSnapshot,
} from '@/client/socket';
import type {
  ConflictResolver,
  BinaryConflictResolution,
  DeleteConflictResolution,
} from '@/sync/conflict';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import type { Logger } from '@/utils/logger';

// -- Test doubles ---------------------------------------------------------------

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Record every method call made on `target` as `<label>.<method>`. */
function track<T extends object>(target: T, label: string, calls: string[]): T {
  return new Proxy(target, {
    get(obj, prop): unknown {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        calls.push(`${label}.${String(prop)}`);
        return method.apply(obj, args);
      };
    },
  });
}

export const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** A vault call held back until the test lets it through. */
export interface Gate {
  /** Resolves once the held call has started. */
  reached: Promise<void>;
  release(): void;
}

type RenameListener = (file: WatchableFile, oldPath: string) => void;

export class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
  private readonly renameListeners = new Set<RenameListener>();
  /**
   * The slice of `app.vault` an `ObsidianWatcher` listens on. Only `rename`
   * fires: the echo the engine has to tell from a user's rename. The engine's
   * writes and deletes are not echoed here — tests dispatch the events they
   * need.
   */
  readonly watchable = {
    on: (name: string, cb: RenameListener): unknown => {
      if (name === 'rename') this.renameListeners.add(cb);
      return cb;
    },
    offref: (ref: unknown): void => {
      this.renameListeners.delete(ref as RenameListener);
    },
  } as unknown as WatchableVault;
  private gates: Array<{
    method: string;
    skip: number;
    reached: () => void;
    open: Promise<void>;
  }> = [];

  /** Hold the next call of `method` (after `skip` calls) at its start. */
  gate(method: string, skip = 0): Gate {
    let release!: () => void;
    let reached!: () => void;
    const open = new Promise<void>((r) => {
      release = r;
    });
    const hit = new Promise<void>((r) => {
      reached = r;
    });
    this.gates.push({ method, skip, reached, open });
    return { reached: hit, release };
  }

  private async pass(method: string): Promise<void> {
    const gate = this.gates.find((g) => g.method === method);
    if (!gate) return;
    if (gate.skip > 0) {
      gate.skip -= 1;
      return;
    }
    this.gates.splice(this.gates.indexOf(gate), 1);
    gate.reached();
    await gate.open;
  }

  getBasePath(): string {
    return '/vault';
  }
  async exists(path: string): Promise<boolean> {
    await this.pass('exists');
    return this.files.has(path);
  }
  async readText(path: string): Promise<string> {
    await this.pass('readText');
    return new TextDecoder().decode(this.expect(path));
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    await this.pass('readBinary');
    return this.expect(path);
  }
  async createText(path: string, content: string): Promise<void> {
    await this.pass('createText');
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, encode(content));
  }
  async writeText(path: string, content: string): Promise<void> {
    await this.pass('writeText');
    this.files.set(path, encode(content));
  }
  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.pass('createBinary');
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, content);
  }
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.pass('writeBinary');
    this.files.set(path, content);
  }
  async delete(path: string): Promise<void> {
    await this.pass('delete');
    this.files.delete(path);
  }
  /**
   * `adapter.rename`, as Obsidian runs it: the file moves, then the vault
   * `rename` event fires — inside the call, before the promise resolves.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.pass('rename');
    this.move(oldPath, newPath);
    for (const cb of [...this.renameListeners]) cb({ path: newPath, kind: 'file' }, oldPath);
  }
  /** Move a file on disk without Obsidian seeing it: done while it was closed. */
  move(oldPath: string, newPath: string): void {
    const buf = this.expect(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, buf);
  }
  async ensureParentFolder(): Promise<void> {
    // No folders in memory.
    await this.pass('ensureParentFolder');
  }
  async list(folderPath: string): Promise<string[]> {
    const folder = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const paths = [...this.files.keys()];
    if (folder === '') return paths;
    return paths.filter((p) => p === folder || p.startsWith(`${folder}/`));
  }
  text(path: string): string | null {
    const buf = this.files.get(path);
    return buf ? new TextDecoder().decode(buf) : null;
  }
  private expect(path: string): ArrayBuffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`missing file ${path}`);
    return buf;
  }
}

/** A database of Obsidian's own, listed next to the plugin's (see {@link FakeIndexedDb}). */
export const FOREIGN_DB = 'obsidian-vault-cache';

/**
 * y-indexeddb stand-in: one database per name, kept across releases and
 * restarts (a new `DocManager` on the same instance). Like the real one, a
 * store loads asynchronously and applies what it holds with itself as the
 * origin, stores the doc's own state when it opens (an update the doc got
 * before is kept, one it gets in between is not written twice), keeps a small
 * key/value area, and `clearData` deletes the database.
 * The registry lists and deletes databases by name, as the renderer's
 * `indexedDB` does for every vault on the machine.
 *
 * It starts with one database that is not the plugin's ({@link FOREIGN_DB}),
 * as Obsidian's origin always has: an empty listing is what a runtime that
 * cannot list databases returns, and `DocManager` then opens a store under
 * every name it checks — a path Obsidian never takes.
 */
export class FakeIndexedDb {
  readonly dbs = new Map<string, { updates: Uint8Array[]; custom: Map<string, unknown> }>([
    [FOREIGN_DB, { updates: [], custom: new Map() }],
  ]);
  /** Every database deleted, in order. */
  readonly deleted: string[] = [];
  readonly registry: IdbRegistry = {
    list: () => Promise.resolve([...this.dbs.keys()]),
    delete: (name) => {
      if (this.dbs.delete(name)) this.deleted.push(name);
      return Promise.resolve();
    },
  };
  readonly factory: PersistenceFactory = (name, doc) => this.open(name, doc);

  /** A fresh `DocManager` on these databases — what a restart of Obsidian builds. */
  manager(): DocManager {
    return new DocManager({ persistenceFactory: this.factory, idb: this.registry });
  }

  /** The text a database holds, as a doc loaded from it would show it. */
  textOf(name: string): string | null {
    const db = this.dbs.get(name);
    if (!db) return null;
    const doc = new Y.Doc();
    for (const u of db.updates) Y.applyUpdate(doc, u);
    const text = doc.getText('content').toJSON();
    doc.destroy();
    return text;
  }

  private open(name: string, doc: Y.Doc): DocPersistence {
    let db = this.dbs.get(name);
    if (!db) {
      db = { updates: [], custom: new Map() };
      this.dbs.set(name, db);
    }
    const store = db;
    let destroyed = false;
    let opened = false;
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (!destroyed && opened && origin !== persistence) store.updates.push(update);
    };
    const persistence: DocPersistence = {
      whenSynced: Promise.resolve().then(() => {
        if (destroyed) return;
        // What the doc got before its database opened is stored now, as
        // y-indexeddb does (`beforeApplyUpdatesCallback`): its update listener
        // writes nothing until then.
        opened = true;
        if (doc.store.clients.size > 0) store.updates.push(Y.encodeStateAsUpdate(doc));
        Y.transact(
          doc,
          () => {
            for (const u of store.updates) Y.applyUpdate(doc, u);
          },
          persistence,
          false,
        );
      }),
      destroy: () => {
        destroyed = true;
        doc.off('update', onUpdate);
      },
      clearData: () => {
        destroyed = true;
        doc.off('update', onUpdate);
        if (this.dbs.get(name) === store) {
          this.dbs.delete(name);
          this.deleted.push(name);
        }
      },
      get: (key) => Promise.resolve(store.custom.get(key)),
      set: (key, value) => {
        store.custom.set(key, value);
        return Promise.resolve();
      },
    };
    doc.on('update', onUpdate);
    return persistence;
  }
}

/** The database name `DocManager` gives the doc of `path` in binding `b1`. */
export function dbNameOf(path: string): string {
  return `team-vault-b1-${encodeURIComponent(path)}`;
}

export interface Emit {
  event: string;
  payload: unknown;
  ack: (response: unknown) => void;
}

/** Socket.IO stand-in: emits wait for the test to answer them. */
export class FakeSocket implements SocketLike {
  connected = false;
  /** `false` while there is no network: `connect()` fails until {@link goOnline}. */
  reachable = true;
  /** A connect was asked for while unreachable; {@link goOnline} completes it. */
  private wantsConnect = false;
  emits: Emit[] = [];
  /** `yjs:fetch` requests, answered by the test through `answer`. */
  fetches: Array<{ fileId: string; answer: (response: unknown) => void }> = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, cb: (...args: unknown[]) => void): SocketLike {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(cb);
    return this;
  }
  off(event: string, cb?: (...args: unknown[]) => void): SocketLike {
    if (!cb) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]): SocketLike {
    const ack = args[args.length - 1] as (response: unknown) => void;
    if (event === 'yjs:fetch') {
      this.fetches.push({ fileId: (args[0] as { fileId: string }).fileId, answer: ack });
    } else {
      this.emits.push({ event, payload: args[0], ack });
    }
    return this;
  }
  connect(): SocketLike {
    if (!this.reachable) {
      // What socket.io reports without network; it keeps retrying.
      this.wantsConnect = true;
      this.fire('connect_error', new Error('websocket error'));
      return this;
    }
    this.connected = true;
    this.fire('connect');
    return this;
  }
  /** The network is back: a connect asked for meanwhile goes through. */
  goOnline(): void {
    this.reachable = true;
    if (!this.wantsConnect) return;
    this.wantsConnect = false;
    this.connect();
  }
  disconnect(): SocketLike {
    this.connected = false;
    this.fire('disconnect', 'io client disconnect');
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  /** The latest emit of `event` (optionally for one file path). */
  pending(event: string, filePath?: string): Emit {
    const match = [...this.emits]
      .reverse()
      .find(
        (e) =>
          e.event === event &&
          (filePath === undefined || (e.payload as { filePath?: string }).filePath === filePath),
      );
    if (!match) throw new Error(`no ${event} emit${filePath ? ` for ${filePath}` : ''}`);
    return match;
  }
  /** Paths of every `file:create` sent so far. */
  created(): string[] {
    return this.emits
      .filter((e) => e.event === 'file:create')
      .map((e) => (e.payload as { filePath: string }).filePath);
  }
}

// -- Harness --------------------------------------------------------------------

export const server: ServerConfig = {
  id: 's1',
  name: 'Local',
  url: 'https://sync.example.com',
  apiKey: 'osk_test',
  addedAt: 0,
};

const binding: VaultBinding = {
  id: 'b1',
  serverId: 's1',
  projectId: 'p1',
  projectName: 'Test',
  localFolder: '/',
  enabled: true,
  lastSyncedAt: 0,
  lastVectorClock: {},
};

type Responder = () => RequestUrlResponse | Promise<RequestUrlResponse>;

export interface Request {
  method: string;
  path: string;
}

/**
 * The one `ObsidianWatcher` on a vault, as the plugin has one for all its
 * engines: shared by an engine and the ones built after it, it hands every
 * event to the newest.
 */
export interface EchoRoute {
  engine: SyncEngine | null;
  binding: VaultBinding;
  /** Handlers still running for events the watcher dispatched. */
  inflight: Set<Promise<void>>;
  /** What those handlers threw: in the plugin, an unhandled rejection. */
  errors: unknown[];
  /** The {@link FakeServer} answering this vault's engines, if any. */
  server: { serveNext(): boolean } | null;
}

export interface Harness {
  engine: SyncEngine;
  /** See {@link EchoRoute}. */
  route: EchoRoute;
  /** Errors thrown by handlers of events the watcher dispatched. */
  eventErrors: unknown[];
  /** Wait until every event the watcher dispatched has been handled. */
  settle: () => Promise<void>;
  vault: MemoryVault;
  log: OperationLog;
  doc: DocManager;
  echo: RecentlyApplied;
  socket: () => FakeSocket;
  /** The engine's socket, or `null` before `start()` built one. */
  socketIfBuilt: () => FakeSocket | null;
  /** Every call the engine made into one of its dependencies. */
  calls: string[];
  /** Every REST request that reached the transport. */
  requests: Request[];
  /** REST routes, keyed `METHOD /path`; blob uploads fall back to `PUT /blobs`. */
  routes: Map<string, Responder>;
  /** What the server lists — read at request time. */
  serverFiles: ApiFile[];
  /**
   * Tombstones: listed, with `deletedAt` set, only when asked for
   * (`?includeDeleted=true`), next to {@link serverFiles}.
   */
  deletedFiles: ApiFile[];
  statuses: EngineStatus[];
  modal: {
    binary: Deferred<BinaryConflictResolution>;
    del: Deferred<DeleteConflictResolution>;
  };
}

export interface HarnessOptions {
  /** The engine this one replaces: same vault, log, docs and echo set. */
  predecessor?: Harness;
  /** Bind to a subfolder instead of the vault root. */
  localFolder?: string;
  logger?: Logger;
  /**
   * The docs the engine uses, instead of an in-memory `DocManager` (or the
   * predecessor's): `FakeIndexedDb.manager()` for docs that persist.
   */
  docs?: DocManager;
  /** Debounce of the disk snapshot after a remote edit; 0 (the next tick) by default. */
  diskSnapshotDebounceMs?: number;
  /** Start without network: the socket connects only after {@link goOnline}. */
  offline?: boolean;
}

export function json(body: unknown, status = 200): RequestUrlResponse {
  return { status, json: body, arrayBuffer: new ArrayBuffer(0), headers: {}, text: '' };
}

export function bytes(buf: ArrayBuffer): RequestUrlResponse {
  return { status: 200, json: null, arrayBuffer: buf, headers: {}, text: '' };
}

function listing(files: ApiFile[]): RequestUrlResponse {
  return json({ files: files.map((f) => ({ ...f, size: String(f.size) })) });
}

export function serverFile(
  id: string,
  path: string,
  fileType: 'TEXT' | 'BINARY',
  contentHash: string,
  size: number,
): ApiFile {
  return {
    id,
    path,
    fileType,
    contentHash,
    size,
    mimeType: null,
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastModifiedById: 'u1',
  };
}

export function buildHarness(opts: HarnessOptions = {}): Harness {
  const { predecessor } = opts;
  const calls: string[] = [];
  const requests: Request[] = [];
  const routes = new Map<string, Responder>();
  const vault = predecessor?.vault ?? new MemoryVault();
  const log = predecessor?.log ?? new OperationLog();
  const doc = opts.docs ?? predecessor?.doc ?? new DocManager();
  const ra = predecessor?.echo ?? new RecentlyApplied();

  // Filled in below; the routes and the modal read it when they are called.
  const state = {
    serverFiles: [] as ApiFile[],
    deletedFiles: [] as ApiFile[],
    statuses: [] as EngineStatus[],
    modal: {
      binary: deferred<BinaryConflictResolution>(),
      del: deferred<DeleteConflictResolution>(),
    },
  };
  const h = state as Partial<Harness> & typeof state;

  routes.set('GET /api/projects/p1/files', () => listing(h.serverFiles));
  routes.set('GET /api/projects/p1/files?includeDeleted=true', () =>
    listing([...h.serverFiles, ...h.deletedFiles]),
  );
  routes.set('PUT /blobs', () => json({ ok: true }));

  const route = async (method: string, url: string): Promise<RequestUrlResponse> => {
    const path = url.replace(server.url, '');
    requests.push({ method, path });
    const responder =
      routes.get(`${method} ${path}`) ??
      (method === 'PUT' && path.includes('/blobs/') ? routes.get('PUT /blobs') : undefined);
    if (!responder) throw new Error(`unexpected request: ${method} ${path}`);
    return responder();
  };
  const api = new ApiClient(
    server,
    (p) => route(p.method ?? 'GET', p.url),
    (p) => route(p.method, p.url),
  );
  // Each engine gets its own socket, so a predecessor's late emits stay
  // apart from its successor's.
  let own: FakeSocket | null = null;
  const factory: SocketFactory = () => {
    own = new FakeSocket();
    if (opts.offline) own.reachable = false;
    return own;
  };
  const socket = new SocketClient({ server, clientId: 'device-1', factory });
  const resolver: ConflictResolver = {
    resolveBinaryConflict: () => h.modal.binary.promise,
    resolveDeleteConflict: () => h.modal.del.promise,
  };

  const engineBinding =
    opts.localFolder === undefined ? binding : { ...binding, localFolder: opts.localFolder };
  const engine = new SyncEngine({
    binding: engineBinding,
    server,
    clientId: 'device-1',
    vault: track(vault, 'vault', calls),
    operationLog: track(log, 'log', calls),
    docManager: track(doc, 'doc', calls),
    recentlyApplied: track(ra, 'echo', calls),
    apiClient: track(api, 'api', calls),
    socketClient: track(socket, 'socket', calls),
    conflictResolver: track(resolver, 'modal', calls),
    diskSnapshotDebounceMs: opts.diskSnapshotDebounceMs ?? 0,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  engine.onStatus((status) => h.statuses.push(status));

  const echoRoute = predecessor?.route ?? watchVault(vault, ra, engineBinding);
  echoRoute.engine = engine;

  return Object.assign(h, {
    engine,
    route: echoRoute,
    eventErrors: echoRoute.errors,
    settle: () => settleEvents(echoRoute),
    vault,
    log,
    doc,
    echo: ra,
    calls,
    requests,
    routes,
    socket: (): FakeSocket => {
      if (!own) throw new Error('socket not built — start the engine first');
      return own;
    },
    socketIfBuilt: (): FakeSocket | null => own,
  });
}

/** Start the vault's `ObsidianWatcher`, wired to the engine as `main.ts` does. */
function watchVault(vault: MemoryVault, ra: RecentlyApplied, binding: VaultBinding): EchoRoute {
  const route: EchoRoute = {
    engine: null,
    binding,
    inflight: new Set(),
    errors: [],
    server: null,
  };
  const watcher = new ObsidianWatcher({
    bindings: () => [route.binding],
    recentlyApplied: ra,
    modifyDebounceMs: 0,
  });
  watcher.onEvent((event: VaultEvent) => {
    const engine = route.engine;
    if (!engine) return;
    const run = engine.handleVaultEvent(event).catch((err: unknown) => {
      route.errors.push(err);
    });
    route.inflight.add(run);
    void run.finally(() => route.inflight.delete(run));
  });
  watcher.start(vault.watchable);
  return route;
}

/**
 * Wait for the handlers of dispatched events, answering file operations on
 * the way when a {@link FakeServer} serves the engine: a handler may be
 * waiting for its ack.
 */
async function settleEvents(route: EchoRoute): Promise<void> {
  for (let idle = 0; idle < 200; ) {
    await flushAsync();
    if (route.server?.serveNext()) {
      idle = 0;
      continue;
    }
    if (route.inflight.size === 0) return;
    await Promise.race([Promise.allSettled([...route.inflight]), flushAsync(5)]);
    idle += 1;
  }
  throw new Error(`${route.inflight.size} vault event(s) still being handled`);
}

/**
 * The user renames a file in Obsidian: the file moves and the vault `rename`
 * event goes through the watcher to the engine. Resolves once handled.
 */
export async function userRename(h: Harness, from: string, to: string): Promise<void> {
  await h.vault.rename(from, to);
  await h.settle();
}

/**
 * The network is back for an engine started with `offline: true`: its socket
 * connects, and the join is answered with `join`.
 */
export async function goOnline(
  h: Harness,
  join: { operations?: ServerOperation[]; yjsDocs?: YjsDocSnapshot[] } = {},
): Promise<void> {
  h.socket().goOnline();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: join.operations ?? [], yjsDocs: join.yjsDocs ?? [] });
  await flushAsync();
}

export async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Start and answer `project:join`. */
export async function connect(
  h: Harness,
  join: { operations?: ServerOperation[]; yjsDocs?: YjsDocSnapshot[] } = {},
): Promise<void> {
  await h.engine.start();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: join.operations ?? [], yjsDocs: join.yjsDocs ?? [] });
  await flushAsync();
}

export interface Mark {
  calls: number;
  requests: number;
  emits: number;
  statuses: number;
}

/** Where the records stand now; anything recorded after it is a late effect. */
export function markOf(h: Harness): Mark {
  return {
    calls: h.calls.length,
    requests: h.requests.length,
    emits: h.socketIfBuilt()?.emits.length ?? 0,
    statuses: h.statuses.length,
  };
}

export function expectQuietSince(h: Harness, mark: Mark): void {
  expect(h.calls.slice(mark.calls)).toEqual([]);
  expect(h.requests.slice(mark.requests)).toEqual([]);
  expect((h.socketIfBuilt()?.emits ?? []).slice(mark.emits).map((e) => e.event)).toEqual([]);
  expect(h.statuses.slice(mark.statuses)).toEqual([]);
  expect(h.engine.getStatus()).toBe('stopped');
}

/** The catch-up snapshot of a server doc, for file `fileId`. */
export function snapshotOf(serverDoc: Y.Doc, fileId: string): YjsDocSnapshot {
  return {
    fileId,
    sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
    stateVector: Array.from(Y.encodeStateVector(serverDoc)),
  };
}

/** A server doc holding `text`. */
export function serverDocWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return doc;
}

/** Push a teammate's edit (`line` inserted at the top) as a live `yjs:update`. */
export function remoteEdit(h: Harness, serverDoc: Y.Doc, fileId: string, line: string): void {
  const seen = Y.encodeStateVector(serverDoc);
  serverDoc.getText('content').insert(0, line);
  h.socket().fire('yjs:update', {
    fileId,
    update: Array.from(Y.encodeStateAsUpdate(serverDoc, seen)),
  });
}

/** The `log` field every server file event carries. */
export const eventLog = { id: 'l1', vectorClock: { 'device-2': 2 }, createdAt: '2026-01-01' };

/** One entry of the join's operation list, authored by a teammate. */
export function op(
  opType: ServerOperation['opType'],
  filePath: string,
  newPath: string | null,
  payload: Record<string, unknown>,
  clock: number,
): ServerOperation {
  return {
    id: `op-${clock}`,
    opType,
    filePath,
    newPath,
    authorId: 'u2',
    vectorClock: { 'device-2': clock },
    payload,
    createdAt: '2026-01-01',
  };
}

// -- Fake server ----------------------------------------------------------------

/** A file as the {@link FakeServer} holds it. */
export interface ServerFileRecord {
  id: string;
  path: string;
  fileType: 'TEXT' | 'BINARY';
  contentHash: string;
  size: number;
  deleted: boolean;
}

/**
 * Which broadcast format the {@link FakeServer} speaks: `current` carries the
 * sender's `clientId` and the path the file was stored at; `legacy` is what
 * servers sent before, without `clientId` and with the path the client asked
 * for, even when the file was stored under a conflict name.
 */
export type BroadcastFormat = 'current' | 'legacy';

/** The operations a client sends that the {@link FakeServer} answers. */
const SERVED = new Set([
  'file:rename',
  'file:move',
  'file:create',
  'file:delete',
  'file:update-binary',
]);

/**
 * The server's side of file operations, enough to see what a client makes of
 * its own and its teammates' changes. Like `Project/server` (`handleMove`,
 * `applyMove`): a RENAME or MOVE is applied by file id without a precondition
 * on the source path, a collision stores the file under the first free
 * `<name>.conflict-<clientId>[-n]`, and the operation is broadcast to the whole
 * room — the sender included — right before the ack. CREATE, DELETE and a
 * binary UPDATE are applied the same way, without file contents. A CREATE on a
 * name taken by a file with the same content is that file (an idempotent
 * replay); one on a tombstone brings its id back.
 *
 * Nothing is answered until {@link FakeServer.pump}: the test decides when
 * the server gets to work. The listing (`h.serverFiles`, tombstones in
 * `h.deletedFiles`) follows every change, and every operation goes to the
 * {@link FakeServer.journal} the catch-up is taken from
 * ({@link FakeServer.catchupFor}).
 */
export class FakeServer {
  readonly files = new Map<string, ServerFileRecord>();
  /**
   * What the server applied, in order: `f1 a.md -> b.md`, `create x.md`,
   * `delete f1`, `update f1`.
   */
  readonly applied: string[] = [];
  /**
   * The operation log: every operation applied, in order, each with the
   * vector clock and log id its broadcast carried.
   */
  readonly journal: ServerOperation[] = [];
  private readonly served = new WeakSet<Emit>();
  private seq = 0;

  constructor(
    private harness: Harness,
    private readonly format: BroadcastFormat = 'current',
  ) {
    harness.route.server = this;
  }

  /** Serve the engine built after a pause instead (see `buildHarness`). */
  attach(h: Harness): void {
    this.harness = h;
    h.route.server = this;
    this.publish();
  }

  /** A file the server has — also in the listing the engine reads. */
  add(file: Omit<ServerFileRecord, 'deleted'>): void {
    this.files.set(file.id, { ...file, deleted: false });
    this.publish();
  }

  /** Where the server has file `id`, or `null` when it is deleted or unknown. */
  pathOf(id: string): string | null {
    const file = this.files.get(id);
    return file && !file.deleted ? file.path : null;
  }

  /**
   * The operations of the catch-up `project:join` answers a client whose
   * vector clock is `clock` (by default what the harness's engine last
   * persisted): every one with a counter the clock has not reached. `window`
   * looks only at the journal's first rows, as a server before the
   * whole-journal catch-up did (500 rows; `0` for a longer journal).
   */
  catchupFor(
    clock: Record<string, number> = this.harness.log.getBindingState('b1')?.lastVectorClock ?? {},
    opts: { window?: number } = {},
  ): ServerOperation[] {
    const rows = opts.window === undefined ? this.journal : this.journal.slice(0, opts.window);
    return rows.filter((row) =>
      Object.entries(row.vectorClock).some(([client, n]) => n > (clock[client] ?? 0)),
    );
  }

  /**
   * Answer the client's file operations, one at a time, until it sends no
   * more. Throws when it is still sending after `maxOps` — a loop.
   */
  async pump(maxOps = 30): Promise<void> {
    let ops = 0;
    for (let idle = 0; idle < 3; ) {
      await flushAsync(15);
      if (!this.serveNext()) {
        idle += 1;
        continue;
      }
      idle = 0;
      if (++ops > maxOps) {
        throw new Error(`the client kept sending operations: ${this.applied.join(', ')}`);
      }
    }
  }

  /** Answer the client's oldest operation not answered yet; `false` when there is none. */
  serveNext(): boolean {
    const next = this.harness
      .socketIfBuilt()
      ?.emits.find((e) => SERVED.has(e.event) && !this.served.has(e));
    if (!next) return false;
    this.served.add(next);
    this.answer(next);
    return true;
  }

  /** A teammate (`device-2`) renames file `id`; the broadcast reaches the engine. */
  teammateRename(id: string, newPath: string): void {
    const result = this.move(id, newPath, 'device-2', 'RENAME');
    if ('error' in result) throw new Error(result.error);
  }

  private answer(e: Emit): void {
    const p = e.payload as {
      clientId: string;
      fileId?: string;
      filePath: string;
      newPath?: string;
      fileType?: 'TEXT' | 'BINARY';
      contentHash?: string;
      size?: number;
    };
    switch (e.event) {
      case 'file:rename':
      case 'file:move': {
        const result = this.move(
          p.fileId ?? '',
          p.newPath ?? '',
          p.clientId,
          e.event === 'file:rename' ? 'RENAME' : 'MOVE',
        );
        e.ack('error' in result ? { ok: false, error: result.error } : { ok: true, ...result });
        return;
      }
      case 'file:create':
        e.ack({ ok: true, outcome: this.create(p.filePath, p) });
        return;
      case 'file:update-binary': {
        const file = this.files.get(p.fileId ?? '');
        if (!file || file.deleted) {
          e.ack({ ok: false, error: 'file_not_found' });
          return;
        }
        file.contentHash = p.contentHash ?? '';
        file.size = p.size ?? 0;
        this.applied.push(`update ${file.id}`);
        this.publish();
        const log = this.log(p.clientId);
        this.record(log, 'UPDATE', file.path, null, {
          fileId: file.id,
          contentHash: file.contentHash,
          size: file.size,
          fileType: file.fileType,
        });
        this.broadcast(
          'file:updated-binary',
          { fileId: file.id, contentHash: file.contentHash, log },
          p.clientId,
        );
        e.ack({ ok: true, outcome: { kind: 'updated', fileId: file.id } });
        return;
      }
      case 'file:delete': {
        const file = this.files.get(p.fileId ?? '');
        if (!file || file.deleted) {
          e.ack({ ok: false, error: 'file_not_found' });
          return;
        }
        file.deleted = true;
        this.applied.push(`delete ${file.id}`);
        this.publish();
        const log = this.log(p.clientId);
        this.record(log, 'DELETE', file.path, null, { fileId: file.id });
        this.broadcast('file:deleted', { fileId: file.id, log }, p.clientId);
        e.ack({ ok: true, outcome: { kind: 'deleted', fileId: file.id } });
        return;
      }
    }
  }

  private move(
    id: string,
    requested: string,
    clientId: string,
    opType: 'RENAME' | 'MOVE',
  ): { outcome: unknown } | { error: string } {
    const file = this.files.get(id);
    if (!file || file.deleted) return { error: 'file_not_found' };
    let outcome: unknown;
    let stored = requested;
    const from = file.path;
    if (file.path === requested) {
      outcome = { kind: 'no_op', reason: 'same_path' };
    } else {
      const taken = [...this.files.values()].some(
        (f) => f !== file && !f.deleted && f.path === requested,
      );
      if (taken) {
        // A row there is taken over when it is a tombstone or this very file.
        stored = this.conflictPath(requested, clientId, (f) => f.deleted || f.id === id);
        this.dropTombstoneAt(stored);
        outcome = {
          kind: 'conflict_create_renamed',
          fileId: id,
          originalPath: requested,
          finalPath: stored,
        };
      } else {
        outcome = { kind: 'renamed', fileId: id, from: file.path, to: requested };
      }
      this.applied.push(`${id} ${file.path} -> ${stored}`);
      file.path = stored;
      this.publish();
    }
    const log = this.log(clientId);
    this.record(log, opType, from, stored, { fileId: id });
    this.broadcast(
      opType === 'RENAME' ? 'file:renamed' : 'file:moved',
      {
        fileId: id,
        newPath: this.format === 'current' ? stored : requested,
        outcome,
        log,
      },
      clientId,
    );
    return { outcome };
  }

  /**
   * Called for each file a CREATE adds or revives, right after `file:created`
   * is broadcast: `data` is what the client sent, `revived` whether the id is
   * a deleted file's brought back. See {@link ServerDocs}.
   */
  onCreate?: (id: string, data: unknown, revived: boolean) => void;

  /** A teammate (`device-2`) creates `path` with `text`; the broadcast reaches the engine. */
  async teammateCreate(path: string, text: string): Promise<string> {
    const bytes = encode(text);
    const outcome = this.create(path, {
      clientId: 'device-2',
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: bytes.byteLength,
      data: bytes,
    }) as { fileId: string };
    return outcome.fileId;
  }

  /** A teammate (`device-2`) uploads an attachment to `path`; the broadcast reaches the engine. */
  async teammateUpload(path: string, content: ArrayBuffer): Promise<string> {
    const outcome = this.create(path, {
      clientId: 'device-2',
      fileType: 'BINARY',
      contentHash: await sha256Hex(content),
      size: content.byteLength,
    }) as { fileId: string };
    return outcome.fileId;
  }

  /** A teammate (`device-2`) deletes file `id`; the broadcast reaches the engine. */
  teammateDelete(id: string): void {
    const file = this.files.get(id);
    if (!file || file.deleted) throw new Error(`no file ${id}`);
    file.deleted = true;
    this.applied.push(`delete ${id}`);
    this.publish();
    const log = this.log('device-2');
    this.record(log, 'DELETE', file.path, null, { fileId: id });
    this.broadcast('file:deleted', { fileId: id, log }, 'device-2');
  }

  /**
   * A teammate (`device-2`) uploads a new version of attachment `id`; the
   * broadcast reaches the engine. Returns the new content hash.
   */
  async teammateUpdate(id: string, content: ArrayBuffer): Promise<string> {
    const file = this.files.get(id);
    if (!file || file.deleted) throw new Error(`no file ${id}`);
    file.contentHash = await sha256Hex(content);
    file.size = content.byteLength;
    this.applied.push(`update ${id}`);
    this.publish();
    const log = this.log('device-2');
    this.record(log, 'UPDATE', file.path, null, {
      fileId: id,
      contentHash: file.contentHash,
      size: file.size,
      fileType: file.fileType,
    });
    this.broadcast(
      'file:updated-binary',
      { fileId: id, contentHash: file.contentHash, log },
      'device-2',
    );
    return file.contentHash;
  }

  private create(
    path: string,
    p: {
      clientId: string;
      fileType?: 'TEXT' | 'BINARY';
      contentHash?: string;
      size?: number;
      data?: unknown;
    },
  ): unknown {
    const live = [...this.files.values()].find((f) => !f.deleted && f.path === path);
    let outcome: unknown;
    let added: { id: string; revived: boolean } | null = null;
    let fileId: string;
    let at = path;
    let revived = false;
    if (live && live.contentHash === p.contentHash) {
      fileId = live.id;
      outcome = { kind: 'created', fileId, path };
    } else {
      // A row on the conflict name is taken over when it is a tombstone or
      // holds this very content: the same CREATE retried after a lost ack.
      at = live
        ? this.conflictPath(path, p.clientId, (f) => f.deleted || f.contentHash === p.contentHash)
        : path;
      const row = [...this.files.values()].find((f) => f.path === at);
      revived = row?.deleted === true;
      fileId = row?.id ?? `s${++this.seq}`;
      this.files.set(fileId, {
        id: fileId,
        path: at,
        fileType: p.fileType ?? 'TEXT',
        contentHash: p.contentHash ?? '',
        size: p.size ?? 0,
        deleted: false,
      });
      this.applied.push(`create ${at}`);
      this.publish();
      if (row === undefined || revived) added = { id: fileId, revived };
      outcome = live
        ? { kind: 'conflict_create_renamed', fileId, originalPath: path, finalPath: at }
        : { kind: 'created', fileId, path: at };
    }
    const log = this.log(p.clientId);
    this.record(log, 'CREATE', at, null, {
      fileId,
      fileType: p.fileType ?? 'TEXT',
      contentHash: p.contentHash ?? '',
      size: p.size ?? 0,
      originalPath: path,
      ...(revived && this.format === 'current' ? { revived: true } : {}),
    });
    this.broadcast('file:created', { result: { outcome, log }, log }, p.clientId);
    if (added !== null) this.onCreate?.(added.id, p.data, added.revived);
    return outcome;
  }

  /**
   * The server's `pickConflictPath`: the first `<path>.conflict-<clientId>[-n]`
   * without a row, or with one that `usable` takes over.
   */
  private conflictPath(
    path: string,
    clientId: string,
    usable: (row: ServerFileRecord) => boolean,
  ): string {
    for (let attempt = 1; ; attempt++) {
      const candidate = conflictName(path, clientId, attempt);
      const row = [...this.files.values()].find((f) => f.path === candidate);
      if (row === undefined || usable(row)) return candidate;
    }
  }

  /** A tombstone at `path` gives way to a file renamed there (the server's `dropTombstoneAt`). */
  private dropTombstoneAt(path: string): void {
    for (const [id, f] of this.files) if (f.deleted && f.path === path) this.files.delete(id);
  }

  /** Add an applied operation to the {@link journal}. */
  private record(
    log: { id: string; vectorClock: Record<string, number>; createdAt: string },
    opType: ServerOperation['opType'],
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.journal.push({
      id: log.id,
      opType,
      filePath,
      newPath,
      authorId: 'u1',
      vectorClock: log.vectorClock,
      payload,
      createdAt: log.createdAt,
    });
  }

  private broadcast(event: string, payload: Record<string, unknown>, clientId: string): void {
    const socket = this.harness.socketIfBuilt();
    if (!socket?.connected) return;
    socket.fire(event, this.format === 'current' ? { ...payload, clientId } : payload);
  }

  private log(clientId: string): {
    id: string;
    vectorClock: Record<string, number>;
    createdAt: string;
  } {
    this.seq += 1;
    return { id: `l${this.seq}`, vectorClock: { [clientId]: this.seq }, createdAt: '2026-01-01' };
  }

  private publish(): void {
    this.harness.serverFiles = [...this.files.values()]
      .filter((f) => !f.deleted)
      .map((f) => serverFile(f.id, f.path, f.fileType, f.contentHash, f.size));
    this.harness.deletedFiles = [...this.files.values()]
      .filter((f) => f.deleted)
      .map((f) => ({
        ...serverFile(f.id, f.path, f.fileType, f.contentHash, f.size),
        deletedAt: '2026-01-02',
      }));
  }
}

/**
 * The notes' Yjs docs on a {@link FakeServer}, kept the way `Project/server`
 * keeps them. A text CREATE seeds a doc from the bytes sent. On a tombstone,
 * the new text goes on top of the stored history, as the server that
 * continues histories does — or, with `replaceOnRevive`, a new history
 * replaces it, as the server before it did (production when 0.3.8 came out).
 * Either way the doc's full state follows `file:created` to the whole room as
 * a `yjs:update`. What the client sends is applied by {@link absorb};
 * `yjs:fetch` is answered by {@link answerFetches}.
 */
export class ServerDocs {
  readonly docs = new Map<string, Y.Doc>();
  private absorbed = new WeakSet<object>();

  constructor(
    readonly server: FakeServer,
    private harness: Harness,
    private readonly opts: { replaceOnRevive?: boolean } = {},
  ) {
    server.onCreate = (id, data, revived) => this.created(id, data, revived);
  }

  /** Serve the engine built after a pause instead (with {@link FakeServer.attach}). */
  attach(h: Harness): void {
    this.harness = h;
    this.absorbed = new WeakSet();
  }

  /** A note the server has: its file, and its doc — by default one holding `text`. */
  async add(
    id: string,
    path: string,
    text: string,
    doc: Y.Doc = serverDocWith(text),
  ): Promise<void> {
    this.docs.set(id, doc);
    this.server.add({
      id,
      path,
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: encode(text).byteLength,
    });
  }

  /** The text of note `id` on the server; `null` when it is deleted or has no doc. */
  text(id: string): string | null {
    if (this.server.pathOf(id) === null) return null;
    return this.docs.get(id)?.getText('content').toJSON() ?? null;
  }

  /** Every live note as `path=text`, sorted. */
  live(): string[] {
    return [...this.server.files.values()]
      .filter((f) => !f.deleted)
      .map((f) => `${f.path}=${this.text(f.id) ?? '?'}`)
      .sort();
  }

  /** The catch-up snapshots of every live note. */
  snapshots(): YjsDocSnapshot[] {
    return [...this.docs]
      .filter(([id]) => this.server.pathOf(id) !== null)
      .map(([id, doc]) => snapshotOf(doc, id));
  }

  /** Apply every `yjs:update` the engine has sent since the last call. */
  absorb(): void {
    for (const e of this.harness.socketIfBuilt()?.emits ?? []) {
      if (e.event !== 'yjs:update' || this.absorbed.has(e)) continue;
      this.absorbed.add(e);
      const p = e.payload as { fileId: string; update: Uint8Array | number[] };
      const doc = this.docs.get(p.fileId);
      if (doc && this.server.pathOf(p.fileId) !== null) {
        Y.applyUpdate(doc, Uint8Array.from(p.update));
      }
    }
  }

  /** Answer every `yjs:fetch` asked so far. */
  answerFetches(): void {
    for (const f of this.harness.socketIfBuilt()?.fetches.splice(0) ?? []) {
      const doc = this.docs.get(f.fileId);
      if (!doc || this.server.pathOf(f.fileId) === null) {
        f.answer({ ok: false, error: 'file_not_found' });
        continue;
      }
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(doc)),
        stateVector: Array.from(Y.encodeStateVector(doc)),
      });
    }
  }

  /**
   * Let the server work until nothing moves: answer file operations and
   * `yjs:fetch`, and apply what the engine sends.
   */
  async drive(rounds = 12): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      await this.server.pump();
      await this.harness.settle();
      this.absorb();
      const asked = this.harness.socketIfBuilt()?.fetches.length ?? 0;
      this.answerFetches();
      await flushAsync(20);
      this.absorb();
      if (asked === 0 && round > 1) return;
    }
  }

  private created(id: string, data: unknown, revived: boolean): void {
    const file = this.server.files.get(id);
    if (!file || file.fileType !== 'TEXT') return;
    const text =
      data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : Array.isArray(data)
            ? new TextDecoder().decode(Uint8Array.from(data as number[]))
            : '';
    const stored = this.docs.get(id);
    if (revived && stored && !this.opts.replaceOnRevive) {
      const t = stored.getText('content');
      stored.transact(() => {
        t.delete(0, t.length);
        t.insert(0, text);
      });
    } else {
      this.docs.set(id, serverDocWith(text));
    }
    const socket = this.harness.socketIfBuilt();
    const doc = this.docs.get(id);
    if (socket?.connected && doc) {
      socket.fire('yjs:update', { fileId: id, update: Array.from(Y.encodeStateAsUpdate(doc)) });
    }
  }
}

/** The server's `appendConflictSuffix`. */
function conflictName(path: string, clientId: string, attempt = 1): string {
  const tag =
    (clientId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'unknown') +
    (attempt > 1 ? `-${attempt}` : '');
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash) return `${path.slice(0, dot)}.conflict-${tag}${path.slice(dot)}`;
  return `${path}.conflict-${tag}`;
}
