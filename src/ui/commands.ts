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
 *   - "Team Vault: Sync now"     — runDeepSync on every active engine.
 *   - "Team Vault: Pause"        — manager.pause().
 *   - "Team Vault: Resume"       — manager.resume().
 *   - "Team Vault: Show history" — open the right-pane History view.
 *   - "Team Vault: Settings"     — focus the plugin's settings tab.
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
    id: 'team-vault-sync-now',
    name: t('command.syncNow'),
    callback: () => {
      void runSyncNow(deps);
    },
  });

  plugin.addCommand({
    id: 'team-vault-pause',
    name: t('command.pause'),
    checkCallback: (checking) => {
      if (deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.pause();
      return true;
    },
  });

  plugin.addCommand({
    id: 'team-vault-resume',
    name: t('command.resume'),
    checkCallback: (checking) => {
      if (!deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.resume();
      return true;
    },
  });

  plugin.addCommand({
    id: 'team-vault-history',
    name: t('command.history'),
    callback: () => {
      void deps.openHistoryView();
    },
  });

  plugin.addCommand({
    id: 'team-vault-open-settings',
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
