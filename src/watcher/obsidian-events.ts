import type { VaultBinding } from '@/settings/settings';
import { debounce, type DebouncedFunction } from '@/utils/debounce';
import {
  DEFAULT_CONFIG_DIR,
  isAlwaysIgnored,
  isInBinding,
  windowsRefusal,
  type WindowsRefusal,
} from './path-utils';
import type { RecentlyApplied } from './recently-applied';

/**
 * Subscriber-friendly wrapper around `app.vault.on(create | modify | delete | rename)`.
 *
 * Stage 6 responsibilities:
 *
 *   - Map each Obsidian event to a typed `VaultEvent` enriched with the
 *     binding it belongs to (or drop it if it doesn't fall inside any).
 *   - Drop what the shared ignore list refuses (`isAlwaysIgnored` in
 *     `path-utils`, the same list chokidar and the engine use). Obsidian
 *     never indexes a dotted path, so here that is mostly service files
 *     without a dot, such as `desktop.ini`, `Thumbs.db` and Office's
 *     `~$<name>` owner files, folders named like temporary files, and
 *     names Windows can't keep as spelled (`Why?.md`, a folder `Notes.`),
 *     which Obsidian allows on macOS and Linux. A note dropped for such a
 *     name is reported (`onUnsyncableName`): unlike a service file, it is one
 *     the user meant to share.
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
  | {
      type: 'delete';
      bindingId: string;
      path: string;
      source: VaultEventSource;
      isFolder?: boolean;
    }
  | {
      type: 'rename';
      bindingId: string;
      oldPath: string;
      newPath: string;
      source: VaultEventSource;
    };

export type VaultEventHandler = (event: VaultEvent) => void;

/**
 * A note created, edited or renamed in the vault under a name no device syncs
 * because Windows can't keep it (see `windowsRefusal`).
 */
export interface UnsyncableName extends WindowsRefusal {
  /** The file the event was about. */
  path: string;
  /** The synced path it was renamed from: teammates see that one deleted. */
  renamedFrom?: string;
}

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
  /** Test seam — defaults to `window.setTimeout` / `window.clearTimeout`. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Obsidian's config folder (`Vault.configDir`); never synced. Default `.obsidian`. */
  configDir?: string;
  /**
   * Called for a file in an enabled binding that is dropped because Windows
   * can't keep its name — on every such create and edit, and on a rename
   * unless it keeps the name at fault: the listener decides what to repeat.
   * Not for deletes.
   */
  onUnsyncableName?: (event: UnsyncableName) => void;
}

// -- Watcher ------------------------------------------------------------------

export class ObsidianWatcher {
  private readonly handlers = new Set<VaultEventHandler>();
  private readonly modifyDebounceMs: number;
  private readonly setT?: ObsidianWatcherOptions['setTimeout'];
  private readonly clearT?: ObsidianWatcherOptions['clearTimeout'];
  private readonly recentlyApplied: RecentlyApplied;
  private readonly getBindings: () => VaultBinding[];
  private readonly configDir: string;
  private readonly onUnsyncableName: ((event: UnsyncableName) => void) | undefined;

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
    this.configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
    this.onUnsyncableName = options.onUnsyncableName;
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
    this.reportUnsyncable(file.path);
    this.dispatchForBindings(file.path, (bindingId) =>
      this.fan({ type: 'create', bindingId, path: file.path, source: 'obsidian' }),
    );
  }

  private onDelete(file: WatchableFile): void {
    // Obsidian fires a single `delete` for a `TFolder` (never one per child),
    // and chokidar `unlink` events for the children are unreliable under a
    // burst. So instead of dropping folder deletes, forward them with an
    // `isFolder` marker — the engine expands them into per-child deletes
    // against its file index, the only reliable source of the children.
    const folder = !isFile(file);
    if (!folder && this.recentlyApplied.take(file.path)) return;
    this.dispatchForBindings(file.path, (bindingId) =>
      this.fan({
        type: 'delete',
        bindingId,
        path: file.path,
        source: 'obsidian',
        ...(folder ? { isFolder: true } : {}),
      }),
    );
  }

  private onRename(file: WatchableFile, oldPath: string): void {
    if (!isFile(file)) return;
    // Both paths are checked separately — a rename out of a binding becomes
    // a delete at oldPath; a rename into a binding becomes a create at newPath.
    // For the simple in-binding case we emit a single rename.
    //
    // The path markers are Obsidian's share of the budget a plugin write
    // claims for both names; chokidar's `unlink` and `add` take the rest.
    this.recentlyApplied.take(file.path);
    this.recentlyApplied.take(oldPath);
    // A rename the plugin made itself: Obsidian fires this event for every
    // `adapter.rename`, before the call returns. Passed on, it went back to
    // the server as the user's rename — the spare name a case-only rename
    // steps through became the note's name for the whole team, and two names
    // swapped while away renamed each other forever. Only the exact pair the
    // plugin registered; a user's rename of the same file is passed on.
    if (this.recentlyApplied.takeRename(oldPath, file.path)) return;
    // An ignored path counts as "outside the binding", so the usual mapping
    // below does the right thing: moving a note into Obsidian's trash (that
    // is what "Move to Obsidian trash" does — a rename into `.trash/`)
    // becomes a delete, and dragging a note back out becomes a create.
    // Treating it as a rename used to publish the trashed copy to everyone,
    // and after the server started refusing `.trash` it would have queued a
    // NACKed op forever.
    const oldIgnored = isAlwaysIgnored(oldPath, this.configDir);
    const newIgnored = isAlwaysIgnored(file.path, this.configDir);
    // Renaming a note to `Why?.md` is the same delete for the team — the one
    // case of it the user doesn't mean, so it is reported. A rename that
    // keeps the name at fault within a binding changes nothing for anyone:
    // renaming the folder `FAQ` that holds `Question 1?.md` …
    // `Question 40?.md` (Obsidian renames each note in it) or moving
    // `Why?.md` to another folder isn't reported, while renaming `Why?.md` to
    // `Why??.md` is — its author tried to fix it — and so is moving it into
    // another binding's folder, meant for that project's team.
    if (newIgnored) {
      const fromSynced = !oldIgnored && this.inEnabledBinding(oldPath);
      if (fromSynced || !this.keepsRefusedName(oldPath, file.path)) {
        this.reportUnsyncable(file.path, fromSynced ? oldPath : undefined);
      }
    }
    if (oldIgnored && newIgnored) return;
    for (const binding of this.getBindings()) {
      if (!binding.enabled) continue;
      const inOld = isInBinding(oldPath, binding.localFolder) && !oldIgnored;
      const inNew = isInBinding(file.path, binding.localFolder) && !newIgnored;
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
    // A note uploaded under such a name by an older version stops syncing
    // after the update; the first edit is when its author can learn of it.
    this.reportUnsyncable(file.path);
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

  private inEnabledBinding(path: string): boolean {
    return this.getBindings().some((b) => b.enabled && isInBinding(path, b.localFolder));
  }

  /**
   * True when a rename leaves a file in the same enabled binding refused for
   * the same name as before (`FAQ/Question 1?.md` → `FAQ 2026/Question 1?.md`,
   * `U.S./a.md` → `U.S./b.md`). A move into another binding's folder is
   * meant for another project, so it is reported: the note won't get there.
   */
  private keepsRefusedName(oldPath: string, newPath: string): boolean {
    const sameBinding = this.getBindings().some(
      (b) =>
        b.enabled && isInBinding(oldPath, b.localFolder) && isInBinding(newPath, b.localFolder),
    );
    if (!sameBinding) return false;
    const before = windowsRefusal(oldPath, this.configDir);
    const after = windowsRefusal(newPath, this.configDir);
    return (
      before !== null &&
      after !== null &&
      refusedSegment(before.name) === refusedSegment(after.name)
    );
  }

  /** Tell `onUnsyncableName` about a file the Windows rules alone keep from syncing. */
  private reportUnsyncable(path: string, renamedFrom?: string): void {
    if (!this.onUnsyncableName) return;
    const refusal = windowsRefusal(path, this.configDir);
    if (refusal === null || !this.inEnabledBinding(path)) return;
    try {
      this.onUnsyncableName({
        ...refusal,
        path,
        ...(renamedFrom !== undefined ? { renamedFrom } : {}),
      });
    } catch {
      // A listener error must not cost the event itself.
    }
  }

  private dispatchForBindings(path: string, action: (bindingId: string) => void): void {
    if (isAlwaysIgnored(path, this.configDir)) return;
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

/** The name at fault alone — `Why?.md`, `U.S.` — out of a `WindowsRefusal.name`. */
export function refusedSegment(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

function isFile(file: WatchableFile): boolean {
  // Default to "file" — the adapter on top of Obsidian sets `kind: 'folder'`
  // explicitly when it sees a `TFolder`. Treating an unset `kind` as a
  // file means tests that pass `{ path }` without a kind work naturally.
  return file.kind !== 'folder';
}
