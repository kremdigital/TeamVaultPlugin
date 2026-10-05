/**
 * The server refuses a file operation `busy` (its project queue did not get
 * to it in time): it refuses every later file operation of the connection
 * too, until its queue has passed them, and expects them again in their
 * order, before anything new (`sync-protocol.md`, «Порядок операций одного
 * соединения»; `Project/server`, `files.ts`, `barLane`).
 *
 * Before: the refused operation went back to the queue and waited for the
 * next connect — hours, maybe — while every change made meanwhile went out at
 * once and overtook it. A note renamed onto the name of one whose delete was
 * refused, or a new "Untitled" made right after a refused rename of the last
 * one, found the name taken on the server and went to the whole team under a
 * conflict name.
 *
 * Now new changes wait in the queue behind the refused ones, and the queue is
 * tried again after a pause, without waiting for the next connect. The
 * engine runs against the {@link FakeServer}; `bar()` is the barrier.
 */
import { sha256Hex } from '@/sync/hash';
import { Logger, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  deferred,
  encode,
  flushAsync,
  joinToAnswer,
  joinsOf,
  json,
  markOf,
  expectQuietSince,
  type Emit,
  type Gate,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

// -- Helpers ------------------------------------------------------------------

type Seed = ReadonlyArray<readonly [path: string, fileId: string, content: string]>;

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  /** What the engine wrote to `sync.log`. */
  entries: LogEntry[];
  /** Every status the engine reported, as `status:detail`. */
  statuses: string[];
}

/**
 * Notes and attachments on disk, recorded and on the server; connected, the
 * catch-up done. The queue is tried again at once after `busy`; once stuck
 * after it, after `queueStuckRetryMs` (the engine's default when not given).
 */
async function online(
  notes: Seed,
  attachments: Seed = [],
  opts: { queueStuckRetryMs?: number } = {},
): Promise<Bench> {
  const entries: LogEntry[] = [];
  const logger = new Logger('debug', {
    write: (e) => {
      entries.push(e);
    },
  });
  const h = buildHarness({ logger, queueRetryMs: [0], ...opts });
  const server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
  const statuses: string[] = [];
  h.engine.onStatus((status, detail) => statuses.push(`${status}:${detail ?? ''}`));
  for (const [path, fileId, text] of notes) {
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
    await docs.add(fileId, path, text);
  }
  for (const [path, fileId, content] of attachments) {
    const data = encode(content);
    const hash = await sha256Hex(data);
    h.vault.files.set(path, data);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: path,
      serverFileId: fileId,
      contentHash: hash,
      size: data.byteLength,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    server.add({ id: fileId, path, fileType: 'BINARY', contentHash: hash, size: data.byteLength });
  }
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  return { h, server, docs, entries, statuses };
}

/** The socket connects again; the join, once sent, answered with the whole catch-up. */
async function reconnect(b: Bench): Promise<void> {
  b.h.socket().connect();
  await answerJoin(b);
}

async function answerJoin(b: Bench): Promise<void> {
  (await joinToAnswer(b.h)).ack(
    b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
  );
  await b.docs.drive();
}

function event(type: VaultEvent['type'], path: string): VaultEvent {
  return { bindingId: 'b1', type, path, source: 'obsidian' } as VaultEvent;
}

function folderEvent(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'delete', path, source: 'obsidian', isFolder: true };
}

function queue(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.newPath ? ` -> ${op.newPath}` : ''}`);
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

/** Every live file on the server, by path. */
function live(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => f.path)
    .sort();
}

/** The server applied each opId once. */
function appliedOnce(server: FakeServer): void {
  expect(new Set(server.appliedOpIds).size).toBe(server.appliedOpIds.length);
}

function emitsOf(h: Harness, event: string): Emit[] {
  return h.socket().emits.filter((e) => e.event === event);
}

function opIdOf(e: Emit): string {
  return (e.payload as { opId: string }).opId;
}

/** Wait until the socket has sent `count` of `event`; the last of them. */
async function emitted(h: Harness, event: string, count = 1): Promise<Emit> {
  await until(`${String(count)} ${event}`, () => emitsOf(h, event).length >= count);
  return emitsOf(h, event)[count - 1] as Emit;
}

/** Wait, in real time, until `done()` holds; fails after 10 s. */
async function until(what: string, done: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The user renames `from` in Obsidian; resolves once its rename is out, not
 * answered yet.
 */
async function renameOut(b: Bench, from: string, to: string): Promise<Emit> {
  const before = emitsOf(b.h, 'file:rename').length;
  await b.h.vault.rename(from, to);
  return emitted(b.h, 'file:rename', before + 1);
}

/**
 * The user renames `from` in Obsidian while new changes wait behind the
 * queue: resolves once its rename is queued, or — failing the test — sent.
 */
async function renameQueued(b: Bench, from: string, to: string): Promise<void> {
  const before = emitsOf(b.h, 'file:rename').length;
  await b.h.vault.rename(from, to);
  const entry = `RENAME ${from} -> ${to}`;
  await until(
    `${entry} queued`,
    () => queue(b.h).includes(entry) || emitsOf(b.h, 'file:rename').length > before,
  );
  expect(emitsOf(b.h, 'file:rename')).toHaveLength(before);
}

/** A few rounds of the event loop: a try of the queue would have gone out by then. */
async function aWhile(): Promise<void> {
  await flushAsync(60);
}

/** How long the engine waits for a streamed catch-up at most (`CATCHUP_TIMEOUT_MS`). */
const CATCHUP_GUARD_MS = 5 * 60 * 1000;

/**
 * The timers set for `ms`, held for the test to run (`held`) instead of
 * running out; every other timer runs as it does. `restore` ends the hold.
 */
function holdTimers(ms: number): { held: Array<() => void>; restore: () => void } {
  const held: Array<() => void> = [];
  const real = globalThis.setTimeout;
  const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void,
    delay?: number,
  ) => {
    if (delay !== ms) return real(handler, delay);
    held.push(handler);
    return 0;
  }) as unknown as typeof setTimeout);
  return { held, restore: () => spy.mockRestore() };
}

// -- New changes wait behind the refused ones ------------------------------------------

describe('SyncEngine — after busy, new changes wait behind the refused ones', () => {
  it('a delete refused busy: a rename onto its name waits for it, and the delete goes out again at once', async () => {
    const b = await online([
      ['x.md', 'f1', 'x\n'],
      ['y.md', 'f2', 'y\n'],
    ]);
    const mark = b.server.applied.length;
    const joins = joinsOf(b.h);
    b.server.bar();
    b.h.vault.files.delete('x.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'x.md'));
    const refused = await emitted(b.h, 'file:delete');
    expect(b.server.serveNext()).toBe(true);
    // Sent again without a connect, under its opId; not answered while the
    // server's queue is stuck.
    const again = await emitted(b.h, 'file:delete', 2);
    expect(opIdOf(again)).toBe(opIdOf(refused));
    await deleting;

    await renameQueued(b, 'y.md', 'x.md');
    expect(queue(b.h)).toEqual(['DELETE x.md', 'RENAME y.md -> x.md']);

    b.server.lift();
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['delete f1', 'f2 y.md -> x.md']);
    expect(live(b.server)).toEqual(['x.md']);
    expect(disk(b.h)).toEqual(['x.md=y\n']);
    expect(b.h.engine.getFileIdForPath('x.md')).toBe('f2');
    expect(queue(b.h)).toEqual([]);
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);
    expect(b.server.refusedBusy).toEqual([opIdOf(refused)]);
    expect(joinsOf(b.h)).toBe(joins);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('"Untitled": a new note made after its rename was refused waits for the rename', async () => {
    const b = await online([['Untitled.md', 'f1', 'draft\n']]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'Untitled.md', 'Title.md');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 2);

    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await until(
      'the create queued',
      () => queue(b.h).includes('CREATE Untitled.md') || b.h.socket().created().length > 0,
    );
    expect(b.h.socket().created()).toEqual([]);
    expect(queue(b.h)).toEqual(['RENAME Untitled.md -> Title.md', 'CREATE Untitled.md']);

    b.server.lift();
    await b.server.pump();
    await creating;
    await b.h.settle();
    await b.docs.drive();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 Untitled.md -> Title.md',
      'create Untitled.md',
    ]);
    expect(live(b.server)).toEqual(['Title.md', 'Untitled.md']);
    expect(disk(b.h)).toEqual(['Title.md=draft\n', 'Untitled.md=new\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('tries again while the server stays busy; once through, new changes go out at once again', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
      ['e.md', 'f3', 'e\n'],
      ['g.md', 'f4', 'g\n'],
    ]);
    const mark = b.server.applied.length;
    b.server.bar();
    const refused = await renameOut(b, 'a.md', 'b.md');
    expect(b.server.serveNext()).toBe(true);
    // Sent again without a connect, under its opId, and refused again.
    expect(opIdOf(await emitted(b.h, 'file:rename', 2))).toBe(opIdOf(refused));
    expect(b.statuses[b.statuses.length - 1]).toBe('connected:server_busy');
    await renameQueued(b, 'c.md', 'd.md');
    expect(b.server.serveNext()).toBe(true);
    expect(opIdOf(await emitted(b.h, 'file:rename', 3))).toBe(opIdOf(refused));
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 4);
    await renameQueued(b, 'e.md', 'f.md');
    expect(queue(b.h)).toEqual([
      'RENAME a.md -> b.md',
      'RENAME c.md -> d.md',
      'RENAME e.md -> f.md',
    ]);
    expect(b.server.applied.slice(mark)).toEqual([]);

    b.server.lift();
    await b.server.pump();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 a.md -> b.md',
      'f2 c.md -> d.md',
      'f3 e.md -> f.md',
    ]);
    expect(queue(b.h)).toEqual([]);
    expect(b.statuses[b.statuses.length - 1]).toBe('connected:');
    expect(b.h.engine.getStatus()).toBe('connected');

    // Sent at once, not queued.
    await renameOut(b, 'g.md', 'h.md');
    expect(queue(b.h)).toEqual([]);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark + 3)).toEqual(['f4 g.md -> h.md']);
    expect(b.entries.filter((e) => e.level === 'warn').map((e) => e.message)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a replay of the queue that sends another operation sends it in its place, not behind the new changes', async () => {
    const b = await online([
      ['x.md', 'f1', 'x\n'],
      ['y.md', 'f2', 'y\n'],
    ]);
    const mark = b.server.applied.length;
    // A note moved to Obsidian's trash, queued by a build that took it for a
    // rename: the replay sends the delete it is (see `replayPending`).
    b.h.vault.move('x.md', '.trash/x.md');
    b.h.log.enqueueOperation('b1', {
      opType: 'RENAME',
      filePath: 'x.md',
      newPath: '.trash/x.md',
      payload: { fileId: 'f1' },
    });
    b.server.bar(1);
    await renameOut(b, 'y.md', 'w.md');
    expect(b.server.serveNext()).toBe(true);
    await until('the rename refused', () => queue(b.h).length === 2);
    expect(queue(b.h)).toEqual(['RENAME x.md -> .trash/x.md', 'RENAME y.md -> w.md']);

    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['delete f1', 'f2 y.md -> w.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('an answer to a question goes out at once while new changes wait behind the queue', async () => {
    const b = await online([
      ['Plan.md', 'f1', 'old\n'],
      ['a.md', 'f2', 'a\n'],
    ]);
    b.h.socket().disconnect();
    await flushAsync();
    b.h.vault.files.set('Plan.md', encode('old\nmine\n'));
    await b.h.engine.handleVaultEvent(event('modify', 'Plan.md'));
    await flushAsync(20);
    b.server.teammateDelete('f1');
    await reconnect(b);
    await until('the question about the copy', () =>
      b.h.calls.includes('modal.resolveDeleteConflict'),
    );
    b.server.bar(1);
    await renameOut(b, 'a.md', 'b.md');
    expect(b.server.serveNext()).toBe(true);
    await until('the rename refused', () => queue(b.h).includes('RENAME a.md -> b.md'));

    // **Restore on server**: never replayed from the queue, so it is not put
    // there behind the refused rename either.
    b.h.modal.del.resolve('restore-server');
    await emitted(b.h, 'file:create');
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md']);

    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    expect(live(b.server)).toEqual(['Plan.md', 'b.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});

// -- A folder deleted -------------------------------------------------------------------

describe('SyncEngine — a folder whose delete is cut short halfway', () => {
  const FILES = ['dir/1.md', 'dir/2.md', 'dir/3.md', 'dir/4.md', 'dir/5.md'];

  async function folder(): Promise<Bench> {
    return online([
      ...FILES.map((p, i) => [p, `f${i + 1}`, `${p}\n`] as const),
      ['keep.md', 'f9', 'k\n'],
    ]);
  }

  /**
   * The folder deleted in Obsidian; resolves once its second delete is out,
   * with its handler (wrapped: a promise returned as is would be waited for).
   */
  async function deleteFolder(b: Bench): Promise<{ deleting: Promise<void> }> {
    for (const path of FILES) b.h.vault.files.delete(path);
    const deleting = b.h.engine.handleVaultEvent(folderEvent('dir'));
    await emitted(b.h, 'file:delete');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:delete', 2);
    return { deleting };
  }

  /** The DELETEs the server applied, in order. */
  function deletesApplied(b: Bench): string[] {
    return b.server.journal.filter((row) => row.opType === 'DELETE').map((row) => row.filePath);
  }

  function expectAllDeleted(b: Bench): void {
    expect(deletesApplied(b)).toEqual(FILES);
    expect(live(b.server)).toEqual(['keep.md']);
    expect(disk(b.h)).toEqual(['keep.md=k\n']);
    for (const path of FILES) expect(b.h.engine.getFileIdForPath(path)).toBeNull();
    expect(queue(b.h)).toEqual([]);
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);
    appliedOnce(b.server);
  }

  it('the second delete refused busy: the rest wait in the queue in order, and all go out', async () => {
    const b = await folder();
    const { deleting } = await deleteFolder(b);
    b.server.bar(1);
    expect(b.server.serveNext()).toBe(true);
    await deleting;
    await b.server.pump();
    await b.h.settle();
    expectAllDeleted(b);
    await b.h.engine.stop();
  });

  it('the connection lost at the second delete: the rest wait in the queue in order for the next connect', async () => {
    const b = await folder();
    const { deleting } = await deleteFolder(b);
    b.h.socket().disconnect();
    await deleting;
    expect(queue(b.h)).toEqual(FILES.slice(1).map((p) => `DELETE ${p}`));
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);

    await reconnect(b);
    await b.server.pump();
    await b.h.settle();
    expectAllDeleted(b);
    await b.h.engine.stop();
  });
});

// -- When the queue is tried again ---------------------------------------------------------

describe('SyncEngine — when the queue is tried again after busy', () => {
  it('waits for the changes still on their way: one refused late goes out in its place', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
      ['e.md', 'f3', 'e\n'],
    ]);
    const mark = b.server.applied.length;
    await renameOut(b, 'a.md', 'b.md');
    const late = await renameOut(b, 'c.md', 'd.md');
    await renameOut(b, 'e.md', 'f.md');
    // The server refused all three; the answer of the second is late — past
    // the pause before the next try.
    b.server.delay(late);
    b.server.bar(2);
    expect(b.server.serveNext()).toBe(true);
    expect(b.server.serveNext()).toBe(true);
    await b.server.pump();
    await aWhile();
    expect(emitsOf(b.h, 'file:rename')).toHaveLength(3);

    late.ack({ ok: false, error: 'busy' });
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 a.md -> b.md',
      'f2 c.md -> d.md',
      'f3 e.md -> f.md',
    ]);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('not while connecting: the connect sends the queue once its catch-up is done', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
    ]);
    const mark = b.server.applied.length;
    b.h.socket().disconnect();
    b.h.socket().connect();
    const join = await joinToAnswer(b.h);
    await flushAsync(20);
    b.server.bar(1);
    await renameOut(b, 'a.md', 'b.md');
    expect(b.server.serveNext()).toBe(true);
    await aWhile();
    expect(emitsOf(b.h, 'file:rename')).toHaveLength(1);
    await renameQueued(b, 'c.md', 'd.md');
    await aWhile();
    expect(emitsOf(b.h, 'file:rename')).toHaveLength(1);
    expect(b.h.engine.getStatus()).toBe('syncing');

    join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
    await b.docs.drive();
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md', 'f2 c.md -> d.md']);
    expect(queue(b.h)).toEqual([]);
    expect(b.h.engine.getStatus()).toBe('connected');
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('busy in the connect’s drain: the first upload queues its new files behind the refused', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.h.socket().disconnect();
    await b.h.vault.rename('a.md', 'b.md');
    await b.h.settle();
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md']);
    b.h.vault.files.set('new.md', encode('new\n'));
    b.server.bar();
    b.h.socket().connect();
    (await joinToAnswer(b.h)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
    );
    // `ops:status` is not refused; the rename the drain sends is.
    expect(b.server.statusAnswers.map((a) => a.voided.length)).toEqual([1]);
    await emitted(b.h, 'file:rename');
    expect(b.server.serveNext()).toBe(true);
    await until('the new file queued', () => queue(b.h).includes('CREATE new.md'));
    expect(b.h.socket().created()).toEqual([]);

    b.server.lift();
    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md', 'create new.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('the connect waits for a try of the queue held up in an upload, and sends the queue before its first upload', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    const mark = b.server.applied.length;
    b.server.bar(1);
    b.h.vault.files.set('img.png', encode('v2'));
    const modifying = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    await emitted(b.h, 'file:update-binary');
    const upload = deferred<void>();
    const uploads = (): number => b.h.requests.filter((r) => r.method === 'PUT').length;
    const before = uploads();
    b.h.routes.set('PUT /blobs', async () => {
      await upload.promise;
      return json({ ok: true });
    });
    expect(b.server.serveNext()).toBe(true);
    await modifying;
    await until('the try’s upload', () => uploads() === before + 1);

    b.h.vault.files.set('new.md', encode('new\n'));
    b.h.socket().disconnect();
    await reconnect(b);
    await aWhile();
    expect(b.h.socket().created()).toEqual([]);
    expect(emitsOf(b.h, 'file:update-binary')).toHaveLength(1);

    upload.resolve();
    await emitted(b.h, 'file:update-binary', 2);
    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    expect(b.server.applied.slice(mark)).toEqual(['update f2', 'create new.md']);
    expect(queue(b.h)).toEqual([]);
    // The try of the connection gone sent nothing on the new one.
    expect(emitsOf(b.h, 'file:update-binary')).toHaveLength(2);
    appliedOnce(b.server);
    // New changes go out at once.
    await renameOut(b, 'a.md', 'b.md');
    expect(queue(b.h)).toEqual([]);
    await b.server.pump();
    await b.h.settle();
    await b.h.engine.stop();
  });

  it('halted by another error three tries in a row: new changes go out again, and the queue is tried again after a long pause', async () => {
    const stuckRetryMs = 1_234_567;
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']], {
      queueStuckRetryMs: stuckRetryMs,
    });
    const mark = b.server.applied.length;
    const joins = joinsOf(b.h);
    const later = holdTimers(stuckRetryMs);
    try {
      b.server.bar(1);
      b.h.vault.files.set('img.png', encode('v2'));
      const modifying = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
      await emitted(b.h, 'file:update-binary');
      const uploads = (): number => b.h.requests.filter((r) => r.method === 'PUT').length;
      const before = uploads();
      b.h.routes.set('PUT /blobs', () => json({ error: 'unavailable' }, 503));
      expect(b.server.serveNext()).toBe(true);
      await modifying;
      const warnings = (): string[] =>
        b.entries.filter((e) => e.level === 'warn').map((e) => e.message);
      const gaveUp = (): boolean =>
        warnings().some((m) => m.startsWith('queue drain halted after busy'));
      await until('the warning', gaveUp);
      expect(uploads() - before).toBe(3);

      await renameOut(b, 'a.md', 'b.md');
      expect(queue(b.h)).toEqual(['UPDATE img.png']);
      await b.server.pump();
      await b.h.settle();
      expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md']);
      expect(queue(b.h)).toEqual(['UPDATE img.png']);

      // Tried again after the long pause, without a connect: still failing,
      // and again after the next one — through by then.
      await until('the next try set', () => later.held.length === 1);
      const warned = warnings().length;
      later.held[0]?.();
      await until('the next try set again', () => later.held.length === 2);
      expect(uploads() - before).toBe(4);
      expect(queue(b.h)).toEqual(['UPDATE img.png']);
      // Said once, when new changes stopped waiting.
      expect(warnings()).toHaveLength(warned);
      b.h.routes.set('PUT /blobs', () => json({ ok: true }));
      later.held[1]?.();
      await b.server.pump();
      await b.h.settle();
      expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md', 'update f2']);
      expect(queue(b.h)).toEqual([]);
      expect(later.held).toHaveLength(2);
      expect(
        b.entries.filter((e) => e.message === 'queued changes held up after busy sent'),
      ).toHaveLength(1);
      expect(joinsOf(b.h)).toBe(joins);
      appliedOnce(b.server);
      await b.h.engine.stop();
    } finally {
      later.restore();
    }
  });

  it('stuck after busy, and busy again: new changes wait behind the queue again, tried after the short pauses', async () => {
    const stuckRetryMs = 1_234_567;
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']], {
      queueStuckRetryMs: stuckRetryMs,
    });
    const mark = b.server.applied.length;
    const later = holdTimers(stuckRetryMs);
    try {
      b.server.bar(1);
      b.h.vault.files.set('img.png', encode('v2'));
      const modifying = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
      await emitted(b.h, 'file:update-binary');
      b.h.routes.set('PUT /blobs', () => json({ error: 'unavailable' }, 503));
      expect(b.server.serveNext()).toBe(true);
      await modifying;
      await until('the long pause', () => later.held.length === 1);

      // The server is back; a change refused busy on its way.
      b.h.routes.set('PUT /blobs', () => json({ ok: true }));
      b.server.bar(1);
      await renameOut(b, 'a.md', 'b.md');
      expect(b.server.serveNext()).toBe(true);
      await b.server.pump();
      await b.h.settle();
      expect(b.server.applied.slice(mark)).toEqual(['update f2', 'f1 a.md -> b.md']);
      expect(queue(b.h)).toEqual([]);
      // Not after the long pause.
      expect(later.held).toHaveLength(1);
      appliedOnce(b.server);
      await b.h.engine.stop();
    } finally {
      later.restore();
    }
  });

  it('changes that keep coming faster than the queue goes out: new ones go out again, and the queue after them', async () => {
    const b = await online([['n0.md', 'f1', 'n\n']]);
    b.server.bar(1);
    await renameOut(b, 'n0.md', 'n1.md');
    expect(b.server.serveNext()).toBe(true);
    // While each pass of the drain waits for its answer, a rename more here:
    // the next pass finds it queued behind.
    const capped = (): boolean =>
      b.entries.some((e) => e.level === 'warn' && e.message.startsWith('changes keep coming'));
    let n = 1;
    let served = 1;
    for (let pass = 0; pass < 100 && !capped(); pass++) {
      await until(
        'the drain’s rename',
        () => emitsOf(b.h, 'file:rename').length > served || capped(),
      );
      if (capped()) break;
      await renameQueued(b, `n${String(n)}.md`, `n${String(n + 1)}.md`);
      n += 1;
      expect(b.server.serveNext()).toBe(true);
      served += 1;
    }
    expect(capped()).toBe(true);
    // Sent at once from here on, and the queue goes out after.
    await b.server.pump(500);
    await b.h.settle();
    await b.server.pump(500);
    expect(queue(b.h)).toEqual([]);
    expect(live(b.server)).toEqual([`n${String(n)}.md`]);
    expect(disk(b.h)).toEqual([`n${String(n)}.md=n\n`]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});

// -- The connect and the drain of a connection gone ----------------------------------------

describe('SyncEngine — the connect and the drain of a connection gone', () => {
  it('a catch-up cut short by the connection dropping ends with it: the next connect’s catch-up and queue are its own', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
    ]);
    const mark = b.server.applied.length;
    const guards = holdTimers(CATCHUP_GUARD_MS);
    try {
      // The server announces a streamed catch-up; the connection drops before its end.
      b.h.socket().disconnect();
      b.h.socket().connect();
      (await joinToAnswer(b.h)).ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
      await until('the first catch-up', () => guards.held.length === 1);
      b.h.vault.files.set('new.md', encode('new\n'));
      b.h.socket().disconnect();
      b.h.socket().connect();
      (await joinToAnswer(b.h)).ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
      await until('the second catch-up', () => guards.held.length === 2);

      // The first connect's guard runs out, its stream long gone.
      guards.held[0]?.();
      await aWhile();
      expect(b.h.engine.getStatus()).toBe('syncing');
      expect(b.h.socket().created()).toEqual([]);
      // A change refused busy meanwhile waits behind the queue, which the
      // second connect sends once its catch-up is done.
      b.server.bar(1);
      await renameOut(b, 'a.md', 'b.md');
      expect(b.server.serveNext()).toBe(true);
      await aWhile();
      expect(emitsOf(b.h, 'file:rename')).toHaveLength(1);

      b.h.socket().fire('yjs:catchup', { projectId: 'p1', docs: [], done: true });
      await until('connected', () => b.h.engine.getStatus() === 'connected');
      await b.server.pump();
      await b.h.settle();
      await b.docs.drive();
      expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md', 'create new.md']);
      expect(queue(b.h)).toEqual([]);
      appliedOnce(b.server);
      await b.h.engine.stop();
    } finally {
      guards.restore();
    }
  });

  it('a drain cut short by the connection dropping uploads nothing after it: the next connect sends the queue first', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    const mark = b.server.applied.length;
    b.h.socket().disconnect();
    await flushAsync();
    b.h.vault.files.set('img.png', encode('v2'));
    await b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    expect(queue(b.h)).toEqual(['UPDATE img.png']);
    b.h.vault.files.set('new.md', encode('new\n'));
    // The upload of each connect's drain, held.
    const held = [deferred<void>(), deferred<void>()];
    let uploads = 0;
    b.h.routes.set('PUT /blobs', async () => {
      const upload = held[uploads];
      uploads += 1;
      await upload?.promise;
      return json({ ok: true });
    });
    await reconnect(b);
    await until('the first drain’s upload', () => uploads === 1);
    b.h.socket().disconnect();
    await reconnect(b);

    held[0]?.resolve();
    await until('the second drain’s upload', () => uploads === 2);
    await aWhile();
    // Nothing of the first connect's tail on this connection.
    expect(b.h.socket().created()).toEqual([]);
    expect(emitsOf(b.h, 'file:update-binary')).toHaveLength(0);

    held[1]?.resolve();
    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    expect(b.server.applied.slice(mark)).toEqual(['update f2', 'create new.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a replay of a connection gone that sends another operation sends nothing on the next one', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    const mark = b.server.applied.length;
    b.h.socket().disconnect();
    await flushAsync();
    // A create of a file the server has, queued offline (a checkout rewrote
    // it): the replay sends it as an update of that file, after its upload.
    b.h.vault.files.set('img.png', encode('v2'));
    b.h.log.enqueueOperation('b1', {
      opType: 'CREATE',
      filePath: 'img.png',
      payload: { fileType: 'BINARY' },
    });
    const upload = deferred<void>();
    let uploads = 0;
    b.h.routes.set('PUT /blobs', async () => {
      uploads += 1;
      if (uploads === 1) await upload.promise;
      return json({ ok: true });
    });
    await reconnect(b);
    await until('the replay’s upload', () => uploads === 1);
    b.h.socket().disconnect();
    b.h.socket().connect();
    const join = await joinToAnswer(b.h);

    upload.resolve();
    await aWhile();
    // Not on the new connection, ahead of its catch-up and its drain; the
    // queue entry it came from is what stays.
    expect(emitsOf(b.h, 'file:update-binary')).toHaveLength(0);
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);
    expect(queue(b.h)).toEqual(['CREATE img.png']);

    join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
    await b.docs.drive();
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['update f2']);
    expect(emitsOf(b.h, 'file:update-binary')).toHaveLength(1);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});

// -- Pause sync and stop ------------------------------------------------------------------

describe('SyncEngine — Pause sync and stop while the queue is tried again', () => {
  it('stop: nothing goes out after it, and the changes wait in the queue in order', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
    ]);
    await renameOut(b, 'a.md', 'b.md');
    const late = await renameOut(b, 'c.md', 'd.md');
    b.server.delay(late);
    b.server.bar(1);
    expect(b.server.serveNext()).toBe(true);
    await aWhile();
    await b.h.engine.stop();
    const mark = markOf(b.h);
    await aWhile();
    expectQuietSince(b.h, mark);
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md', 'RENAME c.md -> d.md']);
  });

  it('Pause sync and Resume sync: the connect sends the refused first, under new ids, and new changes go out at once again', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
      ['e.md', 'f3', 'e\n'],
    ]);
    const mark = b.server.applied.length;
    b.server.bar();
    const refused = await renameOut(b, 'a.md', 'b.md');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 2);
    await renameQueued(b, 'c.md', 'd.md');

    b.h.engine.pause();
    b.server.lift();
    await b.h.engine.resume();
    await answerJoin(b);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md', 'f2 c.md -> d.md']);
    expect(b.server.appliedOpIds).not.toContain(opIdOf(refused));
    expect(queue(b.h)).toEqual([]);

    await renameOut(b, 'e.md', 'f.md');
    expect(queue(b.h)).toEqual([]);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark + 2)).toEqual(['f3 e.md -> f.md']);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});

// -- A new file waiting behind the queue holds its name --------------------------------------

describe('SyncEngine — a new file waiting behind the queue holds its name here', () => {
  /**
   * `notes` synced; the server refuses the rename of `a.md` busy, and each
   * try of it after, the try on its way; the user's new note `Untitled.md`
   * queued behind it.
   */
  async function queuedNewNote(notes: Seed): Promise<Bench> {
    const b = await online([['a.md', 'f1', 'a\n'], ...notes]);
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 2);
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);
    return b;
  }

  /**
   * `path` holds `text` on this disk: the engine's `yjs:fetch` answered as
   * it asks, while the server's queue stays stuck.
   */
  async function writtenHere(b: Bench, path: string, text: string): Promise<void> {
    await until(`${path} written`, () => {
      b.docs.answerFetches();
      return b.h.vault.text(path) === text;
    });
  }

  /** The server's queue moves again; everything answered, the notes' texts in. */
  async function through(b: Bench): Promise<void> {
    b.server.lift();
    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    await b.h.settle();
  }

  /** The project's listing, as the engine reads it from the server. */
  const LISTING = 'GET /api/projects/p1/files';

  /** How many times the engine has read {@link LISTING} since request `from`. */
  function listingsSince(b: Bench, from: number): number {
    return b.h.requests.slice(from).filter((r) => `${r.method} ${r.path}` === LISTING).length;
  }

  /** {@link LISTING} held on its way: `asked` once requested, answered when `answer` is called. */
  function holdListing(b: Bench): { asked: Promise<void>; answer: () => void } {
    const list = b.h.routes.get(LISTING);
    if (list === undefined) throw new Error('no listing route');
    const asked = deferred<void>();
    const answered = deferred<void>();
    b.h.routes.set(LISTING, async () => {
      asked.resolve();
      await answered.promise;
      return list();
    });
    return { asked: asked.promise, answer: () => answered.resolve() };
  }

  /**
   * The engine logs this when a delete waits for the create of its name under
   * way (see `sendLocalDelete`).
   */
  const WAITS_FOR_CREATE = 'local delete: waits for the create of the name under way';

  /**
   * The engine logs this when a teammate's file the server has under the name
   * of a new file here waits for it (see `applyServerCreate`).
   */
  const THEIRS_WAITS = 'a file the server has under a name being created here waits for it';

  /** Whether the engine wrote `message` to `sync.log`. */
  function logged(b: Bench, message: string): boolean {
    return b.entries.some((e) => e.message === message);
  }

  /**
   * The user deletes `path` in Obsidian. Resolves once its handler is done or
   * waits for the create of the name under way; `handled` resolves when the
   * handler is done.
   */
  async function deleteHere(b: Bench, path: string): Promise<{ handled: Promise<void> }> {
    b.h.vault.files.delete(path);
    let done = false;
    const handled = b.h.engine.handleVaultEvent(event('delete', path)).finally(() => {
      done = true;
    });
    await until(
      `the delete of ${path} handled, or waiting`,
      () => done || logged(b, WAITS_FOR_CREATE),
    );
    return { handled };
  }

  /**
   * Wait for `handled`, the server answering what the engine sends meanwhile:
   * a delete goes out at once or behind the queue, as the gate is then.
   */
  async function served(b: Bench, handled: Promise<void>): Promise<void> {
    let done = false;
    const end = (): void => {
      done = true;
    };
    void handled.then(end, end);
    await until('the handler done', () => {
      b.server.serveNext();
      return done;
    });
    await handled;
  }

  /** The id of the live file the server has under `path`. */
  function liveAt(server: FakeServer, path: string): string {
    const file = [...server.files.values()].find((f) => f.path === path && !f.deleted);
    if (file === undefined) throw new Error(`no live file at ${path}`);
    return file.id;
  }

  /** A teammate's new note under `path`, made over REST: listed, its broadcast not here yet. */
  async function listedOnly(b: Bench, id: string, path: string): Promise<void> {
    const text = encode('theirs\n');
    b.server.add({
      id,
      path,
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: text.byteLength,
    });
  }

  /** The next start: a new engine on the same vault, log and docs; connected, the catch-up done. */
  async function restart(b: Bench): Promise<Bench> {
    const logger = new Logger('debug', {
      write: (e) => {
        b.entries.push(e);
      },
    });
    const h = buildHarness({ predecessor: b.h, logger, queueRetryMs: [0] });
    b.server.attach(h);
    b.docs.attach(h);
    const next = { ...b, h };
    await h.engine.start();
    await answerJoin(next);
    return next;
  }

  /**
   * The next read of `path`: read as the disk is then, the bytes held back
   * until released. The file may be gone meanwhile.
   */
  function holdRead(h: Harness, path: string): Gate {
    const read = h.vault.readBinary.bind(h.vault);
    const reached = deferred<void>();
    const open = deferred<void>();
    const spy = jest.spyOn(h.vault, 'readBinary').mockImplementation(async (p: string) => {
      const data = await read(p);
      if (p !== path) return data;
      spy.mockRestore();
      reached.resolve();
      await open.promise;
      return data;
    });
    return { reached: reached.promise, release: () => open.resolve() };
  }

  /**
   * The next look at whether `path` is on disk, after `skip` of them: answered
   * as the disk is then, the answer held back until released. The file may
   * be back meanwhile.
   */
  function holdAnswer(h: Harness, path: string, skip = 0): Gate {
    const exists = h.vault.exists.bind(h.vault);
    const reached = deferred<void>();
    const open = deferred<void>();
    let left = skip;
    const spy = jest.spyOn(h.vault, 'exists').mockImplementation(async (p: string) => {
      const found = await exists(p);
      if (p !== path) return found;
      if (left > 0) {
        left -= 1;
        return found;
      }
      spy.mockRestore();
      reached.resolve();
      await open.promise;
      return found;
    });
    return { reached: reached.promise, release: () => open.resolve() };
  }

  it('a teammate’s new note under its name waits; renamed here, ours goes out as a create, not as a rename of theirs', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    // Not taken for the note on this disk.
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

    await b.h.vault.rename('Untitled.md', 'Title.md');
    await until('the rename handled', () => queue(b.h).some((e) => e.includes('Title.md')));
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Title.md']);
    // The name is free here now: the teammate's note comes in.
    await writtenHere(b, 'Untitled.md', 'theirs\n');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      'create Title.md',
    ]);
    expect(b.server.pathOf(theirs)).toBe('Untitled.md');
    expect(live(b.server)).toEqual(['Title.md', 'Untitled.md', 'z.md']);
    expect(disk(b.h)).toEqual(['Title.md=mine\n', 'Untitled.md=theirs\n', 'z.md=a\n']);
    expect(b.docs.text(b.h.engine.getFileIdForPath('Title.md') ?? '')).toBe('mine\n');
    expect(b.docs.text(theirs)).toBe('theirs\n');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a teammate’s new note under its name waits; deleted here, ours sends no delete of theirs', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    expect(queue(b.h).filter((e) => e.startsWith('DELETE'))).toEqual([]);
    // The name is free here now: the teammate's note comes in.
    await writtenHere(b, 'Untitled.md', 'theirs\n');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(b.docs.text(theirs)).toBe('theirs\n');
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted here before a teammate’s new note comes under its name: theirs comes in as the queue goes out', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('created again under its name while its delete is on its way: the new one holds the name', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['n/keep.md', 'f2', 'k\n'],
    ]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 2);
    b.h.vault.files.set('n/U.md', encode('first\n'));
    await b.h.engine.handleVaultEvent(event('create', 'n/U.md'));
    const theirs = await b.server.teammateCreate('n/U.md', 'theirs\n');
    await aWhile();
    expect(b.h.engine.getFileIdForPath('n/U.md')).toBeNull();

    // Deleted; its delete is held at the check of its folder (the file's own
    // check has found it gone), and the user makes a new note there.
    const folderCheck = b.h.vault.gate('exists', 1);
    b.h.vault.files.delete('n/U.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'n/U.md'));
    await folderCheck.reached;
    b.h.vault.files.set('n/U.md', encode('again\n'));
    await b.h.engine.handleVaultEvent(event('create', 'n/U.md'));
    folderCheck.release();
    await deleting;
    // Not taken for the new note on this disk.
    expect(b.h.engine.getFileIdForPath('n/U.md')).toBeNull();

    await b.h.vault.rename('n/U.md', 'n/Title.md');
    await until('the rename handled', () => !queue(b.h).some((e) => e.includes('n/U.md')));
    await through(b);
    expect(b.server.applied.slice(mark)).toEqual([
      'create n/U.md',
      'f1 a.md -> z.md',
      'create n/Title.md',
    ]);
    expect(b.server.pathOf(theirs)).toBe('n/U.md');
    expect(disk(b.h)).toEqual([
      'n/Title.md=again\n',
      'n/U.md=theirs\n',
      'n/keep.md=k\n',
      'z.md=a\n',
    ]);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a teammate’s rename onto its name waits for our create, which the server stores under a conflict name', async () => {
    const b = await queuedNewNote([['Other.md', 'f2', 'other\n']]);
    const mark = b.server.applied.length;
    b.server.teammateRename('f2', 'Untitled.md');
    await aWhile();
    // Ours stays under its name, and theirs where it was, for now.
    expect(disk(b.h)).toEqual(['Other.md=other\n', 'Untitled.md=mine\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Other.md')).toBe('f2');

    await through(b);
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([
      'f2 Other.md -> Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
    ]);
    expect(live(b.server)).toEqual([aside, 'Untitled.md', 'z.md']);
    expect(disk(b.h)).toEqual([`${aside}=mine\n`, 'Untitled.md=other\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe('f2');
    expect(b.docs.text(b.h.engine.getFileIdForPath(aside) ?? '')).toBe('mine\n');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted here while a teammate’s new note comes under its name: the server is not asked for the name, and nothing of theirs is deleted', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const read = b.h.requests.length;
    // Should the delete read the listing, the teammate's note comes while it
    // is on its way: out of the index here, waiting for the name.
    const list = b.h.routes.get(LISTING);
    let theirs: Promise<string> | null = null;
    const teammateNote = (): Promise<string> =>
      (theirs ??= b.server.teammateCreate('Untitled.md', 'theirs\n'));
    b.h.routes.set(LISTING, async () => {
      await teammateNote();
      await aWhile();
      if (list === undefined) throw new Error('no listing route');
      return list();
    });

    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    const id = await teammateNote();
    await aWhile();
    // The file deleted here is the new note whose create waits in the queue:
    // the server has never heard of it, and the file it has under the name is
    // another one.
    expect(listingsSince(b, read)).toBe(0);
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(b.server.pathOf(id)).toBe('Untitled.md');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(id);
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted here while the server lists a teammate’s note under its name, not announced yet: no delete of it', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const text = encode('theirs\n');
    b.server.add({
      id: 's9',
      path: 'Untitled.md',
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: text.byteLength,
    });

    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> z.md']);
    expect(b.server.pathOf('s9')).toBe('Untitled.md');
    expect(disk(b.h)).toEqual(['z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('created, turned away busy while its delete waits for it, a teammate’s new note under its name meanwhile: no delete of theirs', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    // A new note goes out while the rename is on its way, not answered yet.
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    // Deleted: nothing is recorded under the name, and its create is on its
    // way — the delete waits for it. Should it read the listing, the listing
    // is held.
    const read = b.h.requests.length;
    const listing = holdListing(b);
    let asked = false;
    void listing.asked.then(() => {
      asked = true;
    });
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await until('the delete waits for the create', () => asked || logged(b, WAITS_FOR_CREATE));
    // A teammate's new note under the name waits for ours.
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

    // The server turns the rename away busy, and then the create: the rename
    // goes out again, and the create waits in the queue behind it.
    expect(b.server.serveNext()).toBe(true);
    await until('the rename queued', () => queue(b.h).includes('RENAME a.md -> z.md'));
    expect(b.server.serveNext()).toBe(true);
    await creating;
    await emitted(b.h, 'file:rename', 2);
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);

    // The listing, if asked, has it under the name.
    listing.answer();
    await deleting;
    expect(listingsSince(b, read)).toBe(0);
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);
    // The name is free here now: the teammate's note comes in.
    await writtenHere(b, 'Untitled.md', 'theirs\n');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(b.docs.text(theirs)).toBe('theirs\n');
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a teammate’s rename onto its name waits; deleted here then, theirs moves in at once', async () => {
    const b = await queuedNewNote([['Other.md', 'f2', 'other\n']]);
    const mark = b.server.applied.length;
    b.server.teammateRename('f2', 'Untitled.md');
    await aWhile();
    expect(disk(b.h)).toEqual(['Other.md=other\n', 'Untitled.md=mine\n', 'z.md=a\n']);

    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    // Ours never reached the server: nothing of it goes out, and the name is
    // free here.
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);
    expect(disk(b.h)).toEqual(['Untitled.md=other\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe('f2');

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['f2 Other.md -> Untitled.md', 'f1 a.md -> z.md']);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(disk(b.h)).toEqual(['Untitled.md=other\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe('f2');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted here before a teammate’s rename onto its name: theirs moves in as the queue goes out', async () => {
    const b = await queuedNewNote([['Other.md', 'f2', 'other\n']]);
    const mark = b.server.applied.length;
    b.h.vault.files.delete('Untitled.md');
    await b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    b.server.teammateRename('f2', 'Untitled.md');
    await aWhile();

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['f2 Other.md -> Untitled.md', 'f1 a.md -> z.md']);
    expect(disk(b.h)).toEqual(['Untitled.md=other\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe('f2');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('created again under its name while the disk is read to let the name go: the new one holds it', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

    // Deleted; the look that lets the name go (after the delete's own) finds
    // it free, and the user makes a new note there before the answer is in.
    const look = holdAnswer(b.h, 'Untitled.md', 1);
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await look.reached;
    b.h.vault.files.set('Untitled.md', encode('again\n'));
    await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    look.release();
    await deleting;
    // Not taken for the new note on this disk.
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(b.h.vault.text('Untitled.md')).toBe('again\n');

    await through(b);
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
    ]);
    expect(b.server.pathOf(theirs)).toBe('Untitled.md');
    expect(disk(b.h)).toEqual([`${aside}=again\n`, 'Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('made again under its name, reported as a save, while the disk is read to let the name go: the new one holds it', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await until('their note waits', () => logged(b, THEIRS_WAITS));
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

    // As above, the note made again reported as a save of the name: the
    // delete of a note whose create is queued takes no file, and holds no
    // save of the name up.
    const look = holdAnswer(b.h, 'Untitled.md', 1);
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await look.reached;
    b.h.vault.files.set('Untitled.md', encode('again\n'));
    await b.h.engine.handleVaultEvent(event('modify', 'Untitled.md'));
    look.release();
    await deleting;
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(b.h.vault.text('Untitled.md')).toBe('again\n');

    await through(b);
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
    ]);
    expect(b.server.pathOf(theirs)).toBe('Untitled.md');
    expect(disk(b.h)).toEqual([`${aside}=again\n`, 'Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('created again under its name while the disk is read to let the name go, its create out at once: the new one holds it', async () => {
    const stuckRetryMs = 1_234_567;
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']], {
      queueStuckRetryMs: stuckRetryMs,
    });
    const mark = b.server.applied.length;
    const later = holdTimers(stuckRetryMs);
    try {
      // An attachment's change turned away busy, and its upload failing on
      // each try after; a new note made while the first try is on its way
      // waits in the queue behind it. After the third try new changes go out
      // at once again, and the queue waits for the long pause.
      b.server.bar(1);
      b.h.vault.files.set('img.png', encode('v2'));
      const modifying = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
      await emitted(b.h, 'file:update-binary');
      const upload = deferred<void>();
      const failing = deferred<void>();
      b.h.routes.set('PUT /blobs', async () => {
        upload.resolve();
        await failing.promise;
        return json({ error: 'unavailable' }, 503);
      });
      expect(b.server.serveNext()).toBe(true);
      await upload.promise;
      b.h.vault.files.set('Untitled.md', encode('mine\n'));
      await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
      expect(queue(b.h)).toEqual(['UPDATE img.png', 'CREATE Untitled.md']);
      failing.resolve();
      await modifying;
      await until('the long pause', () => later.held.length === 1);

      // A teammate's new note under its name waits for ours.
      const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
      await aWhile();
      expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
      // Deleted; the look that lets the name go (after the delete's own) finds
      // it free, and the user makes a new note there before the answer is in.
      // Its create goes out at once.
      const look = holdAnswer(b.h, 'Untitled.md', 1);
      b.h.vault.files.delete('Untitled.md');
      const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
      await look.reached;
      b.h.vault.files.set('Untitled.md', encode('again\n'));
      const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
      await emitted(b.h, 'file:create');
      look.release();
      await deleting;
      // Not taken for the new note on this disk.
      expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();

      // The server stores ours under a conflict name; theirs comes in.
      expect(b.server.serveNext()).toBe(true);
      await creating;
      const aside = 'Untitled.conflict-device-1.md';
      await writtenHere(b, 'Untitled.md', 'theirs\n');
      expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
      // The queue, after the long pause: the upload goes through now.
      b.h.routes.set('PUT /blobs', () => json({ ok: true }));
      later.held[0]?.();
      await b.server.pump();
      await b.h.settle();
      await b.docs.drive();
      await b.h.settle();
      expect(b.server.applied.slice(mark)).toEqual([
        'create Untitled.md',
        `create ${aside}`,
        'update f2',
      ]);
      expect(b.server.pathOf(theirs)).toBe('Untitled.md');
      expect(disk(b.h)).toEqual([
        `${aside}=again\n`,
        'Untitled.md=theirs\n',
        'a.md=a\n',
        'img.png=v2',
      ]);
      expect(queue(b.h)).toEqual([]);
      appliedOnce(b.server);
      await b.h.engine.stop();
    } finally {
      later.restore();
    }
  });

  it('created again under its name, not reported yet, as a teammate’s rename onto the name is let in: the new one holds it', async () => {
    const b = await queuedNewNote([['Other.md', 'f2', 'other\n']]);
    const mark = b.server.applied.length;
    b.server.teammateRename('f2', 'Untitled.md');
    await aWhile();

    // Deleted; the look that lets the name go finds it free, and a new note
    // is under the name before the answer is in — Obsidian has not reported it.
    const look = holdAnswer(b.h, 'Untitled.md', 1);
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await look.reached;
    b.h.vault.files.set('Untitled.md', encode('again\n'));
    look.release();
    await deleting;
    // Not moved over the new note.
    expect(disk(b.h)).toEqual(['Other.md=other\n', 'Untitled.md=again\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Other.md')).toBe('f2');

    await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await through(b);
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([
      'f2 Other.md -> Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
    ]);
    expect(disk(b.h)).toEqual([`${aside}=again\n`, 'Untitled.md=other\n', 'z.md=a\n']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe('f2');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('created, turned away busy while its delete waits for it, the server listing a teammate’s note under its name, not announced yet: no delete of it', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    // A teammate's new note under the name, made over REST: its broadcast
    // comes after the listing has it.
    await listedOnly(b, 's9', 'Untitled.md');
    const read = b.h.requests.length;
    const listing = holdListing(b);
    let asked = false;
    void listing.asked.then(() => {
      asked = true;
    });
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await until('the delete waits for the create', () => asked || logged(b, WAITS_FOR_CREATE));

    // The server turns the rename away busy, and then the create.
    expect(b.server.serveNext()).toBe(true);
    await until('the rename queued', () => queue(b.h).includes('RENAME a.md -> z.md'));
    expect(b.server.serveNext()).toBe(true);
    await creating;
    listing.answer();
    await deleting;
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);
    expect(listingsSince(b, read)).toBe(0);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> z.md']);
    expect(b.server.pathOf('s9')).toBe('Untitled.md');
    expect(disk(b.h)).toEqual(['z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted while the queue sends its create, not answered yet: the delete is of the file it records, and the note stays deleted', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const read = b.h.requests.length;
    // The queue goes out: the rename, then the new note's create — its entry
    // queued until it is answered.
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:create');
    expect(queue(b.h)).toEqual(['CREATE Untitled.md']);

    const { handled } = await deleteHere(b, 'Untitled.md');
    // The create answered.
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await served(b, handled);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 a.md -> z.md',
      'create Untitled.md',
      `delete ${ours}`,
    ]);
    expect(listingsSince(b, read)).toBe(0);
    expect(live(b.server)).toEqual(['z.md']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(queue(b.h)).toEqual([]);

    // Nothing brings it back.
    b.h.socket().disconnect();
    await reconnect(b);
    await b.h.settle();
    expect(disk(b.h)).toEqual(['z.md=a\n']);
    expect(live(b.server)).toEqual(['z.md']);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted while the queue reads it to send its create: the delete is of the file the create records', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    // The queue goes out; the drain has read the note, and the user deletes
    // it before the bytes are on their way.
    const reading = holdRead(b.h, 'Untitled.md');
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    await reading.reached;
    const { handled } = await deleteHere(b, 'Untitled.md');
    reading.release();
    await emitted(b.h, 'file:create');
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await served(b, handled);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 a.md -> z.md',
      'create Untitled.md',
      `delete ${ours}`,
    ]);
    expect(live(b.server)).toEqual(['z.md']);
    expect(disk(b.h)).toEqual(['z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deleted while the queue sends its create, a teammate’s note under its name: the server stores ours under a conflict name, and the delete takes it', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:create');

    const { handled } = await deleteHere(b, 'Untitled.md');
    // The create answered: stored under a conflict name, theirs has the name.
    expect(b.server.serveNext()).toBe(true);
    const aside = 'Untitled.conflict-device-1.md';
    const ours = liveAt(b.server, aside);
    await served(b, handled);
    await b.server.pump();
    await b.h.settle();
    await writtenHere(b, 'Untitled.md', 'theirs\n');
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
      `delete ${ours}`,
    ]);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(b.h.engine.getFileIdForPath(aside)).toBeNull();
    expect(queue(b.h)).toEqual([]);

    // Nothing brings ours back.
    b.h.socket().disconnect();
    await reconnect(b);
    await b.h.settle();
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('stopped while its delete waits for the create the queue sent, which never reached the server: nothing of a teammate’s note under its name is deleted at the next start', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    b.server.delay(await emitted(b.h, 'file:create'));
    const { handled } = await deleteHere(b, 'Untitled.md');
    expect(logged(b, WAITS_FOR_CREATE)).toBe(true);

    await b.h.engine.stop();
    void handled.catch(() => undefined);
    // Nothing queued for the delete: the create settles it.
    expect(queue(b.h)).toEqual(['CREATE Untitled.md']);

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await writtenHere(next, 'Untitled.md', 'theirs\n');
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(b.server.pathOf(theirs)).toBe('Untitled.md');
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(next.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped while its delete waits for the create the queue sent, which reached the server after: the next start deletes ours, not the teammate’s note under its name', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    const out = await emitted(b.h, 'file:create');
    b.server.delay(out);
    const { handled } = await deleteHere(b, 'Untitled.md');
    expect(logged(b, WAITS_FOR_CREATE)).toBe(true);

    await b.h.engine.stop();
    void handled.catch(() => undefined);
    expect(queue(b.h)).toEqual(['CREATE Untitled.md']);
    // The create reaches the server; its answer goes nowhere.
    b.server.deliverLate(out);
    const aside = 'Untitled.conflict-device-1.md';
    const ours = liveAt(b.server, aside);

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await writtenHere(next, 'Untitled.md', 'theirs\n');
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
      `delete ${ours}`,
    ]);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(next.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped while the delete of a new note whose create is queued looks at the disk: nothing is queued for it, and a teammate’s note under its name stays', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    // The delete's look at the disk held; stopped meanwhile.
    const look = holdAnswer(b.h, 'Untitled.md');
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    void deleting.catch(() => undefined);
    await look.reached;
    const stopping = b.h.engine.stop();
    look.release();
    await stopping;
    // Nothing queued for the delete: the create settles it.
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);

    b.server.lift();
    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await writtenHere(next, 'Untitled.md', 'theirs\n');
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(b.server.pathOf(theirs)).toBe('Untitled.md');
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(next.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('deleted while its create is on its way, not answered yet: the delete is of the file it records, whatever the listing has', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    const read = b.h.requests.length;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');

    const { handled } = await deleteHere(b, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await served(b, handled);
    await creating;
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', `delete ${ours}`]);
    expect(listingsSince(b, read)).toBe(0);
    expect(live(b.server)).toEqual(['a.md']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a delete of a name nothing is recorded under reads the listing; a new note made there meanwhile, its create queued: no delete of what the listing has', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:rename', 2);
    await listedOnly(b, 's9', 'Untitled.md');
    // A delete of a name not recorded here (a stale index, say): the server
    // is asked what it has there, the answer held.
    const listing = holdListing(b);
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await listing.asked;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);
    listing.answer();
    await deleting;
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md']);

    await through(b);
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> z.md', `create ${aside}`]);
    expect(b.server.pathOf('s9')).toBe('Untitled.md');
    expect(disk(b.h)).toEqual([`${aside}=mine\n`, 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a delete of a name nothing is recorded under reads the listing; a new note made there meanwhile, its create on its way: no delete of what the listing has', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    await listedOnly(b, 's9', 'Untitled.md');
    const listing = holdListing(b);
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await listing.asked;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    listing.answer();
    // The server answers what comes: ours stored under a conflict name, s9
    // has the name.
    await served(b, deleting);
    await creating;
    await b.server.pump();
    await b.h.settle();
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([`create ${aside}`]);
    expect(b.server.pathOf('s9')).toBe('Untitled.md');
    expect(emitsOf(b.h, 'file:delete')).toEqual([]);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('a delete of a name nothing is recorded under, a new note made there before it looks at the server, its create on its way: the server is not asked', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    const read = b.h.requests.length;
    await listedOnly(b, 's9', 'Untitled.md');
    // The delete's look at the disk held; the new note comes meanwhile.
    const look = holdAnswer(b.h, 'Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await look.reached;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    look.release();
    // The server answers what comes: ours stored under a conflict name, s9
    // has the name.
    await served(b, deleting);
    await creating;
    await b.server.pump();
    await b.h.settle();
    const aside = 'Untitled.conflict-device-1.md';
    expect(b.server.applied.slice(mark)).toEqual([`create ${aside}`]);
    expect(b.server.pathOf('s9')).toBe('Untitled.md');
    expect(emitsOf(b.h, 'file:delete')).toEqual([]);
    expect(listingsSince(b, read)).toBe(0);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('Pause sync while its delete waits for the create the queue sent, which reached the server: on resume ours goes, and a teammate’s note under its name comes in', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await aWhile();
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    const out = await emitted(b.h, 'file:create');
    b.server.delay(out);
    const { handled } = await deleteHere(b, 'Untitled.md');
    expect(logged(b, WAITS_FOR_CREATE)).toBe(true);

    // Paused: the create's answer never comes, and the delete sends nothing.
    b.h.engine.pause();
    await handled;
    expect(queue(b.h)).toEqual(['CREATE Untitled.md']);
    // The create reached the server all the same.
    b.server.deliverLate(out);
    const aside = 'Untitled.conflict-device-1.md';
    const ours = liveAt(b.server, aside);

    await b.h.engine.resume();
    await answerJoin(b);
    await b.server.pump();
    await b.h.settle();
    await writtenHere(b, 'Untitled.md', 'theirs\n');
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      'f1 a.md -> z.md',
      `create ${aside}`,
      `delete ${ours}`,
    ]);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(b.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('renamed before its create is answered, then deleted under the new name, the answer after the delete’s checks: the delete is of the file the create records', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    const read = b.h.requests.length;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    // Given its title before the server has answered: the rename waits for the create.
    const renaming = b.h.vault.rename('Untitled.md', 'Title.md');
    await aWhile();
    expect(emitsOf(b.h, 'file:rename')).toEqual([]);

    const { handled } = await deleteHere(b, 'Title.md');
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await served(b, handled);
    await creating;
    await renaming;
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toContain(`delete ${ours}`);
    expect(b.server.pathOf(ours)).toBeNull();
    expect(listingsSince(b, read)).toBe(0);
    expect(live(b.server)).toEqual(['a.md']);
    expect(b.h.engine.getFileIdForPath('Title.md')).toBeNull();
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(disk(b.h)).toEqual(['a.md=a\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  /**
   * The next clear of the doc under `path` — the one the record of a note's
   * create makes (see `startDoc`) — held until released.
   */
  function holdClear(h: Harness, path: string): Gate {
    const clear = h.doc.clear.bind(h.doc);
    const reached = deferred<void>();
    const open = deferred<void>();
    const spy = jest
      .spyOn(h.doc, 'clear')
      .mockImplementation(async (bindingId: string, p: string) => {
        if (p !== path) return clear(bindingId, p);
        spy.mockRestore();
        reached.resolve();
        await open.promise;
        return clear(bindingId, p);
      });
    return { reached: reached.promise, release: () => open.resolve() };
  }

  /** {@link served}, the engine's `yjs:fetch` answered as well. */
  async function answered(b: Bench, handled: Promise<void>): Promise<void> {
    let done = false;
    const end = (): void => {
      done = true;
    };
    void handled.then(end, end);
    await until('the handler done', () => {
      b.server.serveNext();
      b.docs.answerFetches();
      return done;
    });
    await handled;
  }

  /**
   * What the server and this device have once a note deleted while its create
   * was on its way, then made again under its name, is through: the first
   * file deleted, the new note created under the name with its own text.
   */
  async function madeAgain(b: Bench, before: string[], first: string): Promise<void> {
    await b.server.pump();
    await b.h.settle();
    await b.docs.drive();
    await b.h.settle();
    expect(b.server.applied.slice(before.length)).toEqual([
      `delete ${first}`,
      'create Untitled.md',
    ]);
    const again = liveAt(b.server, 'Untitled.md');
    expect(b.docs.text(again)).toBe('new\n');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(again);
    expect(disk(b.h)).toContain('Untitled.md=new\n');
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
  }

  it('created again under its name while its delete waits for the create of the first: the first is deleted, the new note goes out as one of its own', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    // Made again under the name before the server has answered the first.
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const again = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    expect(b.server.serveNext()).toBe(true);
    const first = liveAt(b.server, 'Untitled.md');
    const before = [...b.server.applied];
    await served(b, handled);
    await answered(b, again);
    await creating;
    await madeAgain(b, before, first);
    expect(live(b.server)).toEqual(['Untitled.md', 'a.md']);

    // Nothing changes at the next connect.
    b.h.socket().disconnect();
    await reconnect(b);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(before.length)).toEqual([
      `delete ${first}`,
      'create Untitled.md',
    ]);
    expect(disk(b.h)).toEqual(['Untitled.md=new\n', 'a.md=a\n']);
    await b.h.engine.stop();
  });

  it('created again under its name while its delete waits for the create the queue sent: the first is deleted, the new note goes out as one of its own', async () => {
    const b = await queuedNewNote([]);
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const again = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    expect(b.server.serveNext()).toBe(true);
    const first = liveAt(b.server, 'Untitled.md');
    const before = [...b.server.applied];
    await served(b, handled);
    await answered(b, again);
    await madeAgain(b, before, first);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);

    b.h.socket().disconnect();
    await reconnect(b);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(before.length)).toEqual([
      `delete ${first}`,
      'create Untitled.md',
    ]);
    expect(disk(b.h)).toEqual(['Untitled.md=new\n', 'z.md=a\n']);
    await b.h.engine.stop();
  });

  it('created again under its name and saved while the answer to the first create is recorded, its delete waiting: the save is the new note’s', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    // The answer recorded; its doc is being opened as the new note is saved.
    const clearing = holdClear(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const first = liveAt(b.server, 'Untitled.md');
    const before = [...b.server.applied];
    await clearing.reached;
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const saved = b.h.engine.handleVaultEvent(event('modify', 'Untitled.md'));
    clearing.release();
    await served(b, handled);
    await answered(b, saved);
    await creating;
    await madeAgain(b, before, first);
    await b.h.engine.stop();
  });

  it('stopped while the answer to the create the queue sent is recorded, its delete waiting for it: the next start deletes it', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    b.server.lift();
    expect(b.server.serveNext()).toBe(true);
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    // Its `unlink` too: two deletes of the name wait for the create.
    const unlinked = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    // The answer recorded; stopped while its doc is opened.
    const clearing = holdClear(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await clearing.reached;
    const stopping = b.h.engine.stop();
    clearing.release();
    await stopping;
    await Promise.all([handled, unlinked]);
    expect(queue(b.h)).toEqual(['DELETE Untitled.md']);

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'f1 a.md -> z.md',
      'create Untitled.md',
      `delete ${ours}`,
    ]);
    expect(live(b.server)).toEqual(['z.md']);
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(disk(next.h)).toEqual(['z.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped while the answer to its create is recorded, its delete waiting for it: the next start deletes it', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    void creating.catch(() => undefined);
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    const clearing = holdClear(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const ours = liveAt(b.server, 'Untitled.md');
    await clearing.reached;
    const stopping = b.h.engine.stop();
    clearing.release();
    await stopping;
    void handled.catch(() => undefined);
    expect(queue(b.h)).toContain('DELETE Untitled.md');

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', `delete ${ours}`]);
    expect(live(b.server)).toEqual(['a.md']);
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBeNull();
    expect(disk(next.h)).toEqual(['a.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped while a note made again under its name waits for the delete of the first, the answer to the first create recorded: the next start deletes the first and uploads the new note', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const again = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    const clearing = holdClear(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const first = liveAt(b.server, 'Untitled.md');
    await clearing.reached;
    const stopping = b.h.engine.stop();
    clearing.release();
    await stopping;
    await Promise.all([creating, handled, again]);
    expect(queue(b.h)).toContain('DELETE Untitled.md');

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await next.docs.drive();
    await next.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      `delete ${first}`,
      'create Untitled.md',
    ]);
    const made = liveAt(b.server, 'Untitled.md');
    expect(b.docs.text(made)).toBe('new\n');
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBe(made);
    expect(disk(next.h)).toEqual(['Untitled.md=new\n', 'a.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped once a note made again under its name was renamed, the answer to the first create recorded and its delete waiting: nothing is deleted at the next start', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    const clearing = holdClear(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    const first = liveAt(b.server, 'Untitled.md');
    await clearing.reached;
    // Made again and given its title while the answer is recorded: the file
    // recorded under the name moves with the note.
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const renaming = b.h.vault.rename('Untitled.md', 'Title.md');
    await until('the note recorded under its title', () => {
      return b.h.engine.getFileIdForPath('Title.md') === first;
    });
    const stopping = b.h.engine.stop();
    clearing.release();
    await stopping;
    await Promise.all([creating, handled, renaming, b.h.settle()]);
    expect(queue(b.h).filter((e) => e.startsWith('DELETE'))).toEqual([]);

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await next.docs.drive();
    await next.h.settle();
    expect(b.server.applied.slice(mark)).toEqual([
      'create Untitled.md',
      `${first} Untitled.md -> Title.md`,
    ]);
    expect(live(b.server)).toEqual(['Title.md', 'a.md']);
    expect(next.h.engine.getFileIdForPath('Title.md')).toBe(first);
    expect(disk(next.h)).toEqual(['Title.md=new\n', 'a.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('stopped while the delete of a note turned away busy lets the name go, the note made again with the text of a teammate’s note under the name, its create answered with theirs: nothing of theirs is deleted at the next start', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const mark = b.server.applied.length;
    b.server.bar();
    await renameOut(b, 'a.md', 'z.md');
    b.h.vault.files.set('Untitled.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    await emitted(b.h, 'file:create');
    const { handled } = await deleteHere(b, 'Untitled.md');
    // A teammate's new note under the name waits for ours.
    const theirs = await b.server.teammateCreate('Untitled.md', 'theirs\n');
    await until('their note waits', () => logged(b, THEIRS_WAITS));
    // The rename and the create turned away busy: the delete, which waited
    // for the create, has no file to delete, and lets the name go — its look
    // at the disk held.
    const look = holdAnswer(b.h, 'Untitled.md');
    expect(b.server.serveNext()).toBe(true);
    await until('the rename queued', () => queue(b.h).includes('RENAME a.md -> z.md'));
    expect(b.server.serveNext()).toBe(true);
    await creating;
    await look.reached;
    // Made again, with the teammate's text: the queue sends the create, and
    // the server answers with their note.
    b.h.vault.files.set('Untitled.md', encode('theirs\n'));
    await b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    b.server.lift();
    await until('their note recorded under the name', () => {
      b.server.serveNext();
      return b.h.engine.getFileIdForPath('Untitled.md') === theirs;
    });
    const stopping = b.h.engine.stop();
    look.release();
    await stopping;
    await handled;
    expect(queue(b.h).filter((e) => e.startsWith('DELETE'))).toEqual([]);

    const next = await restart(b);
    await b.server.pump();
    await next.h.settle();
    await next.docs.drive();
    await next.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['create Untitled.md', 'f1 a.md -> z.md']);
    expect(live(b.server)).toEqual(['Untitled.md', 'z.md']);
    expect(b.docs.text(theirs)).toBe('theirs\n');
    expect(next.h.engine.getFileIdForPath('Untitled.md')).toBe(theirs);
    expect(disk(next.h)).toEqual(['Untitled.md=theirs\n', 'z.md=a\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(b.server);
    await next.h.engine.stop();
  });

  it('a new note whose create is queued, deleted and made again under its name while its delete looks at the disk: the new note goes out once, with its own text', async () => {
    const b = await queuedNewNote([]);
    const mark = b.server.applied.length;
    // The delete's look at the disk held; the note is made again meanwhile.
    const look = holdAnswer(b.h, 'Untitled.md');
    b.h.vault.files.delete('Untitled.md');
    const deleting = b.h.engine.handleVaultEvent(event('delete', 'Untitled.md'));
    await look.reached;
    b.h.vault.files.set('Untitled.md', encode('new\n'));
    const again = b.h.engine.handleVaultEvent(event('create', 'Untitled.md'));
    look.release();
    await Promise.all([deleting, again]);
    expect(queue(b.h)).toEqual(['RENAME a.md -> z.md', 'CREATE Untitled.md', 'CREATE Untitled.md']);

    await through(b);
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> z.md', 'create Untitled.md']);
    const made = liveAt(b.server, 'Untitled.md');
    expect(b.docs.text(made)).toBe('new\n');
    expect(b.h.engine.getFileIdForPath('Untitled.md')).toBe(made);
    expect(emitsOf(b.h, 'file:delete')).toEqual([]);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});
