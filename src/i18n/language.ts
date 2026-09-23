import { getLanguage as getObsidianLanguage, requireApiVersion } from 'obsidian';
import type { Language, LanguageSetting } from '@/settings/settings';
import { FALLBACK_LANGUAGE } from './index';

/**
 * Which UI catalog to use. The `language` setting is either a catalog or
 * `auto`, meaning "the language Obsidian itself runs in": Russian when
 * Obsidian is in Russian, English for everything else — English is the
 * directory's lingua franca and the catalog a missing key falls back to.
 */

/**
 * Map an Obsidian language code (`ru`, `en`, `zh-TW`, …) to a catalog by its
 * primary subtag. Obsidian keeps the absolute path of a developer
 * translation file under the same key; that never reads as `ru`, so it
 * lands on English like any language we don't ship.
 */
export function catalogLanguage(code: string | null | undefined): Language {
  if (typeof code !== 'string') return FALLBACK_LANGUAGE;
  return code.trim().toLowerCase().split(/[-_]/)[0] === 'ru' ? 'ru' : FALLBACK_LANGUAGE;
}

/**
 * Resolve the setting to a catalog. `readObsidian` is only asked in `auto`,
 * and a failure to read it is not worth a broken UI: English.
 */
export function resolveLanguage(setting: LanguageSetting, readObsidian: () => string): Language {
  if (setting !== 'auto') return setting;
  try {
    return catalogLanguage(readObsidian());
  } catch {
    return FALLBACK_LANGUAGE;
  }
}

/**
 * The language Obsidian's own UI runs in. `getLanguage()` answers that from
 * 1.8.7, above our minAppVersion (1.7.2); on older builds this does what
 * `getLanguage()` does (app.js 1.13.7): the `language` key Obsidian writes
 * to localStorage when the user picks a language — absent until then — else
 * the system language, else English. The localStorage read is the
 * directory linter's prefer-get-language warning; it only runs where
 * `getLanguage()` does not exist.
 */
export function readObsidianLanguage(): string {
  if (requireApiVersion('1.8.7')) return getObsidianLanguage();
  let picked: string | null = null;
  try {
    picked = window.localStorage.getItem('language');
  } catch {
    // Storage access can throw (blocked); the system language still answers.
  }
  if (picked) return picked;
  return window.navigator.language || FALLBACK_LANGUAGE;
}
