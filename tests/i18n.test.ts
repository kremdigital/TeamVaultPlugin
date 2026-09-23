import { setLanguage, t } from '@/i18n';
import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';

describe('t()', () => {
  beforeEach(() => setLanguage('ru'));

  it('returns the Russian string for a known key', () => {
    expect(t('settings.servers.heading')).toBe('Серверы');
    expect(t('settings.bindings.heading')).toBe('Хранилища');
  });

  it('substitutes named params', () => {
    expect(t('settings.servers.test.success', { email: 'a@b.com' })).toBe(
      'Подключено как a@b.com.',
    );
  });

  it('leaves the placeholder intact when the param is missing', () => {
    expect(t('settings.servers.test.success')).toContain('{email}');
  });

  it('falls back to the raw key when no translation is found', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('returns the English translation when the language is en', () => {
    setLanguage('en');
    expect(t('settings.servers.heading')).toBe('Servers');
    expect(t('notice.connected', { server: 'Local' })).toBe('Connected to Local.');
  });

  it('falls back to English when the current catalog lacks a key', () => {
    // Same object the i18n module holds (one module registry per test file).
    const dict = en as Record<string, string>;
    dict['test.onlyInEnglish'] = 'Only in English';
    try {
      setLanguage('ru');
      expect(t('test.onlyInEnglish')).toBe('Only in English');
    } finally {
      delete dict['test.onlyInEnglish'];
    }
  });
});

describe('command names', () => {
  // Obsidian prefixes every command with the plugin's name itself; a name
  // that carries it too shows up as "Team Vault: Team Vault: …".
  it.each([
    ['en', en],
    ['ru', ru],
  ])('do not repeat the plugin name (%s)', (_lang, catalog) => {
    const names = Object.entries(catalog as Record<string, string>).filter(([key]) =>
      key.startsWith('command.'),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(([, name]) => /team\s*vault/i.test(name))).toEqual([]);
  });
});
