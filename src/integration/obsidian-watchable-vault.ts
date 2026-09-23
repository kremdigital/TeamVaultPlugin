import { type Vault, TFolder } from 'obsidian';
import type { WatchableFile, WatchableVault } from '@/watcher/obsidian-events';

/**
 * Adapter that lets `ObsidianWatcher` work against the real `app.vault`.
 *
 * Translates Obsidian's `TFile` / `TFolder` instances into the watcher's
 * minimal `WatchableFile` shape and forwards `offref` calls.
 */
export class ObsidianWatchableVault implements WatchableVault {
  constructor(private readonly vault: Vault) {}

  // Single signature — TS overloads have to be implementation-compatible
  // and the underlying `WatchableVault` interface is overloaded by event
  // name, so we widen here and pay one cast at the call site.
  on(
    name: 'create' | 'modify' | 'delete' | 'rename',
    cb: ((file: WatchableFile) => void) | ((file: WatchableFile, oldPath: string) => void),
  ): unknown {
    const vaultOn = (this.vault as unknown as { on: (n: string, h: unknown) => unknown }).on;
    if (name === 'rename') {
      return vaultOn.call(this.vault, name, (file: { path: string } | TFolder, oldPath: string) => {
        cb(toWatchable(file), oldPath);
      });
    }
    return vaultOn.call(this.vault, name, (file: { path: string } | TFolder) => {
      (cb as (f: WatchableFile) => void)(toWatchable(file));
    });
  }

  offref(ref: unknown): void {
    this.vault.offref(ref as never);
  }
}

function toWatchable(file: { path: string } | TFolder): WatchableFile {
  return {
    path: file.path,
    kind: file instanceof TFolder ? 'folder' : 'file',
  };
}
