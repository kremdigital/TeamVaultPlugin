import type { Plugin } from 'obsidian';
import { registerCommands } from '@/ui/commands';
import type { EngineManager } from '@/sync/engine-manager';
import type { NoticeService } from '@/ui/notices';

/**
 * The command palette entries. "Sync now" ran while sync was paused: it
 * reached the server for a diff and said "Sync completed", with nothing
 * synced. It is offered only while sync runs, as in the status bar menu.
 */

interface Command {
  id: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean | void;
}

function setup(paused: boolean): {
  commands: Map<string, Command>;
  deepSync: jest.Mock;
  completed: jest.Mock;
  state: { paused: boolean };
} {
  const commands = new Map<string, Command>();
  const plugin = {
    addCommand: (command: Command) => {
      commands.set(command.id, command);
      return command;
    },
  } as unknown as Plugin;
  const state = { paused };
  const deepSync = jest.fn(() => Promise.resolve([]));
  const completed = jest.fn();
  const manager = {
    isPaused: () => state.paused,
    pause: () => {
      state.paused = true;
      return Promise.resolve();
    },
    resume: () => {
      state.paused = false;
      return Promise.resolve();
    },
    runDeepSyncOnAll: deepSync,
  } as unknown as EngineManager;
  const notices = { syncCompleted: completed, error: jest.fn() } as unknown as NoticeService;
  registerCommands(plugin, {
    manager,
    notices,
    openHistoryView: () => undefined,
    openSettings: () => undefined,
  });
  return { commands, deepSync, completed, state };
}

/** Run a command as Obsidian does: a check callback with `checking: false`, straight away. */
function run(command: Command | undefined): void {
  if (command?.checkCallback) command.checkCallback(false);
  else command?.callback?.();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('commands — Sync now', () => {
  it('is offered and runs while sync runs', async () => {
    const { commands, deepSync, completed } = setup(false);
    const syncNow = commands.get('sync-now');
    expect(syncNow?.checkCallback?.(true)).toBe(true);
    run(syncNow);
    await settle();
    expect(deepSync).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('is not offered while paused, and does nothing when run anyway (a hotkey)', async () => {
    const { commands, deepSync, completed, state } = setup(true);
    const syncNow = commands.get('sync-now');
    expect(syncNow?.checkCallback?.(true)).toBe(false);
    run(syncNow);
    await settle();
    expect(deepSync).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();

    run(commands.get('resume'));
    expect(state.paused).toBe(false);
    expect(syncNow?.checkCallback?.(true)).toBe(true);
  });

  it('offers Pause only while sync runs and Resume only while paused', () => {
    const { commands, state } = setup(false);
    expect(commands.get('pause')?.checkCallback?.(true)).toBe(true);
    expect(commands.get('resume')?.checkCallback?.(true)).toBe(false);
    run(commands.get('pause'));
    expect(state.paused).toBe(true);
    expect(commands.get('pause')?.checkCallback?.(true)).toBe(false);
    expect(commands.get('resume')?.checkCallback?.(true)).toBe(true);
  });
});
