/**
 * Obsidian's quit (TASK-0035, spec §6.7). Obsidian does not unload a plugin
 * when it quits, and `state.json` takes a change a moment after it is made:
 * the plugin asks the quit to wait for what `state.json` and `sync.log` have
 * not written yet (`workspace.on('quit')`), and never makes it wait for good.
 *
 * Obsidian 1.13.7 (app.js, `registerQuitHook`): on quit it triggers `quit`
 * with a `Tasks`; with none added the window closes at once, otherwise it
 * shows "Saving...", awaits `Promise.all` of them and closes the window — a
 * task that rejects leaves the window open for good.
 *
 * The first part runs `main.ts` itself; the second, the engine whose record of
 * a teammate's note written here goes to disk at quit (V3 of the spec, the
 * listing's hash lagging the note's text).
 */
import type { App, PluginManifest } from 'obsidian';
import TeamVaultPlugin from '@/main';
import type { OperationLog } from '@/sync/operation-log';
import type { Logger } from '@/utils/logger';
import {
  FakeServer,
  FakeStorage,
  ServerDocs,
  buildHarness,
  connect,
  disk,
  encode,
  joinToAnswer,
  logOn,
  restartFromDisk,
  snapshotCatchesUp,
  typeOn,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

// -- The quit hook in main.ts ---------------------------------------------------

/** Obsidian's `Tasks` (app.js 1.13.7): `add` runs its callback at once. */
class QuitTasks {
  readonly promises: Array<Promise<unknown>> = [];
  add(callback: () => Promise<unknown>): void {
    this.promises.push(callback());
  }
  addPromise(promise: Promise<unknown>): void {
    this.promises.push(promise);
  }
  isEmpty(): boolean {
    return this.promises.length === 0;
  }
  promise(): Promise<unknown> {
    return Promise.all(this.promises);
  }
}

interface QuitApp {
  app: App;
  files: Map<string, string>;
  /** Handlers registered with `workspace.on`, by event name. */
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  /** State-file writes that never finish (a disk that hangs) or fail. */
  stateWrites: 'ok' | 'hang' | 'fail';
}

/** An in-memory vault with the adapter calls `onload` reaches, and a workspace that takes `on`. */
function quitApp(): QuitApp {
  const files = new Map<string, string>();
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const bench: QuitApp = { app: null as unknown as App, files, handlers, stateWrites: 'ok' };
  const stateWrite = (p: string): Promise<void> | null => {
    if (!p.includes('state.json') || bench.stateWrites === 'ok') return null;
    if (bench.stateWrites === 'fail') return Promise.reject(new Error(`EIO ${p}`));
    return new Promise<void>(() => undefined);
  };
  const adapter = {
    exists: (p: string): Promise<boolean> => Promise.resolve(files.has(p)),
    stat: (p: string) => Promise.resolve(files.has(p) ? { size: files.get(p)!.length } : null),
    read: (p: string): Promise<string> => {
      const text = files.get(p);
      if (text === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }));
      }
      return Promise.resolve(text);
    },
    write: (p: string, data: string): Promise<void> => {
      const held = stateWrite(p);
      if (held) return held;
      files.set(p, data);
      return Promise.resolve();
    },
    append: (p: string, data: string): Promise<void> => {
      files.set(p, (files.get(p) ?? '') + data);
      return Promise.resolve();
    },
    rename: (from: string, to: string): Promise<void> => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      return Promise.resolve();
    },
    remove: (p: string): Promise<void> => {
      files.delete(p);
      return Promise.resolve();
    },
    mkdir: (): Promise<void> => Promise.resolve(),
    list: () => Promise.resolve({ files: [], folders: [] }),
  };
  const on = (name: string, cb: (...args: unknown[]) => unknown): unknown => {
    const list = handlers.get(name) ?? [];
    list.push(cb);
    handlers.set(name, list);
    return { name };
  };
  bench.app = {
    vault: { configDir: '.obsidian', adapter, getFiles: () => [] },
    workspace: { onLayoutReady: jest.fn(), on },
  } as unknown as App;
  return bench;
}

/** An element that takes every DOM call the status bar makes. */
function anyEl(): HTMLElement {
  const el: HTMLElement = new Proxy(
    {},
    { get: (_target, key) => (key === 'then' ? undefined : () => el) },
  ) as HTMLElement;
  return el;
}

let seq = 0;

interface Loaded {
  q: QuitApp;
  plugin: TeamVaultPlugin;
  dir: string;
  log: OperationLog;
  logger: Logger;
  /** Refs handed to `registerEvent`: detached when the plugin unloads. */
  registered: unknown[];
}

/** The plugin, loaded: no bindings, nothing connects. */
async function loaded(): Promise<Loaded> {
  const q = quitApp();
  const id = `team-vault-quit-${++seq}`;
  const dir = `.obsidian/plugins/${id}`;
  q.files.set(`${dir}/data.json`, JSON.stringify({ settingsVersion: 2, clientId: 'client-1' }));
  const plugin = new TeamVaultPlugin(q.app, { id, dir } as PluginManifest);
  const registered: unknown[] = [];
  Object.assign(plugin, {
    addSettingTab: jest.fn(),
    registerView: jest.fn(),
    addStatusBarItem: anyEl,
    addCommand: jest.fn(),
    registerEvent: (ref: unknown) => void registered.push(ref),
  });
  await plugin.onload();
  const parts = plugin as unknown as { operationLog: OperationLog; logger: Logger };
  // Whatever `onload` wrote is on disk: the quit below finds only what the test does.
  await parts.operationLog.flush();
  return { q, plugin, dir, log: parts.operationLog, logger: parts.logger, registered };
}

/**
 * Obsidian quits: `quit` is triggered with a `Tasks`, and the window closes
 * once they all resolve. `'at once'` when no task was added; throws when one
 * rejects — the window would never close.
 */
async function quit(q: QuitApp): Promise<'at once' | 'after the tasks'> {
  const tasks = new QuitTasks();
  for (const handler of q.handlers.get('quit') ?? []) handler(tasks);
  if (tasks.isEmpty()) return 'at once';
  await tasks.promise();
  return 'after the tasks';
}

/** A record of `note.md` in binding `b1`: a change `state.json` takes after its delay. */
function recordNote(log: OperationLog): void {
  log.setFileMeta({
    bindingId: 'b1',
    relativePath: 'note.md',
    serverFileId: 'f1',
    contentHash: 'h1',
    size: 3,
    fileType: 'TEXT',
    lastSyncedAt: 1,
  });
}

describe('quit — main.ts waits for what state.json has not written', () => {
  it('registers for Obsidian’s quit, with a ref that goes when the plugin unloads', async () => {
    const { q, plugin, registered } = await loaded();

    expect(q.handlers.get('quit')).toHaveLength(1);
    expect(registered).toContainEqual({ name: 'quit' });
    plugin.onunload();
  });

  it('writes a change still waiting out its delay before the window closes', async () => {
    const { q, plugin, dir, log } = await loaded();
    recordNote(log);
    expect(log.hasUnwrittenChanges()).toBe(true);
    expect(q.files.get(`${dir}/state.json`) ?? '').not.toContain('note.md');

    expect(await quit(q)).toBe('after the tasks');

    expect(q.files.get(`${dir}/state.json`)).toContain('note.md');
    expect(log.hasUnwrittenChanges()).toBe(false);
    plugin.onunload();
  });

  it('writes the lines of sync.log still on their way', async () => {
    const { q, plugin, dir, logger } = await loaded();
    const sink = (plugin as unknown as { fileLogSink: { settled(): Promise<void> } }).fileLogSink;
    await sink.settled();
    logger.warn('the last line before quit');

    expect(await quit(q)).toBe('after the tasks');

    expect(q.files.get(`${dir}/sync.log`)).toContain('the last line before quit');
    plugin.onunload();
  });

  it('adds nothing when everything is written: no "Saving..." at each quit', async () => {
    const { q, plugin, log } = await loaded();
    recordNote(log);
    await log.flush();

    expect(await quit(q)).toBe('at once');
    plugin.onunload();
  });

  it('lets the window close when the write fails', async () => {
    const { q, plugin, log } = await loaded();
    q.stateWrites = 'fail';
    recordNote(log);

    await expect(quit(q)).resolves.toBe('after the tasks');
    plugin.onunload();
  });

  it('lets the window close after two seconds when the disk hangs', async () => {
    const { q, plugin, log } = await loaded();
    q.stateWrites = 'hang';
    recordNote(log);
    const started = Date.now();

    await expect(quit(q)).resolves.toBe('after the tasks');

    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(10_000);
    q.stateWrites = 'ok';
    plugin.onunload();
  });
});

// -- V3: a teammate's note written here, the listing's hash lagging ----------------

describe('quit — a teammate’s note written here just before it', () => {
  // The log's own delay never runs out in these tests: only the quit writes.
  const NEVER = 3_600_000;

  /**
   * `lag`: the listing's hash is the note's first text while its doc holds
   * more — the server's snapshot of a note waits 5 s after its last edit.
   * Without it, the listing has caught up: a control.
   */
  async function writtenThenQuit(
    after: 'typed' | 'deleted' | 'untouched',
    lag = true,
  ): Promise<{
    next: Harness;
    server: FakeServer;
    docs: ServerDocs;
    id: string;
    uploaded: string[];
  }> {
    const storage = new FakeStorage();
    const h = buildHarness({ log: await logOn(storage, NEVER) });
    const server = new FakeServer(h);
    const docs = new ServerDocs(server, h);
    await docs.add('f1', 'a.md', 'A\n');
    h.vault.files.set('a.md', encode('A\n'));
    await connect(h, { yjsDocs: docs.snapshots() });
    await docs.drive();
    await h.log.persistNow();

    // While paused, a teammate creates n.md and keeps typing: the listing's
    // hash is the note's first text, its doc holds more.
    h.engine.pause();
    const id = await server.teammateCreate('n.md', 'theirs\n');
    typeOn(docs, h, id, 'typing\n');
    if (!lag) await snapshotCatchesUp(server, docs, id);
    await h.engine.resume();
    (await joinToAnswer(h)).ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
    await docs.drive();
    expect(h.vault.text('n.md')).toBe('theirs\ntyping\n');

    // Obsidian quits: the quit writes `state.json` (see `flushOnQuit`).
    await h.log.flush();
    await snapshotCatchesUp(server, docs, id);
    if (after === 'typed') {
      typeOn(docs, h, id, 'more\n');
      await snapshotCatchesUp(server, docs, id);
    }
    if (after === 'deleted') server.teammateDelete(id);
    const uploadsBefore = server.applied.length;

    const { next } = await restartFromDisk(h, storage, { server, docs });
    // The old process's log: its delay no longer runs.
    await h.log.close();
    await next.engine.start();
    (await joinToAnswer(next)).ack(
      server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }),
    );
    await docs.drive();
    return { next, server, docs, id, uploaded: server.applied.slice(uploadsBefore) };
  }

  it('takes the teammate’s later text, with no conflict copy', async () => {
    const { next, docs, id, uploaded } = await writtenThenQuit('typed');

    expect(uploaded).toEqual([]);
    expect(docs.text(id)).toBe('theirs\ntyping\nmore\n');
    expect(disk(next)).toEqual(['a.md=A\n', 'n.md=theirs\ntyping\nmore\n']);
    expect(next.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
    await next.engine.stop();
  });

  it('lets the note the teammate deleted go, not back for everyone', async () => {
    const { next, server, id, uploaded } = await writtenThenQuit('deleted');

    expect(uploaded).toEqual([]);
    expect(server.pathOf(id)).toBeNull();
    expect(disk(next)).toEqual(['a.md=A\n']);
    await next.engine.stop();
  });

  it('takes the teammate’s later text when the listing had caught up (control)', async () => {
    const { next, docs, id, uploaded } = await writtenThenQuit('typed', false);

    expect(uploaded).toEqual([]);
    expect(docs.text(id)).toBe('theirs\ntyping\nmore\n');
    expect(disk(next)).toEqual(['a.md=A\n', 'n.md=theirs\ntyping\nmore\n']);
    expect(next.calls.filter((c) => c.startsWith('modal.'))).toEqual([]);
    await next.engine.stop();
  });

  it('keeps the note as it is when nobody touched it since', async () => {
    const { next, docs, id, uploaded } = await writtenThenQuit('untouched');

    expect(uploaded).toEqual([]);
    expect(docs.text(id)).toBe('theirs\ntyping\n');
    expect(disk(next)).toEqual(['a.md=A\n', 'n.md=theirs\ntyping\n']);
    await next.engine.stop();
  });
});
