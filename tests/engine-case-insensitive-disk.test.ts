/**
 * The server tells names apart by case; a Windows or macOS disk does not. A
 * teammate on Linux, the web editor or MCP can give a file a name that
 * differs from another file's only in case — `A.md` next to `a.md` — and can
 * rename a folder only in case (`Notes/` → `notes/`).
 *
 * Before: the second name was taken for a free one. A file moving into it
 * parked the first file aside under a conflict name, while that file's record
 * stayed on the name — which now opened the other file: the next edit of the
 * first note put the other note's text into it for everyone. A new note under
 * such a name was recorded over the copy of the first one, and its first
 * snapshot replaced its text with the first note's for everyone. And after a
 * folder renamed only in case, Obsidian listed the notes under the folder's
 * old case at the next start: each was uploaded as a new note, a duplicate of
 * every note in the folder for the whole team.
 *
 * Now a name another file here takes for its own waits, as a name another
 * file holds does (see `waitForName`), and a file listed by the disk under
 * another case of a name this device has is that file.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  caseInsensitiveDisk,
  connect,
  encode,
  flushAsync,
  remoteEdit,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

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

/** Notes synced on a case-insensitive disk; the engine connected. */
async function onWindows(
  format: BroadcastFormat,
  notes: Array<[string, string, string]>,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness();
  caseInsensitiveDisk(h.vault);
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  for (const [id, path, text] of notes) {
    await remember(h, path, id, text);
    await docs.add(id, path, text);
  }
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  return { h, server, docs };
}

/** Obsidian started again: a new engine on the same disk, log and docs. */
async function restart(h: Harness, server: FakeServer, docs: ServerDocs): Promise<Harness> {
  await h.engine.stop();
  const next = buildHarness({ predecessor: h });
  server.attach(next);
  docs.attach(next);
  await connect(next, { operations: server.catchupFor(), yjsDocs: docs.snapshots() });
  await docs.drive();
  return next;
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a name that differs from another file’s only in case, case-insensitive disk, %s broadcasts',
  (format) => {
    it('a teammate renames a note to it: the rename waits, and neither note takes the other’s text', async () => {
      const { h, server, docs } = await onWindows(format, [
        ['f1', 'a.md', 'A\n'],
        ['f2', 'x.md', 'X\n'],
      ]);
      server.teammateRename('f2', 'A.md');
      await flushAsync(40);
      await docs.drive();
      // `A.md` would open `a.md` here: x.md stays where it is.
      expect(disk(h)).toEqual(['a.md=A\n', 'x.md=X\n']);

      // A teammate edits a.md.
      remoteEdit(h, docs.docs.get('f1')!, 'f1', 'edit\n');
      await flushAsync(40);
      await docs.drive();
      expect(docs.text('f1')).toBe('edit\nA\n');
      expect(docs.text('f2')).toBe('X\n');
      expect(disk(h)).toEqual(['a.md=edit\nA\n', 'x.md=X\n']);

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['A.md=X\n', 'a.md=edit\nA\n']);
      expect(disk(next)).toEqual(['a.md=edit\nA\n', 'x.md=X\n']);
      await next.engine.stop();
    });

    it('a teammate creates a note under it: the note waits, and the first one keeps its text', async () => {
      const { h, server, docs } = await onWindows(format, [['f1', 'a.md', 'A\n']]);
      await server.teammateCreate('A.md', 'NEW\n');
      await flushAsync(40);
      await docs.drive();

      expect(docs.live()).toEqual(['A.md=NEW\n', 'a.md=A\n']);
      expect(disk(h)).toEqual(['a.md=A\n']);
      expect(h.engine.getFileIdForPath('A.md')).toBeNull();

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['A.md=NEW\n', 'a.md=A\n']);
      expect(disk(next)).toEqual(['a.md=A\n']);

      // The first note renamed away: the name is free here, and the new one comes in.
      await next.vault.rename('a.md', 'b.md');
      await next.settle();
      await docs.drive();
      expect(docs.live()).toEqual(['A.md=NEW\n', 'b.md=A\n']);
      expect(disk(next)).toEqual(['A.md=NEW\n', 'b.md=A\n']);
      await next.engine.stop();
    });

    it('the listing has the other note first: the note this device has keeps the name', async () => {
      const h = buildHarness();
      caseInsensitiveDisk(h.vault);
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h);
      // Made on the server while this device was away; listed before a.md.
      await docs.add('f9', 'A.md', 'NEW\n');
      await remember(h, 'a.md', 'f1', 'A\n');
      await docs.add('f1', 'a.md', 'A\n');
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(docs.live()).toEqual(['A.md=NEW\n', 'a.md=A\n']);
      expect(disk(h)).toEqual(['a.md=A\n']);
      expect(h.socket().created()).toEqual([]);

      const next = await restart(h, server, docs);
      expect(docs.live()).toEqual(['A.md=NEW\n', 'a.md=A\n']);
      expect(disk(next)).toEqual(['a.md=A\n']);
      await next.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a folder renamed only in case by a teammate, case-insensitive disk, %s broadcasts',
  (format) => {
    it('uploads nothing at the next start, when the disk lists the folder’s old case', async () => {
      const { h, server, docs } = await onWindows(format, [
        ['f1', 'Notes/a.md', 'A\n'],
        ['f2', 'Notes/b.md', 'B\n'],
      ]);
      server.teammateRename('f1', 'notes/a.md');
      server.teammateRename('f2', 'notes/b.md');
      await flushAsync(40);
      await docs.drive();
      expect(disk(h)).toEqual(['notes/a.md=A\n', 'notes/b.md=B\n']);
      await h.engine.stop();

      // The folder itself kept its case on disk: Obsidian lists it so when
      // it starts again.
      for (const name of ['a.md', 'b.md']) {
        const buf = h.vault.files.get(`notes/${name}`) as ArrayBuffer;
        h.vault.files.delete(`notes/${name}`);
        h.vault.files.set(`Notes/${name}`, buf);
      }
      const next = buildHarness({ predecessor: h });
      server.attach(next);
      docs.attach(next);
      await connect(next, { operations: server.catchupFor(), yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['notes/a.md=A\n', 'notes/b.md=B\n']);

      // An edit of the note under the folder's old case is an edit of it.
      next.vault.files.set('Notes/a.md', encode('A\nmine\n'));
      const saved = next.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Notes/a.md',
        source: 'obsidian',
      });
      await docs.drive();
      await saved;
      await docs.drive();
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['notes/a.md=A\nmine\n', 'notes/b.md=B\n']);

      // And a delete of the folder under its old case deletes its notes.
      next.vault.files.delete('Notes/a.md');
      next.vault.files.delete('Notes/b.md');
      const deleted = next.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'delete',
        path: 'Notes',
        isFolder: true,
        source: 'obsidian',
      });
      await docs.drive();
      await deleted;
      expect(docs.live()).toEqual([]);
      await next.engine.stop();
    });
  },
);
