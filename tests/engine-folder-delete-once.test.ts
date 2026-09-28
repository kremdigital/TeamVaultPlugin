/**
 * A folder deleted in Obsidian: each file in it is deleted on the server
 * once, under one `opId`, whatever order the events of its deletion come in.
 *
 * Obsidian 1.13.7 deletes a folder on disk first and then reports it
 * (`reconcileDeletion` in `app.js`): a `delete` of every file and subfolder
 * in it, in the order Obsidian listed them — a subfolder before its files, a
 * file renamed since after the rest — and one of the folder last. chokidar
 * reports each file's `unlink` besides, 100 ms after its own `fs.rm`: before
 * Obsidian's events when removing the folder takes longer, after them
 * otherwise. The engine expands each folder's event into its files' deletes.
 *
 * Before: each of those events sent a delete of its own. On 2026-09-28 a
 * folder of an attachment saved again a moment before, two notes and a
 * subfolder with a note renamed twice was deleted in `test-vault-2`: the
 * attachment and the subfolder's note each went to the server twice, under
 * two `opId`s — the folder's expansion came before the answers to their own
 * deletes. A delete of a tombstone is applied and logged again, and one that
 * comes late deletes the file a teammate has created again under the name
 * (the server gives it the deleted file's id). Offline, the queue got both.
 */
import { sha256Hex } from '@/sync/hash';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FOREIGN_DB,
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  buildHarness,
  dbNameOf,
  deferred,
  encode,
  flushAsync,
  joinToAnswer,
  userRename,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

const LIST = '/api/projects/p1/files';

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  idb: FakeIndexedDb;
}

/**
 * `paths` synced — notes (`.md`) with their docs open and stored, the rest
 * attachments — recorded in this order; the engine connected.
 */
async function seeded(paths: readonly string[]): Promise<Bench> {
  const idb = new FakeIndexedDb();
  const h = buildHarness({ docs: idb.manager() });
  const server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
  for (const [i, path] of paths.entries()) {
    const id = `f${i + 1}`;
    const text = `${path}\n`;
    const content = encode(text);
    const hash = await sha256Hex(content);
    const note = path.endsWith('.md');
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
  await h.engine.start();
  (await joinToAnswer(h)).ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
  await docs.drive();
  for (const path of paths) if (path.endsWith('.md')) await h.doc.whenSynced('b1', path);
  return { h, server, docs, idb };
}

function fileEvent(path: string, source: 'obsidian' | 'fs' = 'obsidian'): VaultEvent {
  return { bindingId: 'b1', type: 'delete', path, source };
}

function folderEvent(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'delete', path, source: 'obsidian', isFolder: true };
}

/** What the engine has sent and done from now on. */
interface Since {
  emits: number;
  requests: number;
  idbDeleted: number;
  journal: number;
}

function since(b: Bench): Since {
  return {
    emits: b.h.socket().emits.length,
    requests: b.h.requests.length,
    idbDeleted: b.idb.deleted.length,
    journal: b.server.journal.length,
  };
}

/** Paths of the `file:delete`s sent since `mark`, sorted. */
function deletesSent(b: Bench, mark: Since): string[] {
  return b.h
    .socket()
    .emits.slice(mark.emits)
    .filter((e) => e.event === 'file:delete')
    .map((e) => (e.payload as { filePath: string }).filePath)
    .sort();
}

/** Paths of the DELETEs the server applied since `mark`, sorted. */
function deletesApplied(b: Bench, mark: Since): string[] {
  return b.server.journal
    .slice(mark.journal)
    .filter((row) => row.opType === 'DELETE')
    .map((row) => row.filePath)
    .sort();
}

/** Listings of the whole project asked for since `mark`. */
function listings(b: Bench, mark: Since): number {
  return b.h.requests.slice(mark.requests).filter((r) => r.method === 'GET' && r.path === LIST)
    .length;
}

function live(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => f.path)
    .sort();
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort();
}

/**
 * Let the handlers of `runs` finish, the server answering on the way; fails
 * when one threw or one still waits after the server has answered all.
 */
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
  const results = await all;
  expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  await b.server.pump(500);
  await b.h.settle();
}

/** Dispatch `events` as `main.ts` does — one after another, none awaited. */
function dispatch(h: Harness, events: readonly VaultEvent[]): Array<Promise<void>> {
  return events.map((event) => h.engine.handleVaultEvent(event));
}

function removeFromDisk(h: Harness, paths: readonly string[]): void {
  for (const path of paths) h.vault.files.delete(path);
}

/** Each of `paths` deleted once, on the server and here, with nothing left to send. */
function expectDeletedOnce(b: Bench, mark: Since, paths: readonly string[]): void {
  const sorted = [...paths].sort();
  expect(deletesSent(b, mark)).toEqual(sorted);
  expect(deletesApplied(b, mark)).toEqual(sorted);
  expect(new Set(b.server.appliedOpIds).size).toBe(b.server.appliedOpIds.length);
  for (const path of paths) {
    expect(live(b.server)).not.toContain(path);
    expect(disk(b.h)).not.toContain(path);
    expect(b.h.engine.getFileIdForPath(path)).toBeNull();
  }
  expect(b.h.log.dequeueOperations('b1')).toEqual([]);
  expect(b.h.log.inFlightOperations('b1')).toEqual([]);
}

describe('SyncEngine — a folder deleted in Obsidian: one delete per file', () => {
  it('the folder of 2026-09-28: an attachment saved again, notes, a subfolder with a note renamed twice', async () => {
    const b = await seeded([
      'dir/img.png',
      'dir/выход.md',
      'dir/пауза.md',
      'dir/sub/черновик.md',
      'keep.md',
    ]);
    const { h, server, docs, idb } = b;
    // The attachment saved again.
    h.vault.files.set('dir/img.png', encode('img v2'));
    await finish(b, [
      h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'dir/img.png',
        source: 'obsidian',
      }),
    ]);
    // The note renamed twice: Obsidian lists it after the subfolder now.
    await userRename(h, 'dir/sub/черновик.md', 'dir/sub/b.md');
    await docs.drive();
    await userRename(h, 'dir/sub/b.md', 'dir/sub/c.md');
    await docs.drive();
    expect(server.applied).toEqual([
      'update f1',
      'f4 dir/sub/черновик.md -> dir/sub/b.md',
      'f4 dir/sub/b.md -> dir/sub/c.md',
    ]);
    const notes = ['dir/выход.md', 'dir/пауза.md', 'dir/sub/c.md'];
    for (const note of notes) expect(idb.dbs.has(dbNameOf(note))).toBe(true);
    const files = ['dir/img.png', ...notes];

    const mark = since(b);
    const clear = jest.spyOn(h.doc, 'clear');
    removeFromDisk(h, files);
    // Obsidian 1.13.7's order for this folder.
    const runs = dispatch(h, [
      fileEvent('dir/img.png'),
      fileEvent('dir/выход.md'),
      fileEvent('dir/пауза.md'),
      folderEvent('dir/sub'),
      fileEvent('dir/sub/c.md'),
      folderEvent('dir'),
    ]);
    await finish(b, runs);

    expectDeletedOnce(b, mark, files);
    // No file looked up in the listing of the whole project.
    expect(listings(b, mark)).toBe(0);
    expect(live(server)).toEqual(['keep.md']);
    expect(disk(h)).toEqual(['keep.md']);
    // Each file's history dropped once, by its own name; the stores of the
    // note kept and of Obsidian are untouched.
    expect(clear.mock.calls.map(([, path]) => path).sort()).toEqual([...files].sort());
    expect(idb.deleted.slice(mark.idbDeleted).sort()).toEqual(notes.map(dbNameOf).sort());
    expect(idb.dbs.has(dbNameOf('keep.md'))).toBe(true);
    expect(idb.dbs.has(FOREIGN_DB)).toBe(true);
    await h.engine.stop();
  });

  it('two nested subfolders: the file deep inside is deleted once, not three times', async () => {
    const b = await seeded(['dir/x.png', 'dir/sub/deep/d.png', 'dir/sub/deep/n.md']);
    const files = ['dir/x.png', 'dir/sub/deep/d.png', 'dir/sub/deep/n.md'];
    const mark = since(b);
    removeFromDisk(b.h, files);
    const runs = dispatch(b.h, [
      fileEvent('dir/x.png'),
      folderEvent('dir/sub'),
      folderEvent('dir/sub/deep'),
      fileEvent('dir/sub/deep/d.png'),
      fileEvent('dir/sub/deep/n.md'),
      folderEvent('dir'),
    ]);
    await finish(b, runs);

    expectDeletedOnce(b, mark, files);
    expect(listings(b, mark)).toBe(0);
    await b.h.engine.stop();
  });

  it('chokidar’s unlink before Obsidian’s delete, both on their way at once: one delete', async () => {
    const b = await seeded(['a.png', 'n.md']);
    const mark = since(b);
    removeFromDisk(b.h, ['a.png', 'n.md']);
    // A large folder takes longer to remove than chokidar waits (100 ms), and
    // Obsidian registers its own event only after the removal: the FS watcher
    // has nothing to take the `unlink` for.
    const runs = dispatch(b.h, [
      fileEvent('a.png', 'fs'),
      fileEvent('a.png'),
      fileEvent('n.md', 'fs'),
      fileEvent('n.md'),
    ]);
    await finish(b, runs);

    expectDeletedOnce(b, mark, ['a.png', 'n.md']);
    await b.h.engine.stop();
  });

  it('a delete that joins one still reading the disk waits for it: one delete', async () => {
    const b = await seeded(['a.png']);
    const mark = since(b);
    removeFromDisk(b.h, ['a.png']);
    // The first handler has not read the disk yet when the second comes.
    const read = b.h.vault.gate('exists');
    const first = b.h.engine.handleVaultEvent(fileEvent('a.png', 'fs'));
    await read.reached;
    const second = b.h.engine.handleVaultEvent(fileEvent('a.png'));
    await flushAsync(10);
    expect(deletesSent(b, mark)).toEqual([]);
    read.release();
    await finish(b, [first, second]);

    expectDeletedOnce(b, mark, ['a.png']);
    await b.h.engine.stop();
  });

  it('a late chokidar unlink of a file of the folder: joined, not looked up in the listing', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'dir/c.png', 'dir/d.png']);
    const files = ['dir/a.png', 'dir/b.png', 'dir/c.png', 'dir/d.png'];
    const mark = since(b);
    removeFromDisk(b.h, files);
    const runs = dispatch(b.h, [folderEvent('dir')]);
    await flushAsync(2);
    runs.push(b.h.engine.handleVaultEvent(fileEvent('dir/b.png', 'fs')));
    await finish(b, runs);

    expectDeletedOnce(b, mark, files);
    expect(listings(b, mark)).toBe(0);
    await b.h.engine.stop();
  });

  it('offline: the queue gets one delete per file, and the server one each on connect', async () => {
    const b = await seeded(['dir/img.png', 'dir/a.md', 'dir/b.png', 'dir/sub/c.md']);
    const files = ['dir/img.png', 'dir/a.md', 'dir/b.png', 'dir/sub/c.md'];
    b.h.socket().disconnect();
    await flushAsync();
    const mark = since(b);
    removeFromDisk(b.h, files);
    const runs = dispatch(b.h, [
      fileEvent('dir/img.png'),
      fileEvent('dir/a.md'),
      fileEvent('dir/b.png'),
      folderEvent('dir/sub'),
      fileEvent('dir/sub/c.md'),
      folderEvent('dir'),
    ]);
    await finish(b, runs);
    const queued = b.h.log.dequeueOperations('b1');
    expect(queued.map((op) => `${op.opType} ${op.filePath}`).sort()).toEqual(
      files.map((p) => `DELETE ${p}`).sort(),
    );

    b.h.socket().connect();
    await flushAsync();
    (await joinToAnswer(b.h)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
    );
    await b.docs.drive();
    expect(deletesApplied(b, mark)).toEqual([...files].sort());
    expect(new Set(b.server.appliedOpIds).size).toBe(b.server.appliedOpIds.length);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    expect(live(b.server)).toEqual([]);
    await b.h.engine.stop();
  });

  it('stop() halfway through a folder: a file a teammate deleted meanwhile is not queued', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'dir/c.png']);
    const { h, server } = b;
    removeFromDisk(h, ['dir/a.png', 'dir/b.png', 'dir/c.png']);
    const run = h.engine.handleVaultEvent(folderEvent('dir'));
    await flushAsync(10);
    expect(h.socket().pending('file:delete').payload).toMatchObject({ filePath: 'dir/a.png' });
    // A teammate deletes `dir/b.png` before this device's turn for it comes.
    server.teammateDelete('f2');
    await flushAsync(10);
    expect(h.engine.getFileIdForPath('dir/b.png')).toBeNull();
    server.serveNext();
    await flushAsync(10);
    // `dir/c.png` is on its way when the engine stops.
    expect(h.socket().pending('file:delete').payload).toMatchObject({ filePath: 'dir/c.png' });

    await h.engine.stop();
    await run;
    expect(h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.filePath}`)).toEqual([
      'DELETE dir/c.png',
    ]);
  });

  it('stop() while the files’ own events wait for the folder’s deletes: each file queued once', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png', 'dir/c.md']);
    const { h } = b;
    const files = ['dir/a.png', 'dir/b.png', 'dir/c.md'];
    removeFromDisk(h, files);
    // The folder's event first, the files' after it: each joins the folder's.
    const runs = dispatch(h, [folderEvent('dir'), ...files.map((f) => fileEvent(f))]);
    await flushAsync(10);
    expect(h.socket().pending('file:delete').payload).toMatchObject({ filePath: 'dir/a.png' });

    await h.engine.stop();
    await Promise.allSettled(runs);
    expect(
      h.log
        .dequeueOperations('b1')
        .map((op) => `${op.opType} ${op.filePath}`)
        .sort(),
    ).toEqual(files.map((f) => `DELETE ${f}`).sort());
  });

  it('a delete it joined found the file still on disk: the folder deletes it after all', async () => {
    const b = await seeded(['dir/a.png', 'dir/b.png']);
    const { h } = b;
    const mark = since(b);
    // A stray `unlink` of `dir/a.png` (an atomic save) is read against the
    // disk just before the folder goes.
    const onDisk = deferred<void>();
    const exists = h.vault.exists.bind(h.vault);
    let first = true;
    h.vault.exists = async (path: string): Promise<boolean> => {
      if (!first || path !== 'dir/a.png') return exists(path);
      first = false;
      const was = h.vault.files.has(path);
      await onDisk.promise;
      return was;
    };
    const runs = [h.engine.handleVaultEvent(fileEvent('dir/a.png', 'fs'))];
    await flushAsync(5);
    removeFromDisk(h, ['dir/a.png', 'dir/b.png']);
    runs.push(h.engine.handleVaultEvent(folderEvent('dir')));
    await flushAsync(10);
    onDisk.resolve();
    await finish(b, runs);

    expectDeletedOnce(b, mark, ['dir/a.png', 'dir/b.png']);
    await h.engine.stop();
  });
});

// -- A large folder, its events in different orders ----------------------------

/** A folder of 30 attachments and 3 notes in `big/`, `big/s1/`, `big/s2/deep/`: Obsidian's listing order. */
function bigFolder(): { entries: string[]; files: string[] } {
  const entries: string[] = [];
  for (let i = 0; i < 10; i++) entries.push(`big/p${i}.png`);
  entries.push('big/top.md', 'big/s1/');
  for (let i = 0; i < 10; i++) entries.push(`big/s1/q${i}.png`);
  entries.push('big/s1/mid.md', 'big/s2/', 'big/s2/deep/');
  for (let i = 0; i < 10; i++) entries.push(`big/s2/deep/r${i}.png`);
  entries.push('big/s2/deep/low.md');
  return { entries, files: entries.filter((e) => !e.endsWith('/')) };
}

/** A step of a folder's deletion: an event, or the server answering what it has. */
type Step = VaultEvent | 'serve';

/** Obsidian's events for the folder: every entry in order, then the folder. */
function obsidianEvents(entries: readonly string[]): VaultEvent[] {
  return [
    ...entries.map((e) => (e.endsWith('/') ? folderEvent(e.slice(0, -1)) : fileEvent(e))),
    folderEvent('big'),
  ];
}

function chokidarEvents(files: readonly string[]): VaultEvent[] {
  return files.map((f) => fileEvent(f, 'fs'));
}

/** A shuffle of `items` fixed by `seed`. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const { entries: BIG, files: BIG_FILES } = bigFolder();

const ORDERS: Array<[name: string, steps: () => Step[], listed: boolean]> = [
  [
    'Obsidian’s order, chokidar after',
    () => [...obsidianEvents(BIG), ...chokidarEvents(BIG_FILES)],
    true,
  ],
  [
    'chokidar first for the first files, Obsidian’s order, chokidar for the rest',
    () => [
      ...chokidarEvents(BIG_FILES.slice(0, 12)),
      ...obsidianEvents(BIG),
      ...chokidarEvents(BIG_FILES.slice(12)),
    ],
    true,
  ],
  [
    'the folder first, then the files’ and chokidar’s in any order',
    () => [
      folderEvent('big'),
      ...shuffled([...obsidianEvents(BIG).slice(0, -1), ...chokidarEvents(BIG_FILES)], 7),
    ],
    true,
  ],
  ...[11, 23, 42].map((seed): [string, () => Step[], boolean] => [
    `any order, answers in between (seed ${seed})`,
    () =>
      shuffled(
        [
          ...obsidianEvents(BIG),
          ...chokidarEvents(BIG_FILES),
          ...Array.from({ length: 12 }, (): Step => 'serve'),
        ],
        seed,
      ),
    false,
  ]),
];

describe('SyncEngine — a large folder deleted, its events in different orders', () => {
  it.each(ORDERS)('%s: one delete per file', async (_name, steps, listed) => {
    const b = await seeded([...BIG_FILES, 'keep.md']);
    const mark = since(b);
    removeFromDisk(b.h, BIG_FILES);
    const runs: Array<Promise<void>> = [];
    for (const step of steps()) {
      if (step === 'serve') {
        b.server.serveNext();
        await flushAsync(3);
      } else {
        runs.push(b.h.engine.handleVaultEvent(step));
      }
    }
    await finish(b, runs);

    expectDeletedOnce(b, mark, BIG_FILES);
    // With every event in before the first answer, no file is looked up in
    // the listing. A chokidar `unlink` that comes after the file's delete was
    // answered still is — the FS watcher drops the ones Obsidian reported
    // shortly before, but not a late one — and finds nothing to delete.
    if (listed) expect(listings(b, mark)).toBe(0);
    expect(live(b.server)).toEqual(['keep.md']);
    expect(disk(b.h)).toEqual(['keep.md']);
    await b.h.engine.stop();
  });
});
