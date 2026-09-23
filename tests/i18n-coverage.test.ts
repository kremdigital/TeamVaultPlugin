/**
 * Catalog coverage check.
 *
 * Walks every `.ts` file under `src/` and extracts every `t('...')`
 * literal call. Asserts each extracted key exists in both catalogs — `ru.json`
 * and `en.json`, the fallback — and that the two carry the same keys.
 *
 * Limitations: only matches static string literals — `t(\`prefix.${var}\`)`
 * isn't checked. We don't use dynamic keys anywhere yet; if a future
 * refactor introduces them, this test will accept them silently.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';

const SRC = join(__dirname, '..', 'src');
const KEY_REGEX = /\bt\(\s*['"]([\w.-]+)['"]/g;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, files);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function collectUsedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of walk(SRC)) {
    // Normalize Windows paths so the i18n-module skip below works regardless
    // of separator.
    const normalized = file.replace(/\\/g, '/');
    // The i18n module's own JSDoc carries example calls like
    // `t('modal.addServer.testSuccess', ...)` that are illustrative — skip.
    if (normalized.endsWith('/i18n/index.ts')) continue;
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = KEY_REGEX.exec(source)) !== null) {
      const key = match[1];
      if (key) keys.add(key);
    }
  }
  return keys;
}

function missingKeys(dict: Record<string, string>, keys: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(dict, key)) missing.push(key);
  }
  return missing;
}

describe('i18n catalog coverage', () => {
  it('every t() key used in src has a translation in ru.json', () => {
    expect(missingKeys(ru, collectUsedKeys())).toEqual([]);
  });

  it('every t() key used in src has a translation in en.json', () => {
    expect(missingKeys(en, collectUsedKeys())).toEqual([]);
  });

  it('ru.json and en.json carry the same keys', () => {
    expect(missingKeys(en, Object.keys(ru))).toEqual([]);
    expect(missingKeys(ru, Object.keys(en))).toEqual([]);
  });
});
