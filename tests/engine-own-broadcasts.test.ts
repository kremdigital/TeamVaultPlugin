/**
 * The server sends every file operation to the whole project room, its
 * sender included, right before the ack. A server that sends `clientId`
 * lets this device recognise its own: a created, deleted or binary-updated
 * file it reported itself is left to the ack. From a server that does not,
 * an attachment upload is recognised by its hash while it is on its way.
 *
 * Taken for a teammate's, this device's own upload of an attachment was
 * downloaded again right after it went up. When the file had been written
 * once more meanwhile (an attachment saved twice in a row, as drawing
 * plugins do), the download of the first version replaced the second on
 * disk.
 *
 * The client id alone does not make an operation this device's own: it must
 * be on its way from here too. A vault copied to another computer along with
 * its `data.json` takes the id with it.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { Logger, type LogEntry } from '@/utils/logger';
import {
  FakeServer,
  buildHarness,
  bytes,
  connect,
  encode,
  flushAsync,
  serverDocWith,
  serverFile,
  snapshotOf,
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

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — its own file operations broadcast back to it, %s broadcasts',
  (format) => {
    it('does not take its own upload of an attachment for a teammate’s', async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
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
  },
);

describe('SyncEngine — operations of another device that uses this device’s client id', () => {
  // A vault copied to another computer along with its `data.json`: both
  // computers send under one client id. Taken for this device's own, the
  // other computer's new notes, deletes and renames did not reach this one
  // until the next connect.
  it('applies them as a teammate’s: nothing of the kind is on its way from here', async () => {
    const entries: LogEntry[] = [];
    const h = buildHarness({
      logger: new Logger('debug', {
        write: (e) => {
          entries.push(e);
        },
      }),
    });
    for (const [path, id] of [
      ['a.md', 'f1'],
      ['c.md', 'f3'],
    ] as const) {
      h.vault.files.set(path, encode('A\n'));
      h.log.setFileMeta({
        bindingId: 'b1',
        relativePath: path,
        serverFileId: id,
        contentHash: await sha256Hex('A\n'),
        size: 2,
        fileType: 'TEXT',
        lastSyncedAt: 1,
        foldedHash: await sha256Hex('A\n'),
      });
    }
    h.serverFiles = [
      serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f3', 'c.md', 'TEXT', await sha256Hex('A\n'), 2),
    ];
    await connect(h, {
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('A\n'), 'f3')],
    });
    await flushAsync(20);
    const log = { id: 'l9', vectorClock: { 'device-1': 9 }, createdAt: '2026-01-01' };

    h.socket().fire('file:renamed', {
      fileId: 'f1',
      newPath: 'b.md',
      requestedPath: 'b.md',
      outcome: { kind: 'renamed', fileId: 'f1', from: 'a.md', to: 'b.md' },
      clientId: 'device-1',
      log,
    });
    h.socket().fire('file:deleted', { fileId: 'f3', clientId: 'device-1', log });
    h.socket().fire('file:created', {
      result: { outcome: { kind: 'created', fileId: 'f2', path: 'n.md' }, log },
      clientId: 'device-1',
      revived: false,
      log,
    });
    await flushAsync(20);
    h.socket().fire('yjs:update', {
      fileId: 'f2',
      update: Array.from(Y.encodeStateAsUpdate(serverDocWith('twin\n'))),
    });
    await flushAsync(40);
    await h.settle();

    expect([...h.vault.files.keys()].sort()).toEqual(['b.md', 'n.md']);
    expect(h.vault.text('n.md')).toBe('twin\n');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.engine.getFileIdForPath('n.md')).toBe('f2');
    expect(h.engine.getFileIdForPath('c.md')).toBeNull();
    expect(h.engine.getStatus()).toBe('connected');
    // Said once in sync.log, not once per event.
    expect(entries.filter((e) => e.message.includes('uses the same id'))).toHaveLength(1);
    await h.engine.stop();
  });
});
