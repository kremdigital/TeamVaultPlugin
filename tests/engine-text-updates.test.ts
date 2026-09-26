/**
 * A note's text travels through its doc, never as an attachment update — in
 * either direction.
 *
 * A server before 0.3.8's lists the UPDATE of a note written through REST or
 * MCP (`write_note`) in the catch-up, and broadcasts `file:updated-binary` for
 * a note when a 0.3.x client answers "Keep local" about it. Taken as an
 * attachment's, the note's bytes were downloaded beside its doc: over an edit
 * made offline meanwhile, a "Content conflict" prompt whose every answer did
 * worse than the merge of the doc — "Keep server" mangled the offline edit
 * for the whole team, "Keep local" sent the note's bytes on as an attachment
 * update, "Keep both" made a copy of the note; without an edit, the bytes were
 * written over the disk beside the doc.
 *
 * Also: an attachment deleted here while a teammate's update of it was on its
 * way came back to disk when the server had the version this device synced.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  bytes,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  eventLog,
  flushAsync,
  json,
  type BroadcastFormat,
  type CatchupForm,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<void> {
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
}

function modals(h: Harness): string[] {
  return h.calls.filter((c) => c.startsWith('modal.'));
}

function emitted(h: Harness, event: string): number {
  return h.socket().emits.filter((e) => e.event === event).length;
}

/** The lines of `text`, sorted: where a merge puts each line is its own business. */
function lines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .sort();
}

/**
 * Note `a.md` ("old") on disk, in `state.json` and on the server; the engine
 * connected. The server serves the note's bytes, as one before 0.3.8's does
 * for a note written through REST, and its version history holds the text
 * this device synced: the base the fold of an offline edit merges from.
 */
async function withNote(format: BroadcastFormat, text = 'old\n') {
  const idb = new FakeIndexedDb();
  const h = buildHarness({ docs: idb.manager() });
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  await remember(h, 'a.md', 'f1', text);
  await docs.add('f1', 'a.md', text);
  h.routes.set('GET /api/projects/p1/files/f1', () => bytes(encode(docs.text('f1') ?? '')));
  const synced = await sha256Hex(text);
  h.routes.set('GET /api/projects/p1/files/f1/versions', () =>
    json({
      versions: [
        { id: 'v1', versionNumber: 1, contentHash: synced, createdAt: '', authorId: 'u1' },
      ],
    }),
  );
  h.routes.set('GET /api/projects/p1/files/f1/versions/v1', () => bytes(encode(text)));
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  return { idb, h, server, docs };
}

async function drop(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

async function editOffline(h: Harness, from: string, to: string): Promise<void> {
  h.vault.files.set('a.md', encode((h.vault.text('a.md') ?? '').replace(from, to)));
  await h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'modify',
    path: 'a.md',
    source: 'obsidian',
  });
  await flushAsync(20);
}

async function reconnect(h: Harness, server: FakeServer, docs: ServerDocs, form: CatchupForm) {
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack(server.joinAnswer(form, { yjsDocs: docs.snapshots() }));
  await docs.drive();
}

/** Both the offline line and the MCP one, once each; disk, store and server agree. */
function expectMerged(idb: FakeIndexedDb, h: Harness, docs: ServerDocs): void {
  expect(lines(docs.text('f1'))).toEqual(['mcp', 'offline', 'old']);
  expect(h.vault.text('a.md')).toBe(docs.text('f1'));
  expect(idb.textOf(dbNameOf('a.md'))).toBe(docs.text('f1'));
  expect([...h.vault.files.keys()]).toEqual(['a.md']);
  expect(modals(h)).toEqual([]);
  expect(h.requests.filter((r) => r.path === '/api/projects/p1/files/f1')).toEqual([]);
  expect(emitted(h, 'file:update-binary')).toBe(0);
  expect(h.socket().created()).toEqual([]);
}

// Production today, and the server that knows the flag: the whole journal,
// without the UPDATE rows of notes.
const SERVERS = [
  ['legacy', 'first rows'],
  ['current', 'whole journal'],
] as const;

describe.each(SERVERS)(
  'SyncEngine — a note written through MCP and edited offline, %s broadcasts, %s',
  (format, form) => {
    // U-X: the MCP write comes while this device is away.
    it.each(['keep-server', 'keep-local', 'keep-both'] as const)(
      'written while this device was away: no question, both edits kept (a %s answer is never asked for)',
      async (answer) => {
        const { idb, h, server, docs } = await withNote(format);
        h.modal.binary.resolve(answer);

        await drop(h);
        await editOffline(h, 'old\n', 'old\noffline\n');
        await docs.restWrite('f1', 'old\nmcp\n');
        expect(server.catchupFor().map((op) => op.opType)).toEqual(['UPDATE']);
        await reconnect(h, server, docs, form);

        expectMerged(idb, h, docs);
        await h.engine.stop();
      },
    );

    // U-Y: the MCP write comes live; then this device goes offline, and the
    // catch-up lists the write, which a live update does not take off it.
    it.each(['keep-server', 'keep-local', 'keep-both'] as const)(
      'written while this device was online, then edited offline: both edits kept (%s never asked for)',
      async (answer) => {
        const { idb, h, server, docs } = await withNote(format);
        h.modal.binary.resolve(answer);

        await docs.restWrite('f1', 'old\nmcp\n');
        await docs.drive();
        expect(h.vault.text('a.md')).toBe('old\nmcp\n');

        await drop(h);
        await editOffline(h, 'old\n', 'old\noffline\n');
        expect(idb.textOf(dbNameOf('a.md'))).toBe('old\noffline\nmcp\n');
        await reconnect(h, server, docs, form);

        expectMerged(idb, h, docs);
        await h.engine.stop();
      },
    );
  },
);

// U-Z: where the edits land. The note's history is on this device — a write
// through MCP came live — when it is edited offline, and MCP writes it again
// meanwhile, changing another line. A server that writes the text as the
// smallest edit keeps what it left unchanged: each edit stays where it was
// made. One that deleted the whole text and inserted the new one (production
// when 0.3.8 came out) moved a word typed inside a line to the start of the
// note, brought a deleted line back and doubled a replaced word — for the
// whole team.
describe('SyncEngine — a note with its history here, edited offline and written through MCP', () => {
  const base = 'alpha beta\ngamma\ndelta\n';
  const written = 'alpha beta\nGAMMA\ndelta\n';
  it.each([
    [
      'a word typed inside a line',
      'alpha new beta\ngamma\ndelta\n',
      'alpha new beta\nGAMMA\ndelta\n',
    ],
    ['a line deleted', 'alpha beta\ngamma\n', 'alpha beta\nGAMMA\n'],
    ['a word replaced', 'ALPHA beta\ngamma\ndelta\n', 'ALPHA beta\nGAMMA\ndelta\n'],
    ['a line added at the end', `${base}offline\n`, `${written}offline\n`],
  ])('keeps %s where it was', async (_what, offline, merged) => {
    const { idb, h, server, docs } = await withNote('current', 'alpha beta\ngamma\n');
    await docs.restWrite('f1', base);
    await docs.drive();
    expect(h.vault.text('a.md')).toBe(base);
    expect(idb.textOf(dbNameOf('a.md'))).toBe(base);

    await drop(h);
    await editOffline(h, base, offline);
    expect(idb.textOf(dbNameOf('a.md'))).toBe(offline);
    await docs.restWrite('f1', written);
    await reconnect(h, server, docs, 'whole journal');

    expect(docs.text('f1')).toBe(merged);
    expect(h.vault.text('a.md')).toBe(merged);
    expect(idb.textOf(dbNameOf('a.md'))).toBe(merged);
    expect(modals(h)).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — an attachment update of a note, live', () => {
  it.each(['legacy', 'current'] as const)(
    'is left alone: the note keeps its text and its doc (%s broadcasts)',
    async (format) => {
      const { idb, h, server, docs } = await withNote(format);
      // A 0.3.x teammate answered "Keep local" about the note: its bytes went
      // to the server as an attachment update.
      h.routes.set('GET /api/projects/p1/files/f1', () => bytes(encode('stale bytes\n')));
      await server.teammateUpdate('f1', encode('stale bytes\n'));
      await flushAsync(40);
      await docs.drive();

      expect(h.requests.filter((r) => r.path === '/api/projects/p1/files/f1')).toEqual([]);
      expect(h.vault.text('a.md')).toBe('old\n');
      expect(docs.text('f1')).toBe('old\n');
      expect(idb.textOf(dbNameOf('a.md'))).toBeNull();
      expect(modals(h)).toEqual([]);
      await h.engine.stop();
    },
  );
});

describe('SyncEngine — a queued attachment update of a note', () => {
  it('goes to the server through the note’s doc', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const docs = new ServerDocs(server, h);
    await remember(h, 'a.md', 'f1', 'old\n');
    await docs.add('f1', 'a.md', 'old\n');
    // A queue `state.json` kept: the save of the note, as an attachment's.
    h.vault.files.set('a.md', encode('old\nmine\n'));
    h.log.enqueueOperation('b1', {
      opType: 'UPDATE',
      filePath: 'a.md',
      newPath: null,
      payload: { fileId: 'f1' },
    });

    await connect(h);
    await docs.drive();

    expect(emitted(h, 'file:update-binary')).toBe(0);
    expect(server.applied).toEqual([]);
    expect(docs.text('f1')).toBe('old\nmine\n');
    expect(h.vault.text('a.md')).toBe('old\nmine\n');
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — an attachment deleted here while a teammate’s update of it comes', () => {
  it('is not written back when the server has the version this device synced', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const v1 = encode('v1');
    const hash = await sha256Hex(v1);
    server.add({ id: 'i1', path: 'img.png', fileType: 'BINARY', contentHash: hash, size: 2 });
    h.vault.files.set('img.png', v1);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'img.png',
      serverFileId: 'i1',
      contentHash: hash,
      size: 2,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    // The teammate's v2 was undone right after: the server has v1 again.
    h.routes.set('GET /api/projects/p1/files/i1', () => bytes(v1));
    await connect(h);
    await server.pump();

    // The user deletes it; the delete is on its way.
    h.vault.files.delete('img.png');
    const deleting = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'delete',
      path: 'img.png',
      source: 'obsidian',
    });
    await flushAsync(10);
    expect(emitted(h, 'file:delete')).toBe(1);
    h.socket().fire('file:updated-binary', {
      fileId: 'i1',
      contentHash: await sha256Hex('v2'),
      log: eventLog,
      clientId: 'device-2',
    });
    await flushAsync(40);
    await server.pump();
    await deleting;
    await h.settle();

    expect(h.vault.text('img.png')).toBeNull();
    expect(server.applied).toEqual(['delete i1']);
    expect(h.engine.getFileIdForPath('img.png')).toBeNull();
    await h.engine.stop();
  });
});
