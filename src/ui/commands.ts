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
 * Commands (English names; the palette shows them as "Team Vault: …"):
 *   - "Sync now"                   — runDeepSync on every active engine.
 *   - "Pause sync"                 — manager.pause().
 *   - "Resume sync"                — manager.resume().
 *   - "Toggle active file history" — open / close the right-pane History view.
 *   - "Open settings"              — focus the plugin's settings tab.
 */

export interface CommandsDeps {
  manager: EngineManager;
  notices: NoticeService;
  /** Opens (or focuses) the right-pane History view. */
  openHistoryView: () => Promise<void> | void;
  /** Opens the Obsidian settings dialog at our plugin tab. */
  openSettings: () => void;
}

/**
 * Command ids are bare — Obsidian prefixes them with the plugin id itself,
 * so `sync-now` is exposed as `team-vault:sync-now`. Repeating the prefix
 * here (as 0.2.x did) produced `team-vault:team-vault-sync-now`, which the
 * submission requirements call out explicitly. Names likewise: Obsidian
 * shows them as "<plugin name>: <name>", so the catalogs carry the bare
 * name (up to 0.3.4 the palette read "Team Vault: Team Vault: sync now").
 * They are read once, here — a language switch reaches them on reload.
 */
export function registerCommands(plugin: Plugin, deps: CommandsDeps): void {
  plugin.addCommand({
    id: 'sync-now',
    name: t('command.syncNow'),
    callback: () => {
      void runSyncNow(deps);
    },
  });

  plugin.addCommand({
    id: 'pause',
    name: t('command.pause'),
    checkCallback: (checking) => {
      if (deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.pause();
      return true;
    },
  });

  plugin.addCommand({
    id: 'resume',
    name: t('command.resume'),
    checkCallback: (checking) => {
      if (!deps.manager.isPaused()) return false;
      if (!checking) void deps.manager.resume();
      return true;
    },
  });

  plugin.addCommand({
    id: 'history',
    name: t('command.history'),
    callback: () => {
      void deps.openHistoryView();
    },
  });

  plugin.addCommand({
    id: 'open-settings',
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
