import { EngineManager } from '@/sync/engine-manager';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ApiClient, type RequestUrlResponse } from '@/client/api';
import {
  SocketClient,
  type SocketFactory,
  type SocketFactoryOptions,
  type SocketLike,
} from '@/client/socket';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import { Logger, type LogEntry, type LogLevel } from '@/utils/logger';

/**
 * A path from the server the plugin refuses is logged at `warn` once while
 * the plugin runs, and at `debug` after that. The memory of what was reported
 * used to live in the `SyncEngine`, and the `EngineManager` spawns a new
 * engine on every resume and every time a binding is switched back on: the
 * `.DS_Store` files an older version uploaded came back at `warn`, one line
 * per folder, each time. Real engines under a real manager here; the server
 * and the vault are fakes.
 */

class EmptyVault implements VaultAdapter {
  getBasePath(): string {
    return '/vault';
  }
  async exists(): Promise<boolean> {
    return false;
  }
  async readText(path: string): Promise<string> {
    throw new Error(`missing file ${path}`);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    throw new Error(`missing file ${path}`);
  }
  async createText(): Promise<void> {
    throw new Error('the server offers nothing to write here');
  }
  async writeText(): Promise<void> {
    throw new Error('the server offers nothing to write here');
  }
  async createBinary(): Promise<void> {
    throw new Error('the server offers nothing to write here');
  }
  async writeBinary(): Promise<void> {
    throw new Error('the server offers nothing to write here');
  }
  async delete(): Promise<void> {
    /* nothing to delete */
  }
  async rename(): Promise<void> {
    /* nothing to rename */
  }
  async ensureParentFolder(): Promise<void> {
    /* no folders here */
  }
  async list(): Promise<string[]> {
    return [];
  }
}

class FakeSocket implements SocketLike {
  /** Sockets built since the last `join()` — one per engine that connected. */
  static fresh: FakeSocket[] = [];
  connected = false;
  emits: Array<{ event: string; args: unknown[] }> = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor() {
    FakeSocket.fresh.push(this);
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
    this.fire('disconnect', 'io client disconnect');
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  /** Answer the last emit — `project:join` right after a connect. */
  ackOk(extra: Record<string, unknown> = {}): void {
    const last = this.emits[this.emits.length - 1];
    const ack = last?.args[last.args.length - 1] as ((r: unknown) => void) | undefined;
    if (ack) ack({ ok: true, ...extra });
  }
}

const socketFactory: SocketFactory = (_url: string, _options: SocketFactoryOptions) =>
  new FakeSocket();

const server: ServerConfig = {
  id: 's1',
  name: 'Local',
  url: 'https://sync.example.com',
  apiKey: 'osk_test',
  addedAt: 0,
};

function makeBinding(id: string, projectId: string): VaultBinding {
  return {
    id,
    serverId: 's1',
    projectId,
    projectName: 'Test',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 0,
    lastVectorClock: {},
  };
}

/** A file listing with nothing in it the plugin may sync. */
function listing(paths: string[]): () => RequestUrlResponse {
  const files = paths.map((path, i) => ({
    id: `f${i + 1}`,
    path,
    fileType: 'BINARY',
    contentHash: 'h',
    size: '5',
    mimeType: 'application/octet-stream',
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastModifiedById: 'u1',
  }));
  return () => ({
    status: 200,
    json: { files },
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
    text: '',
  });
}

const SERVICE_FILES = ['.DS_Store', 'notes/.DS_Store', 'OBSIDI~1/app.json'];

async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

function harness(
  bindings: VaultBinding[],
  level: LogLevel = 'debug',
): {
  manager: EngineManager;
  logger: Logger;
  entries: LogEntry[];
  /** Answer the joins of the engines that connected since, and let them settle. */
  join: () => Promise<number>;
} {
  const entries: LogEntry[] = [];
  const logger = new Logger(level, {
    write: (e) => {
      entries.push(e);
    },
  });
  const respond = async (params: { url: string; method?: string }) => {
    const path = params.url.replace(server.url, '');
    const project = /^\/api\/projects\/([^/]+)\/files(\?includeDeleted=true)?$/.exec(path);
    if ((params.method ?? 'GET') === 'GET' && project) return listing(SERVICE_FILES)();
    throw new Error(`unexpected request: ${params.method ?? 'GET'} ${path}`);
  };
  const manager = new EngineManager({
    getSettings: () => ({ servers: [server], bindings }),
    vault: new EmptyVault(),
    operationLog: new OperationLog(),
    docManager: new DocManager(),
    recentlyApplied: new RecentlyApplied(),
    clientId: 'device-1',
    logger,
    apiClient: (s) => new ApiClient(s, respond, respond),
    socketClient: (s, clientId) =>
      new SocketClient({ server: s, clientId, factory: socketFactory }),
  });
  const join = async (): Promise<number> => {
    const sockets = FakeSocket.fresh.splice(0);
    for (const socket of sockets) socket.ackOk({ operations: [], yjsDocs: [] });
    await flushAsync();
    return sockets.length;
  };
  return { manager, logger, entries, join };
}

/** The refusals logged at `level`, as `bindingId path`. */
function refused(entries: LogEntry[], level: LogEntry['level']): string[] {
  return entries
    .filter((e) => e.level === level && e.message === 'refused a path supplied by the server')
    .map((e) => `${String(e.context.bindingId)} ${(e.args[0] as { path: string }).path}`)
    .sort();
}

afterEach(() => {
  FakeSocket.fresh = [];
});

describe('a refused server path in sync.log', () => {
  it('is not reported at warn again after a pause and a resume', async () => {
    const { manager, entries, join } = harness([makeBinding('b1', 'p1')]);
    await manager.start();
    expect(await join()).toBe(1);
    expect(refused(entries, 'warn')).toEqual(SERVICE_FILES.map((p) => `b1 ${p}`).sort());

    await manager.pause();
    await manager.resume();
    // A new engine, on a socket of its own, reads the same listing.
    expect(await join()).toBe(1);
    expect(manager.getAggregateStatus().state).toBe('connected');

    expect(refused(entries, 'warn')).toHaveLength(SERVICE_FILES.length);
    expect(refused(entries, 'debug')).toEqual(SERVICE_FILES.map((p) => `b1 ${p}`).sort());
    await manager.stop();
  });

  it('is not reported at warn again after the binding is switched off and on', async () => {
    const binding = makeBinding('b1', 'p1');
    const { manager, entries, join } = harness([binding]);
    await manager.start();
    expect(await join()).toBe(1);

    binding.enabled = false;
    await manager.refreshFromSettings();
    expect(manager.getEngine('b1')).toBeUndefined();
    binding.enabled = true;
    await manager.refreshFromSettings();
    expect(await join()).toBe(1);
    expect(manager.getAggregateStatus().state).toBe('connected');

    expect(refused(entries, 'warn')).toHaveLength(SERVICE_FILES.length);
    expect(refused(entries, 'debug')).toHaveLength(SERVICE_FILES.length);
    await manager.stop();
  });

  it('is reported at warn once for each binding that meets it', async () => {
    // Two bindings (an older version could make one per subfolder), two
    // projects holding the same service files: each binding's lines name it,
    // so one binding's report must not silence the other's.
    const { manager, entries, join } = harness([makeBinding('b1', 'p1'), makeBinding('b2', 'p2')]);
    await manager.start();
    expect(await join()).toBe(2);
    await manager.pause();
    await manager.resume();
    expect(await join()).toBe(2);
    expect(manager.getAggregateStatus().bindings).toEqual({ b1: 'connected', b2: 'connected' });

    expect(refused(entries, 'warn')).toEqual(
      ['b1', 'b2'].flatMap((b) => SERVICE_FILES.map((p) => `${b} ${p}`)).sort(),
    );
    expect(refused(entries, 'debug')).toHaveLength(2 * SERVICE_FILES.length);
    await manager.stop();
  });
});

describe('a refused server path with Log level set to Errors only', () => {
  // At Errors only the `warn` line is dropped. The path used to be remembered
  // as reported all the same, and the memory now outlives the engine: after
  // the user raised the level (it applies at once, no reload) neither a
  // resume nor switching the binding off and on showed the refusal again —
  // only Debug or a plugin reload did.
  it('is reported at warn after the level goes up and sync is resumed', async () => {
    const { manager, logger, entries, join } = harness([makeBinding('b1', 'p1')], 'error');
    await manager.start();
    expect(await join()).toBe(1);
    expect(manager.getAggregateStatus().state).toBe('connected');
    expect(entries.filter((e) => e.message === 'refused a path supplied by the server')).toEqual(
      [],
    );

    logger.setLevel('warn');
    await manager.pause();
    await manager.resume();
    expect(await join()).toBe(1);
    expect(refused(entries, 'warn')).toEqual(SERVICE_FILES.map((p) => `b1 ${p}`).sort());

    // Reported now: the next engine logs the same paths at debug only.
    logger.setLevel('debug');
    await manager.pause();
    await manager.resume();
    expect(await join()).toBe(1);
    expect(refused(entries, 'warn')).toHaveLength(SERVICE_FILES.length);
    expect(refused(entries, 'debug')).toEqual(SERVICE_FILES.map((p) => `b1 ${p}`).sort());
    await manager.stop();
  });

  it('is reported at warn at the first reconnect after the level goes up', async () => {
    const { manager, logger, entries, join } = harness([makeBinding('b1', 'p1')], 'error');
    await manager.start();
    const [socket] = FakeSocket.fresh;
    expect(await join()).toBe(1);
    const engine = manager.getEngine('b1');

    const reconnect = async (): Promise<void> => {
      socket?.disconnect();
      socket?.connect();
      await flushAsync(5);
      socket?.ackOk({ operations: [], yjsDocs: [] });
      await flushAsync();
    };
    logger.setLevel('info');
    await reconnect();
    // The same engine, reading the file index again.
    expect(manager.getEngine('b1')).toBe(engine);
    expect(manager.getAggregateStatus().state).toBe('connected');
    expect(refused(entries, 'warn')).toEqual(SERVICE_FILES.map((p) => `b1 ${p}`).sort());

    await reconnect();
    expect(refused(entries, 'warn')).toHaveLength(SERVICE_FILES.length);
    await manager.stop();
  });
});
