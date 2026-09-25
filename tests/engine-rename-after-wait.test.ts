/**
 * Renames from the server that wait for the note's names, and what they find
 * once they get them.
 *
 * A rename from the server looked the note's name up before it waited for
 * the locks of the old and the new name (a save being folded in holds the
 * name, up to 15 s while the note's state is fetched). Another rename could
 * move the note meanwhile. Taken as it was looked up:
 *
 *   - a rename back to where the note had been (`a → b`, then `b → a`) was
 *     dropped as already done, and the note stayed at `b` here while the
 *     server had it at `a`;
 *   - a second rename to the name the note had just got — this device's own
 *     rename that the server stored under a conflict name is followed both
 *     from its broadcast and from its ack — found the note's copy at the
 *     destination, took it for another file with the same content, and
 *     deleted it: the note was gone from the disk.
 *
 * And a rename this device made stayed counted as on its way while the note
 * followed it to the conflict name the server stored it under, or while the
 * drain moved its records: a teammate's rename of the note broadcast in that
 * time, which the server applied after this one, was dropped.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeServer,
  buildHarness,
  connect,
  encode,
  eventLog,
  flushAsync,
  serverDocWith,
  snapshotOf,
  userRename,
  type BroadcastFormat,
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

/** One synced note, on disk, in `state.json` and on the server; connected. */
async function oneNote(
  format: BroadcastFormat = 'current',
): Promise<{ h: Harness; server: FakeServer; d1: Y.Doc }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  const hash = await remember(h, 'a.md', 'f1', 'A\n');
  server.add({ id: 'f1', path: 'a.md', fileType: 'TEXT', contentHash: hash, size: 2 });
  const d1 = serverDocWith('A\n');
  await connect(h, { yjsDocs: [snapshotOf(d1, 'f1')] });
  await flushAsync(20);
  return { h, server, d1 };
}

/**
 * A save of `a.md` whose fold waits for the note's state from the server:
 * it holds the name until {@link answerFetches}. Wrapped: an async function
 * returning the save itself would make the caller's `await` wait for it.
 */
async function saveHoldingTheName(h: Harness): Promise<{ save: Promise<void> }> {
  h.vault.files.set('a.md', encode('A\n'));
  const save = h.engine.handleVaultEvent({
    bindingId: 'b1',
    type: 'modify',
    path: 'a.md',
    source: 'obsidian',
  });
  await flushAsync(10);
  expect(h.socket().fetches).toHaveLength(1);
  return { save };
}

function answerFetches(h: Harness, doc: Y.Doc): void {
  for (const f of h.socket().fetches.splice(0)) {
    f.answer({
      ok: true,
      sync1: Array.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Array.from(Y.encodeStateVector(doc)),
    });
  }
}

/** A teammate's rename broadcast, as the server sends it. */
function renamedByTeammate(h: Harness, newPath: string): void {
  h.socket().fire('file:renamed', {
    fileId: 'f1',
    newPath,
    outcome: { kind: 'renamed', fileId: 'f1', to: newPath },
    log: eventLog,
    clientId: 'device-2',
  });
}

describe('SyncEngine — a rename from the server that waited for the note’s names', () => {
  it('follows a teammate’s rename back to the old name', async () => {
    const { h, d1 } = await oneNote();
    const { save } = await saveHoldingTheName(h);

    renamedByTeammate(h, 'b.md');
    await flushAsync(5);
    renamedByTeammate(h, 'a.md');
    await flushAsync(5);
    answerFetches(h, d1);
    await save;
    await h.settle();
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['a.md']);
    expect(h.vault.text('a.md')).toBe('A\n');
    expect(h.engine.getFileIdForPath('a.md')).toBe('f1');
    expect(h.log.listFileMeta('b1').map((m) => m.relativePath)).toEqual(['a.md']);
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });

  it('keeps the note when the same rename comes twice', async () => {
    const { h, d1 } = await oneNote();
    const { save } = await saveHoldingTheName(h);

    renamedByTeammate(h, 'b.md');
    await flushAsync(5);
    renamedByTeammate(h, 'b.md');
    await flushAsync(5);
    answerFetches(h, d1);
    await save;
    await h.settle();
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });
});

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a teammate’s rename right after this device’s own, %s broadcasts',
  (format) => {
    it('is followed while the note moves to the conflict name its rename was stored under', async () => {
      const { h, server } = await oneNote(format);
      // A teammate's note at `b.md` this device has not heard of yet.
      server.add({ id: 'f9', path: 'b.md', fileType: 'TEXT', contentHash: 'x', size: 1 });
      // The note's move to the conflict name waits on the disk: the first
      // rename is the user's own, in Obsidian.
      const toConflict = h.vault.gate('rename', 1);

      const renaming = h.vault.rename('a.md', 'b.md');
      await server.pump();
      await toConflict.reached;
      expect(server.pathOf('f1')).toBe('b.conflict-device-1.md');
      // The teammate renames the note; the server applies it after this
      // device's rename.
      server.teammateRename('f1', 'd.md');
      await flushAsync(20);
      toConflict.release();
      await renaming;
      await server.pump();
      await h.settle();
      await flushAsync(20);

      expect(server.pathOf('f1')).toBe('d.md');
      expect([...h.vault.files.keys()]).toEqual(['d.md']);
      expect(h.vault.text('d.md')).toBe('A\n');
      expect(h.engine.getFileIdForPath('d.md')).toBe('f1');
      expect(h.socket().emits.filter((e) => e.event === 'file:rename')).toHaveLength(1);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });

    it('is followed while the drain moves the records of a rename made offline', async () => {
      const { h, server } = await oneNote(format);
      server.add({ id: 'f9', path: 'b.md', fileType: 'TEXT', contentHash: 'x', size: 1 });
      h.socket().disconnect();
      await flushAsync();
      await userRename(h, 'a.md', 'b.md');
      const toConflict = h.vault.gate('rename');

      h.socket().connect();
      await flushAsync();
      h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
      await flushAsync(20);
      server.serveNext();
      await toConflict.reached;
      expect(server.pathOf('f1')).toBe('b.conflict-device-1.md');
      server.teammateRename('f1', 'd.md');
      await flushAsync(20);
      toConflict.release();
      await server.pump();
      await h.settle();
      await flushAsync(20);

      expect(server.pathOf('f1')).toBe('d.md');
      expect([...h.vault.files.keys()]).toEqual(['d.md']);
      expect(h.engine.getFileIdForPath('d.md')).toBe('f1');
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });
  },
);
