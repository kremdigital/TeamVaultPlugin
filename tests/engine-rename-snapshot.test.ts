/**
 * A teammate's edit whose disk snapshot fires while their rename of the same
 * note is still moving its history.
 *
 * The snapshot for the old name waited behind the rename, then found no doc
 * under that name and gave up: the edit was in the doc and in IndexedDB under
 * the new name but not on disk, and so not in the editor, until the next
 * edit or connect. A snapshot still pending was rescheduled under the new
 * name; one that had already fired was not.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { DocManager, type DocPersistence } from '@/crdt/doc-manager';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  deferred,
  encode,
  eventLog,
  flushAsync,
  serverDocWith,
  serverFile,
  snapshotOf,
} from './engine-test-kit';

describe('SyncEngine — a snapshot that fired while a server rename moved the note', () => {
  it('is written under the new name', async () => {
    const idb = new FakeIndexedDb();
    const gate = deferred<void>();
    let armed = false;
    const slow = new DocManager({
      persistenceFactory: (name, doc): DocPersistence | null => {
        const p = idb.factory(name, doc);
        if (p && armed && name === dbNameOf('a.md')) {
          const loaded = p.whenSynced;
          p.whenSynced = gate.promise.then(() => loaded);
        }
        return p;
      },
      idb: idb.registry,
    });
    const d1 = serverDocWith('A\n');
    idb.dbs.set(dbNameOf('a.md'), {
      updates: [Y.encodeStateAsUpdate(d1)],
      custom: new Map([['team-vault-file-id', 'f1']]),
    });
    const h = buildHarness({ docs: slow, diskSnapshotDebounceMs: 0 });
    const hash = await sha256Hex('A\n');
    h.vault.files.set('a.md', encode('A\n'));
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'a.md',
      serverFileId: 'f1',
      contentHash: hash,
      size: 2,
      fileType: 'TEXT',
      lastSyncedAt: 1,
      foldedHash: hash,
    });
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', hash, 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    armed = true;

    // The rename's move waits for the store; the edit's snapshot fires meanwhile.
    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', outcome: {}, log: eventLog });
    await flushAsync(5);
    const seen = Y.encodeStateVector(d1);
    d1.getText('content').insert(2, 'T\n');
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(d1, seen)),
    });
    await flushAsync(10);
    gate.resolve();
    await flushAsync(40);
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    await flushAsync(40);

    expect(h.vault.text('b.md')).toBe('A\nT\n');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    await h.engine.stop();
  });
});
