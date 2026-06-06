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

export interface EngineManagerDeps {
  /** Live settings — re-read on every refresh; lets the UI tweak debounce
   *  / log level / etc. without a restart. */
  getSettings: () => { servers: ServerConfig[]; bindings: VaultBinding[] };
  vault: VaultAdapter;
  operationLog: OperationLog;
  docManager: DocManager;
  recentlyApplied: RecentlyApplied;
  /** Same value used as the vector-clock key everywhere. Stable per device. */
  clientId: string;
  /** Optional UI hook for binary / delete conflicts. */
  conflictResolver?: ConflictResolver | undefined;
  /**
   * Root logger, forwarded to every `SyncEngine` (which scopes it with its
   * own `bindingId`). When omitted, engines fall back to a silent logger.
   */
  logger?: Logger | undefined;
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
  private listeners = new Set<AggregateListener>();
  private paused = false;
  /** Latest detail string emitted by any engine — surfaced as
   *  `AggregateStatus.detail`. Cleared when the aggregate transitions
   *  to a non-error state. */
  private lastDetail: string | undefined = undefined;

  constructor(private readonly deps: EngineManagerDeps) {}

  // -- Lifecycle ------------------------------------------------------------

  /** Bring up an engine for every enabled binding in the current settings. */
  async start(): Promise<void> {
    this.paused = false;
    await this.refreshFromSettings();
  }

  /** Tear everything down. Engines stay registered (we just disconnect). */
  async stop(): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const engine of this.engines.values()) stops.push(engine.stop());
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.engines.clear();
    this.statuses.clear();
    await Promise.all(stops);
    this.notifyAggregate();
  }

  /**
   * Reconcile the engine roster with the current settings:
   *   - new enabled bindings → create + start an engine,
   *   - bindings turned off / removed → stop + drop the engine,
   *   - everything else → leave alone.
   */
  async refreshFromSettings(): Promise<void> {
    if (this.paused) return;
    const { servers, bindings } = this.deps.getSettings();
    const serverById = new Map(servers.map((s) => [s.id, s]));
    const desired = new Set<string>();
    // Every binding still present in settings, regardless of `enabled` —
    // distinguishes "removed" (purge local state) from "merely disabled"
    // (keep its queue for when it's switched back on).
    const known = new Set(bindings.map((b) => b.id));

    for (const binding of bindings) {
      if (!binding.enabled) continue;
      const server = serverById.get(binding.serverId);
      if (!server) continue;
      desired.add(binding.id);
      if (!this.engines.has(binding.id)) {
        await this.spawn(binding, server);
      }
    }

    for (const id of [...this.engines.keys()]) {
      if (!desired.has(id)) await this.dropEngine(id, { purge: !known.has(id) });
    }
  }

  /** Stop every engine but keep settings; resumes via `resume()`. */
  async pause(): Promise<void> {
    this.paused = true;
    const stops: Array<Promise<void>> = [];
    for (const engine of this.engines.values()) stops.push(engine.stop());
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.engines.clear();
    this.statuses.clear();
    await Promise.all(stops);
    this.notifyAggregate();
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.refreshFromSettings();
  }

  isPaused(): boolean {
    return this.paused;
  }

  // -- Vault event fan-out --------------------------------------------------

  /** Forward a watcher event to the engine that owns the binding. */
  async dispatchVaultEvent(event: VaultEvent): Promise<void> {
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
    if (this.paused) {
      return { state: 'paused', bindings: {} };
    }
    const bindings: Record<string, EngineStatus> = {};
    for (const [id, status] of this.statuses) bindings[id] = status;

    if (Object.keys(bindings).length === 0) {
      return { state: 'idle', bindings };
    }
    const state = aggregate(Object.values(bindings));
    const out: AggregateStatus = { state, bindings };
    if (this.lastDetail !== undefined) out.detail = this.lastDetail;
    return out;
  }

  /** Force a deep-sync diff fetch on every active engine (used by "Sync now"). */
  async runDeepSyncOnAll(): Promise<Array<{ bindingId: string; diff: unknown }>> {
    const out: Array<{ bindingId: string; diff: unknown }> = [];
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
    const apiClient = this.deps.apiClient ? this.deps.apiClient(server) : undefined;
    const socketClient = this.deps.socketClient
      ? this.deps.socketClient(server, this.deps.clientId)
      : undefined;
    const engineDeps: SyncEngineDeps = {
      binding,
      server,
      clientId: this.deps.clientId,
      vault: this.deps.vault,
      operationLog: this.deps.operationLog,
      docManager: this.deps.docManager,
      recentlyApplied: this.deps.recentlyApplied,
      ...(apiClient ? { apiClient } : {}),
      ...(socketClient ? { socketClient } : {}),
      ...(this.deps.conflictResolver ? { conflictResolver: this.deps.conflictResolver } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    };
    const engine = this.deps.engineFactory
      ? this.deps.engineFactory(engineDeps)
      : new SyncEngine(engineDeps);

    this.engines.set(binding.id, engine);
    const off = engine.onStatus((status, detail) => {
      this.statuses.set(binding.id, status);
      // `connected` is the catch-up-complete transition: the binding has
      // synced with the server. Let the host stamp lastSyncedAt + persist.
      if (status === 'connected') {
        this.deps.onBindingSynced?.(binding.id, Date.now());
      }
      // Stash the latest detail so `getAggregateStatus()` keeps reporting
      // it consistently (otherwise a fresh call would lose context).
      this.lastDetail = detail;
      this.notifyAggregate();
    });
    this.subs.set(binding.id, off);

    await engine.start();
  }

  /**
   * Stop and forget an engine. `purge` additionally erases the binding's
   * local state from the operation log — set only when the binding is gone
   * from settings for good (see {@link refreshFromSettings}), never on a
   * plain disable, pause, or shutdown, where the queue must survive.
   */
  private async dropEngine(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    const engine = this.engines.get(id);
    if (engine) await engine.stop();
    const off = this.subs.get(id);
    if (off) off();
    this.engines.delete(id);
    this.subs.delete(id);
    this.statuses.delete(id);
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
