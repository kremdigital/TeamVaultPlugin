/**
 * Renames made on this device, and what the server sends back for them.
 *
 * The server broadcasts every operation to the whole project room, its
 * sender included, right before the ack. Since 0.3.8 a rename made offline
 * moves the note's records at once, so when the queue drained a chain of
 * renames (`a → b → c`), the broadcast of the first step moved the note on
 * disk back to the intermediate name: another note there was parked aside as
 * a conflict copy and uploaded as a duplicate, and with Obsidian's echo of
 * that move the server renamed the note `b ↔ c` forever.
 *
 * Now a chain of renames of one note is sent as one, broadcasts of this
 * device's own operations are recognised (by `clientId`, or, from a server
 * that does not send it, by the rename still queued or in flight), a
 * teammate's rename of a note whose own rename is still on its way is left
 * to that rename, and a rename is applied under the name the server stored.
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

/** Synced notes on disk, in `state.json` and on the server; connected. */
async function connectedNotes(
  format: BroadcastFormat,
  notes: ReadonlyArray<readonly [path: string, fileId: string, text: string]>,
): Promise<{ h: Harness; server: FakeServer }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  for (const [path, fileId, text] of notes) {
    const hash = await remember(h, path, fileId, text);
    server.add({ id: fileId, path, fileType: 'TEXT', contentHash: hash, size: text.length });
  }
  await connect(h, {
    yjsDocs: notes.map(([, fileId, text]) => snapshotOf(serverDocWith(text), fileId)),
  });
  await flushAsync(20);
  return { h, server };
}

/** The socket drops; the user works offline. */
async function goOffline(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

/** The socket comes back; the join is answered and the queue drains. */
async function reconnect(h: Harness, server: FakeServer): Promise<void> {
  h.socket().connect();
  await flushAsync();
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
  await server.pump();
  await h.settle();
}

/**
 * The user renames a file while connected: the rename goes out and the
 * server answers it.
 */
async function renameOnline(
  h: Harness,
  server: FakeServer,
  from: string,
  to: string,
): Promise<void> {
  const handled = userRename(h, from, to);
  await server.pump();
  await handled;
}

/** Every disk rename the engine makes from now on. */
function recordDiskRenames(h: Harness): string[] {
  const moves: string[] = [];
  const rename0 = h.vault.rename.bind(h.vault);
  h.vault.rename = (from, to): Promise<void> => {
    moves.push(`${from} -> ${to}`);
    return rename0(from, to);
  };
  return moves;
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — renames made offline, %s server broadcasts',
  (format) => {
    it('sends a chain of renames of one note as one, and leaves the disk alone', async () => {
      const { h, server } = await connectedNotes(format, [['a.md', 'f1', 'A\n']]);
      await goOffline(h);
      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'b.md', 'c.md');
      const moves = recordDiskRenames(h);

      await reconnect(h, server);

      expect(server.applied).toEqual(['f1 a.md -> c.md']);
      expect(moves).toEqual([]);
      expect([...h.vault.files.keys()]).toEqual(['c.md']);
      expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      expect(h.socket().created()).toEqual([]);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });

    it('keeps another note given the intermediate name where it is', async () => {
      const { h, server } = await connectedNotes(format, [
        ['a.md', 'f1', 'A\n'],
        ['d.md', 'f2', 'D\n'],
      ]);
      await goOffline(h);
      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'b.md', 'c.md');
      await userRename(h, 'd.md', 'b.md');
      const moves = recordDiskRenames(h);

      await reconnect(h, server);

      expect(server.pathOf('f1')).toBe('c.md');
      expect(server.pathOf('f2')).toBe('b.md');
      expect(moves).toEqual([]);
      expect([...h.vault.files.keys()].sort()).toEqual(['b.md', 'c.md']);
      expect(h.vault.text('b.md')).toBe('D\n');
      expect(h.vault.text('c.md')).toBe('A\n');
      expect(h.engine.getFileIdForPath('b.md')).toBe('f2');
      expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
      expect(h.socket().created()).toEqual([]);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });

    it('sends nothing for a note renamed and renamed back', async () => {
      const { h, server } = await connectedNotes(format, [['a.md', 'f1', 'A\n']]);
      await goOffline(h);
      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'b.md', 'a.md');

      await reconnect(h, server);

      expect(server.applied).toEqual([]);
      expect(h.socket().emits.map((e) => e.event)).not.toContain('file:rename');
      expect([...h.vault.files.keys()]).toEqual(['a.md']);
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      await h.engine.stop();
    });

    it('sends step by step a chain another rename depends on, without moving the disk', async () => {
      const { h, server } = await connectedNotes(format, [
        ['a.md', 'f1', 'A\n'],
        ['c.md', 'f2', 'C\n'],
      ]);
      await goOffline(h);
      // `c.md` becomes free only by the rename in between: sent as one,
      // `a → c` would find it taken.
      await userRename(h, 'a.md', 'b.md');
      await userRename(h, 'c.md', 'a.md');
      await userRename(h, 'b.md', 'c.md');
      const moves = recordDiskRenames(h);

      await reconnect(h, server);

      expect(server.applied).toEqual(['f1 a.md -> b.md', 'f2 c.md -> a.md', 'f1 b.md -> c.md']);
      expect(moves).toEqual([]);
      expect(h.vault.text('a.md')).toBe('C\n');
      expect(h.vault.text('c.md')).toBe('A\n');
      expect(h.engine.getFileIdForPath('a.md')).toBe('f2');
      expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
      expect(h.socket().created()).toEqual([]);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });

    it('leaves a teammate’s rename to the rename still on its way', async () => {
      const { h, server } = await connectedNotes(format, [['a.md', 'f1', 'A\n']]);
      // The user's rename goes out; before it reaches the server, a teammate
      // renames the same note, and that broadcast arrives first.
      const mine = userRename(h, 'a.md', 'b.md');
      await flushAsync();
      server.teammateRename('f1', 'c.md');
      await flushAsync(20);
      await server.pump();
      await mine;
      await h.settle();

      expect(server.pathOf('f1')).toBe('b.md');
      expect([...h.vault.files.keys()]).toEqual(['b.md']);
      expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });

    it('still follows a teammate’s rename that comes after its own', async () => {
      const { h, server } = await connectedNotes(format, [['a.md', 'f1', 'A\n']]);
      await renameOnline(h, server, 'a.md', 'b.md');

      await h.settle();

      server.teammateRename('f1', 'c.md');
      await server.pump();
      await h.settle();

      expect(server.applied).toEqual(['f1 a.md -> b.md', 'f1 b.md -> c.md']);
      expect([...h.vault.files.keys()]).toEqual(['c.md']);
      expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
      await h.engine.stop();
    });
  },
);

describe('SyncEngine — what the server stored', () => {
  it('moves the note to the conflict name the server stored its rename under', async () => {
    const { h, server } = await connectedNotes('current', [['a.md', 'f1', 'A\n']]);
    // A teammate's note at `b.md` the server has and this device has not seen.
    server.add({ id: 'f9', path: 'b.md', fileType: 'TEXT', contentHash: 'x', size: 1 });

    await renameOnline(h, server, 'a.md', 'b.md');

    await h.settle();

    expect(server.pathOf('f1')).toBe('b.conflict-device-1.md');
    expect([...h.vault.files.keys()]).toEqual(['b.conflict-device-1.md']);
    expect(h.engine.getFileIdForPath('b.conflict-device-1.md')).toBe('f1');
    expect(h.socket().emits.filter((e) => e.event === 'file:rename')).toHaveLength(1);
    await h.engine.stop();
  });

  it('applies a teammate’s rename under the name the server stored, not the one asked for', async () => {
    const { h } = await connectedNotes('legacy', [['a.md', 'f1', 'A\n']]);
    // What a server without `clientId` sent for a rename that collided.
    h.socket().fire('file:renamed', {
      fileId: 'f1',
      newPath: 'b.md',
      outcome: {
        kind: 'conflict_create_renamed',
        fileId: 'f1',
        originalPath: 'b.md',
        finalPath: 'b.conflict-device-2.md',
      },
      log: eventLog,
    });
    await flushAsync(40);
    await h.settle();

    expect([...h.vault.files.keys()]).toEqual(['b.conflict-device-2.md']);
    expect(h.engine.getFileIdForPath('b.conflict-device-2.md')).toBe('f1');
    await h.engine.stop();
  });

  it.each(['current', 'legacy'] as const)(
    'ignores a late %s broadcast of its own rename to a name the note has left',
    async (format) => {
      const { h, server } = await connectedNotes(format, [['a.md', 'f1', 'A\n']]);
      await renameOnline(h, server, 'a.md', 'b.md');
      await renameOnline(h, server, 'b.md', 'c.md');
      await h.settle();

      // The broadcast of `a → b`, delivered once both acks were in.
      h.socket().fire('file:renamed', {
        fileId: 'f1',
        newPath: 'b.md',
        outcome: { kind: 'renamed', fileId: 'f1', from: 'a.md', to: 'b.md' },
        log: eventLog,
        ...(format === 'current' ? { clientId: 'device-1' } : {}),
      });
      await flushAsync(40);
      await h.settle();

      expect([...h.vault.files.keys()]).toEqual(['c.md']);
      expect(h.engine.getFileIdForPath('c.md')).toBe('f1');
      expect(server.pathOf('f1')).toBe('c.md');
      await h.engine.stop();
    },
  );
});

describe('SyncEngine — a teammate’s rename waiting behind a save', () => {
  it('is dropped once the note has been renamed here meanwhile', async () => {
    const { h, server } = await connectedNotes('current', [['a.md', 'f1', 'A\n']]);
    // A save whose fold waits for the note's state holds the name.
    h.vault.files.set('a.md', encode('A\ntyped\n'));
    const save = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'a.md',
      source: 'obsidian',
    });
    await flushAsync(10);
    expect(h.socket().fetches).toHaveLength(1);

    // A teammate renames the note; the rename waits for the save.
    server.teammateRename('f1', 'c.md');
    await flushAsync(10);
    // The user renames it too, and that rename reaches the server after.
    await h.vault.rename('a.md', 'b.md');
    await server.pump();

    const d1 = serverDocWith('A\n');
    for (const f of h.socket().fetches.splice(0)) {
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(d1)),
        stateVector: Array.from(Y.encodeStateVector(d1)),
      });
    }
    await save;
    await h.settle();

    expect(server.pathOf('f1')).toBe('b.md');
    expect([...h.vault.files.keys()]).toEqual(['b.md']);
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    expect(h.eventErrors).toEqual([]);
    await h.engine.stop();
  });
});
