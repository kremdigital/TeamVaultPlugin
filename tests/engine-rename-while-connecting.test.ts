/**
 * A note renamed offline has its rename queued. Renamed again while sync is
 * connecting — waiting for `project:join`, or with the drain of the queue
 * held up behind another operation — the second rename goes out at once.
 *
 * Before: the drain sent the queued rename after it. The server applies a
 * rename by the file's id, whatever name it names as the source, so it moved
 * the note back to the name in between for the whole team, and the next
 * connect wrote that name back to disk here too: the user's last rename was
 * undone. With the connection lost before the drain, the queued rename told
 * the next connect the note was under the name in between, and the copy under
 * the last name was uploaded as a second note.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  deferred,
  encode,
  flushAsync,
  json,
  userRename,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function queue(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.newPath ? ` -> ${op.newPath}` : ''}`);
}

/** `a.md` on disk, in `state.json` and on the server; renamed to `b.md` offline. */
async function renamedOffline(
  format: BroadcastFormat,
  before: (h: Harness) => Promise<void> = () => Promise.resolve(),
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  const hash = await sha256Hex('A\n');
  h.vault.files.set('a.md', encode('A\n'));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'a.md',
    serverFileId: 'f1',
    contentHash: hash,
    size: 2,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
  await docs.add('f1', 'a.md', 'A\n');
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  h.socket().disconnect();
  await flushAsync();
  await before(h);
  await userRename(h, 'a.md', 'b.md');
  expect(queue(h).pop()).toEqual('RENAME a.md -> b.md');
  return { h, server, docs };
}

/** The socket connects again; `project:join` waits for its answer. */
async function connecting(h: Harness): Promise<void> {
  h.socket().connect();
  await flushAsync();
}

async function answerJoin(h: Harness, docs: ServerDocs): Promise<void> {
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: docs.snapshots() });
  await docs.drive();
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a note renamed offline, renamed again while sync connects, %s broadcasts',
  (format) => {
    it('keeps the last rename while the join is answered', async () => {
      const { h, server, docs } = await renamedOffline(format);
      await connecting(h);
      await userRename(h, 'b.md', 'c.md');
      await answerJoin(h, docs);

      expect(server.applied).toEqual(['f1 a.md -> c.md']);
      expect(disk(h)).toEqual(['c.md=A\n']);
      expect(queue(h)).toEqual([]);

      // And the next connect leaves it there.
      h.socket().disconnect();
      await flushAsync();
      await connecting(h);
      await answerJoin(h, docs);
      expect(server.applied).toEqual(['f1 a.md -> c.md']);
      expect(docs.live()).toEqual(['c.md=A\n']);
      expect(disk(h)).toEqual(['c.md=A\n']);
      await h.engine.stop();
    });

    it('keeps the last rename while the drain waits for an attachment upload', async () => {
      // Before the rename, an attachment was added offline: the drain sends
      // it first, and its upload takes a while.
      const { h, server, docs } = await renamedOffline(format, async (h) => {
        h.vault.files.set('pic.png', encode('picture'));
        await h.engine.handleVaultEvent({
          bindingId: 'b1',
          type: 'create',
          path: 'pic.png',
          source: 'obsidian',
        });
      });
      expect(queue(h)).toEqual(['CREATE pic.png', 'RENAME a.md -> b.md']);
      const upload = deferred<void>();
      h.routes.set('PUT /blobs', async () => {
        await upload.promise;
        return json({ ok: true });
      });
      await connecting(h);
      h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
      await flushAsync(20);
      expect(h.requests.some((r) => r.method === 'PUT')).toBe(true);

      await userRename(h, 'b.md', 'c.md');
      upload.resolve();
      await docs.drive();

      expect(server.applied).toEqual(['f1 a.md -> c.md', 'create pic.png']);
      expect(server.pathOf('f1')).toBe('c.md');
      expect(disk(h)).toEqual(['c.md=A\n', 'pic.png=picture']);
      expect(queue(h)).toEqual([]);
      await h.engine.stop();
    });

    it('uploads no second note when the connection drops before the join is answered', async () => {
      const { h, server, docs } = await renamedOffline(format);
      await connecting(h);
      await userRename(h, 'b.md', 'c.md');
      h.socket().disconnect();
      await flushAsync();
      await connecting(h);
      await answerJoin(h, docs);

      expect(server.applied).toEqual(['f1 a.md -> c.md']);
      expect(docs.live()).toEqual(['c.md=A\n']);
      expect(disk(h)).toEqual(['c.md=A\n']);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('uploads no second note after Pause sync before the drain', async () => {
      const { h, server, docs } = await renamedOffline(format);
      await connecting(h);
      await userRename(h, 'b.md', 'c.md');
      await h.engine.stop();

      const next = buildHarness({ predecessor: h });
      server.attach(next);
      docs.attach(next);
      await connect(next, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(server.applied).toEqual(['f1 a.md -> c.md']);
      expect(docs.live()).toEqual(['c.md=A\n']);
      expect(disk(next)).toEqual(['c.md=A\n']);
      expect(next.socket().created()).toEqual([]);
      await next.engine.stop();
    });
  },
);
