import { FsWatcher, type FsWatcherFactory } from '@/watcher/fs-watcher';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { VaultBinding } from '@/settings/settings';
import type { VaultEvent } from '@/watcher/obsidian-events';

/**
 * Stand-in for chokidar's FSWatcher. We only need:
 *   - on('add' | 'change' | 'unlink', cb) — to register handlers,
 *   - close()                            — to satisfy stop(),
 *   - fire(...)                          — for the test to drive events.
 */
class FakeFsWatcher {
  static lastInstance: FakeFsWatcher | null = null;
  static lastPaths: string[] = [];
  static lastOptions: unknown = null;
  closed = false;
  private listeners = new Map<string, Set<(p: string) => void>>();

  constructor(paths: string[], options: unknown) {
    FakeFsWatcher.lastInstance = this;
    FakeFsWatcher.lastPaths = paths;
    FakeFsWatcher.lastOptions = options;
  }

  on(event: string, cb: (p: string) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(cb);
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fire(event: string, path: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb(path);
  }
}

class FakeClock {
  now = 0;
  private id = 0;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();
  setTimeout = (cb: () => void, ms: number): unknown => {
    const id = ++this.id;
    this.timers.set(id, { fireAt: this.now + ms, cb });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers.entries()]) {
      if (t.fireAt <= this.now) {
        this.timers.delete(id);
        t.cb();
      }
    }
  }
}

const factory: FsWatcherFactory = (paths, options) =>
  new FakeFsWatcher(paths, options) as unknown as ReturnType<FsWatcherFactory>;

function binding(over: Partial<VaultBinding> = {}): VaultBinding {
  return {
    id: 'b1',
    serverId: 's',
    projectId: 'p',
    projectName: 'Proj',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 0,
    lastVectorClock: {},
    ...over,
  };
}

function buildWatcher(opts: {
  vaultBasePath?: string;
  bindings: VaultBinding[];
  recentlyApplied?: RecentlyApplied;
  clock?: FakeClock;
  modifyDebounceMs?: number;
}): {
  watcher: FsWatcher;
  events: VaultEvent[];
  fakeWatcher: () => FakeFsWatcher;
  clock: FakeClock;
} {
  const events: VaultEvent[] = [];
  const clock = opts.clock ?? new FakeClock();
  const watcher = new FsWatcher({
    vaultBasePath: opts.vaultBasePath ?? '/vault',
    bindings: () => opts.bindings,
    recentlyApplied: opts.recentlyApplied ?? new RecentlyApplied(),
    factory,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
    modifyDebounceMs: opts.modifyDebounceMs ?? 100,
  });
  watcher.onEvent((e) => events.push(e));
  watcher.start();
  return {
    watcher,
    events,
    clock,
    fakeWatcher: () => {
      const inst = FakeFsWatcher.lastInstance;
      if (!inst) throw new Error('FakeFsWatcher not constructed');
      return inst;
    },
  };
}

afterEach(() => {
  FakeFsWatcher.lastInstance = null;
  FakeFsWatcher.lastOptions = null;
  FakeFsWatcher.lastPaths = [];
});

describe('FsWatcher — wiring', () => {
  it('passes the vault base path to chokidar', () => {
    buildWatcher({ vaultBasePath: '/vault', bindings: [binding()] });
    expect(FakeFsWatcher.lastPaths).toEqual(['/vault']);
  });

  it('configures ignoreInitial + awaitWriteFinish', () => {
    buildWatcher({ bindings: [binding()] });
    const opts = FakeFsWatcher.lastOptions as Record<string, unknown>;
    expect(opts.ignoreInitial).toBe(true);
    expect(opts.awaitWriteFinish).toEqual({ stabilityThreshold: 200, pollInterval: 50 });
  });

  it('start() is idempotent', () => {
    const { watcher } = buildWatcher({ bindings: [binding()] });
    const inst = FakeFsWatcher.lastInstance;
    watcher.start();
    expect(FakeFsWatcher.lastInstance).toBe(inst);
  });
});

describe('FsWatcher — scoping', () => {
  it('emits events for files inside enabled bindings only', () => {
    const { events, fakeWatcher } = buildWatcher({
      bindings: [binding({ localFolder: 'notes' })],
    });
    fakeWatcher().fire('add', '/vault/notes/a.md');
    fakeWatcher().fire('add', '/vault/work/b.md');
    expect(events).toEqual([{ type: 'create', bindingId: 'b1', path: 'notes/a.md', source: 'fs' }]);
  });

  it('drops always-ignored paths even when reported', () => {
    const { events, fakeWatcher } = buildWatcher({ bindings: [binding()] });
    fakeWatcher().fire('add', '/vault/.git/HEAD');
    fakeWatcher().fire('add', '/vault/foo.tmp');
    expect(events).toEqual([]);
  });

  it('drops paths outside the vault root', () => {
    const { events, fakeWatcher } = buildWatcher({
      vaultBasePath: '/vault',
      bindings: [binding()],
    });
    fakeWatcher().fire('add', '/elsewhere/note.md');
    expect(events).toEqual([]);
  });
});

describe('FsWatcher — modify debounce', () => {
  it('coalesces rapid changes', () => {
    const { events, fakeWatcher, clock } = buildWatcher({ bindings: [binding()] });
    fakeWatcher().fire('change', '/vault/a.md');
    fakeWatcher().fire('change', '/vault/a.md');
    expect(events).toEqual([]);
    clock.advance(100);
    expect(events).toEqual([{ type: 'modify', bindingId: 'b1', path: 'a.md', source: 'fs' }]);
  });
});

describe('FsWatcher — dedupe with Obsidian events', () => {
  it('drops a chokidar event already seen via Obsidian within the dedupe window', () => {
    const { watcher, events, fakeWatcher } = buildWatcher({ bindings: [binding()] });
    watcher.notifyObsidianEvent('create', 'a.md');
    fakeWatcher().fire('add', '/vault/a.md');
    expect(events).toEqual([]);
  });

  it('passes through after the dedupe window elapses', () => {
    const clock = new FakeClock();
    const { watcher, events, fakeWatcher } = buildWatcher({ clock, bindings: [binding()] });
    watcher.notifyObsidianEvent('create', 'a.md');
    clock.now = 5000; // outside the default 800 ms window
    fakeWatcher().fire('add', '/vault/a.md');
    expect(events).toEqual([{ type: 'create', bindingId: 'b1', path: 'a.md', source: 'fs' }]);
  });
});

describe('FsWatcher — recently-applied suppression', () => {
  it('takes the marker and skips the event', () => {
    const ra = new RecentlyApplied({ ttlMs: 5000 });
    const { events, fakeWatcher } = buildWatcher({
      bindings: [binding()],
      recentlyApplied: ra,
    });
    ra.mark('a.md');
    fakeWatcher().fire('add', '/vault/a.md');
    fakeWatcher().fire('add', '/vault/a.md');
    expect(events).toEqual([
      { type: 'create', bindingId: 'b1', path: 'a.md', source: 'fs' }, // 2nd one falls through
    ]);
  });

  it('mark(path, count) suppresses up to `count` watcher events', () => {
    // The bug this guards against: a system-applied write that fires
    // multiple chokidar events (`unlink` + `add` for atomic-rename
    // writes) used to leak the leftovers past `take()`. The leftover
    // `unlink` would cascade into a `file:delete` round-trip and the
    // engine would then phantom-CREATE the file on the next echo.
    const ra = new RecentlyApplied({ ttlMs: 5000 });
    const { events, fakeWatcher } = buildWatcher({
      bindings: [binding()],
      recentlyApplied: ra,
    });
    ra.mark('a.md', 3);
    fakeWatcher().fire('unlink', '/vault/a.md');
    fakeWatcher().fire('add', '/vault/a.md');
    fakeWatcher().fire('add', '/vault/a.md');
    // All three echoes consumed; nothing dispatched.
    expect(events).toEqual([]);
    // A fourth event falls through as a real change.
    fakeWatcher().fire('add', '/vault/a.md');
    expect(events).toEqual([{ type: 'create', bindingId: 'b1', path: 'a.md', source: 'fs' }]);
  });
});

describe('FsWatcher — lifecycle', () => {
  it('stop() closes the chokidar instance', async () => {
    const { watcher, fakeWatcher } = buildWatcher({ bindings: [binding()] });
    const inst = fakeWatcher();
    await watcher.stop();
    expect(inst.closed).toBe(true);
  });
});
