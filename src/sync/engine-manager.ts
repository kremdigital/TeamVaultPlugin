import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { ApiClient } from '@/client/api';
import type { SocketClient } from '@/client/socket';
import { DocManager } from '@/crdt/doc-manager';
import { OperationLog } from './operation-log';
import { SyncEngine, type EngineStatus, type SyncEngineDeps } from './engine';
import type { VaultAdapter } from './vault-adapter';
import type { RecentlyApplied } from '@/watcher/recently-applied';
import type { ConflictResolver } from './conflict';
import type { VaultEvent } from '@/watcher/obsidian-events';
import type { Logger } from '@/utils/logger';

/**
 * Top-level coordinator that owns one `SyncEngine` per active binding,
 * plus the shared resources they all depend on (`OperationLog`,
 * `DocManager`, `RecentlyApplied`).
 *
 * The plugin's `main.ts` (Stage 13) creates one of these on `onload`
 * and feeds it: settings updates, vault events from the watchers, and
 * lifecycle commands from the UI (`pause` / `resume` / `syncNow`).
 *
 * The aggregate status reduces every per-engine status into a single
 * value the status bar can render — see {@link AggregateStatus}.
 */

export type AggregateState =
  | 'idle' // no active bindings
  | 'paused'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'offline'
  | 'error';

export interface AggregateStatus {
  state: AggregateState;
  /** Optional human-readable detail (the latest reason / error). */
  detail?: string;
  /** Per-binding states, indexed by binding id. */
  bindings: Record<string, EngineStatus>;
}

export type AggregateListener = (status: AggregateStatus) => void;

/** What an engine connects with: fixed in it for its whole life. */
type ServerConnection = Pick<ServerConfig, 'url' | 'apiKey'>;

export interface EngineManagerDeps {
  /** Live settings — re-read on every refresh; lets the UI tweak debounce
   *  / log level / etc. without a restart. */
  getSettings: () => { servers: ServerConfig[]; bindings: VaultBinding[] };
  vault: VaultAdapter;
  operationLog: OperationLog;
  docManager: DocManager;
  recentlyApplied: RecentlyApplied;
  /** Same value used as the vector-clock key everywhere. One per copy of the vault. */
  clientId: string;
  /** Forwarded to every engine: see `SyncEngineDeps.previousClientIds`. */
  previousClientIds?: readonly string[] | undefined;
  /** Forwarded to every engine: see `SyncEngineDeps.onTwinDetected`. */
  onTwinDetected?: ((clientId: string) => void) | undefined;
  /** Optional UI hook for binary / delete conflicts. */
  conflictResolver?: ConflictResolver | undefined;
  /**
   * Root logger, forwarded to every `SyncEngine` (which scopes it with its
   * own `bindingId`). When omitted, engines fall back to a silent logger.
   */
  logger?: Logger | undefined;
  /**
   * Obsidian's config folder (`Vault.configDir`), forwarded to every engine:
   * nothing the server sends may be written inside it. Default `.obsidian`.
   */
  configDir?: string | undefined;
  /** Test seam — defaults to `new SyncEngine(deps)`. */
  engineFactory?: (deps: SyncEngineDeps) => SyncEngine;
  /**
   * Optional clients for tests. Production constructs real ones inside
   * `SyncEngine` itself when these are absent.
   */
  apiClient?: ((server: ServerConfig) => ApiClient) | undefined;
  socketClient?: ((server: ServerConfig, clientId: string) => SocketClient) | undefined;
  /**
   * Called when a binding finishes a sync cycle — its engine reaches
   * `connected` after catch-up. Lets the host stamp the binding's
   * `lastSyncedAt` and persist it to settings (`data.json`).
   */
  onBindingSynced?: ((bindingId: string, at: number) => void) | undefined;
}

export class EngineManager {
  private readonly engines = new Map<string, SyncEngine>();
  /** Per-engine subscriptions to release on stop / refresh. */
  private readonly subs = new Map<string, () => void>();
  /** Last status known per engine — feeds the aggregate. */
  private readonly statuses = new Map<string, EngineStatus>();
  /**
   * Per engine, the server address and API key it was spawned with. An engine
   * builds its REST and socket clients from them once, and the settings tab
   * may replace the server entry or change it in place — so a refresh
   * compares the settings with this, not with the entry the engine was given.
   */
  private readonly connections = new Map<string, ServerConnection>();
  /**
   * Bindings whose engine is being replaced by one on a new address or key,
   * each with a promise that settles once the new engine has taken the old
   * one's place — or once it is clear that none will (see `restartEngine`).
   */
  private readonly restarts = new Map<string, Promise<void>>();
  /**
   * Per binding, the server paths its engines have already refused at `warn`
   * (`SyncEngineDeps.reportedRefusals`). Here and not in the engine:
   * switching a binding off and on replaces the engine, and each new one
   * logged the same `.DS_Store` refusals at `warn` again. Kept until the
   * plugin unloads, or until the binding is removed.
   */
  private readonly reportedRefusals = new Map<string, Set<string>>();
  private listeners = new Set<AggregateListener>();
  private paused = false;
  /**
   * Set by `stop()` (plugin unload) and cleared by `start()`. Obsidian does not
   * wait for `onunload`, so a `saveSettings()` already in flight — the one
   * `onBindingSynced` fires on every connect — could call
   * `refreshFromSettings()` after the teardown and spawn a fresh engine that
   * nobody would ever stop: a socket and vault writes from an unloaded plugin.
   */
  private stopped = false;
  /** Latest detail string emitted by any engine — surfaced as
   *  `AggregateStatus.detail`. Cleared when the aggregate transitions
   *  to a non-error state. */
  private lastDetail: string | undefined = undefined;

  constructor(private readonly deps: EngineManagerDeps) {}

  // -- Lifecycle ------------------------------------------------------------

  /** Bring up an engine for every enabled binding in the current settings. */
  async start(): Promise<void> {
    this.stopped = false;
    this.paused = false;
    await this.refreshFromSettings();
  }

  /**
   * Tear everything down for good (plugin unload): no engine is spawned
   * afterwards until `start()` is called again. Pausing is `pause()`.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const stops: Array<Promise<void>> = [];
    for (const engine of this.engines.values()) stops.push(engine.stop());
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.engines.clear();
    this.statuses.clear();
    this.connections.clear();
    await Promise.all(stops);
    this.notifyAggregate();
  }

  /**
   * Reconcile the engine roster with the current settings:
   *   - new enabled bindings → create + start an engine,
   *   - bindings turned off / removed → stop + drop the engine,
   *   - bindings whose server got a new address or API key → a new engine
   *     on it, with the binding's local state kept (see `restartEngine`),
   *   - everything else → leave alone.
   *
   * While paused too: a binding added meanwhile gets an engine that is paused
   * from the start — it records the changes made in the vault and connects on
   * `resume()` — and one removed or switched off is stopped (and its local
   * state purged, when removed) as at any other time.
   */
  async refreshFromSettings(): Promise<void> {
    if (this.stopped) return;
    const { servers, bindings } = this.deps.getSettings();
    const serverById = new Map(servers.map((s) => [s.id, s]));
    const desired = new Set<string>();
    // Every binding still present in settings, regardless of `enabled` —
    // distinguishes "removed" (purge local state) from "merely disabled"
    // (keep its queue for when it's switched back on).
    const known = new Set(bindings.map((b) => b.id));
    for (const id of [...this.reportedRefusals.keys()]) {
      if (!known.has(id)) this.reportedRefusals.delete(id);
    }

    for (const binding of bindings) {
      if (!binding.enabled) continue;
      const server = serverById.get(binding.serverId);
      if (!server) continue;
      desired.add(binding.id);
      if (!this.engines.has(binding.id)) {
        await this.spawn(binding, server);
      } else if (connectionChanged(this.connections.get(binding.id), server)) {
        await this.restartEngine(binding.id);
      }
    }

    for (const id of [...this.engines.keys()]) {
      if (!desired.has(id)) await this.dropEngine(id, { purge: !known.has(id) });
    }
  }

  /**
   * Pause sync: every engine closes its connection and stays disconnected
   * until `resume()`, and goes on recording what changes in the vault — the
   * offline queue, renames and deletes, notes folded into their docs — exactly
   * as when the network drops (see `SyncEngine.pause`).
   *
   * The engines used to be stopped and dropped, and a vault event with no
   * engine to take it was lost: a note renamed while paused came back on
   * resume as two notes for the whole team, one deleted came back.
   *
   * Not kept across a restart: the next start of the plugin connects.
   */
  pause(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    this.paused = true;
    for (const engine of this.engines.values()) engine.pause();
    this.notifyAggregate();
    return Promise.resolve();
  }

  /**
   * Resume sync after `pause()`: every engine connects again through the
   * normal connect flow (see `SyncEngine.resume`), a binding added meanwhile
   * included.
   */
  async resume(): Promise<void> {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    await this.refreshFromSettings();
    // Paused again, or stopped, while the roster was reconciled.
    if (this.paused || this.stopped) return;
    // Each engine reports `connecting` as it takes the call.
    const resumed = Promise.all([...this.engines.values()].map((engine) => engine.resume()));
    this.notifyAggregate();
    await resumed;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // -- Vault event fan-out --------------------------------------------------

  /**
   * Forward a watcher event to the engine that owns the binding.
   *
   * While that engine is being replaced — its server got a new address or API
   * key — the event waits for the new one. The old one drops what comes once
   * it is stopping, and it may be stopping for a while: it waits for a local
   * phase it has under way. Dropped so, a change was lost although the binding
   * stays on: a note deleted then came back from the server, one renamed came
   * back under its old name next to the new one.
   */
  async dispatchVaultEvent(event: VaultEvent): Promise<void> {
    const restart = this.restarts.get(event.bindingId);
    if (restart) await restart;
    const engine = this.engines.get(event.bindingId);
    if (!engine) return;
    await engine.handleVaultEvent(event);
  }

  // -- Status surfacing -----------------------------------------------------

  onAggregateStatus(cb: AggregateListener): () => void {
    this.listeners.add(cb);
    cb(this.getAggregateStatus());
    return () => this.listeners.delete(cb);
  }

  getAggregateStatus(): AggregateStatus {
    const bindings: Record<string, EngineStatus> = {};
    for (const [id, status] of this.statuses) bindings[id] = status;
    if (this.paused) return { state: 'paused', bindings };

    if (Object.keys(bindings).length === 0) {
      return { state: 'idle', bindings };
    }
    const state = aggregate(Object.values(bindings));
    const out: AggregateStatus = { state, bindings };
    if (this.lastDetail !== undefined) out.detail = this.lastDetail;
    return out;
  }

  /**
   * Force a deep-sync diff fetch on every active engine (used by "Sync now").
   * Nothing while paused: sync is off until `resume()`.
   */
  async runDeepSyncOnAll(): Promise<Array<{ bindingId: string; diff: unknown }>> {
    const out: Array<{ bindingId: string; diff: unknown }> = [];
    if (this.paused) return out;
    for (const [id, engine] of this.engines) {
      out.push({ bindingId: id, diff: await engine.runDeepSyncDiff() });
    }
    return out;
  }

  /** Engines exposed for ad-hoc UI surfaces (the History view needs the api). */
  getEngine(bindingId: string): SyncEngine | undefined {
    return this.engines.get(bindingId);
  }

  // -- Internals ------------------------------------------------------------

  private async spawn(binding: VaultBinding, server: ServerConfig): Promise<void> {
    // `refreshFromSettings` awaits between bindings, so `stop()` can land in
    // the middle of its loop.
    if (this.stopped) return;
    const apiClient = this.deps.apiClient ? this.deps.apiClient(server) : undefined;
    const socketClient = this.deps.socketClient
      ? this.deps.socketClient(server, this.deps.clientId)
      : undefined;
    let reportedRefusals = this.reportedRefusals.get(binding.id);
    if (!reportedRefusals) {
      reportedRefusals = new Set();
      this.reportedRefusals.set(binding.id, reportedRefusals);
    }
    const engineDeps: SyncEngineDeps = {
      binding,
      server,
      clientId: this.deps.clientId,
      ...(this.deps.previousClientIds ? { previousClientIds: this.deps.previousClientIds } : {}),
      ...(this.deps.onTwinDetected ? { onTwinDetected: this.deps.onTwinDetected } : {}),
      vault: this.deps.vault,
      operationLog: this.deps.operationLog,
      docManager: this.deps.docManager,
      recentlyApplied: this.deps.recentlyApplied,
      reportedRefusals,
      ...(apiClient ? { apiClient } : {}),
      ...(socketClient ? { socketClient } : {}),
      ...(this.deps.conflictResolver ? { conflictResolver: this.deps.conflictResolver } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      ...(this.deps.configDir ? { configDir: this.deps.configDir } : {}),
    };
    const engine = this.deps.engineFactory
      ? this.deps.engineFactory(engineDeps)
      : new SyncEngine(engineDeps);

    this.engines.set(binding.id, engine);
    this.connections.set(binding.id, { url: server.url, apiKey: server.apiKey });
    const off = engine.onStatus((status, detail) => {
      const was = this.statuses.get(binding.id);
      this.statuses.set(binding.id, status);
      // `connected` is the catch-up-complete transition: the binding has
      // synced with the server. Let the host stamp lastSyncedAt + persist.
      // Only on the transition: a connected engine reports `connected` again
      // when only its detail changes (changes waiting behind ones the server
      // refused as busy), and each report saved the settings.
      if (status === 'connected' && was !== 'connected') {
        this.deps.onBindingSynced?.(binding.id, Date.now());
      }
      // Stash the latest detail so `getAggregateStatus()` keeps reporting
      // it consistently (otherwise a fresh call would lose context).
      this.lastDetail = detail;
      this.notifyAggregate();
    });
    this.subs.set(binding.id, off);

    // Spawned while paused: it takes local changes and connects on `resume()`.
    if (this.paused) engine.pause();
    await engine.start();
    // `stop()` ran while this engine was still starting: it was stopped along
    // with the rest, but `start()` may have connected after that.
    if (this.stopped && this.engines.get(binding.id) !== engine) await engine.stop();
  }

  /**
   * Replace a binding's engine with one on its server's new address or API
   * key — the server entry was edited in the settings tab. As when the
   * binding is switched off and on: the old engine stops, queuing the changes
   * it still held, and the new one starts from the binding's local state.
   * Nothing of it is purged — the offline queue, the file index, the offline
   * documents in IndexedDB — so the new engine catches up and sends what was
   * queued, on the new address. A paused manager spawns it paused.
   *
   * Refreshes run side by side (every connect saves the settings, and a save
   * refreshes), so one that comes meanwhile leaves this binding to this call.
   * And the settings are read again once the engine has stopped: a refresh
   * meanwhile may have dropped it (the binding switched off or removed, and
   * purged then), or the server may have changed once more.
   *
   * Vault events for the binding wait until this call ends (see
   * `dispatchVaultEvent`), and then go to the new engine — to none, when the
   * binding is off by then or the plugin unloads.
   */
  private async restartEngine(id: string): Promise<void> {
    const engine = this.engines.get(id);
    if (!engine || this.restarts.has(id)) return;
    let settle!: () => void;
    this.restarts.set(
      id,
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    try {
      await this.replaceEngine(id, engine);
    } finally {
      this.restarts.delete(id);
      settle();
    }
  }

  /** The body of {@link restartEngine}. */
  private async replaceEngine(id: string, engine: SyncEngine): Promise<void> {
    this.deps.logger?.info('server address or API key changed; restarting the engine', {
      bindingId: id,
    });
    // Its `stopped` is not the binding's state: the status bar keeps the last
    // one until the new engine reports its own.
    this.subs.get(id)?.();
    this.subs.delete(id);
    await engine.stop();
    if (this.engines.get(id) !== engine) return;
    this.forget(id);
    const { servers, bindings } = this.deps.getSettings();
    const binding = bindings.find((b) => b.id === id);
    const server = binding ? servers.find((s) => s.id === binding.serverId) : undefined;
    if (binding?.enabled && server) await this.spawn(binding, server);
    else this.notifyAggregate();
  }

  /** Let go of an engine's bookkeeping; the engine itself is stopped already. */
  private forget(id: string): void {
    this.subs.get(id)?.();
    this.subs.delete(id);
    this.engines.delete(id);
    this.statuses.delete(id);
    this.connections.delete(id);
  }

  /**
   * Stop and forget an engine. `purge` additionally erases the binding's
   * local state from the operation log — set only when the binding is gone
   * from settings for good (see {@link refreshFromSettings}), never on a
   * plain disable or shutdown, where the queue must survive.
   */
  private async dropEngine(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    const engine = this.engines.get(id);
    if (engine) await engine.stop();
    // Unless a restart has put a new engine in its place meanwhile.
    if (this.engines.get(id) === engine) this.forget(id);
    if (opts.purge) {
      // Capture the tracked file list BEFORE wiping the log — purgeBinding
      // clears file_meta, which the doc-manager purge uses as a fallback to
      // locate y-indexeddb databases on runtimes that can't enumerate them.
      const paths = this.deps.operationLog.listFileMeta(id).map((m) => m.relativePath);
      try {
        const removed = this.deps.operationLog.purgeBinding(id);
        this.deps.logger?.info('purged local state for removed binding', {
          bindingId: id,
          ...removed,
        });
      } catch (err) {
        // Cleanup must never break roster reconciliation; the startup
        // orphan-sweep will retry on next load.
        this.deps.logger?.warn('failed to purge local state for removed binding', {
          bindingId: id,
          err,
        });
      }
      // Offline CRDT state (y-indexeddb databases) is separate bookkeeping
      // from the SQLite log; delete it too, or the binding's docs leak on disk.
      try {
        const databases = await this.deps.docManager.purgeBinding(id, paths);
        this.deps.logger?.info('purged offline CRDT state for removed binding', {
          bindingId: id,
          databases: databases.length,
        });
      } catch (err) {
        this.deps.logger?.warn('failed to purge offline CRDT state for removed binding', {
          bindingId: id,
          err,
        });
      }
    }
    this.notifyAggregate();
  }

  private notifyAggregate(): void {
    const status = this.getAggregateStatus();
    for (const cb of this.listeners) {
      try {
        cb(status);
      } catch {
        // swallow — listener errors must not propagate.
      }
    }
  }
}

/**
 * Whether the server now has another address or API key than the engine was
 * spawned with. Its name is only a label: a new one restarts nothing.
 */
function connectionChanged(spawned: ServerConnection | undefined, server: ServerConfig): boolean {
  if (!spawned) return false;
  return spawned.url !== server.url || spawned.apiKey !== server.apiKey;
}

/**
 * Reduce per-binding statuses into a single aggregate. Priority:
 *   error > connecting / syncing > offline > connected > stopped.
 *
 * `stopped` only appears mid-tear-down; it's reported as `offline` so
 * the UI doesn't flicker.
 */
function aggregate(statuses: readonly EngineStatus[]): AggregateState {
  if (statuses.some((s) => s === 'error')) return 'error';
  if (statuses.some((s) => s === 'syncing')) return 'syncing';
  if (statuses.some((s) => s === 'connecting')) return 'connecting';
  if (statuses.every((s) => s === 'offline' || s === 'stopped')) return 'offline';
  if (statuses.every((s) => s === 'connected')) return 'connected';
  return 'syncing'; // mixed states — call it syncing; will resolve once all settle.
}
