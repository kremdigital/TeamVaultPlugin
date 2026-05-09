import { EngineManager, type AggregateStatus, type EngineManagerDeps } from '@/sync/engine-manager';
import Database from 'better-sqlite3';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import type { EngineStatus, SyncEngine } from '@/sync/engine';

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
  status: EngineStatus = 'stopped';
  private listeners = new Set<(status: EngineStatus, detail?: string) => void>();

  constructor(public readonly bindingId: string) {
    FakeEngine.instances.set(bindingId, this);
  }

  async start(): Promise<void> {
    this.startCalls++;
    this.setStatus('connecting');
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    this.setStatus('stopped');
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

function makeDeps(servers: ServerConfig[], bindings: VaultBinding[]): EngineManagerDeps {
  return {
    getSettings: () => ({ servers, bindings }),
    vault: memVault,
    operationLog: new OperationLog({ filePath: ':memory:', Database }),
    docManager: new DocManager(),
    recentlyApplied: new RecentlyApplied(),
    clientId: 'device-1',
    engineFactory: (deps) => {
      const fake = new FakeEngine(deps.binding.id);
      return fake as unknown as SyncEngine;
    },
  };
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

  it('pause/resume tears every engine down then re-creates', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    const first = FakeEngine.lastFor('a');
    expect(first?.startCalls).toBe(1);

    await m.pause();
    expect(m.isPaused()).toBe(true);
    expect(first?.stopCalls).toBe(1);

    await m.resume();
    expect(m.isPaused()).toBe(false);
    // Pause/resume cycle creates a fresh engine instance.
    expect(FakeEngine.lastFor('a')?.startCalls).toBe(1);
    await m.stop();
  });

  it('refreshFromSettings is a no-op while paused', async () => {
    const bindings = [makeBinding({ id: 'a' })];
    const m = new EngineManager(makeDeps([server], bindings));
    await m.start();
    await m.pause();
    bindings.push(makeBinding({ id: 'b' }));
    await m.refreshFromSettings();
    expect(FakeEngine.lastFor('b')).toBeUndefined();
  });
});

describe('EngineManager — aggregate status', () => {
  it('reports idle when there are no engines', async () => {
    const m = new EngineManager(makeDeps([server], []));
    await m.start();
    expect(m.getAggregateStatus()).toEqual({ state: 'idle', bindings: {} });
  });

  it('reports paused after pause()', async () => {
    const m = new EngineManager(makeDeps([server], [makeBinding({ id: 'a' })]));
    await m.start();
    await m.pause();
    expect(m.getAggregateStatus().state).toBe('paused');
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
