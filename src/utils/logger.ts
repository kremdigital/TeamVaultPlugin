/**
 * Plugin-wide logger.
 *
 * Stage-12 design:
 *
 *   - Levels: `error` < `warn` < `info` < `debug`. Anything below the
 *     active level is dropped before the sink is called (cheap to leave
 *     `debug(...)` calls in production code).
 *   - **Sinks** are pluggable: the file sink (`FileLogSink`) writes to
 *     `<vault>/.obsidian/plugins/team-vault/sync.log` with size-based
 *     rotation; the console sink mirrors output to DevTools when
 *     `logLevel = debug`. `CompositeSink` chains them together.
 *   - **Child loggers** carry a context object (`{ binding: 'b1' }`,
 *     `{ component: 'engine' }`, …) that's merged into every entry —
 *     keeps grep useful without every call site spelling its own prefix.
 *     They share their parent's level: `setLevel` anywhere in the family
 *     moves all of it.
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
  /**
   * Boxed so a logger and every child made from it read one level. The
   * engines log through children of the plugin's root logger, made when they
   * start; the Log level setting calls `setLevel` on the root. When children
   * snapshotted the level, switching to Debug reached engine logs only after
   * the plugin reloaded.
   */
  private levelBox: { current: LogLevel };
  private readonly sink: LogSink;
  private readonly context: Record<string, unknown>;
  private readonly now: () => Date;

  constructor(
    level: LogLevel,
    sink: LogSink,
    context: Record<string, unknown> = {},
    options: LoggerOptions = {},
  ) {
    this.levelBox = { current: level };
    this.sink = sink;
    this.context = context;
    this.now = options.now ?? (() => new Date());
  }

  setLevel(level: LogLevel): void {
    this.levelBox.current = level;
  }

  getLevel(): LogLevel {
    return this.levelBox.current;
  }

  /**
   * Whether an entry at `level` gets to the sink now. For a caller that
   * remembers what it has logged: an entry the level filter dropped was never
   * written, and must not count as reported.
   */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.levelBox.current];
  }

  /**
   * Build a logger that adds extra context to every entry. Cheap — the
   * sink and the level are shared, only the local context object is copied.
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger(
      this.levelBox.current,
      this.sink,
      { ...this.context, ...context },
      { now: this.now },
    );
    child.levelBox = this.levelBox;
    return child;
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
    if (!this.isEnabled(level)) return;
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
    // Circular or BigInt-bearing values. Arrays keep their own toString (the
    // elements, comma-joined) where it works. For anything else `String()`
    // only ever printed "[object Object]" — and threw on a null-prototype
    // object, or an array holding one, taking the log line down with it. The
    // type tag is the same text, minus the throw.
    if (Array.isArray(v)) {
      try {
        return String(v);
      } catch {
        // An element without a toString — fall back to the tag.
      }
    }
    return Object.prototype.toString.call(v);
  }
}
