/**
 * A crash of Obsidian in the moment after a teammate's note was written here
 * — or its "Reload app without saving" (`app:reload`), which reloads the
 * window without triggering `quit` and without unloading the plugin: the same
 * thing for `state.json`. The record of the write reaches `state.json` a
 * moment after the write (its debounce), so the next start finds the note on
 * disk and a record that says it never came. The listing's hash of the note
 * lags its text (the server's snapshot waits 5 s after the last edit), so it
 * cannot tell the note is the teammate's. The note's offline history
 * (y-indexeddb) can: it holds the text written, and the mark the engine put
 * there right before the write (`DocManager.noteWritten`).
 *
 * Each test here is a restart from `state.json` as it was before its debounce
 * ran ({@link restartFromDisk} without a flush), with a new `DocManager` on the
 * same IndexedDB — what a new process builds. Taken for a file saved under the
 * note's name, the note went up as a new file: a conflict copy with its old
 * text for the whole team, or, once the teammate had deleted it, the note back
 * for everyone.
 */
import { DocManager } from '@/crdt/doc-manager';
import { sha256Hex } from '@/sync/hash';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FOREIGN_DB,
  FakeIndexedDb,
  FakeServer,
  FakeStorage,
  NEVER_FLUSHED,
  ServerDocs,
  buildHarness,
  connect,
  dbNameOf,
  deferred,
  disk,
  encode,
  flushAsync,
  joinToAnswer,
  logOn,
  restartFromDisk,
  snapshotCatchesUp,
  typeOn,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

const OWNER = 'team-vault-file-id';
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

function queue(h: Harness): string[] {
  return h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.filePath}`);
}

function modify(path: string): VaultEvent {
  return { bindingId: 'b1', type: 'modify', path, source: 'obsidian' };
}

interface Crashed {
  /** The process that crashed. */
  h: Harness;
  storage: FakeStorage;
  idb: FakeIndexedDb;
  server: FakeServer;
  docs: ServerDocs;
  /** The teammate's note, `n.md`. */
  id: string;
  /** The text of the note on disk. */
  written: string;
}

/**
 * While sync is paused, a teammate creates `n.md` and types on: the listing's
 * hash of it is its first text. On resume the listing records it as never
 * written here — `state.json` has that — and the catch-up writes it. Then the
 * process dies before `state.json` takes the write. `ahead`: the teammate typed
 * on right after the write, and the note's offline history holds more than the
 * disk (live edits reach the disk only after the snapshot's debounce, which
 * never runs out here).
 */
async function writtenThenCrash(opts: { ahead?: boolean; eol?: string } = {}): Promise<Crashed> {
  const eol = opts.eol ?? '\n';
  const storage = new FakeStorage();
  const idb = new FakeIndexedDb();
  const h = buildHarness({
    log: await logOn(storage, NEVER_FLUSHED),
    docs: idb.manager(),
    diskSnapshotDebounceMs: NEVER_FLUSHED,
  });
  benches.push(h);
  const server = new FakeServer(h);
  const docs = new ServerDocs(server, h);
  await docs.add('f1', 'a.md', 'A\n');
  h.vault.files.set('a.md', encode('A\n'));
  await connect(h, { yjsDocs: docs.snapshots() });
  await docs.drive();
  await h.log.persistNow();

  h.engine.pause();
  const id = await server.teammateCreate('n.md', `theirs${eol}`);
  typeOn(docs, h, id, `typing${eol}`);
  await h.engine.resume();
  const join = await joinToAnswer(h);
  await until(() => h.log.getFileMeta('b1', 'n.md')?.notOnDisk === true, 'n.md listed');
  // Written at once by some change: the listing's record is on disk.
  await h.log.persistNow();
  join.ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
  await docs.drive();
  const written = `theirs${eol}typing${eol}`;
  expect(h.vault.text('n.md')).toBe(written);
  expect(h.log.getFileMeta('b1', 'n.md')?.notOnDisk).toBeUndefined();
  // The mark went into the note's own database before the write.
  const raw = idb.dbs.get(dbNameOf('n.md'))?.custom.get(WRITTEN);
  expect(JSON.parse(String(raw))).toMatchObject({
    fileId: id,
    hash: await sha256Hex(written),
    over: '',
    // The record the write went over: the listing's, of a note never written here.
    synced: await sha256Hex(`theirs${eol}`),
  });
  if (opts.ahead === true) {
    typeOn(docs, h, id, `ahead${eol}`);
    await until(() => idb.textOf(dbNameOf('n.md')) === `${written}ahead${eol}`, 'ahead stored');
  }
  // What the next start finds: the note on disk, recorded as never come.
  expect(storedRecord(storage, 'n.md')).toMatchObject({ serverFileId: id, notOnDisk: true });
  expect(h.vault.text('n.md')).toBe(written);
  expect(idb.textOf(dbNameOf('n.md'))).toBe(
    opts.ahead === true ? `${written}ahead${eol}` : written,
  );
  return { h, storage, idb, server, docs, id, written };
}

/** The process died: a new one starts from the disk (not started yet). */
async function restart(
  c: Crashed,
  opts: { offline?: boolean; manager?: DocManager } = {},
): Promise<Harness> {
  const { next } = await restartFromDisk(c.h, c.storage, {
    server: c.server,
    docs: c.docs,
    manager: opts.manager ?? c.idb.manager(),
    ...(opts.offline === true ? { offline: true } : {}),
  });
  benches.push(next);
  // The dead process's log: its debounce never runs again.
  await c.h.log.close();
  return next;
}

/** Connect `next`, the join answered with the whole journal, and let the server work. */
async function connectAgain(c: Crashed, next: Harness): Promise<void> {
  (await joinToAnswer(next)).ack(
    c.server.joinAnswer('whole journal', { yjsDocs: c.docs.snapshots() }),
  );
  await c.docs.drive();
}

describe('a crash right after a teammate’s note was written here', () => {
  it.each([
    ['typed on', false],
    ['deleted it', false],
    ['left it', false],
    ['typed on', true],
    ['deleted it', true],
    ['left it', true],
  ] as const)(
    'takes the note for the teammate’s when they %s since (offline history ahead of the disk: %s)',
    async (since, ahead) => {
      const c = await writtenThenCrash({ ahead });
      const next = await restart(c);
      if (since === 'typed on') {
        typeOn(c.docs, next, c.id, 'more\n');
        await snapshotCatchesUp(c.server, c.docs, c.id);
      }
      if (since === 'deleted it') c.server.teammateDelete(c.id);
      const before = c.server.applied.length;

      await next.engine.start();
      await connectAgain(c, next);

      // Taken for a file saved under the name, the note went up as a new one.
      expect(c.server.applied.slice(before)).toEqual([]);
      expect(next.calls.filter((call) => call.startsWith('modal.'))).toEqual([]);
      expect(queue(next)).toEqual([]);
      if (since === 'deleted it') {
        expect(c.server.pathOf(c.id)).toBeNull();
        expect(disk(next)).toEqual(['a.md=A\n']);
        return;
      }
      const text = `${c.written}${ahead ? 'ahead\n' : ''}${since === 'typed on' ? 'more\n' : ''}`;
      expect(c.docs.text(c.id)).toBe(text);
      expect(c.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
      expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
      await next.engine.stop();
    },
  );

  it('takes a note with CRLF line ends for the teammate’s, byte for byte', async () => {
    const c = await writtenThenCrash({ eol: '\r\n', ahead: true });
    const next = await restart(c);
    typeOn(c.docs, next, c.id, 'more\r\n');
    await snapshotCatchesUp(c.server, c.docs, c.id);
    const before = c.server.applied.length;

    await next.engine.start();
    await connectAgain(c, next);

    const text = 'theirs\r\ntyping\r\nahead\r\nmore\r\n';
    expect(c.server.applied.slice(before)).toEqual([]);
    expect(c.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
    await next.engine.stop();
  });

  it('settles the note at start, without the network, reading only the note’s own database', async () => {
    const c = await writtenThenCrash();
    const next = await restart(c, { offline: true });
    const openedBefore = c.idb.opened.length;
    const deletedBefore = c.idb.deleted.length;

    await next.engine.start();
    await until(() => next.log.getFileMeta('b1', 'n.md')?.notOnDisk === undefined, 'n.md settled');

    // Only the note's database was opened, by its name, and nothing deleted:
    // IndexedDB is one store for every vault on the machine.
    expect(c.idb.opened.slice(openedBefore)).toEqual([dbNameOf('n.md')]);
    expect(c.idb.deleted.slice(deletedBefore)).toEqual([]);
    expect(c.idb.dbs.has(FOREIGN_DB)).toBe(true);
    expect(next.log.getFileMeta('b1', 'n.md')).toMatchObject({
      contentHash: await sha256Hex(c.written),
      foldedHash: await sha256Hex(c.written),
    });
    await next.engine.stop();
  });

  describe('keeps what is not proven the teammate’s as the user’s own', () => {
    /** The note on disk went up as a new file, under a conflict name, next to the teammate's. */
    async function uploadedAsOwn(c: Crashed, next: Harness, content: string): Promise<void> {
      const before = c.server.applied.length;
      await next.engine.start();
      await connectAgain(c, next);
      expect(c.server.applied.slice(before)).toEqual(['create n.conflict-device-1.md']);
      expect(c.docs.live()).toEqual([
        'a.md=A\n',
        `n.conflict-device-1.md=${content}`,
        `n.md=${c.written}`,
      ]);
      await next.engine.stop();
    }

    it('when the history under the name is another file’s', async () => {
      const c = await writtenThenCrash();
      c.idb.dbs.get(dbNameOf('n.md'))?.custom.set(OWNER, 'f-other');
      const next = await restart(c);

      await uploadedAsOwn(c, next, c.written);
    });

    it('when the history is under the note’s name in another vault only', async () => {
      const c = await writtenThenCrash();
      const other = `team-vault-b2-${encodeURIComponent('n.md')}`;
      const db = c.idb.dbs.get(dbNameOf('n.md'));
      c.idb.dbs.delete(dbNameOf('n.md'));
      if (db) c.idb.dbs.set(other, db);
      const next = await restart(c);
      const openedBefore = c.idb.opened.length;

      await uploadedAsOwn(c, next, c.written);

      expect(c.idb.opened.slice(openedBefore)).not.toContain(other);
      expect(c.idb.textOf(other)).toBe(c.written);
    });

    it('when only the line ends were changed on disk since', async () => {
      const c = await writtenThenCrash();
      const next = await restart(c);
      next.vault.files.set('n.md', encode('theirs\r\ntyping\r\n'));

      await uploadedAsOwn(c, next, 'theirs\r\ntyping\r\n');
    });
  });
});

describe('a crash right after a teammate’s note was written here, then a save of it', () => {
  it('waits for the check at start with a save made offline: the save goes into the note', async () => {
    const c = await writtenThenCrash();
    const manager = c.idb.manager();
    // The check at start held at the note's history, the disk already read.
    const held = deferred<void>();
    let peeked = false;
    const peek = manager.peek.bind(manager);
    manager.peek = async (bindingId, filePath): ReturnType<DocManager['peek']> => {
      peeked = true;
      await held.promise;
      return peek(bindingId, filePath);
    };
    const next = await restart(c, { offline: true, manager });
    typeOn(c.docs, next, c.id, 'more\n');
    await snapshotCatchesUp(c.server, c.docs, c.id);
    const before = c.server.applied.length;
    await next.engine.start();
    await until(() => peeked, 'the check at start');

    // Back at the note, the user adds a line on top; Obsidian saves it.
    next.vault.files.set('n.md', encode(`mine\n${c.written}`));
    const saved = next.engine.handleVaultEvent(modify('n.md'));
    await flushAsync();
    held.resolve();
    await saved;
    // A save of the teammate's note, not a new file.
    expect(queue(next)).toEqual([]);
    expect(next.log.getFileMeta('b1', 'n.md')?.notOnDisk).toBeUndefined();

    next.socket().goOnline();
    await connectAgain(c, next);

    const text = `mine\n${c.written}more\n`;
    expect(c.server.applied.slice(before)).toEqual([]);
    expect(c.docs.live()).toEqual(['a.md=A\n', `n.md=${text}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${text}`]);
    await next.engine.stop();
  });

  it('keeps the teammate’s text the offline history holds beyond the disk when the user saves before the catch-up', async () => {
    const c = await writtenThenCrash({ ahead: true });
    const next = await restart(c, { offline: true });
    typeOn(c.docs, next, c.id, 'more\n');
    await snapshotCatchesUp(c.server, c.docs, c.id);
    const before = c.server.applied.length;
    await next.engine.start();
    await until(() => next.log.getFileMeta('b1', 'n.md')?.notOnDisk === undefined, 'n.md settled');

    // Saved before the catch-up has brought the note's text to disk: the disk
    // is behind the note's offline history.
    next.vault.files.set('n.md', encode(`mine\n${c.written}`));
    await next.engine.handleVaultEvent(modify('n.md'));
    expect(queue(next)).toEqual([]);
    next.socket().goOnline();
    await connectAgain(c, next);

    // Folded without a base, the save replaced the note's text for everyone:
    // "ahead" went.
    const ahead = `mine\n${c.written}ahead\nmore\n`;
    expect(c.server.applied.slice(before)).toEqual([]);
    expect(c.docs.live()).toEqual(['a.md=A\n', `n.md=${ahead}`]);
    expect(disk(next)).toEqual(['a.md=A\n', `n.md=${ahead}`]);
    await next.engine.stop();
  });
});
