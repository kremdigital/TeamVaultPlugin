import { normalizeFolderPath } from '@/settings/folder-utils';

/**
 * Path conventions used by the watcher layer.
 *
 *   - **Vault paths** are what Obsidian uses: forward-slash separators, no
 *     leading slash, root is `''` (or `'/'` from the settings layer).
 *   - **Absolute paths** (from chokidar) use the host OS separator. On
 *     Windows that's `\`. We normalize to `/` immediately on entry.
 *
 * All scope checks (`isInBinding`) compare *normalized vault paths*.
 */

/**
 * True if `vaultPath` lives inside a binding rooted at `bindingFolder`.
 *
 * Rules (after `normalizeFolderPath` is applied to `bindingFolder`):
 *   - `'/'` (the root) matches every vault path,
 *   - exact match counts as "in",
 *   - prefix match with a `/` boundary counts as "in" (`notes` includes
 *     `notes/foo.md` but NOT `notes-other.md`).
 */
export function isInBinding(vaultPath: string, bindingFolder: string): boolean {
  const folder = normalizeFolderPath(bindingFolder);
  if (folder === '/') return true;
  if (vaultPath === folder) return true;
  return vaultPath.startsWith(`${folder}/`);
}

/**
 * Convert an OS-absolute path coming out of chokidar into a vault-relative
 * path with forward-slash separators. Returns `null` when the path is
 * outside the vault base — chokidar shouldn't ever surface that, but
 * better to be defensive than to misroute a delete.
 */
export function absoluteToVault(absolutePath: string, vaultBasePath: string): string | null {
  const norm = normalizeSeparators(absolutePath);
  const base = normalizeSeparators(vaultBasePath).replace(/\/+$/, '');
  if (norm === base) return '';
  if (!norm.startsWith(`${base}/`)) return null;
  return norm.slice(base.length + 1);
}

/** Replace `\` with `/`. Cheap; safe for non-Windows paths too. */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Paths the FS watcher should never report. Includes Obsidian's own
 * config dir and a handful of common throw-aways.
 */
export const ALWAYS_IGNORED_SEGMENTS = ['.obsidian', '.git', '.versions'] as const;

const ALWAYS_IGNORED_SUFFIX = ['.tmp', '~'] as const;

/**
 * Obsidian's desktop adapter writes files atomically: content goes to
 * `<name>.tmp.<pid>.<hex>` first, then renames over the target. A crash or
 * a locked target orphans the temp file — and since the name does NOT end
 * in `.tmp`, the suffix filter above never caught it: the watcher and the
 * initial-push pass treated the artifact as a real note and uploaded it.
 */
const ATOMIC_TMP_PATTERN = /\.tmp\.(\d+)\.[0-9a-f]+$/i;

/** True if the file should be filtered out entirely, regardless of binding. */
export function isAlwaysIgnored(vaultPath: string): boolean {
  if (vaultPath === '') return true;
  for (const seg of ALWAYS_IGNORED_SEGMENTS) {
    if (vaultPath === seg) return true;
    if (vaultPath.startsWith(`${seg}/`)) return true;
    if (vaultPath.includes(`/${seg}/`)) return true;
  }
  for (const suffix of ALWAYS_IGNORED_SUFFIX) {
    if (vaultPath.endsWith(suffix)) return true;
  }
  return ATOMIC_TMP_PATTERN.test(vaultPath);
}

/**
 * True for an atomic-write artifact left behind by a *previous* Obsidian
 * session — the embedded pid differs from `currentPid`. Artifacts of the
 * running process are skipped: their write may still be in flight. Used by
 * the startup sweep that deletes the orphans.
 */
export function isOrphanedAtomicTmp(vaultPath: string, currentPid: number): boolean {
  const match = ATOMIC_TMP_PATTERN.exec(vaultPath);
  if (!match) return false;
  return Number(match[1]) !== currentPid;
}
