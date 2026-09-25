/**
 * A note renamed here to a name the server has given another file meanwhile:
 * a teammate renamed another note to it, or created a new one under it —
 * while this device was offline, or while the rename was on its way. The
 * server stores this device's rename under a conflict name
 * (`c.conflict-device-1.md`), and the other file keeps the name.
 *
 * The other file used to move in at once. Its move parked this note's copy
 * aside as an anonymous conflict copy, and gave the name's record to the
 * file moving in, while this note's record still named it. The rename's ack
 * then moved "this note" to the conflict name — the copy of the file that
 * had moved in — and the fold pushed that text into this note: for the whole
 * team, this note held the other note's text, and the parked copy went up as
 * a duplicate. A new note under the name stayed away until the next connect.
 *
 * Now the other file waits for the name, and moves in once this note has
 * moved to the conflict name.
 */
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  goOnline,
  remoteEdit,
  userRename,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

// Each case runs the server's side too, and a second start.
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

/** Synced notes: on disk, in `state.json`, and on the server with their docs. */
async function notes(
  h: Harness,
  format: BroadcastFormat,
  list: ReadonlyArray<readonly [path: string, fileId: string, text: string]>,
): Promise<{ server: FakeServer; docs: ServerDocs }> {
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  for (const [path, fileId, text] of list) {
    await remember(h, path, fileId, text);
    await docs.add(fileId, path, text);
  }
  return { server, docs };
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

const A_AND_D = [
  ['a.md', 'f1', 'A\n'],
  ['d.md', 'f2', 'D\n'],
] as const;

/** Where both notes must end up: on the server, on disk, in the index. */
async function expectSettled(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  expect(server.pathOf('f1')).toBe('c.conflict-device-1.md');
  expect(server.pathOf('f2')).toBe('c.md');
  expect(docs.live()).toEqual(['c.conflict-device-1.md=A\n', 'c.md=D\n']);
  expect(disk(h)).toEqual(['c.conflict-device-1.md=A\n', 'c.md=D\n']);
  expect(h.engine.getFileIdForPath('c.md')).toBe('f2');
  expect(h.engine.getFileIdForPath('c.conflict-device-1.md')).toBe('f1');
  expect(h.socket().created()).toEqual([]);
  expect(h.eventErrors).toEqual([]);
  // And the next start finds nothing to change.
  await h.engine.stop();
  const next = buildHarness({ predecessor: h });
  server.attach(next);
  docs.attach(next);
  await connect(next, { yjsDocs: docs.snapshots() });
  await docs.drive();
  expect(docs.live()).toEqual(['c.conflict-device-1.md=A\n', 'c.md=D\n']);
  expect(disk(next)).toEqual(['c.conflict-device-1.md=A\n', 'c.md=D\n']);
  expect(next.socket().created()).toEqual([]);
  expect(server.applied).toEqual(['f2 d.md -> c.md', 'f1 a.md -> c.conflict-device-1.md']);
  await next.engine.stop();
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a rename here to a name a teammate gave another note, %s broadcasts',
  (format) => {
    it('offline from the start: the other note moves in once this one has moved out', async () => {
      const h = buildHarness({ offline: true });
      const { server, docs } = await notes(h, format, A_AND_D);
      server.teammateRename('f2', 'c.md');

      await h.engine.start();
      await flushAsync();
      await userRename(h, 'a.md', 'c.md');
      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      await expectSettled(h, server, docs);
    });

    it('offline after a connect, both renames made while the socket was down', async () => {
      const h = buildHarness();
      const { server, docs } = await notes(h, format, A_AND_D);
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      h.socket().disconnect();
      await flushAsync();

      await userRename(h, 'a.md', 'c.md');
      server.teammateRename('f2', 'c.md');
      h.socket().connect();
      await flushAsync();
      h.socket()
        .pending('project:join')
        .ack({ ok: true, operations: [], yjsDocs: docs.snapshots() });
      await docs.drive();

      await expectSettled(h, server, docs);
    });

    it('online, the two renames crossing on the way', async () => {
      const h = buildHarness();
      const { server, docs } = await notes(h, format, A_AND_D);
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      // The rename goes out; the server has not got to it yet.
      await h.vault.rename('a.md', 'c.md');
      await flushAsync();
      expect(h.socket().pending('file:rename').payload).toMatchObject({ fileId: 'f1' });
      // The teammate's rename reaches the server first; its broadcast reaches
      // this device while this rename waits for its ack.
      server.teammateRename('f2', 'c.md');
      await flushAsync(20);
      await docs.drive();

      await expectSettled(h, server, docs);
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a rename here to a name a teammate gave a new note, %s broadcasts',
  (format) => {
    it('brings the new note in once this one has moved out, and follows its edits', async () => {
      const h = buildHarness({ offline: true });
      const { docs } = await notes(h, format, [['Untitled.md', 'f1', 'A\n']]);
      // Created by a teammate while this device was offline.
      await docs.add('s9', 'Meeting.md', 'teammate meeting\n');

      await h.engine.start();
      await flushAsync();
      await userRename(h, 'Untitled.md', 'Meeting.md');
      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(disk(h)).toEqual([
        'Meeting.conflict-device-1.md=A\n',
        'Meeting.md=teammate meeting\n',
      ]);
      expect(h.engine.getFileIdForPath('Meeting.md')).toBe('s9');
      expect(docs.live()).toEqual([
        'Meeting.conflict-device-1.md=A\n',
        'Meeting.md=teammate meeting\n',
      ]);

      const theirs = docs.docs.get('s9');
      if (!theirs) throw new Error('no doc');
      remoteEdit(h, theirs, 's9', 'agenda\n');
      await flushAsync(40);
      expect(h.vault.text('Meeting.md')).toBe('agenda\nteammate meeting\n');
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('online: a new note created under the name while this rename is on its way', async () => {
      const h = buildHarness();
      const { server, docs } = await notes(h, format, [['a.md', 'f1', 'A\n']]);
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      // The rename goes out; the server has not got to it yet.
      await h.vault.rename('a.md', 'c.md');
      await flushAsync();
      expect(h.socket().pending('file:rename').payload).toMatchObject({ fileId: 'f1' });
      const id = await server.teammateCreate('c.md', 'theirs\n');
      await flushAsync(20);
      await docs.drive();

      expect(disk(h)).toEqual(['c.conflict-device-1.md=A\n', 'c.md=theirs\n']);
      expect(docs.live()).toEqual(['c.conflict-device-1.md=A\n', 'c.md=theirs\n']);
      expect(h.engine.getFileIdForPath('c.md')).toBe(id);
      expect(h.engine.getFileIdForPath('c.conflict-device-1.md')).toBe('f1');
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a note created here offline under a name a teammate gave a new note, %s broadcasts',
  (format) => {
    // The server stores the create under a conflict name. The copy here used
    // to stay unrecorded under the name asked for: the teammate's note,
    // indexed there, took it for its own and the fold sent its text into the
    // teammate's note, for everyone. Uploaded again on each save, it left one
    // more conflict copy on the server each time.
    it('keeps both: this one moves to the conflict name, the teammate’s comes in', async () => {
      const h = buildHarness({ offline: true });
      const { server, docs } = await notes(h, format, []);
      // Created by a teammate while this device was offline.
      await docs.add('s9', 'c.md', 'theirs\n');

      await h.engine.start();
      await flushAsync();
      h.vault.files.set('c.md', encode('mine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'create',
        path: 'c.md',
        source: 'obsidian',
      });
      expect(h.log.dequeueOperations('b1').map((o) => o.opType)).toEqual(['CREATE']);
      await goOnline(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(disk(h)).toEqual(['c.conflict-device-1.md=mine\n', 'c.md=theirs\n']);
      expect(docs.live()).toEqual(['c.conflict-device-1.md=mine\n', 'c.md=theirs\n']);
      expect(server.applied).toEqual(['create c.conflict-device-1.md']);
      expect(h.engine.getFileIdForPath('c.md')).toBe('s9');
      expect(h.engine.getFileIdForPath('c.conflict-device-1.md')).not.toBeNull();

      // A save goes to the note it belongs to, and nothing is uploaded again.
      h.vault.files.set('c.conflict-device-1.md', encode('mine\nmore\n'));
      const saved = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'c.conflict-device-1.md',
        source: 'obsidian',
      });
      await docs.drive();
      await saved;
      await docs.drive();
      expect(docs.live()).toEqual(['c.conflict-device-1.md=mine\nmore\n', 'c.md=theirs\n']);
      expect(h.socket().created()).toEqual(['c.md']);
      await h.engine.stop();
    });
  },
);
