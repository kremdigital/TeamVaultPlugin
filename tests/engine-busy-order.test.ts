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
 * catch-up done. The queue is tried again at once after `busy`.
 */
async function online(notes: Seed, attachments: Seed = []): Promise<Bench> {
  const entries: LogEntry[] = [];
  const logger = new Logger('debug', {
    write: (e) => {
      entries.push(e);
    },
  });
  const h = buildHarness({ logger, queueRetryMs: [0] });
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

  it('halted by another error three tries in a row: new changes go out again, the rest waits', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    const mark = b.server.applied.length;
    b.server.bar(1);
    b.h.vault.files.set('img.png', encode('v2'));
    const modifying = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    await emitted(b.h, 'file:update-binary');
    const uploads = (): number => b.h.requests.filter((r) => r.method === 'PUT').length;
    const before = uploads();
    b.h.routes.set('PUT /blobs', () => json({ error: 'unavailable' }, 503));
    expect(b.server.serveNext()).toBe(true);
    await modifying;
    const gaveUp = (): boolean =>
      b.entries.some(
        (e) => e.level === 'warn' && e.message.startsWith('queue drain halted after busy'),
      );
    await until('the warning', gaveUp);
    expect(uploads() - before).toBe(3);

    await renameOut(b, 'a.md', 'b.md');
    expect(queue(b.h)).toEqual(['UPDATE img.png']);
    await b.server.pump();
    await b.h.settle();
    expect(b.server.applied.slice(mark)).toEqual(['f1 a.md -> b.md']);
    expect(queue(b.h)).toEqual(['UPDATE img.png']);
    await b.h.engine.stop();
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
});
