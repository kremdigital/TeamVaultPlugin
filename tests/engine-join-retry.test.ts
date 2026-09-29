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

/**
 * Hold every timer of one of {@link RETRY_MS}; the rest run on the real clock.
 */
function holdPauses(): void {
  held = [];
  win = stubWindow({
    setTimeout: (cb: () => void, ms?: number): unknown => {
      if (ms !== undefined && (RETRY_MS as readonly number[]).includes(ms)) {
        const pause: HeldPause = { ms, pass: cb, cleared: false };
        held.push(pause);
        return pause;
      }
      return setTimeout(cb, ms);
    },
    clearTimeout: (handle: unknown): void => {
      const pause = held.find((p) => p === handle);
      if (pause) pause.cleared = true;
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
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
    const tries = b.entries.filter(
      (e) => e.message === 'the server could not answer the join; joining again',
    );
    expect(tries.map((e) => (e.args[0] as { attempt?: number } | undefined)?.attempt)).toEqual([
      1, 2, 3, 4, 5,
    ]);

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
