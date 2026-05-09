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

function buildHarness(joinResult?: unknown): Harness {
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
  };
  const engine = new SyncEngine(deps);

  // Pre-program the join response so onSocketConnect can complete.
  void joinResult;
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
