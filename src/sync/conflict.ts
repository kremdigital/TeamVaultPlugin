/**
 * Conflict detection + resolution helpers.
 *
 * Stage-9 scope:
 *
 *   - **Text files** — Yjs merges concurrent edits per-character. There is
 *     no conflict to detect.
 *   - **Binary files** — three-way: if the local content has diverged from
 *     the last known server hash AND the server pushed a new hash that's
 *     also different, we surface a `ConflictModal` with three options:
 *     keep-server / keep-local / keep-both.
 *   - **Delete vs. update** — server sends DELETE for a file the user has
 *     unsaved edits to. Two options: delete-locally / restore-on-server.
 *
 * The detection logic lives here as pure functions so it's straightforward
 * to test. The actual modals live in `src/ui/modals/` and depend on
 * Obsidian.
 */

export type BinaryConflictResolution = 'keep-server' | 'keep-local' | 'keep-both';
export type DeleteConflictResolution = 'delete-local' | 'restore-server';

/**
 * Inputs for `detectBinaryConflict`.
 *
 * - `storedHash` — what's in `file_meta` for this binding+path. The
 *   "common ancestor" from the engine's perspective.
 * - `localHash` — hash of the bytes currently on disk.
 * - `serverHash` — hash from the incoming server UPDATE.
 */
export interface BinaryConflictInput {
  storedHash: string;
  localHash: string;
  serverHash: string;
}

/**
 * True when both sides moved away from the common ancestor in different
 * directions — i.e. the local file has uncommitted changes AND the server
 * also has fresh content. `serverHash === localHash` means we and the
 * server independently arrived at the same result; harmless, just adopt.
 */
export function detectBinaryConflict(input: BinaryConflictInput): boolean {
  const localChanged = input.localHash !== input.storedHash;
  const serverChanged = input.serverHash !== input.storedHash;
  const sidesAgree = input.localHash === input.serverHash;
  return localChanged && serverChanged && !sidesAgree;
}

export interface DeleteConflictInput {
  storedHash: string;
  localHash: string;
}

/**
 * True when the user has uncommitted changes to a file the server is
 * trying to delete. Without this guard a passive DELETE event would
 * silently nuke the user's in-progress edit.
 */
export function detectDeleteConflict(input: DeleteConflictInput): boolean {
  return input.localHash !== input.storedHash;
}

/**
 * Build a sibling filename for the keep-both branch:
 *   `notes/foo.png` + ts=1700000000000 → `notes/foo.conflict-1700000000000.png`
 *
 * Files without an extension just get the suffix appended:
 *   `Makefile` → `Makefile.conflict-1700000000000`
 */
export function buildConflictPath(filePath: string, timestamp: number): string {
  const slash = filePath.lastIndexOf('/');
  const basename = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) {
    // No extension or hidden file like `.gitignore` — append the suffix.
    return `${dir}${basename}.conflict-${timestamp}`;
  }
  const stem = basename.slice(0, dot);
  const ext = basename.slice(dot);
  return `${dir}${stem}.conflict-${timestamp}${ext}`;
}

/**
 * The name the server stores a file under when the one asked for is taken
 * (its `appendConflictSuffix`): `<name>.conflict-<clientId>` before the
 * extension, with `-<attempt>` after the id from the second name on —
 * `notes/foo.md` + `device-1` + 2 → `notes/foo.conflict-device-1-2.md`. The
 * id is cut to 32 characters, anything but `A-Z a-z 0-9 _ -` in it made `_`.
 */
export function serverConflictPath(filePath: string, clientId: string, attempt = 1): string {
  const sanitized = clientId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'unknown';
  const tag = attempt > 1 ? `${sanitized}-${attempt}` : sanitized;
  const dot = filePath.lastIndexOf('.');
  const slash = filePath.lastIndexOf('/');
  if (dot > slash) return `${filePath.slice(0, dot)}.conflict-${tag}${filePath.slice(dot)}`;
  return `${filePath}.conflict-${tag}`;
}

/**
 * Resolver contract — the engine asks the resolver to make a choice and
 * the resolver answers (typically by surfacing a modal). The default
 * implementation in `defaultConflictResolver` is "always keep server" so
 * unit tests don't need to wire a UI.
 */
export interface ConflictResolver {
  resolveBinaryConflict(context: BinaryConflictContext): Promise<BinaryConflictResolution>;
  resolveDeleteConflict(context: DeleteConflictContext): Promise<DeleteConflictResolution>;
}

export interface BinaryConflictContext {
  filePath: string;
  localSize: number;
  serverSize: number;
  /** ISO string of the server-side updatedAt. */
  serverUpdatedAt?: string | undefined;
}

export interface DeleteConflictContext {
  filePath: string;
  localSize: number;
}

/**
 * Default resolver — always keeps the server's version. Used in tests and
 * as a safe fallback when no UI is wired up. Production code passes a
 * resolver that opens the modal.
 */
export const defaultConflictResolver: ConflictResolver = {
  async resolveBinaryConflict(): Promise<BinaryConflictResolution> {
    return 'keep-server';
  },
  async resolveDeleteConflict(): Promise<DeleteConflictResolution> {
    return 'delete-local';
  },
};
