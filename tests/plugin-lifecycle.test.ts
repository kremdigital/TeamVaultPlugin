import type { App, PluginManifest } from 'obsidian';
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

type FakeApp = App & { layoutReady: jest.Mock; listed: jest.Mock };

/** An in-memory vault with just the adapter calls `onload` reaches. */
function fakeApp(opts: { stateGate?: Promise<void>; listGate?: Promise<void> } = {}): FakeApp {
  const files = new Map<string, string>();
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
      const text = files.get(p);
      if (text === undefined) throw new Error(`ENOENT ${p}`);
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
  };
  return app as unknown as FakeApp;
}

/** The plugin's private parts the tests look at. */
function internals(plugin: TeamVaultPlugin): { operationLog: unknown; engineManager: unknown } {
  return plugin as unknown as { operationLog: unknown; engineManager: unknown };
}

let seq = 0;

/** A plugin with its registration calls spied on, under an id of its own. */
function makePlugin(app: App): {
  plugin: TeamVaultPlugin;
  registered: jest.Mock;
  id: string;
} {
  // A fresh id per test: the teardown handoff and the state-file claim live
  // on `window`, keyed by the plugin id.
  const id = `team-vault-lifecycle-${++seq}`;
  const manifest = { id, dir: `.obsidian/plugins/${id}` } as PluginManifest;
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
