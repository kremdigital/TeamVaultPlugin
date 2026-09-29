/**
 * A crash of Obsidian — or its "Reload app without saving", which reloads the
 * window without `quit` — in the moment after this device wrote a teammate's
 * edit of a note to disk: `state.json` takes the record of the write a moment
 * after it (its debounce), and the next start finds the disk ahead of the
 * note's fold marker (`FileMeta.foldedHash`), or finds no record of a note
 * created live at all. The note's offline history (y-indexeddb) is ahead of
 * the disk too when the teammate typed on right after the write.
 *
 * Folded against the stale marker, the disk looked like local edits made to
 * an older text: without a base, the disk's text replaced the note's for the
 * whole team (the teammate's text since the write, gone); with the old text in
 * the server's version history, the teammate's lines were merged in twice.
 * The engine puts a mark of each write in the note's own database right
 * before it (`DocManager.noteWritten`): the fold takes the text written as its
 * base when the marker it finds is the one that mark was written over.
 *
 * And only once the write went through to this vault's disk
 * (`DocManager.confirmWritten`). A mark of a write given up on tells a disk
 * holding the very text marked, and nothing else: taken for the base of a
 * disk that never got the text, it deleted the teammate's lines in it.
 *
 * Only then. A text the engine once wrote, brought back to disk by git, a
 * backup or File Recovery after the user had moved on from it, is the user's:
 * the mark is dropped at the first fold of a disk that is not the engine's
 * write, and one whose record moved on since is not taken.
 *
 * Each crash is a restart from `state.json` as it was before its debounce ran
 * ({@link restartFromDisk} without a flush), with a new `DocManager` on the
 * same IndexedDB — what a new process builds.
 */
import { sha256Hex } from '@/sync/hash';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeIndexedDb,
  FakeServer,
  FakeStorage,
  NEVER_FLUSHED,
  ServerDocs,
  buildHarness,
  bytes,
  connect,
  dbNameOf,
  disk,
  encode,
  flushAsync,
  joinToAnswer,
  json,
  logOn,
  restartFromDisk,
  snapshotCatchesUp,
  typeOn,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

const WRITTEN = 'team-vault-written';

/** Every engine of the test: stopped after it, their logs closed (their debounce never runs out). */
const benches: Harness[] = [];

afterEach(async () => {
  for (const h of benches.splice(0)) {
    await h.engine.stop().catch(() => undefined);
    await h.log.close().catch(() => undefined);
  }
});

/** Wait for `cond`, a bounded number of turns of the event loop; throws when it never holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flushAsync(2);
  }
  throw new Error(`never: ${what}`);
}

/** The record of `path` in the `state.json` on `storage`. */
function storedRecord(storage: FakeStorage, path: string): Record<string, unknown> | undefined {
  const files = storage.state()?.bindings.b1?.files ?? [];
  return files.find((f) => f.relativePath === path);
}

function modify(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'modify', path, source: 'obsidian' };
}

/** The server's version history of `fileId`: one version per text. */
function versions(h: Harness, fileId: string, texts: string[]): void {
  const listed = texts.map(async (text, i) => ({
    id: `v${i}`,
    contentHash: await sha256Hex(text),
    size: encode(text).byteLength,
    createdAt: '2026-01-01',
    authorId: 'u2',
    fileId,
  }));
  h.routes.set(`GET /api/projects/p1/files/${fileId}/versions`, async () =>
    json({ versions: await Promise.all(listed) }),
  );
  texts.forEach((text, i) => {
    h.routes.set(`GET /api/projects/p1/files/${fileId}/versions/v${i}`, () => bytes(encode(text)));
  });
}

/** The lines of `text`, sorted: each line a teammate or the user typed, once. */
function lines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .sort();
}

interface Bench {
  h: Harness;
  storage: FakeStorage;
  idb: FakeIndexedDb;
  server: FakeServer;
  docs: ServerDocs;
}

/** Connected, with `a.md` and, when given, the note `n.md` (`f2`) synced at `text`. */
async function synced(note?: string): Promise<Bench> {
  const storage = new FakeStorage();
  const idb = new FakeIndexedDb();
  const h = buildHarness({ log: await logOn(storage, NEVER_FLUSHED), docs: idb.manager() });
  benches.push(h);
  const server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
  await docs.add('f1', 'a.md', 'A\n');
  h.vault.files.set('a.md', encode('A\n'));
  if (note !== undefined) {
    await docs.add('f2', 'n.md', note);
    h.vault.files.set('n.md', encode(note));
  }
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  await h.log.persistNow();
  return { h, storage, idb, server, docs };
}

/**
 * The process dies now: a new one starts from the disk as it is (not
 * started yet). Its snapshot is taken at once, before anything of the old
 * process that is still due runs — the old engine's pending disk write
 * among them, which its stop cancels.
 */
async function crash(b: Bench, h: Harness = b.h): Promise<Harness> {
  const { next, storage } = await restartFromDisk(h, b.storage, {
    server: b.server,
    docs: b.docs,
    manager: b.idb.manager(),
  });
  // The disk the next start finds; the dead process's log writes elsewhere.
  b.storage = storage;
  benches.push(next);
  // The dead process's log: its debounce never runs again.
  await h.log.close();
  return next;
}

/** Obsidian quits and starts again: `state.json` written first. */
async function restart(b: Bench, h: Harness): Promise<Harness> {
  await h.log.persistNow();
  const { next, storage } = await restartFromDisk(h, b.storage, {
    server: b.server,
    docs: b.docs,
    manager: b.idb.manager(),
  });
  b.storage = storage;
  benches.push(next);
  await h.log.close();
  return next;
}

/** Connect `h`, the join answered with the whole journal, and let the server work. */
async function connectAgain(b: Bench, h: Harness): Promise<void> {
  await h.engine.start();
  (await joinToAnswer(h)).ack(
    b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
  );
  await b.docs.drive();
}

/** A file of the server's, a teammate's line appended to its note. */
async function teammateAppends(b: Bench, h: Harness, id: string, line: string): Promise<void> {
  typeOn(b.docs, h, id, line);
  await b.docs.drive();
}

/** The mark of the last write of `n.md` in its database, parsed; `null` without one. */
function markOf(b: Bench): Record<string, unknown> | null {
  const raw = b.idb.dbs.get(dbNameOf('n.md'))?.custom.get(WRITTEN);
  return typeof raw === 'string' && raw !== ''
    ? (JSON.parse(raw) as Record<string, unknown>)
    : null;
}

/** Whether the server has taken in the engine's edits, and `h`'s disk holds the note's text. */
function agreed(b: Bench, h: Harness): boolean {
  b.docs.absorb();
  return h.vault.text('n.md') === b.docs.text('f2');
}

describe('a crash right after a teammate’s note created live was written here', () => {
  /**
   * Connected, a teammate creates `n.md` and the engine writes it; they type
   * on right after, and the process dies before the write reaches
   * `state.json`: no record of the note at all. The offline history holds
   * their line; the disk does not.
   */
  async function createdThenCrash(): Promise<{ b: Bench; next: Harness; id: string }> {
    const b = await synced();
    const id = await b.server.teammateCreate('n.md', 'theirs\n');
    await until(() => b.h.vault.text('n.md') === 'theirs\n', 'n.md written');
    typeOn(b.docs, b.h, id, 'e2\n');
    expect(b.idb.textOf(dbNameOf('n.md'))).toBe('theirs\ne2\n');
    const next = await crash(b);
    // What the next start finds.
    expect(storedRecord(b.storage, 'n.md')).toBeUndefined();
    expect(disk(next)).toEqual(['a.md=A\n', 'n.md=theirs\n']);
    return { b, next, id };
  }

  it('keeps the teammate’s text typed right after the write, and since', async () => {
    const { b, next, id } = await createdThenCrash();
    // They type on; the listing's hash of the note catches up with it.
    typeOn(b.docs, next, id, 'e3\n');
    await snapshotCatchesUp(b.server, b.docs, id);
    const before = b.server.applied.length;

    await connectAgain(b, next);

    // Folded without a base, the disk's text went to everyone: e2 and e3 gone.
    const text = 'theirs\ne2\ne3\n';
    expect(b.server.applied.slice(before)).toEqual([]);
    expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
  });
});

describe('a crash right after a teammate’s edit of a synced note was written here', () => {
  /**
   * `n.md` synced at `F0\n` (its fold marker in `state.json`). A teammate
   * types `e1`, and the engine writes it; `ahead`: they type `e2` right after,
   * and the process dies before the write reaches `state.json` — the marker
   * there is still `F0`'s. `confirmationLost`: it dies before the note's
   * database takes the confirmation of the write, too.
   */
  async function writtenThenCrash(
    ahead: boolean,
    confirmationLost = false,
  ): Promise<{ b: Bench; next: Harness }> {
    const b = await synced('F0\n');
    if (confirmationLost) b.idb.loseConfirmations();
    const f0 = await sha256Hex('F0\n');
    expect(storedRecord(b.storage, 'n.md')).toMatchObject({ foldedHash: f0 });
    await teammateAppends(b, b.h, 'f2', 'e1\n');
    await until(() => b.h.vault.text('n.md') === 'F0\ne1\n', 'e1 written');
    expect(b.idb.dbs.get(dbNameOf('n.md'))?.custom.has(WRITTEN)).toBe(true);
    if (ahead) typeOn(b.docs, b.h, 'f2', 'e2\n');
    const next = await crash(b);
    expect(storedRecord(b.storage, 'n.md')).toMatchObject({ foldedHash: f0, contentHash: f0 });
    expect(next.vault.text('n.md')).toBe('F0\ne1\n');
    expect(b.idb.textOf(dbNameOf('n.md'))).toBe(ahead ? 'F0\ne1\ne2\n' : 'F0\ne1\n');
    return { b, next };
  }

  describe.each([
    ['without the old text in its version history', false],
    ['with the old text in its version history', true],
  ] as const)('%s', (_name, history) => {
    it('the catch-up keeps the teammate’s text the offline history holds beyond the disk', async () => {
      const { b, next } = await writtenThenCrash(true);
      if (history) versions(next, 'f2', ['F0\n']);
      typeOn(b.docs, next, 'f2', 'e3\n');
      await snapshotCatchesUp(b.server, b.docs, 'f2');
      const before = b.server.applied.length;

      await connectAgain(b, next);

      // Without a base: e2 and e3 gone for everyone. With `F0` for one: e1 twice.
      const text = 'F0\ne1\ne2\ne3\n';
      expect(b.server.applied.slice(before)).toEqual([]);
      expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
      expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
    });

    it('a teammate’s edit that comes before the catch-up is taken in once', async () => {
      const { b, next } = await writtenThenCrash(false);
      if (history) versions(next, 'f2', ['F0\n']);
      await next.engine.start();
      const join = await joinToAnswer(next);
      // Live, before the catch-up: the note's history is checked against the
      // server's doc first (`applyAfterLineageCheck`), and the edit folded and
      // written from there.
      typeOn(b.docs, next, 'f2', 'e3\n');
      await until(() => next.socket().fetches.length > 0, 'the server’s doc asked for');
      for (let i = 0; i < 3; i++) {
        b.docs.answerFetches();
        await flushAsync(20);
        b.docs.absorb();
      }
      join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
      await b.docs.drive();

      const text = 'F0\ne1\ne3\n';
      expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
      expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
    });

    it.each([
      ['the offline history as the disk', false],
      ['the offline history ahead of the disk', true],
    ] as const)(
      'a save of the note before the catch-up keeps every line once (%s)',
      async (_what, ahead) => {
        const { b, next } = await writtenThenCrash(ahead);
        if (history) versions(next, 'f2', ['F0\n']);
        await next.engine.start();
        const join = await joinToAnswer(next);

        // Back at the note, the user adds a line; Obsidian saves it.
        next.vault.files.set('n.md', encode('F0\ne1\nu\n'));
        await next.engine.handleVaultEvent(modify('n.md'));
        join.ack(b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }));
        await b.docs.drive();

        // Folded against `F0`: e1 twice with a base from the version history,
        // e2 gone without one.
        const text = b.docs.text('f2');
        expect(lines(text)).toEqual(lines(`F0\ne1\n${ahead ? 'e2\n' : ''}u\n`));
        expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text ?? ''}`]);
      },
    );
  });

  it('the catch-up keeps the teammate’s text when the crash came before the write was confirmed', async () => {
    // The mark put down before the write is all the database has: it tells a
    // disk holding the very text written.
    const { b, next } = await writtenThenCrash(true, true);
    expect(markOf(b)).toMatchObject({ hash: await sha256Hex('F0\ne1\n') });
    expect(markOf(b)?.disk).toBeUndefined();
    typeOn(b.docs, next, 'f2', 'e3\n');
    await snapshotCatchesUp(b.server, b.docs, 'f2');
    const before = b.server.applied.length;

    await connectAgain(b, next);

    const text = 'F0\ne1\ne2\ne3\n';
    expect(b.server.applied.slice(before)).toEqual([]);
    expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
  });
});

describe('a write of a teammate’s edit that did not take place', () => {
  /**
   * `n.md` synced at `F0`; a teammate types `e1`, and the snapshot that is to
   * write it puts down its mark (see `DocManager.noteWritten`) — then does not
   * write. The note's record still names `F0` for the text folded, as its
   * mark does for the text written over: the mark is of a write the disk
   * never got. Taken for the text on disk, it made the next fold read the
   * disk as the deletion of `e1`, for everyone.
   */
  const e1 = 'F0\ne1\n';

  /** Hold the first look at `n.md` made after the mark of the write of `e1`. */
  function holdLookAfterMark(b: Bench, hash: string): { reached: Promise<void>; release(): void } {
    let release!: () => void;
    let reached!: () => void;
    const open = new Promise<void>((r) => {
      release = r;
    });
    const hit = new Promise<void>((r) => {
      reached = r;
    });
    const exists = b.h.vault.exists.bind(b.h.vault);
    let armed = true;
    b.h.vault.exists = async (path) => {
      if (armed && path === 'n.md' && markOf(b)?.hash === hash) {
        armed = false;
        reached();
        await open;
      }
      return exists(path);
    };
    return { reached: hit, release };
  }

  it('the next fold keeps it when the disk kept changing under the snapshot', async () => {
    const b = await synced('F0\ne0\n');
    // The user's editor saves the note while the snapshot is about to write
    // it: each look the snapshot takes at the disk once its mark is down
    // finds a line more, until it gives up — and once more as it tries again.
    let saves = 4;
    const read = b.h.vault.readText.bind(b.h.vault);
    b.h.vault.readText = (path) => {
      if (path === 'n.md' && saves > 0 && markOf(b) !== null) {
        b.h.vault.files.set(path, encode(`${b.h.vault.text(path) ?? ''}u${5 - saves}\n`));
        saves -= 1;
      }
      return read(path);
    };

    await teammateAppends(b, b.h, 'f2', 'e1\n');
    await until(() => saves === 0 && agreed(b, b.h), 'disk and server agree');
    await b.docs.drive();

    // The snapshot tried again once the disk settled: folded against the
    // mark of the write it had given up on, `e1` was gone for everyone.
    const text = b.docs.text('f2');
    expect(lines(text)).toEqual(lines('F0\ne0\ne1\nu1\nu2\nu3\nu4\n'));
    expect(disk(b.h)).toEqual(['a.md=A\n', `n.md=${text ?? ''}`]);
  });

  it('the next start keeps it when the engine stopped between the mark and the write', async () => {
    const b = await synced('F0\n');
    const f0 = await sha256Hex('F0\n');
    const held = holdLookAfterMark(b, await sha256Hex(e1));
    await teammateAppends(b, b.h, 'f2', 'e1\n');
    await held.reached;
    // The plugin turned off, or Obsidian quitting: the write is refused.
    await b.h.engine.stop();
    held.release();
    const next = await restart(b, b.h);
    expect(storedRecord(b.storage, 'n.md')).toMatchObject({ foldedHash: f0, contentHash: f0 });
    expect(next.vault.text('n.md')).toBe('F0\n');
    typeOn(b.docs, next, 'f2', 'e2\n');

    await connectAgain(b, next);

    const text = 'F0\ne1\ne2\n';
    expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
  });

  it('a save keeps it when the note was gone at the look before the write', async () => {
    const b = await synced('F0\n');
    const hash = await sha256Hex(e1);
    // Git or an editor replaces the file — unlink, then create — right as the
    // snapshot looks at it before the write.
    let gone = false;
    const exists = b.h.vault.exists.bind(b.h.vault);
    b.h.vault.exists = (path) => {
      if (!gone && path === 'n.md' && markOf(b)?.hash === hash) {
        gone = true;
        b.h.vault.files.delete(path);
      }
      return exists(path);
    };
    await teammateAppends(b, b.h, 'f2', 'e1\n');
    await until(() => gone, 'n.md gone at the look before the write');
    expect(b.docs.text('f2')).toBe(e1);

    // Back, with the user's line: its save.
    b.h.vault.files.set('n.md', encode('F0\nu\n'));
    await b.h.engine.handleVaultEvent(modify('n.md'));
    await until(() => agreed(b, b.h), 'disk and server agree');
    await b.docs.drive();

    const text = b.docs.text('f2');
    expect(lines(text)).toEqual(lines('F0\ne1\nu\n'));
    expect(disk(b.h)).toEqual(['a.md=A\n', `n.md=${text ?? ''}`]);
  });

  it('is not taken from another copy of the vault on this computer', async () => {
    // One IndexedDB for every vault on the machine: a copy of the vault in
    // another folder, `data.json` and all, shares the note's database.
    const b = await synced('F0\n');
    const f0 = await sha256Hex('F0\n');
    const copyState = b.storage.snapshot();
    const copyFiles = new Map(b.h.vault.files);
    // The original writes `e1` over `F0`: the mark of it in the database is
    // of a write to the original's disk.
    await teammateAppends(b, b.h, 'f2', 'e1\n');
    await until(() => b.h.vault.text('n.md') === e1, 'e1 written');
    expect(markOf(b)).toMatchObject({ hash: await sha256Hex(e1), over: f0, synced: f0 });
    expect(markOf(b)?.disk).toEqual(expect.any(String));
    // Obsidian closes it and opens the copy, never both at once.
    await b.h.log.persistNow();
    b.h.socketIfBuilt()?.kill();
    await b.h.engine.stop();
    const copy = buildHarness({
      log: await logOn(copyState, NEVER_FLUSHED),
      docs: b.idb.manager(),
    });
    benches.push(copy);
    copy.vault.getBasePath = (): string => '/vault copy';
    for (const [path, data] of copyFiles) copy.vault.files.set(path, data);
    b.server.attach(copy);
    b.docs.attach(copy);
    typeOn(b.docs, copy, 'f2', 'e2\n');

    await connectAgain(b, copy);

    // Folded against the text the original wrote, the copy's disk read as
    // the deletion of `e1`.
    const text = 'F0\ne1\ne2\n';
    expect(b.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(copy)).toEqual(['a.md=A\n', `n.md=${text}`]);
  });
});

describe('a text the engine wrote once, back on disk after the user moved on from it', () => {
  /**
   * `n.md` synced at `F\n`; a teammate adds `h`, and the engine writes
   * `F\nh\n` over `F\n` — the mark of that write in the note's database —
   * and `state.json` takes it.
   */
  async function writtenOver(): Promise<Bench> {
    const b = await synced('F\n');
    await teammateAppends(b, b.h, 'f2', 'h\n');
    await until(() => b.h.vault.text('n.md') === 'F\nh\n', 'h written');
    await b.h.log.persistNow();
    expect(storedRecord(b.storage, 'n.md')).toMatchObject({
      foldedHash: await sha256Hex('F\nh\n'),
      contentHash: await sha256Hex('F\nh\n'),
    });
    return b;
  }

  it('is the user’s when they had gone back to the text it was written over', async () => {
    const b = await writtenOver();
    // The user takes `h` out again; the next connect finds the note synced
    // at `F\n` — the text the write went over — its record as it was then.
    b.h.vault.files.set('n.md', encode('F\n'));
    await b.h.engine.handleVaultEvent(modify('n.md'));
    await b.docs.drive();
    expect(b.docs.text('f2')).toBe('F\n');
    b.h.engine.pause();
    await b.h.engine.resume();
    (await joinToAnswer(b.h)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots() }),
    );
    await b.docs.drive();
    expect(b.h.log.getFileMeta('b1', 'n.md')).toMatchObject({
      foldedHash: await sha256Hex('F\n'),
      contentHash: await sha256Hex('F\n'),
    });
    // Obsidian closed, `git checkout` brings `F\nh\n` back.
    const next = await restart(b, b.h);
    next.vault.files.set('n.md', encode('F\nh\n'));

    await connectAgain(b, next);

    // Taken for the engine's write, it was overwritten with `F\n`.
    expect(b.docs.live()).toEqual(['a.md=A\n', 'n.md=F\nh\n']);
    expect(disk(next)).toEqual(['a.md=A\n', 'n.md=F\nh\n']);
  });

  it.each([
    ['the write reached state.json', false],
    ['the write did not reach state.json', true],
  ] as const)(
    'is the user’s after its record moved on without the note’s history open (%s)',
    async (_name, lost) => {
      const b = await synced('F\n');
      await teammateAppends(b, b.h, 'f2', 'h\n');
      await until(() => b.h.vault.text('n.md') === 'F\nh\n', 'h written');
      let next: Harness;
      if (lost) {
        next = await crash(b);
      } else {
        next = await restart(b, b.h);
      }
      // While Obsidian is closed, the note becomes `X` on disk and on the
      // server alike: the catch-up finds them agreeing and takes `X` as
      // synced without opening the note's history.
      const x = lost ? 'X\n' : 'F\n';
      next.vault.files.set('n.md', encode(x));
      await b.docs.restWrite('f2', x);
      await connectAgain(b, next);
      expect(next.log.getFileMeta('b1', 'n.md')?.foldedHash).toBe(await sha256Hex(x));
      // Then the text the engine wrote comes back to disk: a backup restored.
      next.vault.files.set('n.md', encode('F\nh\n'));
      const saved = next.engine.handleVaultEvent(modify('n.md'));
      await b.docs.drive();
      await saved;
      await b.docs.drive();

      expect(b.docs.live()).toEqual(['a.md=A\n', 'n.md=F\nh\n']);
      expect(disk(next)).toEqual(['a.md=A\n', 'n.md=F\nh\n']);
    },
  );
});
