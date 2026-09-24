import { bindingAddBlock } from '@/settings/folder-utils';
import { parseSettings, settingsToSave, type VaultBinding } from '@/settings/settings';

/**
 * A vault holds one binding. A binding `data.json` has but the plugin could
 * not read is kept in the file and written back on every save, so while one
 * is there it counts: a binding added next to it would become a second one
 * covering the vault as soon as the old one is fixed — two engines syncing
 * every file.
 */

const server = { id: 's1', name: 'Work', url: 'https://sync.example.com', apiKey: 'osk_1' };
const rootBinding = (id: string): Record<string, unknown> => ({
  id,
  serverId: 's1',
  projectId: 'p1',
  projectName: 'Notes',
  localFolder: '/',
  enabled: true,
  lastSyncedAt: 1,
  lastVectorClock: {},
});
const withoutProject = (id: string): Record<string, unknown> => {
  const { projectId: _projectId, ...rest } = rootBinding(id);
  return rest;
};

/** What the settings tab would be told for this `data.json`. */
function blockFor(raw: Record<string, unknown>): ReturnType<typeof bindingAddBlock> {
  const { settings, skipped } = parseSettings(raw);
  return bindingAddBlock(settings.bindings, skipped?.bindings ?? null);
}

describe('bindingAddBlock', () => {
  it('lets the first binding be added to a file read in full', () => {
    expect(blockFor({ servers: [server], bindings: [] })).toBeNull();
    expect(blockFor({ servers: [server] })).toBeNull();
  });

  it('blocks once the vault is bound', () => {
    expect(blockFor({ servers: [server], bindings: [rootBinding('b1')] })).toBe('bound');
  });

  it('blocks while the file has a binding it could not read', () => {
    expect(blockFor({ servers: [server], bindings: [withoutProject('b1')] })).toBe('unreadable');
    expect(blockFor({ servers: [server], bindings: ['oops'] })).toBe('unreadable');
  });

  it('blocks while the binding list is not a list', () => {
    // A hand edit that dropped the brackets: the object is the vault's binding.
    expect(blockFor({ servers: [server], bindings: rootBinding('b1') })).toBe('unreadable');
    expect(blockFor({ servers: [server], bindings: null })).toBe('unreadable');
  });

  it('names the binding the vault has first: removing it is the next step', () => {
    const readable = parseSettings({ bindings: [rootBinding('b1')] }).settings.bindings;
    const skipped = parseSettings({ bindings: [withoutProject('b2')] }).skipped?.bindings ?? null;
    expect(bindingAddBlock(readable, skipped)).toBe('bound');
  });

  it('does not count a server it could not read', () => {
    expect(blockFor({ servers: [server, { id: 's2' }], bindings: [] })).toBeNull();
  });

  it('is what keeps a save from writing two bindings for the vault', () => {
    // The scenario the block exists for: were a new root binding added while
    // the old one is skipped, the save would write both, and fixing the old
    // one by hand would leave two root bindings.
    const { settings, skipped } = parseSettings({
      servers: [server],
      bindings: [withoutProject('old')],
    });
    expect(bindingAddBlock(settings.bindings, skipped?.bindings ?? null)).toBe('unreadable');
    const added: VaultBinding = { ...(rootBinding('new') as unknown as VaultBinding) };
    const saved = settingsToSave({ ...settings, bindings: [added] }, skipped) as {
      bindings: unknown[];
    };
    expect(saved.bindings).toHaveLength(2);
  });
});
