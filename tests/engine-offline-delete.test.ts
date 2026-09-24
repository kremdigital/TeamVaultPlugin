/**
 * A note deleted on this device while offline.
 *
 * The DELETE waits in the offline queue until the next connect. The file used
 * to stay in the index, in `state.json` and in its doc until the ack: the
 * catch-up, which runs before the queue drains, wrote the deleted note back to
 * disk, where it stayed after the delete went out, never synced again. A new
 * note saved under the name meanwhile (Obsidian reuses "Untitled") was taken
 * for the deleted one: its text went to the server as the deleted note's, and
 * the new note itself was never uploaded.
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
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/** `path` (f1) synced as `text`. */
async function remember(h: Harness, path: string, text: string): Promise<string> {
  const hash = await sha256Hex(text);
  h.vault.files.set(path, encode(text));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: 'f1',
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
  return hash;
}

const event = (h: Harness, type: 'create' | 'delete', path: string): Promise<void> =>
  h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });

/** Apply the `yjs:update`s sent for f1 from emit `from` on. */
function applySent(h: Harness, serverDoc: Y.Doc, from: number): void {
  for (const e of h.socket().emits.slice(from)) {
    const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
    if (e.event === 'yjs:update' && p.fileId === 'f1' && p.update) {
      Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
    }
  }
}

/** The server deleted f1 (at `path`) once the delete is acked. */
function deleteOnAck(h: Harness, path: string, hash: string, size: number): void {
  const tombstone = { ...serverFile('f1', path, 'TEXT', hash, size), deletedAt: '2026-01-02' };
  h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () =>
    json({ files: [{ ...tombstone, size: String(size) }] }),
  );
}

/** Connected with `path` (f1, `text`) synced; then offline. */
async function offlineWith(
  h: Harness,
  path: string,
  text: string,
): Promise<{ d1: Y.Doc; hash: string }> {
  const hash = await remember(h, path, text);
  const d1 = serverDocWith(text);
  h.serverFiles = [serverFile('f1', path, 'TEXT', hash, encode(text).byteLength)];
  await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
  await flushAsync(20);
  h.socket().disconnect();
  await flushAsync();
  return { d1, hash };
}

describe('SyncEngine — a note deleted here while offline', () => {
  it('is not written back by the catch-up, nor left on disk after the delete', async () => {
    const h = buildHarness();
    const { d1, hash } = await offlineWith(h, 'a.md', 'old\n');
    h.vault.files.delete('a.md');
    await event(h, 'delete', 'a.md');
    await flushAsync();

    h.socket().connect();
    await flushAsync();
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(30);
    expect([...h.vault.files.keys()]).toEqual([]);

    deleteOnAck(h, 'a.md', hash, 4);
    h.socket().pending('file:delete', 'a.md').ack({ ok: true });
    await flushAsync(40);

    expect([...h.vault.files.keys()]).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    expect(h.engine.getFileIdForPath('a.md')).toBeNull();
    expect(h.log.listFileMeta('b1')).toEqual([]);
    await h.engine.stop();
  });

  it('keeps a new note saved under its name apart, and uploads it', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const { d1 } = await offlineWith(h, 'Untitled.md', 'old\n');
    // The note was open: it has a doc and a store.
    await h.doc.whenSynced('b1', 'Untitled.md');
    expect(idb.dbs.has(dbNameOf('Untitled.md'))).toBe(true);
    h.vault.files.delete('Untitled.md');
    await event(h, 'delete', 'Untitled.md');
    await flushAsync();
    // The deleted note's history is gone with it.
    expect(idb.dbs.has(dbNameOf('Untitled.md'))).toBe(false);
    h.vault.files.set('Untitled.md', encode('brand new\n'));
    await event(h, 'create', 'Untitled.md');
    await flushAsync();
    // A new file, not an edit of the deleted one.
    expect(h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'Untitled.md')).toBeNull();
    const queued = h.log.dequeueOperations('b1').map((o) => [o.opType, o.filePath]);
    expect(queued).toEqual([
      ['DELETE', 'Untitled.md'],
      ['CREATE', 'Untitled.md'],
    ]);

    h.socket().connect();
    await flushAsync();
    const mark = h.socket().emits.length;
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(30);
    applySent(h, d1, mark);

    // Nothing of the new note went out as the deleted one's.
    expect(d1.getText('content').toJSON()).toBe('old\n');
    expect(h.vault.text('Untitled.md')).toBe('brand new\n');
    // The tombstone lookup fails, so the pass after the drain uploads nothing:
    // the queue alone brings the new note to the server.
    h.routes.set('GET /api/projects/p1/files?includeDeleted=true', () => json({}, 500));
    h.socket().pending('file:delete', 'Untitled.md').ack({ ok: true });
    await flushAsync(30);

    const create = h.socket().pending('file:create', 'Untitled.md');
    const sent = Uint8Array.from((create.payload as { data: number[] }).data);
    expect(new TextDecoder().decode(sent)).toBe('brand new\n');
    create.ack({ ok: true, outcome: { fileId: 'f2', path: 'Untitled.md' } });
    await flushAsync(30);
    expect(h.socket().created()).toEqual(['Untitled.md']);
    expect(h.engine.getFileIdForPath('Untitled.md')).toBe('f2');
    expect(h.vault.text('Untitled.md')).toBe('brand new\n');
    await h.engine.stop();
  });

  it('uploads, after a restart, a new note created under its name while the plugin was off', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const { d1, hash } = await offlineWith(h, 'Untitled.md', 'old\n');
    h.vault.files.delete('Untitled.md');
    await event(h, 'delete', 'Untitled.md');
    await flushAsync();
    await h.engine.stop();
    await h.doc.destroy(); // Obsidian closed.
    // Created while the plugin was off: no event for it.
    h.vault.files.set('Untitled.md', encode('brand new\n'));

    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f1', 'Untitled.md', 'TEXT', hash, 4)];
    await connect(next, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(30);
    applySent(next, d1, 0);
    expect(d1.getText('content').toJSON()).toBe('old\n');
    expect(next.vault.text('Untitled.md')).toBe('brand new\n');

    next.serverFiles = [];
    deleteOnAck(next, 'Untitled.md', hash, 4);
    next.socket().pending('file:delete', 'Untitled.md').ack({ ok: true });
    await flushAsync(40);

    expect(next.socket().created()).toEqual(['Untitled.md']);
    await next.engine.stop();
  });

  it('is not written back when stop() handed the delete over with its ack on the way', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const hash = await remember(h, 'a.md', 'old\n');
    const d1 = serverDocWith('old\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 4)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    // Opened: the note has a doc and a store.
    await h.doc.whenSynced('b1', 'a.md');
    h.vault.files.delete('a.md');
    void event(h, 'delete', 'a.md');
    await flushAsync();
    expect(h.socket().pending('file:delete', 'a.md')).toBeDefined();
    await h.engine.stop(); // the ack never comes
    await h.doc.destroy();

    const next = buildHarness({ predecessor: h, docs: idb.manager() });
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 4)];
    await connect(next, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(30);

    expect([...next.vault.files.keys()]).toEqual([]);
    expect(next.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    next.serverFiles = [];
    deleteOnAck(next, 'a.md', hash, 4);
    next.socket().pending('file:delete', 'a.md').ack({ ok: true });
    await flushAsync(30);
    expect([...next.vault.files.keys()]).toEqual([]);
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });
});
