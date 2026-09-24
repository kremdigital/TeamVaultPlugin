import type { App, PluginManifest } from 'obsidian';
import { Notice } from './__mocks__/obsidian';
import TeamVaultPlugin from '@/main';
import { UNSYNCABLE_NAME_LOG } from '@/ui/unsyncable-names';
import { setLanguage } from '@/i18n';
import { Logger, type LogEntry } from '@/utils/logger';
import { RecentlyApplied } from '@/watcher/recently-applied';

/**
 * `main.ts` hands the Obsidian watcher a reporter for notes it drops because
 * Windows can't keep their names (see `unsyncable-names.test.ts`): renaming a
 * note to `Why?.md` shows a notice and writes a `warn` line to `sync.log`.
 */

// The file watcher starts next to the Obsidian one; the real chokidar can't
// load under jest.
jest.mock('chokidar', () => ({
  watch: () => ({
    on(): unknown {
      return this;
    },
    close: (): Promise<void> => Promise.resolve(),
  }),
}));

afterEach(() => jest.useRealTimers());

function wire(): {
  plugin: TeamVaultPlugin;
  fire: (name: string, ...args: unknown[]) => void;
  logger: Logger;
  logged: LogEntry[];
  dispatched: jest.Mock;
} {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {},
      on: (name: string, cb: (...args: unknown[]) => void): unknown => {
        listeners.set(name, cb);
        return { name };
      },
      offref: (): void => undefined,
    },
    workspace: { onLayoutReady: jest.fn() },
  } as unknown as App;
  const plugin = new TeamVaultPlugin(app, {
    id: 'team-vault-wiring',
    dir: '.obsidian/plugins/team-vault-wiring',
  } as PluginManifest);
  plugin.settings.bindings = [
    {
      id: 'b1',
      serverId: 's',
      projectId: 'p',
      projectName: 'P',
      localFolder: '/',
      enabled: true,
      lastSyncedAt: 0,
      lastVectorClock: {},
    },
  ];
  const logged: LogEntry[] = [];
  const logger = new Logger('info', { write: (entry: LogEntry) => void logged.push(entry) });
  const dispatched = jest.fn();
  Object.assign(plugin, {
    engineManager: { dispatchVaultEvent: dispatched, stop: () => Promise.resolve() },
    recentlyApplied: new RecentlyApplied(),
    logger,
  });
  Notice.shown = [];
  (plugin as unknown as { bootstrapWatchers: () => void }).bootstrapWatchers();
  return {
    plugin,
    fire: (name, ...args) => listeners.get(name)?.(...args),
    logger,
    logged,
    dispatched,
  };
}

it('shows a notice and logs it when a note is renamed to a name Windows cannot keep', () => {
  jest.useFakeTimers();
  setLanguage('en');
  const { fire, logged, dispatched } = wire();

  fire('rename', { path: 'Why?.md' }, 'Idea.md');
  // Names reported together share one notice, shown after a short pause.
  jest.runOnlyPendingTimers();

  expect(dispatched).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'delete', path: 'Idea.md' }),
  );
  expect(Notice.shown).toHaveLength(1);
  expect(Notice.shown[0]?.message).toContain('"Why?.md"');
  expect(logged.map((e) => [e.level, e.message, e.args[0]])).toEqual([
    [
      'warn',
      UNSYNCABLE_NAME_LOG,
      expect.objectContaining({ path: 'Why?.md', renamedFrom: 'Idea.md' }),
    ],
  ]);
});

it('drops a notice still waiting when the plugin unloads, keeping its log line', () => {
  jest.useFakeTimers();
  const { plugin, fire, logged } = wire();

  fire('rename', { path: 'Why?.md' }, 'Idea.md');
  plugin.onunload();
  jest.runOnlyPendingTimers();

  expect(Notice.shown).toEqual([]);
  expect(logged.map((e) => e.message)).toContain(UNSYNCABLE_NAME_LOG);
});

it('logs a name the Errors only level kept out of sync.log once the level lets it through', () => {
  jest.useFakeTimers();
  const { fire, logger, logged } = wire();

  logger.setLevel('error');
  fire('modify', { path: 'Why?.md' });
  jest.runOnlyPendingTimers();
  expect(logged).toEqual([]);

  logger.setLevel('info');
  fire('modify', { path: 'Why?.md' });
  jest.runOnlyPendingTimers();

  expect(logged.map((e) => [e.level, e.message, e.args[0]])).toEqual([
    ['warn', UNSYNCABLE_NAME_LOG, expect.objectContaining({ path: 'Why?.md' })],
  ]);
  // The notice itself came once, with the first report.
  expect(Notice.shown).toHaveLength(1);
});
