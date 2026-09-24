/**
 * Renames between names a disk takes for one file.
 *
 * - A rename that changes only the case or the spelling was recognised with
 *   `toLowerCase`. A Mac disk also merges the final sigma (`Λογος`/`ΛΟΓΟΣ`),
 *   `ß` with `SS` and NFD with NFC: there the collision check compared the
 *   file with itself and deleted the only copy.
 * - Renames made while away whose new names a disk takes for one (the server
 *   tells them apart) made a move step aside again and again, under a name
 *   longer each time, until the disk refused it — or for good, with the file
 *   missing on disk.
 * - The step aside of a case-only rename was in no record: the rename proper
 *   failing (a file locked by another program) or the app killed before it
 *   left the file under the spare name for the next connect to upload.
 */
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import {
  buildHarness,
  connect,
  deferred,
  eventLog,
  flushAsync,
  op,
  serverFile,
  type Harness,
  type MemoryVault,
} from './engine-test-kit';

async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: ArrayBuffer,
  fileType: FileType = 'BINARY',
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, synced);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: synced.byteLength,
    fileType,
    lastSyncedAt: 1,
  });
  return hash;
}

/** APFS as macOS formats it: names compared after full case folding and NFD. */
const apfsKey = (path: string): string =>
  path.normalize('NFD').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
/** NTFS, and APFS for plain letters: names compared without case. */
const ntfsKey = (path: string): string => path.toLowerCase();

/**
 * Make `vault` open names the way a disk comparing them by `key` does.
 * `renameHook` runs before each rename and may throw or wait.
 */
function foldNames(
  vault: MemoryVault,
  key: (path: string) => string,
  renameHook: (from: string, to: string) => Promise<void> | void = () => undefined,
): void {
  const find = (path: string): string | undefined =>
    [...vault.files.keys()].find((k) => key(k) === key(path));
  const at = (path: string): ArrayBuffer => {
    const k = find(path);
    const buf = k === undefined ? undefined : vault.files.get(k);
    if (!buf) throw new Error(`ENOENT ${path}`);
    return buf;
  };
  vault.exists = async (path) => find(path) !== undefined;
  vault.readBinary = async (path) => at(path);
  vault.delete = async (path) => {
    const k = find(path);
    if (k !== undefined) vault.files.delete(k);
  };
  vault.rename = async (from, to) => {
    await renameHook(from, to);
    const buf = at(from);
    const k = find(from);
    if (k !== undefined) vault.files.delete(k);
    vault.files.set(to, buf);
  };
}

const rename = (from: string, to: string, fileId: string, clock: number) =>
  op('RENAME', from, to, { fileId }, clock);

describe('SyncEngine — a rename to a spelling a Mac disk takes for the same name', () => {
  it.each([
    ['final sigma', 'Λογος.png', 'ΛΟΓΟΣ.png'],
    ['ß and SS', 'Straße.png', 'STRASSE.png'],
    ['NFD and NFC', 'ёлка.png'.normalize('NFD'), 'Ёлка.png'],
  ])('keeps the only copy (%s)', async (_label, from, to) => {
    const h = buildHarness();
    foldNames(h.vault, apfsKey);
    const img = new Uint8Array([4, 4, 4]).buffer;
    const hash = await remember(h, from, 'f1', img);
    h.serverFiles = [serverFile('f1', from, 'BINARY', hash, 3)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: to, log: eventLog });
    await flushAsync();

    expect([...h.vault.files.keys()]).toEqual([to]);
    expect(h.vault.files.get(to)).toBe(img);
    expect(h.engine.getFileIdForPath(to)).toBe('f1');
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('keeps the only copy when the rename happened while away', async () => {
    const h = buildHarness();
    foldNames(h.vault, apfsKey);
    const img = new Uint8Array([4, 4, 4]).buffer;
    const hash = await remember(h, 'Λογος.png', 'f1', img);
    h.serverFiles = [serverFile('f1', 'ΛΟΓΟΣ.png', 'BINARY', hash, 3)];

    await connect(h, { operations: [rename('Λογος.png', 'ΛΟΓΟΣ.png', 'f1', 1)] });

    expect([...h.vault.files.keys()]).toEqual(['ΛΟΓΟΣ.png']);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — renames made while away into names a disk takes for one', () => {
  // Server (case-sensitive): `y` and `z` swapped, `x` renamed to `Y`.
  async function setUp(h: Harness, xOnDisk: boolean): Promise<string[]> {
    const X = new Uint8Array([1]).buffer;
    const Yb = new Uint8Array([2, 2]).buffer;
    const Z = new Uint8Array([3, 3, 3]).buffer;
    const hx = await remember(h, 'x.bin', 'f1', X);
    const hy = await remember(h, 'y.bin', 'f2', Yb);
    const hz = await remember(h, 'z.bin', 'f3', Z);
    if (!xOnDisk) h.vault.files.delete('x.bin');
    h.serverFiles = [
      serverFile('f1', 'Y.bin', 'BINARY', hx, 1),
      serverFile('f2', 'z.bin', 'BINARY', hy, 2),
      serverFile('f3', 'y.bin', 'BINARY', hz, 3),
    ];
    const renames: string[] = [];
    const rename0 = h.vault.rename.bind(h.vault);
    h.vault.rename = async (from, to) => {
      renames.push(`${from} -> ${to}`);
      if (renames.length > 20) throw new Error('test: too many renames');
      return rename0(from, to);
    };
    // A file missing on disk is never renamed, only looked for under one
    // spare name after another: without a cap that loop never yields to a
    // timer, and takes the test runner down with it.
    let looks = 0;
    const exists0 = h.vault.exists.bind(h.vault);
    h.vault.exists = async (path) => {
      if (++looks > 500) throw new Error('test: the renames never end');
      return exists0(path);
    };
    return renames;
  }

  it('applies them on a disk that tells case apart, stepping one file aside once', async () => {
    const h = buildHarness();
    const renames = await setUp(h, true);

    await connect(h);

    expect(renames.length).toBeLessThanOrEqual(4);
    expect(renames.filter((r) => r.includes('.moving-'))).toHaveLength(2);
    expect(renames.every((r) => !/\.moving-\d+\.moving-/.test(r))).toBe(true);
    expect(h.vault.files.get('Y.bin')).toEqual(new Uint8Array([1]).buffer);
    expect(h.vault.files.get('z.bin')).toEqual(new Uint8Array([2, 2]).buffer);
    expect(h.vault.files.get('y.bin')).toEqual(new Uint8Array([3, 3, 3]).buffer);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('ends even when the file moving into the cycle is missing on disk', async () => {
    const h = buildHarness();
    const renames = await setUp(h, false);

    await connect(h);

    expect(renames.length).toBeLessThanOrEqual(3);
    expect(h.engine.getStatus()).toBe('connected');
    expect(h.engine.getFileIdForPath('y.bin')).toBe('f3');
    expect(h.engine.getFileIdForPath('z.bin')).toBe('f2');
    await h.engine.stop();
  });

  it('never steps a file aside under a second spare suffix', async () => {
    const h = buildHarness();
    foldNames(h.vault, ntfsKey);
    const img = new Uint8Array([7]).buffer;
    const hash = await remember(h, 'x.moving-5.png', 'f1', img);
    const renames: string[] = [];
    foldNames(h.vault, ntfsKey, (from, to) => {
      renames.push(`${from} -> ${to}`);
    });
    h.serverFiles = [serverFile('f1', 'x.moving-5.png', 'BINARY', hash, 1)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'X.moving-5.png', log: eventLog });
    await flushAsync();

    expect(renames).toHaveLength(2);
    expect(renames[0]).toMatch(/^x\.moving-5\.png -> x\.moving-\d+\.png$/);
    expect([...h.vault.files.keys()]).toEqual(['X.moving-5.png']);
    await h.engine.stop();
  });
});

describe('SyncEngine — a case-only rename cut off after its step aside', () => {
  it('moves the file back when the rename proper fails, and uploads nothing', async () => {
    const h = buildHarness();
    let busy = true;
    foldNames(h.vault, ntfsKey, (from) => {
      if (busy && from.includes('.moving-')) {
        busy = false;
        throw new Error('EBUSY: resource busy or locked');
      }
    });
    const img = new Uint8Array([4, 4, 4]).buffer;
    const hash = await remember(h, 'Photo.png', 'f1', img);
    h.serverFiles = [serverFile('f1', 'photo.png', 'BINARY', hash, 3)];

    await connect(h, { operations: [rename('Photo.png', 'photo.png', 'f1', 1)] });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['Photo.png']);
    expect(h.socket().created()).toEqual([]);
    expect(h.log.listFileMeta('b1').map((m) => m.relativePath)).toEqual(['Photo.png']);
    expect(h.engine.getStatus()).toBe('connected');

    // Unlocked: the next connect moves it.
    h.socket().disconnect();
    h.socket().connect();
    await flushAsync();
    h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
    await flushAsync(20);
    expect([...h.vault.files.keys()]).toEqual(['photo.png']);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('leaves the next start the spare name on record when the app dies in between', async () => {
    const h = buildHarness();
    const held = deferred<void>();
    const reached = deferred<void>();
    let hold = true;
    foldNames(h.vault, ntfsKey, async (from) => {
      if (hold && from.includes('.moving-')) {
        hold = false;
        reached.resolve();
        await held.promise; // never released: the app is killed here
      }
    });
    const img = new Uint8Array([4, 4, 4]).buffer;
    const hash = await remember(h, 'Photo.png', 'f1', img);
    h.serverFiles = [serverFile('f1', 'photo.png', 'BINARY', hash, 3)];
    void h.engine.start();
    await flushAsync();
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [rename('Photo.png', 'photo.png', 'f1', 1)], yjsDocs: [] });
    await reached.promise;

    const spare = [...h.vault.files.keys()];
    expect(spare).toEqual([expect.stringMatching(/^Photo\.moving-\d+\.png$/)]);
    expect(h.log.listFileMeta('b1').map((m) => m.relativePath)).toEqual(spare);

    const next = buildHarness({ predecessor: h });
    next.serverFiles = [serverFile('f1', 'photo.png', 'BINARY', hash, 3)];
    await connect(next);
    await flushAsync(20);

    expect([...next.vault.files.keys()]).toEqual(['photo.png']);
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });
});
