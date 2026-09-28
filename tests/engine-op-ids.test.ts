/**
 * Operation ids (TASK-0035, `sync-protocol.md` §4 of the 0.4 protocol): every
 * file operation of this device goes out under an `opId` written to
 * `state.json` before it goes out, the server applies each `opId` once, and
 * the next connect asks the server (`ops:status`) what became of the ones
 * whose answers were lost before it reads the listing and the catch-up.
 *
 * The engine runs against the {@link FakeServer}, which keeps that contract,
 * and on a {@link FakeStorage}: a quit or a crash is a new engine started from
 * the `state.json` the disk has at that moment, not from the log in memory.
 * Common to every scenario: the server applies each operation at most once
 * (`appliedOpIds` has no id twice).
 */
import { sha256Hex } from '@/sync/hash';
import { isOpId } from '@/sync/operation-log';
import { Logger, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeServer,
  FakeStorage,
  ServerDocs,
  buildHarness,
  bytes,
  connect,
  deferred,
  encode,
  flushAsync,
  joinClockOf,
  joinToAnswer,
  joinsOf,
  json,
  logOn,
  nextJoin,
  op,
  protocolFixture,
  restartFromDisk,
  serverDocWith,
  serverFile,
  shapeOf,
  snapshotOf,
  userRename,
  type Emit,
  type Harness,
  type StoredState,
} from './engine-test-kit';

jest.setTimeout(30_000);

// -- Helpers ------------------------------------------------------------------

type Seed = ReadonlyArray<readonly [path: string, fileId: string, content: string]>;

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  storage: FakeStorage;
}

/**
 * Notes and attachments on disk, in `state.json` (a {@link FakeStorage}) and
 * on the server; connected, the catch-up done.
 */
async function online(
  notes: Seed = [],
  attachments: Seed = [],
  opts: { flushDelayMs?: number; logger?: Logger } = {},
): Promise<Bench> {
  const storage = new FakeStorage();
  const log = await logOn(storage, opts.flushDelayMs);
  const h = buildHarness({ log, ...(opts.logger ? { logger: opts.logger } : {}) });
  const server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
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
  await h.log.persistNow();
  return { h, server, docs, storage };
}

/** The socket connects again; `ops:status`, then the join, answered with the whole catch-up. */
async function reconnect(b: Bench): Promise<void> {
  const before = joinsOf(b.h);
  b.h.socket().connect();
  await answerNextJoin(b, before);
}

async function answerNextJoin(b: Bench, before: number): Promise<void> {
  (await nextJoin(b.h, before)).ack(
    b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
  );
  await b.docs.drive();
}

/** The process ends now; the next start finds the disk as it is. Connected, the catch-up done. */
async function restart(b: Bench, disk: FakeStorage = b.storage): Promise<Bench> {
  const { next, storage } = await restartFromDisk(b.h, disk, { server: b.server, docs: b.docs });
  const before = joinsOf(next);
  await next.engine.start();
  const bench = { ...b, h: next, storage };
  await answerNextJoin(bench, before);
  return bench;
}

function event(type: VaultEvent['type'], path: string): VaultEvent {
  return { bindingId: 'b1', type, path, source: 'obsidian' } as VaultEvent;
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function queue(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.newPath ? ` -> ${op.newPath}` : ''}`);
}

function records(h: Harness): string[] {
  return h.log
    .listFileMeta('b1')
    .map((m) => `${m.serverFileId}:${m.relativePath}`)
    .sort();
}

/** Every live file on the server as `id:path`. */
function live(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => `${f.id}:${f.path}`)
    .sort();
}

/** R1: the server applied each opId once. */
function appliedOnce(server: FakeServer): void {
  expect(new Set(server.appliedOpIds).size).toBe(server.appliedOpIds.length);
}

/** The file operations the engine's socket has sent, as `event path`. */
function sent(h: Harness): string[] {
  return h
    .socket()
    .emits.filter((e) => e.event.startsWith('file:'))
    .map((e) => {
      const p = e.payload as { filePath?: string; newPath?: string };
      return `${e.event} ${p.filePath ?? ''}${p.newPath ? ` -> ${p.newPath}` : ''}`;
    });
}

function opIdOf(e: Emit): string {
  return (e.payload as { opId: string }).opId;
}

/** Every opId `state` holds, queued or in flight. */
function stateOpIds(state: StoredState | null): string[] {
  const b1 = state?.bindings['b1'];
  return [...(b1?.pending ?? []), ...(b1?.inflight ?? [])].map((op) => op.opId);
}

/** Wait until the socket has sent `event`; the emit. */
async function emitted(h: Harness, event: string, count = 1): Promise<Emit> {
  for (let i = 0; i < 50; i++) {
    const found = h.socket().emits.filter((e) => e.event === event);
    const hit = found[count - 1];
    if (hit !== undefined) return hit;
    await flushAsync(2);
  }
  throw new Error(`no ${event} sent`);
}

/** Hold the connect's listing until the returned function is called. */
function holdListing(h: Harness): () => void {
  const gate = deferred<void>();
  const route = h.routes.get('GET /api/projects/p1/files');
  if (!route) throw new Error('no listing route');
  h.routes.set('GET /api/projects/p1/files', async () => {
    const asked = await route();
    await gate.promise;
    return asked;
  });
  return () => gate.resolve();
}

/** Lose the ack of `e`: the server applies it, the answer never comes. */
function loseAck(e: Emit): void {
  e.ack = (): void => undefined;
}

/** An `ops:status` answered by a server that never got anything asked about. */
function voidEvery(e: Emit): void {
  e.ack({ ok: true, applied: [], voided: (e.payload as { opIds: string[] }).opIds });
}

/** How many times the user was asked about the copy of a deleted file. */
function askedAboutCopy(h: Harness): number {
  return h.calls.filter((c) => c === 'modal.resolveDeleteConflict').length;
}

/**
 * The server answers what the engine sends, and the docs it asks for, until
 * `done()` holds (a bounded number of rounds).
 */
async function serveUntil(b: Bench, done: () => boolean): Promise<void> {
  for (let round = 0; round < 30 && !done(); round++) {
    await b.server.pump(100);
    await b.h.settle();
    b.docs.absorb();
    b.docs.answerFetches();
    await flushAsync(10);
  }
}

/** Wait, in real time, until `done()` holds; fails after `ms`. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The user renames `from` in Obsidian; resolves once its rename is out, not
 * answered yet (unlike `userRename`, whose settling lets the server answer).
 */
async function renameOut(b: Bench, from: string, to: string): Promise<Emit> {
  const before = b.h.socket().emits.filter((e) => e.event === 'file:rename').length;
  await b.h.vault.rename(from, to);
  return emitted(b.h, 'file:rename', before + 1);
}

// -- Write-ahead (I1) and the answer (I2) ----------------------------------------

describe('SyncEngine — an operation is on disk before it goes out', () => {
  it('writes each live operation, under the opId it goes out with, before the emit', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    const onDisk: Array<[string, boolean]> = [];
    const socket = b.h.socket();
    const emit = socket.emit.bind(socket);
    socket.emit = (name: string, ...args: unknown[]) => {
      const opId = (args[0] as { opId?: unknown }).opId;
      if (name.startsWith('file:')) {
        onDisk.push([name, stateOpIds(b.storage.state()).includes(String(opId))]);
      }
      return emit(name, ...args);
    };

    await userRename(b.h, 'a.md', 'b.md');
    b.h.vault.files.set('img.png', encode('v2'));
    const modified = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    b.h.vault.files.set('new.md', encode('new\n'));
    const created = b.h.engine.handleVaultEvent(event('create', 'new.md'));
    await b.server.pump();
    await Promise.all([modified, created]);
    b.h.vault.files.delete('new.md');
    const deleted = b.h.engine.handleVaultEvent(event('delete', 'new.md'));
    await b.docs.drive();
    await deleted;

    // The modify and the create are handled at once: either may go out first.
    expect(onDisk).toHaveLength(4);
    expect(onDisk[0]).toEqual(['file:rename', true]);
    expect(onDisk.slice(1, 3)).toEqual(
      expect.arrayContaining([
        ['file:update-binary', true],
        ['file:create', true],
      ]),
    );
    expect(onDisk[3]).toEqual(['file:delete', true]);
    for (const e of b.h.socket().emits.filter((x) => x.event.startsWith('file:'))) {
      expect(isOpId(opIdOf(e))).toBe(true);
    }
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('does not send an operation it could not write; the drain sends it once it can', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    b.storage.failWrites = true;
    await userRename(b.h, 'a.md', 'b.md');
    await flushAsync(20);
    expect(sent(b.h)).toEqual([]);
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md']);

    b.storage.failWrites = false;
    b.h.socket().disconnect();
    await reconnect(b);
    expect(b.server.applied).toEqual(['f1 a.md -> b.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('takes the operation out of state.json together with what its answer brought', async () => {
    const b = await online();
    b.h.vault.files.set('n.md', encode('n\n'));
    const created = b.h.engine.handleVaultEvent(event('create', 'n.md'));
    const out = await emitted(b.h, 'file:create');
    const opId = opIdOf(out);
    await b.docs.drive();
    await created;
    await b.h.log.persistNow();

    // From the write that put it in flight on, every state.json on disk has
    // either the operation or the file it created — never neither.
    const states = b.storage.states.map((raw) => JSON.parse(raw) as StoredState);
    const from = states.findIndex((s) => stateOpIds(s).includes(opId));
    expect(from).toBeGreaterThanOrEqual(0);
    for (const state of states.slice(from)) {
      const inFlight = stateOpIds(state).includes(opId);
      const recorded = (state.bindings['b1']?.files ?? []).some((f) => f.relativePath === 'n.md');
      expect(inFlight || recorded).toBe(true);
    }
    const last = states[states.length - 1];
    expect(stateOpIds(last ?? null)).toEqual([]);
    expect(records(b.h)).toEqual([`${[...b.server.files.keys()][0] ?? ''}:n.md`]);
    await b.h.engine.stop();
  });

  it('writes the deletes of a folder in flight all at once, before the first goes out', async () => {
    const seed: Array<[string, string, string]> = [];
    for (let i = 0; i < 50; i++) seed.push([`dir/n${i}.png`, `f${i}`, `v${i}`]);
    // Writes the debounce would make meanwhile left out: only those an
    // operation waits for before it goes out count.
    const b = await online([], seed, { flushDelayMs: 60_000 });
    const before = b.storage.states.length;
    let firstEmit: StoredState | null = null;
    const socket = b.h.socket();
    const emit = socket.emit.bind(socket);
    socket.emit = (name: string, ...args: unknown[]) => {
      if (name === 'file:delete' && firstEmit === null) firstEmit = b.storage.state();
      return emit(name, ...args);
    };
    for (const [path] of seed) b.h.vault.files.delete(path);
    const done = b.h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'delete',
      path: 'dir',
      isFolder: true,
      source: 'obsidian',
    });
    await b.server.pump(60);
    await done;
    await b.h.log.persistNow();

    expect(stateOpIds(firstEmit)).toHaveLength(50);
    expect(b.server.applied.filter((a) => a.startsWith('delete'))).toHaveLength(50);
    // One write before the first delete went out, one when it was all done.
    expect(b.storage.states.length - before).toBe(2);
    expect(stateOpIds(b.storage.state())).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('drains a queue on disk already without waiting for a write before each entry', async () => {
    const N = 20;
    const seed: Array<[string, string, string]> = [];
    for (let i = 0; i < N; i++) seed.push([`n${i}.md`, `f${i}`, `n${i}\n`]);
    const b = await online(seed);
    b.h.socket().disconnect();
    await flushAsync();
    for (let i = 0; i < N; i++) await userRename(b.h, `n${i}.md`, `m${i}.md`);
    expect(queue(b.h)).toHaveLength(N);
    const joins = joinsOf(b.h);
    b.h.socket().connect();
    // Asked about and voided: under their new ids on disk before the join.
    const join = await nextJoin(b.h, joins);
    const onDisk = stateOpIds(b.storage.state());
    expect(onDisk).toHaveLength(N);

    // The disk is slow from here on: no write lands until released.
    const release = b.storage.holdWrites();
    join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
    const renames = (): Emit[] => b.h.socket().emits.filter((e) => e.event === 'file:rename');
    await serveUntil(b, () => renames().length === N && b.server.applied.length === N);
    expect(renames().map(opIdOf).sort()).toEqual([...onDisk].sort());
    expect(b.server.applied).toHaveLength(N);
    release();
    await b.h.log.persistNow();
    expect(queue(b.h)).toEqual([]);
    expect(stateOpIds(b.storage.state())).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  }, 120_000);

  it('does not send a queued operation before its opId is on disk', async () => {
    const b = await online();
    b.h.socket().disconnect();
    await flushAsync();
    const joins = joinsOf(b.h);
    b.h.socket().connect();
    const join = await nextJoin(b.h, joins);
    // Created while the join is on its way — queued: the index can't tell a
    // new file yet — and the disk is slow.
    const release = b.storage.holdWrites();
    b.h.vault.files.set('N.md', encode('n\n'));
    await b.h.engine.handleVaultEvent(event('create', 'N.md'));
    expect(queue(b.h)).toEqual(['CREATE N.md']);
    const onDiskAtEmit: boolean[] = [];
    const socket = b.h.socket();
    const emit = socket.emit.bind(socket);
    socket.emit = (name: string, ...args: unknown[]) => {
      if (name.startsWith('file:')) {
        const opId = String((args[0] as { opId?: unknown }).opId);
        onDiskAtEmit.push(stateOpIds(b.storage.state()).includes(opId));
      }
      return emit(name, ...args);
    };

    join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
    await flushAsync(40);
    expect(sent(b.h)).toEqual([]);
    release();
    await b.docs.drive();
    expect(onDiskAtEmit).toEqual([true]);
    expect(b.server.applied).toEqual(['create N.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});

// -- Answers lost: the next connect asks -----------------------------------------

describe('SyncEngine — an operation whose answer was lost, settled at the next connect', () => {
  it('asks ops:status before the join, and does not send again what the server applied', async () => {
    const b = await online([['x.md', 'f1', 'x\n']]);
    loseAck(await renameOut(b, 'x.md', 'y.md'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    expect(queue(b.h)).toEqual(['RENAME x.md -> y.md']);

    // A teammate renames the note on meanwhile: that is where it stays.
    b.server.teammateRename('f1', 'z.md');
    const joins = joinsOf(b.h);
    b.h.socket().connect();
    await flushAsync(5);
    expect(b.server.statusAnswers).toHaveLength(1);
    expect(b.server.statusAnswers[0]?.voided).toEqual([]);
    await answerNextJoin(b, joins);
    expect(joinsOf(b.h)).toBe(joins + 1);

    expect(b.server.applied).toEqual(['f1 x.md -> y.md', 'f1 y.md -> z.md']);
    expect(b.server.duplicates).toEqual([]);
    expect(disk(b.h)).toEqual(['z.md=x\n']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('voids what the server never got, sends it again under a new id, and refuses the old one late', async () => {
    const b = await online([['x.md', 'f1', 'x\n']]);
    const first = await renameOut(b, 'x.md', 'y.md');
    // A packet of a connection that is gone: it reaches the server only
    // after the next connect asked about it.
    b.server.delay(first);
    b.h.socket().disconnect();
    await flushAsync(20);
    await reconnect(b);

    const renames = b.h.socket().emits.filter((e) => e.event === 'file:rename');
    expect(renames).toHaveLength(2);
    expect(opIdOf(renames[1] as Emit)).not.toBe(opIdOf(first));
    expect(b.server.statusAnswers[0]?.voided).toEqual([opIdOf(first)]);
    let late: unknown;
    first.ack = (answer): void => {
      late = answer;
    };
    b.server.deliverLate(first);
    expect(late).toEqual({ ok: false, error: 'op_voided' });
    expect(b.server.applied).toEqual(['f1 x.md -> y.md']);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('keeps an operation in flight at stop for the next engine, which settles it', async () => {
    const b = await online([['x.md', 'f1', 'x\n']]);
    await renameOut(b, 'x.md', 'y.md');
    const stopping = b.h.engine.stop();
    expect(b.server.serveNext()).toBe(true);
    await stopping;
    expect(queue(b.h)).toEqual(['RENAME x.md -> y.md']);

    const next = buildHarness({ predecessor: b.h });
    b.server.attach(next);
    b.docs.attach(next);
    const before = joinsOf(next);
    await next.engine.start();
    await answerNextJoin({ ...b, h: next }, before);
    expect(b.server.applied).toEqual(['f1 x.md -> y.md']);
    expect(next.socket().emits.filter((e) => e.event === 'file:rename')).toEqual([]);
    expect(queue(next)).toEqual([]);
    expect(disk(next)).toEqual(['y.md=x\n']);
    await next.engine.stop();
  });

  it('asks again when the server is busy, and reports it when it stays so', async () => {
    const storage = new FakeStorage();
    const log = await logOn(storage);
    log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'gone.md',
      payload: { fileId: 'f1' },
    });
    let asked = 0;
    const entries: LogEntry[] = [];
    const logger = new Logger('debug', {
      write: (e) => {
        entries.push(e);
      },
    });
    const h = buildHarness({
      log,
      logger,
      opsStatusRetryMs: [0, 0, 0],
      statusResponder: (e) => {
        asked += 1;
        e.ack({ ok: false, error: 'busy' });
      },
    });
    const details: Array<string | undefined> = [];
    h.engine.onStatus((_status, detail) => details.push(detail));
    await h.engine.start();
    await flushAsync(40);
    expect(asked).toBe(4);
    expect(h.engine.getStatus()).toBe('error');
    expect(h.statuses.at(-1)).toBe('error');
    expect(details.at(-1)).toBe('ops_status_failed');
    // The entry may only have waited in the queue: no answer is said lost.
    expect(
      entries.filter((e) => e.message === 'could not check the queued operations with the server'),
    ).toHaveLength(1);
    expect(entries.filter((e) => e.message.includes('answers were lost'))).toEqual([]);
    // A server that answers is one that has the question: no join asks it.
    expect(joinsOf(h)).toBe(0);
    await h.engine.stop();
  });

  it('asks again after a timeout, and leaves it to the next connect when the connection drops', async () => {
    const storage = new FakeStorage();
    const log = await logOn(storage);
    log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'gone.md',
      payload: { fileId: 'f1' },
    });
    const answers: Array<(e: Emit) => void> = [
      (e) => e.ack({ ok: false, error: 'timeout' }),
      // Never answered: the connection drops meanwhile.
      () => undefined,
    ];
    let asked = 0;
    const h = buildHarness({
      log,
      opsStatusRetryMs: [0, 0, 0],
      statusResponder: (e) => {
        asked += 1;
        (answers.shift() ?? voidEvery)(e);
      },
    });
    await h.engine.start();
    await flushAsync(20);
    expect(asked).toBe(2);
    h.socket().disconnect();
    await flushAsync(20);
    expect(h.engine.getStatus()).toBe('offline');
    expect(h.statuses).not.toContain('error');
    expect(joinsOf(h)).toBe(0);

    h.socket().connect();
    await nextJoin(h, 0);
    expect(asked).toBe(3);
    expect(log.dequeueOperations('b1')).toHaveLength(1);
    await h.engine.stop();
  });

  it('asks about more than 500 operations 500 at a time, and gives each voided one a new id', async () => {
    const storage = new FakeStorage();
    const log = await logOn(storage);
    const before: string[] = [];
    for (let i = 0; i < 501; i++) {
      const entry = log.enqueueOperation('b1', {
        opType: 'DELETE',
        filePath: `n${i}.md`,
        payload: { fileId: `f${i}` },
      });
      before.push(entry.opId);
    }
    const asked: string[][] = [];
    const h = buildHarness({
      log,
      statusResponder: (e) => {
        asked.push((e.payload as { opIds: string[] }).opIds);
        voidEvery(e);
      },
    });
    await h.engine.start();
    await nextJoin(h, 0);

    expect(asked.map((ids) => ids.length)).toEqual([500, 1]);
    expect(asked.flat()).toEqual(before);
    const after = log.dequeueOperations('b1').map((entry) => entry.opId);
    expect(after).toHaveLength(501);
    expect(after.filter((id) => before.includes(id))).toEqual([]);
    // On disk before the join went out.
    expect(stateOpIds(storage.state()).sort()).toEqual([...after].sort());
    await h.engine.stop();
  });

  it('moves its own counter up to the one the server logged each of its operations with', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['x.md', 'f2', 'x\n'],
    ]);
    // Answered live, and applied while its answer was lost.
    await userRename(b.h, 'a.md', 'b.md');
    loseAck(await renameOut(b, 'x.md', 'y.md'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    const own = b.server.journal.filter((row) => row.clientId === 'device-1');
    expect(own).toHaveLength(2);

    const joins = joinsOf(b.h);
    b.h.socket().connect();
    const join = await nextJoin(b.h, joins);
    const clock = joinClockOf(b.h);
    for (const row of own) {
      expect(clock['device-1']).toBeGreaterThanOrEqual(row.vectorClock['device-1'] ?? 0);
    }
    // The catch-up for that clock returns neither.
    expect(b.server.catchupFor(clock).filter((row) => row.clientId === 'device-1')).toEqual([]);
    join.ack(b.server.joinAnswer('whole journal', { clock, yjsDocs: b.docs.snapshots() }));
    await b.docs.drive();
    await b.h.log.persistNow();
    const persisted = b.storage.state()?.bindings['b1']?.state?.lastVectorClock ?? {};
    expect(persisted['device-1']).toBeGreaterThanOrEqual(clock['device-1'] ?? 0);
    expect(disk(b.h)).toEqual(['b.md=a\n', 'y.md=x\n']);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('has its counter moved up in every state.json that no longer holds the entry it settled', async () => {
    const b = await online([['x.md', 'f1', 'x\n']]);
    loseAck(await renameOut(b, 'x.md', 'y.md'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    const counter =
      b.server.journal.find((row) => row.clientId === 'device-1')?.vectorClock['device-1'] ?? 0;
    expect(counter).toBeGreaterThan(0);

    // Each state.json the settle writes; the first one without the entry is
    // what the process leaves when it ends right then.
    const written: Array<{ entries: number; own: number }> = [];
    let ended: FakeStorage | null = null;
    b.storage.onState = (state): void => {
      const entries = stateOpIds(state).length;
      written.push({ entries, own: state.bindings['b1']?.state?.lastVectorClock['device-1'] ?? 0 });
      if (entries === 0 && ended === null) ended = b.storage.snapshot();
    };
    const joins = joinsOf(b.h);
    b.h.socket().connect();
    await nextJoin(b.h, joins);
    b.storage.onState = null;
    expect(written.filter((s) => s.entries === 0)).not.toEqual([]);
    for (const state of written.filter((s) => s.entries === 0)) {
      expect(state.own).toBeGreaterThanOrEqual(counter);
    }

    // Started from that disk: the catch-up does not bring the rename back as
    // one of another device under this device's id.
    const { next } = await restartFromDisk(b.h, ended ?? b.storage, {
      server: b.server,
      docs: b.docs,
    });
    const before = joinsOf(next);
    await next.engine.start();
    const join = await nextJoin(next, before);
    const clock = joinClockOf(next);
    expect(clock['device-1']).toBeGreaterThanOrEqual(counter);
    expect(b.server.catchupFor(clock).filter((row) => row.clientId === 'device-1')).toEqual([]);
    join.ack(b.server.joinAnswer('whole journal', { clock, yjsDocs: b.docs.snapshots() }));
    await b.docs.drive();
    expect(disk(next)).toEqual(['y.md=x\n']);
    expect(queue(next)).toEqual([]);
    appliedOnce(b.server);
    await next.engine.stop();
  });
});

// -- A create whose answer was lost ------------------------------------------------

describe('SyncEngine — a create applied while its answer was lost', () => {
  async function createLost(text = 'n\n'): Promise<Bench & { createdId: () => string }> {
    const b = await online();
    b.h.vault.files.set('N.md', encode(text));
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    loseAck(await emitted(b.h, 'file:create'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    return { ...b, createdId: () => [...b.server.files.keys()][0] ?? '' };
  }

  it('records the note under its name and sends nothing again', async () => {
    const b = await createLost();
    await reconnect(b);
    expect(b.server.applied).toEqual(['create N.md']);
    expect(records(b.h)).toEqual([`${b.createdId()}:N.md`]);
    expect(b.h.socket().created()).toEqual(['N.md']);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('sends the rename made since from the name it went out under: no second note', async () => {
    const b = await createLost();
    await userRename(b.h, 'N.md', 'M.md');
    expect(queue(b.h)).toEqual(['CREATE M.md']);
    await reconnect(b);
    const id = b.createdId();
    expect(b.server.applied).toEqual(['create N.md', `${id} N.md -> M.md`]);
    expect(live(b.server)).toEqual([`${id}:M.md`]);
    expect(disk(b.h)).toEqual(['M.md=n\n']);
    expect(records(b.h)).toEqual([`${id}:M.md`]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deletes the note it created when it was deleted here since', async () => {
    const b = await createLost();
    b.h.vault.files.delete('N.md');
    await b.h.engine.handleVaultEvent(event('delete', 'N.md'));
    await reconnect(b);
    expect(b.server.applied).toEqual(['create N.md', `delete ${b.createdId()}`]);
    expect(live(b.server)).toEqual([]);
    expect(disk(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('keeps a note merged with a teammate’s, renamed here since, as a note of its own', async () => {
    const b = await online();
    // A teammate's note this device has not heard of yet, with the same text.
    await b.docs.add('f9', 'Daily.md', 'template\n');
    b.h.vault.files.set('Daily.md', encode('template\n'));
    void b.h.engine.handleVaultEvent(event('create', 'Daily.md'));
    loseAck(await emitted(b.h, 'file:create'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    // The server gave this create the teammate's note (merged); renamed here
    // before the answer could say so.
    await userRename(b.h, 'Daily.md', 'Mine.md');
    await reconnect(b);

    const mine = live(b.server).find((f) => f.endsWith(':Mine.md')) ?? '';
    expect(live(b.server)).toEqual(['f9:Daily.md', mine]);
    expect(mine).not.toBe('f9:Mine.md');
    expect(disk(b.h)).toEqual(['Daily.md=template\n', 'Mine.md=template\n']);
    expect(b.server.applied).toEqual([`create Mine.md`]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('sends a save made offline since as an edit of the note it created', async () => {
    const b = await createLost();
    b.h.vault.files.set('N.md', encode('n\nmore\n'));
    await b.h.engine.handleVaultEvent(event('modify', 'N.md'));
    expect(queue(b.h)).toEqual(['CREATE N.md', 'CREATE N.md']);
    await reconnect(b);
    const id = b.createdId();
    expect(b.server.applied).toEqual(['create N.md']);
    expect(b.docs.text(id)).toBe('n\nmore\n');
    expect(disk(b.h)).toEqual(['N.md=n\nmore\n']);
    expect(records(b.h)).toEqual([`${id}:N.md`]);
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('folds a note saved again while the plugin was off into the note it created', async () => {
    const b = await online();
    b.h.vault.files.set('N.md', encode('n\n'));
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    loseAck(await emitted(b.h, 'file:create'));
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    // No event: the plugin is off.
    b.h.vault.files.set('N.md', encode('n\nmore\n'));
    const next = await restart(b);
    const id = [...next.server.files.keys()][0] ?? '';
    expect(next.server.applied).toEqual(['create N.md']);
    expect(next.docs.text(id)).toBe('n\nmore\n');
    expect(disk(next.h)).toEqual(['N.md=n\nmore\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(next.server);
    await next.h.engine.stop();
  });

  it('sends an attachment saved again while the plugin was off after its create was applied', async () => {
    const b = await online();
    b.h.vault.files.set('p.png', encode('v1'));
    void b.h.engine.handleVaultEvent(event('create', 'p.png'));
    loseAck(await emitted(b.h, 'file:create'));
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    b.h.vault.files.set('p.png', encode('v2'));
    const next = await restart(b);
    const id = [...next.server.files.keys()][0] ?? '';
    const v2 = await sha256Hex(encode('v2'));
    expect(next.server.applied).toEqual(['create p.png', `update ${id}`]);
    expect(next.server.files.get(id)?.contentHash).toBe(v2);
    expect(next.h.log.getFileMeta('b1', 'p.png')?.contentHash).toBe(v2);
    expect(next.h.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(next.server);
    await next.h.engine.stop();
  });
});

// -- A create the server stored under a conflict name ------------------------------

describe('SyncEngine — a create the server stored under a conflict name', () => {
  const stored = 'N.conflict-device-1.md';

  /** A teammate's note under `N.md`, not heard of here yet; `N.md` saved here. */
  async function nameTaken(): Promise<Bench> {
    const b = await online();
    await b.docs.add('f9', 'N.md', 'theirs\n');
    b.h.vault.files.set('N.md', encode('mine\n'));
    return b;
  }

  /** `then` runs right after the file has moved to the conflict name on disk. */
  function onMove(b: Bench, then: () => Promise<void> | void): void {
    const rename = b.h.vault.rename.bind(b.h.vault);
    b.h.vault.rename = async (from: string, to: string): Promise<void> => {
      await rename(from, to);
      if (from === 'N.md' && to === stored) await then();
    };
  }

  function storedId(server: FakeServer): string {
    return [...server.files.values()].find((f) => f.path === stored)?.id ?? '';
  }

  it('stays in state.json until it is recorded under the conflict name', async () => {
    const b = await nameTaken();
    const seen: { state: StoredState | null } = { state: null };
    // A write of state.json lands while the file moves.
    onMove(b, async () => {
      await b.h.log.persistNow();
      seen.state = b.storage.state();
    });
    const created = b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await b.docs.drive();
    await created;

    const during = seen.state;
    expect(during).not.toBeNull();
    const recorded = (during?.bindings['b1']?.files ?? []).some((f) => f.relativePath === stored);
    expect(stateOpIds(during).length === 1 || recorded).toBe(true);
    expect(records(b.h)).toEqual([`${storedId(b.server)}:${stored}`]);
    expect(b.h.vault.text(stored)).toBe('mine\n');
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('is recorded under the conflict name after the process ended between the move and its record', async () => {
    const b = await nameTaken();
    const crash: { disk: FakeStorage | null } = { disk: null };
    onMove(b, () => {
      crash.disk ??= b.storage.snapshot();
    });
    const created = b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await b.docs.drive();
    await created;
    expect(crash.disk).not.toBeNull();
    expect(stateOpIds(crash.disk?.state() ?? null)).toHaveLength(1);

    const next = await restart(b, crash.disk ?? b.storage);
    const id = storedId(next.server);
    expect(next.server.applied).toEqual([`create ${stored}`]);
    expect(next.server.statusAnswers.at(-1)?.applied).toHaveLength(1);
    expect(records(next.h)).toEqual([`${id}:${stored}`, 'f9:N.md'].sort());
    expect(disk(next.h)).toEqual([`${stored}=mine\n`, 'N.md=theirs\n']);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(next.server);
    await next.h.engine.stop();
  });
});

// -- Other operations whose answers were lost ----------------------------------------

describe('SyncEngine — updates and deletes applied while their answers were lost', () => {
  it('takes the attachment version it sent for synced: no second upload, no question', async () => {
    const b = await online([], [['img.png', 'f1', 'v1']]);
    b.h.vault.files.set('img.png', encode('v2'));
    void b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    loseAck(await emitted(b.h, 'file:update-binary'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    await reconnect(b);

    expect(b.server.applied).toEqual(['update f1']);
    expect(b.h.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
    expect(b.h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(await sha256Hex(encode('v2')));
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('deletes an attachment deleted after an update whose answer was lost', async () => {
    const b = await online([], [['img.png', 'f1', 'v1']]);
    b.h.vault.files.set('img.png', encode('v2'));
    void b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    loseAck(await emitted(b.h, 'file:update-binary'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    b.h.vault.files.delete('img.png');
    await b.h.engine.handleVaultEvent(event('delete', 'img.png'));
    expect(queue(b.h)).toEqual(['UPDATE img.png', 'DELETE img.png']);
    await reconnect(b);

    // Known by the version its own update brought: the delete goes out.
    expect(b.server.applied).toEqual(['update f1', 'delete f1']);
    expect(disk(b.h)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('sends an attachment saved again while the plugin was off after its update was applied', async () => {
    const b = await online([], [['img.png', 'f1', 'v1']]);
    b.h.vault.files.set('img.png', encode('v2'));
    void b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    loseAck(await emitted(b.h, 'file:update-binary'));
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    b.h.vault.files.set('img.png', encode('v3'));
    const next = await restart(b);
    const v3 = await sha256Hex(encode('v3'));
    expect(next.server.applied).toEqual(['update f1', 'update f1']);
    expect(next.server.files.get('f1')?.contentHash).toBe(v3);
    expect(next.h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(v3);
    expect(next.h.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
    expect(queue(next.h)).toEqual([]);
    appliedOnce(next.server);
    await next.h.engine.stop();
  });

  it('forgets a note whose delete was applied, and sends nothing again', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    b.h.vault.files.delete('a.md');
    void b.h.engine.handleVaultEvent(event('delete', 'a.md'));
    loseAck(await emitted(b.h, 'file:delete'));
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    await reconnect(b);
    expect(b.server.applied).toEqual(['delete f1']);
    expect(b.h.socket().emits.filter((e) => e.event === 'file:delete')).toHaveLength(1);
    expect(records(b.h)).toEqual([]);
    expect(disk(b.h)).toEqual([]);
    await b.h.engine.stop();
  });
});

// -- Quit or crash at each step of a create ----------------------------------------------

describe('SyncEngine — the process ends at each step of a create', () => {
  /** A connected bench and a note about to be created. */
  async function creating(opts: { flushDelayMs?: number } = {}): Promise<Bench> {
    const b = await online([], [], opts);
    b.h.vault.files.set('N.md', encode('n\n'));
    return b;
  }

  function outcome(b: Bench): void {
    expect(b.server.applied).toEqual(['create N.md']);
    expect(records(b.h)).toEqual([`${[...b.server.files.keys()][0] ?? ''}:N.md`]);
    expect(disk(b.h)).toEqual(['N.md=n\n']);
    expect(queue(b.h)).toEqual([]);
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);
    appliedOnce(b.server);
  }

  it('before the operation is written: the next start uploads the note', async () => {
    const b = await creating();
    b.storage.failWrites = true;
    const crash = b.storage.snapshot();
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await flushAsync(10);
    b.storage.failWrites = false;
    const next = await restart(b, crash);
    outcome(next);
    await next.h.engine.stop();
  });

  it('after the write, before the emit', async () => {
    const b = await creating();
    let crash: FakeStorage | null = null;
    b.storage.onState = (state): void => {
      if (crash === null && stateOpIds(state).length > 0) {
        crash = b.storage.snapshot();
        b.h.socket().kill();
      }
    };
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await flushAsync(10);
    b.storage.onState = null;
    expect(sent(b.h)).toEqual([]);
    const next = await restart(b, crash ?? b.storage);
    outcome(next);
    expect(next.server.statusAnswers.at(-1)?.voided).toHaveLength(1);
    await next.h.engine.stop();
  });

  it('after the emit, before the server applied it', async () => {
    const b = await creating();
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await emitted(b.h, 'file:create');
    const next = await restart(b);
    outcome(next);
    await next.h.engine.stop();
  });

  it('after the server applied it, before the answer came', async () => {
    const b = await creating();
    void b.h.engine.handleVaultEvent(event('create', 'N.md'));
    loseAck(await emitted(b.h, 'file:create'));
    expect(b.server.serveNext()).toBe(true);
    const next = await restart(b);
    outcome(next);
    expect(next.server.statusAnswers.at(-1)?.applied).toHaveLength(1);
    await next.h.engine.stop();
  });

  it('after the answer, before its record was written', async () => {
    const b = await creating({ flushDelayMs: 60_000 });
    const created = b.h.engine.handleVaultEvent(event('create', 'N.md'));
    await emitted(b.h, 'file:create');
    const crash = b.storage.snapshot();
    expect(stateOpIds(crash.state())).toHaveLength(1);
    await b.docs.drive();
    await created;
    // The answer is recorded in memory; the disk still has the operation.
    expect(stateOpIds(b.storage.state())).toHaveLength(1);
    const next = await restart(b, b.storage);
    outcome(next);
    await next.h.engine.stop();
  });
});

// -- Keep local, Restore on server ---------------------------------------------------

describe('SyncEngine — answers to questions whose sending was cut short', () => {
  /** The server's bytes of attachment `f1`, downloaded from `GET /files/f1`. */
  function servesDownloads(b: Bench): { set(text: string): void } {
    let current = encode('v1');
    b.h.routes.set('GET /api/projects/p1/files/f1', () => bytes(current));
    return {
      set(text: string): void {
        current = encode(text);
      },
    };
  }

  it('sends Keep local after the connection is back, and asks again only about a newer version', async () => {
    const b = await online([], [['img.png', 'f1', 'v1']]);
    const downloads = servesDownloads(b);
    // Changed here without an event yet; a teammate's version comes.
    b.h.vault.files.set('img.png', encode('mine'));
    b.h.modal.binary = deferred();
    downloads.set('theirs');
    await b.server.teammateUpdate('f1', encode('theirs'));
    await flushAsync(20);
    expect(b.h.calls.filter((c) => c === 'modal.resolveBinaryConflict')).toHaveLength(1);
    // The connection drops before the answer.
    b.h.socket().disconnect();
    b.h.modal.binary.resolve('keep-local');
    await flushAsync(20);
    expect(queue(b.h)).toEqual(['UPDATE img.png']);

    downloads.set('theirs');
    await reconnect(b);
    // The teammate's version comes back with the catch-up: not asked again.
    expect(b.h.calls.filter((c) => c === 'modal.resolveBinaryConflict')).toHaveLength(1);
    const mine = await sha256Hex(encode('mine'));
    expect(b.server.files.get('f1')?.contentHash).toBe(mine);
    expect(b.h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(mine);
    expect(disk(b.h)).toEqual(['img.png=mine']);

    // A newer version of theirs is a new question.
    b.h.vault.files.set('img.png', encode('mine again'));
    downloads.set('newer');
    await b.server.teammateUpdate('f1', encode('newer'));
    await flushAsync(20);
    expect(b.h.calls.filter((c) => c === 'modal.resolveBinaryConflict')).toHaveLength(2);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('does not write the new version to the record when Keep local is refused', async () => {
    const b = await online([], [['img.png', 'f1', 'v1']]);
    servesDownloads(b).set('theirs');
    b.h.vault.files.set('img.png', encode('mine'));
    b.h.modal.binary = deferred();
    await b.server.teammateUpdate('f1', encode('theirs'));
    await flushAsync(20);
    b.server.files.delete('f1');
    b.h.modal.binary.resolve('keep-local');
    await b.server.pump();
    const v1 = await sha256Hex(encode('v1'));
    expect(b.h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(v1);
    await b.h.engine.stop();
  });
});

// -- A server that does not keep operations idempotent --------------------------------

describe('SyncEngine — a server without opIdempotency', () => {
  /**
   * An engine whose queue holds a delete of `a.md`, against a server that
   * `answer`s each `ops:status` — one older than the question never does: it
   * has no handler for it.
   */
  async function queuedAgainst(answer: (e: Emit) => void = () => undefined): Promise<{
    h: Harness;
    details: Array<string | undefined>;
    asked: () => number;
  }> {
    const log = await logOn(new FakeStorage());
    log.enqueueOperation('b1', { opType: 'DELETE', filePath: 'a.md', payload: { fileId: 'f1' } });
    let asked = 0;
    const h = buildHarness({
      log,
      opsStatusRetryMs: [0, 0, 0],
      opsStatusTimeoutMs: 5,
      statusResponder: (e) => {
        asked += 1;
        answer(e);
      },
    });
    const details: Array<string | undefined> = [];
    h.engine.onStatus((_status, detail) => details.push(detail));
    return { h, details, asked: () => asked };
  }

  function isProbe(e: Emit): boolean {
    const p = e.payload as { skipOperations?: unknown; skipYjsCatchup?: unknown };
    return e.event === 'project:join' && p.skipOperations === true && p.skipYjsCatchup === true;
  }

  it('with changes queued: asks ops:status, then tells by a join without catch-up; sends nothing', async () => {
    const { h, details, asked } = await queuedAgainst();
    await h.engine.start();
    await until(() => joinsOf(h) === 1);
    expect(asked()).toBe(4);
    const probe = await nextJoin(h, 0);
    expect(isProbe(probe)).toBe(true);
    probe.ack({ ok: true, operations: [], yjsSkipped: true, opIdempotency: undefined });
    await flushAsync(20);
    expect(h.engine.getStatus()).toBe('error');
    expect(details.at(-1)).toBe('server_outdated');

    // A change made now waits too.
    h.vault.files.set('n.md', encode('n\n'));
    await h.engine.handleVaultEvent(event('create', 'n.md'));
    await flushAsync(20);
    expect(h.socket().emits.map((e) => e.event)).toEqual(['project:join']);
    expect(queue(h)).toEqual(['DELETE a.md', 'CREATE n.md']);
    await h.engine.stop();
  });

  it('leaves the room of a server that has ops:status and answered no try: ops_status_failed', async () => {
    const { h, details } = await queuedAgainst();
    await h.engine.start();
    await until(() => joinsOf(h) === 1);
    (await nextJoin(h, 0)).ack({ ok: true, operations: [], yjsSkipped: true });
    await flushAsync(20);
    expect(details.at(-1)).toBe('ops_status_failed');
    expect(h.socket().emits.map((e) => e.event)).toEqual(['project:join', 'project:leave']);
    expect(h.socket().inRoom).toBe(false);
    expect(queue(h)).toEqual(['DELETE a.md']);
    await h.engine.stop();
  });

  it('reports the refusal of ops:status as the join would: project_not_found, no join', async () => {
    const { h, details, asked } = await queuedAgainst((e) =>
      e.ack({ ok: false, error: 'project_not_found' }),
    );
    await h.engine.start();
    await until(() => h.engine.getStatus() === 'error');
    expect(asked()).toBe(1);
    expect(details.at(-1)).toBe('project_not_found');
    expect(joinsOf(h)).toBe(0);
    expect(queue(h)).toEqual(['DELETE a.md']);
    await h.engine.stop();
  });

  it('with nothing queued: tells by the join, and sends nothing after its answer', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    b.h.socket().disconnect();
    await flushAsync();
    const joins = joinsOf(b.h);
    b.h.socket().connect();
    const join = await nextJoin(b.h, joins);
    const details: Array<string | undefined> = [];
    b.h.engine.onStatus((_status, detail) => details.push(detail));
    join.ack({ ...b.server.joinAnswer('whole journal'), opIdempotency: undefined });
    await flushAsync(40);
    expect(details.at(-1)).toBe('server_outdated');
    // Nothing asked with nothing queued: an older server never answers.
    expect(b.h.socket().statusQueries).toEqual([]);
    const out = sent(b.h).length;
    await userRename(b.h, 'a.md', 'b.md');
    await flushAsync(20);
    expect(sent(b.h).slice(out)).toEqual([]);
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md']);
    expect(b.server.applied).toEqual([]);
    await b.h.engine.stop();
  });

  // The join's answer told the server, but the check waited for the listing
  // too: a rename or a delete made in between went to the older server.
  it('with nothing queued: sends nothing from the answer to its join on, while the listing is on its way', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
    ]);
    b.h.socket().disconnect();
    await flushAsync();
    const joins = joinsOf(b.h);
    const release = holdListing(b.h);
    b.h.socket().connect();
    const join = await nextJoin(b.h, joins);
    const details: Array<string | undefined> = [];
    b.h.engine.onStatus((_status, detail) => details.push(detail));
    join.ack({ ...b.server.joinAnswer('whole journal'), opIdempotency: undefined });
    await flushAsync(20);
    const out = sent(b.h).length;

    await userRename(b.h, 'a.md', 'b.md');
    b.h.vault.files.delete('c.md');
    const deleted = b.h.engine.handleVaultEvent(event('delete', 'c.md'));
    await b.server.pump();
    await deleted;
    expect(sent(b.h).slice(out)).toEqual([]);
    expect(b.server.applied).toEqual([]);

    release();
    await flushAsync(40);
    expect(details.at(-1)).toBe('server_outdated');
    expect(sent(b.h).slice(out)).toEqual([]);
    expect(queue(b.h)).toEqual(['RENAME a.md -> b.md', 'DELETE c.md']);
    expect(b.server.applied).toEqual([]);
    await b.h.engine.stop();
  });
});

// -- Answers to questions whose answer was lost ---------------------------------------

describe('SyncEngine — Restore on server whose answer was lost', () => {
  /**
   * `Plan.md` (f1) edited offline while a teammate deleted it; asked about at
   * the next connect, the user answers **Restore on server**: its create is
   * on its way.
   */
  async function restoring(): Promise<Bench & { out: Emit }> {
    const b = await online([['Plan.md', 'f1', 'old\n']]);
    b.h.socket().disconnect();
    await flushAsync();
    b.h.vault.files.set('Plan.md', encode('old\nmine\n'));
    await b.h.engine.handleVaultEvent(event('modify', 'Plan.md'));
    await flushAsync(20);
    b.server.teammateDelete('f1');
    await reconnect(b);
    await flushAsync(20);
    expect(askedAboutCopy(b.h)).toBe(1);
    b.h.modal.del.resolve('restore-server');
    const out = await emitted(b.h, 'file:create');
    return { ...b, out };
  }

  /** The copy is the note the server brought back from it, its question settled. */
  function restored(b: Bench): void {
    expect(b.server.applied.filter((a) => a.startsWith('create'))).toEqual(['create Plan.md']);
    expect(b.docs.live()).toEqual(['Plan.md=old\nmine\n']);
    expect(disk(b.h)).toEqual(['Plan.md=old\nmine\n']);
    expect(b.h.engine.getFileIdForPath('Plan.md')).toBe('f1');
    expect(b.h.log.deleteAskedIds('b1')).toEqual(new Set());
    expect(queue(b.h)).toEqual([]);
    appliedOnce(b.server);
  }

  it('settles the question when the server applied it', async () => {
    const b = await restoring();
    loseAck(b.out);
    b.h.socket().disconnect();
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    // Never sent again from the queue: only the next connect settles it.
    expect(queue(b.h)).toEqual(['CREATE Plan.md']);
    await reconnect(b);
    expect(askedAboutCopy(b.h)).toBe(1);
    expect(b.h.socket().created()).toEqual(['Plan.md']);
    restored(b);
    await b.h.engine.stop();
  });

  it('settles the question when the server applied it, after a restart', async () => {
    const b = await restoring();
    loseAck(b.out);
    expect(b.server.serveNext()).toBe(true);
    await flushAsync(20);
    const next = await restart(b);
    expect(askedAboutCopy(next.h)).toBe(0);
    expect(next.h.socket().created()).toEqual([]);
    restored(next);
    await next.h.engine.stop();
  });

  it('asks again when the server never got it', async () => {
    const b = await restoring();
    b.server.delay(b.out);
    b.h.socket().disconnect();
    await flushAsync(20);
    b.h.modal.del = deferred();
    await reconnect(b);
    await flushAsync(20);
    expect(b.server.statusAnswers.at(-1)?.voided).toEqual([opIdOf(b.out)]);
    expect(askedAboutCopy(b.h)).toBe(2);
    expect(b.server.applied.filter((a) => a.startsWith('create'))).toEqual([]);
    expect(disk(b.h)).toEqual(['Plan.md=old\nmine\n']);
    expect(queue(b.h)).toEqual([]);

    // Answered again, it goes out under a new id.
    b.h.modal.del.resolve('restore-server');
    await b.docs.drive();
    const creates = b.h.socket().emits.filter((e) => e.event === 'file:create');
    expect(creates).toHaveLength(2);
    expect(opIdOf(creates[1] as Emit)).not.toBe(opIdOf(b.out));
    restored(b);
    await b.h.engine.stop();
  });
});

describe('SyncEngine — a file moved back whose answer was lost', () => {
  const v1 = 'v1\n';

  /**
   * `note.md` (f1), synced as v1 and edited here, renamed while this device
   * was away to `note?.md`, a name this client never writes; asked about,
   * the user answers **Restore on server**: its move back is on its way, and
   * the connection drops before the answer. `status` answers `ops:status`.
   */
  async function movingBack(status: {
    answer: (e: Emit) => void;
  }): Promise<{ h: Harness; out: Emit }> {
    const h = buildHarness({ statusResponder: (e) => status.answer(e) });
    h.vault.files.set('note.md', encode('v1\nunsent\n'));
    const hash = await sha256Hex(v1);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'note.md',
      serverFileId: 'f1',
      contentHash: hash,
      size: 3,
      fileType: 'TEXT',
      lastSyncedAt: 1,
      foldedHash: hash,
    });
    h.serverFiles = [serverFile('f1', 'note?.md', 'TEXT', hash, 3)];
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
    await h.engine.start();
    (await nextJoin(h, 0)).ack({
      ok: true,
      operations: [op('RENAME', 'note.md', 'note?.md', { fileId: 'f1' }, 1)],
      yjsDocs: [],
    });
    await flushAsync(60);
    expect(askedAboutCopy(h)).toBe(1);
    h.modal.del.resolve('restore-server');
    await flushAsync(20);
    const out = h.socket().pending('file:rename');
    expect(out.payload).toMatchObject({ fileId: 'f1', filePath: 'note?.md', newPath: 'note.md' });
    h.socket().disconnect();
    await flushAsync(20);
    expect(queue(h)).toEqual(['RENAME note?.md -> note.md']);
    return { h, out };
  }

  function renames(h: Harness): number {
    return h.socket().emits.filter((e) => e.event === 'file:rename').length;
  }

  it('settles the question when the server applied it', async () => {
    const status = { answer: voidEvery };
    const { h, out } = await movingBack(status);
    status.answer = (e): void => {
      e.ack({
        ok: true,
        applied: [
          {
            opId: opIdOf(out),
            opType: 'RENAME',
            logId: 'l9',
            filePath: 'note?.md',
            newPath: 'note.md',
            outcome: { kind: 'renamed', fileId: 'f1', from: 'note?.md', to: 'note.md' },
            vectorClock: { 'device-1': 9 },
            createdAt: '2026-01-01',
          },
        ],
        voided: [],
      });
    };
    h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', await sha256Hex(v1), 3)];
    h.socket().connect();
    (await joinToAnswer(h)).ack({
      ok: true,
      operations: [],
      yjsDocs: [snapshotOf(serverDocWith(v1), 'f1')],
    });
    await flushAsync(60);

    expect(askedAboutCopy(h)).toBe(1);
    expect(renames(h)).toBe(1);
    expect(queue(h)).toEqual([]);
    expect(h.engine.getFileIdForPath('note.md')).toBe('f1');
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    expect(joinClockOf(h)['device-1']).toBeGreaterThanOrEqual(9);
    await h.engine.stop();
  });

  it('asks again when the server never got it', async () => {
    const status = { answer: voidEvery };
    const { h } = await movingBack(status);
    h.modal.del = deferred();
    h.socket().connect();
    (await joinToAnswer(h)).ack({ ok: true, operations: [], yjsDocs: [] });
    await flushAsync(60);

    expect(askedAboutCopy(h)).toBe(2);
    expect(renames(h)).toBe(1);
    expect(queue(h)).toEqual([]);
    expect(h.vault.text('note.md')).toBe('v1\nunsent\n');
    await h.engine.stop();
  });
});

// -- What the server refuses -------------------------------------------------------

describe('SyncEngine — an operation the server refuses', () => {
  it('drops one refused for good, keeps one to send again under its id, a voided one under a new id', async () => {
    const entries: LogEntry[] = [];
    const logger = new Logger('debug', {
      write: (e) => {
        entries.push(e);
      },
    });
    const b = await online(
      [
        ['a.md', 'f1', 'a\n'],
        ['c.md', 'f2', 'c\n'],
        ['e.md', 'f3', 'e\n'],
        ['g.md', 'f4', 'g\n'],
      ],
      [],
      { logger },
    );
    /** Rename `from` here; the server answers `error` without applying it. */
    const refused = async (from: string, to: string, error: string): Promise<Emit> => {
      const out = await renameOut(b, from, to);
      b.server.delay(out);
      out.ack({ ok: false, error });
      await flushAsync(20);
      return out;
    };

    await refused('a.md', 'b.md', 'op_id_conflict');
    expect(queue(b.h)).toEqual([]);
    const busy = await refused('c.md', 'd.md', 'busy');
    expect(b.h.log.dequeueOperations('b1').map((entry) => entry.opId)).toEqual([opIdOf(busy)]);
    const voided = await refused('e.md', 'f.md', 'op_voided');
    const rotated = b.h.log.dequeueOperations('b1')[1];
    expect(rotated?.filePath).toBe('e.md');
    expect(isOpId(rotated?.opId)).toBe(true);
    expect(rotated?.opId).not.toBe(opIdOf(voided));
    const invalid = await refused('g.md', 'h.md', 'invalid_op_id');
    expect(queue(b.h)).toEqual([
      'RENAME c.md -> d.md',
      'RENAME e.md -> f.md',
      'RENAME g.md -> h.md',
    ]);
    expect(b.h.log.dequeueOperations('b1')[2]?.opId).toBe(opIdOf(invalid));
    expect(b.h.log.inFlightOperations('b1')).toEqual([]);
    expect(entries.filter((e) => e.message === 'the server refused an operation id')).toHaveLength(
      1,
    );
    expect(b.server.applied).toEqual([]);
    await b.h.engine.stop();
  });
});

// -- The requests, as the server's contract has them ------------------------------------

describe('SyncEngine — its requests have the keys of the contract’s examples', () => {
  /** The payload of the first `event` the socket sent. */
  function payloadOf(h: Harness, event: string): unknown {
    const found = h.socket().emits.find((e) => e.event === event);
    if (!found) throw new Error(`no ${event} sent`);
    return found.payload;
  }

  it('sends file:* and ops:status as tests/fixtures/protocol-0.4/request-* spell them', async () => {
    const b = await online([['a.md', 'f1', 'a\n']], [['img.png', 'f2', 'v1']]);
    await userRename(b.h, 'a.md', 'b.md');
    b.h.vault.files.set('img.png', encode('v2'));
    const modified = b.h.engine.handleVaultEvent(event('modify', 'img.png'));
    b.h.vault.files.set('new.md', encode('new\n'));
    const created = b.h.engine.handleVaultEvent(event('create', 'new.md'));
    await b.server.pump();
    await Promise.all([modified, created]);
    b.h.vault.files.delete('new.md');
    const deleted = b.h.engine.handleVaultEvent(event('delete', 'new.md'));
    await b.docs.drive();
    await deleted;
    // Offline, a rename waits in the queue: the next connect asks about it first.
    b.h.socket().disconnect();
    await userRename(b.h, 'b.md', 'c.md');
    await reconnect(b);

    // What the server's contract test sends as the plugin's requests: the same keys.
    for (const [event, example] of [
      ['file:create', 'request-file-create'], // a note: its bytes inline
      ['file:update-binary', 'request-file-update-binary'], // an attachment: bytes staged
      ['file:rename', 'request-file-rename'],
      ['file:delete', 'request-file-delete'],
    ] as const) {
      expect([event, shapeOf(payloadOf(b.h, event))]).toEqual([
        event,
        shapeOf(protocolFixture(example)),
      ]);
    }
    const asked = b.h.socket().statusQueries[0]?.payload;
    expect(shapeOf(asked)).toEqual(shapeOf(protocolFixture('ops-status-request')));
    expect(b.server.pathOf('f1')).toBe('c.md');
    appliedOnce(b.server);
    await b.h.engine.stop();
  });
});
