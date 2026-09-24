import {
  absoluteToVault,
  checkVaultPath,
  isAlwaysIgnored,
  isIgnoredAbsolutePath,
  isInBinding,
  isOrphanedAtomicTmp,
  normalizeSeparators,
} from '@/watcher/path-utils';

describe('isInBinding', () => {
  it('matches everything for root binding', () => {
    expect(isInBinding('any/path.md', '/')).toBe(true);
    expect(isInBinding('', '/')).toBe(true);
  });

  it('matches the folder itself and direct children', () => {
    expect(isInBinding('notes', 'notes')).toBe(true);
    expect(isInBinding('notes/file.md', 'notes')).toBe(true);
    expect(isInBinding('notes/sub/deep.md', 'notes')).toBe(true);
  });

  it('does not match prefix-similar siblings', () => {
    expect(isInBinding('notes-other.md', 'notes')).toBe(false);
    expect(isInBinding('notesfoo', 'notes')).toBe(false);
  });

  it('handles user input with leading/trailing slashes', () => {
    expect(isInBinding('notes/file.md', '/notes/')).toBe(true);
  });
});

describe('absoluteToVault', () => {
  it('returns vault-relative path with forward slashes', () => {
    const vault = 'D:\\Vaults\\Mine';
    expect(absoluteToVault('D:\\Vaults\\Mine\\note.md', vault)).toBe('note.md');
    expect(absoluteToVault('D:\\Vaults\\Mine\\sub\\note.md', vault)).toBe('sub/note.md');
  });

  it('returns empty string when path matches the vault root', () => {
    expect(absoluteToVault('/vault', '/vault')).toBe('');
  });

  it('returns null for paths outside the vault', () => {
    expect(absoluteToVault('/other/file.md', '/vault')).toBeNull();
    expect(absoluteToVault('/vaultfoo/file.md', '/vault')).toBeNull();
  });

  it('handles trailing slash on the vault path', () => {
    expect(absoluteToVault('/vault/note.md', '/vault/')).toBe('note.md');
  });
});

describe('normalizeSeparators', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(normalizeSeparators('a\\b\\c')).toBe('a/b/c');
  });
});

describe('isAlwaysIgnored', () => {
  it('drops empty and well-known dirs', () => {
    expect(isAlwaysIgnored('')).toBe(true);
    expect(isAlwaysIgnored('.obsidian')).toBe(true);
    expect(isAlwaysIgnored('.obsidian/plugins/x')).toBe(true);
    expect(isAlwaysIgnored('a/.git/HEAD')).toBe(true);
    expect(isAlwaysIgnored('.versions/file.md')).toBe(true);
  });

  it('drops common temp suffixes', () => {
    expect(isAlwaysIgnored('foo.tmp')).toBe(true);
    expect(isAlwaysIgnored('foo~')).toBe(true);
  });

  it('keeps real markdown content', () => {
    expect(isAlwaysIgnored('notes/work/idea.md')).toBe(false);
  });

  it('drops Obsidian atomic-write artifacts (<name>.tmp.<pid>.<hex>)', () => {
    expect(isAlwaysIgnored('DATA/wiki/index.md.tmp.14424.02a1a4a4e56e')).toBe(true);
    expect(isAlwaysIgnored('log.md.tmp.1.ff')).toBe(true);
  });

  it('keeps notes that merely contain "tmp" in the name', () => {
    expect(isAlwaysIgnored('notes/tmp-ideas.md')).toBe(false);
    expect(isAlwaysIgnored('notes/data.tmp.md')).toBe(false);
  });
});

describe('isOrphanedAtomicTmp', () => {
  it('matches artifacts from a different (dead) process', () => {
    expect(isOrphanedAtomicTmp('wiki/index.md.tmp.14424.02a1a4a4e56e', 999)).toBe(true);
  });

  it('skips artifacts of the current process — write may be in flight', () => {
    expect(isOrphanedAtomicTmp('wiki/index.md.tmp.14424.02a1a4a4e56e', 14424)).toBe(false);
  });

  it('never matches regular files', () => {
    expect(isOrphanedAtomicTmp('wiki/index.md', 999)).toBe(false);
    expect(isOrphanedAtomicTmp('notes/data.tmp.md', 999)).toBe(false);
  });
});

/**
 * The gate added in 0.3.3 after the 2026-09-19 pre-flight audit. Three
 * holes: the config folder was hard-coded as `.obsidian` (a custom
 * `Vault.configDir` synced the whole folder, API key included), segment
 * matching was case-sensitive (`.OBSIDIAN/` walked straight through), and
 * `.trash` was missing (a note deleted into the trash came back as a create).
 */
describe('ignored folders — config dir, trash, case, unicode', () => {
  it('drops the default config folder and Obsidian trash', () => {
    expect(isAlwaysIgnored('.obsidian/plugins/team-vault/data.json')).toBe(true);
    expect(isAlwaysIgnored('.trash/deleted.md')).toBe(true);
  });

  it('drops the folders the server reserves for itself', () => {
    // The server refuses these by its own list (`RESERVED_STORAGE_NAMES`), so
    // uploading such a path would retry for ever.
    expect(isAlwaysIgnored('.versions/f1/1.md')).toBe(true);
    expect(isAlwaysIgnored('.staging/abc123')).toBe(true);
  });

  it('matches folder names regardless of case', () => {
    expect(isAlwaysIgnored('.OBSIDIAN/plugins/team-vault/data.json')).toBe(true);
    expect(isAlwaysIgnored('.Obsidian/workspace.json')).toBe(true);
    expect(isAlwaysIgnored('.Trash/note.md')).toBe(true);
  });

  it('drops a custom config folder passed by the caller', () => {
    expect(isAlwaysIgnored('.config-obs/plugins/team-vault/data.json', '.config-obs')).toBe(true);
    expect(isAlwaysIgnored('notes/ok.md', '.config-obs')).toBe(false);
  });

  it('still drops a literal .obsidian when the config folder is elsewhere', () => {
    // In that vault `.obsidian` belongs to another Obsidian setup — never ours to sync.
    expect(isAlwaysIgnored('.obsidian/app.json', '.config-obs')).toBe(true);
  });

  it('drops a multi-segment config folder as a prefix', () => {
    // Obsidian's own `Vault.configDir` is always a single dotted segment, so
    // this covers an arbitrary value coming from settings rather than a real
    // Obsidian layout. The name is NOT in the always-ignored list, otherwise
    // the test would pass without the prefix branch at all.
    expect(isAlwaysIgnored('work/cfg/app.json', 'work/cfg')).toBe(true);
    expect(isAlwaysIgnored('other/cfg/app.json', 'work/cfg')).toBe(false);
    expect(isAlwaysIgnored('work/notes.md', 'work/cfg')).toBe(false);
  });

  it('matches the config folder at the vault root only, not as a nested name', () => {
    // `.obsidian-work` is the config folder at the root; a folder of the same
    // name inside the notes (a downloaded vault, a backup of someone's config)
    // is ordinary content.
    expect(isAlwaysIgnored('.obsidian-work/app.json', '.obsidian-work')).toBe(true);
    expect(isAlwaysIgnored('Архив/.obsidian-work/app.json', '.obsidian-work')).toBe(false);
  });

  it('matches a non-ASCII config folder in either unicode normalization', () => {
    // macOS hands out NFD, the server stores NFC — on APFS both open the same
    // folder. `ё` decomposes into `е` + U+0308, so the two forms really do
    // differ; a name without decomposable letters would make this test empty.
    const dir = '.ёжик';
    expect(dir.normalize('NFC')).not.toBe(dir.normalize('NFD'));
    const path = `${dir}/plugins/team-vault/data.json`;
    expect(isAlwaysIgnored(path.normalize('NFC'), dir.normalize('NFD'))).toBe(true);
    expect(isAlwaysIgnored(path.normalize('NFD'), dir.normalize('NFC'))).toBe(true);
  });

  it('keeps notes whose name merely starts like a config folder', () => {
    expect(isAlwaysIgnored('.obsidian-notes/idea.md')).toBe(false);
    expect(isAlwaysIgnored('notes/.trashed-ideas.md')).toBe(false);
  });
});

/**
 * Since 0.3.4 a binding always covers the whole vault, so the service files
 * other tools leave in the vault root (and in every folder) went to the
 * project: the filter only knew the config folder, `.git`, `.trash`, the
 * server's folders and temporary files.
 */
describe('service files of the OS and other sync tools', () => {
  it.each([
    // macOS
    '.DS_Store',
    'notes/.DS_Store',
    '.Spotlight-V100/Store-V2/index',
    '.fseventsd/fseventsd-uuid',
    '.Trashes/501/deleted.md',
    '.TemporaryItems/folders.501/x',
    '.DocumentRevisions-V100/db-V1/db.sqlite',
    'notes/Icon\r',
    'notes/._idea.md',
    '._.DS_Store',
    'notes/.idea.md.icloud',
    // Windows
    'desktop.ini',
    'Проекты/desktop.ini',
    'Thumbs.db',
    'images/Thumbs.db',
    '$RECYCLE.BIN/S-1-5-21/$R1.md',
    'System Volume Information/tracking.log',
    // Linux
    'notes/.directory',
    '.Trash-1000/files/deleted.md',
    // Syncthing
    '.stfolder',
    '.stfolder/syncthing-folder-0a1b2c.txt',
    '.stversions/notes/idea~20260922-101500.md',
    '.stignore',
    'notes/.syncthing.idea.md.tmp',
    'notes/~syncthing~idea.md.tmp',
    // Resilio Sync
    '.sync/ID',
    '.sync/Archive/idea.md',
    'notes/idea.md.!sync',
    // Dropbox
    '.dropbox',
    '.dropbox.cache/2026-09-22/idea.md',
    // Google Drive
    '.tmp.drivedownload/12345',
    '.tmp.driveupload/67890',
  ])('ignores %j', (path) => {
    expect(isAlwaysIgnored(path)).toBe(true);
    expect(checkVaultPath(path, { bindingFolder: '/' })).toBe('ignored');
  });

  it('matches regardless of case', () => {
    // Windows and macOS file systems don't care — and neither may the gate:
    // a server-supplied `DESKTOP.INI` would still overwrite Explorer's file.
    expect(isAlwaysIgnored('.ds_store')).toBe(true);
    expect(isAlwaysIgnored('notes/DESKTOP.INI')).toBe(true);
    expect(isAlwaysIgnored('thumbs.db')).toBe(true);
    expect(isAlwaysIgnored('.STFOLDER/marker')).toBe(true);
    expect(isAlwaysIgnored('$Recycle.Bin/x.md')).toBe(true);
    expect(isAlwaysIgnored('notes/IDEA.MD.!SYNC')).toBe(true);
    expect(isAlwaysIgnored('notes/.Idea.md.iCloud')).toBe(true);
  });

  it('keeps notes whose names merely resemble a service file', () => {
    expect(isAlwaysIgnored('notes/DS_Store.md')).toBe(false);
    expect(isAlwaysIgnored('notes/desktop.ini.md')).toBe(false);
    expect(isAlwaysIgnored('notes/my-desktop.ini')).toBe(false);
    expect(isAlwaysIgnored('Thumbs.db.md')).toBe(false);
    expect(isAlwaysIgnored('notes/Icon.png')).toBe(false);
    expect(isAlwaysIgnored('Icon/readme.md')).toBe(false);
    expect(isAlwaysIgnored('sync/log.md')).toBe(false);
    expect(isAlwaysIgnored('notes/stfolder.md')).toBe(false);
    expect(isAlwaysIgnored('notes/idea.icloud')).toBe(false);
    expect(isAlwaysIgnored('notes/a_b.md')).toBe(false);
    expect(isAlwaysIgnored('notes/Trash-1000.md')).toBe(false);
    expect(isAlwaysIgnored('notes/.Trash-old/x.md')).toBe(false);
    expect(isAlwaysIgnored('notes/sync.md')).toBe(false);
    expect(checkVaultPath('notes/sync.md', { bindingFolder: '/' })).toBeNull();
  });

  it('filters them out of chokidar at the vault root and below', () => {
    expect(isIgnoredAbsolutePath('D:\\vault\\desktop.ini', 'D:\\vault')).toBe(true);
    expect(isIgnoredAbsolutePath('/Users/u/vault/notes/.DS_Store', '/Users/u/vault')).toBe(true);
    expect(isIgnoredAbsolutePath('/home/u/vault/.stversions', '/home/u/vault')).toBe(true);
  });

  it('does not look at folders above the vault root', () => {
    // A vault kept inside a Syncthing folder's versions, or in a Dropbox cache
    // being restored from: the folder names above the root are not ours to judge.
    expect(
      isIgnoredAbsolutePath('/home/u/.stversions/vault/idea.md', '/home/u/.stversions/vault'),
    ).toBe(false);
    expect(isIgnoredAbsolutePath('D:/.sync/vault/idea.md', 'D:/.sync/vault')).toBe(false);
  });
});

describe('checkVaultPath', () => {
  it('allows a normal note inside the binding', () => {
    expect(checkVaultPath('notes/idea.md', { bindingFolder: 'notes' })).toBeNull();
    expect(checkVaultPath('any/where.md', { bindingFolder: '/' })).toBeNull();
  });

  it('refuses an empty path', () => {
    expect(checkVaultPath('', { bindingFolder: '/' })).toBe('empty');
    expect(checkVaultPath('   ', { bindingFolder: '/' })).toBe('empty');
  });

  it('refuses absolute paths — they would resolve outside the vault', () => {
    expect(checkVaultPath('/etc/passwd', { bindingFolder: '/' })).toBe('absolute');
    expect(checkVaultPath('C:/Windows/system.ini', { bindingFolder: '/' })).toBe('absolute');
    expect(checkVaultPath('C:\\Windows\\system.ini', { bindingFolder: '/' })).toBe('absolute');
  });

  it('refuses traversal and empty segments', () => {
    expect(checkVaultPath('notes/../.obsidian/data.json', { bindingFolder: '/' })).toBe(
      'traversal',
    );
    expect(checkVaultPath('notes\\..\\.obsidian\\data.json', { bindingFolder: '/' })).toBe(
      'traversal',
    );
    expect(checkVaultPath('a//b.md', { bindingFolder: '/' })).toBe('traversal');
    expect(checkVaultPath('./a.md', { bindingFolder: '/' })).toBe('traversal');
  });

  it('refuses the config folder even for a root binding', () => {
    expect(checkVaultPath('.obsidian/plugins/team-vault/data.json', { bindingFolder: '/' })).toBe(
      'ignored',
    );
    expect(checkVaultPath('.OBSIDIAN/plugins/team-vault/data.json', { bindingFolder: '/' })).toBe(
      'ignored',
    );
    expect(
      checkVaultPath('.config-obs/plugins/team-vault/data.json', {
        bindingFolder: '/',
        configDir: '.config-obs',
      }),
    ).toBe('ignored');
  });

  it('refuses Obsidian trash', () => {
    expect(checkVaultPath('.trash/deleted.md', { bindingFolder: '/' })).toBe('ignored');
  });

  it('refuses paths outside the binding folder', () => {
    expect(checkVaultPath('other/secret.md', { bindingFolder: 'notes' })).toBe('outside-binding');
    expect(checkVaultPath('notes-other/secret.md', { bindingFolder: 'notes' })).toBe(
      'outside-binding',
    );
  });

  it('skips the binding check when no folder is given', () => {
    expect(checkVaultPath('anywhere/file.md')).toBeNull();
  });
});

describe('isIgnoredAbsolutePath', () => {
  it('matches config folder and trash inside the vault', () => {
    expect(isIgnoredAbsolutePath('D:/vault/.obsidian/plugins/x/data.json', 'D:/vault')).toBe(true);
    expect(isIgnoredAbsolutePath('D:\\vault\\.obsidian\\workspace.json', 'D:\\vault')).toBe(true);
    expect(isIgnoredAbsolutePath('/home/u/vault/.trash/note.md', '/home/u/vault')).toBe(true);
    expect(isIgnoredAbsolutePath('/home/u/vault/.OBSIDIAN/app.json', '/home/u/vault')).toBe(true);
  });

  it('matches a custom config folder', () => {
    expect(isIgnoredAbsolutePath('/vault/.config-obs/app.json', '/vault', '.config-obs')).toBe(
      true,
    );
  });

  it('ignores folder names ABOVE the vault root', () => {
    // A vault stored inside someone's repository, or under a folder named
    // `.trash`: matching the whole OS path would filter out every file in it.
    expect(isIgnoredAbsolutePath('/home/u/.git/vault/notes/idea.md', '/home/u/.git/vault')).toBe(
      false,
    );
    expect(isIgnoredAbsolutePath('D:/.trash/vault/note.md', 'D:/.trash/vault')).toBe(false);
  });

  it('keeps regular files and the vault root itself', () => {
    expect(isIgnoredAbsolutePath('/home/u/vault/notes/idea.md', '/home/u/vault')).toBe(false);
    expect(isIgnoredAbsolutePath('/home/u/vault', '/home/u/vault')).toBe(false);
  });
});
