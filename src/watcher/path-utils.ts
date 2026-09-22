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
 * Obsidian's default config folder. The *real* one is `Vault.configDir` —
 * users can point it elsewhere ("Override config folder"), and with the name
 * hard-coded the whole config folder (including our own `data.json` with the
 * API key) synced to the server. Every filter below therefore takes the
 * config dir as a parameter; this constant is only the fallback for call
 * sites without an `App` at hand.
 */
export const DEFAULT_CONFIG_DIR = '.obsidian';

/**
 * Paths the watchers and the sync engine never touch, whatever the binding
 * covers:
 *   - `.obsidian` — a config folder. Kept even when `configDir` differs: in
 *     that vault it belongs to *another* Obsidian setup, not to this one.
 *   - `.git` — a repository.
 *   - `.versions`, `.staging` — the server's own storage layout. It refuses
 *     them outright, so uploading one would retry for ever.
 *   - `.trash` — Obsidian's vault trash. Without it a note deleted into the
 *     trash reappears as a create, and the delete travels back to the server.
 */
export const ALWAYS_IGNORED_SEGMENTS = [
  '.obsidian',
  '.git',
  '.versions',
  '.staging',
  '.trash',
] as const;

/**
 * Case- and unicode-folded form used for every comparison here. macOS hands
 * out NFD for non-ASCII names while the server may store NFC; on APFS both
 * open the same folder, so comparing raw strings would let a config folder
 * named `.конфиг` through in one of the two forms.
 */
function fold(value: string): string {
  return normalizeSeparators(value).normalize('NFC').toLowerCase();
}

/** The config folder, folded, with surrounding slashes trimmed. `''` if unset. */
function configPrefix(configDir?: string): string {
  return fold(configDir ?? '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

const ALWAYS_IGNORED_SUFFIX = ['.tmp', '~'] as const;

/**
 * Obsidian's desktop adapter writes files atomically: content goes to
 * `<name>.tmp.<pid>.<hex>` first, then renames over the target. A crash or
 * a locked target orphans the temp file — and since the name does NOT end
 * in `.tmp`, the suffix filter above never caught it: the watcher and the
 * initial-push pass treated the artifact as a real note and uploaded it.
 */
const ATOMIC_TMP_PATTERN = /\.tmp\.(\d+)\.[0-9a-f]+$/i;

/**
 * True if the file should be filtered out entirely, regardless of binding.
 *
 * Matching is case-insensitive: `.OBSIDIAN/plugins/team-vault/data.json` is
 * the same folder as `.obsidian/...` on Windows and macOS, and comparing
 * case-sensitively let a server-supplied path walk straight past the filter.
 */
export function isAlwaysIgnored(vaultPath: string, configDir?: string): boolean {
  const path = fold(vaultPath);
  if (path === '') return true;
  // The config folder lives at the vault root, so it is matched as a prefix —
  // not as a segment. A user whose folder is `.obsidian-work` may well keep a
  // downloaded vault's `Архив/.obsidian-work/` as ordinary notes.
  const cfg = configPrefix(configDir);
  if (cfg !== '' && (path === cfg || path.startsWith(`${cfg}/`))) return true;
  // These names are refused anywhere in the tree: a `.git` or a `.trash` in a
  // subfolder is still a repository and still a trash can.
  const segments = path.split('/');
  for (const name of ALWAYS_IGNORED_SEGMENTS) {
    if (segments.includes(name)) return true;
  }
  for (const suffix of ALWAYS_IGNORED_SUFFIX) {
    if (path.endsWith(suffix)) return true;
  }
  return ATOMIC_TMP_PATTERN.test(path);
}

/**
 * Same filter for an OS-absolute path, used by chokidar's `ignored`
 * predicate. The path is reduced to its vault-relative part first: without
 * that, a vault stored inside a folder named `.git` (or under the user's own
 * `.trash`) would have every single file filtered out. The vault root itself
 * must stay watchable, so an empty relative path is not "ignored" here.
 */
export function isIgnoredAbsolutePath(
  absolutePath: string,
  vaultBasePath: string,
  configDir?: string,
): boolean {
  const relative = absoluteToVault(absolutePath, vaultBasePath);
  // Outside the vault entirely (including an empty base path): fail closed —
  // chokidar has no business reporting it, and letting it through is how a
  // custom config folder would leak back in.
  if (relative === null) return true;
  if (relative === '') return false;
  return isAlwaysIgnored(relative, configDir);
}

/** Why a path was refused. `null` from `checkVaultPath` means "allowed". */
export type PathRejection = 'empty' | 'absolute' | 'traversal' | 'ignored' | 'outside-binding';

/**
 * The single gate for paths that arrive from outside — above all the ones the
 * server sends (file index, catch-up operations, live create/rename events).
 *
 * The server is not trusted to name a local path: before this gate existed a
 * project member could rename a file to `.obsidian/plugins/team-vault/
 * data.json` and every other client would retarget its metadata onto its own
 * settings file, API key included (TASK-0027).
 *
 * Returns `null` when the path may be used, otherwise the reason to log.
 */
export function checkVaultPath(
  vaultPath: string,
  opts: { bindingFolder?: string; configDir?: string } = {},
): PathRejection | null {
  const path = normalizeSeparators(vaultPath).normalize('NFC');
  if (path.trim() === '') return 'empty';
  // `/etc/passwd`, `C:/Windows/...` — the adapter would resolve these outside
  // the vault instead of relative to its root.
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'absolute';
  // `notes/../.obsidian/data.json` normalizes into the config folder, and an
  // empty segment (`a//b`) is not a path Obsidian ever produces.
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'traversal';
  if (isAlwaysIgnored(path, opts.configDir)) return 'ignored';
  if (opts.bindingFolder !== undefined && !isInBinding(path, opts.bindingFolder)) {
    return 'outside-binding';
  }
  return null;
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
