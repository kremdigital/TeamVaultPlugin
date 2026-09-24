/**
 * The fold marker of a note moved to another name.
 *
 * `foldedHash` names the disk content already in the note's doc. When a move
 * leaves a history behind, the marker is set back to the last synced content,
 * so the next fold merges the disk three-way instead of taking it as folded.
 * It used to be set back also when the old name held nothing to carry: a note
 * whose disk matched the server (the catch-up never opened its doc), a store
 * lost with a cleared IndexedDB, one a build before 0.3.8 left under an
 * earlier name. The next fold then merged a disk that already matched the
 * server against an older base, and a teammate's edit arriving next was
 * deleted for everyone, or the note's own last edit doubled.
 *
 * Another file's marker was set back too when its leftover history turned up
 * under a name — with the same result for that file, whose live doc is under
 * its own name.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  buildHarness,
  bytes,
  connect,
  dbNameOf,
  encode,
  eventLog,
  flushAsync,
  json,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

const OWNER = 'team-vault-file-id';

/** `path` (file `fileId`) last synced as `synced`, holding `onDisk`, folded as `folded`. */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: string,
  onDisk: string = synced,
  folded: string = synced,
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, encode(onDisk));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: encode(synced).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: await sha256Hex(folded),
  });
  return hash;
}

/** A store under `path` holding `doc`'s history, stamped for `owner`. */
function store(idb: FakeIndexedDb, path: string, doc: Y.Doc, owner?: string): void {
  idb.dbs.set(dbNameOf(path), {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map(owner === undefined ? [] : [[OWNER, owner]]),
  });
}

/** The server's version history of `fileId`: one version per text. */
function versions(h: Harness, fileId: string, texts: string[]): void {
  const listed = texts.map(async (text, i) => ({
    id: `v${i}`,
    contentHash: await sha256Hex(text),
    size: encode(text).byteLength,
    createdAt: '2026-01-01',
    authorId: 'u2',
    fileId,
  }));
  h.routes.set(`GET /api/projects/p1/files/${fileId}/versions`, async () =>
    json({ versions: await Promise.all(listed) }),
  );
  texts.forEach((text, i) => {
    h.routes.set(`GET /api/projects/p1/files/${fileId}/versions/v${i}`, () => bytes(encode(text)));
  });
}

/**
 * A teammate appends `line` to `serverDoc` (file `fileId`), live; `yjs:fetch`
 * requests are answered from the server doc, and what the engine sends back
 * is applied to it.
 */
async function teammateAppends(
  h: Harness,
  serverDoc: Y.Doc,
  fileId: string,
  line: string,
): Promise<void> {
  const mark = h.socket().emits.length;
  const seen = Y.encodeStateVector(serverDoc);
  const text = serverDoc.getText('content');
  text.insert(text.length, line);
  h.socket().fire('yjs:update', {
    fileId,
    update: Array.from(Y.encodeStateAsUpdate(serverDoc, seen)),
  });
  await flushAsync(20);
  for (const f of h.socket().fetches.splice(0)) {
    f.answer({
      ok: true,
      sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
      stateVector: Array.from(Y.encodeStateVector(serverDoc)),
    });
  }
  await flushAsync(60);
  for (const e of h.socket().emits.slice(mark)) {
    const p = e.payload as { fileId?: string; update?: Uint8Array | number[] };
    if (e.event === 'yjs:update' && p.fileId === fileId && p.update) {
      Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
    }
  }
}

describe('SyncEngine — a note renamed with nothing under its old name to carry', () => {
  // The disk has the server's text, "A\nB\n", but the listing's hash names the
  // last versioned one, "A\n" — as when the disk was brought up to date by
  // something else than the plugin (git, another sync tool), or an edit made
  // here lost its offline store. The catch-up finds disk and server equal and
  // never opens the doc.
  it.each([
    ['in memory, no version history', false, false],
    ['with an offline store, no version history', true, false],
    ['with an offline store, the listed text in version history', true, true],
  ])('keeps a teammate’s next edit (%s)', async (_label, persist, withVersion) => {
    const idb = new FakeIndexedDb();
    const h = buildHarness(persist ? { docs: idb.manager() } : {});
    const listed = await remember(h, 'a.md', 'f1', 'A\n', 'A\nB\n');
    const d1 = serverDocWith('A\n');
    d1.getText('content').insert(2, 'B\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', listed, 2)];
    versions(h, 'f1', withVersion ? ['A\n'] : []);
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    expect(h.doc.has('b1', 'a.md')).toBe(false);
    const folded = await sha256Hex('A\nB\n');
    expect(h.log.getFileMeta('b1', 'a.md')?.foldedHash).toBe(folded);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);
    expect(h.log.getFileMeta('b1', 'b.md')?.foldedHash).toBe(folded);

    await teammateAppends(h, d1, 'f1', 'C\n');

    expect(d1.getText('content').toJSON()).toBe('A\nB\nC\n');
    expect(h.vault.text('b.md')).toBe('A\nB\nC\n');
    await h.engine.stop();
  });

  it('keeps it after an upgrade from 0.3.7, which left the history under an earlier name', async () => {
    // "B\n" was typed here and reached the server live. 0.3.7 then renamed
    // old.md → b.md: the record moved with its marker, the store stayed
    // under old.md, unstamped.
    const d1 = serverDocWith('A\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d1));
    local.getText('content').insert(2, 'B\n');
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(local, Y.encodeStateVector(d1)));
    const idb = new FakeIndexedDb();
    store(idb, 'old.md', local);
    const h = buildHarness({ docs: idb.manager() });
    const listed = await remember(h, 'b.md', 'f1', 'A\n', 'A\nB\n', 'A\nB\n');
    h.serverFiles = [serverFile('f1', 'b.md', 'TEXT', listed, 2)];
    versions(h, 'f1', []);
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);

    // A teammate moves the note into a folder, then keeps typing.
    h.socket().fire('file:moved', { fileId: 'f1', newPath: 'Archive/b.md', log: eventLog });
    await flushAsync(20);
    await teammateAppends(h, d1, 'f1', 'C\n');

    expect(d1.getText('content').toJSON()).toBe('A\nB\nC\n');
    expect(h.vault.text('Archive/b.md')).toBe('A\nB\nC\n');
    await h.engine.stop();
  });

  it('still sets the marker back when the history under the old name is another file’s', async () => {
    const idb = new FakeIndexedDb();
    const leftover = serverDocWith('foreign\n');
    store(idb, 'a.md', leftover, 'f9');
    const h = buildHarness({ docs: idb.manager() });
    const listed = await remember(h, 'a.md', 'f1', 'A\n', 'A\nB\n', 'A\nB\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', listed, 2)];
    await connect(h);
    await flushAsync(20);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);

    expect(h.vault.text('b.md')).toBe('A\nB\n');
    expect(h.log.getFileMeta('b1', 'b.md')?.foldedHash).toBe(listed);
    expect(idb.dbs.has(dbNameOf('a.md'))).toBe(false);
    await h.engine.stop();
  });
});

describe('SyncEngine — another file’s leftover history found under a name', () => {
  /**
   * f2 lives at q.md: "x\n" typed here, folded and sent — its doc and store
   * at q.md hold it, and so does the server; its `contentHash` still names
   * "Q\n", the last text a snapshot wrote. A leftover of f2's history, stamped
   * f2, sits under `leftAt` — a move whose delete of the old store failed.
   */
  async function withLeftover(leftAt: string): Promise<{
    h: Harness;
    idb: FakeIndexedDb;
    d2: Y.Doc;
    folded: string;
  }> {
    const d2 = serverDocWith('Q\n');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(d2));
    local.getText('content').insert(2, 'x\n');
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(local, Y.encodeStateVector(d2)));
    const idb = new FakeIndexedDb();
    store(idb, 'q.md', local, 'f2');
    store(idb, leftAt, serverDocWith('Q\n'), 'f2');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'q.md', 'f2', 'Q\n', 'Q\nx\n', 'Q\nx\n');
    versions(h, 'f2', ['Q\n']);
    return { h, idb, d2, folded: await sha256Hex('Q\nx\n') };
  }

  it('leaves that file’s marker alone when a note opens its doc there', async () => {
    const { h, d2, folded } = await withLeftover('p.md');
    const listedP = await remember(h, 'p.md', 'f1', 'P\n');
    const d1 = serverDocWith('P\n');
    h.serverFiles = [
      serverFile('f1', 'p.md', 'TEXT', listedP, 2),
      serverFile('f2', 'q.md', 'TEXT', await sha256Hex('Q\n'), 2),
    ];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')] });
    await flushAsync(20);

    // An edit to p.md opens its doc, and finds f2's leftover there.
    h.vault.files.set('p.md', encode('P\nmine\n'));
    const edit = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'p.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    await edit;
    await flushAsync(20);
    expect(h.log.getFileMeta('b1', 'p.md')?.foldedHash).toBe(await sha256Hex('P\nmine\n'));
    expect(h.log.getFileMeta('b1', 'q.md')?.foldedHash).toBe(folded);

    await teammateAppends(h, d2, 'f2', 'T\n');
    expect(d2.getText('content').toJSON()).toBe('Q\nx\nT\n');
    expect(h.vault.text('q.md')).toBe('Q\nx\nT\n');
    await h.engine.stop();
  });

  it.each([
    ['under the new name of a note moved there', 'b.md'],
    ['under the old name of a note moved away', 'a.md'],
  ])('leaves that file’s marker alone when it is %s', async (_label, leftAt) => {
    const { h, idb, d2, folded } = await withLeftover(leftAt);
    const listedA = await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [
      serverFile('f1', 'a.md', 'TEXT', listedA, 2),
      serverFile('f2', 'q.md', 'TEXT', await sha256Hex('Q\n'), 2),
    ];
    await connect(h, { yjsDocs: [snapshotOf(d2, 'f2')] });
    await flushAsync(20);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'b.md', log: eventLog });
    await flushAsync(20);
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(idb.dbs.get(dbNameOf('b.md'))?.custom.get(OWNER) ?? 'f1').toBe('f1');
    expect(h.log.getFileMeta('b1', 'q.md')?.foldedHash).toBe(folded);

    await teammateAppends(h, d2, 'f2', 'T\n');
    expect(d2.getText('content').toJSON()).toBe('Q\nx\nT\n');
    expect(h.vault.text('q.md')).toBe('Q\nx\nT\n');
    await h.engine.stop();
  });
});
