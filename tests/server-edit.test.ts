import type { App } from 'obsidian';
import { type ButtonComponent, type InputComponent, Notice, Setting } from './__mocks__/obsidian';
import { SyncSettingsTab } from '@/settings/tab';
import { ApiClient, ApiError, type ApiProject, type ApiUser } from '@/client/api';
import type ObsidianSyncPlugin from '@/main';
import {
  defaultSettings,
  type PluginSettings,
  type ServerConfig,
  type VaultBinding,
} from '@/settings/settings';
import { t } from '@/i18n';

/**
 * Editing a server in the settings tab. On 2026-09-27 the team's
 * server moved to a new address, and the tab could only test or remove a
 * server: removing it switched its bindings off, and a binding made again
 * starts from scratch. Editing keeps the server's id, so the bindings stay on
 * it; the engine manager then moves them to the new address
 * (`engine-manager.test.ts`, "server address or key changed").
 */

const OLD_KEY = 'osk_old_secret';

function makeServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 's1',
    name: 'Work',
    url: 'https://old.example.com',
    apiKey: OLD_KEY,
    addedAt: 1234,
    ...over,
  };
}

function makeBinding(over: Partial<VaultBinding> = {}): VaultBinding {
  return {
    id: 'b1',
    serverId: 's1',
    projectId: 'p1',
    projectName: 'Team notes',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 5,
    lastVectorClock: { device: 3 },
    ...over,
  };
}

/** `saves` is its `saveSettings`, as a mock to look at. */
type FakePlugin = ObsidianSyncPlugin & { saves: jest.Mock<Promise<void>, []> };

/** Just what the settings tab reaches on the plugin. */
function fakePlugin(settings: PluginSettings): FakePlugin {
  const saves = jest.fn(async () => undefined);
  return {
    settings,
    saveSettings: saves,
    saves,
    bindingAddBlock: () => null,
    readLogFile: async () => '',
    clearLogFile: async () => undefined,
  } as unknown as FakePlugin;
}

/** Let every already-queued promise reaction run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The server modal as the tab opened it: its fields and buttons. */
interface OpenedModal {
  settings: Setting[];
  field: (label: string) => InputComponent;
  button: (text: string) => ButtonComponent;
}

function opened(settings: Setting[]): OpenedModal {
  return {
    settings,
    field: (label) => {
      const input = settings.find((s) => s.name === label)?.settingInputs[0];
      if (!input) throw new Error(`the modal has no field "${label}"`);
      return input;
    },
    button: (text) => {
      for (const setting of settings) {
        const button = setting.settingButtons.find((b) => b.text === text);
        if (button) return button;
      }
      throw new Error(`the modal has no button "${text}"`);
    },
  };
}

/** Render the tab and click a button on the setting named `row`. */
function clickInTab(plugin: FakePlugin, row: string | null, text: string): OpenedModal {
  Setting.all = [];
  Setting.buttons = [];
  new SyncSettingsTab({} as App, plugin).display();
  const setting = Setting.all.find(
    (s) => (row === null || s.name === row) && s.settingButtons.some((b) => b.text === text),
  );
  const button = setting?.settingButtons.find((b) => b.text === text);
  if (!button) throw new Error(`the settings tab has no "${text}" button on "${row}"`);
  const before = Setting.all.length;
  button.click();
  return opened(Setting.all.slice(before));
}

function openEdit(plugin: FakePlugin, serverName = 'Work'): OpenedModal {
  return clickInTab(plugin, serverName, t('settings.servers.edit'));
}

const NAME = (): string => t('modal.addServer.name.label');
const URL_LABEL = (): string => t('modal.addServer.url.label');
const KEY = (): string => t('modal.addServer.apiKey.label');
const TEST = (): string => t('modal.addServer.test');
const SAVE = (): string => t('modal.addServer.save');
const CANCEL = (): string => t('modal.addServer.cancel');

/** What each `getMe()` was sent with. */
let tested: Array<{ url: string; apiKey: string }> = [];
let getMe: jest.SpyInstance;
let getProjects: jest.SpyInstance;

function connectionOf(client: ApiClient): { url: string; apiKey: string } {
  const own = client as unknown as { baseUrl: string; apiKey: string };
  return { url: own.baseUrl, apiKey: own.apiKey };
}

beforeEach(() => {
  Notice.shown = [];
  tested = [];
  getMe = jest.spyOn(ApiClient.prototype, 'getMe').mockImplementation(async function (
    this: ApiClient,
  ): Promise<ApiUser> {
    tested.push(connectionOf(this));
    return { id: 'u1', email: 'me@example.com', name: null };
  });
  getProjects = jest
    .spyOn(ApiClient.prototype, 'getProjects')
    .mockImplementation(async (): Promise<ApiProject[]> => [project('p1')]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function project(id: string): ApiProject {
  return { id, slug: id, name: id, description: null, iconEmoji: null };
}

function settingsWith(servers: ServerConfig[], bindings: VaultBinding[]): PluginSettings {
  return { ...defaultSettings(), servers, bindings, clientId: 'client-1' };
}

describe('settings tab — editing a server', () => {
  it('has an Edit button on each server, between Test and Remove', () => {
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    Setting.all = [];
    new SyncSettingsTab({} as App, plugin).display();
    const row = Setting.all.find((s) => s.name === 'Work');
    expect(row?.settingButtons.map((b) => b.text)).toEqual([
      t('settings.servers.test'),
      t('settings.servers.edit'),
      t('settings.servers.remove'),
    ]);
  });

  it('opens with the name and URL filled in and the key field empty, never the key', () => {
    const plugin = fakePlugin(settingsWith([makeServer()], [makeBinding()]));
    const modal = openEdit(plugin);

    expect(modal.field(NAME()).value).toBe('Work');
    expect(modal.field(URL_LABEL()).value).toBe('https://old.example.com');
    const key = modal.field(KEY());
    expect(key.value ?? '').toBe('');
    expect(modal.settings.find((s) => s.name === KEY())?.desc).toBe(
      t('modal.editServer.apiKey.desc'),
    );
    // Nowhere in the modal: not a value, a placeholder or a caption.
    const shown = modal.settings.flatMap((s) => [
      s.name,
      s.desc,
      ...s.settingInputs.flatMap((i) => [
        typeof i.value === 'string' ? i.value : '',
        i.placeholder,
      ]),
    ]);
    expect(shown.some((text) => text.includes(OLD_KEY))).toBe(false);
    // The warning that the address must stay this server's.
    expect(modal.settings.some((s) => s.desc === t('modal.editServer.sameServer'))).toBe(true);
    // Nothing changed yet: Save is open, and needs no test.
    expect(modal.button(SAVE()).disabled).toBe(false);
  });

  it('saves a new name without a test, under the same id, the bindings untouched', async () => {
    const binding = makeBinding();
    const bindings = [binding];
    const plugin = fakePlugin(settingsWith([makeServer()], bindings));
    const modal = openEdit(plugin);

    modal.field(NAME()).change('  Team server  ');
    expect(modal.button(SAVE()).disabled).toBe(false);
    modal.button(SAVE()).click();
    await settle();

    expect(getMe).not.toHaveBeenCalled();
    expect(plugin.saves).toHaveBeenCalledTimes(1);
    expect(plugin.settings.servers).toEqual([makeServer({ name: 'Team server' })]);
    expect(plugin.settings.bindings).toBe(bindings);
    expect(plugin.settings.bindings[0]).toBe(binding);
    expect(binding).toEqual(makeBinding());
  });

  it('holds Save for a new URL until a test passes, and keeps the key when the field is empty', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], [makeBinding()]));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change(' https://teamvault.example.com/ ');
    expect(modal.button(SAVE()).disabled).toBe(true);
    // A click on the disabled button does nothing: no notice, no save.
    modal.button(SAVE()).click();
    await settle();
    expect(plugin.saves).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
    // Obsidian never runs the handler of a disabled button; were it run, its
    // own guard refuses too.
    modal.button(SAVE()).runClickHandler();
    await settle();
    expect(plugin.saves).not.toHaveBeenCalled();
    expect(Notice.shown.map((n) => n.message)).toEqual([t('modal.addServer.errors.testFirst')]);

    modal.button(TEST()).click();
    await settle();
    // Tested where it will be saved: the new URL, normalised, with the old key.
    expect(tested).toEqual([{ url: 'https://teamvault.example.com', apiKey: OLD_KEY }]);
    expect(modal.button(SAVE()).disabled).toBe(false);

    modal.button(SAVE()).click();
    await settle();
    expect(plugin.saves).toHaveBeenCalledTimes(1);
    expect(plugin.settings.servers).toEqual([makeServer({ url: 'https://teamvault.example.com' })]);
    expect(plugin.settings.bindings).toEqual([makeBinding()]);
  });

  it('holds Save for a new key until a test passes, and saves the new key', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    const modal = openEdit(plugin);

    modal.field(KEY()).change(' osk_new ');
    expect(modal.button(SAVE()).disabled).toBe(true);
    modal.button(TEST()).click();
    await settle();
    expect(tested).toEqual([{ url: 'https://old.example.com', apiKey: 'osk_new' }]);

    modal.button(SAVE()).click();
    await settle();
    expect(plugin.settings.servers).toEqual([makeServer({ apiKey: 'osk_new' })]);
  });

  it('keeps Save locked after a failed test, and saves nothing', async () => {
    getMe.mockImplementation(async () => {
      throw new ApiError('401', 'unauthorized', 401, false);
    });
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://teamvault.example.com');
    modal.button(TEST()).click();
    await settle();

    expect(modal.button(SAVE()).disabled).toBe(true);
    expect(Notice.shown.map((n) => n.message)).toEqual([
      t('settings.servers.test.failure', { error: t('errors.unauthorized') }),
    ]);
    modal.button(SAVE()).click();
    await settle();
    expect(plugin.saves).not.toHaveBeenCalled();
    expect(plugin.settings.servers).toEqual([makeServer()]);
  });

  it('locks Save again when the URL changes after a test', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://teamvault.example.com');
    modal.button(TEST()).click();
    await settle();
    expect(modal.button(SAVE()).disabled).toBe(false);

    modal.field(URL_LABEL()).change('https://elsewhere.example.com');
    expect(modal.button(SAVE()).disabled).toBe(true);
  });

  it('keeps Save locked when a field changes while the test is still running', async () => {
    let answer!: (user: ApiUser) => void;
    getMe.mockImplementation(
      () =>
        new Promise<ApiUser>((resolve) => {
          answer = resolve;
        }),
    );
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://teamvault.example.com');
    modal.button(TEST()).click();
    await settle();
    // Typed on while the answer for the previous address was on its way.
    modal.field(URL_LABEL()).change('https://typo.example.com');
    answer({ id: 'u1', email: 'me@example.com', name: null });
    await settle();

    expect(modal.button(SAVE()).disabled).toBe(true);
    modal.button(SAVE()).click();
    await settle();
    expect(plugin.saves).not.toHaveBeenCalled();
  });

  it('warns when the new address does not list a bound project, and still lets Save', async () => {
    getProjects.mockImplementation(async () => [project('p-other')]);
    const plugin = fakePlugin(
      settingsWith(
        [makeServer(), makeServer({ id: 's2', name: 'Home' })],
        [makeBinding(), makeBinding({ id: 'b2', serverId: 's2', projectName: 'Home notes' })],
      ),
    );
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://other.example.com');
    modal.button(TEST()).click();
    await settle();

    // Only this server's binding: the other server's is none of its business.
    expect(Notice.shown.map((n) => n.message)).toEqual([
      t('settings.servers.test.success', { email: 'me@example.com' }),
      t('modal.editServer.projectsMissing', { projects: 'Team notes' }),
    ]);
    expect(modal.button(SAVE()).disabled).toBe(false);
  });

  it('says nothing more when the new address lists every bound project', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], [makeBinding()]));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://teamvault.example.com');
    modal.button(TEST()).click();
    await settle();

    expect(getProjects).toHaveBeenCalledTimes(1);
    expect(Notice.shown.map((n) => n.message)).toEqual([
      t('settings.servers.test.success', { email: 'me@example.com' }),
    ]);
  });

  it('refuses a URL without http(s)://', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], []));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('teamvault.example.com');
    modal.button(TEST()).click();
    await settle();

    expect(getMe).not.toHaveBeenCalled();
    expect(Notice.shown.map((n) => n.message)).toEqual([t('modal.addServer.errors.url')]);
  });

  it('changes nothing on Cancel', async () => {
    const plugin = fakePlugin(settingsWith([makeServer()], [makeBinding()]));
    const modal = openEdit(plugin);

    modal.field(URL_LABEL()).change('https://teamvault.example.com');
    modal.button(TEST()).click();
    await settle();
    modal.button(CANCEL()).click();
    await settle();

    expect(plugin.saves).not.toHaveBeenCalled();
    expect(plugin.settings.servers).toEqual([makeServer()]);
  });
});

describe('settings tab — adding a server', () => {
  it('still needs every field and a passed test, and adds a server of its own', async () => {
    const existing = makeServer();
    const plugin = fakePlugin(settingsWith([existing], []));
    const modal = clickInTab(plugin, null, t('settings.servers.add'));

    expect(modal.field(NAME()).value ?? '').toBe('');
    expect(modal.field(URL_LABEL()).value ?? '').toBe('');
    expect(modal.button(SAVE()).disabled).toBe(true);
    modal.field(NAME()).change('Home');
    modal.field(URL_LABEL()).change('https://home.example.com/');
    // No key: no test.
    modal.button(TEST()).click();
    await settle();
    expect(getMe).not.toHaveBeenCalled();
    expect(Notice.shown.map((n) => n.message)).toEqual([t('modal.addServer.errors.fields')]);

    modal.field(KEY()).change('osk_home');
    expect(modal.button(SAVE()).disabled).toBe(true);
    modal.button(TEST()).click();
    await settle();
    // Checking the projects is for an edited server's bindings only.
    expect(getProjects).not.toHaveBeenCalled();
    modal.button(SAVE()).click();
    await settle();

    expect(plugin.settings.servers).toHaveLength(2);
    expect(plugin.settings.servers[0]).toBe(existing);
    const added = plugin.settings.servers[1];
    expect(added).toMatchObject({
      name: 'Home',
      url: 'https://home.example.com',
      apiKey: 'osk_home',
    });
    expect(added?.id).not.toBe(existing.id);
    expect(added?.id).toMatch(/.+/);
  });
});
