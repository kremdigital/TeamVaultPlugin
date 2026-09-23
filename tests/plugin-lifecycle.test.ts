import type { App, PluginManifest } from 'obsidian';
import { Notice } from './__mocks__/obsidian';
import TeamVaultPlugin from '@/main';
import { handOffTeardown } from '@/integration/plugin-teardown';

/**
 * `main.ts` itself, for the one thing only it decides: what `onload` still
 * does once Obsidian has unloaded the plugin under it. Obsidian awaits neither
 * `onload` nor `onunload`, so disabling a plugin that is still loading runs
 * `onunload` in the middle of `onload`.
 */

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every already-queued promise reaction run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type FakeApp = App & { layoutReady: jest.Mock; listed: jest.Mock; files: Map<string, string> };

/** An in-memory vault with just the adapter calls `onload` reaches. */
function fakeApp(
  opts: {
    stateGate?: Promise<void>;
    listGate?: Promise<void>;
    /** Files the vault starts with. */
    seed?: Record<string, string>;
    /** How many reads of a path fail with EBUSY before one succeeds. */
    busyReads?: Record<string, number>;
  } = {},
): FakeApp {
  const files = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const busy = new Map<string, number>(Object.entries(opts.busyReads ?? {}));
  const layoutReady = jest.fn();
  // The duplicate plugin-folder scan — the first step after the state file.
  const listed = jest.fn();
  const adapter = {
    exists: async (p: string): Promise<boolean> => {
      if (p.endsWith('/state.json') && opts.stateGate) await opts.stateGate;
      return files.has(p);
    },
    stat: async (p: string) => (files.has(p) ? { size: files.get(p)!.length } : null),
    read: async (p: string): Promise<string> => {
      const left = busy.get(p) ?? 0;
      if (left > 0) {
        busy.set(p, left - 1);
        throw Object.assign(new Error(`EBUSY ${p}`), { code: 'EBUSY' });
      }
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return text;
    },
    write: async (p: string, data: string): Promise<void> => {
      files.set(p, data);
    },
    append: async (p: string, data: string): Promise<void> => {
      files.set(p, (files.get(p) ?? '') + data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    remove: async (p: string): Promise<void> => {
      files.delete(p);
    },
    mkdir: async (): Promise<void> => undefined,
    list: async (p: string) => {
      listed(p);
      if (opts.listGate) await opts.listGate;
      return { files: [], folders: [] };
    },
  };
  const app = {
    vault: { configDir: '.obsidian', adapter, getFiles: () => [] },
    workspace: { onLayoutReady: layoutReady },
    layoutReady,
    listed,
    files,
  };
  return app as unknown as FakeApp;
}

/** The plugin's private parts the tests look at. */
function internals(plugin: TeamVaultPlugin): { operationLog: unknown; engineManager: unknown } {
  return plugin as unknown as { operationLog: unknown; engineManager: unknown };
}

let seq = 0;

/** A plugin with its registration calls spied on, under an id of its own. */
function makePlugin(app: FakeApp): {
  plugin: TeamVaultPlugin;
  registered: jest.Mock;
  id: string;
} {
  // A fresh id per test: the teardown handoff and the state-file claim live
  // on `window`, keyed by the plugin id.
  const id = `team-vault-lifecycle-${++seq}`;
  const manifest = { id, dir: `.obsidian/plugins/${id}` } as PluginManifest;
  // An installed plugin, not a first run: those skip the startup sweeps, and
  // confirming that data.json is missing takes a real-time second look.
  app.files.set(`${manifest.dir}/data.json`, '{}');
  const plugin = new TeamVaultPlugin(app, manifest);
  const registered = jest.fn();
  const record = (what: string) => (): void => {
    registered(what);
  };
  Object.assign(plugin, {
    addSettingTab: record('settings tab'),
    registerView: record('view'),
    addStatusBarItem: record('status bar'),
    addCommand: record('command'),
    registerEvent: record('event'),
  });
  return { plugin, registered, id };
}

describe('plugin lifecycle — unloaded while still loading', () => {
  it('stops at the previous teardown and builds nothing after it', async () => {
    const app = fakeApp();
    const { plugin, registered, id } = makePlugin(app);
    const previous = deferred();
    handOffTeardown(window, id, previous.promise);

    const loading = plugin.onload();
    await settle();
    plugin.onunload();
    previous.resolve();
    await loading;

    expect(internals(plugin).operationLog).toBeNull();
    expect(registered).not.toHaveBeenCalled();
    expect(app.layoutReady).not.toHaveBeenCalled();
    // Settings were loaded (and the client id minted) before the unload.
    expect(plugin.settings.clientId).not.toBe('');
  });

  it('stops after reading the state file: no sweeps, engines, views or watchers', async () => {
    const gate = deferred();
    const app = fakeApp({ stateGate: gate.promise });
    const { plugin, registered } = makePlugin(app);

    const loading = plugin.onload();
    await settle();
    expect(internals(plugin).operationLog).not.toBeNull();
    plugin.onunload();
    gate.resolve();
    await loading;

    // The sweeps delete local state; a plugin already unloaded has no
    // business doing that.
    expect(app.listed).not.toHaveBeenCalled();
    expect(internals(plugin).engineManager).toBeNull();
    expect(registered).not.toHaveBeenCalled();
    expect(app.layoutReady).not.toHaveBeenCalled();
  });

  it('stops after the startup sweeps: no engines, views or watchers', async () => {
    const gate = deferred();
    const app = fakeApp({ listGate: gate.promise });
    const { plugin, registered } = makePlugin(app);

    const loading = plugin.onload();
    await settle();
    expect(app.listed).toHaveBeenCalled();
    plugin.onunload();
    gate.resolve();
    await loading;

    expect(internals(plugin).engineManager).toBeNull();
    expect(registered).not.toHaveBeenCalled();
    expect(app.layoutReady).not.toHaveBeenCalled();
  });
});

describe('plugin lifecycle — a data.json it cannot read', () => {
  // A binding with an operation still queued for the server: exactly what the
  // startup sweep used to purge once the unreadable settings had been
  // replaced by the defaults, which have no bindings.
  const queuedState = JSON.stringify({
    version: 1,
    nextOpId: 2,
    bindings: {
      'binding-1': {
        pending: [
          {
            id: 1,
            bindingId: 'binding-1',
            opType: 'UPDATE',
            filePath: 'note.md',
            newPath: null,
            payload: {},
            createdAt: 1,
          },
        ],
        files: [],
        state: null,
      },
    },
  });
  const settings = JSON.stringify({
    settingsVersion: 2,
    servers: [
      { id: 's1', name: 'Work', url: 'https://sync.example.com', apiKey: 'osk_1', addedAt: 1 },
    ],
    bindings: [
      {
        id: 'binding-1',
        serverId: 's1',
        projectId: 'p1',
        projectName: 'Notes',
        localFolder: '/',
        enabled: true,
        lastSyncedAt: 1,
        lastVectorClock: {},
      },
    ],
    clientId: 'client-1',
  });

  beforeEach(() => {
    jest.useFakeTimers();
    Notice.shown = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Run `onload` to the end, letting the retry pauses pass. */
  async function load(plugin: TeamVaultPlugin): Promise<void> {
    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    await loading;
  }

  it('writes nothing, sweeps nothing and starts nothing over a broken data.json', async () => {
    const id = `team-vault-broken-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const broken = settings.replace('"clientId"', ',"clientId"'); // a stray comma
    const app = fakeApp({
      seed: { [`${dir}/data.json`]: broken, [`${dir}/state.json`]: queuedState },
    });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    const saveData = jest.spyOn(plugin, 'saveData');

    await load(plugin);

    expect(app.files.get(`${dir}/data.json`)).toBe(broken);
    expect(app.files.get(`${dir}/state.json`)).toBe(queuedState);
    expect(saveData).not.toHaveBeenCalled();
    // No first-run client id minted over the one in the file.
    expect(plugin.settings.clientId).toBe('');
    expect(internals(plugin).operationLog).toBeNull();
    expect(internals(plugin).engineManager).toBeNull();
    expect(app.layoutReady).not.toHaveBeenCalled();
    // Told where it can't be missed, and why in the log.
    expect(Notice.shown).toHaveLength(1);
    expect(Notice.shown[0]?.message).toContain(`${dir}/data.json`);
    expect(Notice.shown[0]?.message).toContain('damaged');
    expect(Notice.shown[0]?.timeout).toBe(0);
    const log = app.files.get(`${dir}/sync.log`) ?? '';
    expect(log).toContain('settings file unreadable');
    expect(log).toContain('"reason":"corrupt"');
    // Where the stray comma is — the error itself, not `{}`.
    expect(log).toContain('SyntaxError');
  });

  it('writes nothing over a data.json that stays locked, and says it is held', async () => {
    const id = `team-vault-locked-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const app = fakeApp({
      seed: { [`${dir}/data.json`]: settings, [`${dir}/state.json`]: queuedState },
      busyReads: { [`${dir}/data.json`]: 100 },
    });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    const saveData = jest.spyOn(plugin, 'saveData');

    await load(plugin);

    expect(app.files.get(`${dir}/data.json`)).toBe(settings);
    expect(app.files.get(`${dir}/state.json`)).toBe(queuedState);
    expect(saveData).not.toHaveBeenCalled();
    expect(plugin.settings.clientId).toBe('');
    expect(internals(plugin).operationLog).toBeNull();
    expect(Notice.shown).toHaveLength(1);
    expect(Notice.shown[0]?.timeout).toBe(0);
    // Not the "damaged, fix the file" text: nothing is wrong with the file.
    const message = Notice.shown[0]?.message ?? '';
    expect(message).toContain(`${dir}/data.json`);
    expect(message).toContain('could not open');
    expect(message).not.toContain('damaged');
    expect(app.files.get(`${dir}/sync.log`)).toContain('"reason":"inaccessible"');
  });

  it('on a first run leaves local state it finds alone, and saves the new settings', async () => {
    // No data.json — but a state.json left by an earlier install, or by
    // bindings whose data.json a sync client is replacing right now.
    const id = `team-vault-first-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const scan = deferred();
    const app = fakeApp({ seed: { [`${dir}/state.json`]: queuedState }, listGate: scan.promise });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);

    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    expect(app.listed).toHaveBeenCalled();
    plugin.onunload();
    scan.resolve();
    await jest.advanceTimersByTimeAsync(100);
    await loading;

    expect(plugin.settings.clientId).not.toBe('');
    expect(app.files.get(`${dir}/data.json`)).toContain(plugin.settings.clientId);
    expect(app.files.get(`${dir}/state.json`)).toContain('"note.md"');
    expect(Notice.shown).toEqual([]);
  });

  it('never saves over the file, even when asked to', async () => {
    const id = `team-vault-broken-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const app = fakeApp({ seed: { [`${dir}/data.json`]: '{ "servers": [' } });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    await load(plugin);

    await plugin.saveSettings();
    expect(app.files.get(`${dir}/data.json`)).toBe('{ "servers": [');
  });

  it('reads a data.json another program held for a moment, and starts as usual', async () => {
    const id = `team-vault-busy-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    // Held at the duplicate-folder scan, just before the sweeps, so the test
    // never gets as far as starting engines against a server.
    const scan = deferred();
    const app = fakeApp({
      seed: { [`${dir}/data.json`]: settings, [`${dir}/state.json`]: queuedState },
      busyReads: { [`${dir}/data.json`]: 2 },
      listGate: scan.promise,
    });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);

    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    expect(app.listed).toHaveBeenCalled();
    expect(plugin.settings.clientId).toBe('client-1');
    expect(plugin.settings.bindings.map((b) => b.id)).toEqual(['binding-1']);
    expect(Notice.shown).toEqual([]);

    plugin.onunload();
    scan.resolve();
    await jest.advanceTimersByTimeAsync(100);
    await loading;
    // The binding is known, so its queued operation survives the sweep.
    expect(app.files.get(`${dir}/state.json`)).toContain('"note.md"');
  });
});
