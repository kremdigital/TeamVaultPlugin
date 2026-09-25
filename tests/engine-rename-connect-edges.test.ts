/**
 * Renames made here that the connect's index refresh used to misread.
 *
 * - A rename made while the connect's listing was on its way. The socket is
 *   up, so the rename went to the server at once; the listing, taken before
 *   it, still showed the old name, and the refresh took that for a
 *   teammate's rename back to it: the note went back to its old name here
 *   while the server kept the new one.
 * - A note renamed and renamed back while offline (a → b → a), while a
 *   teammate renamed it (a → z). The refresh read the queue before it was
 *   folded: the local rename "won", the teammate's was skipped — and then
 *   the queue folded to nothing and sent nothing. The note stayed `a` here
 *   and `z` on the server; a new note a teammate then created as `a` was
 *   taken for this one.
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
  goOnline,
  userRename,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

// Each case runs the server's side too.
jest.setTimeout(30_000);

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<void> {
  const hash = await sha256Hex(text);
  h.vault.files.set(path, encode(text));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
}

async function note(
  h: Harness,
  format: BroadcastFormat,
): Promise<{ server: FakeServer; docs: ServerDocs }> {
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  await remember(h, 'a.md', 'f1', 'A\n');
  await docs.add('f1', 'a.md', 'A\n');
  return { server, docs };
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function recorded(h: Harness): string[] {
  return h.log.listFileMeta('b1').map((m) => `${m.serverFileId}:${m.relativePath}`);
}

/** Hold the listing: it answers with what the server had when it was asked. */
function holdListing(h: Harness): () => void {
  const gate = deferred<void>();
  const route = h.routes.get('GET /api/projects/p1/files');
  if (!route) throw new Error('no listing route');
  h.routes.set('GET /api/projects/p1/files', async () => {
    const asked = await route();
    await gate.promise;
    return asked;
  });
  return () => gate.resolve();
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a rename made while the connect’s listing is on its way, %s broadcasts',
  (format) => {
    /** The user renames the note, and the server has the rename, before the listing comes. */
    async function renameBeforeListing(
      h: Harness,
      server: FakeServer,
      release: () => void,
    ): Promise<void> {
      await userRename(h, 'a.md', 'b.md');
      await server.pump();
      expect(server.pathOf('f1')).toBe('b.md');
      release();
    }

    it('keeps the new name at the start of a session', async () => {
      const h = buildHarness();
      const { server, docs } = await note(h, format);
      const release = holdListing(h);

      await h.engine.start();
      await flushAsync();
      await renameBeforeListing(h, server, release);
      h.socket()
        .pending('project:join')
        .ack({ ok: true, operations: [], yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(server.pathOf('f1')).toBe('b.md');
      expect(disk(h)).toEqual(['b.md=A\n']);
      expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
      expect(h.engine.getFileIdForPath('a.md')).toBeNull();
      expect(recorded(h)).toEqual(['f1:b.md']);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('keeps the new name on a reconnect', async () => {
      const h = buildHarness();
      const { server, docs } = await note(h, format);
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      h.socket().disconnect();
      await flushAsync();
      const release = holdListing(h);

      h.socket().connect();
      await flushAsync();
      await renameBeforeListing(h, server, release);
      h.socket()
        .pending('project:join')
        .ack({ ok: true, operations: [], yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(server.pathOf('f1')).toBe('b.md');
      expect(disk(h)).toEqual(['b.md=A\n']);
      expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
      expect(recorded(h)).toEqual(['f1:b.md']);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a delete made while the connect’s listing is on its way, %s broadcasts',
  (format) => {
    // Sent at once, after the listing and the join's catch-up were taken:
    // indexed again from them, the note was written back to disk, and stayed
    // there, never synced again (the server holds a tombstone).
    it('keeps the note deleted', async () => {
      const h = buildHarness();
      const { server, docs } = await note(h, format);
      const release = holdListing(h);
      const stale = docs.snapshots();

      await h.engine.start();
      await flushAsync();
      h.vault.files.delete('a.md');
      const deleted = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'delete',
        path: 'a.md',
        source: 'obsidian',
      });
      await server.pump();
      await deleted;
      expect(server.pathOf('f1')).toBeNull();
      release();
      h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: stale });
      await docs.drive();

      expect(disk(h)).toEqual([]);
      expect(h.engine.getFileIdForPath('a.md')).toBeNull();
      expect(recorded(h)).toEqual([]);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — renamed and renamed back offline while a teammate renamed it, %s broadcasts',
  (format) => {
    async function expectFollowed(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
      expect(server.applied).toEqual(['f1 a.md -> z.md']);
      expect(disk(h)).toEqual(['z.md=A\n']);
      expect(h.engine.getFileIdForPath('z.md')).toBe('f1');
      expect(h.log.dequeueOperations('b1')).toEqual([]);

      // A teammate then creates a new `a.md`: a note of its own here too.
      const id = await server.teammateCreate('a.md', 'new a\n');
      await docs.drive();
      expect(disk(h)).toEqual(['a.md=new a\n', 'z.md=A\n']);
      expect(docs.live()).toEqual(['a.md=new a\n', 'z.md=A\n']);
      expect(h.engine.getFileIdForPath('a.md')).toBe(id);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    }

    it('follows the teammate’s rename when the session started offline', async () => {
      const h = buildHarness({ offline: true });
      const { server, docs } = await note(h, format);
      server.teammateRename('f1', 'z.md');

      await h.engine.start();
      await flushAsync();
      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'b.md', 'a.md');
      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      await expectFollowed(h, server, docs);
    });

    it('follows the teammate’s rename after a reconnect', async () => {
      const h = buildHarness();
      const { server, docs } = await note(h, format);
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      h.socket().disconnect();
      await flushAsync();

      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'b.md', 'a.md');
      server.teammateRename('f1', 'z.md');
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack({ ok: true, operations: [], yjsDocs: docs.snapshots() });
      await docs.drive();

      await expectFollowed(h, server, docs);
    });
  },
);
