import { EngineManager, type AggregateStatus, type EngineManagerDeps } from '@/sync/engine-manager';
import { OperationLog } from '@/sync/operation-log';
import { DocManager, type IdbRegistry } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import type { EngineStatus, SyncEngine } from '@/sync/engine';
import type { VaultEvent } from '@/watcher/obsidian-events';

/**
 * Hand-rolled `SyncEngine` stand-in. Records lifecycle calls and exposes
 * `setStatus(status, detail)` so the test can drive the aggregate.
 */
class FakeEngine {
  static instances = new Map<string, FakeEngine>();
  static lastFor(bindingId: string): FakeEngine | undefined {
    return FakeEngine.instances.get(bindingId);
  }
  startCalls = 0;
  stopCalls = 0;
  /** Lifecycle calls in order: `start`, `pause`, `resume`, `stop`. */
  calls: string[] = [];
  /** Vault events handed to this engine. */
  events: VaultEvent[] = [];
  status: EngineStatus = 'stopped';
  private paused = false;
  private listeners = new Set<(status: EngineStatus, detail?: string) => void>();

  constructor(public readonly bindingId: string) {
    FakeEngine.instances.set(bindingId, this);
  }

  async start(): Promise<void> {
    this.startCalls++;
    this.calls.push('start');
    this.setStatus(this.paused ? 'offline' : 'connecting');
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    this.calls.push('stop');
    this.setStatus('stopped');
  }
  pause(): void {
    this.calls.push('pause');
    this.paused = true;
    if (this.startCalls > 0) this.setStatus('offline', 'paused');
  }
  async resume(): Promise<void> {
    this.calls.push('resume');
    this.paused = false;
    this.setStatus('connecting');
  }
  async handleVaultEvent(event: VaultEvent): Promise<void> {
    this.events.push(event);
  }
  onStatus(cb: (status: EngineStatus, detail?: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  setStatus(status: EngineStatus, detail?: string): void {
    this.status = status;
    for (const cb of this.listeners) cb(status, detail);
  }
  async runDeepSyncDiff(): Promise<unknown> {
    return { serverOnly: [], localOnly: [], hashMismatches: [] };
  }
}

const memVault: VaultAdapter = {
  getBasePath: () => '/vault',
  exists: async () => false,
  readText: async () => '',
  readBinary: async () => new ArrayBuffer(0),
  createText: async () => undefined,
  writeText: async () => undefined,
  createBinary: async () => undefined,
  writeBinary: async () => undefined,
  delete: async () => undefined,
  rename: async () => undefined,
  ensureParentFolder: async () => undefined,
  list: async () => [],
};

function makeDeps(
  servers: ServerConfig[],
  bindings: VaultBinding[],
  over: Partial<EngineManagerDeps> = {},
): EngineManagerDeps {
  return {
    getSettings: () => ({ servers, bindings }),
    vault: memVault,
    operationLog: new OperationLog(),
    docManager: new DocManager(),
    recentlyApplied: new RecentlyApplied(),
    clientId: 'device-1',
    engineFactory: (deps) => {
      const fake = new FakeEngine(deps.binding.id);
      return fake as unknown as SyncEngine;
    },
    ...over,
  };
}

/** In-memory stand-in for the renderer's `indexedDB` enumerate/delete seam. */
function makeFakeIdb(initial: string[]): {
  registry: IdbRegistry;
  names: Set<string>;
  deleted: string[];
} {
  const names = new Set(initial);
  const deleted: string[] = [];
  const registry: IdbRegistry = {
    list: () => Promise.resolve([...names]),
    delete: (name) => {
      if (names.delete(name)) deleted.push(name);
      return Promise.resolve();
    },
  };
  return { registry, names, deleted };
}

const server: ServerConfig = {
  id: 's1',
  name: 'Local',
  url: 'https://x',
  apiKey: 'k',
  addedAt: 0,
};
function makeBinding(over: Partial<VaultBinding> = {}): VaultBinding {
  return {
    id: 'b1',
    serverId: 's1',
    projectId: 'p1',
    projectName: 'Test',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 0,
    lastVectorClock: {},
    ...over,
  };
}

afterEach(() => {
  FakeEngine.instances.clear();
});

describe('EngineManager — roster lifecycle', () => {
  it('spawns one engine per enabled binding on start', async () => {
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })]),
    );
    await m.start();
    expect(FakeEngine.lastFor('a')?.startCalls).toBe(1);
    expect(FakeEngine.lastFor('b')?.startCalls).toBe(1);
    await m.stop();
  });

  it('skips disabled bindings and bindings without a known server', async () => {
    const m = new EngineManager(
      makeDeps(
        [server],
        [
          makeBinding({ id: 'on' }),
          makeBinding({ id: 'off', enabled: false }),
          makeBinding({ id: 'orphan', serverId: 'missing' }),
        ],
      ),
    );
    await m.start();
    expect(FakeEngine.lastFor('on')?.startCalls).toBe(1);
    expect(FakeEngine.lastFor('off')).toBeUndefined();
    expect(FakeEngine.lastFor('orphan')).toBeUndefined();
    await m.stop();
  });

  it('refreshFromSettings creates new engines and drops removed ones', async () => {
    const bindings: VaultBinding[] = [makeBinding({ id: 'a' })];
    const deps = makeDeps([server], bindings);
    const m = new EngineManager(deps);
    await m.start();
    expect(FakeEngine.lastFor('a')?.startCalls).toBe(1);

    bindings.push(makeBinding({ id: 'b' }));
    await m.refreshFromSettings();
    expect(FakeEngine.lastFor('b')?.startCalls).toBe(1);

    bindings.shift(); // remove 'a'
    await m.refreshFromSettings();
    expect(FakeEngine.lastFor('a')?.stopCalls).toBe(1);
    await m.stop();
  });

  // Pause stopped and dropped every engine, and a vault event with no engine
  // to take it was lost: a note renamed while paused came back on resume as
  // two notes for the whole team, one deleted came back.
  it('pause keeps every engine, paused, and resume resumes the same one', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const first = FakeEngine.lastFor('a');
    expect(first?.startCalls).toBe(1);

    await m.pause();
    expect(m.isPaused()).toBe(true);
    expect(m.getEngine('a')).toBe(first);
    expect(first?.calls).toEqual(['start', 'pause']);

    await m.resume();
    expect(m.isPaused()).toBe(false);
    expect(FakeEngine.lastFor('a')).toBe(first);
    expect(first?.calls).toEqual(['start', 'pause', 'resume']);
    await m.stop();
  });

  it('hands vault events to the engines while paused', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    await m.pause();
    const rename: VaultEvent = {
      type: 'rename',
      bindingId: 'a',
      oldPath: 'offlene-a.md',
      newPath: 'chain-b.md',
      source: 'obsidian',
    };
    await m.dispatchVaultEvent(rename);
    expect(FakeEngine.lastFor('a')?.events).toEqual([rename]);
    await m.stop();
  });

  it('gives a binding added while paused an engine paused before it starts', async () => {
    const bindings = [makeBinding({ id: 'a' })];
    const m = new EngineManager(makeDeps([server], bindings));
    await m.start();
    await m.pause();
    bindings.push(makeBinding({ id: 'b' }));
    await m.refreshFromSettings();
    expect(FakeEngine.lastFor('b')?.calls).toEqual(['pause', 'start']);
    expect(m.getAggregateStatus().state).toBe('paused');

    await m.resume();
    expect(FakeEngine.lastFor('b')?.calls).toEqual(['pause', 'start', 'resume']);
    await m.stop();
  });

  it('stops a binding switched off while paused, and one removed, purging only that one', async () => {
    const bindings = [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })];
    const deps = makeDeps([server], bindings);
    deps.operationLog.enqueueOperation('a', { opType: 'CREATE', filePath: 'kept.md' });
    deps.operationLog.enqueueOperation('b', { opType: 'CREATE', filePath: 'gone.md' });
    const m = new EngineManager(deps);
    await m.start();
    await m.pause();

    (bindings[0] as VaultBinding).enabled = false;
    bindings.pop();
    await m.refreshFromSettings();

    expect(FakeEngine.lastFor('a')?.calls).toEqual(['start', 'pause', 'stop']);
    expect(FakeEngine.lastFor('b')?.calls).toEqual(['start', 'pause', 'stop']);
    expect(m.getEngine('a')).toBeUndefined();
    expect(deps.operationLog.pendingCount('a')).toBe(1);
    expect(deps.operationLog.pendingCount('b')).toBe(0);

    // Switched back on while still paused: a new engine, paused.
    (bindings[0] as VaultBinding).enabled = true;
    await m.refreshFromSettings();
    expect(m.getEngine('a')).toBeDefined();
    expect(FakeEngine.lastFor('a')?.calls).toEqual(['pause', 'start']);
    await m.stop();
  });

  it('stops every engine on stop() while paused, and resumes nothing after', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    await m.pause();
    await m.stop();
    await m.resume();
    expect(FakeEngine.lastFor('a')?.calls).toEqual(['start', 'pause', 'stop']);
  });

  it('runs no deep sync while paused', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const engine = FakeEngine.lastFor('a') as unknown as { runDeepSyncDiff: jest.Mock };
    engine.runDeepSyncDiff = jest.fn(async () => ({}));
    await m.pause();
    expect(await m.runDeepSyncOnAll()).toEqual([]);
    expect(engine.runDeepSyncDiff).not.toHaveBeenCalled();
    await m.resume();
    expect(await m.runDeepSyncOnAll()).toHaveLength(1);
    await m.stop();
  });

  it('pausing twice, or resuming when not paused, changes nothing', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    await m.resume();
    await m.pause();
    await m.pause();
    expect(FakeEngine.lastFor('a')?.calls).toEqual(['start', 'pause']);
    await m.stop();
  });

  it('spawns nothing after stop(), whatever calls in later', async () => {
    // Obsidian does not await onunload: a settings save or a resume can still
    // arrive after the plugin stopped the manager, and nothing would ever
    // stop the engines they spawned.
    const bindings = [makeBinding({ id: 'a' })];
    const m = new EngineManager(makeDeps([server], bindings));
    await m.start();
    await m.stop();
    FakeEngine.instances.clear();

    bindings.push(makeBinding({ id: 'b' }));
    await m.refreshFromSettings();
    await m.resume();
    expect(FakeEngine.lastFor('a')).toBeUndefined();
    expect(FakeEngine.lastFor('b')).toBeUndefined();

    // A deliberate start() brings it back.
    await m.start();
    expect(FakeEngine.lastFor('b')?.startCalls).toBe(1);
    await m.stop();
  });

  it('stops an engine that was still starting when stop() ran', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowEngine extends FakeEngine {
      override async start(): Promise<void> {
        this.startCalls++;
        await gate;
        this.setStatus('connecting');
      }
    }
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' })], {
        engineFactory: (deps) => new SlowEngine(deps.binding.id) as unknown as SyncEngine,
      }),
    );
    const starting = m.start();
    for (let i = 0; i < 20 && !FakeEngine.lastFor('a')?.startCalls; i++) {
      await Promise.resolve();
    }
    const engine = FakeEngine.lastFor('a');
    expect(engine?.startCalls).toBe(1);

    await m.stop();
    release();
    await starting;
    expect(engine?.status).toBe('stopped');
    expect(engine?.stopCalls).toBe(2);
  });
});

describe('EngineManager — aggregate status', () => {
  it('reports idle when there are no engines', async () => {
    const m = new EngineManager(makeDeps([server], []));
    await m.start();
    expect(m.getAggregateStatus()).toEqual({ state: 'idle', bindings: {} });
  });

  it('reports paused after pause(), whatever the engines report meanwhile', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const seen: string[] = [];
    m.onAggregateStatus((s) => seen.push(s.state));
    await m.pause();
    expect(m.getAggregateStatus()).toEqual({ state: 'paused', bindings: { a: 'offline' } });
    FakeEngine.lastFor('a')?.setStatus('error', 'boom');
    expect(m.getAggregateStatus().state).toBe('paused');
    await m.resume();
    expect(m.getAggregateStatus().state).toBe('connecting');
    expect(seen[seen.length - 1]).toBe('connecting');
    await m.stop();
  });

  it('error wins over everything else', async () => {
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })]),
    );
    await m.start();
    FakeEngine.lastFor('a')?.setStatus('connected');
    FakeEngine.lastFor('b')?.setStatus('error', 'boom');
    expect(m.getAggregateStatus().state).toBe('error');
    expect(m.getAggregateStatus().detail).toBe('boom');
    await m.stop();
  });

  it('syncing wins over connected', async () => {
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })]),
    );
    await m.start();
    FakeEngine.lastFor('a')?.setStatus('connected');
    FakeEngine.lastFor('b')?.setStatus('syncing');
    expect(m.getAggregateStatus().state).toBe('syncing');
  });

  it('all-connected → connected', async () => {
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })]),
    );
    await m.start();
    FakeEngine.lastFor('a')?.setStatus('connected');
    FakeEngine.lastFor('b')?.setStatus('connected');
    expect(m.getAggregateStatus().state).toBe('connected');
  });

  it('all-offline → offline', async () => {
    const m = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })]),
    );
    await m.start();
    FakeEngine.lastFor('a')?.setStatus('offline');
    FakeEngine.lastFor('b')?.setStatus('offline');
    expect(m.getAggregateStatus().state).toBe('offline');
  });

  it('onAggregateStatus delivers the current value immediately', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const seen: AggregateStatus[] = [];
    m.onAggregateStatus((s) => seen.push(s));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('forwards engine status changes to subscribers', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const seen: string[] = [];
    m.onAggregateStatus((s) => seen.push(s.state));
    FakeEngine.lastFor('a')?.setStatus('connected');
    expect(seen[seen.length - 1]).toBe('connected');
  });
});

describe('EngineManager — onBindingSynced', () => {
  it('fires with a fresh timestamp when an engine reaches connected', async () => {
    const calls: Array<{ id: string; at: number }> = [];
    const deps = makeDeps([server], [makeBinding({ id: 'a' })]);
    deps.onBindingSynced = (id, at) => calls.push({ id, at });
    const m = new EngineManager(deps);
    await m.start();

    const before = Date.now();
    FakeEngine.lastFor('a')?.setStatus('connected');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('a');
    expect(calls[0]?.at).toBeGreaterThanOrEqual(before);
    await m.stop();
  });

  it('does not fire for non-connected statuses', async () => {
    const calls: string[] = [];
    const deps = makeDeps([server], [makeBinding({ id: 'a' })]);
    deps.onBindingSynced = (id) => calls.push(id);
    const m = new EngineManager(deps);
    await m.start(); // start() drives 'connecting' — must not count

    FakeEngine.lastFor('a')?.setStatus('syncing');
    FakeEngine.lastFor('a')?.setStatus('offline');
    FakeEngine.lastFor('a')?.setStatus('error', 'boom');

    expect(calls).toHaveLength(0);
    await m.stop();
  });

  it('fires again on every reconnect (re-sync)', async () => {
    const calls: number[] = [];
    const deps = makeDeps([server], [makeBinding({ id: 'a' })]);
    deps.onBindingSynced = (_id, at) => calls.push(at);
    const m = new EngineManager(deps);
    await m.start();

    FakeEngine.lastFor('a')?.setStatus('connected');
    FakeEngine.lastFor('a')?.setStatus('offline');
    FakeEngine.lastFor('a')?.setStatus('connected');

    expect(calls).toHaveLength(2);
    await m.stop();
  });
});

describe('EngineManager — local-state purge', () => {
  it('purges local state when a binding disappears from settings', async () => {
    const bindings = [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })];
    const deps = makeDeps([server], bindings);
    deps.operationLog.enqueueOperation('a', { opType: 'CREATE', filePath: 'gone.md' });
    deps.operationLog.enqueueOperation('b', { opType: 'CREATE', filePath: 'keep.md' });
    const m = new EngineManager(deps);
    await m.start();

    bindings.shift(); // remove 'a' entirely
    await m.refreshFromSettings();

    expect(FakeEngine.lastFor('a')?.stopCalls).toBe(1);
    expect(deps.operationLog.pendingCount('a')).toBe(0);
    // 'b' is still in settings — its queue is left alone.
    expect(deps.operationLog.pendingCount('b')).toBe(1);
    await m.stop();
  });

  it('keeps local state when a binding is only disabled', async () => {
    const binding = makeBinding({ id: 'a' });
    const deps = makeDeps([server], [binding]);
    deps.operationLog.enqueueOperation('a', { opType: 'CREATE', filePath: 'note.md' });
    const m = new EngineManager(deps);
    await m.start();

    binding.enabled = false; // dropped from the roster, but still in settings
    await m.refreshFromSettings();

    expect(FakeEngine.lastFor('a')?.stopCalls).toBe(1);
    // Queue survives for when the binding is switched back on.
    expect(deps.operationLog.pendingCount('a')).toBe(1);
    await m.stop();
  });

  it('does not purge on pause', async () => {
    const binding = makeBinding({ id: 'a' });
    const deps = makeDeps([server], [binding]);
    deps.operationLog.enqueueOperation('a', { opType: 'CREATE', filePath: 'note.md' });
    const m = new EngineManager(deps);
    await m.start();

    await m.pause();

    expect(deps.operationLog.pendingCount('a')).toBe(1);
    await m.stop();
  });
});

describe('EngineManager — offline CRDT purge', () => {
  it('purges y-indexeddb state when a binding disappears from settings', async () => {
    const idb = makeFakeIdb(['team-vault-a-gone.md', 'team-vault-b-keep.md']);
    const docManager = new DocManager({ idb: idb.registry });
    const bindings = [makeBinding({ id: 'a' }), makeBinding({ id: 'b' })];
    const m = new EngineManager(makeDeps([server], bindings, { docManager }));
    await m.start();

    bindings.shift(); // remove 'a' entirely
    await m.refreshFromSettings();

    expect(FakeEngine.lastFor('a')?.stopCalls).toBe(1);
    expect(idb.deleted).toEqual(['team-vault-a-gone.md']);
    // 'b' is still in settings — its offline store is left alone.
    expect([...idb.names]).toEqual(['team-vault-b-keep.md']);
    await m.stop();
  });

  it('keeps y-indexeddb state when a binding is only disabled', async () => {
    const idb = makeFakeIdb(['team-vault-a-note.md']);
    const docManager = new DocManager({ idb: idb.registry });
    const binding = makeBinding({ id: 'a' });
    const m = new EngineManager(makeDeps([server], [binding], { docManager }));
    await m.start();

    binding.enabled = false; // dropped from the roster, but still in settings
    await m.refreshFromSettings();

    expect(FakeEngine.lastFor('a')?.stopCalls).toBe(1);
    // Offline edits survive for when the binding is switched back on.
    expect(idb.deleted).toEqual([]);
    expect([...idb.names]).toEqual(['team-vault-a-note.md']);
    await m.stop();
  });

  it('does not purge y-indexeddb state on pause', async () => {
    const idb = makeFakeIdb(['team-vault-a-note.md']);
    const docManager = new DocManager({ idb: idb.registry });
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })], { docManager }));
    await m.start();

    await m.pause();

    expect(idb.deleted).toEqual([]);
    expect([...idb.names]).toEqual(['team-vault-a-note.md']);
    await m.stop();
  });
});

describe('EngineManager — vault event fan-out', () => {
  it('dispatches an event to the matching engine and ignores unknown ids', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const fake = FakeEngine.lastFor('a') as unknown as { handleVaultEvent?: jest.Mock };
    fake.handleVaultEvent = jest.fn(async () => undefined);
    await m.dispatchVaultEvent({
      type: 'create',
      bindingId: 'a',
      path: 'note.md',
      source: 'obsidian',
    });
    expect(fake.handleVaultEvent).toHaveBeenCalledTimes(1);
    await m.dispatchVaultEvent({
      type: 'create',
      bindingId: 'unknown',
      path: 'note.md',
      source: 'obsidian',
    });
    expect(fake.handleVaultEvent).toHaveBeenCalledTimes(1);
  });
});

/**
 * Проводка папки конфигурации из Obsidian (гейт путей, 0.3.3). Все тесты гейта
 * задают `configDir` прямо в `SyncEngineDeps`, поэтому без этой проверки
 * цепочка `main.ts (app.vault.configDir) → EngineManager → SyncEngine` могла
 * бы молча порваться при зелёных тестах.
 */
describe('EngineManager — проводка configDir', () => {
  it('передаёт configDir в каждый движок', async () => {
    const seen: (string | undefined)[] = [];
    const manager = new EngineManager(
      makeDeps([server], [makeBinding({ id: 'a' })], {
        configDir: '.config-obs',
        engineFactory: (deps) => {
          seen.push(deps.configDir);
          return new FakeEngine(deps.binding.id) as unknown as SyncEngine;
        },
      }),
    );
    await manager.start();
    expect(seen).toEqual(['.config-obs']);
    await manager.stop();
  });
});

/**
 * A server edited in the settings tab: a new URL or API key. The bindings stay
 * on the server (same id), and their engines move to the new address with
 * their local state — the offline queue, the file index, the offline
 * documents — kept. Removing the server and adding it again was the only way
 * before: it switched the bindings off, and a new binding starts from scratch.
 */
describe('EngineManager — server address or key changed', () => {
  interface Spawned {
    bindingId: string;
    url: string;
    apiKey: string;
    engine: FakeEngine;
  }

  /** Deps whose engines record what server they were spawned with. */
  function recordingDeps(
    servers: ServerConfig[],
    bindings: VaultBinding[],
    over: Partial<EngineManagerDeps> = {},
    make: (bindingId: string) => FakeEngine = (id) => new FakeEngine(id),
  ): { deps: EngineManagerDeps; spawned: Spawned[] } {
    const spawned: Spawned[] = [];
    const deps = makeDeps(servers, bindings, {
      engineFactory: (engineDeps) => {
        const engine = make(engineDeps.binding.id);
        spawned.push({
          bindingId: engineDeps.binding.id,
          url: engineDeps.server.url,
          apiKey: engineDeps.server.apiKey,
          engine,
        });
        return engine as unknown as SyncEngine;
      },
      ...over,
    });
    return { deps, spawned };
  }

  function spawnedFor(spawned: Spawned[], bindingId: string): Spawned[] {
    return spawned.filter((s) => s.bindingId === bindingId);
  }

  /** Engines whose `stop()` waits for the test to open the gate. */
  function slowStop(gate: Promise<void>): (bindingId: string) => FakeEngine {
    class SlowStopEngine extends FakeEngine {
      override async stop(): Promise<void> {
        this.stopCalls++;
        this.calls.push('stop');
        await gate;
        this.setStatus('stopped');
      }
    }
    return (id) => new SlowStopEngine(id);
  }

  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  const s1 = (): ServerConfig => ({ ...server, id: 's1', url: 'https://old.example.com' });
  const s2 = (): ServerConfig => ({ ...server, id: 's2', url: 'https://home.example.com' });

  it('restarts exactly the engines of the server with a new URL, keeping their local state', async () => {
    const servers = [s1(), s2()];
    const bindings = [
      makeBinding({ id: 'a' }),
      makeBinding({ id: 'b' }),
      makeBinding({ id: 'c', serverId: 's2' }),
    ];
    const idb = makeFakeIdb(['team-vault-a-note.md', 'team-vault-c-note.md']);
    const { deps, spawned } = recordingDeps(servers, bindings, {
      docManager: new DocManager({ idb: idb.registry }),
    });
    deps.operationLog.enqueueOperation('a', { opType: 'UPDATE', filePath: 'note.md' });
    deps.operationLog.setFileMeta({
      bindingId: 'a',
      relativePath: 'note.md',
      serverFileId: 'f1',
      contentHash: 'h1',
      size: 1,
      fileType: 'TEXT',
      lastSyncedAt: 1,
    });
    const m = new EngineManager(deps);
    await m.start();
    const [firstC] = spawnedFor(spawned, 'c');

    // What the settings tab saves: the same entry, same id, a new URL.
    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    await m.refreshFromSettings();

    for (const id of ['a', 'b']) {
      const runs = spawnedFor(spawned, id);
      expect(runs.map((r) => r.url)).toEqual([
        'https://old.example.com',
        'https://teamvault.example.com',
      ]);
      expect(runs[0]?.engine.calls).toEqual(['start', 'stop']);
      expect(runs[1]?.engine.calls).toEqual(['start']);
      expect(m.getEngine(id)).toBe(runs[1]?.engine);
    }
    // The other server's engine is left alone.
    expect(spawnedFor(spawned, 'c')).toHaveLength(1);
    expect(firstC?.engine.calls).toEqual(['start']);
    // Nothing purged: the queue, the file index, the offline documents.
    expect(deps.operationLog.pendingCount('a')).toBe(1);
    expect(deps.operationLog.listFileMeta('a').map((f) => f.relativePath)).toEqual(['note.md']);
    expect(idb.deleted).toEqual([]);
    expect([...idb.names]).toEqual(['team-vault-a-note.md', 'team-vault-c-note.md']);
    await m.stop();
  });

  it('restarts on a new API key, even one written into the same server object', async () => {
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(servers, [makeBinding({ id: 'a' })]);
    const m = new EngineManager(deps);
    await m.start();

    (servers[0] as ServerConfig).apiKey = 'osk_new';
    await m.refreshFromSettings();

    expect(spawnedFor(spawned, 'a').map((r) => r.apiKey)).toEqual(['k', 'osk_new']);
    await m.stop();
  });

  it('restarts nothing for a new name, or when nothing changed', async () => {
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(servers, [makeBinding({ id: 'a' })]);
    const m = new EngineManager(deps);
    await m.start();

    await m.refreshFromSettings();
    servers[0] = { ...s1(), name: 'Renamed' };
    await m.refreshFromSettings();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.engine.calls).toEqual(['start']);
    await m.stop();
  });

  it('while paused, spawns the new engine paused, and it connects on resume', async () => {
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(servers, [makeBinding({ id: 'a' })]);
    const m = new EngineManager(deps);
    await m.start();
    await m.pause();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    await m.refreshFromSettings();

    const [first, second] = spawnedFor(spawned, 'a');
    expect(first?.engine.calls).toEqual(['start', 'pause', 'stop']);
    expect(second?.url).toBe('https://teamvault.example.com');
    expect(second?.engine.calls).toEqual(['pause', 'start']);
    expect(m.getAggregateStatus().state).toBe('paused');

    await m.resume();
    expect(second?.engine.calls).toEqual(['pause', 'start', 'resume']);
    await m.stop();
  });

  it('leaves a binding that is switched off without an engine', async () => {
    const servers = [s1()];
    const bindings = [makeBinding({ id: 'off', enabled: false }), makeBinding({ id: 'on' })];
    const { deps, spawned } = recordingDeps(servers, bindings);
    deps.operationLog.enqueueOperation('on', { opType: 'UPDATE', filePath: 'note.md' });
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    await m.refreshFromSettings();
    expect(spawnedFor(spawned, 'off')).toHaveLength(0);

    // Switched off in the same save as a new URL: stopped, not restarted.
    (bindings[1] as VaultBinding).enabled = false;
    servers[0] = { ...s1(), url: 'https://again.example.com' };
    await m.refreshFromSettings();
    expect(spawnedFor(spawned, 'on')).toHaveLength(2);
    expect(m.getEngine('on')).toBeUndefined();
    expect(deps.operationLog.pendingCount('on')).toBe(1);
    await m.stop();
  });

  it('keeps the status bar off "offline" while an engine restarts', async () => {
    const servers = [s1()];
    const { deps } = recordingDeps(servers, [makeBinding({ id: 'a' })]);
    const m = new EngineManager(deps);
    await m.start();
    FakeEngine.lastFor('a')?.setStatus('connected');
    const seen: string[] = [];
    m.onAggregateStatus((s) => seen.push(s.state));

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    await m.refreshFromSettings();

    expect(seen).not.toContain('offline');
    expect(seen).not.toContain('idle');
    expect(seen[seen.length - 1]).toBe('connecting');
    await m.stop();
  });

  it('restarts once however many refreshes come while the engine stops', async () => {
    const stopping = gate();
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(
      servers,
      [makeBinding({ id: 'a' })],
      {},
      slowStop(stopping.promise),
    );
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    const first = m.refreshFromSettings();
    // Every connect saves the settings, and every save refreshes.
    const second = m.refreshFromSettings();
    const third = m.refreshFromSettings();
    stopping.open();
    await Promise.all([first, second, third]);

    const runs = spawnedFor(spawned, 'a');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.engine.stopCalls).toBe(1);
    expect(m.getEngine('a')).toBe(runs[1]?.engine);
    await m.stop();
  });

  it('respawns with the settings as they are once the engine has stopped', async () => {
    const stopping = gate();
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(
      servers,
      [makeBinding({ id: 'a' })],
      {},
      slowStop(stopping.promise),
    );
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    const refreshing = m.refreshFromSettings();
    // Corrected while the old engine was still stopping.
    servers[0] = { ...s1(), url: 'https://teamvault.example.org' };
    stopping.open();
    await refreshing;
    await m.refreshFromSettings();

    expect(spawnedFor(spawned, 'a').map((r) => r.url)).toEqual([
      'https://old.example.com',
      'https://teamvault.example.org',
    ]);
    await m.stop();
  });

  it('purges and does not respawn a binding removed while its engine restarts', async () => {
    const stopping = gate();
    const servers = [s1()];
    const bindings = [makeBinding({ id: 'a' })];
    const { deps, spawned } = recordingDeps(servers, bindings, {}, slowStop(stopping.promise));
    deps.operationLog.enqueueOperation('a', { opType: 'UPDATE', filePath: 'note.md' });
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    const restarting = m.refreshFromSettings();
    bindings.pop();
    const removing = m.refreshFromSettings();
    stopping.open();
    await Promise.all([restarting, removing]);

    expect(spawnedFor(spawned, 'a')).toHaveLength(1);
    expect(m.getEngine('a')).toBeUndefined();
    expect(deps.operationLog.pendingCount('a')).toBe(0);
    await m.stop();
  });

  it('keeps the new engine when the binding is switched off and on while it restarts', async () => {
    const stopping = gate();
    const servers = [s1()];
    const bindings = [makeBinding({ id: 'a' })];
    const { deps, spawned } = recordingDeps(servers, bindings, {}, slowStop(stopping.promise));
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    const restarting = m.refreshFromSettings();
    (bindings[0] as VaultBinding).enabled = false;
    const switchedOff = m.refreshFromSettings();
    // Back on before the old engine has stopped: the restart finds it on.
    (bindings[0] as VaultBinding).enabled = true;
    stopping.open();
    await Promise.all([restarting, switchedOff]);

    const runs = spawnedFor(spawned, 'a');
    expect(runs.map((r) => r.url)).toEqual([
      'https://old.example.com',
      'https://teamvault.example.com',
    ]);
    // The switch-off's drop, finishing last, leaves the new engine in place:
    // forgotten, it would run on with nothing to stop it.
    expect(m.getEngine('a')).toBe(runs[1]?.engine);
    await m.stop();
    expect(runs[1]?.engine.stopCalls).toBe(1);
  });

  it('spawns nothing when the plugin unloads while an engine restarts', async () => {
    const stopping = gate();
    const servers = [s1()];
    const { deps, spawned } = recordingDeps(
      servers,
      [makeBinding({ id: 'a' })],
      {},
      slowStop(stopping.promise),
    );
    deps.operationLog.enqueueOperation('a', { opType: 'UPDATE', filePath: 'note.md' });
    const m = new EngineManager(deps);
    await m.start();

    servers[0] = { ...s1(), url: 'https://teamvault.example.com' };
    const restarting = m.refreshFromSettings();
    const stopped = m.stop();
    stopping.open();
    await Promise.all([restarting, stopped]);

    expect(spawnedFor(spawned, 'a')).toHaveLength(1);
    expect(m.getEngine('a')).toBeUndefined();
    expect(deps.operationLog.pendingCount('a')).toBe(1);
  });
});
