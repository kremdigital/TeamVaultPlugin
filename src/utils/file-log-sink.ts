import { formatLogEntry, type LogEntry, type LogSink } from './logger';

/**
 * Storage abstraction the file sink writes through. `Obsidian.DataAdapter`
 * matches it natively (`app.vault.adapter`); tests pass an in-memory map.
 *
 * All paths are passed through unchanged — the caller (the plugin
 * top-level on Stage 13) hands us a vault-relative path under
 * `.obsidian/plugins/obsidian-team/`.
 */
export interface LogStorage {
  exists(path: string): Promise<boolean>;
  /** Returns `null` when the file is missing. */
  stat(path: string): Promise<{ size: number } | null>;
  /** Append text. Creates the file if it doesn't exist. */
  append(path: string, data: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<string>;
  /** Make sure every parent folder of `path` exists. */
  mkdir(path: string): Promise<void>;
}

export interface FileLogSinkOptions {
  storage: LogStorage;
  /** Vault-relative path, e.g. `.obsidian/plugins/obsidian-team/sync.log`. */
  filePath: string;
  /** Trigger rotation when the active log exceeds this size (bytes). Default 1 MiB. */
  maxSizeBytes?: number;
  /** Number of `.log.N` archives to keep. Default 3 — older ones are dropped. */
  maxArchives?: number;
}

/**
 * File-backed log sink with size-based rotation.
 *
 * Rotation flow when the active file would exceed `maxSizeBytes`:
 *
 *   1. Drop `sync.log.<maxArchives>` if it exists (oldest).
 *   2. Shift each `sync.log.N` → `sync.log.N+1`.
 *   3. Move `sync.log` → `sync.log.1`.
 *   4. Start a fresh `sync.log` with the current line.
 *
 * Writes serialize through a single in-flight `Promise` chain — concurrent
 * `write()` calls land in deterministic order even though the logger
 * doesn't await them.
 */
export class FileLogSink implements LogSink {
  private readonly storage: LogStorage;
  private readonly filePath: string;
  private readonly maxSizeBytes: number;
  private readonly maxArchives: number;
  /** Tail of the write-serialization chain. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Cached file size; we read it once from `stat()`, then track increments. */
  private knownSize = -1;

  constructor(options: FileLogSinkOptions) {
    this.storage = options.storage;
    this.filePath = options.filePath;
    this.maxSizeBytes = options.maxSizeBytes ?? 1024 * 1024;
    this.maxArchives = options.maxArchives ?? 3;
  }

  write(entry: LogEntry): Promise<void> {
    const line = formatLogEntry(entry) + '\n';
    const next = this.chain.then(() => this.appendLine(line));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Read the current `.log` file (without archives). */
  async readLog(): Promise<string> {
    const final = this.chain.then(async () => {
      if (!(await this.storage.exists(this.filePath))) return '';
      return this.storage.read(this.filePath);
    });
    this.chain = final.catch(() => undefined);
    return final;
  }

  /** Empty the active log file (does NOT touch archives). */
  async clear(): Promise<void> {
    const next = this.chain.then(async () => {
      await this.storage.mkdir(this.filePath);
      await this.storage.write(this.filePath, '');
      this.knownSize = 0;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  // -- Internals ----------------------------------------------------------

  private async appendLine(line: string): Promise<void> {
    if (this.knownSize < 0) {
      const stat = await this.storage.stat(this.filePath).catch(() => null);
      this.knownSize = stat?.size ?? 0;
    }
    const lineLen = byteLength(line);
    if (this.knownSize + lineLen > this.maxSizeBytes && this.knownSize > 0) {
      await this.rotate();
      this.knownSize = 0;
    }
    await this.storage.mkdir(this.filePath);
    await this.storage.append(this.filePath, line);
    this.knownSize += lineLen;
  }

  private async rotate(): Promise<void> {
    // Drop the oldest archive if we're at the cap.
    const oldest = `${this.filePath}.${this.maxArchives}`;
    if (await this.storage.exists(oldest)) {
      await this.storage.remove(oldest);
    }
    // Shift archives up: log.N-1 → log.N, …, log.1 → log.2.
    for (let i = this.maxArchives - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (await this.storage.exists(from)) {
        await this.storage.rename(from, to);
      }
    }
    // Move the live file → log.1.
    if (await this.storage.exists(this.filePath)) {
      await this.storage.rename(this.filePath, `${this.filePath}.1`);
    }
  }
}

function byteLength(s: string): number {
  // Cheap approximation: most log lines are ASCII. UTF-8 multibyte chars
  // would slightly overcount, but rotation needs only an upper bound.
  return new TextEncoder().encode(s).byteLength;
}
