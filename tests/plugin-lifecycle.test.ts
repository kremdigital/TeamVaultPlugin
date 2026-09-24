import type { App, PluginManifest } from 'obsidian';
import { type ButtonComponent, Notice, Setting } from './__mocks__/obsidian';
import TeamVaultPlugin from '@/main';
import { handOffTeardown } from '@/integration/plugin-teardown';
import { SyncSettingsTab } from '@/settings/tab';
import { t } from '@/i18n';

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

describe('plugin lifecycle — a data.json with entries it cannot read', () => {
  /** A `state.json` with one operation queued for each of these bindings. */
  function queued(...bindingIds: string[]): string {
    const bindings: Record<string, unknown> = {};
    bindingIds.forEach((bindingId, i) => {
      bindings[bindingId] = {
        pending: [
          {
            id: i + 1,
            bindingId,
            opType: 'UPDATE',
            filePath: `${bindingId}.md`,
            newPath: null,
            payload: {},
            createdAt: 1,
          },
        ],
        files: [],
        state: null,
      };
    });
    return JSON.stringify({ version: 1, nextOpId: bindingIds.length + 1, bindings });
  }
  const server = {
    id: 's1',
    name: 'Work',
    url: 'https://sync.example.com',
    apiKey: 'osk_1',
    addedAt: 1,
  };
  /** A binding as the plugin saves it. */
  const binding = (id: string): Record<string, unknown> => ({
    id,
    serverId: 's1',
    projectId: `project-${id}`,
    projectName: 'Notes',
    localFolder: `/${id}`,
    enabled: true,
    lastSyncedAt: 1,
    lastVectorClock: {},
  });
  /** The same, after a hand edit lost its project id. */
  const withoutProject = (id: string): Record<string, unknown> => {
    const { projectId: _projectId, ...rest } = binding(id);
    return rest;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    Notice.shown = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Run `onload` up to the duplicate-folder scan, unload, and let it finish:
   * the orphan sweep still runs, but no engine ever starts against a server.
   */
  async function loadThroughSweeps(seed: Record<string, string>, dir: string, id: string) {
    const scan = deferred();
    const app = fakeApp({ seed, listGate: scan.promise });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    expect(app.listed).toHaveBeenCalled();
    plugin.onunload();
    scan.resolve();
    await jest.advanceTimersByTimeAsync(100);
    await loading;
    return { app, plugin };
  }

  it('keeps the offline queue of a binding it could not read', async () => {
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [withoutProject('binding-1')],
      clientId: 'client-1',
    });
    const state = queued('binding-1');

    const { app, plugin } = await loadThroughSweeps(
      { [`${dir}/data.json`]: data, [`${dir}/state.json`]: state },
      dir,
      id,
    );

    expect(plugin.settings.bindings).toEqual([]);
    // Not swept as orphaned: the queued edit is still there to send.
    expect(app.files.get(`${dir}/state.json`)).toBe(state);
    expect(app.files.get(`${dir}/data.json`)).toBe(data);
    const log = app.files.get(`${dir}/sync.log`) ?? '';
    expect(log).toContain('[error]');
    expect(log).toContain('orphaned-state sweep skipped');
    expect(log).toContain('"bindings":[{"index":0,"id":"binding-1","invalid":["projectId"]}]');
    expect(log).not.toContain('swept orphaned');
    // The binding doesn't sync, and nothing else in the UI would say so.
    expect(Notice.shown).toHaveLength(1);
    expect(Notice.shown[0]?.timeout).toBe(0);
    expect(Notice.shown[0]?.message).toContain(`${dir}/data.json`);
    expect(Notice.shown[0]?.message).toContain('bindings: 1');
    // A running plugin saves its settings over a hand edit of data.json: the
    // notice says to turn it off before fixing the file, not after.
    expect(Notice.shown[0]?.message).toContain('first turn the plugin off');
  });

  it('names the skipped entries in sync.log with Log level set to Errors only', async () => {
    // The notice and the settings tab send the user to sync.log for which
    // entry and why. Logged at `warn`, the line never got there at this level.
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [withoutProject('binding-1')],
      clientId: 'client-1',
      logLevel: 'error',
    });

    const { app, plugin } = await loadThroughSweeps({ [`${dir}/data.json`]: data }, dir, id);

    expect(plugin.settings.logLevel).toBe('error');
    expect(Notice.shown[0]?.message).toContain('sync.log');
    const log = app.files.get(`${dir}/sync.log`) ?? '';
    expect(log).toContain('settings entries unreadable');
    expect(log).toContain('"bindings":[{"index":0,"id":"binding-1","invalid":["projectId"]}]');
    // Still positions, ids and fields only: no server entry, no key.
    expect(log).not.toContain('osk_1');
  });

  it('keeps such an entry in data.json when it saves, in its place', async () => {
    // No client id yet: the plugin mints one and saves at once.
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const brokenServer = { id: 's2', name: 'Home', url: 'https://home.example.com' };
    const data = JSON.stringify({
      servers: [brokenServer, server],
      bindings: [binding('binding-0'), withoutProject('binding-1'), binding('binding-2')],
    });
    const state = queued('binding-1');

    const { app, plugin } = await loadThroughSweeps(
      { [`${dir}/data.json`]: data, [`${dir}/state.json`]: state },
      dir,
      id,
    );

    const saved = JSON.parse(app.files.get(`${dir}/data.json`) ?? '{}') as Record<string, unknown>;
    expect(saved.clientId).toBe(plugin.settings.clientId);
    expect(plugin.settings.clientId).not.toBe('');
    expect(saved.servers).toEqual([brokenServer, server]);
    expect(saved.bindings).toEqual([
      binding('binding-0'),
      withoutProject('binding-1'),
      binding('binding-2'),
    ]);
    expect(app.files.get(`${dir}/state.json`)).toBe(state);
    // The server entry's API key — had it one — never reaches the log.
    const log = app.files.get(`${dir}/sync.log`) ?? '';
    expect(log).toContain('"servers":[{"index":0,"id":"s2","invalid":["apiKey"]}]');
    expect(log).not.toContain('home.example.com');
    expect(Notice.shown[0]?.message).toContain('bindings: 1, servers: 1');
  });

  it('keeps local state when a list in data.json is not a list at all', async () => {
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      servers: 'oops',
      bindings: { 'binding-1': binding('binding-1') },
      clientId: 'client-1',
    });
    const state = queued('binding-1');

    const { app, plugin } = await loadThroughSweeps(
      { [`${dir}/data.json`]: data, [`${dir}/state.json`]: state },
      dir,
      id,
    );

    expect(plugin.settings.servers).toEqual([]);
    expect(plugin.settings.bindings).toEqual([]);
    expect(app.files.get(`${dir}/state.json`)).toBe(state);
    expect(app.files.get(`${dir}/data.json`)).toBe(data);
    const log = app.files.get(`${dir}/sync.log`) ?? '';
    expect(log).toContain('"servers":"not a list (string)"');
    expect(log).toContain('"bindings":"not a list (object)"');
    expect(Notice.shown[0]?.message).toContain('the binding list, the server list');
  });

  it('still sweeps a binding that is gone from a data.json it read in full', async () => {
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [binding('binding-1')],
      clientId: 'client-1',
    });

    const { app } = await loadThroughSweeps(
      { [`${dir}/data.json`]: data, [`${dir}/state.json`]: queued('binding-1', 'binding-gone') },
      dir,
      id,
    );

    const state = app.files.get(`${dir}/state.json`) ?? '';
    expect(state).toContain('binding-1.md');
    expect(state).not.toContain('binding-gone');
    expect(app.files.get(`${dir}/sync.log`)).toContain('swept orphaned binding state');
    expect(Notice.shown).toEqual([]);
  });

  /** The settings tab's "Add binding" setting and button, as the tab renders them. */
  function addBindingSetting(
    app: App,
    plugin: TeamVaultPlugin,
  ): { setting: Setting; button: ButtonComponent } {
    Setting.all = [];
    new SyncSettingsTab(app, plugin).display();
    for (const setting of Setting.all) {
      const button = setting.settingButtons.find((b) => b.text === t('settings.bindings.add'));
      if (button) return { setting, button };
    }
    throw new Error('the settings tab has no "Add binding" button');
  }

  // Were a binding added next to one the plugin could not read, the save would
  // keep both, and fixing the old one would leave two bindings on the vault
  // root — both syncing every file.
  it.each([
    ['a binding in it has no project id', [{ ...withoutProject('binding-1'), localFolder: '/' }]],
    ['its binding list is not a list', { ...binding('binding-1'), localFolder: '/' }],
  ])('will not add a binding while %s', async (_case, bindings) => {
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings,
      clientId: 'client-1',
    });

    const { app, plugin } = await loadThroughSweeps({ [`${dir}/data.json`]: data }, dir, id);

    expect(plugin.settings.bindings).toEqual([]);
    expect(plugin.bindingAddBlock()).toBe('unreadable');
    const { setting, button } = addBindingSetting(app, plugin);
    expect(button.disabled).toBe(true);
    expect(setting.desc).toBe(t('settings.bindings.unreadable'));
  });

  it('lets a binding be added once the file is read in full and has none', async () => {
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [],
      clientId: 'client-1',
    });

    const { app, plugin } = await loadThroughSweeps({ [`${dir}/data.json`]: data }, dir, id);

    expect(plugin.bindingAddBlock()).toBeNull();
    const { setting, button } = addBindingSetting(app, plugin);
    expect(button.disabled).toBe(false);
    expect(setting.desc).toBe('');
  });
});

describe('plugin lifecycle — atomic-write leftovers', () => {
  /** An element that takes every DOM call the status bar makes. */
  function anyEl(): HTMLElement {
    const el: HTMLElement = new Proxy(
      {},
      { get: (_target, key) => (key === 'then' ? undefined : () => el) },
    ) as HTMLElement;
    return el;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // Obsidian starts community plugins before it indexes the vault, and awaits
  // neither: `vault.getFiles()` is empty in `onload`. The leftover sweep ran
  // there and never found one in a real vault.
  it('removes a leftover once the vault is indexed', async () => {
    const id = `team-vault-tmp-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const leftover = `note.md.tmp.${process.pid + 1}.abc123`;
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [
        { id: 's1', name: 'Work', url: 'https://sync.example.com', apiKey: 'osk_1', addedAt: 1 },
      ],
      // Switched off: no engine connects anywhere.
      bindings: [
        {
          id: 'binding-1',
          serverId: 's1',
          projectId: 'p1',
          projectName: 'Notes',
          localFolder: '/',
          enabled: false,
          lastSyncedAt: 1,
          lastVectorClock: {},
        },
      ],
      clientId: 'client-1',
    });
    const app = fakeApp({ seed: { [`${dir}/data.json`]: data, [leftover]: 'x', 'note.md': 'x' } });
    let indexed: string[] = [];
    (app.vault as unknown as { getFiles: () => { path: string }[] }).getFiles = () =>
      indexed.map((path) => ({ path }));
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    Object.assign(plugin, {
      addSettingTab: jest.fn(),
      registerView: jest.fn(),
      addStatusBarItem: anyEl,
      addCommand: jest.fn(),
      registerEvent: jest.fn(),
    });

    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    await loading;
    expect(app.files.has(leftover)).toBe(true);

    // Obsidian has indexed the vault and laid out the workspace.
    indexed = [leftover, 'note.md'];
    for (const [ready] of app.layoutReady.mock.calls as [() => void][]) {
      try {
        ready();
      } catch {
        // The watchers need more of Obsidian than this fake has.
      }
    }
    await jest.advanceTimersByTimeAsync(100);

    expect(app.files.has(leftover)).toBe(false);
    expect(app.files.get('note.md')).toBe('x');
    plugin.onunload();
    await jest.advanceTimersByTimeAsync(100);
  });
});
