import { setLanguage, t } from '@/i18n';

describe('t()', () => {
  beforeEach(() => setLanguage('ru'));

  it('returns the Russian string for a known key', () => {
    expect(t('settings.title')).toBe('Obsidian Team');
    expect(t('settings.servers.heading')).toBe('Серверы');
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
});
