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

  async list(folderPath: string): Promise<string[]> {
    // `vault.getFiles()` returns every TFile in the vault as vault-relative
    // paths. Folders are filtered out by virtue of the type. We then narrow
    // down to the binding's `localFolder` — `'/'` means the whole vault.
    const norm = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const all = this.vault.getFiles().map((f) => f.path);
    if (norm === '') return all;
    return all.filter((p) => p === norm || p.startsWith(`${norm}/`));
  }
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
