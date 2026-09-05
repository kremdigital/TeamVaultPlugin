import { findDuplicatePluginFolders, type PluginFolderReader } from '@/integration/plugin-folders';

/** Fake `DataAdapter` slice: a folder → manifest-contents map. */
function makeReader(manifests: Record<string, string | null>): PluginFolderReader {
  return {
    list: (path) => {
      if (path !== '.obsidian/plugins') return Promise.reject(new Error('ENOENT'));
      return Promise.resolve({ folders: Object.keys(manifests) });
    },
    read: (path) => {
      const folder = path.replace(/\/manifest\.json$/, '');
      const raw = manifests[folder];
      if (raw === undefined || raw === null) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(raw);
    },
  };
}

const manifest = (id: string): string => JSON.stringify({ id, name: id, version: '1.0.0' });

const OPTS = {
  configDir: '.obsidian',
  pluginId: 'team-vault',
  ownDir: '.obsidian/plugins/team-vault',
};

describe('findDuplicatePluginFolders', () => {
  it('finds a second folder declaring our id', async () => {
    // The 2026-09-04 shape: a pre-upgrade backup kept next to the real thing.
    const reader = makeReader({
      '.obsidian/plugins/team-vault': manifest('team-vault'),
      '.obsidian/plugins/team-vault-backup-0.2.9': manifest('team-vault'),
      '.obsidian/plugins/dataview': manifest('dataview'),
    });

    await expect(findDuplicatePluginFolders(reader, OPTS)).resolves.toEqual([
      '.obsidian/plugins/team-vault-backup-0.2.9',
    ]);
  });

  it('reports nothing for a healthy install', async () => {
    const reader = makeReader({
      '.obsidian/plugins/team-vault': manifest('team-vault'),
      '.obsidian/plugins/dataview': manifest('dataview'),
    });

    await expect(findDuplicatePluginFolders(reader, OPTS)).resolves.toEqual([]);
  });

  it('never reports the loaded folder itself, whatever it is named', async () => {
    // Obsidian may well have loaded the copy, not the canonically-named
    // folder — the duplicate is then the *other* one.
    const reader = makeReader({
      '.obsidian/plugins/team-vault': manifest('team-vault'),
      '.obsidian/plugins/team-vault-backup-0.2.9': manifest('team-vault'),
    });

    await expect(
      findDuplicatePluginFolders(reader, {
        ...OPTS,
        ownDir: '.obsidian/plugins/team-vault-backup-0.2.9',
      }),
    ).resolves.toEqual(['.obsidian/plugins/team-vault']);
  });

  it('compares paths regardless of separators and trailing slashes', async () => {
    const reader = makeReader({
      '.obsidian\\plugins\\team-vault\\': manifest('team-vault'),
    });

    await expect(findDuplicatePluginFolders(reader, OPTS)).resolves.toEqual([]);
  });

  it('skips folders without a manifest, and malformed ones', async () => {
    const reader = makeReader({
      '.obsidian/plugins/team-vault': manifest('team-vault'),
      '.obsidian/plugins/no-manifest': null,
      '.obsidian/plugins/broken': '{ not json',
      '.obsidian/plugins/idless': JSON.stringify({ name: 'anon' }),
    });

    await expect(findDuplicatePluginFolders(reader, OPTS)).resolves.toEqual([]);
  });

  it('returns empty when the plugins folder cannot be listed', async () => {
    const reader: PluginFolderReader = {
      list: () => Promise.reject(new Error('EACCES')),
      read: () => Promise.reject(new Error('unreachable')),
    };

    await expect(findDuplicatePluginFolders(reader, OPTS)).resolves.toEqual([]);
  });

  it('without a known own dir, flags only a genuine collision', async () => {
    // `manifest.dir` missing: one claimant is normal (it is us), two is not.
    const single = makeReader({ '.obsidian/plugins/team-vault': manifest('team-vault') });
    await expect(
      findDuplicatePluginFolders(single, { configDir: '.obsidian', pluginId: 'team-vault' }),
    ).resolves.toEqual([]);

    const double = makeReader({
      '.obsidian/plugins/team-vault': manifest('team-vault'),
      '.obsidian/plugins/team-vault-copy': manifest('team-vault'),
    });
    await expect(
      findDuplicatePluginFolders(double, { configDir: '.obsidian', pluginId: 'team-vault' }),
    ).resolves.toEqual(['.obsidian/plugins/team-vault', '.obsidian/plugins/team-vault-copy']);
  });
});
