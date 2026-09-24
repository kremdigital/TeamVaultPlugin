/**
 * A file a teammate deleted while this device was away.
 *
 * It is not in the listing, so not in the index, and the catch-up's DELETE
 * finds nothing to apply to. Renamed before it was deleted, its tombstone is
 * under the new name, and `initialPush` uploaded the copy under the old name
 * as a new file: the deleted note came back for the whole team. Not renamed,
 * the copy stayed on disk, never synced again.
 */
import { sha256Hex } from '@/sync/hash';
import {
  buildHarness,
  connect,
  encode,
  flushAsync,
  json,
  op,
  serverFile,
  type Harness,
} from './engine-test-kit';

/** `a.md` (f1) synced as `A\n`; the disk holds `onDisk`. */
async function remember(h: Harness, onDisk: string, folded?: string): Promise<string> {
  const hash = await sha256Hex('A\n');
  h.vault.files.set('a.md', encode(onDisk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'a.md',
    serverFileId: 'f1',
    contentHash: hash,
    size: 2,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: folded === undefined ? hash : await sha256Hex(folded),
  });
  return hash;
}

/** The server holds f1 as a tombstone at `path`. */
function tombstone(h: Harness, path: string, hash: string): void {
  h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () =>
    json({
      files: [{ ...serverFile('f1', path, 'TEXT', hash, 2), size: '2', deletedAt: '2026-01-02' }],
    }),
  );
}

describe('SyncEngine — a file deleted on the server while this device was away', () => {
  it('does not come back under its old name when it was renamed first', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\n');
    h.serverFiles = [];
    tombstone(h, 'b.md', hash);

    await connect(h, {
      operations: [
        op('RENAME', 'a.md', 'b.md', { fileId: 'f1' }, 1),
        op('DELETE', 'b.md', null, { fileId: 'f1' }, 2),
      ],
    });
    await flushAsync(20);

    expect(h.socket().created()).toEqual([]);
    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('is removed from the disk when it was deleted under its name', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\n');
    h.serverFiles = [];
    tombstone(h, 'a.md', hash);

    await connect(h, { operations: [op('DELETE', 'a.md', null, { fileId: 'f1' }, 1)] });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('asks first about an edit folded while offline, and keeps it on "restore"', async () => {
    const h = buildHarness();
    // Folded into the doc while offline: the marker names the disk, but the
    // doc never went back to the server — the catch-up did not know the file.
    const hash = await remember(h, 'A\noffline\n', 'A\noffline\n');
    h.serverFiles = [];
    tombstone(h, 'b.md', hash);

    await connect(h, {
      operations: [
        op('RENAME', 'a.md', 'b.md', { fileId: 'f1' }, 1),
        op('DELETE', 'b.md', null, { fileId: 'f1' }, 2),
      ],
    });
    await flushAsync(20);
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.text('a.md')).toBe('A\noffline\n');

    h.modal.del.resolve('restore-server');
    await flushAsync(20);
    expect(h.socket().created()).toEqual(['a.md']);
    expect(h.vault.text('a.md')).toBe('A\noffline\n');
    await h.engine.stop();
  });

  it('asks first, and removes it on "delete"', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\nmine\n');
    h.serverFiles = [];
    tombstone(h, 'a.md', hash);

    await connect(h);
    await flushAsync(20);
    expect(h.calls).toContain('modal.resolveDeleteConflict');

    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});
