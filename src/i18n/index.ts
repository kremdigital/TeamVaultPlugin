import ruDict from './ru.json';
import enDict from './en.json';
import type { Language } from '@/settings/settings';

/**
 * Tiny translation helper over two catalogs with the same keys, `ru.json`
 * and `en.json` — `tests/i18n-coverage.test.ts` asserts every key the UI
 * uses is in both. Which one is current is decided by `./language` (the
 * `language` setting, `auto` = Obsidian's own language). A key missing from
 * the current catalog falls back to English — the catalog for every
 * language we don't ship — then to the raw key: a missing translation is
 * loud (the key surfaces in the UI) but never throws.
 *
 * Replace with i18next or similar if the catalog grows past a few hundred
 * keys.
 *
 * Usage:
 *   t('settings.title')
 *   t('settings.servers.test.success', { email: 'foo@bar.com' })
 */

type Catalog = Record<string, string>;

/** The catalog for a language we don't ship, and for a key a catalog lacks. */
export const FALLBACK_LANGUAGE: Language = 'en';

const catalogs: Record<Language, Catalog> = {
  ru: ruDict,
  en: enDict,
};

// English until `onload` resolves the setting.
let currentLanguage: Language = FALLBACK_LANGUAGE;

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * Look up a translation. Falls back to the English catalog, then to the raw
 * key — meaning a missing translation is loud (the key shows up in the UI)
 * but never throws.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const primary = catalogs[currentLanguage]?.[key];
  const fallback = catalogs[FALLBACK_LANGUAGE]?.[key];
  const template = primary ?? fallback ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}
