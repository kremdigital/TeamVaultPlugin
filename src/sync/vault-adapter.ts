/**
 * Abstraction over the slice of `app.vault` the sync engine needs.
 *
 * Stage 7 talks to the vault exclusively through this interface, which
 * lets us unit-test the engine with a `Map`-backed in-memory adapter and
 * still drop in `ObsidianVaultAdapter` (Stage 9) on the real plugin.
 *
 * All `vaultPath`s are forward-slash, no leading slash — the same shape
 * Obsidian's own API uses for `TFile.path`.
 */
export interface VaultAdapter {
  /** OS-absolute path to the vault root (used by chokidar). */
  getBasePath(): string;

  exists(vaultPath: string): Promise<boolean>;
  readText(vaultPath: string): Promise<string>;
  readBinary(vaultPath: string): Promise<ArrayBuffer>;

  /** Create a new text file. Throws if the file exists. */
  createText(vaultPath: string, content: string): Promise<void>;
  /** Replace the contents of an existing text file. */
  writeText(vaultPath: string, content: string): Promise<void>;

  /** Create a new binary file. Throws if the file exists. */
  createBinary(vaultPath: string, content: ArrayBuffer): Promise<void>;
  /** Replace the contents of an existing binary file. */
  writeBinary(vaultPath: string, content: ArrayBuffer): Promise<void>;

  /** Soft-removes the file from the vault. */
  delete(vaultPath: string): Promise<void>;
  /** Move/rename the file. Implementations are responsible for creating
   *  parent folders at the new location. */
  rename(oldVaultPath: string, newVaultPath: string): Promise<void>;

  /** Make sure every parent folder of `vaultPath` exists. */
  ensureParentFolder(vaultPath: string): Promise<void>;

  /**
   * List vault-relative paths of every file recursively inside
   * `folderPath` (or every file in the vault when `folderPath === '/'`).
   * Folders are excluded; only file paths are returned. The order is
   * unspecified.
   *
   * Used by the engine's initial-push pass — after `project:join` the
   * engine scans every local file and uploads anything the server
   * doesn't know about yet.
   */
  list(folderPath: string): Promise<string[]>;
}
