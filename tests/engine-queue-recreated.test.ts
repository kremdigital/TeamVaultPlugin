/**
 * An operation queued offline carries only the file's id. A teammate who
 * deletes a file and creates one under the same name meanwhile gets the same
 * id back: the server revives the tombstone. Sent as it was, the queued
 * operation hit the teammate's new file — a delete removed it for the whole
 * team, a rename renamed it, an attachment edit wrote the old attachment's
 * bytes over it.
 *
 * Now an operation of the file the catch-up shows deleted and created again
 * is not sent: it was about the deleted file. A delete is not sent either
 * when the server's file has changed since this device last synced it — the
 * only sign a server whose catch-up leaves the revival out gives. The file
 * the server has comes back here; what this device had of the deleted one is
 * removed when the server had it, or kept as a file of its own.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  bytes,
  encode,
  flushAsync,
  goOnline,
  json,
  op,
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

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

/** The catch-up of a file deleted and created again under its id. */
function recreatedOps(path: string, fileId: string, fileType: 'TEXT' | 'BINARY' = 'TEXT') {
  return [
    op('DELETE', path, null, { fileId }, 5),
    op('CREATE', path, null, { fileId, fileType }, 6),
  ];
}

/** A note on disk, in `state.json` and on the server; the engine started offline. */
async function offlineWithNote(
  format: BroadcastFormat,
  path: string,
  text: string,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness({ offline: true });
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
  await remember(h, path, 'f1', text);
  await docs.add('f1', path, text);
  h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
  await h.engine.start();
  await flushAsync();
  return { h, server, docs };
}

async function userDelete(h: Harness, path: string): Promise<void> {
  h.vault.files.delete(path);
  await h.engine.handleVaultEvent({ bindingId: 'b1', type: 'delete', path, source: 'obsidian' });
  await h.settle();
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a queued delete of a note deleted and created again meanwhile, %s server',
  (format) => {
    it.each([
      ['the catch-up shows it', true],
      ['only the listing shows the new text', false],
    ])('is not sent when %s', async (_label, shown) => {
      const { h, server, docs } = await offlineWithNote(format, 'Untitled.md', 'old draft\n');
      await userDelete(h, 'Untitled.md');
      expect(h.log.dequeueOperations('b1').map((o) => o.opType)).toEqual(['DELETE']);
      // Meanwhile a teammate deleted it and created a new Untitled.md.
      server.teammateDelete('f1');
      await server.teammateCreate('Untitled.md', 'teammate fresh note\n');

      await goOnline(h, {
        operations: shown ? recreatedOps('Untitled.md', 'f1') : [],
        yjsDocs: docs.snapshots(),
      });
      await docs.drive();

      expect(server.applied).toEqual(['delete f1', 'create Untitled.md']);
      expect(docs.live()).toEqual(['Untitled.md=teammate fresh note\n']);
      expect(disk(h)).toEqual(['Untitled.md=teammate fresh note\n']);
      expect(h.engine.getFileIdForPath('Untitled.md')).toBe('f1');
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('still goes out for a note nobody touched meanwhile', async () => {
      const { h, server, docs } = await offlineWithNote(format, 'a.md', 'A\n');
      await userDelete(h, 'a.md');

      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(server.applied).toEqual(['delete f1']);
      expect(disk(h)).toEqual([]);
      // The hashes it was checked by stay in the queue.
      expect(h.socket().pending('file:delete').payload).not.toHaveProperty('lastSynced');
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a queued rename of a note deleted and created again meanwhile, %s server',
  (format) => {
    it('is not sent, and the renamed copy the server had goes', async () => {
      const { h, server, docs } = await offlineWithNote(format, 'Untitled.md', 'A\n');
      await userRename(h, 'Untitled.md', 'Meeting.md');
      server.teammateDelete('f1');
      await server.teammateCreate('Untitled.md', 'teammate fresh note\n');

      await goOnline(h, {
        operations: recreatedOps('Untitled.md', 'f1'),
        yjsDocs: docs.snapshots(),
      });
      await docs.drive();

      expect(server.applied).toEqual(['delete f1', 'create Untitled.md']);
      expect(docs.live()).toEqual(['Untitled.md=teammate fresh note\n']);
      expect(disk(h)).toEqual(['Untitled.md=teammate fresh note\n']);
      expect(h.engine.getFileIdForPath('Untitled.md')).toBe('f1');
      expect(h.engine.getFileIdForPath('Meeting.md')).toBeNull();
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('is not sent, and a renamed copy with edits the server never got is kept as a note of its own', async () => {
      const { h, server, docs } = await offlineWithNote(format, 'Untitled.md', 'A\n');
      await userRename(h, 'Untitled.md', 'Meeting.md');
      // Edited after the rename, while Obsidian was closed.
      h.vault.files.set('Meeting.md', encode('A\nmine\n'));
      server.teammateDelete('f1');
      await server.teammateCreate('Untitled.md', 'teammate fresh note\n');

      await goOnline(h, {
        operations: recreatedOps('Untitled.md', 'f1'),
        yjsDocs: docs.snapshots(),
      });
      await docs.drive();

      expect(server.applied).toEqual(['delete f1', 'create Untitled.md', 'create Meeting.md']);
      expect(docs.live()).toEqual(['Meeting.md=A\nmine\n', 'Untitled.md=teammate fresh note\n']);
      expect(disk(h)).toEqual(['Meeting.md=A\nmine\n', 'Untitled.md=teammate fresh note\n']);
      expect(h.engine.getFileIdForPath('Untitled.md')).toBe('f1');
      expect(h.engine.getFileIdForPath('Meeting.md')).not.toBe('f1');
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a queued attachment edit of one deleted and uploaded again meanwhile, %s server',
  (format) => {
    it('is not sent: the new attachment comes down, the edit is kept next to it', async () => {
      const h = buildHarness({ offline: true });
      const server = new FakeServer(h, format);
      const v1 = new Uint8Array([1]).buffer;
      const v2 = new Uint8Array([2, 2]).buffer;
      const v3 = new Uint8Array([3, 3, 3]).buffer;
      const h1 = await sha256Hex(v1);
      h.vault.files.set('image.png', v1);
      h.log.setFileMeta({
        bindingId: 'b1',
        relativePath: 'image.png',
        serverFileId: 'f1',
        contentHash: h1,
        size: 1,
        fileType: 'BINARY',
        lastSyncedAt: 1,
      });
      server.add({ id: 'f1', path: 'image.png', fileType: 'BINARY', contentHash: h1, size: 1 });
      h.routes.set('GET /api/projects/p1/files/f1', () => bytes(v3));
      await h.engine.start();
      await flushAsync();

      // Edited offline: the upload waits in the queue.
      h.vault.files.set('image.png', v2);
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'image.png',
        source: 'obsidian',
      });
      expect(h.log.dequeueOperations('b1').map((o) => o.opType)).toEqual(['UPDATE']);
      // A teammate deleted it and uploaded another image.png.
      server.teammateDelete('f1');
      await server.teammateUpload('image.png', v3);

      await goOnline(h, { operations: recreatedOps('image.png', 'f1', 'BINARY') });
      await server.pump();
      await h.settle();
      await flushAsync(20);

      expect(h.vault.files.get('image.png')).toEqual(v3);
      const copies = [...h.vault.files.keys()].filter((p) => p.includes('.conflict-'));
      expect(copies).toHaveLength(1);
      expect(server.applied).toEqual(['delete f1', 'create image.png', `create ${copies[0]}`]);
      expect(h.vault.files.get(copies[0] ?? '')).toEqual(v2);
      expect(h.socket().created()).toEqual(copies);
      expect(h.engine.getFileIdForPath('image.png')).toBe('f1');
      await h.engine.stop();
    });

    it('a queued delete of an attachment changed meanwhile is not sent: the new one comes down', async () => {
      const h = buildHarness({ offline: true });
      const server = new FakeServer(h, format);
      const v1 = new Uint8Array([1]).buffer;
      const v3 = new Uint8Array([3, 3, 3]).buffer;
      const h1 = await sha256Hex(v1);
      h.vault.files.set('image.png', v1);
      h.log.setFileMeta({
        bindingId: 'b1',
        relativePath: 'image.png',
        serverFileId: 'f1',
        contentHash: h1,
        size: 1,
        fileType: 'BINARY',
        lastSyncedAt: 1,
      });
      server.add({ id: 'f1', path: 'image.png', fileType: 'BINARY', contentHash: h1, size: 1 });
      h.routes.set('GET /api/projects/p1/files/f1', () => bytes(v3));
      await h.engine.start();
      await flushAsync();
      await userDelete(h, 'image.png');
      server.teammateDelete('f1');
      await server.teammateUpload('image.png', v3);

      // A catch-up that does not show it: only the listing's content does.
      await goOnline(h);
      await server.pump();
      await h.settle();
      await flushAsync(20);

      expect(server.applied).toEqual(['delete f1', 'create image.png']);
      expect(h.vault.files.get('image.png')).toEqual(v3);
      expect(h.engine.getFileIdForPath('image.png')).toBe('f1');
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a note deleted here offline and saved anew under its name, %s server',
  (format) => {
    it('keeps a teammate’s edit made meanwhile: both notes stay', async () => {
      const { h, server, docs } = await offlineWithNote(format, 'a.md', 'A\n');
      await userDelete(h, 'a.md');
      h.vault.files.set('a.md', encode('fresh\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'create',
        path: 'a.md',
        source: 'obsidian',
      });
      // A teammate edited the note meanwhile.
      const theirs = docs.docs.get('f1');
      if (!theirs) throw new Error('no doc');
      theirs.getText('content').insert(0, 'teammate\n');
      server.add({
        id: 'f1',
        path: 'a.md',
        fileType: 'TEXT',
        contentHash: await sha256Hex('teammate\nA\n'),
        size: 11,
      });

      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(disk(h)).toEqual(['a.conflict-device-1.md=fresh\n', 'a.md=teammate\nA\n']);
      expect(docs.live()).toEqual(['a.conflict-device-1.md=fresh\n', 'a.md=teammate\nA\n']);
      expect(server.applied).toEqual(['create a.conflict-device-1.md']);
      expect(h.engine.getFileIdForPath('a.md')).toBe('f1');
      await h.engine.stop();
    });
  },
);
