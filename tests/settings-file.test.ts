import { readSettingsFile, type SettingsFileIo } from '@/settings/settings-file';

const enoent = (): Error => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

/**
 * A scripted `data.json`: each read takes the next step, and the last step
 * repeats. A step is the file's content, `null` for no file (the read
 * rejects with `ENOENT`, as Obsidian's desktop adapter does), or an error the
 * read rejects with.
 */
function scripted(steps: Array<string | null | Error>): SettingsFileIo & {
  sleeps: number[];
  reads: () => number;
} {
  let step = -1;
  const sleeps: number[] = [];
  return {
    sleeps,
    reads: () => step + 1,
    read: async () => {
      step++;
      const current = steps[Math.min(step, steps.length - 1)];
      if (current === null || current === undefined) throw enoent();
      if (current instanceof Error) throw current;
      return current;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

const DELAYS = [10, 20, 40];

describe('readSettingsFile', () => {
  it('reads a JSON object', async () => {
    const io = scripted(['{"clientId":"c1"}']);
    await expect(readSettingsFile(io, DELAYS)).resolves.toEqual({
      kind: 'ok',
      data: { clientId: 'c1' },
    });
    expect(io.sleeps).toEqual([]);
  });

  it('reads a file saved with a UTF-8 byte order mark', async () => {
    await expect(readSettingsFile(scripted(['﻿{"clientId":"c1"}']), DELAYS)).resolves.toEqual({
      kind: 'ok',
      data: { clientId: 'c1' },
    });
  });

  it('calls a file that is missing on two looks a first run', async () => {
    const io = scripted([null]);
    await expect(readSettingsFile(io, DELAYS)).resolves.toEqual({ kind: 'missing' });
    expect(io.reads()).toBe(2);
    expect(io.sleeps).toEqual([10]);
  });

  it('reads a file that turns up on the second look — a sync client replacing it', async () => {
    const io = scripted([null, '{"clientId":"c1"}']);
    await expect(readSettingsFile(io, DELAYS)).resolves.toEqual({
      kind: 'ok',
      data: { clientId: 'c1' },
    });
  });

  it('calls a file that stays broken unreadable, after trying again', async () => {
    const io = scripted(['{ "servers": [ ,']);
    const result = await readSettingsFile(io, DELAYS);
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'corrupt' });
    expect(io.sleeps).toEqual(DELAYS);
  });

  it.each([
    ['an empty file', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"settings"'],
  ])('calls %s unreadable, not a first run', async (_name, content) => {
    await expect(readSettingsFile(scripted([content]), DELAYS)).resolves.toMatchObject({
      kind: 'unreadable',
      reason: 'corrupt',
    });
  });

  it('reads a file another program held for a moment', async () => {
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const io = scripted([busy, busy, '{"clientId":"c1"}']);
    await expect(readSettingsFile(io, DELAYS)).resolves.toEqual({
      kind: 'ok',
      data: { clientId: 'c1' },
    });
    expect(io.sleeps).toEqual([10, 20]);
  });

  it('calls a file that stays locked unreadable, and keeps the error', async () => {
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const result = await readSettingsFile(scripted([busy]), DELAYS);
    expect(result).toEqual({ kind: 'unreadable', reason: 'inaccessible', error: busy });
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'UNKNOWN'])(
    'never takes a file it may not read (%s) for a missing one',
    async (code) => {
      const denied = Object.assign(new Error(code), { code });
      await expect(readSettingsFile(scripted([denied]), DELAYS)).resolves.toMatchObject({
        kind: 'unreadable',
        reason: 'inaccessible',
      });
    },
  );

  it('reads a file a sync client was halfway through writing', async () => {
    const io = scripted(['{"clientId":', '{"clientId":"c1"}']);
    await expect(readSettingsFile(io, DELAYS)).resolves.toMatchObject({ kind: 'ok' });
  });

  it('does not take a file that vanished after a failed read for a first run', async () => {
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    await expect(readSettingsFile(scripted([busy, null]), DELAYS)).resolves.toMatchObject({
      kind: 'unreadable',
      reason: 'inaccessible',
    });
  });
});
