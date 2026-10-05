/**
 * A folder a teammate deleted or renamed goes from this disk too; a folder a
 * teammate only emptied stays (`sync-protocol.md`, «Папки»).
 *
 * Folders are not synced as such: the server knows files only, and this
 * client makes a file's folders when it writes the file. Before, a folder a
 * teammate deleted, renamed or moved stayed behind, empty, on every other
 * device — after each reorganization of a shared vault, a skeleton of empty
 * folders. A receiver cannot tell by itself a folder deleted from a folder
 * whose last file was deleted or moved: removing the second, it took folders
 * such as "Inbox" or the attachments folder from the whole team, and with
 * the folder for new notes gone, Obsidian puts new notes at the vault's root.
 *
 * So the author says so. Its delete, rename or move of a file carries
 * `folder` — the topmost folder that vanished from its disk with the file —
 * and a receiver removes that folder and the folders under it only if
 * nothing is left in them, on disk or in its index: never a file, not even
 * one it does not sync, nor a teammate's file on its way to the disk. Obsidian
 * reports a folder removed so as it reports one the user deleted, and nothing
 * goes to the server for it.
 */
import { sha256Hex } from '@/sync/hash';
import { Logger, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeServer,
  FakeStorage,
  NEVER_FLUSHED,
  ServerDocs,
  buildHarness,
  bytes,
  deferred,
  encode,
  flushAsync,
  joinToAnswer,
  joinsOf,
  json,
  logOn,
  nextJoin,
  restartFromDisk,
  userRename,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

/** Engines whose log is on a {@link FakeStorage}: stopped after the test, their logs closed. */
const onDisk: Harness[] = [];

afterEach(async () => {
  for (const h of onDisk.splice(0)) {
    await h.engine.stop().catch(() => undefined);
    await h.log.close().catch(() => undefined);
  }
});

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs | null;
  entries: LogEntry[];
}

/**
 * `paths` synced — notes (`.md`) with their docs when `notes` is set, the rest
 * attachments — and the engine connected, its catch-up and first upload done.
 * Without `notes`, no doc of the server's reaches the engine: a note a
 * teammate creates is recorded here and never written (it waits for its doc).
 * `storage`: `state.json` is written there (see {@link crashed}), only when
 * the engine waits for it — the debounced write never comes.
 */
async function seeded(
  paths: readonly string[],
  opts: { notes?: boolean; localFolder?: string; storage?: FakeStorage } = {},
): Promise<Bench> {
  const entries: LogEntry[] = [];
  const logger = new Logger('debug', {
    write: (e) => {
      entries.push(e);
    },
  });
  const h = buildHarness({
    logger,
    ...(opts.localFolder !== undefined ? { localFolder: opts.localFolder } : {}),
    ...(opts.storage !== undefined ? { log: await logOn(opts.storage, NEVER_FLUSHED) } : {}),
  });
  if (opts.storage !== undefined) onDisk.push(h);
  const server = new FakeServer(h);
  const docs = opts.notes === true ? new ServerDocs(server, h) : null;
  for (const [i, path] of paths.entries()) {
    const id = `f${i + 1}`;
    const text = `${path}\n`;
    const content = encode(text);
    const hash = await sha256Hex(content);
    const note = docs !== null && path.endsWith('.md');
    h.vault.files.set(path, content);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: path,
      serverFileId: id,
      contentHash: hash,
      size: content.byteLength,
      fileType: note ? 'TEXT' : 'BINARY',
      lastSyncedAt: 1,
      ...(note ? { foldedHash: hash } : {}),
    });
    if (note) await docs.add(id, path, text);
    else server.add({ id, path, fileType: 'BINARY', contentHash: hash, size: content.byteLength });
  }
  const lookups = tombstoneLookups(h);
  await h.engine.start();
  (await joinToAnswer(h)).ack(
    server.joinAnswer('whole journal', { yjsDocs: docs?.snapshots() ?? [] }),
  );
  if (docs !== null) await docs.drive();
  const b = { h, server, docs, entries };
  await tailDone(b, lookups);
  return b;
}

/** The listing with the server's deleted files, which the first upload of each connect reads. */
const TOMBSTONES = 'GET /api/projects/p1/files?includeDeleted=true';

/** How many times the engine has asked for {@link TOMBSTONES}. */
function tombstoneLookups(h: Harness): number {
  return h.requests.filter((r) => `${r.method} ${r.path}` === TOMBSTONES).length;
}

/**
 * Until the tail of the connect made after `before` lookups of
 * {@link TOMBSTONES} — the queue, the first upload, the folders of the
 * catch-up — is under way, the server answering on the way: the tombstones
 * asked for again, and the engine quiet.
 */
async function tailDone(b: Bench, before: number): Promise<void> {
  for (let round = 0; round < 200 && tombstoneLookups(b.h) <= before; round++) {
    b.server.serveNext();
    await flushAsync(5);
  }
  if (tombstoneLookups(b.h) <= before)
    throw new Error('the first upload of the connect never came');
  await b.server.pump();
  await b.h.settle();
}

/** Wait, as long as it takes the engine and within a bound, until `done()`. */
async function until(what: string, done: () => boolean): Promise<void> {
  for (let round = 0; round < 200; round++) {
    if (done()) return;
    await flushAsync(5);
  }
  throw new Error(`still waiting for ${what}`);
}

/** Whether the engine logged `message` since entry `from`. */
function said(b: Bench, message: string, from = 0): boolean {
  return b.entries.slice(from).some((e) => e.message === message);
}

const KEPT_HOLDS = 'a folder a teammate removed holds files here; kept';
const KEPT_NOT_EMPTY = 'a folder a teammate removed is not empty here; kept';
const GONE_ALREADY = 'a folder a teammate removed is gone here already';
const REMOVED = 'removed a folder a teammate deleted or renamed';
const LEFT_FOR_NEXT =
  'a folder a teammate removed holds a copy not removed yet; left for the next connect';

function fileEvent(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'delete', path, source: 'obsidian' };
}

function folderEvent(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'delete', path, source: 'obsidian', isFolder: true };
}

/** Dispatch `events` as `main.ts` does — one after another, none awaited. */
function dispatch(h: Harness, events: readonly VaultEvent[]): Array<Promise<void>> {
  return events.map((event) => h.engine.handleVaultEvent(event));
}

/** Let the handlers of `runs` finish, the server answering on the way. */
async function finish(b: Bench, runs: ReadonlyArray<Promise<void>>): Promise<void> {
  let done = false;
  const all = Promise.allSettled(runs).then((results) => {
    done = true;
    return results;
  });
  for (let round = 0; round < 40 && !done; round++) {
    await b.server.pump(500);
    await flushAsync(5);
  }
  if (!done) throw new Error('vault event handlers still waiting');
  expect((await all).filter((r) => r.status === 'rejected')).toEqual([]);
  await b.server.pump(500);
  await b.h.settle();
}

/** The `file:*` requests sent from emit `from` on: `event path [-> newPath] [folder]`. */
function sent(b: Bench, from = 0): string[] {
  return b.h
    .socket()
    .emits.slice(from)
    .filter((e) => e.event.startsWith('file:'))
    .map((e) => {
      const p = e.payload as { filePath: string; newPath?: string; folder?: string };
      const to = p.newPath !== undefined ? ` -> ${p.newPath}` : '';
      return `${e.event} ${p.filePath}${to}${'folder' in p ? ` [${String(p.folder)}]` : ''}`;
    });
}

/** The server's journal rows from `from` on: `OP path [-> newPath] [folder]`. */
function journal(server: FakeServer, from = 0): string[] {
  return server.journal.slice(from).map((row) => {
    const folder = (row.payload as { folder?: string }).folder;
    const to = row.newPath !== null ? ` -> ${row.newPath}` : '';
    return `${row.opType} ${row.filePath}${to}${folder !== undefined ? ` [${folder}]` : ''}`;
  });
}

function live(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => f.path)
    .sort();
}

/**
 * A teammate uploads an attachment to `path`, served for download as
 * `content`. The engine's first look at the disk for it waits until the
 * download is served: the server gives the file its id only now.
 */
async function uploaded(b: Bench, path: string, content: ArrayBuffer): Promise<string> {
  const look = b.h.vault.gate('exists');
  const id = await b.server.teammateUpload(path, content);
  b.h.routes.set(`GET /api/projects/p1/files/${id}`, () => bytes(content));
  look.release();
  return id;
}

/**
 * Obsidian started again after `b`'s engine stopped: a new engine on the same
 * disk and `state.json`, connected, its catch-up, queue and first upload done.
 */
async function restarted(b: Bench): Promise<Bench> {
  const logger = new Logger('debug', {
    write: (e) => {
      b.entries.push(e);
    },
  });
  const h = buildHarness({ predecessor: b.h, logger });
  b.server.attach(h);
  // The downloads the server serves (see `uploaded`).
  for (const [route, respond] of b.h.routes) if (!h.routes.has(route)) h.routes.set(route, respond);
  await h.engine.start();
  (await joinToAnswer(h)).ack(b.server.joinAnswer('whole journal'));
  const next = { ...b, h };
  await tailDone(next, 0);
  return next;
}

/**
 * `event` handled, and the engine stopped — Pause sync, the plugin disabled,
 * Obsidian closed — at the handler's look at the disk after `looks` others,
 * if it gets that far.
 */
async function stopAtLook(b: Bench, event: VaultEvent, looks: number): Promise<void> {
  const look = b.h.vault.gate('exists', looks);
  const handled = b.h.engine.handleVaultEvent(event).then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([look.reached, handled]);
  const stopped = b.h.engine.stop();
  look.release();
  await stopped;
  await handled;
}

/** A folder `dir` removed here as a teammate's, and a teammate's `dir/c.png` written into it since. */
async function prunedThenWritten(b: Bench): Promise<string> {
  const mark = b.entries.length;
  b.server.teammateDelete('f1', { folder: 'dir' });
  await until('the folder removed', () => said(b, REMOVED, mark));
  // Written right after, before Obsidian looks: the folder is back.
  const id = await uploaded(b, 'dir/c.png', encode('pic'));
  await until('the file written', () => b.h.vault.files.has('dir/c.png'));
  await b.h.settle();
  return id;
}

async function reconnect(b: Bench, rows?: number): Promise<void> {
  const before = joinsOf(b.h);
  const lookups = tombstoneLookups(b.h);
  b.h.socket().connect();
  (await nextJoin(b.h, before)).ack(
    rows === undefined
      ? b.server.joinAnswer('whole journal')
      : b.server.joinAnswer('cut short', { rows }),
  );
  await tailDone(b, lookups);
}

// -- The author ---------------------------------------------------------------------

describe('SyncEngine — a folder deleted or renamed here: its operations say which folder went', () => {
  it('a folder deleted in Obsidian: each file’s delete carries the folder', async () => {
    const b = await seeded(['dir/a.png', 'dir/n.md', 'dir/sub/b.png', 'keep.md'], { notes: true });
    const emits = b.h.socket().emits.length;
    const rows = b.server.journal.length;

    b.h.vault.removeFolder('dir');
    await finish(
      b,
      dispatch(b.h, [
        fileEvent('dir/a.png'),
        fileEvent('dir/n.md'),
        folderEvent('dir/sub'),
        fileEvent('dir/sub/b.png'),
        folderEvent('dir'),
      ]),
    );

    expect(sent(b, emits).sort()).toEqual([
      'file:delete dir/a.png [dir]',
      'file:delete dir/n.md [dir]',
      'file:delete dir/sub/b.png [dir]',
    ]);
    // The server keeps it, and its teammates get it.
    expect(journal(b.server, rows).sort()).toEqual([
      'DELETE dir/a.png [dir]',
      'DELETE dir/n.md [dir]',
      'DELETE dir/sub/b.png [dir]',
    ]);
    expect(live(b.server)).toEqual(['keep.md']);
    await b.h.engine.stop();
  });

  it('a subfolder deleted: that folder, not the one it was in', async () => {
    const b = await seeded(['dir/sub/a.png', 'dir/b.png']);
    const emits = b.h.socket().emits.length;

    b.h.vault.removeFolder('dir/sub');
    await finish(b, dispatch(b.h, [fileEvent('dir/sub/a.png'), folderEvent('dir/sub')]));

    expect(sent(b, emits)).toEqual(['file:delete dir/sub/a.png [dir/sub]']);
    await b.h.engine.stop();
  });

  it('the last file of a folder deleted: no folder — it stays here, and at every teammate’s', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const emits = b.h.socket().emits.length;

    b.h.vault.files.delete('dir/a.png');
    await finish(b, dispatch(b.h, [fileEvent('dir/a.png')]));

    expect(sent(b, emits)).toEqual(['file:delete dir/a.png']);
    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('a folder renamed in Obsidian: each file’s rename carries the old folder', async () => {
    const b = await seeded(['old/a.png', 'old/sub/b.md', 'keep.md'], { notes: true });
    const emits = b.h.socket().emits.length;
    const rows = b.server.journal.length;

    b.h.vault.renameFolder('old', 'new');
    await b.h.settle();
    await b.docs?.drive();

    expect(sent(b, emits).sort()).toEqual([
      'file:rename old/a.png -> new/a.png [old]',
      'file:rename old/sub/b.md -> new/sub/b.md [old]',
    ]);
    expect(journal(b.server, rows).sort()).toEqual([
      'RENAME old/a.png -> new/a.png [old]',
      'RENAME old/sub/b.md -> new/sub/b.md [old]',
    ]);
    expect(live(b.server)).toEqual(['keep.md', 'new/a.png', 'new/sub/b.md']);
    await b.h.engine.stop();
  });

  it('a folder moved into another: the folder it left, not the one it went to', async () => {
    const b = await seeded(['A/x.png', 'B/y.png']);
    const emits = b.h.socket().emits.length;

    b.h.vault.renameFolder('A', 'B/A');
    await b.h.settle();

    expect(sent(b, emits)).toEqual(['file:rename A/x.png -> B/A/x.png [A]']);
    await b.h.engine.stop();
  });

  it('a file moved out of a folder, the last one included: no folder', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png']);
    const emits = b.h.socket().emits.length;

    await userRename(b.h, 'dir/a.png', 'other/a.png');
    await userRename(b.h, 'dir/b.png', 'other/b.png');

    expect(sent(b, emits)).toEqual([
      'file:rename dir/a.png -> other/a.png',
      'file:rename dir/b.png -> other/b.png',
    ]);
    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('offline: the queue keeps the folder, and sends it when the connection is back', async () => {
    const b = await seeded(['dir/a.png', 'old/b.png', 'keep.png']);
    b.h.socket().disconnect();

    b.h.vault.removeFolder('dir');
    await Promise.all(dispatch(b.h, [fileEvent('dir/a.png'), folderEvent('dir')]));
    b.h.vault.renameFolder('old', 'new');
    await b.h.settle();
    expect(
      b.h.log
        .dequeueOperations('b1')
        .map((op) => `${op.opType} ${op.filePath} ${String(op.payload['folder'])}`),
    ).toEqual(['DELETE dir/a.png dir', 'RENAME old/b.png old']);
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits)).toEqual([
      'file:delete dir/a.png [dir]',
      'file:rename old/b.png -> new/b.png [old]',
    ]);
    expect(live(b.server)).toEqual(['keep.png', 'new/b.png']);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    await b.h.engine.stop();
  });

  it('a folder’s deletes cut off by a lost connection go out again with the folder', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png']);
    b.h.vault.removeFolder('dir');
    // Only the folder's own event: its files' were missed.
    const run = b.h.engine.handleVaultEvent(folderEvent('dir'));
    await until('the first delete sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    // Its packet never reaches the server, and the connection drops.
    b.server.delay(b.h.socket().pending('file:delete'));
    b.h.socket().disconnect();
    await run;
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits).sort()).toEqual([
      'file:delete dir/a.png [dir]',
      'file:delete dir/b.png [dir]',
    ]);
    expect(live(b.server)).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('a queue written by 0.4.0, without folders, goes out as it is', async () => {
    const b = await seeded(['a/x.png', 'b/y.png', 'keep.png']);
    b.h.socket().disconnect();
    b.h.vault.files.delete('a/x.png');
    b.h.vault.move('b/y.png', 'b/z.png');
    // What 0.4.0 wrote to `state.json` for a delete and a rename.
    b.h.log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'a/x.png',
      payload: { fileId: 'f1', lastSynced: [] },
    });
    b.h.log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'b/y.png',
      newPath: 'b/z.png',
      payload: { fileId: 'f2' },
    });
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits)).toEqual(['file:delete a/x.png', 'file:rename b/y.png -> b/z.png']);
    expect(live(b.server)).toEqual(['b/z.png', 'keep.png']);
    await b.h.engine.stop();
  });

  it('renames made offline one after another go as one, with the folder the note left', async () => {
    const b = await seeded(['A/x.png', 'keep.png']);
    b.h.socket().disconnect();
    // Renamed in its folder (the folder stays), then the folder renamed.
    await userRename(b.h, 'A/x.png', 'A/y.png');
    b.h.vault.renameFolder('A', 'Z');
    await b.h.settle();
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits)).toEqual(['file:rename A/x.png -> Z/y.png [A]']);
    expect(journal(b.server).at(-1)).toBe('RENAME A/x.png -> Z/y.png [A]');
    await b.h.engine.stop();
  });

  it('renames go out in the order they came, however long the look at the disk takes', async () => {
    const b = await seeded(['a/x.png', 'a/keep.png', 'b/keep.png']);
    const emits = b.h.socket().emits.length;

    // The first rename's look at its folder takes long; the second's would not.
    const slow = b.h.vault.gate('exists');
    const first = b.h.vault.rename('a/x.png', 'b/x.png');
    await slow.reached;
    const second = b.h.vault.rename('b/x.png', 'b/y.png');
    await flushAsync(20);
    slow.release();
    await Promise.all([first, second]);
    await b.h.settle();
    await b.server.pump();

    expect(sent(b, emits)).toEqual([
      'file:rename a/x.png -> b/x.png',
      'file:rename b/x.png -> b/y.png',
    ]);
    expect(b.server.pathOf('f1')).toBe('b/y.png');
    await b.h.engine.stop();
  });

  it('a rename within a folder renamed before the rename is looked at: that folder goes with the next one', async () => {
    const b = await seeded(['A/x.png', 'keep.png']);
    const emits = b.h.socket().emits.length;

    const slow = b.h.vault.gate('exists');
    const first = b.h.vault.rename('A/x.png', 'A/y.png');
    await slow.reached;
    // The folder renamed right after: the first rename's look finds it gone,
    // though the note did not leave it.
    b.h.vault.renameFolder('A', 'Z');
    await flushAsync(20);
    slow.release();
    await first;
    await b.h.settle();
    await b.server.pump();

    expect(sent(b, emits)).toEqual([
      'file:rename A/x.png -> A/y.png',
      'file:rename A/y.png -> Z/y.png [A]',
    ]);
    expect(b.server.pathOf('f1')).toBe('Z/y.png');
    await b.h.engine.stop();
  });

  it('a note renamed onto the name of one deleted while the folder checks wait: the delete is the deleted one’s', async () => {
    const b = await seeded(['n/plan.png', 'n/plan2.png', 'm/x.png', 'keep.png']);
    const emits = b.h.socket().emits.length;

    // A rename before them waits for its look at the disk: the checks of the
    // delete and the rename after it wait behind it.
    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/plan.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/plan.png'));
    await flushAsync(20);
    // Renamed onto the name meanwhile: recorded there at once.
    const renaming = b.h.vault.rename('n/plan2.png', 'n/plan.png');
    await flushAsync(20);
    expect(b.h.engine.getFileIdForPath('n/plan.png')).toBe('f2');
    slow.release();
    await finish(b, [before, deleting, renaming]);

    const deletes = b.h
      .socket()
      .emits.slice(emits)
      .filter((e) => e.event === 'file:delete')
      .map((e) => (e.payload as { fileId: string }).fileId);
    expect(deletes).toEqual(['f1']);
    expect(b.server.pathOf('f1')).toBeNull();
    expect(b.server.pathOf('f2')).not.toBeNull();
    // The renamed note keeps the name here, its record and its copy.
    expect(b.h.engine.getFileIdForPath('n/plan.png')).toBe('f2');
    expect(b.h.vault.files.has('n/plan.png')).toBe(true);
    await b.h.engine.stop();
  });

  it('a file saved under the name of one whose delete waits for the folder checks: a new file, after the delete', async () => {
    const b = await seeded(['n/plan.png', 'm/x.png', 'keep.png']);
    const emits = b.h.socket().emits.length;
    const rows = b.server.journal.length;

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/plan.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/plan.png'));
    await flushAsync(20);
    // A new file under the name, while the delete waits.
    b.h.vault.files.set('n/plan.png', encode('new'));
    const saving = b.h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'n/plan.png',
      source: 'obsidian',
    });
    await flushAsync(20);
    slow.release();
    await finish(b, [before, deleting, saving]);

    expect(sent(b, emits)).toEqual([
      'file:rename m/x.png -> m/y.png',
      'file:delete n/plan.png',
      'file:create n/plan.png',
    ]);
    // The server has the new file under the name — a create of a deleted
    // file's name brings its id back — with the new content.
    expect(journal(b.server, rows)).toEqual([
      'RENAME m/x.png -> m/y.png',
      'DELETE n/plan.png',
      'CREATE n/plan.png',
    ]);
    const now = b.h.engine.getFileIdForPath('n/plan.png') ?? '';
    expect(b.server.pathOf(now)).toBe('n/plan.png');
    expect(b.server.files.get(now)?.contentHash).toBe(await sha256Hex(encode('new')));
    await b.h.engine.stop();
  });
  it('a file never synced deleted, a note renamed onto its name meanwhile: the server listing that note there does not take the delete', async () => {
    const b = await seeded(['n/plan2.png', 'm/x.png', 'keep.png']);
    // Saved here and never synced: nothing is recorded under its name.
    b.h.vault.files.set('n/u.png', encode('u'));
    const emits = b.h.socket().emits.length;
    const LISTING = 'GET /api/projects/p1/files';
    const served = b.h.routes.get(LISTING);
    if (served === undefined) throw new Error('no route for the listing');
    const listed = deferred<void>();
    let asked = 0;
    b.h.routes.set(LISTING, () => {
      asked += 1;
      return listed.promise.then(served);
    });

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/u.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/u.png'));
    await flushAsync(20);
    const renaming = b.h.vault.rename('n/plan2.png', 'n/u.png');
    await flushAsync(20);
    slow.release();
    await until('the server asked for the file under the name', () => asked > 0);
    // The rename reaches the server before the listing answers.
    await until('the rename sent', () =>
      b.h
        .socket()
        .emits.some(
          (e) =>
            e.event === 'file:rename' && (e.payload as { newPath?: string }).newPath === 'n/u.png',
        ),
    );
    await b.server.pump();
    expect(b.server.pathOf('f1')).toBe('n/u.png');
    listed.resolve();
    await finish(b, [before, deleting, renaming]);

    expect(sent(b, emits).filter((e) => e.startsWith('file:delete'))).toEqual([]);
    expect(b.server.pathOf('f1')).toBe('n/u.png');
    expect(b.h.engine.getFileIdForPath('n/u.png')).toBe('f1');
    await b.h.engine.stop();
  });

  it('a new file deleted before its create is answered, the answer landing while the delete waits: the delete is that file’s', async () => {
    const b = await seeded(['m/x.png', 'keep.png']);
    b.h.vault.files.set('n/new.png', encode('new'));
    const creating = b.h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'n/new.png',
      source: 'obsidian',
    });
    await until('the create sent', () => b.h.socket().emits.some((e) => e.event === 'file:create'));
    const emits = b.h.socket().emits.length;

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/new.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/new.png'));
    await flushAsync(20);
    // The create's answer lands while the delete waits for its checks.
    await b.server.pump();
    await until('the new file recorded', () => b.h.engine.getFileIdForPath('n/new.png') !== null);
    const id = b.h.engine.getFileIdForPath('n/new.png') ?? '';
    slow.release();
    await finish(b, [creating, before, deleting]);

    const deletes = b.h
      .socket()
      .emits.slice(emits)
      .filter((e) => e.event === 'file:delete')
      .map((e) => (e.payload as { fileId: string }).fileId);
    expect(deletes).toEqual([id]);
    expect(b.server.pathOf(id)).toBeNull();
    expect(b.h.engine.getFileIdForPath('n/new.png')).toBeNull();
    await b.h.engine.stop();
  });

  it('a new file renamed before its create is answered, then deleted while the folder checks wait, the answer landing meanwhile: the delete is that file’s', async () => {
    const b = await seeded(['m/x.png', 'keep.png']);
    b.h.vault.files.set('n/a.png', encode('new'));
    const creating = b.h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'n/a.png',
      source: 'obsidian',
    });
    await until('the create sent', () => b.h.socket().emits.some((e) => e.event === 'file:create'));
    // Renamed before the create is answered (a template renaming the note it
    // has just made): the rename waits for the create.
    const renamingNew = b.h.vault.rename('n/a.png', 'n/b.png');
    await flushAsync(20);
    const emits = b.h.socket().emits.length;

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/b.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/b.png'));
    await flushAsync(20);
    // The create's answer lands while the delete waits for its checks: the
    // new file is recorded under its new name, its rename waiting for its
    // own check behind the delete's.
    await b.server.pump();
    await until('the new file recorded under its new name', () => {
      return b.h.engine.getFileIdForPath('n/b.png') !== null;
    });
    const id = b.h.engine.getFileIdForPath('n/b.png') ?? '';
    slow.release();
    await finish(b, [creating, renamingNew, before, deleting]);

    // The delete's check was ahead of the rename's: the delete went first.
    expect(sent(b, emits)).toEqual([
      'file:rename m/x.png -> m/y.png',
      'file:delete n/b.png',
      'file:rename n/a.png -> n/b.png',
    ]);
    const deletes = b.h
      .socket()
      .emits.slice(emits)
      .filter((e) => e.event === 'file:delete')
      .map((e) => (e.payload as { fileId: string }).fileId);
    expect(deletes).toEqual([id]);
    // Gone for the whole team, and from the records here.
    expect(b.server.pathOf(id)).toBeNull();
    expect(live(b.server)).toEqual(['keep.png', 'm/y.png']);
    expect(b.h.engine.getFileIdForPath('n/b.png')).toBeNull();
    expect(b.h.engine.getFileIdForPath('n/a.png')).toBeNull();
    await b.h.engine.stop();
  });

  it('a new file renamed before its create read it, created under the new name, then deleted while the folder checks wait: the delete is that file’s', async () => {
    const b = await seeded(['m/x.png', 'keep.png']);
    b.h.vault.files.set('n/a.png', encode('new'));
    // The create's look at the disk is held: the rename comes first.
    const look = b.h.vault.gate('exists');
    const creating = b.h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'n/a.png',
      source: 'obsidian',
    });
    await look.reached;
    const renamingNew = b.h.vault.rename('n/a.png', 'n/b.png');
    await flushAsync(20);
    look.release();
    // The create finds nothing under the old name: the file goes out as a
    // create of the new one.
    await until('the create of the new name sent', () =>
      b.h
        .socket()
        .emits.some(
          (e) =>
            e.event === 'file:create' && (e.payload as { filePath: string }).filePath === 'n/b.png',
        ),
    );
    const emits = b.h.socket().emits.length;

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/b.png');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/b.png'));
    await flushAsync(20);
    // The create's answer lands while the delete waits for its checks.
    await b.server.pump();
    await until('the new file recorded', () => b.h.engine.getFileIdForPath('n/b.png') !== null);
    const id = b.h.engine.getFileIdForPath('n/b.png') ?? '';
    slow.release();
    await finish(b, [creating, renamingNew, before, deleting]);

    const deletes = b.h
      .socket()
      .emits.slice(emits)
      .filter((e) => e.event === 'file:delete')
      .map((e) => (e.payload as { fileId: string }).fileId);
    expect(deletes).toEqual([id]);
    expect(b.server.pathOf(id)).toBeNull();
    expect(live(b.server)).toEqual(['keep.png', 'm/y.png']);
    expect(b.h.engine.getFileIdForPath('n/b.png')).toBeNull();
    await b.h.engine.stop();
  });

  it('offline: a note renamed onto the name of one deleted while the folder checks wait keeps its history, and the name', async () => {
    const b = await seeded(['n/plan.md', 'n/plan2.md', 'm/x.png', 'keep.png'], { notes: true });
    const docs = b.docs as ServerDocs;
    const save = async (text: string): Promise<void> => {
      b.h.vault.files.set('n/plan2.md', encode(text));
      const saving = b.h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'n/plan2.md',
        source: 'obsidian',
      });
      await docs.drive();
      await saving;
      await b.h.settle();
    };
    // The note renamed below is edited online — its history is here — and
    // then offline: that edit is in its history only.
    await save('n/plan2.md\nedited\n');
    expect(docs.text('f2')).toBe('n/plan2.md\nedited\n');
    b.h.socket().disconnect();
    await flushAsync();
    const edited = 'n/plan2.md\nedited\nedited offline\n';
    await save(edited);
    expect(b.h.doc.getText('b1', 'n/plan2.md')).toBe(edited);

    const slow = b.h.vault.gate('exists');
    const before = b.h.vault.rename('m/x.png', 'm/y.png');
    await slow.reached;
    b.h.vault.files.delete('n/plan.md');
    const deleting = b.h.engine.handleVaultEvent(fileEvent('n/plan.md'));
    await flushAsync(20);
    // Renamed onto the name meanwhile: recorded there at once, its history
    // carried there.
    const renaming = b.h.vault.rename('n/plan2.md', 'n/plan.md');
    await flushAsync(20);
    expect(b.h.engine.getFileIdForPath('n/plan.md')).toBe('f2');
    slow.release();
    await Promise.all([before, deleting, renaming]);
    await b.h.settle();

    // The delete ahead of the rename onto its name, as they came.
    expect(
      b.h.log
        .dequeueOperations('b1')
        .map(
          (op) => `${op.opType} ${op.filePath}${op.newPath !== null ? ` -> ${op.newPath}` : ''}`,
        ),
    ).toEqual(['RENAME m/x.png -> m/y.png', 'DELETE n/plan.md', 'RENAME n/plan2.md -> n/plan.md']);
    // The renamed note's history is under the name, its own, with the edit.
    expect(b.h.doc.ownerOf('b1', 'n/plan.md')).toBe('f2');
    expect(b.h.doc.getText('b1', 'n/plan.md')).toBe(edited);

    const before2 = joinsOf(b.h);
    const lookups = tombstoneLookups(b.h);
    b.h.socket().connect();
    (await nextJoin(b.h, before2)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }),
    );
    await docs.drive();
    await tailDone(b, lookups);
    await docs.drive();

    // The deleted note is gone for the whole team; the renamed one has the
    // name, not a conflict name, and the edit made offline.
    expect(b.server.pathOf('f1')).toBeNull();
    expect(b.server.pathOf('f2')).toBe('n/plan.md');
    expect(docs.text('f2')).toBe(edited);
    expect(b.h.engine.getFileIdForPath('n/plan.md')).toBe('f2');
    expect([...b.h.vault.files.keys()].filter((p) => p.startsWith('n/'))).toEqual(['n/plan.md']);
    expect(b.h.vault.text('n/plan.md')).toBe(edited);
    await b.h.engine.stop();
  });
});

// -- A teammate's device --------------------------------------------------------------

describe('SyncEngine — a folder a teammate deleted or renamed: removed here once empty', () => {
  it('a teammate deletes a folder: it goes here with its last file, its empty subfolders too', async () => {
    const b = await seeded(['dir/a.png', 'dir/sub/b.png', 'keep.png']);
    const emits = b.h.socket().emits.length;
    let mark = b.entries.length;

    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the first file’s delete', () => said(b, KEPT_HOLDS, mark));
    // `dir/sub/b.png` is still here.
    expect(b.h.vault.folders.has('dir')).toBe(true);
    expect(b.h.vault.files.has('dir/a.png')).toBe(false);

    mark = b.entries.length;
    b.server.teammateDelete('f2', { folder: 'dir' });
    await until('the folder removed', () => said(b, REMOVED, mark));

    expect(b.h.vault.folders.has('dir')).toBe(false);
    expect(b.h.vault.folders.has('dir/sub')).toBe(false);
    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    expect(sent(b, emits)).toEqual([]);
    await b.h.engine.stop();
  });

  it('a teammate deletes the last file of a folder, not the folder: it stays', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);

    b.server.teammateDelete('f1');
    await until('the delete applied', () => !b.h.vault.files.has('dir/a.png'));
    await b.h.settle();

    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('a file this client does not sync keeps the folder, and itself', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    b.h.vault.files.set('dir/.gitkeep', encode(''));
    const mark = b.entries.length;

    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the folder looked at', () => said(b, KEPT_NOT_EMPTY, mark));

    expect(b.h.vault.folders.has('dir')).toBe(true);
    expect(b.h.vault.files.has('dir/.gitkeep')).toBe(true);
    await b.h.engine.stop();
  });

  it('a teammate’s new file on its way to this disk keeps the folder', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    // Recorded here, waiting for its doc: not on disk yet.
    await b.server.teammateCreate('dir/new.md', 'new\n');
    await until('the new note recorded', () => b.h.engine.getFileIdForPath('dir/new.md') !== null);
    const mark = b.entries.length;

    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the folder looked at', () => said(b, KEPT_HOLDS, mark));

    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('a teammate’s file recorded under the folder while it is being removed stops the removal', async () => {
    const b = await seeded(['dir/a.png', 'dir/sub/b.png', 'keep.png']);
    const first = b.entries.length;
    b.server.teammateDelete('f2', { folder: 'dir' });
    await until('the first delete applied', () => said(b, KEPT_HOLDS, first));

    const removing = b.h.vault.gate('removeEmptyFolders');
    b.server.teammateDelete('f1', { folder: 'dir' });
    await removing.reached;
    // Between the look at the index and the removal of each folder.
    await b.server.teammateCreate('dir/new.md', 'new\n');
    await until('the new note recorded', () => b.h.engine.getFileIdForPath('dir/new.md') !== null);
    const mark = b.entries.length;
    removing.release();
    await until('the removal given up', () => said(b, KEPT_NOT_EMPTY, mark));

    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('Obsidian’s report of the folder removed sends nothing — not the teammate’s file recorded under it since', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const mark = b.entries.length;
    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the folder removed', () => said(b, REMOVED, mark));
    // A teammate creates a file in the folder again; not written here yet.
    await b.server.teammateCreate('dir/new.md', 'new\n');
    await until('the new note recorded', () => b.h.engine.getFileIdForPath('dir/new.md') !== null);
    const emits = b.h.socket().emits.length;

    // Obsidian's watcher reports the folder removed a moment later.
    await finish(b, dispatch(b.h, [folderEvent('dir')]));

    expect(sent(b, emits)).toEqual([]);
    expect(live(b.server)).toEqual(['dir/new.md', 'keep.png']);
    expect(b.h.engine.getFileIdForPath('dir/new.md')).not.toBeNull();
    await b.h.engine.stop();
  });

  it('two teammate deletes that both find the folder empty: Obsidian’s report of it still sends nothing', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    // A file of the folder this device never got: deleted with the folder
    // all the same (a folder deleted through the web UI or MCP deletes each
    // file of it).
    b.server.add({ id: 'f9', path: 'dir/z.png', fileType: 'BINARY', contentHash: 'h', size: 1 });
    const mark = b.entries.length;
    const removing = b.h.vault.gate('rmdir');
    b.server.teammateDelete('f1', { folder: 'dir' });
    await removing.reached;
    // The other delete, while the first one's removal is on its way.
    b.server.teammateDelete('f9', { folder: 'dir' });
    await flushAsync(20);
    removing.release();
    await until(
      'both deletes done with the folder',
      () =>
        said(b, REMOVED, mark) && (said(b, GONE_ALREADY, mark) || said(b, KEPT_NOT_EMPTY, mark)),
    );
    expect(b.h.vault.folders.has('dir')).toBe(false);
    // A teammate creates a file in the folder again; not written here yet.
    await b.server.teammateCreate('dir/new.md', 'new\n');
    await until('the new note recorded', () => b.h.engine.getFileIdForPath('dir/new.md') !== null);
    const emits = b.h.socket().emits.length;

    // Obsidian's watcher reports the folder removed.
    await finish(b, dispatch(b.h, [folderEvent('dir')]));

    expect(sent(b, emits)).toEqual([]);
    expect(live(b.server)).toEqual(['dir/new.md', 'keep.png']);
    await b.h.engine.stop();
  });

  it('a folder removed here that Obsidian never reported, deleted by the user later: what was written into it since goes', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const mark = b.entries.length;
    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the folder removed', () => said(b, REMOVED, mark));
    // A teammate's file written into the folder right after brings it back
    // before Obsidian looks: Obsidian never reports it gone.
    await uploaded(b, 'dir/c.png', encode('pic'));
    await until('the file written', () => b.h.vault.files.has('dir/c.png'));
    await b.h.settle();
    const emits = b.h.socket().emits.length;

    // The user deletes the folder. The file's own event is swallowed as the
    // echo of the write: only the folder's reaches the engine.
    b.h.vault.removeFolder('dir');
    await finish(b, dispatch(b.h, [folderEvent('dir')]));

    expect(sent(b, emits)).toEqual(['file:delete dir/c.png [dir]']);
    expect(live(b.server)).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('Obsidian’s report of the folder removed while a teammate’s file is being written into it again sends nothing', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const mark = b.entries.length;
    b.server.teammateDelete('f1', { folder: 'dir' });
    await until('the folder removed', () => said(b, REMOVED, mark));
    const writing = b.h.vault.gate('createBinary');
    const id = await uploaded(b, 'dir/c.png', encode('pic'));
    await writing.reached;
    const emits = b.h.socket().emits.length;

    // The report of the removal comes while the file's bytes are on their way
    // to the disk.
    const reported = b.h.engine.handleVaultEvent(folderEvent('dir'));
    await flushAsync(20);
    writing.release();
    await finish(b, [reported]);

    expect(sent(b, emits)).toEqual([]);
    expect(b.server.pathOf(id)).toBe('dir/c.png');
    expect(b.h.vault.files.has('dir/c.png')).toBe(true);
    await b.h.engine.stop();
  });

  it.each([
    ['its first look at the disk', 0],
    ['its second look at the disk', 1],
  ])(
    'Obsidian’s late report of the folder removed, sync stopped at %s: the teammate’s file written into it since is deleted nowhere',
    async (_at, looks) => {
      const b = await seeded(['dir/a.png', 'keep.png']);
      const id = await prunedThenWritten(b);

      // Obsidian reports the removal made here only now.
      await stopAtLook(b, folderEvent('dir'), looks);
      expect(b.h.vault.files.has('dir/c.png')).toBe(true);

      const next = await restarted(b);
      expect(sent(next)).toEqual([]);
      expect(b.server.pathOf(id)).toBe('dir/c.png');
      expect(b.h.vault.text('dir/c.png')).toBe('pic');
      await next.h.engine.stop();
    },
  );

  it('Obsidian’s late report of the folder removed, with a file written into it since: nothing recorded to send', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    await prunedThenWritten(b);
    const calls = b.h.calls.length;

    await finish(b, dispatch(b.h, [folderEvent('dir')]));

    // Nothing that a crash right then, or sync stopped, could send.
    const recorded = b.h.calls
      .slice(calls)
      .filter((call) => call === 'log.recordInFlight' || call === 'log.enqueueOperation');
    expect(recorded).toEqual([]);
    expect(b.h.vault.files.has('dir/c.png')).toBe(true);
    await b.h.engine.stop();
  });

  it('the user deletes a folder removed here, a file of it back on disk before sync stops: its delete is looked at again, and it stays', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);

    // The user deletes the folder: Obsidian's report of it is the one of the
    // removal made here, never reported. After the look at the folder, gone,
    // the file is back on disk — a teammate's new version of it written right
    // then — and sync stops at the next look.
    b.h.vault.removeFolder('dir');
    const look = b.h.vault.gate('exists', 1);
    const handled = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
      () => undefined,
      () => undefined,
    );
    await look.reached;
    b.h.vault.files.set('dir/c.png', encode('pic'));
    const stopped = b.h.engine.stop();
    look.release();
    await stopped;
    await handled;

    const next = await restarted(b);
    expect(sent(next)).toEqual([]);
    expect(b.server.pathOf(id)).toBe('dir/c.png');
    expect(b.h.vault.text('dir/c.png')).toBe('pic');
    await next.h.engine.stop();
  });

  it('a folder’s report with a file of it still on disk: the user’s next change of that file is not taken for an echo', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png']);
    const emits = b.h.socket().emits.length;
    // The user deletes the folder, and `dir/b.png` is written back before
    // Obsidian reports it: only `dir/a.png` is gone.
    b.h.vault.files.delete('dir/a.png');
    // Each mark the engine makes (see `RecentlyApplied`): one of a path
    // swallows the next report of it for a while, taken for the echo of a
    // change the plugin made.
    const marked: string[] = [];
    const mark = b.h.echo.mark.bind(b.h.echo);
    b.h.echo.mark = (path: string, count?: number): void => {
      marked.push(path);
      mark(path, count);
    };

    await finish(b, dispatch(b.h, [folderEvent('dir')]));

    expect(sent(b, emits)).toEqual(['file:delete dir/a.png']);
    // The chokidar `unlink` of the file gone is swallowed; the user's delete
    // of the file still there, a moment later, is not.
    expect(marked).toEqual(['dir/a.png']);
    await b.h.engine.stop();
  });

  it('a teammate renames a folder: the old one goes with the last file moved out of it', async () => {
    const b = await seeded(['old/a.png', 'old/b.png', 'keep.png']);
    let mark = b.entries.length;

    b.server.teammateRename('f1', 'new/a.png', { folder: 'old' });
    await until('the first file moved', () => said(b, KEPT_HOLDS, mark));
    expect(b.h.vault.folders.has('old')).toBe(true);

    mark = b.entries.length;
    b.server.teammateRename('f2', 'new/b.png', { folder: 'old' });
    await until('the folder removed', () => said(b, REMOVED, mark));

    expect(b.h.vault.folders.has('old')).toBe(false);
    expect([...b.h.vault.files.keys()].sort()).toEqual(['keep.png', 'new/a.png', 'new/b.png']);
    await b.h.engine.stop();
  });

  it('the binding’s own folder is never removed', async () => {
    const b = await seeded(['notes/a.png'], { localFolder: 'notes' });

    b.server.teammateDelete('f1', { folder: 'notes' });
    await until('the delete applied', () => !b.h.vault.files.has('notes/a.png'));
    await b.h.settle();

    expect(b.h.vault.folders.has('notes')).toBe(true);
    await b.h.engine.stop();
  });
});

/** A folder `dir` removed here as a teammate's, and a teammate's note `dir/c.md` written into it since. */
async function prunedThenWrittenNote(b: Bench): Promise<string> {
  const mark = b.entries.length;
  b.server.teammateDelete('f1', { folder: 'dir' });
  await until('the folder removed', () => said(b, REMOVED, mark));
  const id = await b.server.teammateCreate('dir/c.md', 'c\n');
  await b.docs?.drive();
  await until('the note written', () => b.h.vault.files.has('dir/c.md'));
  await b.h.settle();
  return id;
}

/**
 * The process dies now, `b`'s `state.json` on `storage` as it is: a new engine
 * starts from that disk and connects, its catch-up, queue and first upload done.
 */
async function crashed(b: Bench, storage: FakeStorage): Promise<Bench> {
  const logger = new Logger('debug', {
    write: (e) => {
      b.entries.push(e);
    },
  });
  const { next } = await restartFromDisk(b.h, storage, {
    server: b.server,
    identity: { logger },
  });
  onDisk.push(next);
  // The downloads the server serves (see `uploaded`).
  for (const [route, respond] of b.h.routes)
    if (!next.routes.has(route)) next.routes.set(route, respond);
  await next.engine.start();
  (await joinToAnswer(next)).ack(b.server.joinAnswer('whole journal'));
  const after = { ...b, h: next };
  await tailDone(after, 0);
  return after;
}

/**
 * The user deletes folder `dir`: only the folder's report reaches the engine
 * (the files' own events are swallowed as echoes of this plugin's writes).
 * Once the first `file:delete` has gone out, its packet is held — it never
 * reaches the server — and `cut` comes: the connection drops, sync is paused,
 * or sync stops.
 */
async function deleteFolderCutAtFirst(b: Bench, cut: 'drop' | 'pause' | 'stop'): Promise<void> {
  b.h.vault.removeFolder('dir');
  const run = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
    () => undefined,
    () => undefined,
  );
  await until('the first delete sent', () =>
    b.h.socket().emits.some((e) => e.event === 'file:delete'),
  );
  b.server.delay(b.h.socket().pending('file:delete'));
  if (cut === 'drop') b.h.socket().disconnect();
  else if (cut === 'pause') b.h.engine.pause();
  else await b.h.engine.stop();
  await run;
}

/** Resume sync after Pause sync: connected again, the catch-up, queue and first upload done. */
async function resumed(b: Bench): Promise<void> {
  const lookups = tombstoneLookups(b.h);
  const resuming = b.h.engine.resume();
  (await joinToAnswer(b.h)).ack(b.server.joinAnswer('whole journal'));
  await resuming;
  await tailDone(b, lookups);
}

/** The queue's entries: `OP path`, ` recheck` for one that asks the replay to look again. */
function queued(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.payload['recheck'] === true ? ' recheck' : ''}`);
}

/**
 * The operations the `state.json` on `storage` holds, queued and in flight —
 * what the next start would send if the process died now: `OP path`.
 */
function recordedOnDisk(storage: FakeStorage): string[] {
  const bucket = storage.state()?.bindings['b1'];
  return [...(bucket?.pending ?? []), ...(bucket?.inflight ?? [])].map(
    (op) => `${op.opType} ${op.filePath}`,
  );
}

describe('SyncEngine — the user deletes a folder removed here: its deletes reach the server', () => {
  it.each([
    ['the connection drops', 'an attachment', false, 'drop'],
    ['the connection drops', 'a note', true, 'drop'],
    ['sync is paused', 'an attachment', false, 'pause'],
  ] as const)(
    '%s while the delete of %s of it waits for its answer: the next connect sends it, and the file stays deleted',
    async (_how, _kind, notes, cut) => {
      const b = notes
        ? await seeded(['dir/a.md', 'keep.md'], { notes: true })
        : await seeded(['dir/a.png', 'keep.png']);
      const path = notes ? 'dir/c.md' : 'dir/c.png';
      const id = notes ? await prunedThenWrittenNote(b) : await prunedThenWritten(b);

      await deleteFolderCutAtFirst(b, cut);
      expect(queued(b.h)).toEqual([`DELETE ${path}`]);
      const socket = b.h.socket();
      const emits = socket.emits.length;

      if (cut === 'pause') await resumed(b);
      else await reconnect(b);

      expect(sent(b, b.h.socket() === socket ? emits : 0)).toEqual([`file:delete ${path} [dir]`]);
      expect(b.server.pathOf(id)).toBeNull();
      expect(b.h.vault.files.has(path)).toBe(false);
      expect(b.h.log.dequeueOperations('b1')).toEqual([]);
      await b.h.engine.stop();
    },
  );

  it('sync stops while the delete of a file of it waits for its answer: the next start sends it, and the file stays deleted', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);

    await deleteFolderCutAtFirst(b, 'stop');
    expect(queued(b.h)).toEqual(['DELETE dir/c.png']);

    const next = await restarted(b);
    expect(sent(next)).toEqual(['file:delete dir/c.png [dir]']);
    expect(b.server.pathOf(id)).toBeNull();
    expect(b.h.vault.files.has('dir/c.png')).toBe(false);
    await next.h.engine.stop();
  });

  it('Obsidian dies while the delete of a file of it waits for its answer: the next start sends it, and the file stays deleted', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/a.png', 'keep.png'], { storage });
    const id = await prunedThenWritten(b);
    await b.h.log.persistNow();

    b.h.vault.removeFolder('dir');
    void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    await until('the first delete sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual(['file:delete dir/c.png [dir]']);
    expect(b.server.pathOf(id)).toBeNull();
    expect(next.h.vault.files.has('dir/c.png')).toBe(false);
    await next.h.engine.stop();
  });

  it.each([['sync stops'], ['Obsidian dies']])(
    '%s while the first of two files’ deletes waits for its answer: the next start sends both',
    async (how) => {
      const storage = new FakeStorage();
      const b = await seeded(['dir/a.png', 'keep.png'], { storage });
      const c = await prunedThenWritten(b);
      const d = await uploaded(b, 'dir/d.png', encode('pic2'));
      await until('the second file written', () => b.h.vault.files.has('dir/d.png'));
      await b.h.settle();
      await b.h.log.persistNow();

      let next: Bench;
      if (how === 'sync stops') {
        await deleteFolderCutAtFirst(b, 'stop');
        expect(queued(b.h)).toEqual(['DELETE dir/c.png', 'DELETE dir/d.png']);
        next = await restarted(b);
      } else {
        b.h.vault.removeFolder('dir');
        void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
        await until('the first delete sent', () =>
          b.h.socket().emits.some((e) => e.event === 'file:delete'),
        );
        b.server.delay(b.h.socket().pending('file:delete'));
        next = await crashed(b, storage);
      }

      expect(sent(next).sort()).toEqual([
        'file:delete dir/c.png [dir]',
        'file:delete dir/d.png [dir]',
      ]);
      expect(b.server.pathOf(c)).toBeNull();
      expect(b.server.pathOf(d)).toBeNull();
      expect(live(b.server)).toEqual(['keep.png']);
      expect(next.h.vault.files.has('dir/c.png')).toBe(false);
      expect(next.h.vault.files.has('dir/d.png')).toBe(false);
      await next.h.engine.stop();
    },
  );

  it('the connection drops while the first of two files’ deletes waits for its answer: both go with the next connect', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    await prunedThenWritten(b);
    await uploaded(b, 'dir/d.png', encode('pic2'));
    await until('the second file written', () => b.h.vault.files.has('dir/d.png'));
    await b.h.settle();

    await deleteFolderCutAtFirst(b, 'drop');
    expect(queued(b.h)).toEqual(['DELETE dir/c.png', 'DELETE dir/d.png']);
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits)).toEqual(['file:delete dir/c.png [dir]', 'file:delete dir/d.png [dir]']);
    expect(live(b.server)).toEqual(['keep.png']);
    expect(b.h.vault.files.has('dir/c.png')).toBe(false);
    expect(b.h.vault.files.has('dir/d.png')).toBe(false);
    await b.h.engine.stop();
  });

  it('the server busy with the delete of a file of it: the queue sends it again, and the file stays deleted', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);
    b.server.bar(1);

    b.h.vault.removeFolder('dir');
    await finish(b, dispatch(b.h, [folderEvent('dir')]));
    for (let round = 0; round < 20 && b.server.pathOf(id) !== null; round++) {
      await b.server.pump();
      await b.h.settle();
    }

    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual([
      'file:delete dir/c.png [dir]',
      'file:delete dir/c.png [dir]',
    ]);
    expect(live(b.server)).toEqual(['keep.png']);
    expect(b.h.vault.files.has('dir/c.png')).toBe(false);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    await b.h.engine.stop();
  });

  it('a file of it back on disk by its own turn, sync stopping while the next file’s delete waits: the file back is deleted nowhere', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const c = await prunedThenWritten(b);
    await uploaded(b, 'dir/d.png', encode('pic2'));
    await until('the second file written', () => b.h.vault.files.has('dir/d.png'));
    await b.h.settle();
    // The deletes recorded ahead, the first file is back on disk before its
    // turn: a teammate's version of it written right then.
    const persist = b.h.log.persistNow.bind(b.h.log);
    let back = false;
    b.h.log.persistNow = (): Promise<void> => {
      if (!back && b.h.log.inFlightOperations('b1').length > 0) {
        back = true;
        b.h.vault.files.set('dir/c.png', encode('pic'));
      }
      return persist();
    };

    await deleteFolderCutAtFirst(b, 'stop');
    expect(back).toBe(true);
    // The folder is back with the file: it goes nowhere.
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual(['file:delete dir/d.png']);
    expect(queued(b.h)).toEqual(['DELETE dir/d.png']);

    const next = await restarted(b);
    expect(sent(next)).toEqual(['file:delete dir/d.png']);
    expect(b.server.pathOf(c)).toBe('dir/c.png');
    expect(b.h.vault.text('dir/c.png')).toBe('pic');
    expect(live(b.server)).toEqual(['dir/c.png', 'keep.png']);
    await next.h.engine.stop();
  });

  it('a file of it found on disk at its first look, sync stopping before its turn: its delete is looked at again, and it stays', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);
    // The file is back on disk when its delete first looks — a teammate's
    // version of it written right then — and sync stops at the next look,
    // before the delete's turn.
    const exists = b.h.vault.exists.bind(b.h.vault);
    let looked = false;
    const stop: { done: Promise<void> | null } = { done: null };
    b.h.vault.exists = (path: string): Promise<boolean> => {
      if (path === 'dir/c.png' && !looked) {
        looked = true;
        b.h.vault.files.set('dir/c.png', encode('pic'));
      } else if (looked && stop.done === null) {
        stop.done = b.h.engine.stop();
      }
      return exists(path);
    };

    b.h.vault.removeFolder('dir');
    await b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    expect(stop.done).not.toBeNull();
    await stop.done;
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual([]);

    const next = await restarted(b);
    expect(sent(next)).toEqual([]);
    expect(b.server.pathOf(id)).toBe('dir/c.png');
    expect(b.h.vault.text('dir/c.png')).toBe('pic');
    await next.h.engine.stop();
  });

  it('a file of it found on disk at its first look and gone by its turn: its delete goes as checked, the connection dropping while it waits included', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);
    // The first look at the file finds it back on disk; by its turn, it is gone again.
    const exists = b.h.vault.exists.bind(b.h.vault);
    let looks = 0;
    b.h.vault.exists = (path: string): Promise<boolean> => {
      if (path === 'dir/c.png') {
        looks += 1;
        if (looks === 1) b.h.vault.files.set('dir/c.png', encode('pic'));
        else if (looks === 2) b.h.vault.removeFolder('dir');
      }
      return exists(path);
    };

    await deleteFolderCutAtFirst(b, 'drop');
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(queued(b.h)).toEqual(['DELETE dir/c.png']);
    const emits = b.h.socket().emits.length;

    await reconnect(b);

    expect(sent(b, emits)).toEqual(['file:delete dir/c.png [dir]']);
    expect(b.server.pathOf(id)).toBeNull();
    expect(b.h.vault.files.has('dir/c.png')).toBe(false);
    await b.h.engine.stop();
  });

  it('a file of it found on disk at its first look and gone by its turn: its delete goes out once what its look found is on disk, and Obsidian dying then does not lose it', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/a.png', 'keep.png'], { storage });
    const id = await prunedThenWritten(b);
    await b.h.log.persistNow();
    const exists = b.h.vault.exists.bind(b.h.vault);
    let looks = 0;
    b.h.vault.exists = (path: string): Promise<boolean> => {
      if (path === 'dir/c.png') {
        looks += 1;
        if (looks === 1) b.h.vault.files.set('dir/c.png', encode('pic'));
        else if (looks === 2) b.h.vault.removeFolder('dir');
      }
      return exists(path);
    };
    // Each `state.json` that lands: whether the delete of the file in it asks
    // for a recheck, and how many deletes had gone out by then.
    const landed: Array<{ deletes: number; recheck: boolean | null }> = [];
    storage.onState = (state): void => {
      const inflight = (state.bindings['b1']?.inflight ?? []) as Array<{
        filePath: string;
        payload?: Record<string, unknown>;
      }>;
      const op = inflight.find((o) => o.filePath === 'dir/c.png');
      landed.push({
        deletes: b.h.socket().emits.filter((e) => e.event === 'file:delete').length,
        recheck: op === undefined ? null : op.payload?.['recheck'] === true,
      });
    };

    b.h.vault.removeFolder('dir');
    void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    await until('the delete sent', () => b.h.socket().emits.some((e) => e.event === 'file:delete'));
    b.server.delay(b.h.socket().pending('file:delete'));
    storage.onState = null;

    // Recorded ahead with the recheck — the file was on disk at its first
    // look — and on disk without it before the delete went out.
    const ahead = landed.findIndex((s) => s.recheck === true);
    const checked = landed.findIndex((s) => s.recheck === false);
    expect(ahead).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThan(ahead);
    expect(landed[checked]?.deletes).toBe(0);

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual(['file:delete dir/c.png [dir]']);
    expect(b.server.pathOf(id)).toBeNull();
    expect(next.h.vault.files.has('dir/c.png')).toBe(false);
    await next.h.engine.stop();
  });

  it('a file whose own delete found it on disk, its folder gone by then: the folder’s delete of it is looked at again when sync stops at its look', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);

    // A stray report of the file comes first: its handler looks at the disk
    // while the user deletes the folder.
    const own = b.h.vault.gate('exists');
    const stray = b.h.engine.handleVaultEvent(fileEvent('dir/c.png')).then(
      () => undefined,
      () => undefined,
    );
    await own.reached;
    b.h.vault.removeFolder('dir');
    const folder = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
      () => undefined,
      () => undefined,
    );
    await until('the folder’s delete waiting for the file’s', () =>
      said(b, 'folder delete → expanding'),
    );
    // The file is on disk when its own handler looks: nothing goes for it.
    b.h.vault.files.set('dir/c.png', encode('pic'));
    const again = b.h.vault.gate('exists');
    own.release();
    await stray;
    // The folder's delete of the file looks at it again — and the file is
    // there (a teammate's version written right then) when sync stops.
    await again.reached;
    const stopped = b.h.engine.stop();
    again.release();
    await stopped;
    await folder;

    const next = await restarted(b);
    expect(sent(next)).toEqual([]);
    expect(b.server.pathOf(id)).toBe('dir/c.png');
    expect(b.h.vault.text('dir/c.png')).toBe('pic');
    await next.h.engine.stop();
  });

  it('Obsidian’s late report of the folder removed, the connection dropping right after: the next connect sends nothing', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const id = await prunedThenWritten(b);
    const emits = b.h.socket().emits.length;

    await finish(b, dispatch(b.h, [folderEvent('dir')]));
    b.h.socket().disconnect();
    await b.h.settle();
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);

    await reconnect(b);

    expect(sent(b, emits)).toEqual([]);
    expect(b.server.pathOf(id)).toBe('dir/c.png');
    expect(b.h.vault.text('dir/c.png')).toBe('pic');
    await b.h.engine.stop();
  });

  it('a file of it back on disk right after its first look, Obsidian dying while the next file’s delete waits: the file back is deleted nowhere', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/a.png', 'keep.png'], { storage });
    const c = await prunedThenWritten(b);
    await uploaded(b, 'dir/d.png', encode('pic2'));
    await until('the second file written', () => b.h.vault.files.has('dir/d.png'));
    await b.h.settle();
    await b.h.log.persistNow();
    // The first file is back on disk once its first look found it gone — a
    // teammate's version of it written right then — and with it the folder:
    // the deletes are recorded ahead as checked, without the folder, and the
    // next file's goes out as recorded.
    const exists = b.h.vault.exists.bind(b.h.vault);
    let back = false;
    b.h.vault.exists = (path: string): Promise<boolean> => {
      if (path === 'dir/d.png' && !back) {
        back = true;
        b.h.vault.files.set('dir/c.png', encode('pic'));
      }
      return exists(path);
    };

    b.h.vault.removeFolder('dir');
    void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    await until('the delete of the next file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));
    expect(back).toBe(true);
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual(['file:delete dir/d.png']);
    expect(recordedOnDisk(storage)).toEqual(['DELETE dir/d.png']);

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual(['file:delete dir/d.png']);
    expect(b.server.pathOf(c)).toBe('dir/c.png');
    expect(next.h.vault.text('dir/c.png')).toBe('pic');
    expect(live(b.server)).toEqual(['dir/c.png', 'keep.png']);
    await next.h.engine.stop();
  });

  it('sync stopping while it looks at the files of it: the delete of one found gone goes with the folder', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    const c = await prunedThenWritten(b);
    const d = await uploaded(b, 'dir/d.png', encode('pic2'));
    await until('the second file written', () => b.h.vault.files.has('dir/d.png'));
    await b.h.settle();
    // Sync stops at the look at the second file, the first found gone.
    const exists = b.h.vault.exists.bind(b.h.vault);
    const stop: { done: Promise<void> | null } = { done: null };
    b.h.vault.exists = (path: string): Promise<boolean> => {
      if (path === 'dir/d.png' && stop.done === null) stop.done = b.h.engine.stop();
      return exists(path);
    };

    b.h.vault.removeFolder('dir');
    await b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    expect(stop.done).not.toBeNull();
    await stop.done;
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual([]);
    expect(queued(b.h)).toEqual(['DELETE dir/c.png', 'DELETE dir/d.png recheck']);
    expect(b.h.log.dequeueOperations('b1').map((op) => op.payload['folder'])).toEqual([
      'dir',
      'dir',
    ]);

    // The file not looked at yet comes back, as before; the one found gone
    // goes, and its teammates remove the folder once nothing is left in it.
    const next = await restarted(b);
    expect(sent(next)).toEqual(['file:delete dir/c.png [dir]']);
    expect(b.server.pathOf(c)).toBeNull();
    expect(b.server.pathOf(d)).toBe('dir/d.png');
    expect(next.h.vault.files.has('dir/c.png')).toBe(false);
    expect(next.h.vault.text('dir/d.png')).toBe('pic2');
    await next.h.engine.stop();
  });
});

describe('SyncEngine — a folder deleted: a file its own look finds nothing to send for is not sent later', () => {
  it('a file of the folder still on disk at its look, sync stopping while another file’s delete waits: the file kept is deleted nowhere', async () => {
    const b = await seeded(['dir/b.png', 'dir/a.png', 'keep.png']);
    // The user deletes the folder, and `dir/b.png` is written back before
    // Obsidian reports it: only `dir/a.png` is gone.
    b.h.vault.files.delete('dir/a.png');
    const run = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
      () => undefined,
      () => undefined,
    );
    await until('the delete of the gone file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));
    await b.h.engine.stop();
    await run;
    expect(queued(b.h)).toEqual(['DELETE dir/a.png']);

    const next = await restarted(b);
    expect(sent(next)).toEqual(['file:delete dir/a.png']);
    expect(b.server.pathOf('f1')).toBe('dir/b.png');
    expect(b.h.vault.text('dir/b.png')).toBe('dir/b.png\n');
    expect(live(b.server)).toEqual(['dir/b.png', 'keep.png']);
    await next.h.engine.stop();
  });

  it('a file of the folder a teammate renames while its delete looks at the disk, sync stopping while another file’s delete waits: the renamed file is deleted nowhere', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png']);
    // The teammate's rename of `dir/a.png` lands while its delete looks at the
    // disk: from then on the file is theirs, under another name.
    const exists = b.h.vault.exists.bind(b.h.vault);
    let renamed = false;
    b.h.vault.exists = async (path: string): Promise<boolean> => {
      if (path === 'dir/a.png' && !renamed) {
        renamed = true;
        b.server.teammateRename('f1', 'other/a.png');
        await until(
          'the rename applied',
          () => b.h.engine.getFileIdForPath('other/a.png') === 'f1',
        );
      }
      return exists(path);
    };
    b.h.vault.removeFolder('dir');
    const run = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
      () => undefined,
      () => undefined,
    );
    await until('the delete of the other file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));
    await b.h.engine.stop();
    await run;
    expect(renamed).toBe(true);
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual([
      'file:delete dir/b.png [dir]',
    ]);
    expect(queued(b.h)).toEqual(['DELETE dir/b.png']);

    const next = await restarted(b);
    expect(sent(next)).toEqual(['file:delete dir/b.png [dir]']);
    expect(b.server.pathOf('f1')).toBe('other/a.png');
    expect(live(b.server)).toEqual(['keep.png', 'other/a.png']);
    await next.h.engine.stop();
  });

  // The deletes recorded ahead go out without a write of their own: the
  // record of one that sends nothing has to leave `state.json` by itself,
  // without waiting out the debounce — which never runs out here.
  it('a file of the folder still on disk at its look, Obsidian dying while another file’s delete waits: the file kept is deleted nowhere', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/b.png', 'dir/a.png', 'keep.png'], { storage });
    // The user deletes the folder, and `dir/b.png` is written back before
    // Obsidian reports it: only `dir/a.png` is gone.
    b.h.vault.files.delete('dir/a.png');
    void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    await until('the delete of the gone file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));
    expect(recordedOnDisk(storage)).toEqual(['DELETE dir/a.png']);

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual(['file:delete dir/a.png']);
    expect(b.server.pathOf('f1')).toBe('dir/b.png');
    expect(next.h.vault.text('dir/b.png')).toBe('dir/b.png\n');
    expect(live(b.server)).toEqual(['dir/b.png', 'keep.png']);
    await next.h.engine.stop();
  });

  it('a file of the folder a teammate renames while its delete looks at the disk, Obsidian dying while another file’s delete waits: the renamed file is deleted nowhere', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png'], { storage });
    const exists = b.h.vault.exists.bind(b.h.vault);
    let renamed = false;
    b.h.vault.exists = async (path: string): Promise<boolean> => {
      if (path === 'dir/a.png' && !renamed) {
        renamed = true;
        b.server.teammateRename('f1', 'other/a.png');
        await until(
          'the rename applied',
          () => b.h.engine.getFileIdForPath('other/a.png') === 'f1',
        );
      }
      return exists(path);
    };
    b.h.vault.removeFolder('dir');
    void b.h.engine.handleVaultEvent(folderEvent('dir')).catch(() => undefined);
    await until('the delete of the other file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    b.server.delay(b.h.socket().pending('file:delete'));
    expect(renamed).toBe(true);
    expect(recordedOnDisk(storage)).toEqual(['DELETE dir/b.png']);

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual(['file:delete dir/b.png [dir]']);
    expect(b.server.pathOf('f1')).toBe('other/a.png');
    expect(live(b.server)).toEqual(['keep.png', 'other/a.png']);
    await next.h.engine.stop();
  });

  it('a file of the folder a teammate renames while another file’s delete waits for its answer, Obsidian dying once the folder’s delete is through: the renamed file is deleted nowhere', async () => {
    const storage = new FakeStorage();
    const b = await seeded(['dir/a.png', 'dir/b.png', 'keep.png'], { storage });
    b.h.vault.removeFolder('dir');
    const run = b.h.engine.handleVaultEvent(folderEvent('dir')).then(
      () => true,
      () => true,
    );
    await until('the delete of the first file sent', () =>
      b.h.socket().emits.some((e) => e.event === 'file:delete'),
    );
    // While it waits for its answer, a teammate renames the other file out of
    // the folder: by its turn, it is theirs, under another name.
    b.server.teammateRename('f2', 'other/b.png');
    await until('the rename applied', () => b.h.engine.getFileIdForPath('other/b.png') === 'f2');
    let through = false;
    void run.then((done) => {
      through = done;
    });
    await until('the folder’s delete through', () => {
      b.server.serveNext();
      return through;
    });
    expect(sent(b).filter((s) => s.startsWith('file:delete'))).toEqual([
      'file:delete dir/a.png [dir]',
    ]);
    expect(recordedOnDisk(storage)).toEqual([]);

    const next = await crashed(b, storage);
    expect(sent(next)).toEqual([]);
    expect(b.server.pathOf('f2')).toBe('other/b.png');
    expect(live(b.server)).toEqual(['keep.png', 'other/b.png']);
    await next.h.engine.stop();
  });
});

describe('SyncEngine — a folder a teammate deleted or renamed while this device was away', () => {
  it('deleted: removed once the connect has removed the copies of its files', async () => {
    const b = await seeded(['dir/a.png', 'dir/sub/b.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'dir' });
    b.server.teammateDelete('f2', { folder: 'dir' });
    const emits = b.h.socket().emits.length;

    await reconnect(b);
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect(b.h.vault.folders.has('dir/sub')).toBe(false);
    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    expect(sent(b, emits)).toEqual([]);
    await b.h.engine.stop();
  });

  it('renamed: the old folder goes, the files are under the new one', async () => {
    const b = await seeded(['old/a.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateRename('f1', 'new/a.png', { folder: 'old' });

    await reconnect(b);
    await until('the folder removed', () => !b.h.vault.folders.has('old'));

    expect([...b.h.vault.files.keys()].sort()).toEqual(['keep.png', 'new/a.png']);
    await b.h.engine.stop();
  });

  it('the connect cut short by Pause sync before the copies went: the next one removes the folder', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'dir' });
    // The first upload looks up the server's deleted files; sync is paused then.
    const served = b.h.routes.get(TOMBSTONES);
    if (served === undefined) throw new Error('no route for the deleted files');
    const lookedUp = deferred<void>();
    b.h.routes.set(TOMBSTONES, () => lookedUp.promise.then(served));
    const asked = tombstoneLookups(b.h);
    const before = joinsOf(b.h);
    b.h.socket().connect();
    (await nextJoin(b.h, before)).ack(b.server.joinAnswer('whole journal'));
    await until('the first upload started', () => tombstoneLookups(b.h) > asked);
    b.h.engine.pause();
    lookedUp.resolve();
    await flushAsync(20);
    expect(b.h.vault.files.has('dir/a.png')).toBe(true);
    b.h.routes.set(TOMBSTONES, served);

    const resumed = b.h.engine.resume();
    // A new connection, a join of its own. Nothing new in the catch-up: the
    // connect paused took the operation in.
    await until('the join after Resume sync', () =>
      (b.h.socketIfBuilt()?.emits ?? []).some(
        (e) => e.event === 'project:join' && e.answered !== true,
      ),
    );
    (await joinToAnswer(b.h)).ack(b.server.joinAnswer('whole journal'));
    await resumed;
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('the lookup of the server’s deleted files failed: the next connect removes the folder with the copy', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'dir' });
    const served = b.h.routes.get(TOMBSTONES);
    if (served === undefined) throw new Error('no route for the deleted files');
    b.h.routes.set(TOMBSTONES, () => json({ error: 'internal' }, 500));

    await reconnect(b);
    // The first upload is put off: the copy stays, and the folder with it.
    expect(b.h.vault.files.has('dir/a.png')).toBe(true);
    expect(b.h.vault.folders.has('dir')).toBe(true);

    b.h.routes.set(TOMBSTONES, served);
    b.h.socket().disconnect();
    await reconnect(b);
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('the lookup of the server’s deleted files failed: a folder with nothing left in it goes at once, one with a copy at the next connect', async () => {
    const b = await seeded(['dir/a.png', 'old/b.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'dir' });
    b.server.teammateRename('f2', 'new/b.png', { folder: 'old' });
    const served = b.h.routes.get(TOMBSTONES);
    if (served === undefined) throw new Error('no route for the deleted files');
    b.h.routes.set(TOMBSTONES, () => json({ error: 'internal' }, 500));

    await reconnect(b);
    // The catch-up moved the file out of the renamed folder: nothing waits
    // for the next connect there. Left for it, the folder stayed for good
    // when Obsidian restarted first.
    await until('the renamed folder removed', () => !b.h.vault.folders.has('old'));
    // The first upload is put off: the copy stays, and its folder with it.
    expect(b.h.vault.files.has('dir/a.png')).toBe(true);
    expect(b.h.vault.folders.has('dir')).toBe(true);

    b.h.routes.set(TOMBSTONES, served);
    b.h.socket().disconnect();
    await reconnect(b);
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect([...b.h.vault.files.keys()].sort()).toEqual(['keep.png', 'new/b.png']);
    await b.h.engine.stop();
  });

  it('“Restore on server” for a copy whose upload failed keeps its folder for the next connect, which removes it on “Delete”', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    b.h.socket().disconnect();
    // Changed here while away: the user is asked before the copy goes.
    b.h.vault.files.set('dir/a.png', encode('mine'));
    b.server.teammateDelete('f1', { folder: 'dir' });
    const upload = b.h.routes.get('PUT /blobs');
    if (upload === undefined) throw new Error('no route for the uploads');
    b.h.routes.set('PUT /blobs', () => json({ error: 'unavailable' }, 503));
    const questions = (): number =>
      b.h.calls.filter((call) => call === 'modal.resolveDeleteConflict').length;
    let mark = b.entries.length;

    await reconnect(b);
    await until('the question', () => questions() === 1);
    b.h.modal.del.resolve('restore-server');
    await until('the restore given up', () =>
      said(b, 'restore-server push failed; asking again on reconnect', mark),
    );
    await until(
      'the folders of the catch-up looked at',
      () => said(b, LEFT_FOR_NEXT, mark) || said(b, KEPT_NOT_EMPTY, mark),
    );
    expect(b.h.vault.text('dir/a.png')).toBe('mine');

    // The next connect asks again; the user deletes the copy this time.
    b.h.routes.set('PUT /blobs', upload);
    b.h.modal.del = deferred();
    b.h.socket().disconnect();
    mark = b.entries.length;
    await reconnect(b);
    await until('the question again', () => questions() === 2);
    b.h.modal.del.resolve('delete-local');
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    expect(said(b, REMOVED, mark)).toBe(true);
    await b.h.engine.stop();
  });

  it('a copy that could not be removed keeps its folder for the next connect; the other folders go at once', async () => {
    const b = await seeded(['one/a.png', 'two/b.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'one' });
    b.server.teammateDelete('f2', { folder: 'two' });
    // The first removal of `one/a.png` fails: held by another program, say.
    const remove = b.h.vault.delete.bind(b.h.vault);
    let failed = false;
    b.h.vault.delete = async (path: string): Promise<void> => {
      if (path === 'one/a.png' && !failed) {
        failed = true;
        throw new Error('EBUSY');
      }
      await remove(path);
    };

    await reconnect(b);
    await until('the other folder removed', () => !b.h.vault.folders.has('two'));
    expect(failed).toBe(true);
    expect(b.h.vault.files.has('one/a.png')).toBe(true);
    expect(b.h.vault.folders.has('one')).toBe(true);

    b.h.socket().disconnect();
    await reconnect(b);
    await until('the folder removed', () => !b.h.vault.folders.has('one'));

    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('a catch-up cut short: the folder of a deleted file among its operations goes all the same', async () => {
    const b = await seeded(['dir/a.png', 'x.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f2');
    b.server.teammateDelete('f1', { folder: 'dir' });

    // The newest operation only: the listing tells the rest.
    await reconnect(b, 1);
    await until('the folder removed', () => !b.h.vault.folders.has('dir'));

    expect([...b.h.vault.files.keys()]).toEqual(['keep.png']);
    await b.h.engine.stop();
  });

  it('a catch-up cut short without the folder’s operation: the folder is left as it is', async () => {
    const b = await seeded(['dir/a.png', 'x.png', 'keep.png']);
    b.h.socket().disconnect();
    b.server.teammateDelete('f1', { folder: 'dir' });
    b.server.teammateDelete('f2');

    // The newest operation only: the folder's is not among it.
    await reconnect(b, 1);
    await until('the copy removed', () => !b.h.vault.files.has('dir/a.png'));
    await b.h.settle();

    expect(b.h.vault.folders.has('dir')).toBe(true);
    await b.h.engine.stop();
  });

  it('a catch-up cut short: a folder that holds a file of the listing stays, the file comes', async () => {
    const b = await seeded(['dir/a.png', 'keep.png']);
    b.h.socket().disconnect();
    // A teammate adds a file to the folder; another device, which never got
    // it, deletes the folder.
    await uploaded(b, 'dir/new.png', encode('pic'));
    b.server.teammateDelete('f1', { folder: 'dir' });
    const mark = b.entries.length;

    // The newest operation only: the listing tells the rest.
    await reconnect(b, 1);
    await until('the folder looked at', () => said(b, KEPT_HOLDS, mark));

    expect(b.h.vault.folders.has('dir')).toBe(true);
    expect(b.h.vault.text('dir/new.png')).toBe('pic');
    expect(b.h.vault.files.has('dir/a.png')).toBe(false);
    await b.h.engine.stop();
  });
});
