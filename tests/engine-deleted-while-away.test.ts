/**
 * A file a teammate deleted while this device was away.
 *
 * It is not in the listing, so not in the index, and the catch-up's DELETE
 * finds nothing to apply to. Renamed before it was deleted, its tombstone is
 * under the new name, and `initialPush` uploaded the copy under the old name
 * as a new file: the deleted note came back for the whole team. Not renamed,
 * the copy stayed on disk, never synced again.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
  json,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/** `a.md` (f1) synced as `A\n`; the disk holds `onDisk`. */
async function remember(h: Harness, onDisk: string, folded?: string): Promise<string> {
  const hash = await sha256Hex('A\n');
  h.vault.files.set('a.md', encode(onDisk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'a.md',
    serverFileId: 'f1',
    contentHash: hash,
    size: 2,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: folded === undefined ? hash : await sha256Hex(folded),
  });
  return hash;
}

/** The server holds f1 as a tombstone at `path`. */
function tombstone(h: Harness, path: string, hash: string): void {
  h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () =>
    json({
      files: [{ ...serverFile('f1', path, 'TEXT', hash, 2), size: '2', deletedAt: '2026-01-02' }],
    }),
  );
}

describe('SyncEngine — a file deleted on the server while this device was away', () => {
  it('does not come back under its old name when it was renamed first', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\n');
    h.serverFiles = [];
    tombstone(h, 'b.md', hash);

    await connect(h, {
      operations: [
        op('RENAME', 'a.md', 'b.md', { fileId: 'f1' }, 1),
        op('DELETE', 'b.md', null, { fileId: 'f1' }, 2),
      ],
    });
    await flushAsync(20);

    expect(h.socket().created()).toEqual([]);
    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('is removed from the disk when it was deleted under its name', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\n');
    h.serverFiles = [];
    tombstone(h, 'a.md', hash);

    await connect(h, { operations: [op('DELETE', 'a.md', null, { fileId: 'f1' }, 1)] });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('asks first about an edit folded while offline, and keeps it on "restore"', async () => {
    const h = buildHarness();
    // Folded into the doc while offline: the marker names the disk, but the
    // doc never went back to the server — the catch-up did not know the file.
    const hash = await remember(h, 'A\noffline\n', 'A\noffline\n');
    h.serverFiles = [];
    tombstone(h, 'b.md', hash);

    await connect(h, {
      operations: [
        op('RENAME', 'a.md', 'b.md', { fileId: 'f1' }, 1),
        op('DELETE', 'b.md', null, { fileId: 'f1' }, 2),
      ],
    });
    await flushAsync(20);
    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.text('a.md')).toBe('A\noffline\n');

    h.modal.del.resolve('restore-server');
    await flushAsync(20);
    expect(h.socket().created()).toEqual(['a.md']);
    expect(h.vault.text('a.md')).toBe('A\noffline\n');
    await h.engine.stop();
  });

  it('on "restore", starts the note from the server’s doc, so edits not sent before come back once', async () => {
    const idb = new FakeIndexedDb();
    // The note's history here: its text from the server, and a line folded
    // while offline, never sent.
    const old = serverDocWith('A\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(old));
    local.getText('content').insert(2, 'offline\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(local)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'A\noffline\n', 'A\noffline\n');
    h.serverFiles = [];
    tombstone(h, 'a.md', hash);
    await connect(h, { operations: [op('DELETE', 'a.md', null, { fileId: 'f1' }, 1)] });
    await flushAsync(20);

    h.modal.del.resolve('restore-server');
    await flushAsync(20);
    // The server revives f1 from this copy.
    h.socket()
      .pending('file:create', 'a.md')
      .ack({
        ok: true,
        outcome: { kind: 'created', fileId: 'f1', path: 'a.md' },
      });
    await flushAsync(20);
    expect(h.engine.getFileIdForPath('a.md')).toBe('f1');
    expect(idb.deleted).toContain(dbNameOf('a.md'));

    // A server that continues the history on revival: the old text deleted,
    // the copy's text inserted on top.
    const revived = new Y.Doc();
    Y.applyUpdate(revived, Y.encodeStateAsUpdate(old));
    const text = revived.getText('content');
    text.delete(0, text.length);
    text.insert(0, 'A\noffline\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\noffline\n'), 10)];
    h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () => json({ files: [] }));
    const mark = h.socket().emits.length;
    h.socket().disconnect();
    h.socket().connect();
    await flushAsync();
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: [snapshotOf(revived, 'f1')] });
    await flushAsync(40);
    // The next save brings the note's doc up.
    h.vault.files.set('a.md', encode('A\noffline\nmore\n'));
    const saving = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(revived)),
        stateVector: Array.from(Y.encodeStateVector(revived)),
      });
    }
    await saving;
    await flushAsync(20);
    for (const e of h.socket().emits.slice(mark)) {
      const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
      if (e.event === 'yjs:update' && p.fileId === 'f1' && p.update) {
        Y.applyUpdate(revived, Uint8Array.from(p.update));
      }
    }

    expect(revived.getText('content').toJSON()).toBe('A\noffline\nmore\n');
    expect(h.vault.text('a.md')).toBe('A\noffline\nmore\n');
    expect(h.socket().created()).toEqual(['a.md']);
    await h.engine.stop();
  });

  it('asks first, and removes it on "delete"', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'A\nmine\n');
    h.serverFiles = [];
    tombstone(h, 'a.md', hash);

    await connect(h);
    await flushAsync(20);
    expect(h.calls).toContain('modal.resolveDeleteConflict');

    h.modal.del.resolve('delete-local');
    await flushAsync(20);
    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});
