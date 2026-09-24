/**
 * The offline queue and renames.
 *
 * - The index refresh moves files renamed while this device was away before
 *   the queue drains. The drain looked files up by the path they had when
 *   the operation was queued: a queued attachment edit was dropped as
 *   "missing", and a delete handed over before its stale-delete check found
 *   nothing there and went out — deleting a live file for the whole team.
 * - A rename made here while offline was only queued: the index and
 *   `state.json` kept the old name. On reconnect the catch-up wrote the note
 *   back under it, and once the queue had sent the rename `initialPush`
 *   uploaded that copy as a second file. A new note saved under the old name
 *   meanwhile was folded into the renamed one.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import {
  buildHarness,
  connect,
  encode,
  flushAsync,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

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

function applySent(h: Harness, serverDoc: Y.Doc, fileId: string): void {
  for (const e of h.socket().emits) {
    if (e.event !== 'yjs:update') continue;
    const p = e.payload as { fileId: string; update: Uint8Array | number[] };
    if (p.fileId === fileId) Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
  }
}

/** Reconnect: the socket drops and comes back; the join is answered with `join`. */
async function rejoin(
  h: Harness,
  join: { operations?: unknown[]; yjsDocs?: unknown[] } = {},
): Promise<void> {
  h.socket().disconnect();
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: join.operations ?? [], yjsDocs: join.yjsDocs ?? [] });
  await flushAsync(40);
}

const events = (h: Harness): string[] => h.socket().emits.map((e) => e.event);

/** Rename `from` → `to` in Obsidian while the socket is down. */
async function renameOffline(h: Harness, from: string, to: string): Promise<void> {
  await h.vault.rename(from, to);
  await h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'rename',
    oldPath: from,
    newPath: to,
    source: 'obsidian',
  });
  await flushAsync();
}

describe('SyncEngine — the queue drained after renames made while away', () => {
  it.each([
    ['renamed', 'a.png', 'b.png', 'RENAME'],
    ['moved with its folder', 'img/doc.pdf', 'assets/doc.pdf', 'MOVE'],
  ] as const)(
    'sends an attachment edit queued offline for a file a teammate %s',
    async (_label, from, to, opType) => {
      const h = buildHarness();
      const img = new Uint8Array([1, 2, 3]).buffer;
      const edited = new Uint8Array([1, 2, 3, 4]).buffer;
      const hash = await remember(h, from, 'f1', img, img, 'BINARY');
      h.serverFiles = [serverFile('f1', from, 'BINARY', hash, 3)];
      await connect(h);
      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set(from, edited);
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: from,
        source: 'obsidian',
      });
      await flushAsync();
      expect(h.log.dequeueOperations('b1').map((o) => o.opType)).toEqual(['UPDATE']);

      h.serverFiles = [serverFile('f1', to, 'BINARY', hash, 3)];
      await rejoin(h, { operations: [op(opType, from, to, { fileId: 'f1' }, 5)] });

      expect(h.vault.files.get(to)).toBe(edited);
      expect(h.socket().pending('file:update-binary').payload).toMatchObject({
        fileId: 'f1',
        contentHash: await sha256Hex(edited),
      });
      await h.engine.stop();
    },
  );

  it('does not send a delete handed over at stop for a file a teammate renamed', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'a.md', 'f1', encode('A\n'));
    // What `stop()` hands over for a delete whose stale-delete check had not run.
    h.log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'a.md',
      newPath: null,
      payload: { fileId: 'f1', recheck: true },
    });
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', hash, 2)];

    await connect(h, {
      operations: [op('RENAME', 'a.md', 'b.md', { fileId: 'f1' }, 1)],
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')],
    });
    await flushAsync(20);

    expect(events(h)).not.toContain('file:delete');
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.log.pendingCount('b1')).toBe(0);
    await h.engine.stop();
  });

  it('sends an attachment edit queued before a rename made here offline', async () => {
    const h = buildHarness();
    const img = new Uint8Array([1, 2, 3]).buffer;
    const edited = new Uint8Array([9, 9]).buffer;
    const hash = await remember(h, 'a.png', 'f1', img, img, 'BINARY');
    h.serverFiles = [serverFile('f1', 'a.png', 'BINARY', hash, 3)];
    await connect(h);
    h.socket().disconnect();
    await flushAsync();
    h.vault.files.set('a.png', edited);
    await h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'a.png',
      source: 'obsidian',
    });
    await renameOffline(h, 'a.png', 'b.png');

    await rejoin(h);
    // The edit goes first, by id, read from where the file is now.
    const update = h.socket().pending('file:update-binary');
    expect(update.payload).toMatchObject({ fileId: 'f1', contentHash: await sha256Hex(edited) });
    update.ack({ ok: true });
    await flushAsync(20);
    const rename = h.socket().pending('file:rename');
    expect(rename.payload).toMatchObject({ fileId: 'f1', filePath: 'a.png', newPath: 'b.png' });
    rename.ack({ ok: true });
    await flushAsync(20);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a rename made here while offline', () => {
  async function connectedNote(h: Harness): Promise<Y.Doc> {
    const hash = await remember(h, 'a.md', 'f1', encode('A\n'));
    const d1 = serverDocWith('A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    return d1;
  }

  it('is not written back under the old name nor uploaded as a second file', async () => {
    const h = buildHarness();
    const d1 = await connectedNote(h);
    h.socket().disconnect();
    await flushAsync();
    await renameOffline(h, 'a.md', 'b.md');
    // Recorded under the new name at once.
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();

    // The server still has it under the old name, and streams its doc.
    await rejoin(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.socket().created()).toEqual([]);
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    await h.engine.stop();
  });

  it('keeps the note apart from a new note saved under the old name meanwhile', async () => {
    const h = buildHarness();
    const d1 = await connectedNote(h);
    h.socket().disconnect();
    await flushAsync();
    await renameOffline(h, 'a.md', 'b.md');
    // Obsidian creates the note a link `[[a]]` points to.
    h.vault.files.set('a.md', encode('NEW\n'));
    await h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync();
    expect(h.log.dequeueOperations('b1').map((o) => [o.opType, o.filePath])).toEqual([
      ['RENAME', 'a.md'],
      ['CREATE', 'a.md'],
    ]);

    await rejoin(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);
    applySent(h, d1, 'f1');

    // The renamed note kept its text; the new one goes up as a file of its own.
    expect(d1.getText('content').toJSON()).toBe('A\n');
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.vault.text('a.md')).toBe('NEW\n');
    expect(h.socket().created()).toEqual(['a.md']);
    await h.engine.stop();
  });

  it('is sent by the next engine after a restart, without a second file', async () => {
    const h = buildHarness();
    const d1 = await connectedNote(h);
    h.socket().disconnect();
    await flushAsync();
    await renameOffline(h, 'a.md', 'b.md');
    await h.engine.stop();

    const next = buildHarness({ predecessor: h });
    next.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];
    await connect(next, { yjsDocs: [snapshotOf(d1, 'f1')] });
    expect([...next.vault.files.keys()]).toEqual(['b.md']);
    next.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);

    expect([...next.vault.files.keys()]).toEqual(['b.md']);
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });

  it('is taken up from a queue an older version left, with the record under the old name', async () => {
    const h = buildHarness();
    const hash = await remember(h, 'a.md', 'f1', encode('A\n'));
    // What 0.3.7 left: the rename queued, the record still at `a.md`.
    await h.vault.rename('a.md', 'b.md');
    h.log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'a.md',
      newPath: 'b.md',
      payload: { fileId: 'f1' },
    });
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];

    await connect(h, { yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')] });
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.socket().created()).toEqual([]);
    expect(h.log.getFileMeta('b1', 'a.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
    await h.engine.stop();
  });

  it('wins over a teammate’s rename of the same note while offline, without moving it back and forth', async () => {
    const h = buildHarness();
    await connectedNote(h);
    h.socket().disconnect();
    await flushAsync();
    await renameOffline(h, 'a.md', 'b.md');
    const renames: string[] = [];
    const rename0 = h.vault.rename.bind(h.vault);
    h.vault.rename = async (from, to) => {
      renames.push(`${from} -> ${to}`);
      return rename0(from, to);
    };

    h.serverFiles = [serverFile('f1', 'c.md', 'TEXT', await sha256Hex('A\n'), 2)];
    await rejoin(h, {
      operations: [op('RENAME', 'a.md', 'c.md', { fileId: 'f1' }, 5)],
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1')],
    });
    h.socket().pending('file:rename').ack({ ok: true });
    await flushAsync(20);

    expect(renames).toEqual([]);
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});
