/**
 * Obsidian's echo of the plugin's own renames.
 *
 * Obsidian fires a vault `rename` for every `adapter.rename`, the plugin's
 * own included, inside the call (app.js 1.13.7: `FileSystemAdapter.rename`
 * triggers `renamed`, `Vault.onChange` turns it into `rename`). The watcher
 * passed it on and the engine took it for the user's rename: it moved the
 * note's records to the name in the event and sent the rename to the server.
 * Since 0.3.8 the engine renames through a spare name (`Note.moving-<ts>.md`)
 * for a case-only rename and for names swapped while away. The echo of that
 * step renamed the note to the spare name for the whole team, left the real
 * file out of the index to be uploaded again, and names swapped while away
 * were renamed back and forth on the server forever.
 *
 * The test kit echoes every `MemoryVault.rename` through a real
 * `ObsidianWatcher`; the {@link FakeServer} broadcasts every operation to its
 * sender too, as the real server does.
 */
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import {
  FakeServer,
  buildHarness,
  bytes,
  connect,
  encode,
  eventLog,
  flushAsync,
  serverDocWith,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/** A file this device synced: on disk and in `state.json`. */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  content: ArrayBuffer,
  fileType: FileType = 'TEXT',
): Promise<string> {
  const hash = await sha256Hex(content);
  h.vault.files.set(path, content);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: content.byteLength,
    fileType,
    lastSyncedAt: 1,
    ...(fileType === 'TEXT' ? { foldedHash: hash } : {}),
  });
  return hash;
}

/** The server has the note `fileId` at `path` with `text`. */
function serverNote(server: FakeServer, fileId: string, path: string, hash: string): void {
  server.add({ id: fileId, path, fileType: 'TEXT', contentHash: hash, size: 2 });
}

const sentRenames = (h: Harness): unknown[] =>
  h
    .socket()
    .emits.filter((e) => e.event === 'file:rename' || e.event === 'file:move')
    .map((e) => e.payload);

const recorded = (h: Harness): string[] => h.log.listFileMeta('b1').map((m) => m.relativePath);

describe('SyncEngine — Obsidian’s echo of the plugin’s own renames', () => {
  it('follows a teammate’s case-only rename without sending anything back', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const hash = await remember(h, 'Note.md', 'f1', encode('A\n'));
    serverNote(server, 'f1', 'Note.md', hash);
    await connect(h, { yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')] });

    server.teammateRename('f1', 'note.md');
    await server.pump();
    await h.settle();

    // The server has only the teammate's rename; nothing went to `.moving-`.
    expect(server.applied).toEqual(['f1 Note.md -> note.md']);
    expect(sentRenames(h)).toEqual([]);
    expect([...h.vault.files.keys()]).toEqual(['note.md']);
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    expect(recorded(h)).toEqual(['note.md']);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('applies names a teammate swapped while away, and the server keeps them', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const ha = await remember(h, 'a.md', 'f1', encode('A\n'));
    const hb = await remember(h, 'b.md', 'f2', encode('B\n'));
    serverNote(server, 'f1', 'b.md', ha);
    serverNote(server, 'f2', 'a.md', hb);

    await connect(h, {
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('B\n'), 'f2')],
    });
    await server.pump();
    await h.settle();

    expect(server.applied).toEqual([]);
    expect(sentRenames(h)).toEqual([]);
    expect(h.vault.text('a.md')).toBe('B\n');
    expect(h.vault.text('b.md')).toBe('A\n');
    expect([...h.vault.files.keys()].sort()).toEqual(['a.md', 'b.md']);
    expect(h.engine.getFileIdForPath('a.md')).toBe('f2');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.socket().created()).toEqual([]);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('does not rename an attachment to the copy keep-both parks aside', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const synced = new Uint8Array([5, 5]).buffer;
    const local = new Uint8Array([1, 2, 3]).buffer;
    const newer = new Uint8Array([9, 9, 9, 9]).buffer;
    const hash = await remember(h, 'image.png', 'f1', synced, 'BINARY');
    h.vault.files.set('image.png', local);
    server.add({ id: 'f1', path: 'image.png', fileType: 'BINARY', contentHash: hash, size: 2 });
    await connect(h);

    // A teammate uploads a new version; the user keeps both.
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(newer));
    h.modal.binary.resolve('keep-both');
    h.socket().fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: await sha256Hex(newer),
      log: eventLog,
    });
    await flushAsync(40);
    await server.pump();
    await h.settle();

    expect(sentRenames(h)).toEqual([]);
    expect(server.pathOf('f1')).toBe('image.png');
    expect(h.engine.getFileIdForPath('image.png')).toBe('f1');
    expect(h.vault.files.get('image.png')).toBe(newer);
    const aside = [...h.vault.files.keys()].filter((p) => p !== 'image.png');
    expect(aside).toHaveLength(1);
    expect(h.vault.files.get(aside[0] ?? '')).toBe(local);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });
});

/**
 * The same echo, delivered straight to the engine rather than through the
 * watcher that drops it: the engine must not take its own renames for the
 * user's either — whatever route the event takes, and whether it arrives
 * inside the adapter call or later.
 */
describe('SyncEngine — its own renames reaching it as events', () => {
  function echoToEngine(h: Harness, when: 'inside' | 'later'): void {
    const rename0 = h.vault.rename.bind(h.vault);
    h.vault.rename = async (from, to): Promise<void> => {
      await rename0(from, to);
      const deliver = (): void =>
        void h.engine
          .handleVaultEvent({
            bindingId: 'b1',
            type: 'rename',
            oldPath: from,
            newPath: to,
            source: 'obsidian',
          })
          .catch((err: unknown) => h.eventErrors.push(err));
      if (when === 'inside') deliver();
      else setTimeout(deliver, 0);
    };
  }

  it('ignores an echo that arrives inside the adapter call', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const hash = await remember(h, 'Note.md', 'f1', encode('A\n'));
    serverNote(server, 'f1', 'Note.md', hash);
    await connect(h, { yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')] });
    echoToEngine(h, 'inside');

    server.teammateRename('f1', 'note.md');
    await server.pump();
    await flushAsync(40);

    expect(server.applied).toEqual(['f1 Note.md -> note.md']);
    expect(sentRenames(h)).toEqual([]);
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    expect(recorded(h)).toEqual(['note.md']);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('leaves alone a file a server rename is still moving when an echo arrives late', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const hash = await remember(h, 'Note.md', 'f1', encode('A\n'));
    serverNote(server, 'f1', 'Note.md', hash);
    await connect(h, { yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')] });
    echoToEngine(h, 'later');
    // Hold the second disk step (spare name → `note.md`): the late echo of
    // the first one arrives while the rename is still under way.
    const second = h.vault.gate('rename', 1);

    server.teammateRename('f1', 'note.md');
    await second.reached;
    await flushAsync(10);
    second.release();
    await server.pump();
    await flushAsync(40);

    expect(server.applied).toEqual(['f1 Note.md -> note.md']);
    expect(sentRenames(h)).toEqual([]);
    expect([...h.vault.files.keys()]).toEqual(['note.md']);
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    expect(recorded(h)).toEqual(['note.md']);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('ignores the echo of the copy keep-both parks aside', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const synced = new Uint8Array([5, 5]).buffer;
    const local = new Uint8Array([1, 2, 3]).buffer;
    const newer = new Uint8Array([9, 9, 9, 9]).buffer;
    const hash = await remember(h, 'image.png', 'f1', synced, 'BINARY');
    h.vault.files.set('image.png', local);
    server.add({ id: 'f1', path: 'image.png', fileType: 'BINARY', contentHash: hash, size: 2 });
    await connect(h);
    echoToEngine(h, 'inside');

    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(newer));
    h.modal.binary.resolve('keep-both');
    h.socket().fire('file:updated-binary', {
      fileId: 'f1',
      contentHash: await sha256Hex(newer),
      log: eventLog,
    });
    await flushAsync(40);
    await server.pump();
    await flushAsync(40);

    expect(sentRenames(h)).toEqual([]);
    expect(h.engine.getFileIdForPath('image.png')).toBe('f1');
    expect(h.vault.files.get('image.png')).toBe(newer);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });
});
