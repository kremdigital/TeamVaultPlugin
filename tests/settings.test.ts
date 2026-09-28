import {
  DEFAULT_SETTINGS,
  defaultSettings,
  mergeWithDefaults,
  parseLanguageSetting,
  PREVIOUS_CLIENT_IDS_MAX,
  SETTINGS_VERSION,
  settingsToSave,
} from '@/settings/settings';

describe('mergeWithDefaults', () => {
  it('returns defaults for empty input', () => {
    expect(mergeWithDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeWithDefaults({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps known fields and falls back to defaults for missing ones', () => {
    const merged = mergeWithDefaults({
      debounceMs: 1500,
      logLevel: 'debug',
    });
    expect(merged.debounceMs).toBe(1500);
    expect(merged.logLevel).toBe('debug');
    expect(merged.showSyncNotifications).toBe(DEFAULT_SETTINGS.showSyncNotifications);
    expect(merged.servers).toEqual([]);
  });

  it('follows Obsidian’s language by default', () => {
    expect(DEFAULT_SETTINGS.language).toBe('auto');
    expect(mergeWithDefaults({}).language).toBe('auto');
    expect(mergeWithDefaults({ language: 'auto' }).language).toBe('auto');
  });

  it('keeps the language the user picked', () => {
    expect(mergeWithDefaults({ settingsVersion: 2, language: 'ru' }).language).toBe('ru');
    expect(mergeWithDefaults({ settingsVersion: 2, language: 'en' }).language).toBe('en');
    expect(mergeWithDefaults({ settingsVersion: 2, language: 'auto' }).language).toBe('auto');
  });

  it('follows Obsidian where a Russian was saved before the language setting existed', () => {
    // Up to 0.3.4 the plugin always saved `ru`, and 0.3.5 kept it as if it
    // had been picked: an English Obsidian got a Russian plugin.
    expect(mergeWithDefaults({ language: 'ru' }).language).toBe('auto');
    // `en` could only be written by hand — that one was a choice.
    expect(mergeWithDefaults({ language: 'en' }).language).toBe('en');
  });

  it('saves the settings version, so a choice made from now on is kept', () => {
    const upgraded = mergeWithDefaults({ language: 'ru' });
    expect(upgraded.settingsVersion).toBe(SETTINGS_VERSION);
    // What saveSettings writes back, then reads on the next start.
    expect(
      mergeWithDefaults(JSON.parse(JSON.stringify({ ...upgraded, language: 'ru' }))).language,
    ).toBe('ru');
    expect(DEFAULT_SETTINGS.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('loads a data.json that still carries the removed syncOnStartup, and drops it', () => {
    // 0.3.4 and earlier saved `syncOnStartup` (a switch that did nothing).
    const saved = {
      servers: [],
      bindings: [],
      debounceMs: 500,
      syncOnStartup: false,
      showSyncNotifications: true,
      logLevel: 'info',
      language: 'ru',
      clientId: 'c1',
    };
    const merged = mergeWithDefaults(saved);
    expect(merged).not.toHaveProperty('syncOnStartup');
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, language: 'auto', clientId: 'c1' });
    expect(DEFAULT_SETTINGS).not.toHaveProperty('syncOnStartup');
  });

  it('rejects unknown enum values and uses defaults', () => {
    const merged = mergeWithDefaults({ logLevel: 'banana', language: 'fr' });
    expect(merged.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
    expect(merged.language).toBe(DEFAULT_SETTINGS.language);
  });

  it('clamps negative debounceMs to zero', () => {
    expect(mergeWithDefaults({ debounceMs: -42 }).debounceMs).toBe(0);
  });

  it('drops malformed servers and bindings', () => {
    const merged = mergeWithDefaults({
      servers: [
        { id: 'a', name: 'one', url: 'https://x', apiKey: 'k', addedAt: 1 },
        { id: '', url: 'https://y', apiKey: 'k' }, // missing id → dropped
        'not-an-object',
      ],
      bindings: [
        {
          id: 'b1',
          serverId: 'a',
          projectId: 'p',
          projectName: 'Proj',
          localFolder: '/notes',
          enabled: true,
          lastSyncedAt: 0,
          lastVectorClock: { node1: 7 },
        },
        { id: 'broken' }, // missing serverId/projectId → dropped
      ],
    });
    expect(merged.servers).toHaveLength(1);
    expect(merged.servers[0]?.id).toBe('a');
    expect(merged.bindings).toHaveLength(1);
    expect(merged.bindings[0]?.lastVectorClock).toEqual({ node1: 7 });
  });

  it('filters non-numeric vector clock entries', () => {
    const merged = mergeWithDefaults({
      bindings: [
        {
          id: 'b1',
          serverId: 's',
          projectId: 'p',
          lastVectorClock: { node1: 5, node2: 'bad', node3: NaN },
        },
      ],
    });
    expect(merged.bindings[0]?.lastVectorClock).toEqual({ node1: 5 });
  });
});

describe('parseLanguageSetting', () => {
  it('accepts the three choices of the settings dropdown', () => {
    expect(parseLanguageSetting('auto')).toBe('auto');
    expect(parseLanguageSetting('ru')).toBe('ru');
    expect(parseLanguageSetting('en')).toBe('en');
  });

  it('turns anything else into auto', () => {
    expect(parseLanguageSetting('fr')).toBe('auto');
    expect(parseLanguageSetting('RU')).toBe('auto');
    expect(parseLanguageSetting('')).toBe('auto');
    expect(parseLanguageSetting(null)).toBe('auto');
    expect(parseLanguageSetting(1)).toBe('auto');
  });
});

describe('defaultSettings', () => {
  it('hands out fresh arrays, never the ones in DEFAULT_SETTINGS', () => {
    const fresh = defaultSettings();
    fresh.servers.push({ id: 's', name: 'n', url: 'https://x', apiKey: 'k', addedAt: 0 });
    mergeWithDefaults(undefined).bindings.push({
      id: 'b',
      serverId: 's',
      projectId: 'p',
      projectName: 'P',
      localFolder: '/',
      enabled: true,
      lastSyncedAt: 0,
      lastVectorClock: {},
    });
    fresh.previousClientIds.push('c0');
    expect(DEFAULT_SETTINGS.servers).toEqual([]);
    expect(DEFAULT_SETTINGS.bindings).toEqual([]);
    expect(DEFAULT_SETTINGS.previousClientIds).toEqual([]);
    expect(defaultSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('the client id fields', () => {
  // Written from 0.4.1 on (see `settings/client-identity.ts`); a data.json of
  // 0.4.0 has none of them.
  it('default to an id not bound to the vault, no twin, no change, no previous ids', () => {
    expect(mergeWithDefaults({ clientId: 'c1' })).toMatchObject({
      clientId: 'c1',
      clientIdClaimed: false,
      twinClientId: '',
      clientIdRotatedAt: 0,
      previousClientIds: [],
    });
  });

  it('read back what a save wrote', () => {
    const settings = mergeWithDefaults({
      clientId: 'c2',
      clientIdClaimed: true,
      twinClientId: 'c2',
      clientIdRotatedAt: 1_790_000_000_000,
      previousClientIds: ['c1', 'c0'],
    });
    const saved = JSON.parse(JSON.stringify(settingsToSave(settings, null))) as unknown;
    expect(mergeWithDefaults(saved)).toEqual(settings);
    expect(settings).toMatchObject({
      clientIdClaimed: true,
      twinClientId: 'c2',
      clientIdRotatedAt: 1_790_000_000_000,
      previousClientIds: ['c1', 'c0'],
    });
  });

  it('repair values of the wrong type', () => {
    expect(
      mergeWithDefaults({
        clientIdClaimed: 'yes',
        twinClientId: 7,
        clientIdRotatedAt: -5,
        previousClientIds: 'c1',
      }),
    ).toMatchObject({
      clientIdClaimed: false,
      twinClientId: '',
      clientIdRotatedAt: 0,
      previousClientIds: [],
    });
    expect(mergeWithDefaults({ clientIdRotatedAt: Number.NaN }).clientIdRotatedAt).toBe(0);
  });

  it('keep each previous id once, strings only, at most the bound', () => {
    const many = Array.from({ length: PREVIOUS_CLIENT_IDS_MAX + 4 }, (_, i) => `c${i}`);
    expect(
      mergeWithDefaults({ previousClientIds: ['c1', 1, '', 'c1', null, 'c2'] }).previousClientIds,
    ).toEqual(['c1', 'c2']);
    expect(mergeWithDefaults({ previousClientIds: many }).previousClientIds).toEqual(
      many.slice(0, PREVIOUS_CLIENT_IDS_MAX),
    );
  });
});
