import type { Plugin } from 'obsidian';
import { t } from '@/i18n';
import type { EngineManager } from '@/sync/engine-manager';
import type { NoticeService } from './notices';
import { HISTORY_VIEW_TYPE } from './views/history-view';

/**
 * Wires plugin commands into the Obsidian command palette. Plain
 * function so `main.ts` (Stage 13) calls `registerCommands(plugin, ...)`
 * once during `onload`.
 *
 * Commands:
 *   - "Obsidian Team: Sync now"     — runDeepSync on every active engine.
 *   - "Obsidian Team: Pause"        — manager.pause().
 *   - "Obsidian Team: Resume"       — manager.resume().
 *   - "Obsidian Team: Show history" — open the right-pane History view.
 *   - "Obsidian Team: Settings"     — focus the plugin's settings tab.
 */

export interface CommandsDeps {
  manager: EngineManager;
  notices: NoticeService;
  /** Opens (or focuses) the right-pane History view. */
  openHistoryView: () => Promise<void> | void;
  /** Opens the Obsidian settings dialog at our plugin tab. */
  openSettings: () => void;
}

export function registerCommands(plugin: Plugin, deps: CommandsDeps): void {
  plugin.addCommand({
    id: 'obsidian-sync-sync-now',
    name: t('command.syncNow'),
    callback: () => {
      void runSyncNow(deps);
    },
  });

  plugin.addCommand({
    id: 'obsidian-sync-pause',
    name: t('command.pause'),
    checkCallback: (checking) => {
      if (deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.pause();
      return true;
    },
  });

  plugin.addCommand({
    id: 'obsidian-sync-resume',
    name: t('command.resume'),
    checkCallback: (checking) => {
      if (!deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.resume();
      return true;
    },
  });

  plugin.addCommand({
    id: 'obsidian-sync-history',
    name: t('command.history'),
    callback: () => {
      void deps.openHistoryView();
    },
  });

  plugin.addCommand({
    id: 'obsidian-sync-open-settings',
    name: t('command.settings'),
    callback: () => deps.openSettings(),
  });
}

async function runSyncNow(deps: CommandsDeps): Promise<void> {
  try {
    await deps.manager.runDeepSyncOnAll();
    deps.notices.syncCompleted();
  } catch (err) {
    deps.notices.error(err instanceof Error ? err.message : 'unknown');
  }
}

// Re-export for symmetry with the History view's `HISTORY_VIEW_TYPE`.
export { HISTORY_VIEW_TYPE };
