/**
 * Renames whose answers were lost (TASK-0035, spec §9.2): the reproductions of
 * the 0.3.8 review rounds — V1, V2, VF, Q, R — as regression tests.
 *
 * A chain of renames of one note, or renames of several notes, goes out. Some
 * reach the server, some of their answers come back, and then the connection
 * is cut: Pause sync, the connection dropping, the plugin turned off, Obsidian
 * quitting (its quit writes `state.json`) or the process dying (the disk as it
 * was). A teammate may rename a note meanwhile. Before operation ids, the
 * device recognised at best the last rename it had sent: an earlier one went
 * out again and undid the teammate's rename for everyone, or the user's last
 * rename was lost.
 *
 * Expected in every case:
 *   - R1: the server applies each operation once — no rename twice, no opId
 *     twice, nothing answered as a resend;
 *   - R3: nothing sent again undoes a teammate's later rename;
 *   - R4: each note ends under the last rename in the server's order: the
 *     user's last one, or the teammate's made after it.
 */
import { sha256Hex } from '@/sync/hash';
import type { OperationLog } from '@/sync/operation-log';
import {
  FakeServer,
  FakeStorage,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  joinClockOf,
  joinToAnswer,
  logOn,
  NEVER_FLUSHED,
  restartFromDisk,
  userRename,
  type Cut,
  type Emit,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

// -- Helpers ------------------------------------------------------------------

type Seed = ReadonlyArray<readonly [path: string, fileId: string, text: string]>;

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  storage: FakeStorage;
}

/** Logs whose debounce never runs out: closed after each test. */
const opened: OperationLog[] = [];

afterEach(async () => {
  for (const log of opened.splice(0)) await log.close();
});

/** Notes on disk, in `state.json` and on the server; connected, the catch-up done. */
async function online(notes: Seed): Promise<Bench> {
  const storage = new FakeStorage();
  const log = await logOn(storage, NEVER_FLUSHED);
  opened.push(log);
  const h = buildHarness({ log });
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
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  await h.log.persistNow();
  return { h, server, docs, storage };
}

/**
 * The join the engine sends next (after `ops:status`), answered as the server
 * does: for the clock it carries.
 */
async function answerJoin(b: Bench): Promise<void> {
  const join = await joinToAnswer(b.h);
  join.ack(
    b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots(), clock: joinClockOf(b.h) }),
  );
  await b.docs.drive();
}

function isMove(e: Emit): boolean {
  return e.event === 'file:rename' || e.event === 'file:move';
}

/** The user renames `from` in Obsidian; resolves once its rename is out, not answered yet. */
async function renameOut(b: Bench, from: string, to: string): Promise<Emit> {
  const before = b.h.socket().emits.filter(isMove).length;
  await b.h.vault.rename(from, to);
  for (let i = 0; i < 100; i++) {
    const out = b.h.socket().emits.filter(isMove)[before];
    if (out !== undefined) return out;
    await flushAsync(2);
  }
  throw new Error(`the rename ${from} -> ${to} did not go out`);
}

/** The answer to `e` never reaches the device. */
function loseAck(e: Emit): void {
  e.ack = (): void => undefined;
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function records(h: Harness): string[] {
  return h.log
    .listFileMeta('b1')
    .map((m) => `${m.serverFileId}:${m.relativePath}`)
    .sort();
}

interface Renames {
  notes: Seed;
  steps: ReadonlyArray<readonly [from: string, to: string]>;
  /** How many of them are answered before the cut; `0` by default. */
  answered?: number;
  /** How many the server applies in all, the answered ones included; the rest never reach it. */
  applied: number;
  /** A teammate's rename of a note once the connection is cut. */
  teammate?: readonly [fileId: string, to: string];
}

/**
 * Rename, cut the connection (see `Cut` in the kit), let the server work and
 * the teammate rename, and come back.
 */
async function renamedThenCut(r: Renames, cut: Cut): Promise<Bench> {
  const b = await online(r.notes);
  const outs: Emit[] = [];
  for (const [from, to] of r.steps) outs.push(await renameOut(b, from, to));
  const answered = r.answered ?? 0;
  for (let i = 0; i < answered; i++) expect(b.server.serveNext()).toBe(true);
  await flushAsync(20);
  outs.slice(answered).forEach(loseAck);
  // Packets that never reach the server: not before the next connect's
  // `ops:status` on the same socket either.
  for (const out of outs.slice(r.applied)) b.server.delay(out);

  let crashDisk: FakeStorage | null = null;
  switch (cut) {
    case 'pause':
      b.h.engine.pause();
      break;
    case 'drop':
      b.h.socket().connected = false;
      b.h.socket().fire('disconnect', 'transport close');
      break;
    case 'stop':
      await b.h.engine.stop();
      break;
    case 'quit':
      // What the quit hook of `main.ts` waits for.
      await b.h.log.flush();
      crashDisk = b.storage.snapshot();
      b.h.socket().kill();
      break;
    case 'crash':
      crashDisk = b.storage.snapshot();
      b.h.socket().kill();
      break;
  }
  await flushAsync(20);
  for (let i = answered; i < r.applied; i++) expect(b.server.serveNext()).toBe(true);
  await flushAsync(10);
  if (r.teammate) b.server.teammateRename(r.teammate[0], r.teammate[1]);

  switch (cut) {
    case 'pause':
      // A new socket: Pause sync closed the old one for good.
      await b.h.engine.resume();
      await answerJoin(b);
      return b;
    case 'drop':
      b.h.socket().connect();
      await answerJoin(b);
      return b;
    case 'stop': {
      const next = buildHarness({ predecessor: b.h });
      b.server.attach(next);
      b.docs.attach(next);
      const bench = { ...b, h: next };
      await next.engine.start();
      await answerJoin(bench);
      return bench;
    }
    case 'quit':
    case 'crash': {
      const { next, storage } = await restartFromDisk(b.h, crashDisk ?? b.storage, {
        server: b.server,
        docs: b.docs,
      });
      opened.push(next.log);
      const bench = { ...b, h: next, storage };
      await next.engine.start();
      await answerJoin(bench);
      return bench;
    }
  }
}

/**
 * The outcome: where the server has each note (`fileId → path`), the disk and
 * the records agreeing with it, and what the server applied, in order — each
 * once (R1).
 */
async function expectOutcome(
  b: Bench,
  where: Record<string, string>,
  applied: readonly string[],
): Promise<void> {
  const texts = new Map<string, string>();
  for (const [id] of Object.entries(where)) texts.set(id, b.docs.text(id) ?? '?');
  for (const [id, path] of Object.entries(where)) {
    expect(`${id}:${b.server.pathOf(id)}`).toBe(`${id}:${path}`);
  }
  expect(disk(b.h)).toEqual(
    Object.entries(where)
      .map(([id, path]) => `${path}=${texts.get(id) ?? ''}`)
      .sort(),
  );
  expect(records(b.h)).toEqual(
    Object.entries(where)
      .map(([id, path]) => `${id}:${path}`)
      .sort(),
  );
  expect(b.server.applied).toEqual(applied);
  expect(b.server.duplicates).toEqual([]);
  expect(new Set(b.server.appliedOpIds).size).toBe(b.server.appliedOpIds.length);
  expect(b.h.log.dequeueOperations('b1')).toEqual([]);
  expect(b.h.log.inFlightOperations('b1')).toEqual([]);
  expect(b.h.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
  await b.h.engine.stop();
}

const X: Seed = [['x.md', 'f1', 'X\n']];
const CHAIN4 = [
  ['x.md', 'y.md'],
  ['y.md', 'z.md'],
  ['z.md', 'w.md'],
  ['w.md', 'z.md'],
] as const;
const APPLIED4 = ['f1 x.md -> y.md', 'f1 y.md -> z.md', 'f1 z.md -> w.md', 'f1 w.md -> z.md'];

// -- V1, V2: two renames on their way ------------------------------------------------

describe('two renames of one note on their way, both applied, the answers cut off', () => {
  it.each(['pause', 'drop', 'stop', 'quit', 'crash'] as const)(
    'leaves the teammate’s rename made since: the note is at w for everyone (%s)',
    async (cut) => {
      const b = await renamedThenCut(
        {
          notes: X,
          steps: [
            ['x.md', 'y.md'],
            ['y.md', 'z.md'],
          ],
          applied: 2,
          teammate: ['f1', 'w.md'],
        },
        cut,
      );
      await expectOutcome(b, { f1: 'w.md' }, [
        'f1 x.md -> y.md',
        'f1 y.md -> z.md',
        'f1 z.md -> w.md',
      ]);
    },
  );

  it('keeps the note at the last name without a teammate (pause)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'z.md'],
        ],
        applied: 2,
      },
      'pause',
    );
    await expectOutcome(b, { f1: 'z.md' }, ['f1 x.md -> y.md', 'f1 y.md -> z.md']);
  });
});

describe('two notes moved into a folder, both applied, the answers cut off', () => {
  it.each(['pause', 'drop', 'stop', 'crash'] as const)(
    'leaves the teammate’s rename of one of them (%s)',
    async (cut) => {
      const b = await renamedThenCut(
        {
          notes: [
            ['a.md', 'f1', 'A\n'],
            ['b.md', 'f2', 'B\n'],
          ],
          steps: [
            ['a.md', 'd/a.md'],
            ['b.md', 'd/b.md'],
          ],
          applied: 2,
          teammate: ['f1', 'd/a2.md'],
        },
        cut,
      );
      await expectOutcome(b, { f1: 'd/a2.md', f2: 'd/b.md' }, [
        'f1 a.md -> d/a.md',
        'f2 b.md -> d/b.md',
        'f1 d/a.md -> d/a2.md',
      ]);
    },
  );
});

// -- VF, Q: chains of renames of one note ------------------------------------------

describe('a chain of renames of one note, the last one lost on the way', () => {
  it.each(['stop', 'quit', 'crash', 'pause', 'drop'] as const)(
    'x → y → z → w → z, three applied: sends the fourth, the note at z (%s)',
    async (cut) => {
      const b = await renamedThenCut({ notes: X, steps: CHAIN4, applied: 3 }, cut);
      await expectOutcome(b, { f1: 'z.md' }, APPLIED4);
    },
  );

  it('x → z → w → z, two applied: sends the third, the note at z (stop)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'z.md'],
          ['z.md', 'w.md'],
          ['w.md', 'z.md'],
        ],
        applied: 2,
      },
      'stop',
    );
    await expectOutcome(b, { f1: 'z.md' }, [
      'f1 x.md -> z.md',
      'f1 z.md -> w.md',
      'f1 w.md -> z.md',
    ]);
  });

  it.each(['stop', 'quit', 'crash'] as const)(
    'x → y → z → y, two applied: sends the rename back, the note at y (%s)',
    async (cut) => {
      const b = await renamedThenCut(
        {
          notes: X,
          steps: [
            ['x.md', 'y.md'],
            ['y.md', 'z.md'],
            ['z.md', 'y.md'],
          ],
          applied: 2,
        },
        cut,
      );
      await expectOutcome(b, { f1: 'y.md' }, [
        'f1 x.md -> y.md',
        'f1 y.md -> z.md',
        'f1 z.md -> y.md',
      ]);
    },
  );

  it('x → y → z → w → z, three answered before the quit: sends the fourth (quit)', async () => {
    const b = await renamedThenCut({ notes: X, steps: CHAIN4, answered: 3, applied: 3 }, 'quit');
    await expectOutcome(b, { f1: 'z.md' }, APPLIED4);
  });

  it('x → y → z → w → z, the first answered, two more applied (stop)', async () => {
    const b = await renamedThenCut({ notes: X, steps: CHAIN4, answered: 1, applied: 3 }, 'stop');
    await expectOutcome(b, { f1: 'z.md' }, APPLIED4);
  });
});

describe('a chain of renames of one note, all applied, the answers cut off', () => {
  it.each(['stop', 'quit'] as const)('x → y → z → w → z: nothing sent again (%s)', async (cut) => {
    const b = await renamedThenCut({ notes: X, steps: CHAIN4, applied: 4 }, cut);
    await expectOutcome(b, { f1: 'z.md' }, APPLIED4);
  });

  it('x → y → z → w: nothing sent again, the note at w (stop)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'z.md'],
          ['z.md', 'w.md'],
        ],
        applied: 3,
      },
      'stop',
    );
    await expectOutcome(b, { f1: 'w.md' }, [
      'f1 x.md -> y.md',
      'f1 y.md -> z.md',
      'f1 z.md -> w.md',
    ]);
  });

  it('x → y → z: nothing sent again, the note at z (quit)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'z.md'],
        ],
        applied: 2,
      },
      'quit',
    );
    await expectOutcome(b, { f1: 'z.md' }, ['f1 x.md -> y.md', 'f1 y.md -> z.md']);
  });

  it.each(['stop', 'quit'] as const)(
    'x → y → z, the teammate renames z → w since: the note at w (%s)',
    async (cut) => {
      const b = await renamedThenCut(
        {
          notes: X,
          steps: [
            ['x.md', 'y.md'],
            ['y.md', 'z.md'],
          ],
          applied: 2,
          teammate: ['f1', 'w.md'],
        },
        cut,
      );
      await expectOutcome(b, { f1: 'w.md' }, [
        'f1 x.md -> y.md',
        'f1 y.md -> z.md',
        'f1 z.md -> w.md',
      ]);
    },
  );

  it('x → y → z → w, the first answered, the teammate renames w → q since (stop)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'z.md'],
          ['z.md', 'w.md'],
        ],
        answered: 1,
        applied: 3,
        teammate: ['f1', 'q.md'],
      },
      'stop',
    );
    await expectOutcome(b, { f1: 'q.md' }, [
      'f1 x.md -> y.md',
      'f1 y.md -> z.md',
      'f1 z.md -> w.md',
      'f1 w.md -> q.md',
    ]);
  });

  it('x → y → x → y, the teammate renames y → t since: the note at t (stop)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'x.md'],
          ['x.md', 'y.md'],
        ],
        applied: 3,
        teammate: ['f1', 't.md'],
      },
      'stop',
    );
    await expectOutcome(b, { f1: 't.md' }, [
      'f1 x.md -> y.md',
      'f1 y.md -> x.md',
      'f1 x.md -> y.md',
      'f1 y.md -> t.md',
    ]);
  });

  it('x → y → x → y, the last lost: sends it, the note at y (stop)', async () => {
    const b = await renamedThenCut(
      {
        notes: X,
        steps: [
          ['x.md', 'y.md'],
          ['y.md', 'x.md'],
          ['x.md', 'y.md'],
        ],
        applied: 2,
      },
      'stop',
    );
    await expectOutcome(b, { f1: 'y.md' }, [
      'f1 x.md -> y.md',
      'f1 y.md -> x.md',
      'f1 x.md -> y.md',
    ]);
  });

  it('three renames applied, the note renamed back to z while paused, then restarted', async () => {
    const b = await online(X);
    const outs: Emit[] = [];
    for (const [from, to] of CHAIN4.slice(0, 3)) outs.push(await renameOut(b, from, to));
    outs.forEach(loseAck);
    b.h.engine.pause();
    await flushAsync(20);
    for (let i = 0; i < 3; i++) expect(b.server.serveNext()).toBe(true);
    await userRename(b.h, 'w.md', 'z.md');
    await b.h.engine.stop();
    const next = buildHarness({ predecessor: b.h });
    b.server.attach(next);
    b.docs.attach(next);
    const bench = { ...b, h: next };
    await next.engine.start();
    await answerJoin(bench);
    await expectOutcome(bench, { f1: 'z.md' }, APPLIED4);
  });
});

// -- R: renames of several notes ---------------------------------------------------

describe('renames of several notes on their way, the answers cut off', () => {
  const THREE: Seed = [
    ['a.md', 'f1', 'A\n'],
    ['b.md', 'f3', 'B\n'],
    ['c.md', 'f4', 'C\n'],
  ];
  const ABC = [
    ['a.md', 'a2.md'],
    ['b.md', 'b2.md'],
    ['c.md', 'c2.md'],
  ] as const;
  const APPLIED_ABC = ['f1 a.md -> a2.md', 'f3 b.md -> b2.md', 'f4 c.md -> c2.md'];

  it.each(['stop', 'pause', 'drop', 'quit', 'crash'] as const)(
    'the first answered, the others applied: the teammate’s rename of b stays (%s)',
    async (cut) => {
      const b = await renamedThenCut(
        { notes: THREE, steps: ABC, answered: 1, applied: 3, teammate: ['f3', 'b3.md'] },
        cut,
      );
      await expectOutcome(b, { f1: 'a2.md', f3: 'b3.md', f4: 'c2.md' }, [
        ...APPLIED_ABC,
        'f3 b2.md -> b3.md',
      ]);
    },
  );

  it('none answered, all applied: the teammate’s rename of b stays (stop)', async () => {
    const b = await renamedThenCut(
      { notes: THREE, steps: ABC, applied: 3, teammate: ['f3', 'b3.md'] },
      'stop',
    );
    await expectOutcome(b, { f1: 'a2.md', f3: 'b3.md', f4: 'c2.md' }, [
      ...APPLIED_ABC,
      'f3 b2.md -> b3.md',
    ]);
  });

  const TWO: Seed = [
    ['x.md', 'f1', 'X\n'],
    ['z.md', 'f2', 'Z\n'],
  ];
  /** x → y, then z → q frees z, then y → z. */
  const INTERLEAVED = [
    ['x.md', 'y.md'],
    ['z.md', 'q.md'],
    ['y.md', 'z.md'],
  ] as const;
  const APPLIED_INTERLEAVED = ['f1 x.md -> y.md', 'f2 z.md -> q.md', 'f1 y.md -> z.md'];

  it('a note renamed onto the name another one left, all applied (stop)', async () => {
    const b = await renamedThenCut({ notes: TWO, steps: INTERLEAVED, applied: 3 }, 'stop');
    await expectOutcome(b, { f1: 'z.md', f2: 'q.md' }, APPLIED_INTERLEAVED);
  });

  it('a note renamed onto the name another one left, the last lost: sent (stop)', async () => {
    const b = await renamedThenCut({ notes: TWO, steps: INTERLEAVED, applied: 2 }, 'stop');
    await expectOutcome(b, { f1: 'z.md', f2: 'q.md' }, APPLIED_INTERLEAVED);
  });

  it('a note renamed onto the name another one left, then by the teammate (stop)', async () => {
    const b = await renamedThenCut(
      { notes: TWO, steps: INTERLEAVED, applied: 3, teammate: ['f1', 't.md'] },
      'stop',
    );
    await expectOutcome(b, { f1: 't.md', f2: 'q.md' }, [...APPLIED_INTERLEAVED, 'f1 z.md -> t.md']);
  });
});
