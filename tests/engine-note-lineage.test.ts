/**
 * The history in a note's offline doc must descend from the server's doc of
 * the note before the two are merged.
 *
 * Two histories of one note that do not are independent insertions of its
 * text; merged, the note holds its text twice, and the catch-up's push-back
 * sends that to the whole team. The file id does not tell them apart:
 *
 * - a server before the fix that continues histories revived a deleted note
 *   under its old id with a new history — a note deleted and created again
 *   under its name ("Untitled", a template, the trash, `write_note` through
 *   MCP) while this device was away;
 * - a project seeded again, or a doc the server seeds anew from the note's
 *   file, is a new history under the same id;
 * - a build before 0.3.8 left the history of a note renamed or deleted away
 *   under its name, unstamped, and with `state.json` lost every note is new
 *   under its name to this device.
 *
 * The check must not fire in the normal flows: a note created here and seeded
 * by the server, a doc hydrated with `yjs:fetch`, a fresh doc, a server that
 * collected garbage.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  eventLog,
  flushAsync,
  json,
  op,
  remoteEdit,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

const OWNER = 'team-vault-file-id';

/**
 * `path` (`fileId`) synced as `synced`: on disk (or `onDisk`), and in
 * `state.json` with both hashes naming `synced`.
 */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: string,
  onDisk: string = synced,
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
    foldedHash: hash,
  });
  return hash;
}

/** A store under `path` holding `doc`'s history, stamped for `owner` if given. */
function store(idb: FakeIndexedDb, path: string, doc: Y.Doc, owner?: string): void {
  idb.dbs.set(dbNameOf(path), {
    updates: [Y.encodeStateAsUpdate(doc)],
    custom: new Map(owner === undefined ? [] : [[OWNER, owner]]),
  });
}

/** A doc continuing `base`'s history, with `edit` applied to its text. */
function continued(base: Y.Doc, edit: (text: Y.Text) => void): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  edit(doc.getText('content'));
  return doc;
}

/** Apply to `serverDoc` every `yjs:update` the engine sent for `fileId` (from emit `from` on). */
function applySent(h: Harness, serverDoc: Y.Doc, fileId: string, from = 0): void {
  for (const e of h.socket().emits.slice(from)) {
    if (e.event !== 'yjs:update') continue;
    const p = e.payload as { fileId: string; update: Uint8Array | number[] };
    if (p.fileId === fileId) Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
  }
}

/** Paths on disk that are conflict copies. */
function conflictCopies(h: Harness): string[] {
  return [...h.vault.files.keys()].filter((p) => p.includes('.conflict-'));
}

/** Answer every `yjs:fetch` so far with `serverDoc`. */
function answerFetches(h: Harness, serverDoc: Y.Doc): void {
  for (const f of h.socket().fetches.splice(0)) {
    f.answer({
      ok: true,
      sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
      stateVector: Array.from(Y.encodeStateVector(serverDoc)),
    });
  }
}

/** The server's version history of `fileId` holds nothing. */
function noVersions(h: Harness, fileId: string): void {
  h.routes.set(`GET /api/projects/p1/files/${fileId}/versions`, () => json({ versions: [] }));
}

/** The catch-up of a note deleted and created again under its id, as a server logs it. */
function deletedAndCreated(path: string, fileId: string, revived?: boolean) {
  return [
    op('DELETE', path, null, { fileId }, 5),
    op(
      'CREATE',
      path,
      null,
      { fileId, fileType: 'TEXT', ...(revived === undefined ? {} : { revived }) },
      6,
    ),
  ];
}

describe('SyncEngine — a note deleted and created again under its name while this device was away', () => {
  const OLD = 'Old line one\nOld line two\n';
  const EDITED = 'Old line one\nOld line two\nedit\n';
  const NEW = 'Brand new note\n';

  it('does not merge the deleted note’s history into the new one', async () => {
    const idb = new FakeIndexedDb();
    // Session 1: a.md (f1) synced; an edit on disk goes out, and the note's
    // history is stored.
    const oldServer = serverDocWith(OLD);
    const h1 = buildHarness({ docs: idb.manager() });
    await remember(h1, 'a.md', 'f1', OLD, EDITED);
    h1.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(OLD), OLD.length)];
    await connect(h1, { yjsDocs: [snapshotOf(oldServer, 'f1')] });
    await flushAsync(40);
    applySent(h1, oldServer, 'f1');
    expect(oldServer.getText('content').toJSON()).toBe(EDITED);
    expect(idb.textOf(dbNameOf('a.md'))).toBe(EDITED);
    await h1.engine.stop();

    // Away: a teammate deletes a.md and creates a new a.md. The server
    // revives f1 with a history of its own.
    const revived = serverDocWith(NEW);
    const h2 = buildHarness({ predecessor: h1, docs: idb.manager() });
    h2.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(NEW), NEW.length)];
    await connect(h2, {
      operations: deletedAndCreated('a.md', 'f1'),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(40);
    applySent(h2, revived, 'f1');

    expect(h2.vault.text('a.md')).toBe(NEW);
    expect(revived.getText('content').toJSON()).toBe(NEW);
    // The store holds the new note's history now, and says so.
    expect(idb.textOf(dbNameOf('a.md'))).toBe(NEW);
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f1');
    expect(conflictCopies(h2)).toEqual([]);
    expect(h2.socket().created()).toEqual([]);
    await h2.engine.stop();
  });

  it('nor into one renamed since (“Untitled” reused, then renamed)', async () => {
    const idb = new FakeIndexedDb();
    const synced = 'teammate line\nold draft\n';
    store(
      idb,
      'Untitled.md',
      continued(serverDocWith('old draft\n'), (t) => t.insert(0, 'teammate line\n')),
      'f1',
    );
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'Untitled.md', 'f1', synced);
    const fresh = 'Meeting notes\n';
    const revived = serverDocWith(fresh);
    h.serverFiles = [serverFile('f1', 'Meeting.md', 'TEXT', await sha256Hex(fresh), fresh.length)];

    await connect(h, {
      operations: [
        ...deletedAndCreated('Untitled.md', 'f1'),
        op('RENAME', 'Untitled.md', 'Meeting.md', { fileId: 'f1' }, 7),
      ],
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(60);
    applySent(h, revived, 'f1');

    expect(revived.getText('content').toJSON()).toBe(fresh);
    expect(h.vault.text('Meeting.md')).toBe(fresh);
    expect(h.vault.files.has('Untitled.md')).toBe(false);
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });

  it('does not double a note restored from the trash', async () => {
    const idb = new FakeIndexedDb();
    const text = 'OLD note text\n';
    store(idb, 'Untitled.md', serverDocWith(text), 'f1');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'Untitled.md', 'f1', text);
    // The same text, inserted anew by the server.
    const revived = serverDocWith(text);
    h.serverFiles = [serverFile('f1', 'Untitled.md', 'TEXT', await sha256Hex(text), text.length)];

    await connect(h, {
      operations: deletedAndCreated('Untitled.md', 'f1'),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(40);
    applySent(h, revived, 'f1');

    expect(h.vault.text('Untitled.md')).toBe(text);
    expect(revived.getText('content').toJSON()).toBe(text);
    await h.engine.stop();
  });

  it('keeps the deleted note’s text out of an empty new note (Ctrl+N)', async () => {
    const idb = new FakeIndexedDb();
    store(idb, 'Untitled.md', serverDocWith('old draft\n'), 'f1');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'Untitled.md', 'f1', 'old draft\n');
    // Nothing in the new note: a server that replaces the history has no
    // operation left in its doc to compare with.
    const revived = new Y.Doc();
    h.serverFiles = [serverFile('f1', 'Untitled.md', 'TEXT', await sha256Hex(''), 0)];

    await connect(h, {
      operations: deletedAndCreated('Untitled.md', 'f1'),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(40);
    applySent(h, revived, 'f1');

    expect(revived.getText('content').toJSON()).toBe('');
    expect(h.vault.text('Untitled.md')).toBe('');
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });

  it('keeps edits of the deleted note the server never got in a copy next to the new one', async () => {
    const idb = new FakeIndexedDb();
    const old = serverDocWith('A\n');
    // Folded while offline, never sent: in the store and on disk.
    store(
      idb,
      'a.md',
      continued(old, (t) => t.insert(2, 'unsent\n')),
      'f1',
    );
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', 'A\n', 'A\nunsent\n');
    const meta = h.log.getFileMeta('b1', 'a.md');
    if (!meta) throw new Error('no meta');
    h.log.setFileMeta({ ...meta, foldedHash: await sha256Hex('A\nunsent\n') });
    noVersions(h, 'f1');
    const revived = serverDocWith(NEW);
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(NEW), NEW.length)];

    await connect(h, {
      operations: deletedAndCreated('a.md', 'f1'),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(60);
    applySent(h, revived, 'f1');

    expect(h.vault.text('a.md')).toBe(NEW);
    expect(revived.getText('content').toJSON()).toBe(NEW);
    const copies = conflictCopies(h);
    expect(copies).toHaveLength(1);
    const [copy] = copies;
    expect(h.vault.text(copy ?? '')).toBe('A\nunsent\n');
    // Uploaded as a file of its own by the connect's first upload.
    expect(h.socket().created()).toEqual([copy]);
    await h.engine.stop();
  });

  it('writes the new note over a copy the server’s history has, whatever the fold marker says', async () => {
    const idb = new FakeIndexedDb();
    const old = serverDocWith('A\n');
    store(
      idb,
      'a.md',
      continued(old, (t) => t.insert(2, 'mine\n')),
      'f1',
    );
    const h = buildHarness({ docs: idb.manager() });
    // Saved and sent, then versioned by the server; the marker still names
    // the text before (a rename made here sets it back so).
    await remember(h, 'a.md', 'f1', 'A\n', 'A\nmine\n');
    const versions = await Promise.all(
      ['A\n', 'A\nmine\n'].map(async (text, i) => ({
        id: `v${i}`,
        contentHash: await sha256Hex(text),
        size: text.length,
        createdAt: '2026-01-01',
        authorId: 'u2',
        fileId: 'f1',
      })),
    );
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions }));
    const revived = serverDocWith(NEW);
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(NEW), NEW.length)];

    await connect(h, {
      operations: deletedAndCreated('a.md', 'f1'),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(60);
    applySent(h, revived, 'f1');

    expect(h.vault.text('a.md')).toBe(NEW);
    expect(revived.getText('content').toJSON()).toBe(NEW);
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a note revived by a server that continues its history', () => {
  it('is merged as the one history it is: the new text, nothing set aside', async () => {
    const idb = new FakeIndexedDb();
    const old = serverDocWith('OLD\n');
    store(idb, 'a.md', old, 'f1');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', 'OLD\n');
    // Revived: the old text deleted and the new one inserted, on top of the
    // stored history.
    const revived = continued(old, (t) => {
      t.delete(0, t.length);
      t.insert(0, 'NEW\n');
    });
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('NEW\n'), 4)];

    await connect(h, {
      operations: deletedAndCreated('a.md', 'f1', true),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(40);
    applySent(h, revived, 'f1');

    expect(h.vault.text('a.md')).toBe('NEW\n');
    expect(revived.getText('content').toJSON()).toBe('NEW\n');
    expect(idb.deleted).toEqual([]);
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });

  it('brings edits made here to an empty note into the new one, as the protocol has it', async () => {
    const idb = new FakeIndexedDb();
    // An empty note, typed into while offline.
    const typed = new Y.Doc();
    typed.getText('content').insert(0, 'typed\n');
    store(idb, 'a.md', typed, 'f1');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', '', 'typed\n');
    const meta = h.log.getFileMeta('b1', 'a.md');
    if (!meta) throw new Error('no meta');
    h.log.setFileMeta({ ...meta, foldedHash: await sha256Hex('typed\n') });
    // Revived as an empty note: the stored doc was empty, and stays so.
    const revived = new Y.Doc();
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(''), 0)];

    await connect(h, {
      operations: deletedAndCreated('a.md', 'f1', true),
      yjsDocs: [snapshotOf(revived, 'f1')],
    });
    await flushAsync(40);
    applySent(h, revived, 'f1');

    expect(revived.getText('content').toJSON()).toBe('typed\n');
    expect(h.vault.text('a.md')).toBe('typed\n');
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a server doc rebuilt with the same text (a project seeded again)', () => {
  it('merges an edit once into the rebuilt doc when the note is hydrated', async () => {
    const idb = new FakeIndexedDb();
    store(idb, 'a.md', serverDocWith('A\n'), 'f1');
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', 'A\n');
    const rebuilt = serverDocWith('A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];
    // Disk and server agree: the catch-up leaves the doc closed.
    await connect(h, { yjsDocs: [snapshotOf(rebuilt, 'f1')] });
    await flushAsync(20);
    expect(h.doc.has('b1', 'a.md')).toBe(false);
    const mark = h.socket().emits.length;

    h.vault.files.set('a.md', encode('A\nmore\n'));
    const editing = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    answerFetches(h, rebuilt);
    await editing;
    await flushAsync(20);
    applySent(h, rebuilt, 'f1', mark);

    expect(rebuilt.getText('content').toJSON()).toBe('A\nmore\n');
    expect(h.vault.text('a.md')).toBe('A\nmore\n');
    expect(idb.textOf(dbNameOf('a.md'))).toBe('A\nmore\n');
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — the lineage check leaves the normal flows alone', () => {
  it('a note created here, seeded by the server, edited, and caught up after a restart', async () => {
    const idb = new FakeIndexedDb();
    const h1 = buildHarness({ docs: idb.manager() });
    await connect(h1);
    h1.vault.files.set('n.md', encode('hello\n'));
    const creating = h1.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'n.md',
      source: 'obsidian',
    });
    await flushAsync();
    h1.socket()
      .pending('file:create', 'n.md')
      .ack({ ok: true, outcome: { fileId: 'f1', path: 'n.md' } });
    await creating;
    await flushAsync();
    // The server seeds the note's doc from the uploaded text and sends it.
    const seeded = serverDocWith('hello\n');
    h1.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(seeded)),
    });
    await flushAsync(20);
    h1.vault.files.set('n.md', encode('hello\nmore\n'));
    await h1.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'n.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    applySent(h1, seeded, 'f1');
    expect(seeded.getText('content').toJSON()).toBe('hello\nmore\n');
    await h1.engine.stop();
    const deletedBefore = [...idb.deleted];

    // Offline: another save, folded in. Then a restart and a teammate's edit.
    const h2 = buildHarness({ predecessor: h1, docs: idb.manager() });
    h2.vault.files.set('n.md', encode('hello\nmore\noffline\n'));
    await h2.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'n.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    await h2.engine.stop();
    const h3 = buildHarness({ predecessor: h2, docs: idb.manager() });
    seeded.getText('content').insert(0, 'teammate\n');
    const text = seeded.getText('content').toJSON();
    h3.serverFiles = [serverFile('f1', 'n.md', 'TEXT', await sha256Hex(text), text.length)];
    await connect(h3, { yjsDocs: [snapshotOf(seeded, 'f1')] });
    await flushAsync(40);
    applySent(h3, seeded, 'f1');

    expect(seeded.getText('content').toJSON()).toBe('teammate\nhello\nmore\noffline\n');
    expect(h3.vault.text('n.md')).toBe('teammate\nhello\nmore\noffline\n');
    expect(idb.deleted).toEqual(deletedBefore);
    expect(conflictCopies(h3)).toEqual([]);
    await h3.engine.stop();
  });

  it('a note the catch-up skipped, hydrated with yjs:fetch', async () => {
    const idb = new FakeIndexedDb();
    const d1 = serverDocWith('A\n');
    // A store from before 0.3.8: no stamp.
    store(idb, 'a.md', d1);
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', 'A\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('A\n'), 2)];
    await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(20);
    remoteEdit(h, d1, 'f1', 'teammate\n');
    await flushAsync(20);
    answerFetches(h, d1);
    await flushAsync(20);
    const mark = h.socket().emits.length;

    h.vault.files.set('a.md', encode('teammate\nA\nmine\n'));
    await h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync(20);
    applySent(h, d1, 'f1', mark);

    expect(d1.getText('content').toJSON()).toBe('teammate\nA\nmine\n');
    expect(idb.deleted).toEqual([]);
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f1');
    await h.engine.stop();
  });

  it('a note a teammate created, while its doc is open', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    await connect(h);
    const d1 = serverDocWith('first\n');
    h.socket().fire('file:created', {
      result: { outcome: { fileId: 'f1', path: 'x.md' } },
      log: eventLog,
    });
    h.socket().fire('yjs:update', { fileId: 'f1', update: Array.from(Y.encodeStateAsUpdate(d1)) });
    await flushAsync(20);
    remoteEdit(h, d1, 'f1', 'second\n');
    await flushAsync(20);
    const deletedBefore = [...idb.deleted];

    h.socket().disconnect();
    h.socket().connect();
    await flushAsync();
    h.serverFiles = [serverFile('f1', 'x.md', 'TEXT', await sha256Hex('second\nfirst\n'), 13)];
    h.socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: [snapshotOf(d1, 'f1')] });
    await flushAsync(40);

    expect(h.vault.text('x.md')).toBe('second\nfirst\n');
    expect(idb.deleted).toEqual(deletedBefore);
    await h.engine.stop();
  });

  it('a note deleted and created again under its name while this device is online', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const old = serverDocWith('old text\n');
    await remember(h, 'a.md', 'f1', 'old text\n', 'old text\nedit\n');
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('old text\n'), 9)];
    await connect(h, { yjsDocs: [snapshotOf(old, 'f1')] });
    await flushAsync(40);
    applySent(h, old, 'f1');
    expect(old.getText('content').toJSON()).toBe('old text\nedit\n');
    const mark = h.socket().emits.length;

    // Deleted, then revived under the same id with a history of its own.
    h.socket().fire('file:deleted', { fileId: 'f1', log: eventLog });
    await flushAsync(20);
    const revived = serverDocWith('new note\n');
    h.socket().fire('file:created', {
      result: { outcome: { fileId: 'f1', path: 'a.md' } },
      log: eventLog,
    });
    await flushAsync(20);
    h.socket().fire('yjs:update', {
      fileId: 'f1',
      update: Array.from(Y.encodeStateAsUpdate(revived)),
    });
    await flushAsync(40);
    applySent(h, revived, 'f1', mark);

    expect(revived.getText('content').toJSON()).toBe('new note\n');
    expect(h.vault.text('a.md')).toBe('new note\n');
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });

  it('a server that collected garbage since', async () => {
    const idb = new FakeIndexedDb();
    const d0 = serverDocWith('A\nB\nC\n');
    store(
      idb,
      'a.md',
      continued(d0, (t) => t.insert(t.length, 'mine\n')),
      'f1',
    );
    const h = buildHarness({ docs: idb.manager() });
    await remember(h, 'a.md', 'f1', 'A\nB\nC\n', 'A\nB\nC\nmine\n');
    const meta = h.log.getFileMeta('b1', 'a.md');
    if (!meta) throw new Error('no meta');
    h.log.setFileMeta({ ...meta, foldedHash: await sha256Hex('A\nB\nC\nmine\n') });
    // A teammate deleted a line; the server stored its doc anew since.
    d0.getText('content').delete(0, 2);
    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, Y.mergeUpdates([Y.encodeStateAsUpdate(d0)]));
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex('B\nC\n'), 4)];

    await connect(h, { yjsDocs: [snapshotOf(compacted, 'f1')] });
    await flushAsync(40);
    applySent(h, compacted, 'f1');

    expect(compacted.getText('content').toJSON()).toBe('B\nC\nmine\n');
    expect(h.vault.text('a.md')).toBe('B\nC\nmine\n');
    expect(idb.deleted).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — state.json lost, offline stores from before 0.3.8 intact', () => {
  it('keeps a teammate’s edit made meanwhile', async () => {
    const idb = new FakeIndexedDb();
    const server = serverDocWith('A\nB\n');
    store(idb, 'a.md', server);
    server.getText('content').insert(0, 'top\n');
    const text = server.getText('content').toJSON();
    const h = buildHarness({ docs: idb.manager() });
    h.vault.files.set('a.md', encode('A\nB\n'));
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(text), text.length)];

    await connect(h, { yjsDocs: [snapshotOf(server, 'f1')] });
    await flushAsync(60);
    applySent(h, server, 'f1');

    expect(server.getText('content').toJSON()).toBe('top\nA\nB\n');
    expect(h.vault.text('a.md')).toBe('top\nA\nB\n');
    expect(idb.dbs.get(dbNameOf('a.md'))?.custom.get(OWNER)).toBe('f1');
    await h.engine.stop();
  });

  it('keeps both that edit and an offline one only the store and the disk have', async () => {
    const idb = new FakeIndexedDb();
    const server = serverDocWith('A\nB\n');
    store(
      idb,
      'a.md',
      continued(server, (t) => t.insert(4, 'mine\n')),
    );
    server.getText('content').insert(0, 'top\n');
    const text = server.getText('content').toJSON();
    const h = buildHarness({ docs: idb.manager() });
    h.vault.files.set('a.md', encode('A\nB\nmine\n'));
    h.serverFiles = [serverFile('f1', 'a.md', 'TEXT', await sha256Hex(text), text.length)];

    await connect(h, { yjsDocs: [snapshotOf(server, 'f1')] });
    await flushAsync(60);
    applySent(h, server, 'f1');

    expect(server.getText('content').toJSON()).toBe('top\nA\nB\nmine\n');
    expect(h.vault.text('a.md')).toBe('top\nA\nB\nmine\n');
    await h.engine.stop();
  });

  it('opens no store at connect, nor for the notes whose disk matches the server', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const files = [];
    const snaps = [];
    for (let i = 0; i < 40; i++) {
      const path = `notes/n${i}.md`;
      const text = `note ${i}\n`;
      const serverDoc = serverDocWith(text);
      store(idb, path, serverDoc);
      h.vault.files.set(path, encode(text));
      files.push(serverFile(`f${i}`, path, 'TEXT', await sha256Hex(text), text.length));
      snaps.push(snapshotOf(serverDoc, `f${i}`));
    }
    h.serverFiles = files;

    await connect(h, { yjsDocs: snaps });
    await flushAsync(60);

    expect(files.filter((f) => h.doc.has('b1', f.path))).toEqual([]);
    expect(h.calls.filter((c) => c === 'doc.open')).toEqual([]);
    expect(idb.deleted).toEqual([]);
    expect(h.socket().emits.filter((e) => e.event === 'yjs:update')).toEqual([]);
    await h.engine.stop();
  });

  it.each([
    ['with text', 'new\n'],
    ['empty (Obsidian’s new “Untitled”)', ''],
  ])(
    'does not take another note’s history left under the name for the note there (%s)',
    async (_label, fresh) => {
      const idb = new FakeIndexedDb();
      // What 0.3.7 left under the name when an older note moved away from it.
      store(idb, 'Untitled.md', serverDocWith('an older note\n'));
      const h = buildHarness({ docs: idb.manager() });
      const d2 = serverDocWith(fresh);
      h.serverFiles = [
        serverFile('f2', 'Untitled.md', 'TEXT', await sha256Hex(fresh), fresh.length),
      ];

      await connect(h, { yjsDocs: [snapshotOf(d2, 'f2')] });
      await flushAsync(40);
      applySent(h, d2, 'f2');

      expect(d2.getText('content').toJSON()).toBe(fresh);
      expect(h.vault.text('Untitled.md')).toBe(fresh);
      await h.engine.stop();
    },
  );
});
