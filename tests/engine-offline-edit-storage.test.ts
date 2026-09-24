import { sha256Hex } from '@/sync/hash';
import { manualStep } from './docs-text';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/**
 * Where an edit made offline waits for the server. MANUAL-TEST S14 steps 5–7
 * check that a binding the plugin can't read in `data.json` keeps both kinds
 * of offline state, and it used to say that an edited note "is queued in
 * `state.json`". It is not: a note's edit goes into its Y.Doc, which
 * y-indexeddb keeps in Obsidian's IndexedDB, and only an attachment's edit
 * is queued in `state.json` (`pending`, an `UPDATE`). A tester looking there
 * for the note's edit found nothing.
 */

const modify = (h: Harness, path: string): Promise<void> =>
  h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });

/**
 * Synced: a note `a.md` edited on this device before (it has an offline
 * document) and an attachment `img.png`. Then the network goes.
 */
async function offline(idb: FakeIndexedDb): Promise<Harness> {
  const h = buildHarness({ docs: idb.manager() });
  const synced = 'old\n';
  const hash = await sha256Hex(synced);
  const png = encode('PNG-1');
  const pngHash = await sha256Hex(png);
  // Edited on disk since the last sync: the catch-up folds it into the doc.
  h.vault.files.set('a.md', encode('old\nmine\n'));
  h.vault.files.set('img.png', png);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'a.md',
    serverFileId: 'f1',
    contentHash: hash,
    size: encode(synced).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'img.png',
    serverFileId: 'f2',
    contentHash: pngHash,
    size: png.byteLength,
    fileType: 'BINARY',
    lastSyncedAt: 1,
  });
  h.serverFiles = [
    serverFile('f1', 'a.md', 'TEXT', hash, encode(synced).byteLength),
    serverFile('f2', 'img.png', 'BINARY', pngHash, png.byteLength),
  ];
  await connect(h, { yjsDocs: [snapshotOf(serverDocWith(synced), 'f1')] });
  await flushAsync(20);
  expect(idb.textOf(dbNameOf('a.md'))).toBe('old\nmine\n');
  h.socket().disconnect();
  await flushAsync();
  return h;
}

describe('an edit made offline (MANUAL-TEST S14, step 5)', () => {
  it("goes into the note's offline document in IndexedDB, not into state.json", async () => {
    const idb = new FakeIndexedDb();
    const h = await offline(idb);

    h.vault.files.set('a.md', encode('old\nmine\noffline\n'));
    await modify(h, 'a.md');
    await flushAsync();

    expect(idb.textOf(dbNameOf('a.md'))).toBe('old\nmine\noffline\n');
    expect(h.log.pendingCount('b1')).toBe(0);
    await h.engine.stop();
  });

  it("is queued in state.json as an UPDATE when it is an attachment's", async () => {
    const h = await offline(new FakeIndexedDb());

    h.vault.files.set('img.png', encode('PNG-2'));
    await modify(h, 'img.png');
    await flushAsync();

    expect(h.log.dequeueOperations('b1').map((op) => [op.opType, op.filePath])).toEqual([
      ['UPDATE', 'img.png'],
    ]);
    await h.engine.stop();
  });

  it('is described so in MANUAL-TEST.md', () => {
    const step5 = manualStep('S14', 5);
    // The step makes both kinds of offline state and says where each is.
    expect(step5).not.toMatch(/правка встаёт в очередь `state\.json`/);
    expect(step5).toContain('IndexedDB');
    expect(step5).toContain('`pending`');
    expect(step5).toContain('`UPDATE`');
    // And step 7 checks that both reach the server.
    const step7 = manualStep('S14', 7);
    expect(step7).toContain('картинк');
    expect(step7).toContain('`pending`');
  });
});
