/**
 * Notes a teammate deleted while this device was away, whose local copy the
 * server already had.
 *
 * A note's `contentHash` moves only when a snapshot writes the file, so once
 * edited on this device it differs from the disk for good. Every such note
 * deleted while away asked, one dialog after another, whether to keep edits
 * the server had long had. The question is for a copy the server never saw:
 * its last content (from the tombstone) and its version history say which.
 */
import { sha256Hex } from '@/sync/hash';
import {
  buildHarness,
  connect,
  encode,
  flushAsync,
  json,
  serverFile,
  type Harness,
} from './engine-test-kit';

/** `path` (`fileId`) last written by a snapshot as "A\n"; "disk" typed and folded since. */
async function remember(h: Harness, path: string, fileId: string, disk: string): Promise<void> {
  h.vault.files.set(path, encode(disk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: await sha256Hex('A\n'),
    size: 2,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: await sha256Hex(disk),
  });
}

/** Tombstones: each file with the content the server last had. */
async function tombstones(h: Harness, files: Array<[string, string, string]>): Promise<void> {
  const listed = await Promise.all(
    files.map(async ([id, path, text]) => ({
      ...serverFile(id, path, 'TEXT', await sha256Hex(text), text.length),
      size: String(text.length),
      deletedAt: '2026-01-02',
    })),
  );
  h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () => json({ files: listed }));
}

async function history(h: Harness, fileId: string, texts: string[]): Promise<void> {
  const versions = await Promise.all(
    texts.map(async (text, i) => ({
      id: `v${i}`,
      contentHash: await sha256Hex(text),
      size: text.length,
      createdAt: '2026-01-01',
      authorId: 'u2',
      fileId,
    })),
  );
  h.routes.set(`GET /api/projects/p1/files/${fileId}/versions`, () => json({ versions }));
}

describe('SyncEngine — notes deleted while away whose copy the server had', () => {
  it('removes them without asking, and asks only about the one with unsent edits', async () => {
    const h = buildHarness();
    // Its last content on the server is the copy here.
    await remember(h, 'Old/n1.md', 'f1', 'A\nB\n');
    // The server moved on since ("A\nB\nC\n"), but had this copy once.
    await remember(h, 'Old/n2.md', 'f2', 'A\nB\n');
    // Typed and folded while offline: never reached the server.
    await remember(h, 'Old/n3.md', 'f3', 'A\nunsent\n');
    h.serverFiles = [];
    await tombstones(h, [
      ['f1', 'Old/n1.md', 'A\nB\n'],
      ['f2', 'Old/n2.md', 'A\nB\nC\n'],
      ['f3', 'Old/n3.md', 'A\n'],
    ]);
    await history(h, 'f2', ['A\n', 'A\nB\n', 'A\nB\nC\n']);
    await history(h, 'f3', ['A\n']);

    await connect(h);
    await flushAsync(40);

    expect(h.calls.filter((c) => c === 'modal.resolveDeleteConflict')).toHaveLength(1);
    expect([...h.vault.files.keys()]).toEqual(['Old/n3.md']);
    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.log.listFileMeta('b1')).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});
