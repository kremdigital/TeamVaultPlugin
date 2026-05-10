import type DatabaseConstructorType from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { loadNative } from '@/utils/native-loader';
import type { VectorClock } from './vector-clock';

type DatabaseConstructor = typeof DatabaseConstructorType;

/**
 * Local operation log — the offline-first backbone of the plugin.
 *
 * Lives in `<vault>/.obsidian/plugins/obsidian-team/state.db`, opened in WAL
 * mode for crash safety. Three logical concerns:
 *
 *   1. **`bindings_state`** — per-binding sync cursor (`lastVectorClock`,
 *      `lastSyncedAt`). Used at reconnect to ask the server "what changed
 *      since this point".
 *
 *   2. **`pending_operations`** — operations produced locally that haven't
 *      been confirmed by the server yet. Drained on reconnect.
 *
 *   3. **`file_meta`** — local mirror of server-side metadata for every
 *      file we track: server file id, content hash, size, type. Lets us
 *      decide whether an incoming UPDATE actually changes anything and
 *      what to do at conflict time.
 *
 * The class is synchronous (better-sqlite3 is synchronous by design — it
 * runs against a single connection on the main thread, which is the right
 * trade-off for a desktop Obsidian plugin).
 */

export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME' | 'MOVE';
export type FileType = 'TEXT' | 'BINARY';

export interface PendingOperationInput {
  opType: OperationType;
  filePath: string;
  /** Set for RENAME / MOVE; null otherwise. */
  newPath?: string | null;
  /** Arbitrary structured data for the operation (e.g. contentHash, size). */
  payload?: Record<string, unknown>;
}

export interface PendingOperation {
  id: number;
  bindingId: string;
  opType: OperationType;
  filePath: string;
  newPath: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface FileMeta {
  bindingId: string;
  /** Vault-relative path. */
  relativePath: string;
  serverFileId: string;
  contentHash: string;
  size: number;
  fileType: FileType;
  lastSyncedAt: number;
}

export interface BindingState {
  bindingId: string;
  lastVectorClock: VectorClock;
  lastSyncedAt: number;
}

/**
 * Migration list. Each entry is appended; `user_version` PRAGMA tracks how
 * many have been applied. Never edit a published migration — append a new
 * one. Order matters; index = migration number.
 */
const MIGRATIONS: readonly string[] = [
  // 1: initial schema.
  `
    CREATE TABLE IF NOT EXISTS bindings_state (
      bindingId TEXT PRIMARY KEY,
      lastVectorClock TEXT NOT NULL DEFAULT '{}',
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pending_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bindingId TEXT NOT NULL,
      opType TEXT NOT NULL,
      filePath TEXT NOT NULL,
      newPath TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_binding ON pending_operations(bindingId, id);

    CREATE TABLE IF NOT EXISTS file_meta (
      bindingId TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      serverFileId TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      size INTEGER NOT NULL,
      fileType TEXT NOT NULL,
      lastSyncedAt INTEGER NOT NULL,
      PRIMARY KEY (bindingId, relativePath)
    );
    CREATE INDEX IF NOT EXISTS idx_file_meta_binding ON file_meta(bindingId);
  `,
] as const;

export interface OperationLogOptions {
  /** Absolute path to the SQLite file, or `':memory:'` for tests. */
  filePath: string;
  /** Optional clock injection — tests substitute a deterministic source. */
  now?: () => number;
  /**
   * better-sqlite3 constructor injection. Tests pass it directly; in
   * production we lazy-load via {@link loadNative} (Obsidian's bundle
   * runtime can't resolve `require('better-sqlite3')` against the
   * plugin folder, so we use an absolute path).
   */
  Database?: DatabaseConstructor;
}

interface PendingRow {
  id: number;
  bindingId: string;
  opType: string;
  filePath: string;
  newPath: string | null;
  payload: string;
  createdAt: number;
}

interface FileMetaRow {
  bindingId: string;
  relativePath: string;
  serverFileId: string;
  contentHash: string;
  size: number;
  fileType: string;
  lastSyncedAt: number;
}

interface BindingStateRow {
  bindingId: string;
  lastVectorClock: string;
  lastSyncedAt: number;
}

export class OperationLog {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(options: OperationLogOptions) {
    const Database = options.Database ?? loadNative<DatabaseConstructor>('better-sqlite3');
    this.db = new Database(options.filePath);
    this.now = options.now ?? Date.now;
    // WAL is fine on disk; on `:memory:` SQLite ignores the pragma silently
    // (in-memory dbs don't have a separate journal file). Safe to set in both.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  /** Apply any pending migrations. Safe to call repeatedly. */
  private runMigrations(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = current; i < MIGRATIONS.length; i++) {
      const sql = MIGRATIONS[i];
      if (!sql) continue;
      this.db.exec(`BEGIN; ${sql}; PRAGMA user_version = ${i + 1}; COMMIT;`);
    }
  }

  /** Current schema version — useful in tests. */
  schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.db.close();
  }

  // -- pending_operations -----------------------------------------------------

  enqueueOperation(bindingId: string, op: PendingOperationInput): PendingOperation {
    const createdAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO pending_operations (bindingId, opType, filePath, newPath, payload, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bindingId,
        op.opType,
        op.filePath,
        op.newPath ?? null,
        JSON.stringify(op.payload ?? {}),
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      bindingId,
      opType: op.opType,
      filePath: op.filePath,
      newPath: op.newPath ?? null,
      payload: op.payload ?? {},
      createdAt,
    };
  }

  /**
   * Return all pending operations for a binding in insertion order. Does not
   * delete them — call `markSent(ids)` once the server has acknowledged the
   * batch.
   */
  dequeueOperations(bindingId: string): PendingOperation[] {
    const rows = this.db
      .prepare<[string], PendingRow>(
        `SELECT id, bindingId, opType, filePath, newPath, payload, createdAt
         FROM pending_operations
         WHERE bindingId = ?
         ORDER BY id ASC`,
      )
      .all(bindingId);
    return rows.map(rowToPending);
  }

  /** Total number of pending operations across all bindings. */
  pendingCount(bindingId?: string): number {
    if (bindingId === undefined) {
      const row = this.db.prepare(`SELECT COUNT(*) as n FROM pending_operations`).get() as {
        n: number;
      };
      return row.n;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM pending_operations WHERE bindingId = ?`)
      .get(bindingId) as { n: number };
    return row.n;
  }

  markSent(opIds: readonly number[]): void {
    if (opIds.length === 0) return;
    const placeholders = opIds.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM pending_operations WHERE id IN (${placeholders})`).run(...opIds);
  }

  // -- file_meta --------------------------------------------------------------

  getFileMeta(bindingId: string, path: string): FileMeta | null {
    const row = this.db
      .prepare<[string, string], FileMetaRow>(
        `SELECT bindingId, relativePath, serverFileId, contentHash, size, fileType, lastSyncedAt
         FROM file_meta WHERE bindingId = ? AND relativePath = ?`,
      )
      .get(bindingId, path);
    return row ? rowToFileMeta(row) : null;
  }

  setFileMeta(meta: FileMeta): void {
    this.db
      .prepare(
        `INSERT INTO file_meta
           (bindingId, relativePath, serverFileId, contentHash, size, fileType, lastSyncedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bindingId, relativePath) DO UPDATE SET
           serverFileId = excluded.serverFileId,
           contentHash = excluded.contentHash,
           size = excluded.size,
           fileType = excluded.fileType,
           lastSyncedAt = excluded.lastSyncedAt`,
      )
      .run(
        meta.bindingId,
        meta.relativePath,
        meta.serverFileId,
        meta.contentHash,
        meta.size,
        meta.fileType,
        meta.lastSyncedAt,
      );
  }

  deleteFileMeta(bindingId: string, path: string): void {
    this.db
      .prepare(`DELETE FROM file_meta WHERE bindingId = ? AND relativePath = ?`)
      .run(bindingId, path);
  }

  listFileMeta(bindingId: string): FileMeta[] {
    const rows = this.db
      .prepare<[string], FileMetaRow>(
        `SELECT bindingId, relativePath, serverFileId, contentHash, size, fileType, lastSyncedAt
         FROM file_meta WHERE bindingId = ? ORDER BY relativePath ASC`,
      )
      .all(bindingId);
    return rows.map(rowToFileMeta);
  }

  // -- bindings_state ---------------------------------------------------------

  getBindingState(bindingId: string): BindingState | null {
    const row = this.db
      .prepare<
        [string],
        BindingStateRow
      >(`SELECT bindingId, lastVectorClock, lastSyncedAt FROM bindings_state WHERE bindingId = ?`)
      .get(bindingId);
    return row
      ? {
          bindingId: row.bindingId,
          lastVectorClock: parseVectorClock(row.lastVectorClock),
          lastSyncedAt: row.lastSyncedAt,
        }
      : null;
  }

  /**
   * Persist a new vector clock for a binding. `syncedAt` defaults to the
   * configured clock; pass an explicit value when replaying historical state
   * (e.g. tests).
   */
  updateLastVectorClock(bindingId: string, vc: VectorClock, syncedAt?: number): void {
    const at = syncedAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO bindings_state (bindingId, lastVectorClock, lastSyncedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(bindingId) DO UPDATE SET
           lastVectorClock = excluded.lastVectorClock,
           lastSyncedAt = excluded.lastSyncedAt`,
      )
      .run(bindingId, JSON.stringify(vc), at);
  }
}

// -- helpers ------------------------------------------------------------------

function rowToPending(row: PendingRow): PendingOperation {
  return {
    id: row.id,
    bindingId: row.bindingId,
    opType: row.opType as OperationType,
    filePath: row.filePath,
    newPath: row.newPath,
    payload: parseJsonObject(row.payload),
    createdAt: row.createdAt,
  };
}

function rowToFileMeta(row: FileMetaRow): FileMeta {
  return {
    bindingId: row.bindingId,
    relativePath: row.relativePath,
    serverFileId: row.serverFileId,
    contentHash: row.contentHash,
    size: row.size,
    fileType: row.fileType as FileType,
    lastSyncedAt: row.lastSyncedAt,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseVectorClock(raw: string): VectorClock {
  const parsed = parseJsonObject(raw);
  const out: VectorClock = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
