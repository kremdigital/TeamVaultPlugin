/**
 * Attachments the user deletes while sync connects to a server whose catch-up
 * may leave operations out — every server before 0.3.8's: after such a connect
 * the attachments are checked against the server's listing, and one missing
 * from the vault is downloaded.
 *
 * Before: one missing because the user had just deleted it came back. A folder
 * delete sends its files' deletes one ack at a time, and a file leaves the
 * index only with its own ack. The files not sent yet were downloaded again,
 * a delete of a file still on disk is not sent, and the folder came back here
 * while its files stayed on the server for the whole team.
 */
import { sha256Hex } from '@/sync/hash';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeServer,
  buildHarness,
  bytes,
  deferred,
  encode,
  flushAsync,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

const LIST = 'GET /api/projects/p1/files';
const NAMES = ['imgs/a.png', 'imgs/b.png', 'imgs/c.png', 'imgs/d.png'];

/** Four attachments in `imgs/`, synced; the engine connected. */
async function setup(format: BroadcastFormat): Promise<{ h: Harness; server: FakeServer }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  for (const [i, path] of NAMES.entries()) {
    const content = encode(`pic ${i}`);
    const hash = await sha256Hex(content);
    const id = `i${i + 1}`;
    server.add({ id, path, fileType: 'BINARY', contentHash: hash, size: content.byteLength });
    h.vault.files.set(path, content);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: path,
      serverFileId: id,
      contentHash: hash,
      size: content.byteLength,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    h.routes.set(`GET /api/projects/p1/files/${id}`, () => bytes(content));
  }
  await h.engine.start();
  await answerJoin(h, server);
  await server.pump();
  await h.settle();
  return { h, server };
}

/** Production's answer: the journal's first rows, no echo; the docs streamed. */
async function answerJoin(h: Harness, server: FakeServer): Promise<void> {
  h.socket()
    .pending('project:join')
    .ack({ ...server.joinAnswer('first rows'), yjsStream: true, yjsCount: 0 });
  await flushAsync(5);
  h.socket().fire('yjs:catchup', { projectId: 'p1', docs: [], done: true });
  await flushAsync(10);
}

function deleteEvent(path: string, isFolder = false): VaultEvent {
  return {
    bindingId: 'b1',
    type: 'delete',
    path,
    source: 'obsidian',
    ...(isFolder ? { isFolder: true } : {}),
  };
}

function downloads(h: Harness): string[] {
  return h.requests.filter((r) => /\/files\/i\d$/.test(r.path)).map((r) => r.path);
}

function onDisk(h: Harness): string[] {
  return [...h.vault.files.keys()].filter((p) => p.startsWith('imgs'));
}

function live(server: FakeServer): string[] {
  return [...server.files.values()].filter((f) => !f.deleted).map((f) => f.path);
}

/** Connect again, and let everything settle. */
async function reconnect(h: Harness, server: FakeServer): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
  h.socket().connect();
  await flushAsync();
  await answerJoin(h, server);
  await server.pump();
  await h.settle();
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — attachments deleted while sync connects, %s broadcasts',
  (format) => {
    // What Obsidian 1.13.7 fires for a folder: a delete for each file in it,
    // then one for the folder — or, with the files' swallowed, the folder's.
    it.each(['each file, then the folder', 'the folder only'] as const)(
      'a folder: every file deleted for the team and gone here (%s)',
      async (events) => {
        const { h, server } = await setup(format);
        h.socket().disconnect();
        await flushAsync();
        // The listing of a large vault takes a while.
        const listing = h.routes.get(LIST);
        if (!listing) throw new Error('no listing');
        const gate = deferred<void>();
        h.routes.set(LIST, () => gate.promise.then(() => listing()));
        h.socket().connect();
        await flushAsync();
        await answerJoin(h, server);

        for (const path of NAMES) h.vault.files.delete(path);
        const runs: Array<Promise<void>> = [];
        if (events === 'each file, then the folder') {
          for (const path of NAMES) runs.push(h.engine.handleVaultEvent(deleteEvent(path)));
        }
        runs.push(h.engine.handleVaultEvent(deleteEvent('imgs', true)));
        await flushAsync(10);
        // One delete is answered before the listing comes.
        server.serveNext();
        await flushAsync(10);
        h.routes.set(LIST, listing);
        gate.resolve();
        await flushAsync(60);
        await server.pump();
        await h.settle();
        await Promise.allSettled(runs);
        await server.pump();

        expect(live(server)).toEqual([]);
        expect(onDisk(h)).toEqual([]);
        expect(downloads(h)).toEqual([]);
        expect(NAMES.map((p) => h.engine.getFileIdForPath(p))).toEqual([null, null, null, null]);

        await reconnect(h, server);
        expect(onDisk(h)).toEqual([]);
        expect(downloads(h)).toEqual([]);
        await h.engine.stop();
      },
    );

    it('a folder deleted while a file of it missing here comes down', async () => {
      const { h, server } = await setup(format);
      h.socket().disconnect();
      await flushAsync();
      // Its download failed at an earlier connect.
      h.vault.files.delete('imgs/d.png');
      const slow = deferred<void>();
      const d = h.routes.get('GET /api/projects/p1/files/i4');
      if (!d) throw new Error('no route');
      h.routes.set('GET /api/projects/p1/files/i4', () => slow.promise.then(() => d()));
      h.socket().connect();
      await flushAsync();
      await answerJoin(h, server);
      await flushAsync(20);
      expect(downloads(h)).toEqual(['/api/projects/p1/files/i4']);

      for (const path of NAMES) h.vault.files.delete(path);
      const run = h.engine.handleVaultEvent(deleteEvent('imgs', true));
      await flushAsync(10);
      slow.resolve();
      await flushAsync(40);
      await server.pump();
      await run;
      await h.settle();
      await server.pump();

      expect(live(server)).toEqual([]);
      expect(onDisk(h)).toEqual([]);
      await h.engine.stop();
    });

    it('one file, deleted after the listing came and before the join is answered', async () => {
      const { h, server } = await setup(format);
      h.socket().disconnect();
      await flushAsync();
      h.socket().connect();
      await flushAsync(30);

      h.vault.files.delete('imgs/b.png');
      const run = h.engine.handleVaultEvent(deleteEvent('imgs/b.png'));
      await flushAsync(10);
      expect(h.socket().emits.filter((e) => e.event === 'file:delete')).toHaveLength(1);
      await answerJoin(h, server);
      await flushAsync(40);
      expect(downloads(h)).toEqual([]);
      await server.pump();
      await run;
      await h.settle();

      expect(live(server)).toEqual(['imgs/a.png', 'imgs/c.png', 'imgs/d.png']);
      expect(onDisk(h)).toEqual(['imgs/a.png', 'imgs/c.png', 'imgs/d.png']);
      expect(downloads(h)).toEqual([]);
      await h.engine.stop();
    });
  },
);
