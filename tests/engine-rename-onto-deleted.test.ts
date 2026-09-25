/**
 * A note renamed onto the name of a note deleted a moment before, while the
 * delete is still on its way to the server.
 *
 * A local rename records the note under its new name at once. The delete's
 * ack then wiped that name from the index and `state.json` and deleted the
 * store under it — by then the renamed note's: the next save of the renamed
 * note went out as a new file, a duplicate for the whole team, and its
 * history was gone. From a server that does not send `clientId`, the
 * broadcast of the delete, which arrives before its ack, went for the file
 * under the name — the renamed note — and asked the user whether to delete
 * it.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  FakeServer,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
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

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a rename onto the name of a note whose delete is on its way, %s broadcasts',
  (format) => {
    it('keeps the renamed note recorded under the name, with its history', async () => {
      const idb = new FakeIndexedDb();
      const h = buildHarness({ docs: idb.manager() });
      const server = new FakeServer(h, format);
      const ha = await remember(h, 'a.md', 'f1', 'alpha\n');
      const hb = await remember(h, 'b.md', 'f2', 'beta\n');
      server.add({ id: 'f1', path: 'a.md', fileType: 'TEXT', contentHash: ha, size: 6 });
      server.add({ id: 'f2', path: 'b.md', fileType: 'TEXT', contentHash: hb, size: 5 });
      const d1 = serverDocWith('alpha\n');
      const d2 = serverDocWith('beta\n');
      await connect(h, { yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')] });
      // Both notes have their history stored here, as notes opened once do.
      await h.doc.whenSynced('b1', 'a.md');
      await h.doc.whenSynced('b1', 'b.md');
      h.doc.applyRemoteUpdate('b1', 'a.md', Y.encodeStateAsUpdate(d1));
      h.doc.applyRemoteUpdate('b1', 'b.md', Y.encodeStateAsUpdate(d2));
      await flushAsync();
      expect(idb.textOf(dbNameOf('a.md'))).toBe('alpha\n');
      expect(idb.textOf(dbNameOf('b.md'))).toBe('beta\n');
      // The user deletes `b.md`, then renames `a.md` to `b.md` before the
      // delete has reached the server.
      h.vault.files.delete('b.md');
      const deleting = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'delete',
        path: 'b.md',
        source: 'obsidian',
      });
      await flushAsync();
      expect(h.socket().pending('file:delete', 'b.md')).toBeDefined();
      await userRename(h, 'a.md', 'b.md');
      await server.pump();
      await deleting;
      await h.settle();

      expect(server.pathOf('f1')).toBe('b.md');
      expect(server.pathOf('f2')).toBeNull();
      expect(h.vault.text('b.md')).toBe('alpha\n');
      expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
      expect(h.log.getFileMeta('b1', 'b.md')?.serverFileId).toBe('f1');
      expect(idb.textOf(dbNameOf('b.md'))).toBe('alpha\n');
      expect(h.calls).not.toContain('modal.resolveDeleteConflict');

      // An edit of the renamed note goes out as that note's.
      const mark = h.socket().emits.length;
      h.vault.files.set('b.md', encode('alpha\nmore\n'));
      const saving = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'b.md',
        source: 'obsidian',
      });
      await flushAsync(10);
      // The note's state, if the fold asks the server for it.
      for (const f of h.socket().fetches.splice(0)) {
        expect(f.fileId).toBe('f1');
        f.answer({
          ok: true,
          sync1: Array.from(Y.encodeStateAsUpdate(d1)),
          stateVector: Array.from(Y.encodeStateVector(d1)),
        });
      }
      await saving;
      await flushAsync(20);
      const sent = h.socket().emits.slice(mark);
      expect(h.socket().created()).toEqual([]);
      for (const e of sent.filter((x) => x.event === 'yjs:update')) {
        const p = e.payload as { fileId: string; update: number[] };
        expect(p.fileId).toBe('f1');
        Y.applyUpdate(d1, Uint8Array.from(p.update));
      }
      expect(d1.getText('content').toJSON()).toBe('alpha\nmore\n');
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });
  },
);
