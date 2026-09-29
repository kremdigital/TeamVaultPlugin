import type { App, PluginManifest } from 'obsidian';
import { type ButtonComponent, Notice, Setting } from './__mocks__/obsidian';
import TeamVaultPlugin from '@/main';
import { handOffTeardown } from '@/integration/plugin-teardown';
import { SyncSettingsTab } from '@/settings/tab';
import { t } from '@/i18n';
import { ApiClient } from '@/client/api';
import { SocketClient } from '@/client/socket';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import type { EngineManager } from '@/sync/engine-manager';
import { CLIENT_ID_KEY } from '@/settings/client-identity';

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

/**
 * Obsidian's `localStorage`, one for every vault of the machine (the
 * renderer's origin), with a write that fails while `full` is set.
 */
interface FakeLocalStorage {
  items: Map<string, string>;
  full: boolean;
}

function localStorageOf(): FakeLocalStorage {
  return { items: new Map(), full: false };
}

/**
 * Give `app` Obsidian's vault-scoped local storage (app.js 1.13.7): JSON under
 * `<appId>-<key>`, `appId` being the vault's id in Obsidian's vault list; a
 * falsy value removes the key; a write that fails is dropped without a word.
 */
function withLocalStorage(app: FakeApp, appId: string, storage: FakeLocalStorage): FakeApp {
  Object.assign(app, {
    appId,
    loadLocalStorage: (key: string): unknown => {
      const raw = storage.items.get(`${appId}-${key}`);
      return raw ? (JSON.parse(raw) as unknown) : null;
    },
    saveLocalStorage: (key: string, data: unknown): void => {
      if (!data) {
        storage.items.delete(`${appId}-${key}`);
        return;
      }
      if (storage.full) return;
      storage.items.set(`${appId}-${key}`, JSON.stringify(data));
    },
  });
  return app;
}

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
    workspace: { onLayoutReady: layoutReady, on: jest.fn(() => ({})) },
    layoutReady,
    listed,
    files,
  };
  return app as unknown as FakeApp;
}

/** An element that takes every DOM call the status bar makes. */
function anyEl(): HTMLElement {
  const el: HTMLElement = new Proxy(
    {},
    { get: (_target, key) => (key === 'then' ? undefined : () => el) },
  ) as HTMLElement;
  return el;
}

/** Stub the calls into Obsidian's UI that `onload` makes once it gets that far. */
function stubUi(plugin: TeamVaultPlugin): void {
  Object.assign(plugin, {
    addSettingTab: jest.fn(),
    registerView: jest.fn(),
    addStatusBarItem: anyEl,
    addCommand: jest.fn(),
    registerEvent: jest.fn(),
  });
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
    // The client id is settled only right before the engines: none minted,
    // nothing saved.
    expect(plugin.settings.clientId).toBe('');
    expect(app.files.get(`.obsidian/plugins/${id}/data.json`)).toBe('{}');
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
    const app = fakeApp({ seed: { [`${dir}/state.json`]: queuedState } });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    // No bindings yet: loaded to the end, nothing connects.
    stubUi(plugin);

    await load(plugin);

    expect(plugin.settings.clientId).not.toBe('');
    expect(app.files.get(`${dir}/data.json`)).toContain(plugin.settings.clientId);
    expect(app.files.get(`${dir}/state.json`)).toContain('"note.md"');
    expect(Notice.shown).toEqual([]);
    plugin.onunload();
    await jest.advanceTimersByTimeAsync(100);
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
    // No client id yet: the plugin mints one and saves before it starts the
    // engines — which connect nowhere here.
    const connect = jest.spyOn(SocketClient.prototype, 'connect').mockImplementation(() => {});
    const id = `team-vault-skipped-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const brokenServer = { id: 's2', name: 'Home', url: 'https://home.example.com' };
    const data = JSON.stringify({
      servers: [brokenServer, server],
      bindings: [binding('binding-0'), withoutProject('binding-1'), binding('binding-2')],
    });
    const state = queued('binding-1');
    const app = fakeApp({ seed: { [`${dir}/data.json`]: data, [`${dir}/state.json`]: state } });
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    stubUi(plugin);
    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    await loading;
    plugin.onunload();
    await jest.advanceTimersByTimeAsync(100);
    connect.mockRestore();

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

describe('plugin lifecycle — the client id of a copied vault', () => {
  const server = {
    id: 's1',
    name: 'Work',
    url: 'https://sync.example.com',
    apiKey: 'osk_1',
    addedAt: 1,
  };
  const binding = {
    id: 'binding-1',
    serverId: 's1',
    projectId: 'p1',
    projectName: 'Notes',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 1,
    lastVectorClock: {},
  };
  /** A data.json as 0.4.0 wrote it, with `extra` fields. */
  const dataJson = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [binding],
      clientId: 'client-1',
      ...extra,
    });

  let connect: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 8, 28, 12));
    Notice.shown = [];
    // The binding's engine starts; its socket connects nowhere.
    connect = jest.spyOn(SocketClient.prototype, 'connect').mockImplementation(() => {});
  });
  afterEach(() => {
    connect.mockRestore();
    jest.useRealTimers();
  });

  interface Started {
    plugin: TeamVaultPlugin;
    saved: () => Record<string, unknown>;
    log: () => string;
    /** The client id the binding's engine syncs under. */
    engineClientId: () => string | undefined;
    stop: () => Promise<void>;
  }

  /** Start the plugin to the end on `app` (its files and local storage as they are). */
  async function start(app: FakeApp, id: string): Promise<Started> {
    const dir = `.obsidian/plugins/${id}`;
    const plugin = new TeamVaultPlugin(app, { id, dir } as PluginManifest);
    stubUi(plugin);
    const loading = plugin.onload();
    await jest.advanceTimersByTimeAsync(5000);
    await loading;
    return {
      plugin,
      saved: () => JSON.parse(app.files.get(`${dir}/data.json`) ?? '{}') as Record<string, unknown>,
      log: () => app.files.get(`${dir}/sync.log`) ?? '',
      engineClientId: () => {
        const manager = internals(plugin).engineManager as EngineManager | null;
        const engine = manager?.getEngine('binding-1') as unknown as { clientId?: string };
        return engine?.clientId;
      },
      stop: async () => {
        plugin.onunload();
        await jest.advanceTimersByTimeAsync(100);
      },
    };
  }

  /** A vault whose plugin folder holds `data`, registered in Obsidian as `appId`. */
  function vault(
    id: string,
    data: string,
    appId: string,
    storage: FakeLocalStorage | null,
  ): FakeApp {
    const app = fakeApp({ seed: { [`.obsidian/plugins/${id}/data.json`]: data } });
    return storage ? withLocalStorage(app, appId, storage) : app;
  }

  it('binds the id of a data.json from before to the vault, without changing it', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const app = vault(id, dataJson(), 'vault-a', storage);

    const run = await start(app, id);

    expect(run.plugin.settings.clientId).toBe('client-1');
    expect(run.saved()).toMatchObject({ clientId: 'client-1', clientIdClaimed: true });
    expect(storage.items.get(`vault-a-${CLIENT_ID_KEY}`)).toBe('"client-1"');
    expect(run.engineClientId()).toBe('client-1');
    expect(Notice.shown).toEqual([]);
    await run.stop();
  });

  // The regression: a vault copied along with its data.json kept the id, and
  // its changes and the original's shared one counter in the vector clocks.
  it('gives a copy of the vault a new id before any engine starts, and leaves the original’s', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const original = vault(id, dataJson(), 'vault-a', storage);
    const first = await start(original, id);
    await first.stop();
    const copiedData = original.files.get(`.obsidian/plugins/${id}/data.json`) ?? '';

    // The folder copied and opened as a vault of its own: another entry of
    // Obsidian's vault list, the same local storage of the machine.
    const copyId = `team-vault-identity-${++seq}`;
    const copy = vault(copyId, copiedData, 'vault-b', storage);
    const startedAt = Date.now();
    const run = await start(copy, copyId);

    const clientId = run.plugin.settings.clientId;
    expect(clientId).not.toBe('client-1');
    expect(clientId).not.toBe('');
    expect(run.engineClientId()).toBe(clientId);
    // `client-1` is the original's: the copy sent nothing under it.
    expect(run.saved()).toMatchObject({
      clientId,
      clientIdClaimed: true,
      twinClientId: '',
      previousClientIds: [],
    });
    expect(run.saved().clientIdRotatedAt).toBeGreaterThanOrEqual(startedAt);
    expect(run.saved().clientIdRotatedAt).toBeLessThanOrEqual(Date.now());
    expect(storage.items.get(`vault-b-${CLIENT_ID_KEY}`)).toBe(JSON.stringify(clientId));
    expect(storage.items.get(`vault-a-${CLIENT_ID_KEY}`)).toBe('"client-1"');
    expect(Notice.shown.map((n) => n.message)).toEqual([t('notice.clientIdReplaced')]);
    expect(run.log()).toContain('client id replaced');
    expect(run.log()).toContain('"reason":"vault-copied"');
    await run.stop();

    // The original starts as it did.
    Notice.shown = [];
    const again = await start(original, id);
    expect(again.plugin.settings.clientId).toBe('client-1');
    expect(Notice.shown).toEqual([]);
    await again.stop();
  });

  // The regression: the copy's data.json, back in the original's plugin
  // folder (a folder another tool syncs, the copy carried back), listed the
  // original's id as one left, and the original took the copy's id — two
  // devices under one id.
  it('leaves the original its own id when the copy’s data.json comes back to it', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const original = vault(id, dataJson(), 'vault-a', storage);
    await (await start(original, id)).stop();

    const copyId = `team-vault-identity-${++seq}`;
    const copy = vault(
      copyId,
      original.files.get(`.obsidian/plugins/${id}/data.json`) ?? '',
      'vault-b',
      storage,
    );
    const copied = await start(copy, copyId);
    const copyClientId = copied.plugin.settings.clientId;
    expect(copyClientId).not.toBe('client-1');
    await copied.stop();

    original.files.set(
      `.obsidian/plugins/${id}/data.json`,
      copy.files.get(`.obsidian/plugins/${copyId}/data.json`) ?? '',
    );
    Notice.shown = [];
    const back = await start(original, id);
    expect(back.plugin.settings.clientId).toBe('client-1');
    expect(back.engineClientId()).toBe('client-1');
    expect(back.saved()).toMatchObject({ clientId: 'client-1' });
    expect(storage.items.get(`vault-a-${CLIENT_ID_KEY}`)).toBe('"client-1"');
    expect(Notice.shown).toEqual([]);
    await back.stop();

    // And the copy, its data.json the original's again, keeps its own.
    copy.files.set(
      `.obsidian/plugins/${copyId}/data.json`,
      original.files.get(`.obsidian/plugins/${id}/data.json`) ?? '',
    );
    const again = await start(copy, copyId);
    expect(again.plugin.settings.clientId).toBe(copyClientId);
    expect(again.engineClientId()).toBe(copyClientId);
    await again.stop();
  });

  // The same through a twin: a pair from before whose data.json another tool
  // syncs; the one that left the shared id listed it as left in data.json,
  // and the other, given that data.json, took the new id too.
  it('leaves each of a pair from before its own id once one of them left the shared one', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const a = vault(id, dataJson(), 'vault-a', storage);
    const bId = `team-vault-identity-${++seq}`;
    const b = vault(bId, dataJson(), 'vault-b', storage);
    await (await start(a, id)).stop();
    const first = await start(b, bId);
    expect(first.plugin.settings.clientId).toBe('client-1');
    const manager = internals(first.plugin).engineManager as {
      deps: { onTwinDetected?: (clientId: string) => void };
    };
    manager.deps.onTwinDetected?.('client-1');
    await jest.advanceTimersByTimeAsync(100);
    await first.stop();

    const left = await start(b, bId);
    const bClientId = left.plugin.settings.clientId;
    expect(bClientId).not.toBe('client-1');
    expect(left.saved()).toMatchObject({ previousClientIds: ['client-1'] });
    await left.stop();

    // The synced data.json: B's, in A's plugin folder.
    a.files.set(
      `.obsidian/plugins/${id}/data.json`,
      b.files.get(`.obsidian/plugins/${bId}/data.json`) ?? '',
    );
    Notice.shown = [];
    const run = await start(a, id);
    expect(run.plugin.settings.clientId).toBe('client-1');
    expect(run.engineClientId()).toBe('client-1');
    expect(run.log()).toContain('"reason":"from-vault-store"');
    expect(Notice.shown).toEqual([]);
    await run.stop();
  });

  // A copy of a vault whose id changed within the day synced under that
  // vault's id until the day was out.
  it('gives a copy of a copy made the same day an id of its own', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const original = vault(id, dataJson(), 'vault-a', storage);
    await (await start(original, id)).stop();
    const copyId = `team-vault-identity-${++seq}`;
    const copy = vault(
      copyId,
      original.files.get(`.obsidian/plugins/${id}/data.json`) ?? '',
      'vault-b',
      storage,
    );
    const first = await start(copy, copyId);
    const firstId = first.plugin.settings.clientId;
    await first.stop();

    jest.setSystemTime(Date.now() + 60 * 60 * 1000);
    const secondId = `team-vault-identity-${++seq}`;
    const second = vault(
      secondId,
      copy.files.get(`.obsidian/plugins/${copyId}/data.json`) ?? '',
      'vault-c',
      storage,
    );
    const run = await start(second, secondId);
    const clientId = run.plugin.settings.clientId;
    expect([firstId, 'client-1']).not.toContain(clientId);
    expect(run.engineClientId()).toBe(clientId);
    expect(run.saved()).toMatchObject({ clientId, previousClientIds: [] });
    expect(run.log()).toContain('"reason":"vault-copied"');
    await run.stop();
  });

  it('gives the vault a new id at the start after an engine saw another device under it', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    const app = vault(id, dataJson(), 'vault-a', storage);
    const first = await start(app, id);
    const manager = internals(first.plugin).engineManager as {
      deps: { onTwinDetected?: (clientId: string) => void };
    };
    manager.deps.onTwinDetected?.('client-1');
    manager.deps.onTwinDetected?.('client-1');
    // An id the vault no longer has: nothing.
    manager.deps.onTwinDetected?.('someone-else');
    await jest.advanceTimersByTimeAsync(100);
    expect(first.saved()).toMatchObject({ clientId: 'client-1', twinClientId: 'client-1' });
    expect(Notice.shown.map((n) => n.message)).toEqual([t('notice.clientIdTwin')]);
    await first.stop();

    Notice.shown = [];
    const run = await start(app, id);
    const clientId = run.plugin.settings.clientId;
    expect(clientId).not.toBe('client-1');
    expect(run.engineClientId()).toBe(clientId);
    expect(run.saved()).toMatchObject({
      clientId,
      twinClientId: '',
      previousClientIds: ['client-1'],
    });
    expect(storage.items.get(`vault-a-${CLIENT_ID_KEY}`)).toBe(JSON.stringify(clientId));
    expect(Notice.shown.map((n) => n.message)).toEqual([t('notice.clientIdReplaced')]);
    expect(run.log()).toContain('"reason":"twin-seen"');
    await run.stop();
  });

  // Obsidian drops a write to a full local storage without a word. Taken for
  // one that stuck, each start after it took the vault for a copy: a new id,
  // and a new key in every vector clock of the project, on every start.
  it('keeps one id start after start when the local storage drops its writes', async () => {
    const id = `team-vault-identity-${++seq}`;
    const storage = localStorageOf();
    storage.full = true;
    const app = vault(id, dataJson(), 'vault-a', storage);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await start(app, id);
      ids.push(run.plugin.settings.clientId);
      expect(run.saved().clientIdClaimed).not.toBe(true);
      await run.stop();
      jest.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    }
    expect(ids).toEqual(['client-1', 'client-1', 'client-1']);
    expect(Notice.shown).toEqual([]);
  });

  it('on an Obsidian without a vault local storage, starts with data.json’s id as before', async () => {
    const id = `team-vault-identity-${++seq}`;
    const data = dataJson({ clientIdClaimed: true });
    const app = vault(id, data, 'vault-a', null);

    const run = await start(app, id);

    expect(run.plugin.settings.clientId).toBe('client-1');
    expect(run.engineClientId()).toBe('client-1');
    expect(app.files.get(`.obsidian/plugins/${id}/data.json`)).toBe(data);
    expect(Notice.shown).toEqual([]);
    await run.stop();
  });
});

describe('plugin lifecycle — atomic-write leftovers', () => {
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

describe('plugin lifecycle — a server moved to a new address', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Notice.shown = [];
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // On 2026-09-27 the team's server moved to a new address. The settings tab
  // could only remove the server — switching its binding off — and a binding
  // made again starts from scratch; users hand-edited data.json instead.
  it('moves the binding to the address edited in the settings tab, its queue kept', async () => {
    // Where each engine's socket connects; nothing goes out.
    const connected: string[] = [];
    jest.spyOn(SocketClient.prototype, 'connect').mockImplementation(function (this: SocketClient) {
      connected.push((this as unknown as { url: string }).url);
    });
    const tested: string[] = [];
    jest.spyOn(ApiClient.prototype, 'getMe').mockImplementation(async function (this: ApiClient) {
      tested.push((this as unknown as { baseUrl: string }).baseUrl);
      return { id: 'u1', email: 'me@example.com', name: null };
    });
    jest
      .spyOn(ApiClient.prototype, 'getProjects')
      .mockResolvedValue([
        { id: 'p1', slug: 'notes', name: 'Notes', description: null, iconEmoji: null },
      ]);
    const purgedLog = jest.spyOn(OperationLog.prototype, 'purgeBinding');
    const purgedDocs = jest.spyOn(DocManager.prototype, 'purgeBinding');

    const id = `team-vault-moved-${++seq}`;
    const dir = `.obsidian/plugins/${id}`;
    const server = {
      id: 's1',
      name: 'Work',
      url: 'https://old.example.com',
      apiKey: 'osk_1',
      addedAt: 1,
    };
    const binding = {
      id: 'binding-1',
      serverId: 's1',
      projectId: 'p1',
      projectName: 'Notes',
      localFolder: '/',
      enabled: true,
      lastSyncedAt: 1,
      lastVectorClock: {},
    };
    const data = JSON.stringify({
      settingsVersion: 2,
      servers: [server],
      bindings: [binding],
      clientId: 'client-1',
    });
    const state = JSON.stringify({
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
    const app = fakeApp({ seed: { [`${dir}/data.json`]: data, [`${dir}/state.json`]: state } });
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

    const manager = internals(plugin).engineManager as EngineManager;
    const before = manager.getEngine('binding-1');
    expect(before).toBeDefined();
    expect(connected).toEqual(['https://old.example.com']);

    // Settings → Team Vault → Servers → Edit: a new URL, the key left empty.
    Setting.all = [];
    new SyncSettingsTab(app, plugin).display();
    const edit = Setting.all
      .find((s) => s.name === 'Work')
      ?.settingButtons.find((b) => b.text === t('settings.servers.edit'));
    if (!edit) throw new Error('the settings tab has no Edit button on the server');
    const from = Setting.all.length;
    edit.click();
    const modal = Setting.all.slice(from);
    const button = (text: string): ButtonComponent => {
      const found = modal.flatMap((s) => s.settingButtons).find((b) => b.text === text);
      if (!found) throw new Error(`the server modal has no "${text}" button`);
      return found;
    };
    modal
      .find((s) => s.name === t('modal.addServer.url.label'))
      ?.settingInputs[0]?.change('https://teamvault.example.com/');
    button(t('modal.addServer.test')).click();
    await jest.advanceTimersByTimeAsync(100);
    button(t('modal.addServer.save')).click();
    await jest.advanceTimersByTimeAsync(100);

    expect(tested).toEqual(['https://teamvault.example.com']);
    const saved = JSON.parse(app.files.get(`${dir}/data.json`) ?? '{}') as Record<string, unknown>;
    expect(saved.servers).toEqual([{ ...server, url: 'https://teamvault.example.com' }]);
    expect(saved.bindings).toEqual([binding]);
    // A new engine on the new address, for the same binding.
    const after = manager.getEngine('binding-1');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(connected).toEqual(['https://old.example.com', 'https://teamvault.example.com']);
    // Its local state went with it: nothing purged, the edit still queued.
    expect(purgedLog).not.toHaveBeenCalled();
    expect(purgedDocs).not.toHaveBeenCalled();
    expect((internals(plugin).operationLog as OperationLog).pendingCount('binding-1')).toBe(1);

    plugin.onunload();
    await jest.advanceTimersByTimeAsync(100);
  });
});
