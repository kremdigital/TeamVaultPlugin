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
import type { ConflictResolver, BinaryConflictResolution } from '@/sync/conflict';
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

class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();

  getBasePath(): string {
    return '/vault';
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(this.expect(path));
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.expect(path);
  }
  async createText(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, encode(content));
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, encode(content));
  }
  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, content);
  }
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const buf = this.expect(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, buf);
  }
  async ensureParentFolder(): Promise<void> {
    /* no folders in memory */
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

const factory: SocketFactory = () => new FakeSocket();

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
  socket: () => FakeSocket;
  /** Every call the engine made into one of its dependencies. */
  calls: string[];
  /** Every REST request that reached the transport. */
  requests: Request[];
  /** REST routes, keyed `METHOD /path`; blob uploads fall back to `PUT /blobs`. */
  routes: Map<string, Responder>;
  /** What the server lists — read at request time. */
  serverFiles: ApiFile[];
  statuses: EngineStatus[];
  modal: { binary: Deferred<BinaryConflictResolution> };
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

function buildHarness(): Harness {
  const calls: string[] = [];
  const requests: Request[] = [];
  const routes = new Map<string, Responder>();
  const vault = new MemoryVault();
  const log = new OperationLog();
  const doc = new DocManager();
  const ra = new RecentlyApplied();

  // Filled in below; the routes and the modal read it when they are called.
  const state = {
    serverFiles: [] as ApiFile[],
    statuses: [] as EngineStatus[],
    modal: { binary: deferred<BinaryConflictResolution>() },
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
  const socket = new SocketClient({ server, clientId: 'device-1', factory });
  const resolver: ConflictResolver = {
    resolveBinaryConflict: () => h.modal.binary.promise,
    resolveDeleteConflict: async () => 'delete-local',
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
    calls,
    requests,
    routes,
    socket: (): FakeSocket => {
      if (!FakeSocket.last) throw new Error('socket not built — start the engine first');
      return FakeSocket.last;
    },
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

/** Stop the engine; everything recorded from here on is a late effect. */
async function stop(h: Harness): Promise<Mark> {
  await h.engine.stop();
  return {
    calls: h.calls.length,
    requests: h.requests.length,
    emits: FakeSocket.last?.emits.length ?? 0,
    statuses: h.statuses.length,
  };
}

function expectQuietSince(h: Harness, mark: Mark): void {
  expect(h.calls.slice(mark.calls)).toEqual([]);
  expect(h.requests.slice(mark.requests)).toEqual([]);
  expect((FakeSocket.last?.emits ?? []).slice(mark.emits).map((e) => e.event)).toEqual([]);
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
  async function connectWithImage(h: Harness, storedHash?: string): Promise<ArrayBuffer> {
    const local = new Uint8Array([9, 9, 9]).buffer;
    h.vault.files.set('img.png', local);
    h.serverFiles = [
      serverFile('f1', 'img.png', 'BINARY', storedHash ?? (await sha256Hex(local)), 3),
    ];
    await connect(h);
    return local;
  }

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

  it('neither emits nor queues a binary edit whose upload finishes after stop', async () => {
    const h = buildHarness();
    await connectWithImage(h);
    const upload = deferred<RequestUrlResponse>();
    h.routes.set('PUT /blobs', () => upload.promise);

    h.vault.files.set('img.png', new Uint8Array([1, 1, 1, 1]).buffer);
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

    expectQuietSince(h, mark);
    expect(h.log.pendingCount('b1')).toBe(0);
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
