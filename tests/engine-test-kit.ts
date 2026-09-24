/**
 * Test bench for `SyncEngine`: an in-memory vault whose calls can be held, a
 * Socket.IO stand-in whose acks the test answers, REST routes read at request
 * time, and a record of every call the engine makes into its dependencies.
 *
 * The same bench as in `engine-stop.test.ts`, shared by the suites written
 * after it. `buildHarness(predecessor)` builds the engine the `EngineManager`
 * spawns after a pause: a fresh one on the same vault, log, docs and echo set.
 */
import * as Y from 'yjs';
import { SyncEngine, type EngineStatus } from '@/sync/engine';
import { OperationLog } from '@/sync/operation-log';
import {
  DocManager,
  type DocPersistence,
  type IdbRegistry,
  type PersistenceFactory,
} from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
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

export class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
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
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.pass('rename');
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

/**
 * y-indexeddb stand-in: one database per name, kept across releases and
 * restarts (a new `DocManager` on the same instance). Like the real one, a
 * store loads asynchronously and applies what it holds with itself as the
 * origin, keeps a small key/value area, and `clearData` deletes the database.
 * The registry lists and deletes databases by name, as the renderer's
 * `indexedDB` does for every vault on the machine.
 */
export class FakeIndexedDb {
  readonly dbs = new Map<string, { updates: Uint8Array[]; custom: Map<string, unknown> }>();
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
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (!destroyed && origin !== persistence) store.updates.push(update);
    };
    const persistence: DocPersistence = {
      whenSynced: Promise.resolve().then(() => {
        if (destroyed) return;
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
    this.connected = true;
    this.fire('connect');
    return this;
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

export interface Harness {
  engine: SyncEngine;
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
    statuses: [] as EngineStatus[],
    modal: {
      binary: deferred<BinaryConflictResolution>(),
      del: deferred<DeleteConflictResolution>(),
    },
  };
  const h = state as Partial<Harness> & typeof state;

  routes.set('GET /api/projects/p1/files', () => listing(h.serverFiles));
  routes.set('GET /api/projects/p1/files?includeDeleted=true', () => listing(h.serverFiles));
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
    return own;
  };
  const socket = new SocketClient({ server, clientId: 'device-1', factory });
  const resolver: ConflictResolver = {
    resolveBinaryConflict: () => h.modal.binary.promise,
    resolveDeleteConflict: () => h.modal.del.promise,
  };

  const engine = new SyncEngine({
    binding:
      opts.localFolder === undefined ? binding : { ...binding, localFolder: opts.localFolder },
    server,
    clientId: 'device-1',
    vault: track(vault, 'vault', calls),
    operationLog: track(log, 'log', calls),
    docManager: track(doc, 'doc', calls),
    recentlyApplied: track(ra, 'echo', calls),
    apiClient: track(api, 'api', calls),
    socketClient: track(socket, 'socket', calls),
    conflictResolver: track(resolver, 'modal', calls),
    diskSnapshotDebounceMs: 0,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  engine.onStatus((status) => h.statuses.push(status));

  return Object.assign(h, {
    engine,
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
