import type { Vault } from 'obsidian';
import type { LogStorage } from '@/utils/file-log-sink';

/**
 * Concrete `LogStorage` over `app.vault.adapter`. The file sink uses
 * vault-relative paths under `.obsidian/plugins/obsidian-team/`, so we
 * never escape the vault sandbox.
 */
export class ObsidianLogStorage implements LogStorage {
  constructor(private readonly vault: Vault) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.adapter.exists(path);
  }

  async stat(path: string): Promise<{ size: number } | null> {
    const s = await this.vault.adapter.stat(path);
    if (!s) return null;
    return { size: s.size };
  }

  async append(path: string, data: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.append(path, data);
    } else {
      await this.vault.adapter.write(path, data);
    }
  }

  async write(path: string, data: string): Promise<void> {
    await this.vault.adapter.write(path, data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.vault.adapter.rename(oldPath, newPath);
  }

  async remove(path: string): Promise<void> {
    await this.vault.adapter.remove(path);
  }

  async read(path: string): Promise<string> {
    return this.vault.adapter.read(path);
  }

  /** Create every parent folder of `path` if missing. */
  async mkdir(path: string): Promise<void> {
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return;
    const dir = path.slice(0, idx);
    const segments = dir.split('/').filter(Boolean);
    let current = '';
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      if (!(await this.vault.adapter.exists(current))) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }
}
