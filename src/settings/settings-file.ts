/**
 * Reading `data.json` so that a file we cannot read is never taken for a
 * missing one.
 *
 * `Plugin.loadData()` can't tell them apart well enough. Obsidian's
 * `Vault.readJson` (app.js 1.13.7) returns `null` for a missing file, but
 * for every other failure — a trailing comma after a hand edit, a file held
 * by an antivirus or a cloud-sync client (`EBUSY`, `EPERM`) — it logs and
 * returns `undefined`, and the plugin used to merge that into the defaults
 * like a first run: it minted a new client id, saved the empty settings over
 * the file (API keys and bindings gone) and then swept the "orphaned" local
 * state of every binding — the offline queue in `state.json` and the offline
 * CRDT in IndexedDB. So this reads the file itself and says which case it is.
 *
 * Only the read's own `ENOENT` means "no file". `adapter.exists()` won't do:
 * on the desktop it is `fs.access` answering `false` for any error at all.
 */

/** What reading `data.json` found. */
export type SettingsFileRead =
  | { kind: 'ok'; data: Record<string, unknown> }
  /** No file, on two looks: a first run. */
  | { kind: 'missing' }
  /**
   * There is a file, but not settings we can use: it could not be read
   * (`inaccessible`) or is not a JSON object (`corrupt`). Nothing may be
   * written over it.
   */
  | { kind: 'unreadable'; reason: 'inaccessible' | 'corrupt'; error: unknown };

export interface SettingsFileIo {
  /** The file's text; rejects with the file system's error (`code: 'ENOENT'` for none). */
  read(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/**
 * Waits before each re-read of a file that could not be read or parsed. A
 * lock by a sync client or an antivirus usually lasts well under a second,
 * and so does a sync client replacing the file; a real hand-edit mistake
 * stays broken, and costs under two seconds of startup. A first run pays
 * the first wait once, for its second look.
 */
export const SETTINGS_READ_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

export async function readSettingsFile(
  io: SettingsFileIo,
  retryDelaysMs: readonly number[] = SETTINGS_READ_RETRY_DELAYS_MS,
): Promise<SettingsFileRead> {
  let failure: Extract<SettingsFileRead, { kind: 'unreadable' }> | null = null;
  let missingLooks = 0;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await io.sleep(retryDelaysMs[attempt - 1]!);
    let text: string;
    try {
      text = await io.read();
    } catch (error) {
      if (isMissingFile(error)) {
        // A first run, if the file is still not there on a second look. A
        // sync client may delete it to write it anew; and once it has been
        // seen but could not be read, it is not missing at all.
        if (failure === null && ++missingLooks >= 2) return { kind: 'missing' };
        continue;
      }
      failure = { kind: 'unreadable', reason: 'inaccessible', error };
      continue;
    }
    let data: unknown;
    try {
      // Editors and PowerShell 5.1 save "UTF-8" with a byte order mark, which
      // JSON.parse rejects. Obsidian writes the file back without one.
      data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      failure = { kind: 'unreadable', reason: 'corrupt', error };
      continue;
    }
    if (!isPlainObject(data)) {
      failure = {
        kind: 'unreadable',
        reason: 'corrupt',
        error: new Error('data.json does not hold a JSON object'),
      };
      continue;
    }
    return { kind: 'ok', data };
  }
  return failure ?? { kind: 'missing' };
}
