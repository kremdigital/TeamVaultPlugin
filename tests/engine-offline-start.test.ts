/**
 * A session that starts without network.
 *
 * The engine built its file index only from the server listing, when it
 * connected. Opened on a plane, Obsidian never connected, and the index
 * stayed empty: deleting a synced note queued nothing at all — the catch-up
 * brought it back on landing — and renaming one queued a rename without the
 * file id, which the drain dropped, so the note was uploaded again under its
 * new name next to the old one. The same after Pause and Resume sync without
 * network: the new engine never connected either.
 *
 * The index now starts from `state.json`, and the listing reconciles it when
 * the engine connects.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  buildHarness,
  connect,
  encode,
  flushAsync,
  goOnline,
  serverDocWith,
  snapshotOf,
  userRename,
  type Harness,
} from './engine-test-kit';

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<string> {
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
  return hash;
}

async function userDelete(h: Harness, path: string): Promise<void> {
  h.vault.files.delete(path);
  await h.engine.handleVaultEvent({ bindingId: 'b1', type: 'delete', path, source: 'obsidian' });
  await h.settle();
}

const queued = (h: Harness): unknown[] =>
  h.log.dequeueOperations('b1').map((o) => [o.opType, o.filePath, o.newPath, o.payload]);

const recorded = (h: Harness): string[] => h.log.listFileMeta('b1').map((m) => m.relativePath);

describe('SyncEngine — a session that starts offline', () => {
  it('queues a delete and a rename with the file ids, and nothing comes back on connect', async () => {
    const h = buildHarness({ offline: true });
    const server = new FakeServer(h);
    const ha = await remember(h, 'a.md', 'f1', 'A\n');
    const hb = await remember(h, 'b.md', 'f2', 'B\n');
    server.add({ id: 'f1', path: 'a.md', fileType: 'TEXT', contentHash: ha, size: 2 });
    server.add({ id: 'f2', path: 'b.md', fileType: 'TEXT', contentHash: hb, size: 2 });
    await h.engine.start();
    await flushAsync();
    expect(h.engine.getStatus()).not.toBe('connected');

    await userDelete(h, 'a.md');
    await userRename(h, 'b.md', 'c.md');

    expect(queued(h)).toEqual([
      ['DELETE', 'a.md', null, expect.objectContaining({ fileId: 'f1' })],
      ['RENAME', 'b.md', 'c.md', { fileId: 'f2' }],
    ]);
    // Out of the records at once, as when the engine had connected before.
    expect(recorded(h)).toEqual(['c.md']);
    expect(h.engine.getFileIdForPath('c.md')).toBe('f2');
    expect(h.engine.getFileIdForPath('a.md')).toBeNull();

    // Landed.
    await goOnline(h, {
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('B\n'), 'f2')],
    });
    await server.pump();
    await h.settle();

    expect(server.applied).toEqual(['delete f1', 'f2 b.md -> c.md']);
    expect([...h.vault.files.keys()]).toEqual(['c.md']);
    expect(h.vault.text('c.md')).toBe('B\n');
    expect(h.socket().created()).toEqual([]);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('does the same after Pause and Resume sync without network', async () => {
    const h = buildHarness();
    const ha = await remember(h, 'a.md', 'f1', 'A\n');
    const hb = await remember(h, 'b.md', 'f2', 'B\n');
    const server = new FakeServer(h);
    server.add({ id: 'f1', path: 'a.md', fileType: 'TEXT', contentHash: ha, size: 2 });
    server.add({ id: 'f2', path: 'b.md', fileType: 'TEXT', contentHash: hb, size: 2 });
    await connect(h, {
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('B\n'), 'f2')],
    });
    await flushAsync(20);
    // Pause; the network goes; Resume builds an engine that cannot connect.
    await h.engine.stop();
    const next = buildHarness({ predecessor: h, offline: true });
    server.attach(next);
    await next.engine.start();
    await flushAsync();

    await userDelete(next, 'a.md');
    await userRename(next, 'b.md', 'c.md');

    expect(queued(next)).toEqual([
      ['DELETE', 'a.md', null, expect.objectContaining({ fileId: 'f1' })],
      ['RENAME', 'b.md', 'c.md', { fileId: 'f2' }],
    ]);
    expect(recorded(next)).toEqual(['c.md']);

    await goOnline(next, {
      yjsDocs: [snapshotOf(serverDocWith('A\n'), 'f1'), snapshotOf(serverDocWith('B\n'), 'f2')],
    });
    await server.pump();
    await next.settle();

    expect([...next.vault.files.keys()]).toEqual(['c.md']);
    expect(next.socket().created()).toEqual([]);
    expect(server.pathOf('f1')).toBeNull();
    expect(server.pathOf('f2')).toBe('c.md');
    await next.engine.stop();
  });

  it('knows no file under a name `state.json` has that it never syncs', async () => {
    const h = buildHarness({ offline: true });
    // Written by a build without the path gate.
    await remember(h, '.obsidian/plugins/team-vault/data.json', 'f7', '{}');
    await h.engine.start();
    await flushAsync();
    expect(h.engine.getFileIdForPath('.obsidian/plugins/team-vault/data.json')).toBeNull();
    await h.engine.stop();
  });
});
