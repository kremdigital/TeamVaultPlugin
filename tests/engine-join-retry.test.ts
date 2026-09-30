/**
 * The server could not answer `project:join`: it failed to read what the
 * answer needs (its database, say). It answers `join_failed` and takes the
 * socket out of the project's room; the refusal is one to ask again, on the
 * same connection (`sync-protocol.md`, «Подключение», «Отказ»).
 *
 * Before: the engine showed the error and waited for the next connect. The
 * device got no catch-up and, out of the room, no teammate's change at all
 * until Pause sync and Resume sync or a dropped connection — hours, maybe —
 * and the status and the notice said `join_failed`.
 *
 * Now the connect flow runs again on the same connection after 2, 5, 15, 30
 * and then every 60 seconds (`joinRetryMs`), until a join is taken. The try
 * belongs to the connection: a dropped connection, Pause sync, `stop()` and
 * a new connect call it off.
 *
 * The pauses are held (see {@link holdPauses}) and passed by the test: no
 * test waits for one.
 */
import type { RequestUrlResponse } from '@/client/api';
import type { YjsDocSnapshot } from '@/client/socket';
import { sha256Hex } from '@/sync/hash';
import { Logger, type LogEntry } from '@/utils/logger';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  joinsOf,
  json,
  nextJoin,
  type Emit,
  type Harness,
} from './engine-test-kit';
import { stubWindow, type WindowStub } from './window-stub';

jest.setTimeout(60_000);

// -- Helpers ------------------------------------------------------------------

/** The engine's pauses before it joins again, in the bench (`joinRetryMs`). */
const RETRY_MS = [7_001, 7_002, 7_003] as const;

/** A pause of the engine before it joins again, held until the test passes it. */
interface HeldPause {
  ms: number;
  pass: () => void;
  /** The engine called it off (`clearTimeout`). */
  cleared: boolean;
}

let held: HeldPause[] = [];
let win: WindowStub | null = null;

/** A timer of the engine's on the real clock: set, and whether it has neither fired nor been cleared. */
interface RealTimer {
  ms: number | undefined;
  pending: boolean;
}

/** Every timer of the engine's on the real clock, in the order it was set. */
let timers: RealTimer[] = [];

/**
 * Hold every timer of one of {@link RETRY_MS}; the rest run on the real clock,
 * and are kept in {@link timers}.
 */
function holdPauses(): void {
  held = [];
  timers = [];
  const real = new Map<unknown, RealTimer>();
  win = stubWindow({
    setTimeout: (cb: () => void, ms?: number): unknown => {
      if (ms !== undefined && (RETRY_MS as readonly number[]).includes(ms)) {
        const pause: HeldPause = { ms, pass: cb, cleared: false };
        held.push(pause);
        return pause;
      }
      const timer: RealTimer = { ms, pending: true };
      timers.push(timer);
      const handle = setTimeout(() => {
        timer.pending = false;
        cb();
      }, ms);
      real.set(handle, timer);
      return handle;
    },
    clearTimeout: (handle: unknown): void => {
      const pause = held.find((p) => p === handle);
      if (pause) {
        pause.cleared = true;
        return;
      }
      const timer = real.get(handle);
      if (timer) timer.pending = false;
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}

/**
 * The timers of the engine's set since the `from`-th one that still run and
 * would outlast a second: a wait of a flow still under way.
 */
function waitingSince(from: number): RealTimer[] {
  return timers.slice(from).filter((t) => t.pending && (t.ms ?? 0) > 1_000);
}

beforeEach(() => holdPauses());
afterEach(() => {
  win?.restore();
  win = null;
});

/** Wait, in real time, until `done()` holds; fails after 10 s. */
async function until(what: string, done: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  /** What the engine wrote to `sync.log`. */
  entries: LogEntry[];
  /** Every status the engine reported, as `status:detail`. */
  statuses: string[];
  /** The client ids the engine said another device uses (`onTwinDetected`). */
  twins: string[];
}

/**
 * Note `a.md` (`f1`) here, recorded, and on the server; the engine not
 * started. `ask`: who answers `ops:status` instead of the server — handed the
 * server's own answer.
 */
async function bench(
  opts: { ask?: (e: Emit, serve: (e: Emit) => void) => void } = {},
): Promise<Bench> {
  const entries: LogEntry[] = [];
  const logger = new Logger('debug', {
    write: (e) => {
      entries.push(e);
    },
  });
  const twins: string[] = [];
  let server: FakeServer | null = null;
  const ask = opts.ask;
  const h = buildHarness({
    logger,
    joinRetryMs: RETRY_MS,
    // No test waits for the pauses between tries of `ops:status` either.
    opsStatusRetryMs: [0, 0, 0],
    onTwinDetected: (id) => void twins.push(id),
    ...(ask
      ? {
          statusResponder: (e: Emit): void =>
            ask(e, (q) => {
              server?.answerStatus(q);
            }),
        }
      : {}),
  });
  server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
  const statuses: string[] = [];
  h.engine.onStatus((status, detail) => statuses.push(`${status}:${detail ?? ''}`));
  const text = 'a\n';
  const hash = await sha256Hex(text);
  h.vault.files.set('a.md', encode(text));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'a.md',
    serverFileId: 'f1',
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
  await docs.add('f1', 'a.md', text);
  return { h, server, docs, entries, statuses, twins };
}

/** The server fails the engine's `n`-th join (0-based): `join_failed`. */
async function failJoin(b: Bench, n: number): Promise<void> {
  const pauses = held.length;
  (await nextJoin(b.h, n)).ack({ ok: false, error: 'join_failed' });
  await until('the pause before the next try', () => held.length === pauses + 1);
}

/** The server takes the engine's `n`-th join (0-based), with the whole catch-up. */
async function takeJoin(b: Bench, n: number): Promise<void> {
  (await nextJoin(b.h, n)).ack(
    b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
  );
  await b.docs.drive();
  await until('connected', () => b.h.engine.getStatus() === 'connected');
}

/** The `i`-th pause (0-based), still set, passes. */
function pass(i: number): void {
  const pause = held[i];
  if (!pause) throw new Error(`no pause ${i}`);
  expect(pause.cleared).toBe(false);
  pause.pass();
}

function text(b: Bench, path: string): string | null {
  const data = b.h.vault.files.get(path);
  return data === undefined ? null : new TextDecoder().decode(data);
}

/** How many times the engine opened its socket. */
function connects(b: Bench): number {
  return b.h.calls.filter((c) => c === 'socket.connect').length;
}

/** A new try the engine set up, as `sync.log` says it. */
interface TryLine {
  step?: string;
  error?: string;
  attempt?: number;
}

/** Each new try the engine set up, in order. */
function triesOf(b: Bench): TryLine[] {
  return b.entries
    .filter((e) => e.message === 'the server could not answer for now; joining again')
    .map((e) => (e.args[0] ?? {}) as TryLine);
}

// -- Tests --------------------------------------------------------------------

describe('SyncEngine — a join the server could not answer (join_failed)', () => {
  it('joins again on the same connection after a pause, and gets what it missed', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    expect(b.statuses).toEqual(['connecting:', 'syncing:', 'error:join_failed']);
    expect(held.map((p) => p.ms)).toEqual([RETRY_MS[0]]);
    // Out of the room: a teammate's edit made now does not reach this device.
    expect(b.h.socket().inRoom).toBe(false);
    await b.docs.restWrite('f1', 'a\nteammate\n');
    await flushAsync();
    expect(text(b, 'a.md')).toBe('a\n');
    expect(joinsOf(b.h)).toBe(1);

    pass(0);
    const again = await nextJoin(b.h, 1);
    expect((again.payload as { projectId?: string }).projectId).toBe('p1');
    // The same connection: no reconnect, and the error on show until the
    // join is taken.
    expect(connects(b)).toBe(1);
    expect(b.statuses).toEqual(['connecting:', 'syncing:', 'error:join_failed']);

    await takeJoin(b, 1);
    expect(b.statuses.slice(3)).toEqual(['syncing:', 'connected:']);
    expect(b.h.socket().inRoom).toBe(true);
    await until('the edit made meanwhile on disk', () => text(b, 'a.md') === 'a\nteammate\n');

    // In the room again: a teammate's edit reaches this device live.
    await b.docs.restWrite('f1', 'a\nteammate\nagain\n');
    await b.docs.drive();
    await until('the live edit on disk', () => text(b, 'a.md') === 'a\nteammate\nagain\n');
    expect(joinsOf(b.h)).toBe(2);
    expect(held).toHaveLength(1);
    await b.h.engine.stop();
  });

  it('waits longer after each refusal, the last pause again and again, and says the error once', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    for (let i = 0; i < 4; i++) {
      pass(i);
      await failJoin(b, i + 1);
    }
    expect(held.map((p) => p.ms)).toEqual([...RETRY_MS, RETRY_MS[2], RETRY_MS[2]]);
    // `error` and no `syncing` in between: the plugin announces an error when
    // the status turns to it, and a flip at each try announced it again.
    expect(b.statuses.slice(2).every((s) => s === 'error:join_failed')).toBe(true);
    const tries = triesOf(b);
    expect(tries.map((t) => t.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(tries.every((t) => t.step === 'project:join' && t.error === 'join_failed')).toBe(true);

    pass(4);
    await takeJoin(b, 5);
    expect(b.statuses.slice(-2)).toEqual(['syncing:', 'connected:']);
    await b.h.engine.stop();
  });

  it.each(['invalid_payload', 'project_not_found', 'user_not_found', 'forbidden'])(
    'does not join again after %s: asking again changes nothing',
    async (error) => {
      const b = await bench();
      await b.h.engine.start();
      (await nextJoin(b.h, 0)).ack({ ok: false, error });
      await until('the refusal shown', () => b.h.engine.getStatus() === 'error');
      await flushAsync();
      expect(held).toEqual([]);
      expect(joinsOf(b.h)).toBe(1);
      expect(b.statuses.at(-1)).toBe(`error:${error}`);
      await b.h.engine.stop();
    },
  );

  it('a dropped connection calls the try off; the next connect joins once', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    b.h.socket().disconnect();
    expect(held[0]?.cleared).toBe(true);

    b.h.socket().connect();
    await takeJoin(b, 1);
    // A pause that would have passed anyway brings no join of its own.
    held[0]?.pass();
    await flushAsync();
    expect(joinsOf(b.h)).toBe(2);
    expect(connects(b)).toBe(1);
    expect(b.h.engine.getStatus()).toBe('connected');
    await b.h.engine.stop();
  });

  it('a connection that drops right as the pause passes gets no join', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    // The pause's timer has fired; the flow waiting on it has not woken yet.
    pass(0);
    b.h.socket().disconnect();
    await flushAsync();
    expect(joinsOf(b.h)).toBe(1);
    expect(b.h.engine.getStatus()).toBe('offline');

    b.h.socket().connect();
    await takeJoin(b, 1);
    expect(joinsOf(b.h)).toBe(2);
    await b.h.engine.stop();
  });

  it('Pause sync calls the try off; Resume sync joins once', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    b.h.engine.pause();
    expect(held[0]?.cleared).toBe(true);
    expect(b.h.engine.getStatus()).toBe('offline');

    // Resume sync opens a socket of its own: this is its first join.
    await b.h.engine.resume();
    await takeJoin(b, 0);
    held[0]?.pass();
    await flushAsync();
    expect(joinsOf(b.h)).toBe(1);
    expect(connects(b)).toBe(2);
    expect(b.h.engine.getStatus()).toBe('connected');
    await b.h.engine.stop();
  });

  it('stop() calls the try off: nothing goes out after it', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    await b.h.engine.stop();
    expect(held[0]?.cleared).toBe(true);
    const emits = b.h.socket().emits.length;
    held[0]?.pass();
    await flushAsync();
    expect(b.h.socket().emits).toHaveLength(emits);
    expect(b.h.engine.getStatus()).toBe('stopped');
  });

  it('joins again after the join that tells the server’s kind is refused join_failed', async () => {
    // The first four questions go unanswered (the client's own timeout): the
    // engine tells the server's kind by a join without catch-up.
    let asked = 0;
    const b = await bench({
      ask: (e, serve) => {
        asked += 1;
        if (asked <= 4) e.ack({ ok: false, error: 'timeout' });
        else serve(e);
      },
    });
    // A change waits in the queue: each connect asks ops:status first.
    b.h.log.enqueueOperation('b1', {
      opType: 'DELETE',
      filePath: 'a.md',
      payload: { fileId: 'f1' },
    });
    await b.h.engine.start();
    await failJoin(b, 0);
    const probe = (await nextJoin(b.h, 0)).payload as { skipOperations?: boolean };
    expect(probe.skipOperations).toBe(true);
    expect(asked).toBe(4);
    expect(b.statuses.at(-1)).toBe('error:join_failed');

    pass(0);
    // The try asks again before its join.
    const again = await nextJoin(b.h, 1);
    expect(asked).toBe(5);
    expect((again.payload as { skipOperations?: boolean }).skipOperations).toBeUndefined();
    await takeJoin(b, 1);
    await b.h.engine.stop();
  });

  it('a change made while the try waits goes to the queue, and out after the catch-up', async () => {
    const b = await bench();
    await b.h.engine.start();
    await failJoin(b, 0);
    // Sent now, it could still be on its way when the try reads the listing,
    // and the try would wait for it: it waits for the try instead.
    await b.h.vault.rename('a.md', 'b.md');
    await b.h.settle();
    expect(b.h.socket().emits.filter((e) => e.event === 'file:rename')).toEqual([]);
    expect(b.h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.newPath}`)).toEqual([
      'RENAME b.md',
    ]);

    pass(0);
    await takeJoin(b, 1);
    await b.docs.drive();
    expect(b.server.pathOf('f1')).toBe('b.md');
    expect([...b.h.vault.files.keys()].sort()).toEqual(['b.md']);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    await b.h.engine.stop();
  });

  it('waits for the answer of a change sent while the refused join was on its way', async () => {
    const b = await bench();
    await connect(b.h, { yjsDocs: b.docs.snapshots() });
    await b.docs.drive();
    b.h.socket().disconnect();
    b.h.socket().connect();
    const join = await nextJoin(b.h, 1);
    // Renamed while the join is on its way: the rename goes out at once, and
    // reaches the server late.
    await b.h.vault.rename('a.md', 'b.md');
    await until('the rename out', () => b.h.socket().emits.some((e) => e.event === 'file:rename'));
    const rename = b.h.socket().pending('file:rename');
    b.server.delay(rename);
    join.ack({ ok: false, error: 'join_failed' });
    await until('the pause', () => held.length === 1);

    pass(0);
    await flushAsync();
    // The listing the try reads would have the note under its old name, and
    // the note was moved back there on disk: the try waits for the answer.
    expect(joinsOf(b.h)).toBe(2);
    b.server.deliverLate(rename);
    await takeJoin(b, 2);
    await b.docs.drive();
    expect(b.server.pathOf('f1')).toBe('b.md');
    expect([...b.h.vault.files.keys()].sort()).toEqual(['b.md']);
    expect(b.h.engine.getFileIdForPath('b.md')).toBe('f1');
    await b.h.engine.stop();
  });

  it('keeps what the server answered on this connection: such a change is not taken for a twin’s', async () => {
    const b = await bench();
    // Synced once: the binding has a state, and a twin would be told.
    await connect(b.h, { yjsDocs: b.docs.snapshots() });
    await b.docs.drive();
    b.h.socket().disconnect();
    b.h.socket().connect();
    const join = await nextJoin(b.h, 1);

    // Renamed while the join is on its way: the rename goes out at once, and
    // is answered.
    await b.h.vault.rename('a.md', 'b.md');
    await until('the rename out', () => b.h.socket().emits.some((e) => e.event === 'file:rename'));
    await b.server.pump();
    await b.h.settle();
    expect(b.server.pathOf('f1')).toBe('b.md');
    join.ack({ ok: false, error: 'join_failed' });
    await until('the pause', () => held.length === 1);

    pass(0);
    // The catch-up returns this device's rename too (the server's safeguard
    // case: a clock that has not taken it in).
    (await nextJoin(b.h, 2)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots(), clock: {} }),
    );
    await b.docs.drive();
    await until('connected', () => b.h.engine.getStatus() === 'connected');
    expect(b.twins).toEqual([]);
    expect([...b.h.vault.files.keys()].sort()).toEqual(['b.md']);
    await b.h.engine.stop();
  });
});

// -- The server still down at the next try -----------------------------------

/**
 * How the server answers the listing of the project's files: as it is, 500
 * (its database down fails the REST route too), not reached at all, or 403.
 */
type Listing = 'ok' | 'HTTP 500' | 'unreachable' | 'HTTP 403';

const LISTING = 'GET /api/projects/p1/files';

interface Listings {
  /** How the listings are answered, from the moment each is answered. */
  mode: Listing;
  /** Hold each listing asked for from now on, until {@link release}. */
  hold: boolean;
  /** The listings held, not answered yet. */
  held: Array<() => void>;
  /** Answer every listing held, as {@link mode} says. */
  release: () => void;
}

/** The listings of the bench's engine, answered as the test says. */
function listingsOf(b: Bench): Listings {
  const serve = b.h.routes.get(LISTING);
  if (!serve) throw new Error('no listing route');
  const answer = async (mode: Listing): Promise<RequestUrlResponse> => {
    switch (mode) {
      case 'ok':
        return serve();
      case 'HTTP 500':
        return json({ error: 'Internal Server Error' }, 500);
      case 'HTTP 403':
        return json({ error: 'forbidden' }, 403);
      case 'unreachable':
        throw new Error('net::ERR_CONNECTION_REFUSED');
    }
  };
  const listings: Listings = {
    mode: 'ok',
    hold: false,
    held: [],
    release: () => {
      const waiting = listings.held;
      listings.held = [];
      for (const go of waiting) go();
    },
  };
  b.h.routes.set(LISTING, () => {
    if (!listings.hold) return answer(listings.mode);
    return new Promise<RequestUrlResponse>((resolve, reject) => {
      listings.held.push(() => void answer(listings.mode).then(resolve, reject));
    });
  });
  return listings;
}

/**
 * How the server answers `ops:status`: as it does, with the text of its
 * database's error (the handler's `catch`), `busy`, no answer (`timeout`, the
 * client's own), or a refusal for good.
 */
type Status =
  | 'serve'
  | 'db down'
  | 'busy'
  | 'timeout'
  | 'invalid_payload'
  | 'project_not_found'
  | 'user_not_found'
  | 'forbidden';

/** A bench whose `ops:status` is answered as `status.mode` says. */
async function benchAsking(): Promise<{ b: Bench; status: { mode: Status; asked: number } }> {
  const status: { mode: Status; asked: number } = { mode: 'serve', asked: 0 };
  const b = await bench({
    ask: (e, serve) => {
      status.asked += 1;
      if (status.mode === 'serve') serve(e);
      else if (status.mode === 'db down') {
        e.ack({ ok: false, error: "Can't reach database server at `db:5432`" });
      } else e.ack({ ok: false, error: status.mode });
    },
  });
  return { b, status };
}

/** `a.md` renamed to `b.md` here: queued, with the socket down or the try waiting. */
async function renameHere(b: Bench): Promise<void> {
  await b.h.vault.rename('a.md', 'b.md');
  await b.h.settle();
  expect(queued(b)).toEqual(['RENAME b.md']);
}

/** The offline queue of the bench's engine. */
function queued(b: Bench): string[] {
  return b.h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.newPath}`);
}

/** Every status from `from` on is the first `join_failed`: in words, never another code. */
function saysJoinFailedSince(b: Bench, from: number): void {
  expect(b.statuses[from]).toBe('error:join_failed');
  expect(b.statuses.slice(from).filter((s) => s !== 'error:join_failed')).toEqual([]);
}

/** The rename made here went out once the vault caught up: the note is `b.md` everywhere. */
async function renamedEverywhere(b: Bench): Promise<void> {
  await b.docs.drive();
  await until('the rename on the server', () => b.server.pathOf('f1') === 'b.md');
  expect([...b.h.vault.files.keys()].sort()).toEqual(['b.md']);
  expect(queued(b)).toEqual([]);
  // Once, and nothing else from here: a teammate's write aside.
  expect(b.server.applied.filter((a) => !a.startsWith('write '))).toEqual(['f1 a.md -> b.md']);
}

/** A `yjs:catchup` batch on the engine's connection, as the server streams it. */
function streamBatch(b: Bench, docs: YjsDocSnapshot[], done: boolean): void {
  b.h.socket().fire('yjs:catchup', { projectId: 'p1', docs, done });
}

describe('SyncEngine — the tries while the server is still down', () => {
  // The server's database down fails the listing (`GET …/files`) with the
  // join. Awaited together with `Promise.all`, the listing's failure ended
  // the flow as `server (HTTP 500)`, the join's `join_failed` was never read,
  // and no try came: the vault stayed out of the room.
  it.each([
    ['HTTP 500', 'the listing'],
    ['HTTP 500', 'the join'],
    ['unreachable', 'the listing'],
    ['unreachable', 'the join'],
  ] as const)(
    'joins again when the listing failed for now (%s) with the refused join, %s answered first',
    async (failure, first) => {
      const b = await bench();
      const listings = listingsOf(b);
      listings.mode = failure;
      listings.hold = true;
      await b.h.engine.start();
      const join = await nextJoin(b.h, 0);
      await until('the listing asked for', () => listings.held.length === 1);
      if (first === 'the listing') {
        listings.release();
        await flushAsync();
        join.ack({ ok: false, error: 'join_failed' });
      } else {
        join.ack({ ok: false, error: 'join_failed' });
        await flushAsync();
        listings.release();
      }
      await until('the pause before the next try', () => held.length === 1);
      expect(b.statuses).toEqual(['connecting:', 'syncing:', 'error:join_failed']);
      expect(b.h.socket().inRoom).toBe(false);
      expect(triesOf(b)).toEqual([
        expect.objectContaining({ step: 'project:join', error: 'join_failed', attempt: 1 }),
      ]);

      // The server is back.
      listings.mode = 'ok';
      listings.hold = false;
      await b.docs.restWrite('f1', 'a\nteammate\n');
      pass(0);
      await takeJoin(b, 1);
      expect(b.statuses.slice(3)).toEqual(['syncing:', 'connected:']);
      expect(b.h.socket().inRoom).toBe(true);
      await until('the edit made meanwhile on disk', () => text(b, 'a.md') === 'a\nteammate\n');
      await b.h.engine.stop();
    },
  );

  // A listing that failed for now waits for the join's answer. The connection
  // dropping, Pause sync or `stop()` meanwhile ends the flow with it, as when
  // the listing was still on its way: no try is set up, no error shown, and
  // the join's late answer does nothing.
  it.each(['drop', 'pause', 'stop'] as const)(
    '%s while the flow waits for the join after the listing failed for now: no try',
    async (cut) => {
      const b = await bench();
      const listings = listingsOf(b);
      listings.mode = 'HTTP 500';
      listings.hold = true;
      await b.h.engine.start();
      const join = await nextJoin(b.h, 0);
      await until('the listing asked for', () => listings.held.length === 1);
      listings.release();
      await flushAsync();
      expect(b.h.engine.getStatus()).toBe('syncing');

      const old = b.h.socket();
      if (cut === 'drop') old.disconnect();
      else if (cut === 'pause') b.h.engine.pause();
      else await b.h.engine.stop();
      await flushAsync();
      join.ack({ ok: false, error: 'join_failed' });
      await flushAsync();
      expect(held).toEqual([]);
      expect(triesOf(b)).toEqual([]);
      expect(b.statuses.filter((s) => s.startsWith('error:'))).toEqual([]);
      expect(joinsOf(b.h)).toBe(1);
      if (cut === 'stop') {
        expect(b.h.engine.getStatus()).toBe('stopped');
        return;
      }
      expect(b.h.engine.getStatus()).toBe('offline');

      listings.mode = 'ok';
      listings.hold = false;
      if (cut === 'drop') {
        old.connect();
        await takeJoin(b, 1);
        expect(connects(b)).toBe(1);
      } else {
        await b.h.engine.resume();
        // Resume sync opens a socket of its own: this is its first join.
        await takeJoin(b, 0);
        expect(connects(b)).toBe(2);
      }
      expect(b.h.socket().inRoom).toBe(true);
      expect(held).toEqual([]);
      await b.h.engine.stop();
    },
  );

  it('ends as before when the listing is refused for good with the refused join: no try', async () => {
    const b = await bench();
    const listings = listingsOf(b);
    listings.mode = 'HTTP 403';
    await b.h.engine.start();
    (await nextJoin(b.h, 0)).ack({ ok: false, error: 'join_failed' });
    await until('the error', () => b.h.engine.getStatus() === 'error');
    await flushAsync();
    expect(b.statuses.at(-1)).toBe('error:forbidden (HTTP 403)');
    expect(held).toEqual([]);
    expect(joinsOf(b.h)).toBe(1);
    await b.h.engine.stop();
  });

  // Outside a chain of tries, only a join refused `join_failed` makes the
  // listing's failure one to try again after: a join taken, or refused for
  // good, ends the flow with the listing's error, and the next connect lists
  // again.
  it.each([
    ['taken', null],
    ['refused for good', 'project_not_found'],
  ] as const)(
    'ends as before when the listing fails for now with a join %s outside the tries: no try',
    async (_how, refusal) => {
      const b = await bench();
      const listings = listingsOf(b);
      listings.mode = 'HTTP 500';
      await b.h.engine.start();
      (await nextJoin(b.h, 0)).ack(
        refusal === null ? b.server.joinAnswer('whole journal') : { ok: false, error: refusal },
      );
      await until('the error', () => b.h.engine.getStatus() === 'error');
      await flushAsync();
      expect(b.statuses).toEqual(['connecting:', 'syncing:', 'error:server (HTTP 500)']);
      expect(held).toEqual([]);
      expect(triesOf(b)).toEqual([]);
      expect(joinsOf(b.h)).toBe(1);
      await b.h.engine.stop();
    },
  );

  it('goes on trying when the next try’s listing fails with its join', async () => {
    const b = await bench();
    const listings = listingsOf(b);
    await b.h.engine.start();
    await failJoin(b, 0);

    listings.mode = 'HTTP 500';
    pass(0);
    await failJoin(b, 1);
    expect(held.map((p) => p.ms)).toEqual([RETRY_MS[0], RETRY_MS[1]]);
    saysJoinFailedSince(b, 2);
    expect(b.h.socket().inRoom).toBe(false);
    // Out of the room: a teammate's edit made now comes with the catch-up.
    await b.docs.restWrite('f1', 'a\nteammate\n');
    await flushAsync();
    expect(text(b, 'a.md')).toBe('a\n');

    listings.mode = 'ok';
    pass(1);
    await takeJoin(b, 2);
    expect(b.statuses.slice(-2)).toEqual(['syncing:', 'connected:']);
    expect(triesOf(b).map((t) => `${t.attempt} ${t.step}`)).toEqual([
      '1 project:join',
      '2 project:join',
    ]);
    await until('the edit made meanwhile on disk', () => text(b, 'a.md') === 'a\nteammate\n');
    await b.h.engine.stop();
  });

  it('a try whose join is taken and whose listing fails: the next one comes after that join’s catch-up stream', async () => {
    const b = await bench();
    const listings = listingsOf(b);
    await b.h.engine.start();
    await failJoin(b, 0);

    listings.mode = 'HTTP 500';
    pass(0);
    // Taken; the server streams its docs after the answer, whatever the
    // flow makes of it.
    (await nextJoin(b.h, 1)).ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
    await until('the next pause', () => held.length === 2);
    saysJoinFailedSince(b, 2);
    expect(triesOf(b).at(-1)).toEqual(
      expect.objectContaining({ step: 'listing', error: 'server (HTTP 500)', attempt: 2 }),
    );
    streamBatch(b, b.docs.snapshots(), false);

    listings.mode = 'ok';
    pass(1);
    await flushAsync();
    // Still streaming: a join now would stream on the same connection, and
    // the rest of the old stream would be taken for its own.
    expect(joinsOf(b.h)).toBe(2);

    streamBatch(b, [], true);
    const third = await nextJoin(b.h, 2);
    // This join's own stream: the try waits for it, not for the old one's end.
    third.ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
    await flushAsync();
    expect(b.h.engine.getStatus()).toBe('syncing');
    streamBatch(b, b.docs.snapshots(), true);
    await b.docs.drive();
    await until('connected', () => b.h.engine.getStatus() === 'connected');
    expect(joinsOf(b.h)).toBe(3);
    expect(text(b, 'a.md')).toBe('a\n');
    await b.h.engine.stop();
  });

  it('a stream that ended before the try read its join’s answer is not waited for', async () => {
    const b = await bench();
    const listings = listingsOf(b);
    await b.h.engine.start();
    await failJoin(b, 0);

    listings.mode = 'HTTP 500';
    pass(0);
    // The bench streams the docs as soon as the join is answered: the `done`
    // batch comes before the flow reads the answer.
    (await nextJoin(b.h, 1)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
    );
    await until('the next pause', () => held.length === 2);

    listings.mode = 'ok';
    pass(1);
    await takeJoin(b, 2);
    expect(joinsOf(b.h)).toBe(3);
    await b.h.engine.stop();
  });

  it('a teammate’s rename that reaches the vault between the tries is applied once', async () => {
    const b = await bench();
    const listings = listingsOf(b);
    await b.h.engine.start();
    await failJoin(b, 0);

    listings.mode = 'HTTP 500';
    pass(0);
    (await nextJoin(b.h, 1)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
    );
    await until('the next pause', () => held.length === 2);
    // The join was taken: the socket is in the room, and the broadcast comes.
    expect(b.h.socket().inRoom).toBe(true);
    b.server.teammateRename('f1', 'c.md');
    await until('the rename on disk', () => b.h.vault.files.has('c.md'));

    listings.mode = 'ok';
    pass(1);
    // The catch-up returns the rename.
    await takeJoin(b, 2);
    await b.docs.drive();
    expect([...b.h.vault.files.keys()].sort()).toEqual(['c.md']);
    expect(b.h.engine.getFileIdForPath('c.md')).toBe('f1');
    expect(b.server.pathOf('f1')).toBe('c.md');
    expect(b.server.applied).toEqual(['f1 a.md -> c.md']);
    await b.h.engine.stop();
  });

  // The try asks `ops:status` first whenever a change waits in the queue —
  // one made while it waited, one queued before the connect. The server's
  // database down fails the question as it fails the join; answered with an
  // error of the server's own (not busy, not a timeout), it ended the tries
  // as `ops_status_failed`, as did `busy` until the questions ran out.
  it.each([
    ['db down', 'while the try waits'],
    ['db down', 'before the connect'],
    ['busy', 'while the try waits'],
  ] as const)(
    'goes on trying when the next try’s ops:status fails for now (%s), the change queued %s',
    async (failure, queuedWhen) => {
      const { b, status } = await benchAsking();
      if (queuedWhen === 'before the connect') await renameHere(b);
      await b.h.engine.start();
      await failJoin(b, 0);
      if (queuedWhen === 'while the try waits') await renameHere(b);

      status.mode = failure;
      const asked = status.asked;
      pass(0);
      await until('the next pause', () => held.length === 2);
      // Asked (again and again after `busy`), and no join sent.
      expect(status.asked).toBe(asked + (failure === 'busy' ? 4 : 1));
      expect(joinsOf(b.h)).toBe(1);
      expect(b.h.socket().inRoom).toBe(false);
      saysJoinFailedSince(b, 2);
      expect(triesOf(b).at(-1)).toEqual(
        expect.objectContaining({ step: 'ops:status', attempt: 2 }),
      );
      expect(queued(b)).toEqual(['RENAME b.md']);
      // Out of the room: a teammate's edit made now comes with the catch-up.
      await b.docs.restWrite('f1', 'a\nteammate\n');
      await flushAsync();
      expect(text(b, 'b.md')).toBe('a\n');

      // The server is back.
      status.mode = 'serve';
      pass(1);
      await takeJoin(b, 1);
      expect(b.statuses.slice(-2)).toEqual(['syncing:', 'connected:']);
      await renamedEverywhere(b);
      await until('the edit made meanwhile on disk', () => text(b, 'b.md') === 'a\nteammate\n');
      await b.h.engine.stop();
    },
  );

  it('goes on trying after a try whose ops:status went unanswered, from a server that has it', async () => {
    const { b, status } = await benchAsking();
    await b.h.engine.start();
    await failJoin(b, 0);
    await renameHere(b);

    status.mode = 'timeout';
    pass(0);
    // Four questions without an answer: the join that tells the server's
    // kind, answered by one that has `ops:status`.
    const probe = await nextJoin(b.h, 1);
    expect((probe.payload as { skipOperations?: boolean }).skipOperations).toBe(true);
    probe.ack({ ok: true, operations: [], yjsSkipped: true });
    await until('the next pause', () => held.length === 2);
    expect(b.h.socket().inRoom).toBe(false);
    saysJoinFailedSince(b, 2);

    status.mode = 'serve';
    pass(1);
    await takeJoin(b, 2);
    await renamedEverywhere(b);
    await b.h.engine.stop();
  });

  it.each(['invalid_payload', 'project_not_found', 'user_not_found', 'forbidden'] as const)(
    'stops trying when the next try’s ops:status is refused for good (%s)',
    async (refusal) => {
      const { b, status } = await benchAsking();
      await b.h.engine.start();
      await failJoin(b, 0);
      await renameHere(b);

      status.mode = refusal;
      pass(0);
      await until('the refusal shown', () => b.statuses.at(-1) === `error:${refusal}`);
      await flushAsync();
      expect(held).toHaveLength(1);
      expect(joinsOf(b.h)).toBe(1);
      // Nothing is lost: the change waits for the next connect.
      expect(queued(b)).toEqual(['RENAME b.md']);
      await b.h.engine.stop();
    },
  );

  it.each(['drop', 'pause', 'stop'] as const)(
    '%s while the try waits for the old catch-up stream calls the try off',
    async (cut) => {
      const b = await bench();
      const listings = listingsOf(b);
      await b.h.engine.start();
      await failJoin(b, 0);
      listings.mode = 'HTTP 500';
      pass(0);
      (await nextJoin(b.h, 1)).ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
      await until('the next pause', () => held.length === 2);
      listings.mode = 'ok';
      const mark = timers.length;
      pass(1);
      await flushAsync();
      expect(joinsOf(b.h)).toBe(2);

      const old = b.h.socket();
      if (cut === 'stop') {
        await b.h.engine.stop();
        await flushAsync();
        // The wait ended with the engine: nothing of the try's still runs.
        expect(waitingSince(mark)).toEqual([]);
        const emits = old.emits.length;
        streamBatch(b, [], true);
        await flushAsync();
        expect(old.emits).toHaveLength(emits);
        expect(b.h.engine.getStatus()).toBe('stopped');
        return;
      }
      if (cut === 'drop') {
        old.disconnect();
        await flushAsync();
        expect(waitingSince(mark)).toEqual([]);
        old.connect();
        await takeJoin(b, 2);
        expect(joinsOf(b.h)).toBe(3);
        expect(connects(b)).toBe(1);
      } else {
        b.h.engine.pause();
        await flushAsync();
        expect(waitingSince(mark)).toEqual([]);
        await b.h.engine.resume();
        // Resume sync opens a socket of its own: this is its first join.
        await takeJoin(b, 0);
        expect(joinsOf(b.h)).toBe(1);
        expect(connects(b)).toBe(2);
        // Nothing of the connection closed was still running to wait for.
        expect(
          b.entries.filter(
            (e) => e.message === 'connecting again while the previous connection’s work still runs',
          ),
        ).toEqual([]);
      }
      expect(b.h.engine.getStatus()).toBe('connected');
      await b.h.engine.stop();
    },
  );

  it('a try waits for no stream of a connection gone', async () => {
    const b = await bench();
    await b.h.engine.start();
    // Taken; the connection drops before its stream ends.
    (await nextJoin(b.h, 0)).ack({ ...b.server.joinAnswer('whole journal'), yjsStream: true });
    await flushAsync();
    b.h.socket().disconnect();
    b.h.socket().connect();
    await failJoin(b, 1);
    pass(0);
    await takeJoin(b, 2);
    expect(joinsOf(b.h)).toBe(3);
    await b.h.engine.stop();
  });
});
