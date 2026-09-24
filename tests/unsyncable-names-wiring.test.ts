import type { App, PluginManifest } from 'obsidian';
import { Notice } from './__mocks__/obsidian';
import TeamVaultPlugin from '@/main';
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

it('shows a notice and logs it when a note is renamed to a name Windows cannot keep', () => {
  setLanguage('en');
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
  const dispatched = jest.fn();
  Object.assign(plugin, {
    engineManager: { dispatchVaultEvent: dispatched },
    recentlyApplied: new RecentlyApplied(),
    logger: new Logger('info', { write: (entry: LogEntry) => void logged.push(entry) }),
  });
  Notice.shown = [];

  (plugin as unknown as { bootstrapWatchers: () => void }).bootstrapWatchers();
  listeners.get('rename')?.({ path: 'Why?.md' }, 'Idea.md');

  expect(dispatched).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'delete', path: 'Idea.md' }),
  );
  expect(Notice.shown).toHaveLength(1);
  expect(Notice.shown[0]?.message).toContain('"Why?.md"');
  expect(logged.map((e) => [e.level, e.message, e.args[0]])).toEqual([
    [
      'warn',
      'not synced: Windows cannot keep this name',
      expect.objectContaining({ path: 'Why?.md', renamedFrom: 'Idea.md' }),
    ],
  ]);
});
