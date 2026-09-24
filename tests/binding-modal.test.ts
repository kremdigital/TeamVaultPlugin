import type { App } from 'obsidian';
import { Notice, Setting } from './__mocks__/obsidian';
import { AddBindingModal } from '@/settings/modals/binding-modal';
import type { BindingAddBlock } from '@/settings/folder-utils';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { t } from '@/i18n';

/**
 * The binding modal's own check, the backstop for a modal opened before the
 * settings tab disabled "Add binding": it asks what blocks a binding at the
 * moment of the click, not when the modal opened.
 */
describe('AddBindingModal — what blocks a binding', () => {
  const servers: ServerConfig[] = [
    { id: 's1', name: 'Work', url: 'https://work.example.com', apiKey: 'osk_1', addedAt: 1 },
    { id: 's2', name: 'Home', url: 'https://home.example.com', apiKey: 'osk_2', addedAt: 1 },
  ];

  beforeEach(() => {
    Setting.buttons = [];
    Notice.shown = [];
  });

  /**
   * Open the modal with a server and a project picked, and click "Bind".
   * Two servers, so the modal loads no projects by itself.
   */
  async function bind(
    block: () => BindingAddBlock | null,
  ): Promise<jest.Mock<Promise<void>, [VaultBinding]>> {
    const onAdd = jest.fn<Promise<void>, [VaultBinding]>(async () => undefined);
    const modal = new AddBindingModal({} as App, servers, block, onAdd);
    modal.open();
    // What picking a server and a project in the dropdowns sets.
    Object.assign(modal, { serverId: 's1', projectId: 'p1' });
    const save = Setting.buttons.find((b) => b.text === t('modal.addBinding.save'));
    if (!save) throw new Error('the modal has not rendered its save button');
    save.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return onAdd;
  }

  it('adds a root binding when nothing blocks it', async () => {
    const onAdd = await bind(() => null);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({
      serverId: 's1',
      projectId: 'p1',
      localFolder: '/',
    });
    expect(Notice.shown).toEqual([]);
  });

  it('refuses while the vault has a binding', async () => {
    const onAdd = await bind(() => 'bound');
    expect(onAdd).not.toHaveBeenCalled();
    expect(Notice.shown.map((n) => n.message)).toEqual([t('modal.addBinding.errors.alreadyBound')]);
  });

  it('refuses while data.json has a binding the plugin could not read', async () => {
    const onAdd = await bind(() => 'unreadable');
    expect(onAdd).not.toHaveBeenCalled();
    expect(Notice.shown.map((n) => n.message)).toEqual([
      t('modal.addBinding.errors.unreadableBinding'),
    ]);
  });

  it('asks at the click, not when the modal opened', async () => {
    let block: BindingAddBlock | null = null;
    const onAdd = jest.fn<Promise<void>, [VaultBinding]>(async () => undefined);
    const modal = new AddBindingModal({} as App, servers, () => block, onAdd);
    modal.open();
    Object.assign(modal, { serverId: 's1', projectId: 'p1' });
    block = 'unreadable';
    Setting.buttons.find((b) => b.text === t('modal.addBinding.save'))?.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
