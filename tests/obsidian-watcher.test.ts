import { ObsidianWatcher, type VaultEvent, type WatchableVault } from '@/watcher/obsidian-events';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { VaultBinding } from '@/settings/settings';

/**
 * Lightweight stand-in. We don't `implements WatchableVault` because the
 * interface uses overloaded signatures — TS can't see our single
 * `(name, cb)` impl as compatible. The cast at construction time keeps
 * the watcher's input type honest while letting the test code stay terse.
 */
class FakeVault {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(name: string, cb: (...args: unknown[]) => void): unknown {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(cb);
    return { name, cb };
  }
  offref(ref: unknown): void {
    const r = ref as { name: string; cb: (...args: unknown[]) => void };
    this.listeners.get(r.name)?.delete(r.cb);
  }
  fire(name: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(...args);
  }
  /** Cast helper for passing into `start()`. */
  asVault(): WatchableVault {
    return this as unknown as WatchableVault;
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

function buildWatcher(
  bindings: VaultBinding[],
  options: { recentlyApplied?: RecentlyApplied; clock?: FakeClock; debounceMs?: number } = {},
): { vault: FakeVault; watcher: ObsidianWatcher; events: VaultEvent[]; clock: FakeClock } {
  const vault = new FakeVault();
  const events: VaultEvent[] = [];
  const clock = options.clock ?? new FakeClock();
  const watcher = new ObsidianWatcher({
    bindings: () => bindings,
    recentlyApplied: options.recentlyApplied ?? new RecentlyApplied(),
    modifyDebounceMs: options.debounceMs ?? 100,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  watcher.onEvent((e) => events.push(e));
  watcher.start(vault.asVault());
  return { vault, watcher, events, clock };
}

describe('ObsidianWatcher — scoping', () => {
  it('emits create/delete only for files inside an enabled binding', () => {
    const { vault, events } = buildWatcher([binding({ localFolder: 'notes' })]);
    vault.fire('create', { path: 'notes/a.md', kind: 'file' });
    vault.fire('create', { path: 'work/b.md', kind: 'file' });
    vault.fire('delete', { path: 'notes/a.md', kind: 'file' });
    expect(events).toEqual([
      { type: 'create', bindingId: 'b1', path: 'notes/a.md', source: 'obsidian' },
      { type: 'delete', bindingId: 'b1', path: 'notes/a.md', source: 'obsidian' },
    ]);
  });

  it('drops events for disabled bindings', () => {
    const { vault, events } = buildWatcher([binding({ enabled: false })]);
    vault.fire('create', { path: 'a.md', kind: 'file' });
    expect(events).toEqual([]);
  });

  it('drops folder create/modify events', () => {
    const { vault, events } = buildWatcher([binding()]);
    vault.fire('create', { path: 'notes', kind: 'folder' });
    vault.fire('modify', { path: 'notes', kind: 'folder' });
    expect(events).toEqual([]);
  });

  it('forwards folder deletes with an isFolder marker (engine expands them)', () => {
    const { vault, events } = buildWatcher([binding()]);
    vault.fire('delete', { path: 'notes', kind: 'folder' });
    expect(events).toEqual([
      { type: 'delete', bindingId: 'b1', path: 'notes', source: 'obsidian', isFolder: true },
    ]);
  });

  it('drops always-ignored paths', () => {
    const { vault, events } = buildWatcher([binding()]);
    vault.fire('create', { path: '.obsidian/workspace.json', kind: 'file' });
    vault.fire('create', { path: 'note.tmp', kind: 'file' });
    expect(events).toEqual([]);
  });

  it('fires events for every matching binding', () => {
    const { vault, events } = buildWatcher([
      binding({ id: 'b1', localFolder: '/' }),
      binding({ id: 'b2', localFolder: 'work' }),
    ]);
    vault.fire('create', { path: 'work/a.md', kind: 'file' });
    expect(events.map((e) => (e.type === 'create' ? e.bindingId : 'X'))).toEqual(['b1', 'b2']);
  });
});

describe('ObsidianWatcher — modify debounce', () => {
  it('coalesces rapid modifies into a single event', () => {
    const { vault, events, clock } = buildWatcher([binding()]);
    vault.fire('modify', { path: 'a.md', kind: 'file' });
    vault.fire('modify', { path: 'a.md', kind: 'file' });
    vault.fire('modify', { path: 'a.md', kind: 'file' });
    expect(events).toEqual([]);
    clock.advance(100);
    expect(events).toEqual([{ type: 'modify', bindingId: 'b1', path: 'a.md', source: 'obsidian' }]);
  });

  it('debounces independently per file', () => {
    const { vault, events, clock } = buildWatcher([binding()]);
    vault.fire('modify', { path: 'a.md', kind: 'file' });
    vault.fire('modify', { path: 'b.md', kind: 'file' });
    clock.advance(100);
    expect(events.map((e) => (e.type === 'modify' ? e.path : 'X')).sort()).toEqual([
      'a.md',
      'b.md',
    ]);
  });
});

describe('ObsidianWatcher — recently-applied suppression', () => {
  it('drops a single event after mark()', () => {
    const ra = new RecentlyApplied({ ttlMs: 5000 });
    const { vault, events } = buildWatcher([binding()], { recentlyApplied: ra });
    ra.mark('a.md');
    vault.fire('create', { path: 'a.md', kind: 'file' });
    vault.fire('create', { path: 'a.md', kind: 'file' });
    expect(events).toEqual([
      // First was suppressed; second falls through.
      { type: 'create', bindingId: 'b1', path: 'a.md', source: 'obsidian' },
    ]);
  });
});

describe('ObsidianWatcher — rename', () => {
  it('emits a rename for in-binding moves', () => {
    const { vault, events } = buildWatcher([binding()]);
    vault.fire('rename', { path: 'new.md', kind: 'file' }, 'old.md');
    expect(events).toEqual([
      {
        type: 'rename',
        bindingId: 'b1',
        oldPath: 'old.md',
        newPath: 'new.md',
        source: 'obsidian',
      },
    ]);
  });

  it('translates a rename out of the binding into a delete', () => {
    const { vault, events } = buildWatcher([binding({ localFolder: 'notes' })]);
    vault.fire('rename', { path: 'archive/old.md', kind: 'file' }, 'notes/old.md');
    expect(events).toEqual([
      {
        type: 'delete',
        bindingId: 'b1',
        path: 'notes/old.md',
        source: 'obsidian',
      },
    ]);
  });

  it('translates a rename into the binding into a create', () => {
    const { vault, events } = buildWatcher([binding({ localFolder: 'notes' })]);
    vault.fire('rename', { path: 'notes/new.md', kind: 'file' }, 'archive/old.md');
    expect(events).toEqual([
      {
        type: 'create',
        bindingId: 'b1',
        path: 'notes/new.md',
        source: 'obsidian',
      },
    ]);
  });
});

describe('ObsidianWatcher — lifecycle', () => {
  it('stop() detaches listeners and cancels pending debouncers', () => {
    const { vault, watcher, events, clock } = buildWatcher([binding()]);
    vault.fire('modify', { path: 'a.md', kind: 'file' });
    watcher.stop();
    clock.advance(1000);
    expect(events).toEqual([]);
    // Re-firing now must not produce anything (we offref'd).
    vault.fire('create', { path: 'b.md', kind: 'file' });
    expect(events).toEqual([]);
  });

  it('isolates listener errors', () => {
    const ra = new RecentlyApplied();
    const vault = new FakeVault();
    const events: VaultEvent[] = [];
    const watcher = new ObsidianWatcher({
      bindings: () => [binding()],
      recentlyApplied: ra,
    });
    watcher.onEvent(() => {
      throw new Error('boom');
    });
    watcher.onEvent((e) => events.push(e));
    watcher.start(vault.asVault());
    vault.fire('create', { path: 'a.md', kind: 'file' });
    expect(events).toHaveLength(1);
  });
});
