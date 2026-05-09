import type * as chokidarTypes from 'chokidar';
import type { ChokidarOptions, FSWatcher } from 'chokidar';
import type { VaultBinding } from '@/settings/settings';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import { loadNative } from '@/utils/native-loader';
import {
  ALWAYS_IGNORED_SEGMENTS,
  absoluteToVault,
  isAlwaysIgnored,
  isInBinding,
  normalizeSeparators,
} from './path-utils';
import type { RecentlyApplied } from './recently-applied';
import type { VaultEvent, VaultEventHandler } from './obsidian-events';

/**
 * Filesystem watcher.
 *
 * Stage 6 responsibilities (per `tasks.md` 6.2):
 *
 *   - Watch the vault root with chokidar so changes coming from outside
 *     Obsidian (CLI scripts, AI agents writing directly to disk, …) get
 *     observed. Obsidian's `vault.on(...)` only fires for app-mediated
 *     edits.
 *   - Ignore noise: `.obsidian`, `.git`, `.versions`, temp files,
 *     anything outside an enabled binding's `localFolder`.
 *   - Debounce writes — external agents commonly rewrite a file in
 *     several syscalls; we want one event after the dust settles.
 *   - Suppress events triggered by our own `vault.modify(...)` calls
 *     via the shared `RecentlyApplied` set.
 *   - Avoid duplicating events that the Obsidian watcher already saw —
 *     a per-(path, type) dedupe window swallows the second fire.
 *
 * The chokidar dependency is injectable so tests can run without real
 * filesystem watching.
 */

export type FsWatcherFactory = (paths: string[], options: ChokidarOptions) => FSWatcher;

/**
 * Default factory — lazy-loads chokidar through `loadNative` so the
 * bundle's `require("chokidar")` doesn't fail under Obsidian's plugin
 * runtime. Tests inject their own factory via `FsWatcherOptions.factory`.
 */
const defaultFactory: FsWatcherFactory = (paths, options) => {
  const chokidar = loadNative<typeof chokidarTypes>('chokidar');
  return chokidar.watch(paths, options);
};

export interface FsWatcherOptions {
  vaultBasePath: string;
  bindings: () => VaultBinding[];
  recentlyApplied: RecentlyApplied;
  /** Window (ms) during which a (path, type) tuple seen via Obsidian
   *  is suppressed when chokidar emits it. Default 800ms. */
  dedupeWindowMs?: number;
  /** Debounce for FS-driven modify events. Default 1000ms (matches the
   *  "external agent stretch" — typical AI agents do several writes per
   *  edit, and 1s is enough to coalesce them without feeling laggy). */
  modifyDebounceMs?: number;
  factory?: FsWatcherFactory;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

export class FsWatcher {
  private readonly factory: FsWatcherFactory;
  private readonly vaultBasePath: string;
  private readonly getBindings: () => VaultBinding[];
  private readonly recentlyApplied: RecentlyApplied;
  private readonly dedupeWindowMs: number;
  private readonly modifyDebounceMs: number;
  private readonly setT?: FsWatcherOptions['setTimeout'];
  private readonly clearT?: FsWatcherOptions['clearTimeout'];
  private readonly now: () => number;

  private watcher: FSWatcher | null = null;
  private readonly handlers = new Set<VaultEventHandler>();
  private readonly recentObsidian = new Map<string, number>();
  private readonly modifyDebouncers = new Map<string, DebouncedFunction<[string]>>();

  constructor(options: FsWatcherOptions) {
    this.factory = options.factory ?? defaultFactory;
    this.vaultBasePath = options.vaultBasePath;
    this.getBindings = options.bindings;
    this.recentlyApplied = options.recentlyApplied;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 800;
    this.modifyDebounceMs = options.modifyDebounceMs ?? 1000;
    this.setT = options.setTimeout;
    this.clearT = options.clearTimeout;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.watcher) return;
    const watcher = this.factory([this.vaultBasePath], {
      ignored: (filePath: string) => this.shouldIgnoreAbsolute(filePath),
      ignoreInitial: true,
      persistent: true,
      // We don't watch hidden files outside what binding folders explicitly
      // expose. `awaitWriteFinish` smooths out partial writes from atomic
      // saves (editor → tmp → rename).
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    watcher.on('add', (p: string) => this.handle('create', p));
    watcher.on('change', (p: string) => this.handle('modify', p));
    watcher.on('unlink', (p: string) => this.handle('delete', p));
    this.watcher = watcher;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    for (const d of this.modifyDebouncers.values()) d.cancel();
    this.modifyDebouncers.clear();
    this.recentObsidian.clear();
  }

  /** Register an Obsidian event so the FS watcher can dedupe shortly after. */
  notifyObsidianEvent(type: 'create' | 'modify' | 'delete', vaultPath: string): void {
    this.recentObsidian.set(`${type}::${vaultPath}`, this.now());
  }

  onEvent(handler: VaultEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // -- Internals ----------------------------------------------------------

  private shouldIgnoreAbsolute(absolutePath: string): boolean {
    const normalized = normalizeSeparators(absolutePath);
    for (const seg of ALWAYS_IGNORED_SEGMENTS) {
      if (normalized.includes(`/${seg}/`) || normalized.endsWith(`/${seg}`)) return true;
    }
    return false;
  }

  private handle(type: 'create' | 'modify' | 'delete', absolutePath: string): void {
    const vaultPath = absoluteToVault(absolutePath, this.vaultBasePath);
    if (vaultPath === null || vaultPath === '') return;
    if (isAlwaysIgnored(vaultPath)) return;
    if (this.recentlyApplied.take(vaultPath)) return;
    if (this.takeObsidianDedupe(type, vaultPath)) return;

    const bindings = this.getBindings().filter(
      (b) => b.enabled && isInBinding(vaultPath, b.localFolder),
    );
    if (bindings.length === 0) return;

    if (type === 'modify') {
      this.fanModify(vaultPath, bindings);
      return;
    }
    for (const binding of bindings) {
      this.fan({ type, bindingId: binding.id, path: vaultPath, source: 'fs' });
    }
  }

  private fanModify(vaultPath: string, bindings: VaultBinding[]): void {
    for (const binding of bindings) {
      const key = `${binding.id}::${vaultPath}`;
      let d = this.modifyDebouncers.get(key);
      if (!d) {
        d = debounce<[string]>(
          (path) => {
            this.modifyDebouncers.delete(key);
            this.fan({ type: 'modify', bindingId: binding.id, path, source: 'fs' });
          },
          this.modifyDebounceMs,
          {
            ...(this.setT ? { setTimeout: this.setT } : {}),
            ...(this.clearT ? { clearTimeout: this.clearT } : {}),
          },
        );
        this.modifyDebouncers.set(key, d);
      }
      d(vaultPath);
    }
  }

  private takeObsidianDedupe(type: 'create' | 'modify' | 'delete', path: string): boolean {
    const key = `${type}::${path}`;
    const ts = this.recentObsidian.get(key);
    if (ts === undefined) return false;
    if (this.now() - ts > this.dedupeWindowMs) {
      this.recentObsidian.delete(key);
      return false;
    }
    this.recentObsidian.delete(key);
    return true;
  }

  private fan(event: VaultEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Swallow — the engine logs explicitly.
      }
    }
  }
}
