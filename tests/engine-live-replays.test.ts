/**
 * The catch-up of `project:join` returns every operation the device's vector
 * clock has not seen — and a live broadcast does not move the clock. So it
 * returns what this device applied live as well: a teammate's attachment
 * update, a rename, a note deleted and created again under its id. A server
 * that gives the whole journal (asked for with `operationsCatchup`) does that
 * in any project; the one before it, in projects of up to 500 operations.
 *
 * Before: replayed over what the device did since, the update wrote the
 * teammate's version over an attachment edited offline (the edit was lost,
 * without a question), the rename moved a note back from where the user had
 * renamed it, and the revival was taken for one made while the device was
 * away — an offline edit of the note went into a conflict copy, an offline
 * rename or delete was dropped.
 *
 * And a server that gives the window of the journal's first 500 rows gives a
 * longer project nothing new: attachments are checked against the listing
 * then, or a new one never came and an edit made offline went out over a
 * teammate's newer version.
 */
import { sha256Hex } from '@/sync/hash';
import type { ServerOperation } from '@/client/socket';
import {
  FOREIGN_DB,
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  buildHarness,
  bytes,
  connect,
  encode,
  flushAsync,
  json,
  op,
  userRename,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

/** How the server answers `project:join`: see `sync-protocol.md`, «Подключение». */
type Form = 'whole journal' | 'first rows';

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

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function modals(h: Harness): string[] {
  return h.calls.filter((c) => c.startsWith('modal.'));
}

function event(h: Harness, type: 'create' | 'modify' | 'delete', path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });
}

/** The answer to `project:join` for `form`, with `operations`. */
function joinAck(docs: ServerDocs, form: Form, operations: ServerOperation[]): unknown {
  return {
    ok: true,
    operations,
    ...(form === 'whole journal' ? { operationsCatchup: 2 } : {}),
    yjsDocs: docs.snapshots(),
  };
}

/** The network drops. */
async function drop(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

/** The network is back: the socket connects and the join is answered with the catch-up. */
async function reconnect(h: Harness, server: FakeServer, docs: ServerDocs, form: Form) {
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack(joinAck(docs, form, server.catchupFor()));
  await docs.drive();
}

/**
 * Notes on disk, in `state.json` and on the server; the engine connected. The
 * server of the `legacy` format replaces a note's history when it revives it,
 * as production did when 0.3.8 came out.
 */
async function withNotes(
  format: BroadcastFormat,
  notes: Array<[string, string, string]>,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
  for (const [id, path, text] of notes) {
    await remember(h, path, id, text);
    await docs.add(id, path, text);
  }
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  return { h, server, docs };
}

const FORMS: Form[] = ['whole journal', 'first rows'];
const MATRIX = (['current', 'legacy'] as const).flatMap((format) =>
  FORMS.map((form) => [format, form] as const),
);

describe.each(MATRIX)(
  'SyncEngine — an attachment update applied live and replayed, %s broadcasts, %s',
  (format, form) => {
    it.each([1, 2])(
      'does not write the teammate’s version over an edit made offline since (%i updates)',
      async (updates) => {
        const h = buildHarness();
        const server = new FakeServer(h, format);
        const docs = new ServerDocs(server, h);
        const v0 = encode('v0');
        const theirs = encode('teammate v1');
        const mine = encode('my offline v2');
        let served = v0;
        h.routes.set('GET /api/projects/p1/files/i1', () => bytes(served));
        server.add({
          id: 'i1',
          path: 'img.png',
          fileType: 'BINARY',
          contentHash: await sha256Hex(v0),
          size: v0.byteLength,
        });
        h.vault.files.set('img.png', v0);
        h.log.setFileMeta({
          bindingId: 'b1',
          relativePath: 'img.png',
          serverFileId: 'i1',
          contentHash: await sha256Hex(v0),
          size: v0.byteLength,
          fileType: 'BINARY',
          lastSyncedAt: 1,
        });
        await connect(h);
        await docs.drive();

        // Live: the teammate's new versions come down. The catch-up finds the
        // last of them synced here; an earlier one, the version the server has
        // now.
        if (updates === 2) {
          served = encode('teammate v0.5');
          await server.teammateUpdate('i1', served);
          await flushAsync(40);
        }
        served = theirs;
        await server.teammateUpdate('i1', theirs);
        await flushAsync(40);
        expect(h.vault.text('img.png')).toBe('teammate v1');

        // Offline: the user edits it.
        await drop(h);
        h.vault.files.set('img.png', mine);
        await event(h, 'modify', 'img.png');
        expect(h.log.dequeueOperations('b1').map((o) => o.opType)).toEqual(['UPDATE']);

        // The catch-up returns the teammate's update.
        expect(server.catchupFor().map((o) => o.opType)).toContain('UPDATE');
        await reconnect(h, server, docs, form);

        expect(server.files.get('i1')?.contentHash).toBe(await sha256Hex(mine));
        expect(h.vault.text('img.png')).toBe('my offline v2');
        expect(modals(h)).toEqual([]);
        expect(h.log.dequeueOperations('b1')).toEqual([]);
        await h.engine.stop();
      },
    );
  },
);

describe.each(MATRIX)(
  'SyncEngine — a teammate’s rename applied live and replayed, %s broadcasts, %s',
  (format, form) => {
    it('does not move the note back from where the user renamed it since', async () => {
      const { h, server, docs } = await withNotes(format, [['f1', 'A.md', 'A\n']]);
      server.teammateRename('f1', 'B.md');
      await flushAsync(40);
      expect(disk(h)).toEqual(['B.md=A\n']);
      await userRename(h, 'B.md', 'C.md');
      await docs.drive();
      // Another operation of this device's after it: its clock covers the
      // rename, and the catch-up leaves that one out.
      h.vault.files.set('other.md', encode('x\n'));
      const made = event(h, 'create', 'other.md');
      await docs.drive();
      await made;
      expect(server.pathOf('f1')).toBe('C.md');
      const renames = server.applied.length;

      await drop(h);
      await reconnect(h, server, docs, form);

      expect(server.applied.slice(renames)).toEqual([]);
      expect(server.pathOf('f1')).toBe('C.md');
      expect(disk(h)).toEqual(['C.md=A\n', 'other.md=x\n']);
      expect(h.engine.getFileIdForPath('C.md')).toBe('f1');
      await h.engine.stop();
    });

    it('does not move the note away from the name the user gave it back', async () => {
      const { h, server, docs } = await withNotes(format, [['f1', 'A.md', 'A\n']]);
      server.teammateRename('f1', 'B.md');
      await flushAsync(40);
      // Undone here: back to its first name, the one the rename starts from.
      await userRename(h, 'B.md', 'A.md');
      await docs.drive();
      h.vault.files.set('other.md', encode('x\n'));
      const made = event(h, 'create', 'other.md');
      await docs.drive();
      await made;
      expect(server.pathOf('f1')).toBe('A.md');
      const done = server.applied.length;

      await drop(h);
      await reconnect(h, server, docs, form);

      expect(server.applied.slice(done)).toEqual([]);
      expect(disk(h)).toEqual(['A.md=A\n', 'other.md=x\n']);
      expect(h.engine.getFileIdForPath('A.md')).toBe('f1');
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a rename whose catch-up comes after this device renamed the note on, %s broadcasts',
  (format) => {
    it('leaves the note where the user put it (the rename was applied from the listing)', async () => {
      // Renamed by a teammate while this device was away; the next connect
      // got the window of the journal's first rows, without it, and the
      // listing moved the note.
      const { h, server, docs } = await withNotes(format, [['f1', 'A.md', 'A\n']]);
      await drop(h);
      server.teammateRename('f1', 'B.md');
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack(joinAck(docs, 'first rows', []));
      await docs.drive();
      expect(disk(h)).toEqual(['B.md=A\n']);

      await userRename(h, 'B.md', 'C.md');
      h.vault.files.set('other.md', encode('x\n'));
      const made = event(h, 'create', 'other.md');
      await docs.drive();
      await made;
      const done = server.applied.length;

      // A server that gives the whole journal: the teammate's rename comes now.
      await drop(h);
      const catchup = server.catchupFor();
      expect(catchup.map((o) => `${o.opType} ${o.filePath}`)).toContain('RENAME A.md');
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack(joinAck(docs, 'whole journal', catchup));
      await docs.drive();

      expect(server.applied.slice(done)).toEqual([]);
      expect(disk(h)).toEqual(['C.md=A\n', 'other.md=x\n']);
      expect(h.engine.getFileIdForPath('C.md')).toBe('f1');
      await h.engine.stop();
    });
  },
);

/**
 * A teammate deletes `U.md` and creates a new `U.md`: the server brings the
 * id back. This device applies both live.
 */
async function revivedLive(
  format: BroadcastFormat,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const { h, server, docs } = await withNotes(format, [['f4', 'U.md', 'old\n']]);
  server.teammateDelete('f4');
  await flushAsync(40);
  expect(disk(h)).toEqual([]);
  await server.teammateCreate('U.md', 'new\n');
  await docs.drive();
  expect(disk(h)).toEqual(['U.md=new\n']);
  expect(h.engine.getFileIdForPath('U.md')).toBe('f4');
  await drop(h);
  return { h, server, docs };
}

describe.each(MATRIX)(
  'SyncEngine — a note deleted and created again, applied live and replayed, %s broadcasts, %s',
  (format, form) => {
    it('merges an edit made offline since into the note', async () => {
      const { h, server, docs } = await revivedLive(format);
      h.vault.files.set('U.md', encode('new\nmine\n'));
      await event(h, 'modify', 'U.md');

      await reconnect(h, server, docs, form);

      expect(docs.live()).toEqual(['U.md=new\nmine\n']);
      expect(disk(h)).toEqual(['U.md=new\nmine\n']);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('sends a rename made offline since', async () => {
      const { h, server, docs } = await revivedLive(format);
      await userRename(h, 'U.md', 'T.md');

      await reconnect(h, server, docs, form);

      expect(docs.live()).toEqual(['T.md=new\n']);
      expect(disk(h)).toEqual(['T.md=new\n']);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('sends a delete made offline since', async () => {
      const { h, server, docs } = await revivedLive(format);
      h.vault.files.delete('U.md');
      await event(h, 'delete', 'U.md');

      await reconnect(h, server, docs, form);

      expect(server.pathOf('f4')).toBeNull();
      expect(disk(h)).toEqual([]);
      await h.engine.stop();
    });

    it('merges an edit made offline after a connect to a server that gave the journal’s first rows only', async () => {
      const { h, server, docs } = await revivedLive(format);
      // A server whose window of the journal's first rows leaves the revival
      // out: nothing comes back, and the clock does not move.
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack(joinAck(docs, 'first rows', []));
      await docs.drive();
      await drop(h);
      h.vault.files.set('U.md', encode('new\nmine\n'));
      await event(h, 'modify', 'U.md');

      // Then the whole journal: the revival comes, applied live long ago.
      await reconnect(h, server, docs, 'whole journal');

      expect(docs.live()).toEqual(['U.md=new\nmine\n']);
      expect(disk(h)).toEqual(['U.md=new\nmine\n']);
      await h.engine.stop();
    });

    it('merges an edit made offline, after a restart as well', async () => {
      const { h, server, docs } = await revivedLive(format);
      h.vault.files.set('U.md', encode('new\nmine\n'));
      await event(h, 'modify', 'U.md');
      await h.engine.stop();

      const next = buildHarness({ predecessor: h });
      server.attach(next);
      docs.attach(next);
      await next.engine.start();
      next
        .socket()
        .pending('project:join')
        .ack(joinAck(docs, form, server.catchupFor()));
      await docs.drive();

      expect(docs.live()).toEqual(['U.md=new\nmine\n']);
      expect(disk(next)).toEqual(['U.md=new\nmine\n']);
      await next.engine.stop();
    });
  },
);

describe('SyncEngine — what a catch-up replays for files already in sync', () => {
  it('opens no doc for the CREATE of a note whose disk matches the server', async () => {
    const idb = new FakeIndexedDb();
    const h = buildHarness({ docs: idb.manager() });
    const server = new FakeServer(h);
    const docs = new ServerDocs(server, h);
    const ops: ServerOperation[] = [];
    for (let i = 1; i <= 3; i++) {
      await remember(h, `n${i}.md`, `f${i}`, `note ${i}\n`);
      await docs.add(`f${i}`, `n${i}.md`, `note ${i}\n`);
      ops.push(op('CREATE', `n${i}.md`, null, { fileId: `f${i}`, fileType: 'TEXT' }, i));
    }
    await connect(h, { operations: ops, yjsDocs: docs.snapshots() });
    await docs.drive();

    expect([...idb.dbs.keys()]).toEqual([FOREIGN_DB]);
    expect(disk(h)).toEqual(['n1.md=note 1\n', 'n2.md=note 2\n', 'n3.md=note 3\n']);
    await h.engine.stop();
  });

  it('downloads nothing for the UPDATE of an attachment this device already has', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const docs = new ServerDocs(server, h);
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
    await connect(h, {
      operations: [op('UPDATE', 'img.png', null, { fileId: 'i1', contentHash: hash }, 4)],
    });
    await docs.drive();

    expect(h.requests.filter((r) => r.path === '/api/projects/p1/files/i1')).toEqual([]);
    expect(h.vault.text('img.png')).toBe('v1');
    await h.engine.stop();
  });

  it('takes a note’s text from its doc, not from the UPDATE a server before 0.3.8 lists', async () => {
    const base = await sha256Hex('N\n');
    const { h, docs } = await withNotes('legacy', [['f1', 'N.md', 'N\n']]);
    // The server's version history has the text this device last synced.
    h.routes.set('GET /api/projects/p1/files/f1/versions', () =>
      json({
        versions: [
          { id: 'v1', versionNumber: 1, contentHash: base, size: 2, createdAt: '', authorId: null },
        ],
      }),
    );
    h.routes.set('GET /api/projects/p1/files/f1/versions/v1', () => bytes(encode('N\n')));
    // Written through MCP while the network was down here, and edited here.
    await drop(h);
    const text = docs.docs.get('f1')?.getText('content');
    text?.insert(2, 'mcp\n');
    h.vault.files.set('N.md', encode('mine\nN\n'));
    await event(h, 'modify', 'N.md');
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(encode('N\nmcp\n')));

    h.socket().connect();
    await flushAsync();
    h.socket()
      .pending('project:join')
      .ack(
        joinAck(docs, 'first rows', [
          op('UPDATE', 'N.md', null, { fileId: 'f1', contentHash: await sha256Hex('N\nmcp\n') }, 9),
        ]),
      );
    await docs.drive();

    expect(modals(h)).toEqual([]);
    expect(h.requests.filter((r) => r.path === '/api/projects/p1/files/f1')).toEqual([]);
    expect(docs.live()).toEqual(['N.md=mine\nN\nmcp\n']);
    expect(disk(h)).toEqual(['N.md=mine\nN\nmcp\n']);
    await h.engine.stop();
  });
});

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — attachments after the window of the journal’s first rows, %s broadcasts',
  (format) => {
    it('downloads an attachment a teammate added while this device was away', async () => {
      const { h, server, docs } = await withNotes(format, [['f1', 'a.md', 'A\n']]);
      await drop(h);
      const pic = encode('their picture');
      h.routes.set('GET /api/projects/p1/files/s1', () => bytes(pic));
      expect(await server.teammateUpload('pic.png', pic)).toBe('s1');

      h.socket().connect();
      await flushAsync();
      // A project longer than the window: no operations at all.
      h.socket()
        .pending('project:join')
        .ack(joinAck(docs, 'first rows', []));
      await docs.drive();

      expect(h.vault.text('pic.png')).toBe('their picture');
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it.each(['keep-both', 'keep-local'] as const)(
      'asks about an attachment edited here while a teammate uploaded a newer version (%s)',
      async (answer) => {
        const { h, server, docs } = await withNotes(format, [['f1', 'a.md', 'A\n']]);
        const v0 = encode('v0');
        const theirs = encode('teammate v1');
        const mine = encode('my offline v2');
        let served = v0;
        h.routes.set('GET /api/projects/p1/files/s1', () => bytes(served));
        expect(await server.teammateUpload('img.png', v0)).toBe('s1');
        await flushAsync(40);
        expect(h.vault.text('img.png')).toBe('v0');

        await drop(h);
        h.vault.files.set('img.png', mine);
        await event(h, 'modify', 'img.png');
        served = theirs;
        await server.teammateUpdate('s1', theirs);
        h.modal.binary.resolve(answer);

        h.socket().connect();
        await flushAsync();
        h.socket()
          .pending('project:join')
          .ack(joinAck(docs, 'first rows', []));
        await docs.drive();

        expect(modals(h)).toEqual(['modal.resolveBinaryConflict']);
        const hashes = [...server.files.values()]
          .filter((f) => !f.deleted && f.fileType === 'BINARY')
          .map((f) => f.contentHash)
          .sort();
        const expected =
          answer === 'keep-both'
            ? [await sha256Hex(mine), await sha256Hex(theirs)].sort()
            : [await sha256Hex(mine)];
        expect(hashes).toEqual(expected);
        expect(h.vault.text('img.png')).toBe(
          answer === 'keep-both' ? 'teammate v1' : 'my offline v2',
        );
        await h.engine.stop();
      },
    );
  },
);
