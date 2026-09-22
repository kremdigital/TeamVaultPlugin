import type { VaultBinding } from './settings';

/**
 * Normalize a vault-relative folder path to a canonical form used by the
 * settings layer:
 *   - root is `/` (never empty),
 *   - other paths have NO leading or trailing slash (e.g. `notes/work`).
 *
 * Both `''` and `'/'` are treated as the vault root. Anything else is
 * trimmed of surrounding slashes.
 */
export function normalizeFolderPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Returns true if the candidate folder overlaps with any existing binding's
 * folder. Overlap rules (paths are normalized first):
 *   - exact match (the same folder is bound twice),
 *   - root (`/`) collides with any other folder (the whole vault binding
 *     would otherwise swallow nested bindings),
 *   - parent / child relationship (`a` collides with `a/b` and vice versa).
 */
export function isFolderInUse(bindings: VaultBinding[], candidate: string): boolean {
  const normCandidate = normalizeFolderPath(candidate);
  for (const binding of bindings) {
    const existing = normalizeFolderPath(binding.localFolder);
    if (existing === normCandidate) return true;
    if (existing === '/' || normCandidate === '/') return true;
    if (existing.startsWith(`${normCandidate}/`)) return true;
    if (normCandidate.startsWith(`${existing}/`)) return true;
  }
  return false;
}

/**
 * The vault root. A new binding always syncs the whole vault: Obsidian opens a
 * vault as its root folder, so that is the folder the user means. Bindings
 * made by older versions to a subfolder keep working — `localFolder` is still
 * honoured everywhere downstream.
 */
export const VAULT_ROOT = '/';

/**
 * True when a new (root) binding can be added. The root overlaps every other
 * folder, so a vault holds one binding at most — including a legacy binding
 * to a subfolder, which a root binding would swallow.
 */
export function canAddBinding(bindings: VaultBinding[]): boolean {
  return !isFolderInUse(bindings, VAULT_ROOT);
}
