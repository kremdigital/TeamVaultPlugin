import type { VaultBinding } from '@/settings/settings';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import { isAlwaysIgnored, isInBinding } from './path-utils';
import type { RecentlyApplied } from './recently-applied';

/**
 * Subscriber-friendly wrapper around `app.vault.on(create | modify | delete | rename)`.
 *
 * Stage 6 responsibilities:
 *
 *   - Map each Obsidian event to a typed `VaultEvent` enriched with the
 *     binding it belongs to (or drop it if it doesn't fall inside any).
 *   - Debounce `modify` per (binding, path) — Obsidian fires several
 *     events per save (`metadata`, `links`, etc) and the engine doesn't
 *     need every microtick.
 *   - Honor a `RecentlyApplied` set so events triggered by the plugin's
 *     own `vault.modify` calls (catch-up sync, conflict resolution)
 *     don't echo back upstream.
 *
 * The watcher does NOT depend on the full Obsidian API — it accepts a
 * `WatchableVault` adapter so unit tests can drive it without an Obsidian
 * runtime. The adapter mirrors the slice of `app.vault` we use.
 */

// -- Public types -------------------------------------------------------------

export type VaultEventSource = 'obsidian' | 'fs';

export type VaultEvent =
  | { type: 'create'; bindingId: string; path: string; source: VaultEventSource }
  | { type: 'modify'; bindingId: string; path: string; source: VaultEventSource }
  | { type: 'delete'; bindingId: string; path: string; source: VaultEventSource }
  | {
      type: 'rename';
      bindingId: string;
      oldPath: string;
      newPath: string;
      source: VaultEventSource;
    };

export type VaultEventHandler = (event: VaultEvent) => void;

// -- Vault adapter (the bit of `app.vault` we use) ----------------------------

/** A minimal stand-in for `TFile` / `TFolder`. Adapters must set
 *  `kind: 'folder'` for folders so the watcher can drop them — Obsidian's
 *  built-in `extension` field is unreliable (it's `''` for files like
 *  `Makefile` and absent on folders). */
export interface WatchableFile {
  path: string;
  kind?: 'file' | 'folder';
}

export type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';

/** Subset of `Vault` we depend on — `on` returns an opaque ref, `offref`
 *  cancels it. Mirrors Obsidian 1.5+ exactly. */
export interface WatchableVault {
  on(name: 'create', cb: (file: WatchableFile) => void): unknown;
  on(name: 'modify', cb: (file: WatchableFile) => void): unknown;
  on(name: 'delete', cb: (file: WatchableFile) => void): unknown;
  on(name: 'rename', cb: (file: WatchableFile, oldPath: string) => void): unknown;
  offref(ref: unknown): void;
}

// -- Options ------------------------------------------------------------------

export interface ObsidianWatcherOptions {
  bindings: () => VaultBinding[];
  recentlyApplied: RecentlyApplied;
  /** Debounce window for modify (ms). Default 300. */
  modifyDebounceMs?: number;
  /** Test seam — defaults to globalThis. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

// -- Watcher ------------------------------------------------------------------

export class ObsidianWatcher {
  private readonly handlers = new Set<VaultEventHandler>();
  private readonly modifyDebounceMs: number;
  private readonly setT?: ObsidianWatcherOptions['setTimeout'];
  private readonly clearT?: ObsidianWatcherOptions['clearTimeout'];
  private readonly recentlyApplied: RecentlyApplied;
  private readonly getBindings: () => VaultBinding[];

  /** Per-`(binding, path)` debounced fan-out. */
  private readonly modifyDebouncers = new Map<string, DebouncedFunction<[string, string]>>();
  private refs: unknown[] = [];
  private vault: WatchableVault | null = null;

  constructor(options: ObsidianWatcherOptions) {
    this.getBindings = options.bindings;
    this.recentlyApplied = options.recentlyApplied;
    this.modifyDebounceMs = options.modifyDebounceMs ?? 300;
    this.setT = options.setTimeout;
    this.clearT = options.clearTimeout;
  }

  /** Attach event listeners to the given vault. Idempotent. */
  start(vault: WatchableVault): void {
    if (this.vault) return;
    this.vault = vault;
    this.refs.push(vault.on('create', (file) => this.onCreate(file)));
    this.refs.push(vault.on('modify', (file) => this.onModify(file)));
    this.refs.push(vault.on('delete', (file) => this.onDelete(file)));
    this.refs.push(vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
  }

  /** Detach and cancel pending debounced calls. */
  stop(): void {
    if (this.vault) {
      for (const ref of this.refs) this.vault.offref(ref);
      this.refs = [];
      this.vault = null;
    }
    for (const d of this.modifyDebouncers.values()) d.cancel();
    this.modifyDebouncers.clear();
  }

  /** Subscribe to `VaultEvent`s. Returns an unsubscribe handle. */
  onEvent(handler: VaultEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // -- Obsidian event mapping ---------------------------------------------

  private onCreate(file: WatchableFile): void {
    if (!isFile(file)) return;
    if (this.recentlyApplied.take(file.path)) return;
    this.dispatchForBindings(file.path, (bindingId) =>
      this.fan({ type: 'create', bindingId, path: file.path, source: 'obsidian' }),
    );
  }

  private onDelete(file: WatchableFile): void {
    if (!isFile(file)) return;
    if (this.recentlyApplied.take(file.path)) return;
    this.dispatchForBindings(file.path, (bindingId) =>
      this.fan({ type: 'delete', bindingId, path: file.path, source: 'obsidian' }),
    );
  }

  private onRename(file: WatchableFile, oldPath: string): void {
    if (!isFile(file)) return;
    // Both paths are checked separately — a rename out of a binding becomes
    // a delete at oldPath; a rename into a binding becomes a create at newPath.
    // For the simple in-binding case we emit a single rename.
    this.recentlyApplied.take(file.path);
    this.recentlyApplied.take(oldPath);
    for (const binding of this.getBindings()) {
      if (!binding.enabled) continue;
      const inOld = isInBinding(oldPath, binding.localFolder);
      const inNew = isInBinding(file.path, binding.localFolder);
      if (isAlwaysIgnored(oldPath) && isAlwaysIgnored(file.path)) continue;
      if (inOld && inNew) {
        this.fan({
          type: 'rename',
          bindingId: binding.id,
          oldPath,
          newPath: file.path,
          source: 'obsidian',
        });
      } else if (inOld && !inNew) {
        this.fan({ type: 'delete', bindingId: binding.id, path: oldPath, source: 'obsidian' });
      } else if (!inOld && inNew) {
        this.fan({ type: 'create', bindingId: binding.id, path: file.path, source: 'obsidian' });
      }
    }
  }

  private onModify(file: WatchableFile): void {
    if (!isFile(file)) return;
    if (this.recentlyApplied.take(file.path)) return;
    this.dispatchForBindings(file.path, (bindingId) => {
      const key = `${bindingId}::${file.path}`;
      let d = this.modifyDebouncers.get(key);
      if (!d) {
        d = debounce<[string, string]>(
          (b, p) => {
            this.modifyDebouncers.delete(key);
            this.fan({ type: 'modify', bindingId: b, path: p, source: 'obsidian' });
          },
          this.modifyDebounceMs,
          {
            ...(this.setT ? { setTimeout: this.setT } : {}),
            ...(this.clearT ? { clearTimeout: this.clearT } : {}),
          },
        );
        this.modifyDebouncers.set(key, d);
      }
      d(bindingId, file.path);
    });
  }

  // -- Helpers ------------------------------------------------------------

  private dispatchForBindings(path: string, action: (bindingId: string) => void): void {
    if (isAlwaysIgnored(path)) return;
    for (const binding of this.getBindings()) {
      if (!binding.enabled) continue;
      if (!isInBinding(path, binding.localFolder)) continue;
      action(binding.id);
    }
  }

  private fan(event: VaultEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Listener errors must not break the watcher chain — engine logs.
      }
    }
  }
}

function isFile(file: WatchableFile): boolean {
  // Default to "file" — the adapter on top of Obsidian sets `kind: 'folder'`
  // explicitly when it sees a `TFolder`. Treating an unset `kind` as a
  // file means tests that pass `{ path }` without a kind work naturally.
  return file.kind !== 'folder';
}
