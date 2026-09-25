/**
 * A note a teammate renamed, while this device was away, to a name this
 * client never writes (`Why?.md`, `Notes.`, `Draft~1.md`, a folder `Archive~`):
 * the servers before the path gate took such names, and 0.3.7, the web and
 * MCP still send the ones the plugin ignores.
 *
 * The index refresh handles it like a delete. It used to ask about "unsaved
 * edits" there and then, even when the server had exactly that copy, and the
 * question held the whole connect: no index, no catch-up, status `syncing`,
 * every other note waiting for the answer — one question after another when
 * a folder moved.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { Logger, type LogEntry } from '@/utils/logger';
import {
  buildHarness,
  deferred,
  encode,
  eventLog,
  flushAsync,
  json,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/** `path` (f1) synced as "v1\n"; `disk` on disk, folded as `folded`. */
async function remember(h: Harness, disk: string, folded = 'v1\n'): Promise<void> {
  h.vault.files.set('note.md', encode(disk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'note.md',
    serverFileId: 'f1',
    contentHash: await sha256Hex('v1\n'),
    size: 3,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: await sha256Hex(folded),
  });
}

/**
 * `b.md` (f2), synced as "B\n" and edited by a teammate since: the listing
 * entry and the catch-up snapshot.
 */
async function teammateNote(
  h: Harness,
): Promise<{ listed: ReturnType<typeof serverFile>; doc: Y.Doc }> {
  h.vault.files.set('b.md', encode('B\n'));
  const synced = await sha256Hex('B\n');
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'b.md',
    serverFileId: 'f2',
    contentHash: synced,
    size: 2,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: synced,
  });
  const doc = serverDocWith('B\n');
  doc.getText('content').insert(0, 'teammate\n');
  return {
    listed: serverFile('f2', 'b.md', 'TEXT', await sha256Hex('teammate\nB\n'), 11),
    doc,
  };
}

/** Start, and answer the join with f1 renamed to `note?.md` and b.md's snapshot. */
async function start(h: Harness, doc: Y.Doc): Promise<void> {
  await h.engine.start();
  h.socket()
    .pending('project:join')
    .ack({
      ok: true,
      operations: [op('RENAME', 'note.md', 'note?.md', { fileId: 'f1' }, 1)],
      yjsDocs: [snapshotOf(doc, 'f2')],
    });
  await flushAsync(60);
}

/** Record how many calls the engine had made when it reached `connected`. */
function callsAtConnected(h: Harness): { at: number } {
  const seen = { at: -1 };
  h.engine.onStatus((status) => {
    if (status === 'connected' && seen.at < 0) seen.at = h.calls.length;
  });
  return seen;
}

describe('SyncEngine — a note renamed while away to a name this client never writes', () => {
  it('does not ask about a save the server has, and the rest of the connect goes on', async () => {
    const h = buildHarness();
    const saved = 'v1\nmine\n';
    // Saved and sent in an earlier session: the marker names the disk.
    await remember(h, saved, saved);
    const b = await teammateNote(h);
    h.serverFiles = [
      serverFile('f1', 'note?.md', 'TEXT', await sha256Hex(saved), saved.length),
      b.listed,
    ];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));

    await start(h, b.doc);

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.engine.getStatus()).toBe('connected');
    expect(h.vault.text('b.md')).toBe('teammate\nB\n');
    expect(h.vault.files.has('note.md')).toBe(false);
    expect(h.log.getFileMeta('b1', 'note.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('does not ask when the server’s history has the copy', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nmine\n', 'v1\nmine\n');
    const b = await teammateNote(h);
    h.serverFiles = [
      serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\nmine\nmore\n'), 14),
      b.listed,
    ];
    const versions = await Promise.all(
      ['v1\n', 'v1\nmine\n'].map(async (text, i) => ({
        id: `v${i}`,
        contentHash: await sha256Hex(text),
        size: text.length,
        createdAt: '2026-01-01',
        authorId: 'u2',
        fileId: 'f1',
      })),
    );
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions }));

    await start(h, b.doc);

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('note.md')).toBe(false);
    await h.engine.stop();
  });

  it('asks about edits the server never got once connected, the rest of the catch-up applied', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3), b.listed];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
    const connected = callsAtConnected(h);

    await start(h, b.doc);

    const asked = h.calls.indexOf('modal.resolveDeleteConflict');
    expect(asked).toBeGreaterThan(connected.at);
    expect(connected.at).toBeGreaterThan(-1);
    expect(h.vault.text('b.md')).toBe('teammate\nB\n');
    // Waiting for the answer, the copy is neither uploaded nor written over.
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    expect(h.socket().created()).toEqual([]);

    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect(h.vault.files.has('note.md')).toBe(false);
    expect(h.log.getFileMeta('b1', 'note.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('on "restore", moves the note back to its name', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3), b.listed];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));

    await start(h, b.doc);
    h.modal.del.resolve('restore-server');
    await flushAsync(20);

    expect(h.socket().pending('file:rename').payload).toMatchObject({
      fileId: 'f1',
      filePath: 'note?.md',
      newPath: 'note.md',
    });
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('on "restore", takes the server’s broadcast of the move back for its own', async () => {
    const entries: LogEntry[] = [];
    const h = buildHarness({ logger: new Logger('debug', { write: (e) => entries.push(e) }) });
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3), b.listed];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));

    await start(h, b.doc);
    h.modal.del.resolve('restore-server');
    await flushAsync(20);
    // Broadcast to the whole room, this device included, before the ack.
    h.socket().fire('file:renamed', {
      fileId: 'f1',
      newPath: 'note.md',
      requestedPath: 'note.md',
      outcome: { kind: 'renamed', fileId: 'f1', from: 'note?.md', to: 'note.md' },
      clientId: 'device-1',
      log: eventLog,
    });
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);

    expect(entries.filter((e) => e.message.includes('uses the same id'))).toEqual([]);
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    await h.engine.stop();
  });

  it('takes the copy along when the note is renamed back to a name we sync before the question', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3), b.listed];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
    // The pass that comes before the question waits on the server.
    const tombstones = deferred<void>();
    h.routes.set('GET /api/projects/p1/files?includeDeleted=true', async () => {
      await tombstones.promise;
      return json({ files: [] });
    });

    await start(h, b.doc);
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'note2.md', log: eventLog });
    await flushAsync(20);
    tombstones.resolve();
    await flushAsync(20);

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('note.md')).toBe(false);
    expect(h.vault.text('note2.md')).toBe('v1\nunsent\n');
    expect(h.engine.getFileIdForPath('note2.md')).toBe('f1');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('keeps a note created under the old name meanwhile off the copy waiting for its question', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    const created = serverDocWith('new\n');
    h.serverFiles = [
      serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3),
      serverFile('f3', 'note.md', 'TEXT', await sha256Hex('new\n'), 4),
      b.listed,
    ];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));

    await h.engine.start();
    h.socket()
      .pending('project:join')
      .ack({
        ok: true,
        operations: [
          op('RENAME', 'note.md', 'note?.md', { fileId: 'f1' }, 1),
          op('CREATE', 'note.md', null, { fileId: 'f3', fileType: 'TEXT' }, 2),
        ],
        yjsDocs: [snapshotOf(b.doc, 'f2'), snapshotOf(created, 'f3')],
      });
    await flushAsync(60);
    for (const e of h.socket().emits) {
      const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
      if (e.event === 'yjs:update' && p.fileId === 'f3' && p.update) {
        Y.applyUpdate(created, Uint8Array.from(p.update));
      }
    }

    // The copy was not folded into the new note, nor written over.
    expect(created.getText('content').toJSON()).toBe('new\n');
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect(created.getText('content').toJSON()).toBe('new\n');
    await h.engine.stop();
  });

  it('gives the old name at once to a note created there, when the copy was the server’s', async () => {
    const h = buildHarness();
    const saved = 'v1\nmine\n';
    await remember(h, saved, saved);
    const b = await teammateNote(h);
    const created = serverDocWith('new\n');
    h.serverFiles = [
      serverFile('f1', 'note?.md', 'TEXT', await sha256Hex(saved), saved.length),
      serverFile('f3', 'note.md', 'TEXT', await sha256Hex('new\n'), 4),
      b.listed,
    ];

    await h.engine.start();
    h.socket()
      .pending('project:join')
      .ack({
        ok: true,
        operations: [
          op('RENAME', 'note.md', 'note?.md', { fileId: 'f1' }, 1),
          op('CREATE', 'note.md', null, { fileId: 'f3', fileType: 'TEXT' }, 2),
        ],
        yjsDocs: [snapshotOf(b.doc, 'f2'), snapshotOf(created, 'f3')],
      });
    await flushAsync(60);

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.vault.text('note.md')).toBe('new\n');
    expect(h.engine.getFileIdForPath('note.md')).toBe('f3');
    await h.engine.stop();
  });

  it('forgets a question that never came when the next connect finds nothing to ask', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3), b.listed];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
    // The connect drops before its question.
    const held = deferred<void>();
    h.routes.set('GET /api/projects/p1/files?includeDeleted=true', async () => {
      await held.promise;
      return json({ files: [] });
    });
    await start(h, b.doc);
    h.socket().disconnect();
    await flushAsync();
    // Offline, the user deletes the copy. On the next connect, before its own
    // first upload pass is through, a new note is saved under the name.
    h.vault.files.delete('note.md');
    h.socket().connect();
    await flushAsync();
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: [snapshotOf(b.doc, 'f2')] });
    await flushAsync(40);

    h.vault.files.set('note.md', encode('fresh\n'));
    const creating = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'note.md',
      source: 'obsidian',
    });
    await flushAsync(20);

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.socket().created()).toEqual(['note.md']);
    h.socket().pending('file:create', 'note.md').ack({ ok: false, error: 'offline' });
    await creating;
    held.resolve();
    await flushAsync(20);
    await h.engine.stop();
  });

  it('moves nothing into the old name until the question is answered', async () => {
    const h = buildHarness();
    await remember(h, 'v1\nunsent\n');
    const b = await teammateNote(h);
    // other.md (f3), renamed by a teammate into the name note.md left.
    h.vault.files.set('other.md', encode('O\n'));
    const other = await sha256Hex('O\n');
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'other.md',
      serverFileId: 'f3',
      contentHash: other,
      size: 2,
      fileType: 'TEXT',
      lastSyncedAt: 1,
      foldedHash: other,
    });
    h.serverFiles = [
      serverFile('f1', 'note?.md', 'TEXT', await sha256Hex('v1\n'), 3),
      serverFile('f3', 'note.md', 'TEXT', other, 2),
      b.listed,
    ];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));

    await start(h, b.doc);

    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    expect(h.vault.text('other.md')).toBe('O\n');
    expect([...h.vault.files.keys()].filter((p) => p.includes('.conflict-'))).toEqual([]);
    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});
