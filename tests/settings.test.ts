import { DEFAULT_SETTINGS, mergeWithDefaults, parseLanguageSetting } from '@/settings/settings';

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

  it('keeps an explicit ru / en saved by earlier versions', () => {
    expect(mergeWithDefaults({ language: 'ru' }).language).toBe('ru');
    expect(mergeWithDefaults({ language: 'en' }).language).toBe('en');
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
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, language: 'ru', clientId: 'c1' });
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
