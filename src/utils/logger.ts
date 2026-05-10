/**
 * Plugin-wide logger.
 *
 * Stage-12 design:
 *
 *   - Levels: `error` < `warn` < `info` < `debug`. Anything below the
 *     active level is dropped before the sink is called (cheap to leave
 *     `debug(...)` calls in production code).
 *   - **Sinks** are pluggable: the file sink (`FileLogSink`) writes to
 *     `<vault>/.obsidian/plugins/obsidian-team/sync.log` with size-based
 *     rotation; the console sink mirrors output to DevTools when
 *     `logLevel = debug`. `CompositeSink` chains them together.
 *   - **Child loggers** carry a context object (`{ binding: 'b1' }`,
 *     `{ component: 'engine' }`, …) that's merged into every entry —
 *     keeps grep useful without every call site spelling its own prefix.
 *
 * Usage:
 *
 *   const root = new Logger('info', new ConsoleLogSink());
 *   const log  = root.child({ component: 'engine', bindingId: 'b1' });
 *   log.info('socket connected');
 *   // → 2026-05-08T… [info] [component=engine bindingId=b1] socket connected
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Sink contract — `Logger` calls `write` for every entry that passes the
 * level filter. Implementations may be sync (console) or async (file);
 * the logger doesn't await — it's fire-and-forget so a slow disk doesn't
 * stall the sync engine.
 */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LogEntry {
  level: LogLevel;
  /** ISO-8601 timestamp string. */
  timestamp: string;
  /** Pre-formatted single-line message. */
  message: string;
  /** Merged context (child + per-call). */
  context: Record<string, unknown>;
  /** Extra arguments after the message (errors, objects, …). */
  args: readonly unknown[];
}

export interface LoggerOptions {
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date;
}

export class Logger {
  private level: LogLevel;
  private readonly sink: LogSink;
  private readonly context: Record<string, unknown>;
  private readonly now: () => Date;

  constructor(
    level: LogLevel,
    sink: LogSink,
    context: Record<string, unknown> = {},
    options: LoggerOptions = {},
  ) {
    this.level = level;
    this.sink = sink;
    this.context = context;
    this.now = options.now ?? (() => new Date());
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Build a logger that adds extra context to every entry. Cheap — the
   * sink is shared, only the local context object is copied.
   */
  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.sink, { ...this.context, ...context }, { now: this.now });
  }

  error(message: string, ...args: unknown[]): void {
    this.emit('error', message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.emit('warn', message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.emit('info', message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.emit('debug', message, args);
  }

  private emit(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = {
      level,
      timestamp: this.now().toISOString(),
      message,
      context: this.context,
      args,
    };
    void this.sink.write(entry);
  }
}

/**
 * Format a log entry as a single line:
 *   `2026-05-08T14:32:01.234Z [info] [k=v k=v] message`
 *
 * Extracted as a free function so both the file sink and the console
 * sink (and future formatters) can share the rendering.
 */
export function formatLogEntry(entry: LogEntry): string {
  const ctx = Object.entries(entry.context);
  const ctxText =
    ctx.length > 0 ? ` [${ctx.map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')}]` : '';
  let line = `${entry.timestamp} [${entry.level}]${ctxText} ${entry.message}`;
  if (entry.args.length > 0) {
    line += ' ' + entry.args.map(formatValue).join(' ');
  }
  return line;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
