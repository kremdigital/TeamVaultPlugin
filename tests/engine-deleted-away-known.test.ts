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
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  buildHarness,
  connect,
  deferred,
  encode,
  eventLog,
  flushAsync,
  json,
  serverDocWith,
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

/** Apply to `serverDoc` every `yjs:update` the engine sent for `fileId`. */
function applySent(h: Harness, serverDoc: Y.Doc, fileId: string): void {
  for (const e of h.socket().emits) {
    const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
    if (e.event === 'yjs:update' && p.fileId === fileId && p.update) {
      Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
    }
  }
}

/** A teammate creates `path` again; the server revives `fileId` there with `text`. */
function createdAgain(h: Harness, fileId: string, path: string, text: string): Y.Doc {
  const doc = serverDocWith(text);
  h.socket().fire('file:created', { result: { outcome: { fileId, path } }, log: eventLog });
  h.socket().fire('yjs:update', { fileId, update: Array.from(Y.encodeStateAsUpdate(doc)) });
  return doc;
}

describe('SyncEngine — a note deleted while away and created again during the question', () => {
  it('removes the copies the server had before asking, so a note created again meanwhile stays', async () => {
    const h = buildHarness();
    // a.md: typed and folded while offline, never sent — asked about.
    await remember(h, 'a.md', 'f1', 'A\nunsent\n');
    // b.md: the server had this copy — removed without a question.
    await remember(h, 'b.md', 'f2', 'A\n');
    h.serverFiles = [];
    await tombstones(h, [
      ['f1', 'a.md', 'A\n'],
      ['f2', 'b.md', 'A\n'],
    ]);
    await history(h, 'f1', ['A\n']);

    await connect(h);
    await flushAsync(40);
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('b.md')).toBe(false);

    // While the question is open, a teammate creates b.md again.
    const b = createdAgain(h, 'f2', 'b.md', 'revived\n');
    await flushAsync(40);
    applySent(h, b, 'f2');
    expect(h.vault.text('b.md')).toBe('revived\n');
    expect(b.getText('content').toJSON()).toBe('revived\n');

    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect(h.vault.files.has('a.md')).toBe(false);
    expect(h.vault.text('b.md')).toBe('revived\n');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f2');
    await h.engine.stop();
  });

  it.each([['delete-local' as const], ['restore-server' as const]])(
    'keeps the copy asked about aside when its note is created again; the answer (%s) leaves the new note be',
    async (answer) => {
      const h = buildHarness();
      await remember(h, 'a.md', 'f1', 'A\nunsent\n');
      h.serverFiles = [];
      await tombstones(h, [['f1', 'a.md', 'A\n']]);
      await history(h, 'f1', ['A\n']);

      await connect(h);
      await flushAsync(40);
      expect(h.calls).toContain('modal.resolveDeleteConflict');

      const a = createdAgain(h, 'f1', 'a.md', 'revived\n');
      await flushAsync(40);
      applySent(h, a, 'f1');
      const aside = [...h.vault.files.keys()].filter((p) => p.includes('.conflict-'));
      expect(aside).toHaveLength(1);
      expect(h.vault.text(aside[0] ?? '')).toBe('A\nunsent\n');
      expect(h.vault.text('a.md')).toBe('revived\n');
      expect(a.getText('content').toJSON()).toBe('revived\n');

      h.modal.del.resolve(answer);
      await flushAsync(20);
      expect(h.vault.text('a.md')).toBe('revived\n');
      expect(h.engine.getFileIdForPath('a.md')).toBe('f1');
      expect(h.vault.text(aside[0] ?? '')).toBe('A\nunsent\n');
      // Nothing sent over the note created again, either.
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    },
  );

  it('keeps the note’s first snapshot waiting while its copy is moved aside', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', 'A\nunsent\n');
    h.serverFiles = [];
    await tombstones(h, [['f1', 'a.md', 'A\n']]);
    await history(h, 'f1', ['A\n']);
    await connect(h);
    await flushAsync(40);
    expect(h.calls).toContain('modal.resolveDeleteConflict');

    // Moving the copy aside takes a while (an antivirus holds the file).
    const slow = h.vault.gate('rename');
    const a = createdAgain(h, 'f1', 'a.md', 'revived\n');
    await slow.reached;
    await flushAsync(40);
    slow.release();
    await flushAsync(40);
    applySent(h, a, 'f1');

    expect(a.getText('content').toJSON()).toBe('revived\n');
    expect(h.vault.text('a.md')).toBe('revived\n');
    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    await h.engine.stop();
  });

  it('leaves a copy whose note is created again while its check waits on the server', async () => {
    const h = buildHarness();
    // Edited and sent here; the server moved on since, and had this copy once.
    await remember(h, 'b.md', 'f2', 'A\nB\n');
    h.serverFiles = [];
    await tombstones(h, [['f2', 'b.md', 'A\nB\nC\n']]);
    const versions = deferred<void>();
    const listed = await Promise.all(
      ['A\n', 'A\nB\n', 'A\nB\nC\n'].map(async (text, i) => ({
        id: `v${i}`,
        contentHash: await sha256Hex(text),
        size: text.length,
        createdAt: '2026-01-01',
        authorId: 'u2',
        fileId: 'f2',
      })),
    );
    h.routes.set('GET /api/projects/p1/files/f2/versions', async () => {
      await versions.promise;
      return json({ versions: listed });
    });

    await connect(h);
    await flushAsync(20);
    const b = createdAgain(h, 'f2', 'b.md', 'revived\n');
    await flushAsync(40);
    versions.resolve();
    await flushAsync(40);
    applySent(h, b, 'f2');

    expect(b.getText('content').toJSON()).toBe('revived\n');
    expect(h.vault.text('b.md')).toBe('revived\n');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f2');
    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    await h.engine.stop();
  });
});
