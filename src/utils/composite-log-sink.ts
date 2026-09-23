import type { LogEntry, LogSink } from './logger';

/**
 * Fan an entry to every sink in sequence. Errors thrown by an individual
 * sink are swallowed — one sink failing (e.g. disk full on the file sink)
 * must not silence the others.
 */
export class CompositeLogSink implements LogSink {
  constructor(private readonly sinks: readonly LogSink[]) {}

  write(entry: LogEntry): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.write(entry);
        // Swallow rejected promises too — the logger is fire-and-forget.
        if (result && typeof result.catch === 'function') {
          void result.catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }
  }
}
