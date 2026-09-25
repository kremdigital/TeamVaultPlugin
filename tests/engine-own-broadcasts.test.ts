/**
 * The server sends every file operation to the whole project room, its
 * sender included, right before the ack. A server that sends `clientId`
 * lets this device recognise its own: a created, deleted or binary-updated
 * file it reported itself is left to the ack.
 *
 * Taken for a teammate's, this device's own upload of an attachment was
 * downloaded again right after it went up. When the file had been written
 * once more meanwhile (an attachment saved twice in a row, as drawing
 * plugins do), the download of the first version replaced the second on
 * disk.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  buildHarness,
  bytes,
  connect,
  flushAsync,
  type Harness,
} from './engine-test-kit';

/** An attachment this device synced: on disk and in `state.json`. */
async function rememberAttachment(
  h: Harness,
  path: string,
  fileId: string,
  content: ArrayBuffer,
): Promise<string> {
  const hash = await sha256Hex(content);
  h.vault.files.set(path, content);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: content.byteLength,
    fileType: 'BINARY',
    lastSyncedAt: 1,
  });
  return hash;
}

function contentOf(h: Harness, path: string): number[] | null {
  const buf = h.vault.files.get(path);
  return buf === undefined ? null : Array.from(new Uint8Array(buf));
}

function saved(h: Harness, path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });
}

describe('SyncEngine — its own file operations broadcast back to it', () => {
  it('does not take its own upload of an attachment for a teammate’s', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const v1 = new Uint8Array([1]).buffer;
    const v2 = new Uint8Array([2, 2]).buffer;
    const v3 = new Uint8Array([3, 3, 3]).buffer;
    const hash = await rememberAttachment(h, 'image.png', 'f1', v1);
    server.add({ id: 'f1', path: 'image.png', fileType: 'BINARY', contentHash: hash, size: 1 });
    await connect(h);
    // What a download would get: the version the server has after the first upload.
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(v2));

    // The attachment is written twice in a row; the first upload is still
    // on its way when the second write lands.
    h.vault.files.set('image.png', v2);
    const first = saved(h, 'image.png');
    await flushAsync();
    h.vault.files.set('image.png', v3);
    const second = saved(h, 'image.png');
    await flushAsync();
    await server.pump();
    await first;
    await second;
    await h.settle();
    await flushAsync(20);

    // The second write stays on disk; nothing downloaded replaced it.
    expect(contentOf(h, 'image.png')).toEqual([3, 3, 3]);
    expect(h.log.getFileMeta('b1', 'image.png')?.contentHash).toBe(await sha256Hex(v3));
    expect(server.applied).toEqual(['update f1', 'update f1']);
    expect(h.calls).not.toContain('modal.resolveBinaryConflict');
    expect(h.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/files/f1'))).toEqual(
      [],
    );
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });
});
