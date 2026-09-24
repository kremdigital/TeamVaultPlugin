import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  defaultSettings,
  describeSkipped,
  parseSettings,
  settingsToSave,
  type PluginSettings,
  type SkippedSettings,
} from '@/settings/settings';
import { readSettingsFile, type SettingsFileRead } from '@/settings/settings-file';
import { bindingAddBlock, type BindingAddBlock } from '@/settings/folder-utils';
import { getLanguage, setLanguage, t } from '@/i18n';
import { readObsidianLanguage, resolveLanguage } from '@/i18n/language';
import { SyncSettingsTab } from '@/settings/tab';
import { OperationLog } from '@/sync/operation-log';
import { DocManager, type IdbRegistry, type PersistenceFactory } from '@/crdt/doc-manager';
import { EngineManager } from '@/sync/engine-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ObsidianWatcher, type VaultEvent } from '@/watcher/obsidian-events';
import { FsWatcher } from '@/watcher/fs-watcher';
import { isInBinding, isOrphanedAtomicTmp } from '@/watcher/path-utils';
import { Logger } from '@/utils/logger';
import { ConsoleLogSink } from '@/utils/console-log-sink';
import { CompositeLogSink } from '@/utils/composite-log-sink';
import { GatedLogSink } from '@/utils/gated-log-sink';
import { FileLogSink } from '@/utils/file-log-sink';
import { findDuplicatePluginFolders } from '@/integration/plugin-folders';
import {
  awaitPreviousTeardown,
  claimStateFile,
  handOffTeardown,
  teardownPlugin,
  TEARDOWN_HANDOFF_TIMEOUT_MS,
} from '@/integration/plugin-teardown';
import { ObsidianVaultAdapter } from '@/integration/obsidian-vault-adapter';
import { ObsidianLogStorage } from '@/integration/obsidian-log-storage';
import { ObsidianWatchableVault } from '@/integration/obsidian-watchable-vault';
import { UiConflictResolver } from '@/ui/modals/conflict-modal';
import { NoticeService } from '@/ui/notices';
import { UnsyncableNameReporter } from '@/ui/unsyncable-names';
import { StatusBar } from '@/ui/status-bar';
import { registerCommands } from '@/ui/commands';
import { HISTORY_VIEW_TYPE, HistoryView } from '@/ui/views/history-view';
import { uuid } from '@/utils/id';

/**
 * Team Vault — plugin entry point.
 *
 * The bulk of the work happens here at `onload()` time:
 *
 *   1. Load + repair settings, generate a stable `clientId` on first run.
 *   2. Build shared singletons: vault adapter, log storage, logger,
 *      operation log (JSON-backed), Yjs doc manager, recently-applied set,
 *      conflict resolver, notice service.
 *   3. Spin up two watchers (Obsidian events + filesystem) that fan
 *      events into the engine manager.
 *   4. Construct the engine manager, register the settings tab, status
 *      bar, history view, and command palette entries.
 *
 * `onunload()` detaches the watchers, the UI hooks and the sockets at once
 * and leaves the rest — flushing the operation log, closing the offline docs
 * — to finish in the background (see `integration/plugin-teardown`). The next
 * instance's `onload()` waits for that background part before it reads
 * `state.json`.
 */
export default class ObsidianSyncPlugin extends Plugin {
  settings: PluginSettings = defaultSettings();

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
  private unsyncableNames: UnsyncableNameReporter | null = null;
  private unsubscribeAggregate: (() => void) | null = null;
  /**
   * Set by `onunload`. A request an engine had in flight can settle after
   * the plugin is gone; its callbacks must not write `data.json`, which by
   * then may belong to the next instance of the plugin.
   */
  private unloaded = false;
  /**
   * Set by `loadSettings` when `data.json` exists but can't be read. The
   * defaults in `settings` then stand in for settings we don't know, so
   * nothing may be written or cleaned up on their strength.
   */
  private unreadableSettings: Extract<SettingsFileRead, { kind: 'unreadable' }> | null = null;
  /** Set by `loadSettings` when there was no `data.json`: a first run. */
  private firstRun = false;
  /**
   * Set by `loadSettings`: the servers and bindings of `data.json` it could
   * not use (see `parseSettings`). `settings` then does not name every
   * binding this vault has, so the orphan sweep is off, and every save puts
   * these back into the file.
   */
  private skippedSettings: SkippedSettings | null = null;

  override async onload(): Promise<void> {
    // Obsidian can unload the plugin while this is still running — it does
    // not wait for `onload` either. Hence the `unloaded` checks after every
    // await below: past one of them, whatever this goes on to build (the
    // engines, the settings tab, the view, the commands) would never be torn
    // down, and a second instance would register the same view type.
    await this.loadSettings();
    if (this.unloaded) return;
    this.applyLanguage();
    // Settings we could not read are not a first run: starting on the
    // defaults would save them over the file and sweep every binding's local
    // state as orphaned. Stop here until the user fixes or removes the file.
    if (this.unreadableSettings) {
      this.reportUnreadableSettings(this.unreadableSettings);
      return;
    }

    // Make sure we have a stable client id; persist once on first run.
    if (!this.settings.clientId) {
      this.settings.clientId = uuid();
      await this.saveSettings();
      if (this.unloaded) return;
    }

    this.bootstrapLogger();
    if (this.skippedSettings) this.reportSkippedSettings(this.skippedSettings);
    // Disabling and enabling the plugin, or an update, starts this instance
    // while the previous one may still be flushing `state.json`.
    if (!(await awaitPreviousTeardown(window, this.manifest.id, TEARDOWN_HANDOFF_TIMEOUT_MS))) {
      this.logger?.warn('previous instance is still shutting down; loading anyway', {
        waitedMs: TEARDOWN_HANDOFF_TIMEOUT_MS,
      });
    }
    if (this.unloaded) return;
    await this.bootstrapState();
    if (this.unloaded) return;
    // A duplicate plugin folder means the settings we just loaded may not be
    // the user's (see `integration/plugin-folders`). Everything below the
    // sweeps is read-mostly, but the sweeps themselves delete local state
    // keyed on those settings — so warn and skip them until the install is
    // untangled, rather than wiping a live binding's offline CRDT.
    //
    // A first run skips them too: it has no bindings of its own yet, so every
    // binding's local state would look orphaned — and a data.json that was
    // missing a moment ago may just be one a sync client is replacing. The
    // next start cleans up whatever is really left over.
    if (!(await this.warnOnDuplicatePluginFolders()) && !this.firstRun) {
      // A binding data.json has but the plugin could not read is not in
      // `settings`, yet it is no orphan: its unsent changes are still queued.
      // The tmp sweep stays — it only ever looks inside known bindings.
      if (!this.skippedSettings) await this.sweepOrphanedBindingState();
      await this.sweepOrphanedTmpArtifacts();
    }
    if (this.unloaded) return;
    this.bootstrapManager();
    // Watchers attach only after the workspace layout is ready: while the
    // vault index loads, Obsidian fires `vault.on('create')` for EVERY
    // existing file, and that startup flood raced the engines' file-index
    // refresh — each launch re-uploaded the whole vault as `file:create`,
    // and the server conflict-renamed every path whose content had
    // diverged (the 2026-06-12 burst: 120 junk `.conflict-*` copies in two
    // seconds). `onLayoutReady` marks the end of the initial scan; events
    // after it are genuine user/file activity. Changes made while the
    // plugin was off are reconciled by the connect-time catch-up, not by
    // the startup flood.
    this.app.workspace.onLayoutReady(() => this.bootstrapWatchers());
    this.bootstrapUi();

    // Kick off the manager — engines for active bindings start connecting.
    await this.engineManager?.start();

    this.logger?.info('plugin loaded');
  }

  override onunload(): void {
    this.logger?.info('plugin unloading');
    this.unloaded = true;
    // A notice about a name Windows can't keep that still waits for the
    // names reported with it is dropped; its `sync.log` line is written.
    this.unsyncableNames?.dispose();
    // Synchronous on purpose: Obsidian does not await onunload. Listeners,
    // watchers, the status bar and the sockets are gone when this returns;
    // the rest — the engines settling, the operation log flushing its
    // pending queue, the offline docs closing — finishes in the background
    // and logs its failures. The next instance's onload waits for it.
    const done = teardownPlugin({
      unsubscribes: [this.unsubscribeAggregate],
      obsidianWatcher: this.obsidianWatcher,
      fsWatcher: this.fsWatcher,
      statusBar: this.statusBar,
      engineManager: this.engineManager,
      docManager: this.docManager,
      operationLog: this.operationLog,
      logger: this.logger,
    });
    handOffTeardown(window, this.manifest.id, done);
  }

  /**
   * Read `data.json` ourselves rather than through `loadData()`, which
   * answers `undefined` both for a file it could not parse and for one it
   * could not open — see `settings/settings-file`.
   */
  async loadSettings(): Promise<void> {
    const path = this.settingsFilePath();
    const adapter = this.app.vault.adapter;
    const result = await readSettingsFile({
      // The desktop adapter's read is `fs.promises.readFile`: a missing file
      // rejects with `code: 'ENOENT'`, which is what tells a first run apart.
      read: () => adapter.read(path),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    });
    this.firstRun = result.kind === 'missing';
    if (result.kind === 'unreadable') {
      this.unreadableSettings = result;
      this.skippedSettings = null;
      this.settings = defaultSettings();
      return;
    }
    this.unreadableSettings = null;
    const parsed = parseSettings(result.kind === 'ok' ? result.data : null);
    this.settings = parsed.settings;
    this.skippedSettings = parsed.skipped;
  }

  private settingsFilePath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/data.json`;
  }

  /** Log why the plugin did not start, and say so where it can't be missed. */
  private reportUnreadableSettings(
    failure: Extract<SettingsFileRead, { kind: 'unreadable' }>,
  ): void {
    const path = this.settingsFilePath();
    this.bootstrapLogger();
    // The error as an argument of its own: the log prints an Error as
    // "SyntaxError: … at position 812" — where the stray comma is — while
    // inside the context object it would come out as `{}`.
    this.logger?.error(
      'settings file unreadable; plugin not started',
      { path, reason: failure.reason },
      failure.error,
    );
    // Sticky (timeout 0), like the duplicate-folder warning: nothing syncs
    // until the user acts.
    const key = failure.reason === 'corrupt' ? 'notice.settingsCorrupt' : 'notice.settingsLocked';
    new Notice(t(key, { path }), 0);
  }

  /**
   * Say which servers and bindings of `data.json` are skipped, and that the
   * orphan sweep is off until they are fixed. The log gets positions, ids and
   * the fields at fault — never an entry itself, which may hold an API key;
   * the notice, how many.
   *
   * At `error`, like the other settings-file reports: the notice and the
   * settings tab send the user to `sync.log` for the details, and at `warn`
   * the line never got there with Log level set to Errors only. Nor did
   * switching the level bring it back — it is written once, at start.
   */
  private reportSkippedSettings(skipped: SkippedSettings): void {
    const path = this.settingsFilePath();
    this.logger?.error(
      'settings entries unreadable; kept in the file, orphaned-state sweep skipped',
      {
        path,
        ...describeSkipped(skipped),
      },
    );
    const parts: string[] = [];
    const { bindings, servers } = skipped;
    if (bindings) {
      parts.push(
        bindings.kind === 'not-a-list'
          ? t('notice.settingsSkipped.bindingList')
          : t('notice.settingsSkipped.bindings', { count: bindings.entries.length }),
      );
    }
    if (servers) {
      parts.push(
        servers.kind === 'not-a-list'
          ? t('notice.settingsSkipped.serverList')
          : t('notice.settingsSkipped.servers', { count: servers.entries.length }),
      );
    }
    // Sticky, like the other settings-file notices: a skipped binding does
    // not sync, and nothing else in the UI says so.
    new Notice(t('notice.settingsSkipped', { path, what: parts.join(', ') }), 0);
  }

  /**
   * What keeps the settings tab from adding a binding, if anything: one the
   * vault has, or one `data.json` has that the plugin could not read
   * (`skippedSettings`) — see `bindingAddBlock`.
   */
  bindingAddBlock(): BindingAddBlock | null {
    return bindingAddBlock(this.settings.bindings, this.skippedSettings?.bindings ?? null);
  }

  async saveSettings(): Promise<void> {
    // Never over settings we could not read — see `unreadableSettings`.
    if (this.unloaded || this.unreadableSettings) return;
    await this.saveData(settingsToSave(this.settings, this.skippedSettings));
    this.applyLanguage();
    if (this.logger) this.logger.setLevel(this.settings.logLevel);
    // Settings changes can add / remove bindings; reconcile.
    await this.engineManager?.refreshFromSettings();
  }

  /**
   * Resolve the language setting (`auto` → Obsidian's own language) and, on
   * a change, re-render the status bar. The settings tab re-renders itself;
   * command names were read when they were registered and switch on the
   * next load, as the setting's description says.
   */
  private applyLanguage(): void {
    const language = resolveLanguage(this.settings.language, readObsidianLanguage);
    if (language === getLanguage()) return;
    setLanguage(language);
    this.statusBar?.render();
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
      filePath: `${this.app.vault.configDir}/plugins/${this.manifest.id}/sync.log`,
    });
    const sinks = new CompositeLogSink([
      this.fileLogSink,
      // The DevTools mirror follows the Log level setting entry by entry, so
      // picking Debug starts it (and leaving Debug stops it) with no reload.
      new GatedLogSink(new ConsoleLogSink(), () => this.settings.logLevel === 'debug'),
    ]);
    this.logger = new Logger(this.settings.logLevel, sinks, { plugin: this.manifest.id });
  }

  private async bootstrapState(): Promise<void> {
    // Vault-relative, and read through the same storage seam as `sync.log`:
    // the operation log used to be SQLite via `better-sqlite3`, a native
    // module that only resolves when someone hand-installs the plugin's
    // `node_modules/`. Directory installs ship three files and no
    // dependencies, so that build could never load there. See the header of
    // `sync/operation-log.ts`.
    this.operationLog = new OperationLog({
      storage: new ObsidianLogStorage(this.app.vault),
      filePath: `${this.app.vault.configDir}/plugins/${this.manifest.id}/state.json`,
      onError: (err) => this.logger?.warn('operation log persistence failed', { err }),
      // From here on the previous instance, if any, stops writing the file.
      ownsFile: claimStateFile(window, this.manifest.id),
    });
    await this.operationLog.load();

    const persistenceFactory: PersistenceFactory = (name, doc) =>
      new IndexeddbPersistence(name, doc);
    this.docManager = new DocManager({ persistenceFactory, idb: browserIdbRegistry() });
    this.recentlyApplied = new RecentlyApplied();
  }

  /**
   * Warn — loudly and stickily — when another folder under
   * `.obsidian/plugins/` declares our `manifest.id`. Obsidian loads only one
   * of them and the choice isn't the user's: the copy that wins supplies
   * `data.json` (possibly empty, so nothing syncs and the status bar reads
   * «no active vaults») while `state.db` / `sync.log` still resolve to the
   * canonical `{manifest.id}` folder. The whole failure is invisible from
   * inside the plugin — hence the notice naming the folder to remove.
   *
   * Returns `true` when a duplicate was found, which also gates the startup
   * sweeps: with someone else's settings in hand they'd delete live state.
   */
  private async warnOnDuplicatePluginFolders(): Promise<boolean> {
    let duplicates: string[];
    try {
      duplicates = await findDuplicatePluginFolders(this.app.vault.adapter, {
        configDir: this.app.vault.configDir,
        pluginId: this.manifest.id,
        ...(this.manifest.dir !== undefined ? { ownDir: this.manifest.dir } : {}),
      });
    } catch (err) {
      this.logger?.warn('failed to scan for duplicate plugin folders', { err });
      return false;
    }
    if (duplicates.length === 0) return false;

    const loaded = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.logger?.error('duplicate plugin folders share this plugin id', {
      pluginId: this.manifest.id,
      loaded,
      version: this.manifest.version,
      duplicates,
    });
    // Sticky (timeout 0): sync is effectively down until the user acts, and a
    // notice that fades in five seconds is exactly what got missed before.
    new Notice(t('notice.duplicatePluginFolder', { loaded, duplicates: duplicates.join(', ') }), 0);
    return true;
  }

  /**
   * One-time-per-launch reconciliation: drop local state for bindings that
   * no longer exist in settings. Earlier plugin versions never cleaned up
   * when a binding was deleted, so `state.db` accumulated dead pending
   * operations (for engines that no longer exist and can never drain them)
   * plus orphaned file_meta / bindings_state rows, and the offline `Y.Doc`
   * stores (y-indexeddb databases) leaked likewise. From now on the
   * `EngineManager` purges both at delete time; this sweep mops up the backlog
   * and anything a crash left behind. A merely-disabled binding is still in
   * settings, so its state is preserved. `onload` doesn't run this while
   * `data.json` holds entries it could not read (`skippedSettings`): a binding
   * among them would look orphaned here.
   */
  private async sweepOrphanedBindingState(): Promise<void> {
    if (!this.operationLog) return;
    const known = new Set(this.settings.bindings.map((b) => b.id));
    for (const bindingId of this.operationLog.listBindingIds()) {
      if (known.has(bindingId)) continue;
      // Capture tracked file paths BEFORE wiping the log: purgeBinding clears
      // file_meta, which the doc-manager purge uses as a fallback to locate
      // y-indexeddb databases on runtimes that can't enumerate them.
      const paths = this.operationLog.listFileMeta(bindingId).map((m) => m.relativePath);
      const removed = this.operationLog.purgeBinding(bindingId);
      this.logger?.info('swept orphaned binding state from local log', { bindingId, ...removed });
      try {
        const databases = (await this.docManager?.purgeBinding(bindingId, paths)) ?? [];
        if (databases.length > 0) {
          this.logger?.info('swept orphaned offline CRDT state', {
            bindingId,
            databases: databases.length,
          });
        }
      } catch (err) {
        this.logger?.warn('failed to sweep orphaned offline CRDT state', { bindingId, err });
      }
    }

    // Deliberately NO "delete every team-vault database this vault doesn't
    // recognise" backstop. Obsidian keeps IndexedDB in ONE store shared by
    // every vault on the machine, and database names are keyed by binding id,
    // not by vault — so from inside one vault, another vault's live binding
    // is indistinguishable from an orphan. 0.2.12–0.3.0 shipped exactly that
    // sweep, and on 2026-09-16 a freshly created test vault deleted 207 of a
    // large production vault's offline CRDT databases at startup. Only ids
    // this vault's own operation log names (the loop above) are safe to purge.
  }

  /**
   * Delete orphaned Obsidian atomic-write artifacts (`<name>.tmp.<pid>.<hex>`)
   * inside binding folders. Obsidian writes files atomically — temp file,
   * then rename — and a crash or a locked target leaves the temp behind.
   * Earlier versions even uploaded the orphans (the watcher's `.tmp` suffix
   * filter didn't match the pattern). Artifacts whose embedded pid belongs
   * to the current process are skipped: their write may still be in flight.
   * Best-effort — a failed delete is logged and retried next launch.
   */
  private async sweepOrphanedTmpArtifacts(): Promise<void> {
    const pid = typeof process !== 'undefined' ? process.pid : undefined;
    if (pid === undefined) return;
    for (const file of this.app.vault.getFiles()) {
      if (!isOrphanedAtomicTmp(file.path, pid)) continue;
      if (!this.settings.bindings.some((b) => isInBinding(file.path, b.localFolder))) continue;
      try {
        await this.app.vault.adapter.remove(file.path);
        this.logger?.info('removed orphaned tmp artifact', { path: file.path });
      } catch (err) {
        this.logger?.warn('failed to remove orphaned tmp artifact', { path: file.path, err });
      }
    }
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
      configDir: this.app.vault.configDir,
      logger: this.logger ?? undefined,
      onBindingSynced: (bindingId, at) => {
        const binding = this.settings.bindings.find((b) => b.id === bindingId);
        if (!binding) return;
        binding.lastSyncedAt = at;
        void this.saveSettings();
      },
    });
  }

  private bootstrapWatchers(): void {
    // `onLayoutReady` can fire after an unload that came first: nothing
    // would ever stop watchers attached then.
    if (this.unloaded || !this.engineManager || !this.recentlyApplied) return;

    // A note named so that Windows can't keep it (`Why?.md`) is never synced;
    // the user is told, once per name while the plugin runs.
    const unsyncableNames = new UnsyncableNameReporter({
      log: (message, context) => {
        if (!this.logger?.isEnabled('warn')) return false;
        this.logger.warn(message, context);
        return true;
      },
    });
    this.unsyncableNames = unsyncableNames;
    this.obsidianWatcher = new ObsidianWatcher({
      bindings: () => this.settings.bindings,
      recentlyApplied: this.recentlyApplied,
      modifyDebounceMs: this.settings.debounceMs,
      configDir: this.app.vault.configDir,
      onUnsyncableName: (event) => unsyncableNames.report(event),
    });
    const watchableVault = new ObsidianWatchableVault(this.app.vault);
    this.obsidianWatcher.start(watchableVault);

    const basePath =
      (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? '';
    this.fsWatcher = new FsWatcher({
      vaultBasePath: basePath,
      bindings: () => this.settings.bindings,
      recentlyApplied: this.recentlyApplied,
      configDir: this.app.vault.configDir,
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
    this.unsubscribeAggregate = this.engineManager.onAggregateStatus((status) => {
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
    // A Promise since 1.7.2 (deferred views) — the manifest's minAppVersion.
    await this.app.workspace.revealLeaf(leaf);
  }
}

/**
 * Adapt the renderer's IndexedDB to the {@link IdbRegistry} seam the
 * {@link DocManager} uses to purge a removed binding's offline stores. This
 * lives in `main.ts` (the browser entry point) rather than the env-agnostic
 * `doc-manager.ts` because it touches browser globals. `databases()` exists in
 * Obsidian's Chromium renderer; we still guard it. Deletes are best-effort:
 * a blocked or failed request resolves (never rejects) so one stuck database
 * can't break roster reconciliation — the startup sweep retries.
 */
function browserIdbRegistry(): IdbRegistry {
  const idb = typeof window !== 'undefined' ? window.indexedDB : undefined;
  return {
    list: async () => {
      if (!idb?.databases) return [];
      const infos = await idb.databases();
      const names: string[] = [];
      for (const info of infos) if (info.name) names.push(info.name);
      return names;
    },
    delete: (name) =>
      new Promise<void>((resolve) => {
        if (!idb) {
          resolve();
          return;
        }
        try {
          const request = idb.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          // A still-open connection blocks deletion; ours are closed first, so
          // this only fires for a foreign holder — resolve rather than hang.
          request.onblocked = () => resolve();
        } catch {
          resolve();
        }
      }),
  };
}
