import { lstat, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Vault } from 'obsidian';
import type { VaultAdapter } from '@/sync/vault-adapter';

/**
 * Concrete `VaultAdapter` over `app.vault`. Lives in `src/integration/`
 * because it depends on the Obsidian runtime — the plain
 * `VaultAdapter` interface stays free of obsidian imports for the
 * benefit of unit tests.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  getBasePath(): string {
    // `getBasePath` is a desktop-only method on `FileSystemAdapter`. The
    // plugin manifest declares `isDesktopOnly: true`, so this is safe at
    // runtime. The cast lets us avoid pulling the desktop-specific type
    // into the public interface.
    return (this.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? '';
  }

  async exists(vaultPath: string): Promise<boolean> {
    return this.vault.adapter.exists(vaultPath);
  }

  async readText(vaultPath: string): Promise<string> {
    return this.vault.adapter.read(vaultPath);
  }

  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    return this.vault.adapter.readBinary(vaultPath);
  }

  async createText(vaultPath: string, content: string): Promise<void> {
    await this.ensureParentFolder(vaultPath);
    await this.vault.adapter.write(vaultPath, content);
  }

  async writeText(vaultPath: string, content: string): Promise<void> {
    await this.vault.adapter.write(vaultPath, content);
  }

  async createBinary(vaultPath: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentFolder(vaultPath);
    await this.vault.adapter.writeBinary(vaultPath, content);
  }

  async writeBinary(vaultPath: string, content: ArrayBuffer): Promise<void> {
    await this.vault.adapter.writeBinary(vaultPath, content);
  }

  async delete(vaultPath: string): Promise<void> {
    await this.vault.adapter.remove(vaultPath);
  }

  async rename(oldVaultPath: string, newVaultPath: string): Promise<void> {
    await this.ensureParentFolder(newVaultPath);
    await this.vault.adapter.rename(oldVaultPath, newVaultPath);
  }

  async ensureParentFolder(vaultPath: string): Promise<void> {
    const idx = vaultPath.lastIndexOf('/');
    if (idx <= 0) return;
    const dir = vaultPath.slice(0, idx);
    await ensureDir(this.vault, dir);
  }

  isCaseInsensitive(): boolean {
    // `FileSystemAdapter.insensitive`: set from the platform, then tested on
    // the vault's own disk when the adapter is built (it writes
    // `.OBSIDIANTEST` and looks for `.obsidiantest`). Not in the typings.
    return (this.vault.adapter as unknown as { insensitive?: unknown }).insensitive === true;
  }

  async list(folderPath: string): Promise<string[]> {
    // `vault.getFiles()` returns every TFile in the vault as vault-relative
    // paths. Folders are filtered out by virtue of the type. We then narrow
    // down to the binding's `localFolder` — `'/'` means the whole vault.
    const norm = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const all = this.vault.getFiles().map((f) => f.path);
    if (norm === '') return all;
    return all.filter((p) => p === norm || p.startsWith(`${norm}/`));
  }

  async removeEmptyFolders(
    vaultPath: string,
    mayGo?: (folder: string) => boolean,
  ): Promise<string[]> {
    // On the disk itself, not through `adapter`. Obsidian's `rmdir(path,
    // false)` is `fs.rm` without `recursive`, which refuses any folder
    // (`ERR_FS_EISDIR`, 1.13.7), and a recursive one would take whatever
    // landed in the folder since it was looked at. `fs.rmdir` removes a folder
    // only if it is empty — the disk's own check, at the moment of removal.
    // Obsidian's watcher then reports each folder gone as a `delete`, a
    // moment later (see `SyncEngine.pruneVanishedFolder`).
    const base = this.getBasePath();
    const top = vaultPath.replace(/^\/+/, '').replace(/\/+$/, '');
    if (base === '' || top === '') return [];
    const folders: string[] = [];
    try {
      // A link or a junction is not followed: what it points at is not ours.
      if (!(await lstat(onDisk(base, top))).isDirectory()) return [];
      if (!(await onlyEmptyFolders(base, top, folders))) return [];
    } catch {
      // Not there, or not readable: nothing to remove.
      return [];
    }
    const removed: string[] = [];
    for (const folder of folders) {
      if (mayGo !== undefined && !mayGo(folder)) break;
      try {
        await rmdir(onDisk(base, folder));
      } catch {
        // Not empty any more (`ENOTEMPTY`), held by another program, gone:
        // the folders above it hold it, or went with it.
        break;
      }
      removed.push(folder);
    }
    return removed;
  }
}

/** The absolute path of vault path `path` under the vault's folder `base`. */
function onDisk(base: string, path: string): string {
  return join(base, ...path.split('/'));
}

/**
 * Whether the folder `path` holds nothing but folders that hold nothing but
 * folders, all the way down: those folders, `path` last, are added to `out`
 * deepest first. Throws when a folder cannot be read.
 */
async function onlyEmptyFolders(base: string, path: string, out: string[]): Promise<boolean> {
  const entries = await readdir(onDisk(base, path), { withFileTypes: true });
  for (const entry of entries) {
    // A file — one Obsidian does not list (`.DS_Store`, `.gitkeep`) too — a
    // link, anything else: the folder stays as it is.
    if (!entry.isDirectory()) return false;
    if (!(await onlyEmptyFolders(base, `${path}/${entry.name}`, out))) return false;
  }
  out.push(path);
  return true;
}

/** Recursively create every missing segment of a vault-relative folder. */
async function ensureDir(vault: Vault, dir: string): Promise<void> {
  if (!dir) return;
  const segments = dir.split('/').filter(Boolean);
  let current = '';
  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg;
    if (!(await vault.adapter.exists(current))) {
      await vault.adapter.mkdir(current);
    }
  }
}
