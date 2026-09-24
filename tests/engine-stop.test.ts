/**
 * `SyncEngine.stop()` ends the work the engine had already started (TASK-0030).
 *
 * Obsidian neither awaits `onunload` nor can anything interrupt a pending
 * socket ack or `requestUrl`. Every test here parks one flow on such an
 * await — a file listing, a catch-up download, a queued upload's ack, a
 * `yjs:fetch`, the conflict modal — stops the engine, and only then lets the
 * answer arrive. From that moment the engine must make no call at all into
 * the vault, the operation log, the doc manager, the echo set, the conflict
 * modal, the REST client or the socket.
 *
 * Two things are finished rather than dropped, because dropping them loses
 * data, and the tests pin that too: a local change the engine had taken on is
 * queued by `stop()` itself, and the next engine — spawned on the same vault
 * and log, as after a pause — sends it; a server change whose disk part has
 * begun runs to its end, and `stop()` waits for it.
 */
import * as Y from 'yjs';
import { SyncEngine, type EngineStatus } from '@/sync/engine';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
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
import { sha256Hex } from '@/sync/hash';

// -- Test doubles ---------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Record every method call made on `target` as `<label>.<method>` — the
 * engine's whole view of the outside world, which must go quiet after stop.
 */
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

const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** A vault call held back until the test lets it through. */
interface Gate {
  /** Resolves once the held call has started. */
  reached: Promise<void>;
  release(): void;
}

class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
  private gates: Array<{
    method: string;
    skip: number;
    reached: () => void;
    open: Promise<void>;
  }> = [];

  /**
   * Hold the next call of `method` (after `skip` calls) at its start — a
   * disk read or write that `stop()` can land on.
   */
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
    /* no folders in memory */
    await this.pass('ensureParentFolder');
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
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

interface Emit {
  event: string;
  payload: unknown;
  ack: (response: unknown) => void;
}

/** Socket.IO stand-in: emits wait for the test to answer them. */
class FakeSocket implements SocketLike {
  static last: FakeSocket | null = null;
  connected = false;
  emits: Emit[] = [];
  /** `yjs:fetch` requests, answered by the test through `answer`. */
  fetches: Array<{ fileId: string; answer: (response: unknown) => void }> = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor() {
    FakeSocket.last = this;
  }
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
}

// -- Harness --------------------------------------------------------------------

const server: ServerConfig = {
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

interface Request {
  method: string;
  path: string;
  signal: AbortSignal | undefined;
}

interface Harness {
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

function json(body: unknown, status = 200): RequestUrlResponse {
  return { status, json: body, arrayBuffer: new ArrayBuffer(0), headers: {}, text: '' };
}

function bytes(buf: ArrayBuffer): RequestUrlResponse {
  return { status: 200, json: null, arrayBuffer: buf, headers: {}, text: '' };
}

function listing(files: ApiFile[]): RequestUrlResponse {
  return json({ files: files.map((f) => ({ ...f, size: String(f.size) })) });
}

function serverFile(
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

/**
 * `predecessor`: build the engine the `EngineManager` spawns after a pause or
 * a binding toggle — a fresh one on the same vault, log, docs and echo set.
 */
function buildHarness(predecessor?: Harness): Harness {
  const calls: string[] = [];
  const requests: Request[] = [];
  const routes = new Map<string, Responder>();
  const vault = predecessor?.vault ?? new MemoryVault();
  const log = predecessor?.log ?? new OperationLog();
  const doc = predecessor?.doc ?? new DocManager();
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

  const route = async (method: string, url: string, signal?: AbortSignal) => {
    const path = url.replace(server.url, '');
    requests.push({ method, path, signal });
    const responder =
      routes.get(`${method} ${path}`) ??
      (method === 'PUT' && path.includes('/blobs/') ? routes.get('PUT /blobs') : undefined);
    if (!responder) throw new Error(`unexpected request: ${method} ${path}`);
    return responder();
  };
  // `requestUrl` (JSON) has no signal; the binary transport (`fetch`) gets one.
  // Neither honours it here: the answer arrives whenever the test says so, as
  // it would from a transport that can't be cancelled.
  const api = new ApiClient(
    server,
    (p) => route(p.method ?? 'GET', p.url),
    (p) => route(p.method, p.url, p.signal),
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
    binding,
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

afterEach(() => {
  FakeSocket.last = null;
});

async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Start and answer `project:join`. */
async function connect(
  h: Harness,
  join: { operations?: ServerOperation[]; yjsDocs?: YjsDocSnapshot[] } = {},
): Promise<void> {
  await h.engine.start();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: join.operations ?? [], yjsDocs: join.yjsDocs ?? [] });
  await flushAsync();
}

interface Mark {
  calls: number;
  requests: number;
  emits: number;
  statuses: number;
}

/** Where the records stand now; anything recorded after it is a late effect. */
function markOf(h: Harness): Mark {
  return {
    calls: h.calls.length,
    requests: h.requests.length,
    emits: h.socketIfBuilt()?.emits.length ?? 0,
    statuses: h.statuses.length,
  };
}

/** Stop the engine; everything recorded from here on is a late effect. */
async function stop(h: Harness): Promise<Mark> {
  await h.engine.stop();
  return markOf(h);
}

function expectQuietSince(h: Harness, mark: Mark): void {
  expect(h.calls.slice(mark.calls)).toEqual([]);
  expect(h.requests.slice(mark.requests)).toEqual([]);
  expect((h.socketIfBuilt()?.emits ?? []).slice(mark.emits).map((e) => e.event)).toEqual([]);
  expect(h.statuses.slice(mark.statuses)).toEqual([]);
  expect(h.engine.getStatus()).toBe('stopped');
}

function snapshot(text: string): YjsDocSnapshot {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  const snap = {
    fileId: 'f1',
    sync1: Array.from(Y.encodeStateAsUpdate(doc)),
    stateVector: Array.from(Y.encodeStateVector(doc)),
  };
  doc.destroy();
  return snap;
}

/** The `log` field every server file event carries. */
const eventLog = { id: 'l1', vectorClock: { 'device-2': 2 }, createdAt: '2026-01-01' };

/** `img.png` on disk and on the server, synced; `storedHash` overrides the server's hash. */
async function connectWithImage(h: Harness, storedHash?: string): Promise<ArrayBuffer> {
  const local = new Uint8Array([9, 9, 9]).buffer;
  h.vault.files.set('img.png', local);
  h.serverFiles = [
    serverFile('f1', 'img.png', 'BINARY', storedHash ?? (await sha256Hex(local)), 3),
  ];
  await connect(h);
  return local;
}

/** A text file the server and the disk agree on, its doc loaded by the catch-up. */
async function connectWithNote(h: Harness, text: string): Promise<Y.Doc> {
  const serverDoc = new Y.Doc();
  serverDoc.getText('content').insert(0, text);
  h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', await sha256Hex(text), text.length)];
  // Not on disk yet: the catch-up writes it, so the doc is loaded and trusted.
  await connect(h, {
    yjsDocs: [
      {
        fileId: 'f1',
        sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
        stateVector: Array.from(Y.encodeStateVector(serverDoc)),
      },
    ],
  });
  expect(h.vault.text('note.md')).toBe(text);
  return serverDoc;
}

function createOp(fileId: string, filePath: string): ServerOperation {
  return {
    id: `op-${fileId}`,
    opType: 'CREATE',
    filePath,
    newPath: null,
    authorId: 'u2',
    vectorClock: { 'device-2': 1 },
    payload: { fileId, fileType: 'BINARY' },
    createdAt: '2026-01-01',
  };
}

// -- Catch-up ---------------------------------------------------------------------

describe('SyncEngine.stop() — connect-time catch-up', () => {
  it('drops a file listing that lands after stop: no file meta, no doc, nothing on disk', async () => {
    const h = buildHarness();
    h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', 'h1', 5)];
    const files = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files', () => files.promise);

    await connect(h, { yjsDocs: [snapshot('hello')] });
    expect(h.engine.getStatus()).toBe('syncing');

    const mark = await stop(h);
    files.resolve(listing(h.serverFiles));
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.getFileMeta('b1', 'note.md')).toBeNull();
    expect(h.doc.has('b1', 'note.md')).toBe(false);
    expect(h.vault.files.has('note.md')).toBe(false);
  });

  it('does not write a catch-up download that lands after stop, nor start the next one', async () => {
    const h = buildHarness();
    const png = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(png);
    h.serverFiles = [
      serverFile('f2', 'a.png', 'BINARY', hash, 3),
      serverFile('f3', 'b.png', 'BINARY', hash, 3),
    ];
    const download = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files/f2', () => download.promise);
    h.routes.set('GET /api/projects/p1/files/f3', () => bytes(png));

    await connect(h, { operations: [createOp('f2', 'a.png'), createOp('f3', 'b.png')] });
    const inFlight = h.requests.find((r) => r.path === '/api/projects/p1/files/f2');
    expect(inFlight?.signal?.aborted).toBe(false);

    const mark = await stop(h);
    // The transfer is cancelled; a transport that answers anyway is ignored.
    expect(inFlight?.signal?.aborted).toBe(true);
    download.resolve(bytes(png));
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.vault.files.has('a.png')).toBe(false);
    expect(h.vault.files.has('b.png')).toBe(false);
  });

  it('keeps status `stopped` when a catch-up request fails after stop', async () => {
    const h = buildHarness();
    const files = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files', () => files.promise);
    await connect(h);

    const mark = await stop(h);
    files.resolve(json({ error: 'boom' }, 500));
    await flushAsync();

    expectQuietSince(h, mark);
  });
});

// -- Offline queue ----------------------------------------------------------------

describe('SyncEngine.stop() — offline queue drain', () => {
  function queueCreates(h: Harness, ...paths: string[]): void {
    for (const path of paths) {
      h.vault.files.set(path, encode(`${path} body`));
      h.log.enqueueOperation('b1', {
        opType: 'CREATE',
        filePath: path,
        payload: { fileType: 'TEXT', contentHash: 'stale', size: 1 },
      });
    }
  }

  it('ignores an ack that lands after stop and sends nothing more', async () => {
    const h = buildHarness();
    queueCreates(h, 'a.md', 'b.md');
    await connect(h);
    const inFlight = h.socket().pending('file:create', 'a.md');

    const mark = await stop(h);
    inFlight.ack({ ok: true, outcome: { kind: 'created', fileId: 'fa', path: 'a.md' } });
    await flushAsync();

    expectQuietSince(h, mark);
    // Neither op is marked sent, so the next engine replays both — the server
    // takes the resent CREATE (same path and hash) as a replay.
    expect(h.log.dequeueOperations('b1').map((op) => op.filePath)).toEqual(['a.md', 'b.md']);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
  });

  it('keeps what the server acknowledged before stop, not what it acknowledged after', async () => {
    const h = buildHarness();
    queueCreates(h, 'a.md', 'b.md');
    await connect(h);

    h.socket()
      .pending('file:create', 'a.md')
      .ack({ ok: true, outcome: { kind: 'created', fileId: 'fa', path: 'a.md' } });
    await flushAsync();
    // Recorded at once, not at the end of the drain.
    expect(h.log.dequeueOperations('b1').map((op) => op.filePath)).toEqual(['b.md']);
    const inFlight = h.socket().pending('file:create', 'b.md');

    const mark = await stop(h);
    inFlight.ack({ ok: true, outcome: { kind: 'created', fileId: 'fb', path: 'b.md' } });
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.dequeueOperations('b1').map((op) => op.filePath)).toEqual(['b.md']);
    expect(h.log.getFileMeta('b1', 'b.md')).toBeNull();
  });

  it('uploads nothing when stop lands during the initial-push pass', async () => {
    const h = buildHarness();
    h.vault.files.set('new.md', encode('fresh'));
    const tombstones = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () => tombstones.promise);
    await connect(h);

    const mark = await stop(h);
    tombstones.resolve(listing([]));
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.pendingCount('b1')).toBe(0);
  });
});

// -- Transfers ----------------------------------------------------------------------

describe('SyncEngine.stop() — file transfers', () => {
  it('does not write a live download that lands after stop', async () => {
    const h = buildHarness();
    const local = await connectWithImage(h);
    const download = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files/f1', () => download.promise);

    h.socket().fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: 'new',
      log: { id: 'l1', vectorClock: { 'device-2': 2 }, createdAt: '2026-01-01' },
    });
    await flushAsync();
    const inFlight = h.requests.find((r) => r.path === '/api/projects/p1/files/f1');

    const mark = await stop(h);
    expect(inFlight?.signal?.aborted).toBe(true);
    download.resolve(bytes(new Uint8Array([4, 5, 6, 7]).buffer));
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.vault.files.get('img.png')).toBe(local);
    expect(h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(await sha256Hex(local));
  });

  it('queues a binary edit whose upload stop cancelled, and the next engine sends it', async () => {
    const h = buildHarness();
    const synced = await connectWithImage(h);
    const upload = deferred<RequestUrlResponse>();
    h.routes.set('PUT /blobs', () => upload.promise);

    const edited = new Uint8Array([1, 1, 1, 1]).buffer;
    h.vault.files.set('img.png', edited);
    const handled = h.engine.handleVaultEvent({
      type: 'modify',
      bindingId: 'b1',
      path: 'img.png',
      source: 'obsidian',
    });
    await flushAsync();
    const inFlight = h.requests.find((r) => r.method === 'PUT');
    expect(inFlight).toBeDefined();

    const mark = await stop(h);
    expect(inFlight?.signal?.aborted).toBe(true);
    upload.resolve(json({ ok: true }));
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();

    // Nothing after stop — the edit went to the queue inside `stop()` itself.
    expectQuietSince(h, mark);
    const newHash = await sha256Hex(edited);
    expect(h.log.dequeueOperations('b1')).toMatchObject([
      { opType: 'UPDATE', filePath: 'img.png', payload: { fileId: 'f1', contentHash: newHash } },
    ]);

    // Resume: the manager spawns a fresh engine on the same vault and log.
    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'img.png', 'BINARY', await sha256Hex(synced), 3)];
    await connect(next);
    expect(next.requests.filter((r) => r.method === 'PUT').map((r) => r.path)).toEqual([
      `/api/projects/p1/blobs/${newHash}`,
    ]);
    const update = next.socket().pending('file:update-binary');
    expect(update.payload).toMatchObject({ fileId: 'f1', contentHash: newHash, size: 4 });
    update.ack({ ok: true });
    await flushAsync();
    expect(next.log.pendingCount('b1')).toBe(0);
    expect(next.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(newHash);
  });

  it('changes nothing when the conflict modal is answered after stop', async () => {
    const h = buildHarness();
    const local = await connectWithImage(h, 'hash-of-the-last-synced-version');
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(new Uint8Array([4, 5, 6, 7]).buffer));

    h.socket().fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: 'new',
      log: { id: 'l1', vectorClock: { 'device-2': 2 }, createdAt: '2026-01-01' },
    });
    await flushAsync();
    expect(h.calls).toContain('modal.resolveBinaryConflict');

    const mark = await stop(h);
    h.modal.binary.resolve('keep-server');
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.vault.files.get('img.png')).toBe(local);
  });
});

// -- Hydration ------------------------------------------------------------------

describe('SyncEngine.stop() — doc hydration', () => {
  it('does not apply a yjs:fetch answer that lands after stop', async () => {
    const h = buildHarness();
    h.vault.files.set('note.md', encode('v1\n'));
    h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', await sha256Hex('v1\n'), 3)];
    // Disk already matches the server: the catch-up skips the doc, so the
    // first local save has to pull it with `yjs:fetch`.
    await connect(h, { yjsDocs: [snapshot('v1\n')] });
    expect(h.doc.has('b1', 'note.md')).toBe(false);

    h.vault.files.set('note.md', encode('v1\nlocal\n'));
    const handled = h.engine.handleVaultEvent({
      type: 'modify',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    await flushAsync();
    const fetch = h.socket().fetches[0];
    expect(fetch?.fileId).toBe('f1');

    const mark = await stop(h);
    const { sync1, stateVector } = snapshot('v1\nremote\n');
    fetch?.answer({ ok: true, sync1, stateVector });
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.doc.getText('b1', 'note.md')).toBe('');
    expect(h.vault.text('note.md')).toBe('v1\nlocal\n');
  });
});

// -- Local changes under way ----------------------------------------------------

describe('SyncEngine.stop() — local changes it had taken on', () => {
  async function connectWithNotes(h: Harness, ...paths: string[]): Promise<void> {
    h.serverFiles = [];
    for (const [i, path] of paths.entries()) {
      h.vault.files.set(path, encode(path));
      h.serverFiles.push(serverFile(`f${i + 1}`, path, 'TEXT', await sha256Hex(path), path.length));
    }
    await connect(h);
  }

  it('queues a rename whose ack the disconnect cut off, and the next engine sends it', async () => {
    const h = buildHarness();
    await connectWithNotes(h, 'a.md');

    h.vault.files.set('b.md', encode('a.md'));
    h.vault.files.delete('a.md');
    void h.engine.handleVaultEvent({
      type: 'rename',
      bindingId: 'b1',
      oldPath: 'a.md',
      newPath: 'b.md',
      source: 'obsidian',
    });
    await flushAsync();
    // Never answered: stop takes the socket away first.
    expect(h.socket().pending('file:rename').payload).toMatchObject({ fileId: 'f1' });

    const mark = await stop(h);
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.dequeueOperations('b1')).toMatchObject([
      { opType: 'RENAME', filePath: 'a.md', newPath: 'b.md', payload: { fileId: 'f1' } },
    ]);

    // The server never got it: the next engine sends the rename and does not
    // upload `b.md` as a second file.
    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('a.md'), 4)];
    await connect(next);
    const rename = next.socket().pending('file:rename');
    expect(rename.payload).toMatchObject({ fileId: 'f1', filePath: 'a.md', newPath: 'b.md' });
    rename.ack({ ok: true });
    await flushAsync();
    expect(next.socket().emits.map((e) => e.event)).toEqual(['project:join', 'file:rename']);
    expect(next.log.pendingCount('b1')).toBe(0);
  });

  it('queues a delete stopped during its stale-delete check; the next engine sends it', async () => {
    const h = buildHarness();
    await connectWithNotes(h, 'a.md');
    h.vault.files.delete('a.md');
    const check = h.vault.gate('exists');

    const handled = h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'a.md',
      source: 'obsidian',
    });
    await check.reached;
    const mark = await stop(h);
    check.release();
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.dequeueOperations('b1')).toMatchObject([
      { opType: 'DELETE', filePath: 'a.md', payload: { fileId: 'f1' } },
    ]);

    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('a.md'), 4)];
    await connect(next);
    const del = next.socket().pending('file:delete');
    // The recheck flag stays in the queue — the server gets the plain delete.
    expect(del.payload).toMatchObject({ fileId: 'f1', filePath: 'a.md' });
    expect(del.payload).not.toHaveProperty('recheck');
  });

  it('drops such a delete when the file turns out to be on disk (a stray unlink)', async () => {
    const h = buildHarness();
    await connectWithNotes(h, 'a.md');
    // The file stays: the watcher saw the `unlink` half of an atomic write.
    const check = h.vault.gate('exists');

    const handled = h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'a.md',
      source: 'fs',
    });
    await check.reached;
    const mark = await stop(h);
    check.release();
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();
    expectQuietSince(h, mark);
    expect(h.log.pendingCount('b1')).toBe(1);

    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('a.md'), 4)];
    await connect(next);
    expect(next.socket().emits.map((e) => e.event)).toEqual(['project:join']);
    expect(next.log.pendingCount('b1')).toBe(0);
    expect(next.vault.text('a.md')).toBe('a.md');
  });

  it('queues a delete whose server-id lookup stop cut off; the next engine resolves the id', async () => {
    const h = buildHarness();
    await connect(h);
    // A live server file the index has not caught up with yet.
    h.serverFiles = [serverFile('f9', 'late.md', 'TEXT', 'h', 1)];
    const lookup = deferred<RequestUrlResponse>();
    h.routes.set('GET /api/projects/p1/files', () => lookup.promise);

    const handled = h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'late.md',
      source: 'obsidian',
    });
    await flushAsync();
    expect(h.requests.at(-1)?.path).toBe('/api/projects/p1/files');

    const mark = await stop(h);
    lookup.resolve(listing(h.serverFiles));
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.dequeueOperations('b1')).toMatchObject([
      { opType: 'DELETE', filePath: 'late.md', payload: { fileId: '' } },
    ]);

    const next = buildHarness(h);
    next.serverFiles = [serverFile('f9', 'late.md', 'TEXT', 'h', 1)];
    await connect(next);
    expect(next.socket().pending('file:delete').payload).toMatchObject({
      fileId: 'f9',
      filePath: 'late.md',
    });
  });

  it('queues the children of a folder delete that were not acknowledged yet', async () => {
    const h = buildHarness();
    await connectWithNotes(h, 'dir/a.md', 'dir/b.md', 'dir/c.md');
    for (const path of ['dir/a.md', 'dir/b.md', 'dir/c.md']) h.vault.files.delete(path);

    void h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'dir',
      source: 'obsidian',
      isFolder: true,
    });
    await flushAsync();
    h.socket().pending('file:delete', 'dir/a.md').ack({ ok: true });
    await flushAsync();
    // `dir/b.md` is on its way when the engine stops.
    h.socket().pending('file:delete', 'dir/b.md');

    const mark = await stop(h);
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.log.dequeueOperations('b1')).toMatchObject([
      { opType: 'DELETE', filePath: 'dir/b.md', payload: { fileId: 'f2' } },
      { opType: 'DELETE', filePath: 'dir/c.md', payload: { fileId: 'f3' } },
    ]);

    const next = buildHarness(h);
    next.serverFiles = [
      serverFile('f2', 'dir/b.md', 'TEXT', await sha256Hex('dir/b.md'), 8),
      serverFile('f3', 'dir/c.md', 'TEXT', await sha256Hex('dir/c.md'), 8),
    ];
    await connect(next);
    next.socket().pending('file:delete', 'dir/b.md').ack({ ok: true });
    await flushAsync();
    next.socket().pending('file:delete', 'dir/c.md').ack({ ok: true });
    await flushAsync();
    expect(next.log.pendingCount('b1')).toBe(0);
  });

  it('queues an edit it had not compared yet; the next engine drops it if nothing changed', async () => {
    const h = buildHarness();
    const synced = await connectWithImage(h);
    // A modify echo: the bytes are those of the last sync.
    const read = h.vault.gate('readBinary');

    const handled = h.engine.handleVaultEvent({
      type: 'modify',
      bindingId: 'b1',
      path: 'img.png',
      source: 'fs',
    });
    await read.reached;
    const mark = await stop(h);
    read.release();
    await expect(handled).resolves.toBeUndefined();
    await flushAsync();
    expectQuietSince(h, mark);
    expect(h.log.pendingCount('b1')).toBe(1);

    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'img.png', 'BINARY', await sha256Hex(synced), 3)];
    await connect(next);
    // Sending the old bytes again could overwrite a newer server version.
    expect(next.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(next.socket().emits.map((e) => e.event)).toEqual(['project:join']);
    expect(next.log.pendingCount('b1')).toBe(0);
  });
});

// -- Server changes on disk -----------------------------------------------------

describe('SyncEngine.stop() — a server change whose disk part has begun', () => {
  /** `a.md` on disk and on the server, synced. Returns its hash. */
  async function connectWithA(h: Harness): Promise<string> {
    h.vault.files.set('a.md', encode('hello'));
    const hash = await sha256Hex('hello');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 5)];
    await connect(h);
    return hash;
  }

  /** Start `stop()` while a disk step is held; `settled` says whether it has returned. */
  function stopWhileHeld(h: Harness): { stopping: Promise<void>; settled: () => boolean } {
    let done = false;
    const stopping = h.engine.stop().then(() => {
      done = true;
    });
    return { stopping, settled: () => done };
  }

  it('finishes a live rename stop lands in, and waits for it', async () => {
    const h = buildHarness();
    const hash = await connectWithA(h);
    const step = h.vault.gate('ensureParentFolder');

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', outcome: {}, log: eventLog });
    await step.reached;
    const before = markOf(h);
    const { stopping, settled } = stopWhileHeld(h);
    await flushAsync();
    expect(settled()).toBe(false);

    step.release();
    await stopping;
    // The whole move, disk and bookkeeping — and nothing that is not local.
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    expect(h.requests.length).toBe(before.requests);
    expect(h.socket().emits.length).toBe(before.emits);
    const mark = markOf(h);
    await flushAsync();
    expectQuietSince(h, mark);

    // The next engine finds the move done: no stray `a.md` to upload.
    const next = buildHarness(h);
    next.serverFiles = [serverFile('f1', 'b.md', 'TEXT', hash, 5)];
    await connect(next);
    expect(next.socket().emits.map((e) => e.event)).toEqual(['project:join']);
    expect([...next.vault.files.keys()]).toEqual(['b.md']);
  });

  it('finishes a rename onto a different local file, both of its moves', async () => {
    const h = buildHarness();
    await connectWithA(h);
    h.vault.files.set('b.md', encode('other local'));
    // Held: the first of the two moves, parking the local `b.md` aside.
    const step = h.vault.gate('rename');

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', outcome: {}, log: eventLog });
    await step.reached;
    const { stopping } = stopWhileHeld(h);
    step.release();
    await stopping;

    expect(h.vault.files.has('a.md')).toBe(false);
    expect(h.vault.text('b.md')).toBe('hello');
    const parked = [...h.vault.files.keys()].filter((p) => p !== 'b.md');
    expect(parked).toHaveLength(1);
    expect(h.vault.text(parked[0] ?? '')).toBe('other local');
  });

  it('finishes a binary update between its file meta and its write', async () => {
    const h = buildHarness();
    await connectWithImage(h);
    const server = new Uint8Array([4, 5, 6, 7]).buffer;
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(server));
    // The first `exists` is the conflict check; the second runs after the
    // file meta has taken the new hash.
    const step = h.vault.gate('exists', 1);

    h.socket().fire('file:updated-binary', { fileId: 'f1', contentHash: 'new', log: eventLog });
    await step.reached;
    const { stopping } = stopWhileHeld(h);
    step.release();
    await stopping;

    // Meta and disk agree: a meta for bytes the disk never got would upload
    // the old ones over the server's version on the next local edit.
    expect(h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(await sha256Hex(server));
    expect(h.vault.files.get('img.png')).toBe(server);
  });

  it('finishes a live delete stop lands in', async () => {
    const h = buildHarness();
    await connectWithImage(h);
    const step = h.vault.gate('exists');

    h.socket().fire('file:deleted', { fileId: 'f1', log: eventLog });
    await step.reached;
    const { stopping } = stopWhileHeld(h);
    step.release();
    await stopping;

    // Not replayed otherwise: the next listing no longer has the file, so no
    // catch-up would ever delete the local copy.
    expect(h.vault.files.has('img.png')).toBe(false);
    expect(h.log.getFileMeta('b1', 'img.png')).toBeNull();
  });

  it('changes nothing when the delete-conflict modal is answered after stop', async () => {
    const h = buildHarness();
    const local = await connectWithImage(h, 'hash-of-the-last-synced-version');

    h.socket().fire('file:deleted', { fileId: 'f1', log: eventLog });
    await flushAsync();
    expect(h.calls).toContain('modal.resolveDeleteConflict');

    const mark = await stop(h);
    h.modal.del.resolve('delete-local');
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.vault.files.get('img.png')).toBe(local);
    expect(h.log.getFileMeta('b1', 'img.png')).not.toBeNull();
  });
});

// -- Yjs snapshots --------------------------------------------------------------

describe('SyncEngine.stop() — disk snapshots of Yjs docs', () => {
  it('does not write the snapshot of a live yjs:update that stop overtakes', async () => {
    const h = buildHarness();
    const serverDoc = await connectWithNote(h, 'v1\n');
    const synced = h.log.getFileMeta('b1', 'note.md');

    const seen = Y.encodeStateVector(serverDoc);
    serverDoc.getText('content').insert(3, 'remote\n');
    const read = h.vault.gate('readText');
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(serverDoc, seen)),
    });
    await read.reached;

    const mark = await stop(h);
    read.release();
    await flushAsync();

    expectQuietSince(h, mark);
    expect(h.vault.text('note.md')).toBe('v1\n');
    expect(h.log.getFileMeta('b1', 'note.md')).toEqual(synced);
  });
});

// -- Queue replay ---------------------------------------------------------------

describe('SyncEngine — replaying a queued binary edit', () => {
  it('drops an edit whose file is gone instead of halting the drain on it', async () => {
    const h = buildHarness();
    h.vault.files.set('new.md', encode('fresh'));
    h.log.enqueueOperation('b1', {
      opType: 'UPDATE',
      filePath: 'gone.png',
      payload: { fileId: 'f7', contentHash: 'x', size: 1 },
    });
    h.log.enqueueOperation('b1', {
      opType: 'CREATE',
      filePath: 'new.md',
      payload: { fileType: 'TEXT' },
    });
    h.serverFiles = [serverFile('f7', 'gone.png', 'BINARY', 'x', 1)];

    await connect(h);
    // Behind it in the queue, `new.md` still goes out.
    expect(h.socket().pending('file:create', 'new.md')).toBeDefined();
    expect(h.requests.filter((r) => r.method === 'PUT')).toEqual([]);
  });
});

// -- Lifecycle ------------------------------------------------------------------

describe('SyncEngine.stop() — lifecycle', () => {
  it('never starts again: the manager spawns a fresh engine instead', async () => {
    const h = buildHarness();
    await connect(h);
    const mark = await stop(h);

    FakeSocket.last = null;
    await h.engine.start();

    expect(FakeSocket.last).toBeNull();
    expectQuietSince(h, mark);
  });

  it('queues no vault event that arrives after stop', async () => {
    const h = buildHarness();
    h.vault.files.set('a.md', encode('a'));
    h.vault.files.set('b.md', encode('b'));
    // A never-started engine queues offline edits…
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'a.md',
      source: 'obsidian',
    });
    expect(h.log.pendingCount('b1')).toBe(1);

    // …a stopped one takes nothing more.
    const mark = await stop(h);
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'b.md',
      source: 'obsidian',
    });

    expect(h.calls.slice(mark.calls)).toEqual([]);
    expect(h.log.dequeueOperations('b1').map((op) => op.filePath)).toEqual(['a.md']);
  });
});
