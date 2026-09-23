import { getLanguage, requireApiVersion } from 'obsidian';
import { catalogLanguage, readObsidianLanguage, resolveLanguage } from '@/i18n/language';
import { stubWindow, type WindowStub } from './window-stub';

describe('catalogLanguage', () => {
  it('picks Russian for ru and its regional forms', () => {
    expect(catalogLanguage('ru')).toBe('ru');
    expect(catalogLanguage('ru-RU')).toBe('ru');
    expect(catalogLanguage('RU')).toBe('ru');
    expect(catalogLanguage(' ru ')).toBe('ru');
  });

  it('picks English for English and for every language without a catalog', () => {
    expect(catalogLanguage('en')).toBe('en');
    expect(catalogLanguage('en-GB')).toBe('en');
    expect(catalogLanguage('uk')).toBe('en');
    expect(catalogLanguage('de')).toBe('en');
    expect(catalogLanguage('zh-TW')).toBe('en');
    expect(catalogLanguage('rus')).toBe('en');
  });

  it('picks English for an empty or missing code', () => {
    expect(catalogLanguage('')).toBe('en');
    expect(catalogLanguage(null)).toBe('en');
    expect(catalogLanguage(undefined)).toBe('en');
  });

  it('picks English for a translation-file path (Obsidian keeps one under the same key)', () => {
    expect(catalogLanguage('C:\\translations\\ru.txt')).toBe('en');
    expect(catalogLanguage('/home/me/ru-test.json')).toBe('en');
  });
});

describe('resolveLanguage', () => {
  it('follows Obsidian in auto: Russian Obsidian → Russian', () => {
    expect(resolveLanguage('auto', () => 'ru')).toBe('ru');
  });

  it('follows Obsidian in auto: English Obsidian → English', () => {
    expect(resolveLanguage('auto', () => 'en')).toBe('en');
  });

  it('falls back to English in auto when Obsidian runs in a language we do not ship', () => {
    expect(resolveLanguage('auto', () => 'fr')).toBe('en');
    expect(resolveLanguage('auto', () => '')).toBe('en');
  });

  it('falls back to English in auto when Obsidian’s language cannot be read', () => {
    expect(
      resolveLanguage('auto', () => {
        throw new Error('storage blocked');
      }),
    ).toBe('en');
  });

  it('keeps an explicit choice whatever language Obsidian is in, without asking it', () => {
    const read = jest.fn(() => 'ru');
    expect(resolveLanguage('en', read)).toBe('en');
    read.mockReturnValue('en');
    expect(resolveLanguage('ru', read)).toBe('ru');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('readObsidianLanguage', () => {
  let win: WindowStub | null = null;

  afterEach(() => {
    win?.restore();
    win = null;
  });

  function legacyWindow(stored: string | null | Error, navigatorLanguage?: string): void {
    jest.mocked(requireApiVersion).mockReturnValueOnce(false);
    win = stubWindow({
      localStorage: {
        getItem: (key: string) => {
          if (stored instanceof Error) throw stored;
          return key === 'language' ? stored : null;
        },
      },
      navigator: navigatorLanguage === undefined ? {} : { language: navigatorLanguage },
    });
  }

  it('asks getLanguage() on Obsidian 1.8.7 and later', () => {
    jest.mocked(requireApiVersion).mockReturnValueOnce(true);
    jest.mocked(getLanguage).mockReturnValueOnce('ru');
    expect(readObsidianLanguage()).toBe('ru');
    expect(requireApiVersion).toHaveBeenLastCalledWith('1.8.7');
  });

  it('before 1.8.7 reads the language Obsidian keeps in localStorage', () => {
    legacyWindow('ru', 'en-US');
    expect(readObsidianLanguage()).toBe('ru');
  });

  it('before 1.8.7 falls back to the system language when none was picked', () => {
    legacyWindow(null, 'ru-RU');
    expect(readObsidianLanguage()).toBe('ru-RU');
  });

  it('before 1.8.7 treats an empty stored value as none picked', () => {
    legacyWindow('', 'de-DE');
    expect(readObsidianLanguage()).toBe('de-DE');
  });

  it('before 1.8.7 survives blocked storage', () => {
    legacyWindow(new Error('SecurityError'), 'ru');
    expect(readObsidianLanguage()).toBe('ru');
  });

  it('before 1.8.7 ends at English when there is nothing to go on', () => {
    legacyWindow(null);
    expect(readObsidianLanguage()).toBe('en');
  });
});
