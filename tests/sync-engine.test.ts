import { SyncEngine, type EngineStatus, type SyncEngineDeps } from '@/sync/engine';
import Database from 'better-sqlite3';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ApiClient, type RequestUrlResponse } from '@/client/api';
import {
  SocketClient,
  type SocketFactory,
  type SocketLike,
  type SocketFactoryOptions,
} from '@/client/socket';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import { Logger, formatLogEntry, type LogEntry, type LogSink } from '@/utils/logger';

/**
 * In-memory vault adapter — file map keyed by vault path. Binary is stored
 * as ArrayBuffer; text as UTF-8 strings; both reads return the matching
 * representation regardless of which write created the entry.
 */
class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
  base = '/vault';

  getBasePath(): string {
    return this.base;
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
    this.files.set(path, new TextEncoder().encode(content).buffer as ArrayBuffer);
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(content).buffer as ArrayBuffer);
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
    /* no-op for the in-memory adapter */
  }
  async list(folderPath: string): Promise<string[]> {
    const norm = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const paths = [...this.files.keys()];
    if (norm === '') return paths;
    return paths.filter((p) => p === norm || p.startsWith(`${norm}/`));
  }

  private expect(path: string): ArrayBuffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`missing file ${path}`);
    return buf;
  }
}

/** Records emitted ack-able events so tests can resolve them. */
class FakeSocket implements SocketLike {
  connected = false;
  emits: Array<{ event: string; args: unknown[] }> = [];
  static last: FakeSocket | null = null;
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
    this.emits.push({ event, args });
    return this;
  }
  connect(): SocketLike {
    this.connected = true;
    this.fire('connect');
    return this;
  }
  disconnect(): SocketLike {
    this.connected = false;
    this.fire('disconnect', 'manual');
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  /** Resolve the ack of the last emit with `ok: true` and an arbitrary outcome. */
  ackOk(extra: Record<string, unknown> = {}): void {
    const last = this.emits[this.emits.length - 1];
    const ack = last?.args[last.args.length - 1] as ((r: unknown) => void) | undefined;
    if (ack) ack({ ok: true, ...extra });
  }
  /** Resolve the ack of the last emit with `ok: false` and an error code. */
  ackErr(error: string): void {
    const last = this.emits[this.emits.length - 1];
    const ack = last?.args[last.args.length - 1] as ((r: unknown) => void) | undefined;
    if (ack) ack({ ok: false, error });
  }
}

const factory: SocketFactory = (_url: string, _options: SocketFactoryOptions) => new FakeSocket();

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

interface Harness {
  engine: SyncEngine;
  vault: MemoryVault;
  /** Lazy — the FakeSocket only exists after the first `socket.connect()`. */
  socket: () => FakeSocket;
  api: ApiClient;
  apiCalls: Array<{ url: string; method?: string | undefined }>;
  log: OperationLog;
  doc: DocManager;
  ra: RecentlyApplied;
  apiResponses: Map<string, () => RequestUrlResponse>;
}

function buildHarness(opts: { logger?: Logger; snapshotMs?: number } = {}): Harness {
  const vault = new MemoryVault();
  const log = new OperationLog({ filePath: ':memory:', Database });
  const doc = new DocManager();
  const ra = new RecentlyApplied();
  const apiCalls: Array<{ url: string; method?: string | undefined }> = [];
  const apiResponses = new Map<string, () => RequestUrlResponse>();

  // Default empty `getProjectFiles` response — tests override per-case.
  apiResponses.set('GET /api/projects/p1/files', () => ({
    status: 200,
    json: { files: [] },
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
    text: '',
  }));

  const api = new ApiClient(server, async (params) => {
    apiCalls.push({ url: params.url, method: params.method });
    const path = params.url.replace(server.url, '');
    const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
    if (!responder) throw new Error(`unexpected request: ${params.method ?? 'GET'} ${path}`);
    return responder();
  });

  const socket = new SocketClient({ server, clientId: 'device-1', factory });
  const deps: SyncEngineDeps = {
    binding,
    server,
    clientId: 'device-1',
    vault,
    operationLog: log,
    docManager: doc,
    recentlyApplied: ra,
    apiClient: api,
    socketClient: socket,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.snapshotMs !== undefined ? { diskSnapshotDebounceMs: opts.snapshotMs } : {}),
  };
  const engine = new SyncEngine(deps);

  return {
    engine,
    vault,
    socket: () => {
      if (!FakeSocket.last) throw new Error('socket not yet built — call engine.start() first');
      return FakeSocket.last;
    },
    api,
    apiCalls,
    log,
    doc,
    ra,
    apiResponses,
  };
}

afterEach(() => {
  FakeSocket.last = null;
});

/** Run every queued microtask + macro tick so chains of awaits resolve. */
async function flushAsync(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe('SyncEngine — lifecycle', () => {
  it('starts in stopped state and reports status transitions', async () => {
    const h = buildHarness();
    const seen: EngineStatus[] = [];
    h.engine.onStatus((s) => seen.push(s));
    await h.engine.start();
    // The join emit fires synchronously inside the connect callback.
    expect(h.socket().emits[0]?.event).toBe('project:join');
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();
    expect(seen).toContain('connecting');
    expect(seen).toContain('syncing');
    expect(seen).toContain('connected');
    await h.engine.stop();
    expect(h.engine.getStatus()).toBe('stopped');
  });
});

describe('SyncEngine — local create', () => {
  it('emits file:create for an unseen file and serializes the buffer as number[]', async () => {
    const h = buildHarness();
    h.vault.files.set('note.md', new TextEncoder().encode('hello').buffer as ArrayBuffer);
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    const lastBefore = h.socket().emits.length - 1;
    const promise = h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    // Wait for the chain of awaits inside handleLocalCreate (read + hash)
    // to surface the actual emit before we ack it.
    await flushAsync();
    const emit = h.socket().emits[lastBefore + 1];
    expect(emit?.event).toBe('file:create');
    const payload = emit?.args[0] as { filePath: string; data: number[]; fileType: string };
    expect(payload.filePath).toBe('note.md');
    expect(payload.fileType).toBe('TEXT');
    expect(payload.data).toEqual([104, 101, 108, 108, 111]); // "hello"
    h.socket().ackOk({ outcome: 'created' });
    await promise;
  });
});

describe('SyncEngine — local delete', () => {
  it('emits file:delete with the known fileId and updates the local index', async () => {
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    const before = h.socket().emits.length;
    const promise = h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    await flushAsync();
    const ackArg = h.socket().emits[before];
    expect(ackArg?.event).toBe('file:delete');
    const payload = ackArg?.args[0] as { fileId: string; filePath: string };
    expect(payload.fileId).toBe('f1');
    expect(payload.filePath).toBe('note.md');
    h.socket().ackOk({ outcome: 'deleted' });
    await promise;
  });
});

describe('SyncEngine — offline queue', () => {
  it('queues a CREATE in pending_operations when the socket is disconnected', async () => {
    const h = buildHarness();
    h.vault.files.set('note.md', new TextEncoder().encode('hi').buffer as ArrayBuffer);
    // Don't start — socket is still disconnected.
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    expect(h.log.pendingCount('b1')).toBe(1);
    const ops = h.log.dequeueOperations('b1');
    expect(ops[0]?.opType).toBe('CREATE');
    expect(ops[0]?.filePath).toBe('note.md');
  });

  it('drains the queue on reconnect', async () => {
    const h = buildHarness();
    h.vault.files.set('note.md', new TextEncoder().encode('hi').buffer as ArrayBuffer);
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    expect(h.log.pendingCount('b1')).toBe(1);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] }); // join ack
    await flushAsync(20); // give the background flushPending a chance to surface

    // engine.flushPendingOperations runs after join and emits a file:create.
    const replay = h.socket().emits.find((e) => e.event === 'file:create');
    expect(replay).toBeDefined();
    h.socket().ackOk({ outcome: 'created' });
    await flushAsync();
  });
});

describe('SyncEngine — server → local', () => {
  it('applies a server delete by removing the local file', async () => {
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    h.vault.files.set('note.md', new ArrayBuffer(0));
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    h.socket().fire('file:deleted', {
      fileId: 'f1',
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync();

    expect(await h.vault.exists('note.md')).toBe(false);
    expect(h.ra.has('note.md')).toBe(true); // engine marked it
  });

  it('applies a yjs:update by routing it to the doc manager', async () => {
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '0',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    // Build a Yjs update from a sibling doc and feed it in via the socket.
    const Y = await import('yjs');
    const source = new Y.Doc();
    source.getText('content').insert(0, 'hello yjs');
    const update = Y.encodeStateAsUpdate(source);

    h.socket().fire('yjs:update', { fileId: 'f1', update: Array.from(update) });
    await flushAsync();

    expect(h.doc.getText('b1', 'note.md')).toBe('hello yjs');
  });
});

describe('SyncEngine — vector clock persistence', () => {
  it('bumps the local clock and writes it through the operation log', async () => {
    const h = buildHarness();
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();
    // Place the file AFTER start so the initial-push pass doesn't find it
    // and the only CREATE that bumps the clock is the watcher event below.
    h.vault.files.set('a.md', new TextEncoder().encode('x').buffer as ArrayBuffer);

    const promise = h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync();
    h.socket().ackOk({ outcome: 'created' });
    await promise;

    const state = h.log.getBindingState('b1');
    expect(state?.lastVectorClock).toEqual({ 'device-1': 1 });
  });
});

describe('SyncEngine — ignores events outside its binding', () => {
  it('drops events for other bindings', async () => {
    const h = buildHarness();
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b2',
      path: 'note.md',
      source: 'obsidian',
    });
    // Without our binding hit, no operation is queued. The socket isn't
    // even constructed because we never called `engine.start()`.
    expect(h.log.pendingCount('b1')).toBe(0);
  });
});

describe('SyncEngine — binary conflict resolver', () => {
  it('renames the local file aside on keep-both', async () => {
    // Set up: server already knows about a binary file. The local copy on
    // disk is different (uncommitted edit). Server pushes a fresh UPDATE.
    const localBytes = new Uint8Array([1, 2, 3]).buffer;
    const serverBytes = new Uint8Array([9, 9, 9]).buffer;
    const sha256 = (await import('@/sync/hash')).sha256Hex;
    const localHash = await sha256(localBytes);
    const serverHash = await sha256(serverBytes);

    const vault = new MemoryVault();
    vault.files.set('image.png', localBytes);
    const log = new OperationLog({ filePath: ':memory:', Database });
    const doc = new DocManager();
    const ra = new RecentlyApplied();
    const apiResponses = new Map<string, () => RequestUrlResponse>();
    apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'image.png',
            fileType: 'BINARY',
            // Stored hash differs from both local and server: a 3-way conflict.
            contentHash: 'h-stored',
            size: '3',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    apiResponses.set('GET /api/projects/p1/files/f1', () => ({
      status: 200,
      json: null,
      arrayBuffer: serverBytes,
      headers: {},
      text: '',
    }));

    const api = new ApiClient(server, async (params) => {
      const path = params.url.replace(server.url, '');
      const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
      if (!responder) throw new Error(`unexpected: ${params.method ?? 'GET'} ${path}`);
      return responder();
    });

    const conflictResolver = {
      resolveBinaryConflict: jest.fn(async () => 'keep-both' as const),
      resolveDeleteConflict: jest.fn(async () => 'delete-local' as const),
    };

    const socket = new SocketClient({ server, clientId: 'device-1', factory });
    const engine = new SyncEngine({
      binding,
      server,
      clientId: 'device-1',
      vault,
      operationLog: log,
      docManager: doc,
      recentlyApplied: ra,
      apiClient: api,
      socketClient: socket,
      conflictResolver,
      now: () => 1700000000000,
    });

    await engine.start();
    if (!FakeSocket.last) throw new Error('socket not built');
    FakeSocket.last.ackOk({ operations: [], yjsDocs: [] }); // join ack
    await flushAsync();

    FakeSocket.last.fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: serverHash,
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    expect(conflictResolver.resolveBinaryConflict).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'image.png' }),
    );
    // Original path now has the server bytes.
    const finalLocal = await vault.readBinary('image.png');
    expect(await sha256(finalLocal)).toBe(serverHash);
    // The user's local edits were saved aside.
    expect(vault.files.has('image.conflict-1700000000000.png')).toBe(true);
    const aside = await vault.readBinary('image.conflict-1700000000000.png');
    expect(await sha256(aside)).toBe(localHash);

    await engine.stop();
  });
});

describe('SyncEngine — delete conflict resolver', () => {
  it('emits file:create instead of deleting on restore-server', async () => {
    const localBytes = new Uint8Array([7, 7, 7]).buffer;
    const sha256 = (await import('@/sync/hash')).sha256Hex;

    const vault = new MemoryVault();
    vault.files.set('important.png', localBytes);
    const log = new OperationLog({ filePath: ':memory:', Database });
    const doc = new DocManager();
    const ra = new RecentlyApplied();
    const apiResponses = new Map<string, () => RequestUrlResponse>();
    apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'important.png',
            fileType: 'BINARY',
            contentHash: 'h-stored', // mismatch → delete conflict
            size: '3',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    const api = new ApiClient(server, async (params) => {
      const path = params.url.replace(server.url, '');
      const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
      if (!responder) throw new Error(`unexpected: ${params.method ?? 'GET'} ${path}`);
      return responder();
    });

    const conflictResolver = {
      resolveBinaryConflict: jest.fn(async () => 'keep-server' as const),
      resolveDeleteConflict: jest.fn(async () => 'restore-server' as const),
    };

    const socket = new SocketClient({ server, clientId: 'device-1', factory });
    const engine = new SyncEngine({
      binding,
      server,
      clientId: 'device-1',
      vault,
      operationLog: log,
      docManager: doc,
      recentlyApplied: ra,
      apiClient: api,
      socketClient: socket,
      conflictResolver,
    });

    await engine.start();
    if (!FakeSocket.last) throw new Error('socket not built');
    FakeSocket.last.ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    const before = FakeSocket.last.emits.length;
    FakeSocket.last.fire('file:deleted', {
      fileId: 'f1',
      log: { id: 'l1', vectorClock: {}, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    expect(conflictResolver.resolveDeleteConflict).toHaveBeenCalled();
    // The engine emitted file:create instead of accepting the delete.
    const restoreEmit = FakeSocket.last.emits[before];
    expect(restoreEmit?.event).toBe('file:create');
    // Local file is still there.
    expect(await vault.exists('important.png')).toBe(true);
    expect(await sha256(await vault.readBinary('important.png'))).toBe(await sha256(localBytes));

    await engine.stop();
  });
});

describe('SyncEngine — S4 offline drain → reconnect', () => {
  it('does not re-upload a queued CREATE during the post-drain initial-push pass', async () => {
    const h = buildHarness();
    h.vault.files.set('note.md', new TextEncoder().encode('offline edit').buffer as ArrayBuffer);

    // Queue a CREATE while offline (socket not started yet).
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'note.md',
      source: 'obsidian',
    });
    expect(h.log.pendingCount('b1')).toBe(1);

    // Reconnect.
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] }); // join ack
    await flushAsync(20); // let the drain surface its file:create emit

    // The drain replayed the queued CREATE — exactly one file:create so far.
    const afterDrain = h.socket().emits.filter((e) => e.event === 'file:create');
    expect(afterDrain).toHaveLength(1);

    // Ack it with a real outcome so the engine records the file in its index.
    h.socket().ackOk({ outcome: { fileId: 'f1', path: 'note.md' } });
    await flushAsync(20); // let the drain finish + the initial-push pass run

    // The initial-push pass must NOT re-upload note.md — the queued CREATE
    // already synced it. A second file:create here is the S4 conflict-twin
    // bug (initialPush racing the pending-queue drain).
    const total = h.socket().emits.filter((e) => e.event === 'file:create');
    expect(total).toHaveLength(1);
    expect(h.log.pendingCount('b1')).toBe(0);
  });

  it('collapses duplicate offline CREATEs for one path into one CREATE + a modify', async () => {
    const Y = await import('yjs');
    const h = buildHarness();
    // Simulate create-then-edit while offline: the content captured at
    // enqueue time differs from the content on disk at replay time.
    h.vault.files.set('draft.md', new TextEncoder().encode('v1').buffer as ArrayBuffer);
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'draft.md',
      source: 'obsidian',
    });
    h.vault.files.set('draft.md', new TextEncoder().encode('v2 edited').buffer as ArrayBuffer);
    // A modify with no server record yet promotes to a second queued CREATE.
    await h.engine.handleVaultEvent({
      type: 'modify',
      bindingId: 'b1',
      path: 'draft.md',
      source: 'obsidian',
    });
    expect(h.log.pendingCount('b1')).toBe(2);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(20);

    // First replayed CREATE ships the fresh on-disk bytes.
    const creates = h.socket().emits.filter((e) => e.event === 'file:create');
    expect(creates).toHaveLength(1);
    const sent = creates[0]?.args[0] as { contentHash: string; data: number[] };
    expect(new TextDecoder().decode(Uint8Array.from(sent.data))).toBe('v2 edited');
    h.socket().ackOk({ outcome: { fileId: 'f1', path: 'draft.md' } });
    await flushAsync(20);

    // The ack recorded draft.md in the file index, so the second queued
    // CREATE must NOT replay as another file:create — the server would
    // conflict-rename a same-path re-create with a diverged hash into
    // `draft.conflict-<clientId>.md` (the 2026-06-12 incident). It routes
    // through the modify path instead (Yjs diff for this TEXT file).
    const creates2 = h.socket().emits.filter((e) => e.event === 'file:create');
    expect(creates2).toHaveLength(1);
    expect(h.log.pendingCount('b1')).toBe(0);
    // The modify defers until the server's CREATE-time seed hydrates the
    // doc (a diff into the still-empty doc would be a second independent
    // insertion of the content — the doubled-file corruption). The real
    // server broadcasts the seed to the whole room, sender included:
    const seed = new Y.Doc();
    seed.getText('content').insert(0, 'v2 edited');
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(seed)),
    });
    seed.destroy();
    await flushAsync(20);
    expect(h.doc.getText('b1', 'draft.md')).toBe('v2 edited');
  });

  it('pushes local-only Yjs ops back to the server on reconnect', async () => {
    const Y = await import('yjs');
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '0',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    // Simulate offline edits sitting in y-indexeddb: the docManager has
    // local content the server has never seen.
    h.doc.setText('b1', 'note.md', 'offline-only edits');

    await h.engine.start();

    // Server is at an empty Y.Doc — sync1 + stateVector both reflect that.
    const emptyDoc = new Y.Doc();
    const sync1 = Array.from(Y.encodeStateAsUpdate(emptyDoc));
    const stateVector = Array.from(Y.encodeStateVector(emptyDoc));
    emptyDoc.destroy();
    h.socket().ackOk({
      operations: [],
      yjsDocs: [{ fileId: 'f1', sync1, stateVector }],
    });
    await flushAsync(20);

    // The engine must have emitted yjs:update carrying the offline ops.
    // Without this fix the server stayed empty, then `applyYjsUpdate` saw
    // every subsequent live edit as a no-op replay (`changed:false`,
    // no broadcast).
    const emits = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(emits.length).toBeGreaterThanOrEqual(1);
    const payload = emits[0]?.args[0] as { fileId: string; update: number[] };
    expect(payload.fileId).toBe('f1');
    expect(payload.update.length).toBeGreaterThan(2);

    // Decoding the emitted update on a fresh doc should reproduce the
    // exact offline content.
    const target = new Y.Doc();
    Y.applyUpdate(target, Uint8Array.from(payload.update));
    expect(target.getText('content').toString()).toBe('offline-only edits');
    target.destroy();
    await h.engine.stop();
  });

  it('applies a streamed Yjs catch-up and only connects after the done batch', async () => {
    const Y = await import('yjs');
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '0',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    // Offline edits the server has never seen — must be pushed back on catch-up.
    h.doc.setText('b1', 'note.md', 'offline-only edits');

    await h.engine.start();
    // Server signals streaming (no inline yjsDocs).
    h.socket().ackOk({ operations: [], yjsStream: true, yjsCount: 1 });
    await flushAsync(10);

    // The catch-up is streaming — status must NOT reach connected until `done`.
    expect(h.engine.getStatus()).not.toBe('connected');

    const emptyDoc = new Y.Doc();
    const sync1 = Array.from(Y.encodeStateAsUpdate(emptyDoc));
    const stateVector = Array.from(Y.encodeStateVector(emptyDoc));
    emptyDoc.destroy();
    h.socket().fire('yjs:catchup', {
      projectId: 'p1',
      docs: [{ fileId: 'f1', sync1, stateVector }],
      done: true,
    });
    await flushAsync(20);

    // Now connected…
    expect(h.engine.getStatus()).toBe('connected');
    // …and the offline ops were pushed back (same round-trip as inline).
    const emits = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(emits.length).toBeGreaterThanOrEqual(1);
    const payload = emits[0]?.args[0] as { fileId: string; update: number[] };
    expect(payload.fileId).toBe('f1');
    const target = new Y.Doc();
    Y.applyUpdate(target, Uint8Array.from(payload.update));
    expect(target.getText('content').toString()).toBe('offline-only edits');
    target.destroy();
    await h.engine.stop();
  });

  it('ignores streamed catch-up batches for a different project', async () => {
    const h = buildHarness();
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsStream: true, yjsCount: 0 });
    await flushAsync(10);

    // A `done` for some other project must not complete our catch-up.
    h.socket().fire('yjs:catchup', { projectId: 'OTHER', docs: [], done: true });
    await flushAsync(10);
    expect(h.engine.getStatus()).not.toBe('connected');

    // Our own `done` does.
    h.socket().fire('yjs:catchup', { projectId: 'p1', docs: [], done: true });
    await flushAsync(10);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('skips the reconnect push when the local doc has nothing the server is missing', async () => {
    const Y = await import('yjs');
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    // Local doc starts empty — nothing offline. After applying server's
    // sync1, the local state vector matches the server's exactly.
    await h.engine.start();

    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, 'hello');
    const sync1 = Array.from(Y.encodeStateAsUpdate(serverDoc));
    const stateVector = Array.from(Y.encodeStateVector(serverDoc));
    serverDoc.destroy();
    h.socket().ackOk({
      operations: [],
      yjsDocs: [{ fileId: 'f1', sync1, stateVector }],
    });
    await flushAsync(20);

    // No yjs:update emit — the server already had everything the client has.
    const emits = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(emits).toHaveLength(0);
    await h.engine.stop();
  });

  it('refreshFileIndex preserves the client-stored contentHash for known files', async () => {
    // If refreshFileIndex blindly overwrites `storedHash` with the server's
    // current hash, `detectBinaryConflict` sees stored == server for every
    // remote update and silently adopts it — local edits get clobbered
    // without a modal. The fix: preserve `storedHash` from the local
    // operationLog mirror; only fall back to the server's hash for files
    // we've never seen before.
    const h = buildHarness();
    // Pre-seed the local operation log with an OLD hash for image.png.
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'image.png',
      serverFileId: 'f-img',
      contentHash: 'OLD_CLIENT_HASH',
      size: 100,
      fileType: 'BINARY',
      lastSyncedAt: 1700000000000,
    });
    // Server reports a different hash for the same file.
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f-img',
            path: 'image.png',
            fileType: 'BINARY',
            contentHash: 'NEW_SERVER_HASH',
            size: '200',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
          // A file we've never seen before — fileIndex should adopt the
          // server's hash as the baseline.
          {
            id: 'f-new',
            path: 'new.png',
            fileType: 'BINARY',
            contentHash: 'FRESH_HASH',
            size: '50',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    // The known file keeps its client-stored hash.
    const imgMeta = h.log.getFileMeta('b1', 'image.png');
    expect(imgMeta?.contentHash).toBe('OLD_CLIENT_HASH');
    expect(imgMeta?.size).toBe(100);
    // The fresh file picks up the server's hash.
    const newMeta = h.log.getFileMeta('b1', 'new.png');
    expect(newMeta?.contentHash).toBe('FRESH_HASH');
    await h.engine.stop();
  });

  it('updates meta before writing to disk so watcher echoes short-circuit', async () => {
    // chokidar AND Obsidian's `vault.on('modify')` BOTH fire for the same
    // write, and `recentlyApplied.take` only consumes one of them. The
    // second event falls through to `handleLocalModify`, where the only
    // guard against a re-emit is `if (hash === meta.contentHash) return`.
    // If meta is still the OLD hash at that moment, the echo emits an
    // UPDATE → server applies → broadcasts → `applyServerUpdateBinary`
    // runs again → another disk write → another echo → infinite loop.
    // The fix updates meta BEFORE the disk write so the echo sees the new
    // hash and short-circuits.
    const initialBytes = new TextEncoder().encode('initial-bytes').buffer as ArrayBuffer;
    const newBytes = new TextEncoder().encode('server-updated-bytes').buffer as ArrayBuffer;
    const sha256 = (await import('@/sync/hash')).sha256Hex;
    const initialHash = await sha256(initialBytes);
    const newHash = await sha256(newBytes);

    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f-img',
            path: 'img.png',
            fileType: 'BINARY',
            contentHash: initialHash,
            size: '13',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    h.apiResponses.set('GET /api/projects/p1/files/f-img', () => ({
      status: 200,
      json: null,
      arrayBuffer: newBytes,
      headers: {},
      text: '',
    }));
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'img.png',
      serverFileId: 'f-img',
      contentHash: initialHash,
      size: 13,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    h.vault.files.set('img.png', initialBytes);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    // Intercept writeBinary to fire the inevitable second watcher event
    // INSIDE the write — simulating chokidar firing while the engine is
    // mid-apply on a path Obsidian already consumed via recentlyApplied.
    const origWrite = h.vault.writeBinary.bind(h.vault);
    h.vault.writeBinary = async (path: string, buf: ArrayBuffer): Promise<void> => {
      await origWrite(path, buf);
      if (path === 'img.png') {
        await h.engine.handleVaultEvent({
          type: 'modify',
          bindingId: 'b1',
          path,
          source: 'fs',
        });
      }
    };

    const emitsBefore = h.socket().emits.length;
    h.socket().fire('file:updated-binary', {
      fileId: 'f-img',
      contentHash: newHash,
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    // The watcher echo must NOT have produced a second UPDATE emit. With
    // the pre-fix ordering (meta-after-write), handleLocalModify here
    // would see disk=newBytes, meta=initialHash → emit → loop.
    const echoEmits = h
      .socket()
      .emits.slice(emitsBefore)
      .filter((e) => e.event === 'file:update-binary');
    expect(echoEmits).toHaveLength(0);
    await h.engine.stop();
  });

  it('catch-up replay skips DELETE for a fileId that is currently live on the server', async () => {
    // Scenario: the catch-up's operation log returns a historical DELETE
    // for a file that has since been re-created (tombstone-revival
    // reuses the same `fileId`, so the stale op's fileId matches the
    // freshly-refreshed fileIndex entry). Without the guard,
    // `applyServerDelete` would either wipe the local copy or pop a
    // spurious delete-vs-update modal. With the guard, the DELETE is
    // dropped and the file stays intact.
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f-survivor',
            path: 'live-test.md',
            fileType: 'TEXT',
            contentHash: 'server-hash',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    h.vault.files.set('live-test.md', new TextEncoder().encode('local').buffer as ArrayBuffer);

    // Spy on the resolver — it MUST NOT be called for this stale op.
    const resolver = {
      resolveBinaryConflict: jest.fn(async () => 'keep-server' as const),
      resolveDeleteConflict: jest.fn(async () => 'delete-local' as const),
    };
    const log = new OperationLog({ filePath: ':memory:', Database });
    const doc = new DocManager();
    const ra = new RecentlyApplied();
    const socket = new SocketClient({ server, clientId: 'device-1', factory });
    const apiResponses = new Map<string, () => RequestUrlResponse>();
    apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f-survivor',
            path: 'live-test.md',
            fileType: 'TEXT',
            contentHash: 'server-hash',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    const api = new ApiClient(server, async (params) => {
      const path = params.url.replace(server.url, '');
      const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
      if (!responder) throw new Error(`unexpected: ${params.method ?? 'GET'} ${path}`);
      return responder();
    });
    const vault = new MemoryVault();
    vault.files.set(
      'live-test.md',
      new TextEncoder().encode('local-divergent').buffer as ArrayBuffer,
    );
    const engine = new SyncEngine({
      binding,
      server,
      clientId: 'device-1',
      vault,
      operationLog: log,
      docManager: doc,
      recentlyApplied: ra,
      apiClient: api,
      socketClient: socket,
      conflictResolver: resolver,
    });

    await engine.start();
    if (!FakeSocket.last) throw new Error('socket not built');
    FakeSocket.last.ackOk({
      operations: [
        {
          id: 'op-stale-delete',
          opType: 'DELETE',
          filePath: 'live-test.md',
          newPath: null,
          authorId: 'u1',
          vectorClock: { someClient: 1 },
          payload: { fileId: 'f-survivor' },
          createdAt: '2026-01-01',
        },
      ],
      yjsDocs: [],
    });
    await flushAsync(20);

    // Modal must NOT have been triggered, file must still be on disk.
    expect(resolver.resolveDeleteConflict).not.toHaveBeenCalled();
    expect(await vault.exists('live-test.md')).toBe(true);
    await engine.stop();
  });

  it('applyServerRename drops the stale source when the destination already exists', async () => {
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'old.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '1',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    // Both the rename source AND destination exist on disk — the situation
    // the initial-push race used to create. `adapter.rename` would throw
    // "Destination file already exists" and crash the engine to `error`.
    h.vault.files.set('old.md', new TextEncoder().encode('a').buffer as ArrayBuffer);
    h.vault.files.set('new.md', new TextEncoder().encode('b').buffer as ArrayBuffer);

    const seen: EngineStatus[] = [];
    h.engine.onStatus((s) => seen.push(s));
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    h.socket().fire('file:renamed', {
      fileId: 'f1',
      newPath: 'new.md',
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    // No crash to `error`; the stale source is gone, the destination stays.
    expect(seen).not.toContain('error');
    expect(await h.vault.exists('old.md')).toBe(false);
    expect(await h.vault.exists('new.md')).toBe(true);
    await h.engine.stop();
  });

  it('does not phantom-CREATE on a yjs:update snapshot write watcher echo', async () => {
    // Reproduces the S6 manual-test bug: when vault A reloads and its
    // reconnect-push fan-out broadcasts a yjs:update to vault B, vault
    // B's snapshotDocToDisk writes the text to disk. On Windows that
    // write can fan into chokidar `unlink` + `add` (the atomic-rename
    // split), and Obsidian's `vault.on('modify')` fires too. With the
    // pre-fix single-consume `recentlyApplied.take`, only one of the
    // three echoes was suppressed: the leftover `unlink` cascaded into
    // a `file:delete` round-trip that stripped the path from fileIndex,
    // and the next `add` then found an empty index and emitted a
    // phantom `file:create` — which the server conflict-renamed into
    // `<path>.conflict-<clientId>.<ext>`.
    const Y = await import('yjs');
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'from-shell-2.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '0',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    // The file is already on disk — both vaults were in-sync before the
    // other side's reload.
    h.vault.files.set(
      'from-shell-2.md',
      new TextEncoder().encode('synced content').buffer as ArrayBuffer,
    );

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(20);

    // Wire the chokidar-style echoes inline with the disk write. The
    // production order is: Obsidian onModify (consumes 1) → chokidar
    // `unlink` (consumes 2) → chokidar `add` (consumes 3). Production
    // delivers them through the watcher's `take`, but at the engine
    // layer we drive them as direct `handleVaultEvent` calls so we can
    // assert the engine's emit set without spinning up the FS watcher.
    const origWriteText = h.vault.writeText.bind(h.vault);
    h.vault.writeText = async (path: string, text: string): Promise<void> => {
      await origWriteText(path, text);
      if (path === 'from-shell-2.md') {
        // The first three takes are consumed by the watcher (the
        // engine's mark sets count=3); from the engine's perspective
        // no events arrive. Simulate the *production* edge case where
        // chokidar's `add` still leaks past the budget — a fourth
        // event the engine must not turn into a phantom `file:create`.
        h.ra.take(path);
        h.ra.take(path);
        h.ra.take(path);
        await h.engine.handleVaultEvent({
          type: 'create',
          bindingId: 'b1',
          path,
          source: 'fs',
        });
      }
    };

    // Vault A's reconnect push lands as a yjs:update on the wire.
    const remote = new Y.Doc();
    remote.getText('content').insert(0, 'synced content');
    const update = Y.encodeStateAsUpdate(remote);
    remote.destroy();

    const emitsBefore = h.socket().emits.length;
    h.socket().fire('yjs:update', { fileId: 'f1', update: Array.from(update) });
    // Allow the 500 ms snapshot debouncer + the synthesised watcher
    // event to surface.
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    await flushAsync(20);

    // The phantom emit would have been `file:create` for 'from-shell-2.md'.
    const creates = h
      .socket()
      .emits.slice(emitsBefore)
      .filter((e) => e.event === 'file:create');
    expect(creates).toEqual([]);
    // And the fileIndex must STILL know about the path — the stale
    // delete that previously stripped it out is what gave the next
    // event nothing to short-circuit against.
    expect(h.engine.getFileIdForPath('from-shell-2.md')).toBe('f1');
    await h.engine.stop();
  });

  it('keep-both: no phantom file:delete or file:create on watcher echoes', async () => {
    // S6 ветка C reproduction. When keep-both resolves a binary conflict
    // it (1) renames the local image.png aside and (2) writes the server's
    // bytes back to image.png. Each of those disk operations fans out into
    // multiple watcher echoes — Obsidian's vault event + chokidar's FS
    // event — that the engine must suppress via `recentlyApplied.mark`.
    //
    // The original bug: the keep-both branch only marked the `aside` path,
    // so chokidar's `unlink(image.png)` from the rename leaked into
    // `handleLocalDelete('image.png')` → emit `file:delete` → server
    // soft-deleted image.png. The stale-delete guard couldn't help — at
    // the moment the unlink fires, image.png genuinely IS gone from disk
    // (the rename just moved it). The marks are the only line of defense.
    //
    // This test reproduces the leak by hijacking vault.rename and
    // vault.createBinary to fire the chokidar-equivalent events inline,
    // gated by `ra.take` exactly as the production fs-watcher does. With
    // the engine marking both paths (ECHO_COUNT_RENAME each) plus the
    // post-rename createBinary (ECHO_COUNT_CREATE), every take returns
    // true and no leaked event reaches the engine.
    const localBytes = new Uint8Array([1, 2, 3]).buffer;
    const serverBytes = new Uint8Array([9, 9, 9, 9]).buffer;
    const sha256 = (await import('@/sync/hash')).sha256Hex;
    const localHash = await sha256(localBytes);
    const serverHash = await sha256(serverBytes);

    const vault = new MemoryVault();
    vault.files.set('image.png', localBytes);
    const log = new OperationLog({ filePath: ':memory:', Database });
    const doc = new DocManager();
    const ra = new RecentlyApplied();
    const apiResponses = new Map<string, () => RequestUrlResponse>();
    apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'image.png',
            fileType: 'BINARY',
            // Stored hash differs from both local and server → 3-way conflict.
            contentHash: 'h-stored',
            size: '3',
            mimeType: 'image/png',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    apiResponses.set('GET /api/projects/p1/files/f1', () => ({
      status: 200,
      json: null,
      arrayBuffer: serverBytes,
      headers: {},
      text: '',
    }));

    const api = new ApiClient(server, async (params) => {
      const path = params.url.replace(server.url, '');
      const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
      if (!responder) throw new Error(`unexpected: ${params.method ?? 'GET'} ${path}`);
      return responder();
    });

    const conflictResolver = {
      resolveBinaryConflict: jest.fn(async () => 'keep-both' as const),
      resolveDeleteConflict: jest.fn(async () => 'delete-local' as const),
    };

    const socket = new SocketClient({ server, clientId: 'device-1', factory });
    const engine = new SyncEngine({
      binding,
      server,
      clientId: 'device-1',
      vault,
      operationLog: log,
      docManager: doc,
      recentlyApplied: ra,
      apiClient: api,
      socketClient: socket,
      conflictResolver,
      now: () => 1700000000000,
    });

    await engine.start();
    if (!FakeSocket.last) throw new Error('socket not built');
    FakeSocket.last.ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    // Hijack the vault ops so each disk-level call fires its chokidar
    // echoes inline. The fs-watcher gates dispatch on `ra.take`, so we
    // mirror that: take returns true → suppressed; false → dispatch
    // through handleVaultEvent (using void so a leaked emit awaiting an
    // ack doesn't deadlock the engine's keep-both flow). Both stale
    // guards (handleLocalDelete's `exists` check, handleLocalCreate's
    // `!exists` check) deliberately can't save us here — at the moment
    // the unlink fires, image.png really is missing from disk.
    const origRename = vault.rename.bind(vault);
    vault.rename = async (oldP: string, newP: string): Promise<void> => {
      await origRename(oldP, newP);
      if (!ra.take(oldP)) {
        void engine.handleVaultEvent({
          type: 'delete',
          bindingId: 'b1',
          path: oldP,
          source: 'fs',
        });
      }
      if (!ra.take(newP)) {
        void engine.handleVaultEvent({
          type: 'create',
          bindingId: 'b1',
          path: newP,
          source: 'fs',
        });
      }
    };
    const origCreateBinary = vault.createBinary.bind(vault);
    vault.createBinary = async (p: string, buf: ArrayBuffer): Promise<void> => {
      await origCreateBinary(p, buf);
      if (!ra.take(p)) {
        void engine.handleVaultEvent({
          type: 'create',
          bindingId: 'b1',
          path: p,
          source: 'fs',
        });
      }
    };

    const emitsBefore = FakeSocket.last.emits.length;
    FakeSocket.last.fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: serverHash,
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    // Phantom file:delete for image.png is the headline regression — it
    // is what soft-deleted image.png on the server in the original repro.
    // Phantom file:create on aside is the matching nested-conflict cause:
    // the server already had image.conflict-<ts>.png by the time the
    // leaked CREATE arrived (the rename moved image.png there), so the
    // server conflict-renamed it to image.conflict-<ts>.conflict-<id>.png.
    const newEmits = FakeSocket.last.emits.slice(emitsBefore);
    const deletes = newEmits.filter((e) => e.event === 'file:delete');
    const creates = newEmits.filter((e) => e.event === 'file:create');
    expect(deletes).toEqual([]);
    expect(creates).toEqual([]);

    // Local state is the keep-both outcome: server bytes at image.png,
    // local bytes at the aside.
    expect(await sha256(await vault.readBinary('image.png'))).toBe(serverHash);
    expect(await sha256(await vault.readBinary('image.conflict-1700000000000.png'))).toBe(
      localHash,
    );

    await engine.stop();
  });

  it('handleLocalDelete skips when the file is still on disk', async () => {
    // The stale-delete guard: chokidar can emit `unlink` mid-write
    // (atomic rename), and the matching `add` lands a beat later. If
    // handleLocalDelete acted on that stray unlink, we'd file:delete a
    // file that's still very much present, and the round-trip would
    // strip the entry from fileIndex.
    const h = buildHarness();
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash: 'h',
            size: '5',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
    h.vault.files.set('note.md', new TextEncoder().encode('hello').buffer as ArrayBuffer);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    const before = h.socket().emits.length;
    await h.engine.handleVaultEvent({
      type: 'delete',
      bindingId: 'b1',
      path: 'note.md',
      source: 'fs',
    });
    await flushAsync();
    const deletes = h
      .socket()
      .emits.slice(before)
      .filter((e) => e.event === 'file:delete');
    expect(deletes).toEqual([]);
    // And fileIndex is untouched.
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    await h.engine.stop();
  });

  it('handleLocalCreate skips when the file is no longer on disk', async () => {
    // Inverse of the stale-delete guard: chokidar's `add` can fire for
    // a path that briefly existed during an atomic rename and is gone
    // by the time we read it. Emitting an empty CREATE here would tip
    // the server into a conflict-rename round-trip too.
    const h = buildHarness();
    // File was never written to disk — the synthesized event is stale.
    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();

    const before = h.socket().emits.length;
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'transient.md',
      source: 'fs',
    });
    await flushAsync();
    const creates = h
      .socket()
      .emits.slice(before)
      .filter((e) => e.event === 'file:create');
    expect(creates).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — error logging (observability)', () => {
  // A logger backed by an in-memory sink so the test can read exactly what
  // the engine would have written to sync.log / DevTools. Level 'debug' so
  // non-error transitions are recorded too — we filter to the error ones.
  function captureLogger(): { logger: Logger; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const sink: LogSink = {
      write: (e) => {
        entries.push(e);
      },
    };
    return { logger: new Logger('debug', sink, { plugin: 'team-vault' }), entries };
  }

  it('logs the cause at error level with bindingId when project:join is NACKed', async () => {
    const { logger, entries } = captureLogger();
    const h = buildHarness({ logger });

    await h.engine.start();
    // The project was deleted server-side → join is rejected with a cause code.
    h.socket().ackErr('project_not_found');
    await flushAsync();

    // Status still flips to error (unchanged behaviour)…
    expect(h.engine.getStatus()).toBe('error');

    // …but now the failure is also written to the logger — previously the
    // status bar was the only place it surfaced (the "muteness" bug).
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    const entry = errors[0];
    expect(entry?.context).toMatchObject({ component: 'engine', bindingId: 'b1' });
    const line = entry ? formatLogEntry(entry) : '';
    expect(line).toContain('bindingId=b1');
    expect(line).toContain('project_not_found');

    await h.engine.stop();
  });

  it('folds the HTTP status code into the logged detail when refreshFileIndex 404s', async () => {
    const { logger, entries } = captureLogger();
    const h = buildHarness({ logger });
    // Deleted project → the REST file-list returns 404. The bare ApiError
    // message is just "Not found"; the engine must fold in the status code so
    // the log pinpoints the cause (project_not_found vs. some other failure).
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 404,
      json: { error: 'not_found' },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    await h.engine.start();
    await flushAsync();

    expect(h.engine.getStatus()).toBe('error');
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    const line = errors[0] ? formatLogEntry(errors[0]) : '';
    expect(line).toContain('404');
    expect(line).toContain('not_found');

    await h.engine.stop();
  });
});

describe('SyncEngine — disk preservation (mass-rollback regression)', () => {
  /** Standard one-file server listing used by every test in this block. */
  function listFiles(h: Harness, contentHash: string): void {
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f1',
            path: 'note.md',
            fileType: 'TEXT',
            contentHash,
            size: '10',
            mimeType: 'text/markdown',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));
  }

  function seedSyncedMeta(h: Harness, contentHash: string): void {
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'note.md',
      serverFileId: 'f1',
      contentHash,
      size: 10,
      fileType: 'TEXT',
      lastSyncedAt: 1,
    });
  }

  function putDisk(h: Harness, text: string): void {
    h.vault.files.set('note.md', new TextEncoder().encode(text).buffer as ArrayBuffer);
  }

  it('catch-up must not roll back a file edited on disk while the plugin was off', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness();
    const oldText = 'старая версия\n';
    const newText = 'старая версия\nсвежая локальная правка\n';
    const oldHash = await sha256Hex(oldText);

    // The engine synced `oldText` in a previous session; the file was then
    // edited on disk (git checkout / external agent) with the plugin off,
    // and the local Y.Doc store is EMPTY (e.g. fresh database name).
    listFiles(h, oldHash);
    seedSyncedMeta(h, oldHash);
    putDisk(h, newText);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsStream: true, yjsCount: 1 });
    await flushAsync(10);

    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, oldText);
    h.socket().fire('yjs:catchup', {
      projectId: 'p1',
      docs: [
        {
          fileId: 'f1',
          sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
          stateVector: Array.from(Y.encodeStateVector(serverDoc)),
        },
      ],
      done: true,
    });
    await flushAsync(20);

    // The disk keeps the local edits (this is the 56-file rollback bug)…
    expect(await h.vault.readText('note.md')).toBe(newText);
    // …the doc converged on them…
    expect(h.doc.getText('b1', 'note.md')).toBe(newText);
    // …and the push-back ships them to the server.
    const emits = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(emits.length).toBeGreaterThanOrEqual(1);
    const payload = emits[0]?.args[0] as { update: number[] };
    Y.applyUpdate(serverDoc, Uint8Array.from(payload.update));
    expect(serverDoc.getText('content').toString()).toBe(newText);
    serverDoc.destroy();
    await h.engine.stop();
  });

  it('catch-up still applies newer server content when the disk has no local edits', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness();
    const oldText = 'v1\n';
    const serverText = 'v1\nremote edit\n';
    const oldHash = await sha256Hex(oldText);

    listFiles(h, oldHash);
    seedSyncedMeta(h, oldHash);
    putDisk(h, oldText); // unchanged since last sync

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsStream: true, yjsCount: 1 });
    await flushAsync(10);

    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, serverText);
    h.socket().fire('yjs:catchup', {
      projectId: 'p1',
      docs: [
        {
          fileId: 'f1',
          sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
          stateVector: Array.from(Y.encodeStateVector(serverDoc)),
        },
      ],
      done: true,
    });
    await flushAsync(20);

    // Normal sync: the server's newer text lands on disk.
    expect(await h.vault.readText('note.md')).toBe(serverText);
    serverDoc.destroy();
    await h.engine.stop();
  });

  it('a live yjs:update snapshot folds unseen disk edits instead of clobbering them', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness({ snapshotMs: 0 });
    const oldText = 'v1\n';
    const localText = 'v1\nlocal pending edit\n';
    const oldHash = await sha256Hex(oldText);

    listFiles(h, oldHash);
    seedSyncedMeta(h, oldHash);
    putDisk(h, localText); // edited on disk; the watcher debounce hasn't fired yet

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(10);

    const remote = new Y.Doc();
    remote.getText('content').insert(0, 'v1\nremote line\n');
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(remote)),
    });
    remote.destroy();
    await flushAsync(20);

    // The snapshot must not roll the disk back to a state without the
    // local edit — disk content wins and is shipped upstream.
    expect(await h.vault.readText('note.md')).toContain('local pending edit');
    const pushed = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    await h.engine.stop();
  });

  it('replays an offline CREATE for a server-known path as a modify, not a conflict-renaming CREATE', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness();
    const oldText = 'старое содержимое\n';
    const newText = 'восстановленное содержимое\n';
    const oldHash = await sha256Hex(oldText);

    listFiles(h, oldHash);
    seedSyncedMeta(h, oldHash);
    putDisk(h, newText);

    // A git checkout while the engine was offline looks like a fresh create
    // to the watcher — the op queues because the socket is down.
    await h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'note.md',
      source: 'fs',
    });
    expect(h.log.pendingCount('b1')).toBe(1);

    await h.engine.start();
    // The real server streams every text doc's state during catch-up —
    // the doc hydrates with the server's copy before the drain replays
    // the queued op.
    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, oldText);
    h.socket().ackOk({
      operations: [],
      yjsDocs: [
        {
          fileId: 'f1',
          sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
          stateVector: Array.from(Y.encodeStateVector(serverDoc)),
        },
      ],
    });
    await flushAsync(20);

    // The server already tracks note.md — replaying the queued op as a
    // CREATE would make the server conflict-rename the upload into
    // `note.conflict-<clientId>.md`. It must go through the modify path.
    const creates = h.socket().emits.filter((e) => e.event === 'file:create');
    expect(creates).toHaveLength(0);
    // The disk text reached the doc as a minimal diff over the server's
    // copy, and the push-back ships it upstream.
    expect(h.doc.getText('b1', 'note.md')).toBe(newText);
    const updates = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const u of updates) {
      Y.applyUpdate(serverDoc, Uint8Array.from((u.args[0] as { update: number[] }).update));
    }
    expect(serverDoc.getText('content').toString()).toBe(newText);
    serverDoc.destroy();
    expect(h.log.pendingCount('b1')).toBe(0);
    await h.engine.stop();
  });

  it('never materialises a server-side atomic-write artifact locally', async () => {
    const h = buildHarness();
    // A stale artifact an older client uploaded, still live on the server.
    h.apiResponses.set('GET /api/projects/p1/files', () => ({
      status: 200,
      json: {
        files: [
          {
            id: 'f-tmp',
            path: 'wiki/index.md.tmp.14424.02a1a4a4e56e',
            fileType: 'BINARY',
            contentHash: 'h',
            size: '7',
            mimeType: 'application/octet-stream',
            deletedAt: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            lastModifiedById: 'u1',
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: '',
    }));

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(10);

    // Not indexed from the listing…
    expect(h.engine.getFileIdForPath('wiki/index.md.tmp.14424.02a1a4a4e56e')).toBeNull();

    // …and a live broadcast doesn't download or create it either.
    h.socket().fire('file:created', {
      result: { outcome: { fileId: 'f-tmp2', path: 'wiki/log.md.tmp.2340.cb727fa8dd9f' } },
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(10);
    expect(await h.vault.exists('wiki/log.md.tmp.2340.cb727fa8dd9f')).toBe(false);
    // No byte download was attempted for either artifact (GET /files/<id>).
    const downloads = h.apiCalls.filter((c) => /\/files\/f-tmp2?$/.test(c.url));
    expect(downloads).toHaveLength(0);
    await h.engine.stop();
  });

  it('an external modify into an unhydrated doc must not duplicate the content', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness();
    const baseText = '# Сцена 18 — Казнь Перминова\n\nстарый текст\n';
    const editedText = '# Сцена 18 — Казнь Перминова\n\nстарый текст\nсвежая правка\n';
    const baseHash = await sha256Hex(baseText);

    // Server knows the file; the local y-indexeddb store is EMPTY (fresh
    // database name) and the disk was just edited by an external process.
    listFiles(h, baseHash);
    seedSyncedMeta(h, baseHash);
    putDisk(h, editedText);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsStream: true, yjsCount: 1 });
    await flushAsync(10);

    // The watcher's modify fires BEFORE the file's catch-up batch arrives —
    // the doubled-content window. Diffing the full text into the op-less
    // doc would create a second insertion of the whole file; it must defer.
    await h.engine.handleVaultEvent({
      type: 'modify',
      bindingId: 'b1',
      path: 'note.md',
      source: 'fs',
    });
    await flushAsync(10);
    expect(h.socket().emits.filter((e) => e.event === 'yjs:update')).toHaveLength(0);
    expect(h.doc.getText('b1', 'note.md')).toBe('');

    // The catch-up lands: the doc hydrates with the server's copy, the
    // snapshot folds the disk edits in as a minimal diff, and the
    // push-back ships them. Nothing is doubled — on either side.
    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, baseText);
    h.socket().fire('yjs:catchup', {
      projectId: 'p1',
      docs: [
        {
          fileId: 'f1',
          sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
          stateVector: Array.from(Y.encodeStateVector(serverDoc)),
        },
      ],
      done: true,
    });
    await flushAsync(20);

    expect(h.doc.getText('b1', 'note.md')).toBe(editedText);
    expect(await h.vault.readText('note.md')).toBe(editedText);
    const pushed = h.socket().emits.filter((e) => e.event === 'yjs:update');
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    for (const u of pushed) {
      Y.applyUpdate(serverDoc, Uint8Array.from((u.args[0] as { update: number[] }).update));
    }
    // The incident signature was the whole content repeated under itself
    // (two `# ` headings per file) — the converged server doc must hold
    // the edited text exactly once.
    expect(serverDoc.getText('content').toString()).toBe(editedText);
    serverDoc.destroy();
    await h.engine.stop();
  });

  it('never snapshots a half-applied doc (pending remote updates) over a real file', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness({ snapshotMs: 0 });
    const baseText = 'строфа один\n';
    const baseHash = await sha256Hex(baseText);

    listFiles(h, baseHash);
    seedSyncedMeta(h, baseHash);
    putDisk(h, baseText);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(10);

    // Two sequential server-side edits; the first update is lost/delayed,
    // only the second arrives. Yjs parks it as pending — the doc's visible
    // text is an empty stale subset. Snapshotting now would truncate the
    // file on disk (the mass-rollback incident shape).
    const remote = new Y.Doc();
    const updates: Uint8Array[] = [];
    remote.on('update', (u: Uint8Array) => updates.push(u));
    remote.getText('content').insert(0, baseText);
    remote.getText('content').insert(baseText.length, 'строфа два\n');
    remote.destroy();
    h.socket().fire('yjs:update', { fileId: 'f1', update: Array.from(updates[1] ?? []) });
    await flushAsync(20);
    expect(await h.vault.readText('note.md')).toBe(baseText);

    // The missing update arrives; both integrate and the snapshot writes
    // the complete merged text.
    h.socket().fire('yjs:update', { fileId: 'f1', update: Array.from(updates[0] ?? []) });
    await flushAsync(20);
    expect(await h.vault.readText('note.md')).toBe('строфа один\nстрофа два\n');
    await h.engine.stop();
  });

  it('catch-up does not rewrite files whose disk content already matches the doc', async () => {
    const Y = await import('yjs');
    const { sha256Hex } = await import('@/sync/hash');
    const h = buildHarness();
    const text = 'неизменённый текст\n';
    const hash = await sha256Hex(text);

    listFiles(h, hash);
    seedSyncedMeta(h, hash);
    putDisk(h, text);

    await h.engine.start();
    const serverDoc = new Y.Doc();
    serverDoc.getText('content').insert(0, text);
    h.socket().ackOk({
      operations: [],
      yjsDocs: [
        {
          fileId: 'f1',
          sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
          stateVector: Array.from(Y.encodeStateVector(serverDoc)),
        },
      ],
    });
    serverDoc.destroy();
    await flushAsync(20);

    // The old behavior rewrote EVERY text file on EVERY connect — a write
    // storm that churned atomic-write tmp artifacts and left live echo
    // budgets that swallowed genuine external edits. An unchanged file must
    // produce no write, hence no `recentlyApplied` echo budget.
    expect(await h.vault.readText('note.md')).toBe(text);
    expect(h.ra.size()).toBe(0);
    await h.engine.stop();
  });

  it('initial push skips Obsidian atomic-write artifacts', async () => {
    const h = buildHarness();
    // Map iteration order = insertion order: the artifact comes first, so a
    // missing filter would upload it before the real note.
    h.vault.files.set(
      'note.md.tmp.14424.02a1a4a4e56e',
      new TextEncoder().encode('garbage').buffer as ArrayBuffer,
    );
    h.vault.files.set('real.md', new TextEncoder().encode('content').buffer as ArrayBuffer);

    await h.engine.start();
    h.socket().ackOk({ operations: [], yjsDocs: [] });
    await flushAsync(20);

    const creates = h.socket().emits.filter((e) => e.event === 'file:create');
    const paths = creates.map((e) => (e.args[0] as { filePath: string }).filePath);
    expect(paths).toEqual(['real.md']);
    h.socket().ackOk({ outcome: { fileId: 'f9', path: 'real.md' } });
    await flushAsync();
    await h.engine.stop();
  });
});
