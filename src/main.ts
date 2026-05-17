import { Plugin, WorkspaceLeaf } from 'obsidian';
import { IndexeddbPersistence } from 'y-indexeddb';
import { DEFAULT_SETTINGS, mergeWithDefaults, type PluginSettings } from '@/settings/settings';
import { setLanguage } from '@/i18n';
import { SyncSettingsTab } from '@/settings/tab';
import { OperationLog } from '@/sync/operation-log';
import { DocManager, type PersistenceFactory } from '@/crdt/doc-manager';
import { EngineManager } from '@/sync/engine-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ObsidianWatcher, type VaultEvent } from '@/watcher/obsidian-events';
import { FsWatcher } from '@/watcher/fs-watcher';
import { Logger, type LogLevel } from '@/utils/logger';
import { ConsoleLogSink } from '@/utils/console-log-sink';
import { CompositeLogSink } from '@/utils/composite-log-sink';
import { FileLogSink } from '@/utils/file-log-sink';
import { ObsidianVaultAdapter } from '@/integration/obsidian-vault-adapter';
import { ObsidianLogStorage } from '@/integration/obsidian-log-storage';
import { ObsidianWatchableVault } from '@/integration/obsidian-watchable-vault';
import { UiConflictResolver } from '@/ui/modals/conflict-modal';
import { NoticeService } from '@/ui/notices';
import { StatusBar } from '@/ui/status-bar';
import { registerCommands } from '@/ui/commands';
import { HISTORY_VIEW_TYPE, HistoryView } from '@/ui/views/history-view';
import { uuid } from '@/utils/id';
import { setPluginDir } from '@/utils/native-loader';

/**
 * Obsidian Team — plugin entry point.
 *
 * The bulk of the work happens here at `onload()` time:
 *
 *   1. Load + repair settings, generate a stable `clientId` on first run.
 *   2. Build shared singletons: vault adapter, log storage, logger,
 *      operation log (SQLite), Yjs doc manager, recently-applied set,
 *      conflict resolver, notice service.
 *   3. Spin up two watchers (Obsidian events + filesystem) that fan
 *      events into the engine manager.
 *   4. Construct the engine manager, register the settings tab, status
 *      bar, history view, and command palette entries.
 *
 * `onunload()` tears everything down in reverse order — disconnects
 * sockets, closes the SQLite handle, kills chokidar, removes UI hooks.
 */
export default class ObsidianSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  private logger: Logger | null = null;
  private fileLogSink: FileLogSink | null = null;
  private operationLog: OperationLog | null = null;
  private docManager: DocManager | null = null;
  private recentlyApplied: RecentlyApplied | null = null;
  private engineManager: EngineManager | null = null;
  private obsidianWatcher: ObsidianWatcher | null = null;
  private fsWatcher: FsWatcher | null = null;
  private statusBar: StatusBar | null = null;
  private notices: NoticeService | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    setLanguage(this.settings.language);

    // Make sure we have a stable client id; persist once on first run.
    if (!this.settings.clientId) {
      this.settings.clientId = uuid();
      await this.saveSettings();
    }

    this.bootstrapLogger();
    this.bootstrapState();
    this.bootstrapManager();
    this.bootstrapWatchers();
    this.bootstrapUi();

    // Kick off the manager — engines for active bindings start connecting.
    await this.engineManager?.start();

    this.logger?.info('plugin loaded');
  }

  override async onunload(): Promise<void> {
    this.logger?.info('plugin unloading');
    await this.engineManager?.stop().catch(() => undefined);
    this.statusBar?.destroy();
    await this.fsWatcher?.stop().catch(() => undefined);
    this.obsidianWatcher?.stop();
    await this.docManager?.destroy().catch(() => undefined);
    this.operationLog?.close();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as unknown;
    this.settings = mergeWithDefaults(raw);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    setLanguage(this.settings.language);
    if (this.logger) this.logger.setLevel(this.settings.logLevel as LogLevel);
    // Settings changes can add / remove bindings; reconcile.
    await this.engineManager?.refreshFromSettings();
  }

  /** Exposed for the settings UI ("Open log" / "Clear log" buttons). */
  async readLogFile(): Promise<string> {
    return this.fileLogSink?.readLog() ?? '';
  }

  async clearLogFile(): Promise<void> {
    await this.fileLogSink?.clear();
  }

  // -- Bootstrap helpers --------------------------------------------------

  private bootstrapLogger(): void {
    const storage = new ObsidianLogStorage(this.app.vault);
    this.fileLogSink = new FileLogSink({
      storage,
      filePath: `.obsidian/plugins/${this.manifest.id}/sync.log`,
    });
    const sinks =
      this.settings.logLevel === 'debug'
        ? new CompositeLogSink([this.fileLogSink, new ConsoleLogSink()])
        : this.fileLogSink;
    this.logger = new Logger(this.settings.logLevel, sinks, { plugin: this.manifest.id });
  }

  private bootstrapState(): void {
    const dataDir = `.obsidian/plugins/${this.manifest.id}`;
    // The OperationLog needs an OS-absolute path because better-sqlite3
    // talks to the filesystem directly. `FileSystemAdapter.getBasePath()`
    // exposes it (desktop-only — the manifest enforces that).
    const basePath =
      (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? '';
    // Register the absolute plugin folder with the native-loader so
    // `loadNative('better-sqlite3')` can resolve under Obsidian's
    // bundle-runtime require (which doesn't traverse the plugin's
    // local node_modules through the bundled string specifier).
    setPluginDir(`${basePath}/${dataDir}`);
    this.operationLog = new OperationLog({
      filePath: `${basePath}/${dataDir}/state.db`,
    });

    const persistenceFactory: PersistenceFactory = (name, doc) =>
      new IndexeddbPersistence(name, doc);
    this.docManager = new DocManager({ persistenceFactory });
    this.recentlyApplied = new RecentlyApplied();
  }

  private bootstrapManager(): void {
    if (!this.operationLog || !this.docManager || !this.recentlyApplied) return;
    const vault = new ObsidianVaultAdapter(this.app.vault);
    const conflictResolver = new UiConflictResolver(this.app);
    this.engineManager = new EngineManager({
      getSettings: () => ({ servers: this.settings.servers, bindings: this.settings.bindings }),
      vault,
      operationLog: this.operationLog,
      docManager: this.docManager,
      recentlyApplied: this.recentlyApplied,
      clientId: this.settings.clientId,
      conflictResolver,
    });
  }

  private bootstrapWatchers(): void {
    if (!this.engineManager || !this.recentlyApplied) return;

    this.obsidianWatcher = new ObsidianWatcher({
      bindings: () => this.settings.bindings,
      recentlyApplied: this.recentlyApplied,
      modifyDebounceMs: this.settings.debounceMs,
    });
    const watchableVault = new ObsidianWatchableVault(this.app.vault);
    this.obsidianWatcher.start(watchableVault);

    const basePath =
      (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? '';
    this.fsWatcher = new FsWatcher({
      vaultBasePath: basePath,
      bindings: () => this.settings.bindings,
      recentlyApplied: this.recentlyApplied,
    });
    this.fsWatcher.start();

    const dispatcher = (event: VaultEvent): void => {
      // Tell the FS watcher about Obsidian-originated events so it can
      // skip the duplicate that chokidar will see in 50–100ms.
      if (event.source === 'obsidian' && event.type !== 'rename') {
        this.fsWatcher?.notifyObsidianEvent(event.type, event.path);
      }
      void this.engineManager?.dispatchVaultEvent(event);
    };
    this.obsidianWatcher.onEvent(dispatcher);
    this.fsWatcher.onEvent(dispatcher);
  }

  private bootstrapUi(): void {
    if (!this.engineManager) return;

    this.notices = new NoticeService({
      isEnabled: () => this.settings.showSyncNotifications,
    });

    this.addSettingTab(new SyncSettingsTab(this.app, this));

    this.registerView(
      HISTORY_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new HistoryView(leaf, () => this.resolveActiveFile()),
    );

    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(this.app, statusBarEl, this.engineManager, {
      syncNow: () => void this.engineManager?.runDeepSyncOnAll(),
      pause: () => void this.engineManager?.pause(),
      resume: () => void this.engineManager?.resume(),
      openSettings: () => this.openSettingsTab(),
      openHistory: () => void this.openHistoryView(),
    });

    registerCommands(this, {
      manager: this.engineManager,
      notices: this.notices,
      openHistoryView: () => void this.openHistoryView(),
      openSettings: () => this.openSettingsTab(),
    });

    // Wire socket events to the notice service. Notices fire on
    // *transitions*, not on every status emit — otherwise a chatty
    // sync would spam the user. We track the last announced state and
    // only react when it changes.
    let lastAnnounced: string | null = null;
    this.engineManager.onAggregateStatus((status) => {
      if (status.state === lastAnnounced) return;
      const previous = lastAnnounced;
      lastAnnounced = status.state;
      if (status.state === 'connected' && previous !== 'connecting' && previous !== null) {
        // Reconnected from offline / error — let the user know.
        this.notices?.syncCompleted();
      }
      if (status.state === 'offline' && previous && previous !== 'paused') {
        this.notices?.disconnected('—');
      }
      if (status.state === 'error' && status.detail) {
        this.notices?.error(status.detail);
      }
    });
  }

  private resolveActiveFile(): {
    server: import('@/settings/settings').ServerConfig;
    projectId: string;
    fileId: string;
  } | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const path = file.path;
    for (const binding of this.settings.bindings) {
      if (!binding.enabled) continue;
      const matches =
        binding.localFolder === '/' ||
        path === binding.localFolder ||
        path.startsWith(`${binding.localFolder}/`);
      if (!matches) continue;
      const server = this.settings.servers.find((s) => s.id === binding.serverId);
      if (!server) continue;
      const engine = this.engineManager?.getEngine(binding.id);
      if (!engine) continue;
      const fileId = engine.getFileIdForPath(path);
      if (!fileId) continue;
      return { server, projectId: binding.projectId, fileId };
    }
    return null;
  }

  private openSettingsTab(): void {
    const setting = (
      this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }
    ).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /**
   * Toggle the right-pane History view — open + reveal if not yet
   * mounted, detach if already there. Obsidian's sidebar tabs don't get
   * an inline close X, and asking users to right-click → Close on the
   * tab icon is poor discoverability for a feature surfaced primarily
   * through the command palette and status bar.
   */
  private async openHistoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
    if (existing) {
      existing.detach();
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
