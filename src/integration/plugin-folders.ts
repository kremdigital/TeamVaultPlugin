/**
 * Duplicate plugin-folder detection.
 *
 * Obsidian keys plugins by the `id` inside `manifest.json`, not by folder
 * name. Keeping a second copy of the plugin next to the real one — a
 * `team-vault-backup-0.2.9` saved before an upgrade, an unzipped release, a
 * dev build — leaves two folders declaring the same id, and Obsidian loads
 * exactly one of them. Which one is not the user's choice, and the halves of
 * our state then disagree:
 *
 *   - `data.json` is read from the **loaded folder** (`Plugin.loadData()`),
 *     so a stale copy starts with empty settings: no servers, no bindings,
 *     the status bar sits at «no active vaults» and nothing ever syncs;
 *   - `state.db` and `sync.log` live under `.obsidian/plugins/{manifest.id}`
 *     — the **canonical** folder — so that same stale copy still reads and
 *     mutates the real op-log, orphan sweeps included. With empty settings
 *     every binding looks retired, and the sweep wipes the offline CRDT.
 *
 * That pair cost a large production vault a full re-sync on 2026-09-04: the
 * manager showed 0.2.9 while 0.2.11 sat unused in the folder next to it.
 * Detection is a directory listing, so we run it on every load, tell the
 * user which folder to remove, and skip the destructive sweeps until they do.
 */

/** Minimal slice of Obsidian's `DataAdapter` this module needs. */
export interface PluginFolderReader {
  list(normalizedPath: string): Promise<{ folders: string[] }>;
  read(normalizedPath: string): Promise<string>;
}

export interface DuplicateScanOptions {
  /** Obsidian's config dir, e.g. `.obsidian` (vault-relative). */
  configDir: string;
  /** Our own `manifest.id` — the key Obsidian actually dedupes on. */
  pluginId: string;
  /** `manifest.dir` of the loaded copy; omitted when Obsidian doesn't set it. */
  ownDir?: string;
}

/** Strip trailing slashes and normalize separators so paths compare equal. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Folders under `{configDir}/plugins` — other than the loaded one — whose
 * `manifest.json` declares `pluginId`. Empty when the install is healthy.
 *
 * Best-effort: an unreadable directory, a missing or malformed manifest and
 * a manifest without an `id` are all skipped rather than thrown. When
 * `ownDir` is unknown we can't tell which copy is live, so a duplicate is
 * only reported when *more than one* folder claims the id.
 */
export async function findDuplicatePluginFolders(
  reader: PluginFolderReader,
  options: DuplicateScanOptions,
): Promise<string[]> {
  const root = `${normalize(options.configDir)}/plugins`;
  let folders: string[];
  try {
    folders = (await reader.list(root)).folders;
  } catch {
    return [];
  }

  const claiming: string[] = [];
  for (const folder of folders) {
    let raw: string;
    try {
      raw = await reader.read(`${normalize(folder)}/manifest.json`);
    } catch {
      continue; // no manifest — not a plugin folder we care about
    }
    let id: unknown;
    try {
      id = (JSON.parse(raw) as { id?: unknown }).id;
    } catch {
      continue; // malformed manifest — Obsidian ignores it too
    }
    if (id === options.pluginId) claiming.push(normalize(folder));
  }

  const own = options.ownDir === undefined ? undefined : normalize(options.ownDir);
  if (own === undefined) return claiming.length > 1 ? claiming.sort() : [];
  return claiming.filter((dir) => dir !== own).sort();
}
