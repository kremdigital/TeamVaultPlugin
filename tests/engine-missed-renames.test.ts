/**
 * Renames the engine learns about late, or cannot follow.
 *
 * - A teammate renamed or moved a file while this device was away. The
 *   catch-up skips the RENAME as already applied (the listing has the new
 *   name), so the old copy used to stay on disk outside the index, and
 *   `initialPush` uploaded it as a new file — a duplicate for the whole team.
 * - A binary file created and then renamed while away was written under the
 *   name it was created with, not the one it has now.
 * - A file renamed on the server to a name this client never writes (the
 *   ignore list, names Windows opens as another file) stayed on disk under the
 *   old name and was uploaded again on the next connect. It is handled like a
 *   delete now — the counterpart of renaming a note to such a name locally.
 */
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import {
  buildHarness,
  bytes,
  connect,
  encode,
  eventLog,
  flushAsync,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/**
 * A file this device synced earlier: on disk, and in `state.json` at `path`
 * with the hash of `synced` — the disk may hold `onDisk` since. Returns the
 * synced hash.
 */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: ArrayBuffer,
  onDisk: ArrayBuffer = synced,
  fileType: FileType = 'TEXT',
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, onDisk);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: synced.byteLength,
    fileType,
    lastSyncedAt: 1,
    ...(fileType === 'TEXT' ? { foldedHash: hash } : {}),
  });
  return hash;
}

/** Disconnect and connect again, answering the join with no catch-up. */
async function reconnect(h: Harness): Promise<void> {
  h.socket().disconnect();
  h.socket().connect();
  await flushAsync();
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
  await flushAsync();
}

const rename = (from: string, to: string, fileId: string, clock: number) =>
  op('RENAME', from, to, { fileId }, clock);

describe('SyncEngine — a rename made while this device was away', () => {
  it('moves a note to its new name instead of uploading the old one as a new file', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('hello\n'));
    const serverDoc = serverDocWith('hello\n');
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', await sha256Hex('hello\n'), 6)];

    await connect(h, {
      operations: [rename('a.md', 'b.md', 'f1', 1)],
      yjsDocs: [snapshotOf(serverDoc, 'f1')],
    });

    expect(h.engine.getStatus()).toBe('connected');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('hello\n');
    expect(h.socket().created()).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    await h.engine.stop();
  });

  it('keeps an edit made to the note while away, under the new name', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('hello\n'), encode('hello\nlocal\n'));
    const serverDoc = serverDocWith('hello\n');
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', await sha256Hex('hello\n'), 6)];

    await connect(h, {
      operations: [rename('a.md', 'b.md', 'f1', 1)],
      yjsDocs: [snapshotOf(serverDoc, 'f1')],
    });

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('hello\nlocal\n');
    expect(h.doc.getText('b1', 'b.md')).toBe('hello\nlocal\n');
    // The edit goes to the server as an edit of the same file.
    expect(h.socket().emits.map((e) => e.event)).toContain('yjs:update');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('moves a binary file too, without downloading it again', async () => {
    const h = buildHarness();
    const img = new Uint8Array([1, 2, 3]).buffer;
    const hash = await remember(h, 'a.png', 'f1', img, img, 'BINARY');
    h.serverFiles = [serverFile('f1', 'b.png', 'BINARY', hash, 3)];

    await connect(h, { operations: [rename('a.png', 'b.png', 'f1', 1)] });

    expect([...h.vault.files.keys()]).toEqual(['b.png']);
    expect(h.vault.files.get('b.png')).toBe(img);
    expect(h.socket().created()).toEqual([]);
    expect(h.requests.filter((r) => r.path.endsWith('/files/f1'))).toEqual([]);
    await h.engine.stop();
  });

  it('follows a move out of the binding folder, as a live one does', async () => {
    const h = buildHarness({ localFolder: 'notes' });
    const hash = await remember(h, 'notes/a.md', 'f1', encode('hello\n'));
    h.serverFiles = [serverFile('f1', 'archive/a.md', 'TEXT', hash, 6)];

    await connect(h, { operations: [rename('notes/a.md', 'archive/a.md', 'f1', 1)] });

    expect([...h.vault.files.keys()]).toEqual(['archive/a.md']);
    expect(h.engine.getFileIdForPath('archive/a.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'notes/a.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('moves a file out of a name before another one moves into it', async () => {
    // Away: `a.md` → `c.md`, then `b.md` → `a.md`. The listing names the file
    // that moves INTO `a.md` first; moved in that order, it would find the
    // other note still there and park that one aside as a conflict copy.
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'));
    await remember(h, 'b.md', 'f2', encode('B\n'));
    h.serverFiles = [
      serverFile('f2', 'a.md', 'TEXT', await sha256Hex('B\n'), 2),
      serverFile('f1', 'c.md', 'TEXT', await sha256Hex('A\n'), 2),
    ];

    await connect(h, {
      operations: [rename('a.md', 'c.md', 'f1', 1), rename('b.md', 'a.md', 'f2', 2)],
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('B\n'), 'f2')],
    });

    expect([...h.vault.files.keys()].sort()).toEqual(['a.md', 'c.md']);
    expect(h.vault.text('a.md')).toBe('B\n');
    expect(h.vault.text('c.md')).toBe('A\n');
    expect(h.engine.getFileIdForPath('a.md')).toBe('f2');
    expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  // The catch-up carries at most 500 operations: the CREATE may be missing.
  it.each([
    ['with its CREATE in the catch-up', true],
    ['with its CREATE outside the catch-up', false],
  ])('leaves the old name to a file created there since (%s)', async (_label, withCreate) => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'));
    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f3', 'a.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];

    await connect(h, {
      operations: [
        rename('a.md', 'b.md', 'f1', 1),
        ...(withCreate ? [op('CREATE', 'a.md', null, { fileId: 'f3' }, 2)] : []),
      ],
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('new\n'), 'f3')],
    });

    expect([...h.vault.files.keys()].sort()).toEqual(['a.md', 'b.md']);
    expect(h.vault.text('a.md')).toBe('new\n');
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.log.getFileMeta('b1', 'a.md')?.serverFileId).toBe('f3');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a binary created and renamed while this device was away', () => {
  it('is written under its current name, not the one it was created with', async () => {
    const h = buildHarness();
    const img = new Uint8Array([137, 80, 78, 71]).buffer;
    h.serverFiles = [serverFile('f1', 'b.png', 'BINARY', await sha256Hex(img), 4)];
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(img));

    await connect(h, {
      operations: [
        op('CREATE', 'a.png', null, { fileId: 'f1', fileType: 'BINARY' }, 1),
        rename('a.png', 'b.png', 'f1', 2),
      ],
    });

    expect(h.engine.getStatus()).toBe('connected');
    expect([...h.vault.files.keys()]).toEqual(['b.png']);
    expect(h.vault.files.get('b.png')).toBe(img);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('does not put its bytes under the old name when another file took it', async () => {
    const h = buildHarness();
    const f = new Uint8Array([1, 1, 1]).buffer;
    const g = new Uint8Array([2, 2, 2, 2]).buffer;
    h.serverFiles = [
      serverFile('f', 'b.png', 'BINARY', await sha256Hex(f), 3),
      serverFile('g', 'a.png', 'BINARY', await sha256Hex(g), 4),
    ];
    h.routes.set('GET /api/projects/p1/files/f', () => bytes(f));
    h.routes.set('GET /api/projects/p1/files/g', () => bytes(g));

    await connect(h, {
      operations: [
        op('CREATE', 'a.png', null, { fileId: 'f', fileType: 'BINARY' }, 1),
        rename('a.png', 'b.png', 'f', 2),
        op('CREATE', 'a.png', null, { fileId: 'g', fileType: 'BINARY' }, 3),
      ],
    });

    expect(h.vault.files.get('b.png')).toBe(f);
    expect(h.vault.files.get('a.png')).toBe(g);
    expect(h.log.getFileMeta('b1', 'a.png')?.contentHash).toBe(await sha256Hex(g));
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a server rename to a name this client never writes', () => {
  const synced = encode('текст\n');

  // On the ignore list — a folder ending in `~`, a `.tmp` name, a Windows
  // service file — and a name Windows opens as another file (8.3 shape).
  it.each(['drafts~/x.md', 'drafts/x.tmp', 'drafts/desktop.ini', 'drafts/Draft~1.md'])(
    'works like a delete: the old name is not uploaded again (%s)',
    async (newPath) => {
      const h = buildHarness();
      const hash = await remember(h, 'drafts/x.md', 'f1', synced);
      h.serverFiles = [serverFile('f1', 'drafts/x.md', 'TEXT', hash, synced.byteLength)];
      await connect(h);

      h.socket().fire('file:renamed', { fileId: 'f1', newPath, log: eventLog });
      await flushAsync();

      expect(h.vault.files.has('drafts/x.md')).toBe(false);
      expect(h.vault.files.has(newPath)).toBe(false);
      expect(h.engine.getFileIdForPath('drafts/x.md')).toBeNull();
      expect(h.log.getFileMeta('b1', 'drafts/x.md')).toBeNull();
      // Nothing unsynced was on disk, so nothing to ask about.
      expect(h.calls).not.toContain('modal.resolveDeleteConflict');

      h.serverFiles = [serverFile('f1', newPath, 'TEXT', hash, synced.byteLength)];
      await reconnect(h);
      expect(h.socket().created()).toEqual([]);
      expect(h.statuses).not.toContain('error');
      await h.engine.stop();
    },
  );

  it('works the same when the rename happened while this device was away', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'drafts/x.md', 'f1', synced);
    h.serverFiles = [serverFile('f1', 'drafts~/x.md', 'TEXT', hash, synced.byteLength)];

    await connect(h, { operations: [rename('drafts/x.md', 'drafts~/x.md', 'f1', 1)] });

    expect(h.vault.files.has('drafts/x.md')).toBe(false);
    expect(h.log.getFileMeta('b1', 'drafts/x.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);

    // Renamed back to a name we sync later, the file is ours again.
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'drafts/y.md', log: eventLog });
    await flushAsync();
    expect(h.engine.getFileIdForPath('drafts/y.md')).toBe('f1');
    await h.engine.stop();
  });

  it('ignores such a name when the same catch-up renames the file on from it', async () => {
    // Away: `a.md` → `a.md~` → `c.md`. Only the last name counts; replaying
    // the first would delete the copy — asking first, as it holds an edit —
    // only to fetch it again under `c.md`.
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'), encode('A\nlocal\n'));
    h.serverFiles = [serverFile('f1', 'c.md', 'TEXT', await sha256Hex('A\n'), 2)];

    await connect(h, {
      operations: [rename('a.md', 'a.md~', 'f1', 1), rename('a.md~', 'c.md', 'f1', 2)],
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')],
    });

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.engine.getStatus()).toBe('connected');
    expect([...h.vault.files.keys()]).toEqual(['c.md']);
    expect(h.vault.text('c.md')).toBe('A\nlocal\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('adopts a file the listing had under such a name once it is renamed to one we sync', async () => {
    const h = buildHarness();
    h.serverFiles = [serverFile('f9', 'drafts~/y.md', 'TEXT', 'h', 1)];
    await connect(h);
    expect(h.engine.getFileIdForPath('drafts~/y.md')).toBeNull();

    h.socket().fire('file:renamed', { fileId: 'f9', newPath: 'drafts/y.md', log: eventLog });
    await flushAsync();

    expect(h.engine.getFileIdForPath('drafts/y.md')).toBe('f9');
    await h.engine.stop();
  });

  it('asks before deleting a copy with edits the server never got', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'drafts/x.md', 'f1', synced, encode('текст\nправка\n'));
    h.serverFiles = [serverFile('f1', 'drafts/x.md', 'TEXT', hash, synced.byteLength)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'drafts~/x.md', log: eventLog });
    await flushAsync();
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('drafts/x.md')).toBe(true);

    h.modal.del.resolve('delete-local');
    await flushAsync();
    expect(h.vault.files.has('drafts/x.md')).toBe(false);
    expect(h.log.getFileMeta('b1', 'drafts/x.md')).toBeNull();
    await h.engine.stop();
  });

  it('on "restore", moves the file back to its name and sends the local edits', async () => {
    const h = buildHarness();
    const img = new Uint8Array([1, 2, 3]).buffer;
    const edited = new Uint8Array([1, 2, 3, 4]).buffer;
    const hash = await remember(h, 'drafts/x.png', 'f1', img, edited, 'BINARY');
    h.serverFiles = [serverFile('f1', 'drafts/x.png', 'BINARY', hash, 3)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'drafts~/x.png', log: eventLog });
    await flushAsync();
    h.modal.del.resolve('restore-server');
    await flushAsync();

    // Moved back, not uploaded anew: a second file would start a history of
    // its own next to the one this copy belongs to.
    expect(h.socket().pending('file:rename').payload).toMatchObject({
      fileId: 'f1',
      filePath: 'drafts~/x.png',
      newPath: 'drafts/x.png',
    });
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync();
    expect(h.socket().pending('file:update-binary').payload).toMatchObject({
      fileId: 'f1',
      contentHash: await sha256Hex(edited),
    });
    expect(h.socket().created()).toEqual([]);
    expect(h.vault.files.get('drafts/x.png')).toBe(edited);
    expect(h.engine.getFileIdForPath('drafts/x.png')).toBe('f1');
    await h.engine.stop();
  });

  it('decides nothing once the file was renamed back while the user was asked', async () => {
    const h = buildHarness();
    const img = new Uint8Array([1, 2, 3]).buffer;
    const edited = new Uint8Array([1, 2, 3, 4]).buffer;
    const hash = await remember(h, 'drafts/x.png', 'f1', img, edited, 'BINARY');
    h.serverFiles = [serverFile('f1', 'drafts/x.png', 'BINARY', hash, 3)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'drafts~/x.png', log: eventLog });
    await flushAsync();
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    // The teammate renames it again, to a name we sync: the copy moves along.
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'drafts/y.png', log: eventLog });
    await flushAsync();
    expect(h.vault.files.get('drafts/y.png')).toBe(edited);

    h.modal.del.resolve('delete-local');
    await flushAsync();
    expect(h.vault.files.get('drafts/y.png')).toBe(edited);
    expect(h.engine.getFileIdForPath('drafts/y.png')).toBe('f1');
    await h.engine.stop();
  });

  it('leaves the file alone when the path is garbage rather than a name', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'note.md', 'f1', synced);
    h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', hash, synced.byteLength)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: '../outside.md', log: eventLog });
    await flushAsync();

    expect(h.vault.text('note.md')).toBe('текст\n');
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    await h.engine.stop();
  });
});
