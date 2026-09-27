import { FileLogSink, type LogStorage } from '@/utils/file-log-sink';
import type { LogEntry } from '@/utils/logger';

/**
 * In-memory storage adapter that mimics the slice of `Obsidian.DataAdapter`
 * the file sink talks to. Records files in a `Map<path, content>` and
 * tracks every operation in `events` for sanity assertions.
 */
class MemoryStorage implements LogStorage {
  files = new Map<string, string>();
  events: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async stat(path: string): Promise<{ size: number } | null> {
    const v = this.files.get(path);
    if (v === undefined) return null;
    return { size: new TextEncoder().encode(v).byteLength };
  }
  async append(path: string, data: string): Promise<void> {
    this.events.push(`append ${path}`);
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  async write(path: string, data: string): Promise<void> {
    this.events.push(`write ${path}`);
    this.files.set(path, data);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    this.events.push(`rename ${oldPath} → ${newPath}`);
    const v = this.files.get(oldPath);
    if (v !== undefined) {
      this.files.delete(oldPath);
      this.files.set(newPath, v);
    }
  }
  async remove(path: string): Promise<void> {
    this.events.push(`remove ${path}`);
    this.files.delete(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? '';
  }
  async mkdir(): Promise<void> {
    /* no-op for in-memory */
  }
}

function entry(level: 'error' | 'warn' | 'info' | 'debug', message: string): LogEntry {
  return { level, timestamp: '2026-05-08T12:00:00Z', message, context: {}, args: [] };
}

describe('FileLogSink — append', () => {
  it('writes a line to a fresh file', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    await sink.write(entry('info', 'hello'));
    expect(storage.files.get('sync.log')).toBe('2026-05-08T12:00:00Z [info] hello\n');
  });

  it('appends sequential lines', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    await sink.write(entry('info', 'a'));
    await sink.write(entry('info', 'b'));
    expect(storage.files.get('sync.log')?.split('\n')).toEqual([
      '2026-05-08T12:00:00Z [info] a',
      '2026-05-08T12:00:00Z [info] b',
      '',
    ]);
  });

  it('serializes concurrent writes', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    await Promise.all([
      sink.write(entry('info', '1')),
      sink.write(entry('info', '2')),
      sink.write(entry('info', '3')),
    ]);
    const lines = storage.files.get('sync.log')?.trim().split('\n') ?? [];
    expect(lines.map((l) => l.replace(/^.* /, ''))).toEqual(['1', '2', '3']);
  });
});

describe('FileLogSink — rotation', () => {
  it('rotates when the next line would overflow', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({
      storage,
      filePath: 'sync.log',
      maxSizeBytes: 50,
      maxArchives: 2,
    });

    // Each formatted line is ~33 bytes — two of these blow the 50-byte cap.
    await sink.write(entry('info', 'aaaa'));
    expect(storage.files.has('sync.log.1')).toBe(false);

    await sink.write(entry('info', 'bbbb'));
    // The second write should have triggered rotation: log → log.1, fresh log.
    expect(storage.files.has('sync.log.1')).toBe(true);
    expect(storage.files.get('sync.log.1')?.includes('aaaa')).toBe(true);
    expect(storage.files.get('sync.log')?.includes('bbbb')).toBe(true);
  });

  it('caps archive count at maxArchives', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({
      storage,
      filePath: 'sync.log',
      maxSizeBytes: 30,
      maxArchives: 2,
    });

    // Force four rotations.
    await sink.write(entry('info', 'aaa'));
    await sink.write(entry('info', 'bbb')); // → archive 1 (aaa)
    await sink.write(entry('info', 'ccc')); // → log.1 (bbb), log.2 (aaa)
    await sink.write(entry('info', 'ddd')); // → log.1 (ccc), log.2 (bbb), aaa dropped

    expect(storage.files.has('sync.log.3')).toBe(false);
    expect(storage.files.get('sync.log.1')?.includes('ccc')).toBe(true);
    expect(storage.files.get('sync.log.2')?.includes('bbb')).toBe(true);
    expect(storage.files.get('sync.log')?.includes('ddd')).toBe(true);
  });

  it('does not rotate an empty file', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log', maxSizeBytes: 5 });
    await sink.write(entry('info', 'this-is-already-bigger-than-cap'));
    expect(storage.files.has('sync.log.1')).toBe(false);
  });
});

describe('FileLogSink — readLog / clear', () => {
  it('readLog returns the active file content', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    await sink.write(entry('info', 'foo'));
    expect(await sink.readLog()).toContain('foo');
  });

  it('readLog returns empty string when the file does not exist', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    expect(await sink.readLog()).toBe('');
  });

  it('clear empties the active file but leaves archives alone', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log', maxSizeBytes: 30 });
    await sink.write(entry('info', 'aaa'));
    await sink.write(entry('info', 'bbb')); // forces a rotation
    await sink.clear();
    expect(storage.files.get('sync.log')).toBe('');
    expect(storage.files.has('sync.log.1')).toBe(true);
  });
});

// Obsidian's quit waits for what `sync.log` has not written yet (see `main.ts`).
describe('FileLogSink — lines still on their way', () => {
  it('says a line is on its way until it is in the file, and settles then', async () => {
    const storage = new MemoryStorage();
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });
    expect(sink.hasPendingWrites()).toBe(false);

    void sink.write(entry('warn', 'last words'));
    expect(sink.hasPendingWrites()).toBe(true);
    await sink.settled();

    expect(sink.hasPendingWrites()).toBe(false);
    expect(storage.files.get('sync.log')).toContain('last words');
  });

  it('settles without rejecting when the write fails', async () => {
    const storage = new MemoryStorage();
    storage.append = (): Promise<void> => Promise.reject(new Error('EIO'));
    storage.write = (): Promise<void> => Promise.reject(new Error('EIO'));
    const sink = new FileLogSink({ storage, filePath: 'sync.log' });

    sink.write(entry('warn', 'lost')).catch(() => undefined);

    await expect(sink.settled()).resolves.toBeUndefined();
    expect(sink.hasPendingWrites()).toBe(false);
  });
});
