/**
 * `ObsidianVaultAdapter.removeEmptyFolders` on a real disk: a folder a
 * teammate deleted or renamed goes from this disk only if nothing but empty
 * folders is left under it (`sync-protocol.md`, «Папки»). Obsidian's own
 * `rmdir(path, false)` refuses any folder (`fs.rm` without `recursive`,
 * 1.13.7), and a recursive one would take a file that landed in the folder
 * since it was looked at: the adapter removes each folder with `fs.rmdir`,
 * which the disk refuses for a folder that is not empty.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from 'obsidian';
import { ObsidianVaultAdapter } from '@/integration/obsidian-vault-adapter';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-vault-folders-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function adapter(): ObsidianVaultAdapter {
  const vault = { adapter: { getBasePath: () => base } } as unknown as Vault;
  return new ObsidianVaultAdapter(vault);
}

function folder(path: string): void {
  mkdirSync(join(base, ...path.split('/')), { recursive: true });
}

function file(path: string): void {
  writeFileSync(join(base, ...path.split('/')), '');
}

function there(path: string): boolean {
  return existsSync(join(base, ...path.split('/')));
}

describe('ObsidianVaultAdapter — removeEmptyFolders', () => {
  it('removes a folder and the empty folders under it, deepest first', async () => {
    folder('dir/a/deep');
    folder('dir/b');
    folder('keep');

    const removed = await adapter().removeEmptyFolders('dir');

    expect([...removed].sort()).toEqual(['dir', 'dir/a', 'dir/a/deep', 'dir/b']);
    expect(removed.at(-1)).toBe('dir');
    expect(removed.indexOf('dir/a/deep')).toBeLessThan(removed.indexOf('dir/a'));
    expect(there('dir')).toBe(false);
    expect(there('keep')).toBe(true);
  });

  it('keeps the whole folder when a file is anywhere under it — one Obsidian does not list too', async () => {
    folder('dir/a');
    folder('dir/b/deep');
    file('dir/b/deep/.gitkeep');

    expect(await adapter().removeEmptyFolders('dir')).toEqual([]);

    expect(there('dir/a')).toBe(true);
    expect(there('dir/b/deep/.gitkeep')).toBe(true);
  });

  it('stops where it is told to, and keeps the rest', async () => {
    folder('dir/sub');
    const asked: string[] = [];

    const removed = await adapter().removeEmptyFolders('dir', (path) => {
      asked.push(path);
      return path !== 'dir';
    });

    expect(removed).toEqual(['dir/sub']);
    expect(asked).toEqual(['dir/sub', 'dir']);
    expect(there('dir')).toBe(true);
    expect(there('dir/sub')).toBe(false);
  });

  it('does not follow a link: neither one under the folder, nor the folder itself', async () => {
    folder('target');
    folder('dir');
    symlinkSync(join(base, 'target'), join(base, 'dir', 'link'), 'junction');
    symlinkSync(join(base, 'target'), join(base, 'linked'), 'junction');

    expect(await adapter().removeEmptyFolders('dir')).toEqual([]);
    expect(await adapter().removeEmptyFolders('linked')).toEqual([]);

    expect(there('dir')).toBe(true);
    expect(there('linked')).toBe(true);
    expect(there('target')).toBe(true);
  });

  it('removes nothing that is not there, not a folder, or the vault itself', async () => {
    file('note.md');

    expect(await adapter().removeEmptyFolders('missing')).toEqual([]);
    expect(await adapter().removeEmptyFolders('note.md')).toEqual([]);
    expect(await adapter().removeEmptyFolders('')).toEqual([]);
    expect(await adapter().removeEmptyFolders('/')).toEqual([]);

    expect(there('note.md')).toBe(true);
    expect(existsSync(base)).toBe(true);
  });
});
