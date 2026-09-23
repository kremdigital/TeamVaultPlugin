import type { LogEntry, LogSink } from './logger';

/**
 * Pass entries to `inner` only while `isOpen()` says so. The predicate is
 * asked per entry, so a settings change takes effect on the next line logged
 * — the DevTools mirror (`ConsoleLogSink`) follows the Debug log level
 * without a plugin reload. It used to be wired in once at load, so picking
 * Debug mirrored nothing until the plugin was reloaded.
 */
export class GatedLogSink implements LogSink {
  constructor(
    private readonly inner: LogSink,
    private readonly isOpen: () => boolean,
  ) {}

  write(entry: LogEntry): void | Promise<void> {
    if (!this.isOpen()) return;
    // Hand a promise back so `CompositeLogSink` can swallow its rejection.
    return this.inner.write(entry);
  }
}
