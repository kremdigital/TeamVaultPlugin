/**
 * Pause sync.
 *
 * `EngineManager.pause()` stopped and dropped every engine, and a vault event
 * with no engine to take it was dropped: whatever the user did while paused
 * was lost as an intent. Found on Obsidian 1.13.7 against the production
 * server: a note renamed while paused (`offlene-a.md → chain-b.md →
 * chain-c.md`) came back on resume as two notes for the whole team — the
 * first upload sent `chain-c.md` as a new note, and the catch-up wrote the old
 * name back from the server — and a note deleted while paused came back.
 *
 * Now Pause keeps every engine and closes its connection: the engine records
 * local changes exactly as when the network drops, and Resume connects again
 * through the normal connect flow. The work of the closed connection ends at
 * its next step, and the next connect waits for it.
 */
import { sha256Hex } from '@/sync/hash';
import { EngineManager } from '@/sync/engine-manager';
import type { SyncEngine } from '@/sync/engine';
import type { VaultEvent } from '@/watcher/obsidian-events';
import { Logger, type LogEntry } from '@/utils/logger';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  bytes,
  deferred,
  encode,
  flushAsync,
  json,
  markOf,
  expectQuietSince,
  server as serverConfig,
  userRename,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

// -- Helpers ------------------------------------------------------------------

type Seed = ReadonlyArray<readonly [path: string, fileId: string, content: string]>;

/** Notes and attachments on disk, in `state.json` and on the server; not connected. */
async function seeded(
  notes: Seed,
  attachments: Seed = [],
  opts: { logger?: Logger } = {},
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness(opts.logger ? { logger: opts.logger } : {});
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
    const bytes = encode(content);
    const hash = await sha256Hex(bytes);
    h.vault.files.set(path, bytes);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: path,
      serverFileId: fileId,
      contentHash: hash,
      size: bytes.byteLength,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    server.add({ id: fileId, path, fileType: 'BINARY', contentHash: hash, size: bytes.byteLength });
  }
  return { h, server, docs };
}

/** The pending `project:join` answered with the server's whole-journal catch-up; the server works. */
async function answerJoin(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  h.socket()
    .pending('project:join')
    .ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
  await docs.drive();
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function queue(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.newPath ? ` -> ${op.newPath}` : ''}`);
}

function vaultEvent(type: 'create' | 'modify' | 'delete', path: string): VaultEvent {
  return { bindingId: 'b1', type, path, source: 'obsidian' };
}

/** How many times the engine asked its socket to connect. */
function connects(h: Harness): number {
  return h.calls.filter((c) => c === 'socket.connect').length;
}

/**
 * The binding under an `EngineManager`, wired as `main.ts` wires it: the
 * vault's watcher hands every event to the manager, which hands it to the
 * binding's engine. The first engine is `first`'s; one spawned after it is a
 * fresh engine on the same vault, log and docs (`buildHarness` with a
 * predecessor) — what the manager did on every resume before.
 */
function managed(
  first: Harness,
  server: FakeServer,
  docs: ServerDocs,
): { manager: EngineManager; now: () => Harness } {
  let current: Harness | null = null;
  let manager: EngineManager | null = null;
  const viaManager = {
    handleVaultEvent: (event: VaultEvent) => manager?.dispatchVaultEvent(event),
  } as unknown as SyncEngine;
  manager = new EngineManager({
    getSettings: () => ({ servers: [serverConfig], bindings: [first.route.binding] }),
    vault: first.vault,
    operationLog: first.log,
    docManager: first.doc,
    recentlyApplied: first.echo,
    clientId: 'device-1',
    engineFactory: () => {
      const next = current === null ? first : buildHarness({ predecessor: current });
      if (next !== first) {
        server.attach(next);
        docs.attach(next);
      }
      current = next;
      first.route.engine = viaManager;
      return next.engine;
    },
  });
  first.route.engine = viaManager;
  return { manager, now: () => current ?? first };
}

async function managedLocal(
  manager: EngineManager,
  h: Harness,
  type: 'create' | 'modify' | 'delete',
  path: string,
  content?: string,
): Promise<void> {
  if (type === 'delete') h.vault.files.delete(path);
  else if (content !== undefined) h.vault.files.set(path, encode(content));
  await manager.dispatchVaultEvent(vaultEvent(type, path));
  await h.settle();
}

// -- What the user does while paused -----------------------------------------

describe('Pause sync — what the user does while paused reaches the team on resume', () => {
  it('sends a note renamed twice while paused as one rename, a teammate’s note under the middle name', async () => {
    const { h, server, docs } = await seeded([
      ['offlene-a.md', 'f1', 'A\n'],
      ['other.md', 'f2', 'O\n'],
    ]);
    const { manager, now } = managed(h, server, docs);
    await manager.start();
    await answerJoin(now(), server, docs);
    expect(manager.getAggregateStatus().state).toBe('connected');

    await manager.pause();
    expect(manager.getAggregateStatus().state).toBe('paused');
    const socket = now().socket();
    const mark = markOf(now());
    await userRename(now(), 'offlene-a.md', 'chain-b.md');
    await userRename(now(), 'chain-b.md', 'chain-c.md');
    // A teammate gives their note the name in between meanwhile.
    server.teammateRename('f2', 'chain-b.md');
    // Nothing went to the server while paused, and no socket came up.
    expect(now().socketIfBuilt()).toBe(socket);
    expect(socket.emits.length).toBe(mark.emits);
    expect(now().requests.length).toBe(mark.requests);
    expect(manager.getAggregateStatus().state).toBe('paused');

    await manager.resume();
    await answerJoin(now(), server, docs);

    expect(server.applied).toEqual(['f2 other.md -> chain-b.md', 'f1 offlene-a.md -> chain-c.md']);
    expect(docs.live()).toEqual(['chain-b.md=O\n', 'chain-c.md=A\n']);
    expect(disk(now())).toEqual(['chain-b.md=O\n', 'chain-c.md=A\n']);
    expect(now().socket().created()).toEqual([]);
    expect(queue(now())).toEqual([]);
    expect(manager.getAggregateStatus().state).toBe('connected');
    expect(now().eventErrors).toEqual([]);
    await manager.stop();
  });

  it('keeps a note deleted while paused deleted', async () => {
    const { h, server, docs } = await seeded([
      ['a.md', 'f1', 'A\n'],
      ['b.md', 'f2', 'B\n'],
    ]);
    const { manager, now } = managed(h, server, docs);
    await manager.start();
    await answerJoin(now(), server, docs);

    await manager.pause();
    await managedLocal(manager, now(), 'delete', 'a.md');
    await manager.resume();
    await answerJoin(now(), server, docs);

    expect(server.applied).toEqual(['delete f1']);
    expect(docs.live()).toEqual(['b.md=B\n']);
    expect(disk(now())).toEqual(['b.md=B\n']);
    expect(now().socket().created()).toEqual([]);
    await manager.stop();
  });

  it('sends notes created, edited, and created then renamed while paused', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    const { manager, now } = managed(h, server, docs);
    await manager.start();
    await answerJoin(now(), server, docs);

    await manager.pause();
    const mark = markOf(now());
    await managedLocal(manager, now(), 'modify', 'a.md', 'A\nmore\n');
    await managedLocal(manager, now(), 'create', 'new.md', 'N\n');
    await managedLocal(manager, now(), 'create', 'Untitled.md', 'T\n');
    await userRename(now(), 'Untitled.md', 'Titled.md');
    expect(now().requests.length).toBe(mark.requests);
    expect(now().socket().emits.length).toBe(mark.emits);

    await manager.resume();
    await answerJoin(now(), server, docs);

    expect(docs.live()).toEqual(['Titled.md=T\n', 'a.md=A\nmore\n', 'new.md=N\n']);
    expect(disk(now())).toEqual(['Titled.md=T\n', 'a.md=A\nmore\n', 'new.md=N\n']);
    expect(now().socket().created().sort()).toEqual(['Titled.md', 'new.md']);
    expect(queue(now())).toEqual([]);
    expect(now().eventErrors).toEqual([]);
    await manager.stop();
  });

  it('sends attachments created, edited, deleted and renamed while paused', async () => {
    const { h, server, docs } = await seeded(
      [],
      [
        ['att.png', 'f3', 'v1'],
        ['old.png', 'f4', 'old'],
        ['img.png', 'f5', 'img'],
      ],
    );
    const { manager, now } = managed(h, server, docs);
    await manager.start();
    await answerJoin(now(), server, docs);

    await manager.pause();
    const mark = markOf(now());
    await managedLocal(manager, now(), 'modify', 'att.png', 'v2');
    await managedLocal(manager, now(), 'create', 'pic.png', 'pic');
    await managedLocal(manager, now(), 'delete', 'old.png');
    await userRename(now(), 'img.png', 'img2.png');
    expect(now().requests.length).toBe(mark.requests);
    expect(queue(now())).toEqual([
      'UPDATE att.png',
      'CREATE pic.png',
      'DELETE old.png',
      'RENAME img.png -> img2.png',
    ]);

    await manager.resume();
    await answerJoin(now(), server, docs);

    expect(server.applied).toEqual([
      'update f3',
      'create pic.png',
      'delete f4',
      'f5 img.png -> img2.png',
    ]);
    expect(server.files.get('f3')?.contentHash).toBe(await sha256Hex(encode('v2')));
    expect(server.pathOf('f4')).toBeNull();
    expect(server.pathOf('f5')).toBe('img2.png');
    expect(disk(now())).toEqual(['att.png=v2', 'img2.png=img', 'pic.png=pic']);
    expect(queue(now())).toEqual([]);
    await manager.stop();
  });
});

// -- The connection's work, cut short -----------------------------------------

describe('Pause sync — the work of the connection it closes', () => {
  it('drops a join and a listing that answer after the pause; resume waits for them, then joins again', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    // Renamed by a teammate before this device connects: applied from the
    // listing, it moves the note on disk.
    server.teammateRename('f1', 'x.md');
    const listings: Array<() => void> = [];
    h.routes.set('GET /api/projects/p1/files', async () => {
      const held = deferred<void>();
      listings.push(() => held.resolve());
      await held.promise;
      return json({ files: h.serverFiles.map((f) => ({ ...f, size: String(f.size) })) });
    });
    await h.engine.start();
    await flushAsync();
    const first = h.socket();
    expect(listings).toHaveLength(1);

    h.engine.pause();
    expect(h.engine.getStatus()).toBe('offline');
    const resumed = h.engine.resume();
    await flushAsync(20);
    // The listing of the closed connection is still on its way.
    expect(h.socketIfBuilt()).toBe(first);
    expect(connects(h)).toBe(1);

    // Both answers come late.
    first.pending('project:join').ack(server.joinAnswer('whole journal'));
    listings[0]?.();
    await resumed;
    await flushAsync(20);
    // Neither was applied, and the next connect is under way.
    expect(disk(h)).toEqual(['a.md=A\n']);
    expect(h.log.getFileMeta('b1', 'a.md')?.serverFileId).toBe('f1');
    expect(h.socket()).not.toBe(first);
    expect(listings).toHaveLength(2);

    listings[1]?.();
    await answerJoin(h, server, docs);
    expect(disk(h)).toEqual(['x.md=A\n']);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('ends a connect waiting for its streamed catch-up at once', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    await h.engine.start();
    h.socket().pending('project:join').ack({
      ok: true,
      operations: [],
      operationsCatchup: 2,
      yjsStream: true,
      yjsCount: 1,
    });
    await flushAsync(20);
    expect(h.engine.getStatus()).toBe('syncing');

    h.engine.pause();
    const statuses = h.statuses.length;
    // The next connect goes out at once. Waited out, the catch-up guard (five
    // minutes) held it, and then reported the binding connected while paused.
    const resumed = h.engine.resume();
    await flushAsync(10);
    expect(connects(h)).toBe(2);
    await resumed;
    expect(h.statuses.slice(statuses)).toEqual(['connecting', 'syncing']);

    await answerJoin(h, server, docs);
    expect(h.engine.getStatus()).toBe('connected');
    expect(h.statuses.filter((s) => s === 'connected')).toHaveLength(1);
    await h.engine.stop();
  });

  it('ends the drain: the operation in flight stays queued and goes out once; no first upload while paused', async () => {
    const entries: LogEntry[] = [];
    const logger = new Logger('debug', {
      write: (e) => {
        entries.push(e);
      },
    });
    const { h, server, docs } = await seeded(
      [
        ['a.md', 'f1', 'A\n'],
        ['b.md', 'f2', 'B\n'],
      ],
      [],
      { logger },
    );
    h.engine.pause();
    await h.engine.start();
    await userRename(h, 'a.md', 'a2.md');
    h.vault.files.delete('b.md');
    await h.engine.handleVaultEvent(vaultEvent('delete', 'b.md'));
    expect(queue(h)).toEqual(['RENAME a.md -> a2.md', 'DELETE b.md']);

    await h.engine.resume();
    h.socket()
      .pending('project:join')
      .ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
    await flushAsync(30);
    // The drain sent the rename; its answer has not come.
    expect(h.socket().pending('file:rename')).toBeDefined();
    const mark = markOf(h);

    h.engine.pause();
    await flushAsync(30);
    expect(queue(h)).toEqual(['RENAME a.md -> a2.md', 'DELETE b.md']);
    expect(h.requests.slice(mark.requests)).toEqual([]);
    expect(entries.map((e) => e.message)).not.toContain('offline queue drain halted');

    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(server.applied).toEqual(['f1 a.md -> a2.md', 'delete f2']);
    expect(disk(h)).toEqual(['a2.md=A\n']);
    expect(queue(h)).toEqual([]);
    await h.engine.stop();
  });

  it('cancels an upload on its way and queues its change, sent once on resume', async () => {
    const { h, server, docs } = await seeded([]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    const upload = deferred<void>();
    h.routes.set('PUT /blobs', async () => {
      await upload.promise;
      return json({ ok: true });
    });
    h.vault.files.set('pic.png', encode('pic'));
    const handled = h.engine.handleVaultEvent(vaultEvent('create', 'pic.png'));
    await flushAsync(20);
    expect(h.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);

    h.engine.pause();
    await handled;
    expect(queue(h)).toEqual(['CREATE pic.png']);
    upload.resolve();
    await flushAsync(20);
    expect(h.socket().created()).toEqual([]);

    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(server.applied).toEqual(['create pic.png']);
    expect(h.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(queue(h)).toEqual([]);
    await h.engine.stop();
  });

  it('cancels a teammate’s attachment on its way down without an error; the resume brings it', async () => {
    const { h, server, docs } = await seeded([], [['att.png', 'f3', 'v1']]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    const download = deferred<void>();
    h.routes.set('GET /api/projects/p1/files/f3', async () => {
      await download.promise;
      return bytes(encode('v2'));
    });
    await server.teammateUpdate('f3', encode('v2'));
    await flushAsync(20);
    expect(h.requests.map((r) => r.path)).toContain('/api/projects/p1/files/f3');

    const statuses = h.statuses.length;
    h.engine.pause();
    await flushAsync(20);
    expect(h.statuses.slice(statuses)).not.toContain('error');
    expect(h.engine.getStatus()).toBe('offline');
    expect(disk(h)).toEqual(['att.png=v1']);

    download.resolve();
    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(disk(h)).toEqual(['att.png=v2']);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('keeps a local delete that lets a teammate’s attachment into the name while paused', async () => {
    const { h, server, docs } = await seeded([], [['img.png', 'f1', 'mine']]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    // Renamed while paused to a name a teammate gives their attachment
    // meanwhile.
    h.engine.pause();
    await userRename(h, 'img.png', 'pic.png');
    const theirs = await server.teammateUpload('pic.png', encode('theirs'));
    h.routes.set(`GET /api/projects/p1/files/${theirs}`, () => bytes(encode('theirs')));
    // Resumed: their file waits for the name, and the drain sends the rename.
    await h.engine.resume();
    h.socket()
      .pending('project:join')
      .ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
    await flushAsync(30);
    expect(h.socket().pending('file:rename')).toBeDefined();

    // Paused again, and the copy here deleted: the name is free, and their
    // file would come down into it — not while paused.
    h.engine.pause();
    h.vault.files.delete('pic.png');
    await h.engine.handleVaultEvent(vaultEvent('delete', 'pic.png'));
    expect(h.eventErrors).toEqual([]);
    expect(disk(h)).toEqual([]);

    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(server.pathOf('f1')).toBeNull();
    expect(server.pathOf(theirs)).toBe('pic.png');
    expect(disk(h)).toEqual(['pic.png=theirs']);
    expect(queue(h)).toEqual([]);
    await h.engine.stop();
  });

  it('keeps a delete queued when the pause cuts the check of the server’s doc short', async () => {
    const { h, server, docs } = await seeded([]);
    h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
    await docs.add('f1', 'P.md', 'A\n');
    await h.engine.start();
    await answerJoin(h, server, docs);
    // Edited online: the note's history here has the server's.
    h.vault.files.set('P.md', encode('A\nB\n'));
    const saved = h.engine.handleVaultEvent(vaultEvent('modify', 'P.md'));
    await docs.drive();
    await saved;
    await docs.drive();
    expect(docs.text('f1')).toBe('A\nB\n');
    // The server's listing follows its doc.
    const file = server.files.get('f1');
    if (!file) throw new Error('no f1');
    server.add({ ...file, contentHash: await sha256Hex('A\nB\n'), size: 4 });

    // Edited again and deleted while paused: the listing's text is neither of
    // the two this device knows the note by, so the connect asks the server
    // for its doc before it sends the delete.
    h.engine.pause();
    h.vault.files.set('P.md', encode('A\nB\nC\n'));
    await h.engine.handleVaultEvent(vaultEvent('modify', 'P.md'));
    h.vault.files.delete('P.md');
    await h.engine.handleVaultEvent(vaultEvent('delete', 'P.md'));
    expect(queue(h)).toEqual(['DELETE P.md']);

    await h.engine.resume();
    h.socket()
      .pending('project:join')
      .ack(server.joinAnswer('whole journal', { yjsDocs: docs.snapshots() }));
    await flushAsync(30);
    expect(h.socket().fetches.map((f) => f.fileId)).toEqual(['f1']);

    // Paused while the doc is on its way: no answer, not a "no".
    h.engine.pause();
    await flushAsync(30);
    expect(queue(h)).toEqual(['DELETE P.md']);
    expect(disk(h)).toEqual([]);

    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(server.pathOf('f1')).toBeNull();
    expect(disk(h)).toEqual([]);
    expect(queue(h)).toEqual([]);
    await h.engine.stop();
  });
});

// -- Lifecycle ----------------------------------------------------------------

describe('Pause sync — lifecycle', () => {
  it('connects once for pauses and resumes in quick succession', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    expect(connects(h)).toBe(1);

    h.engine.pause();
    const r1 = h.engine.resume();
    h.engine.pause();
    const r2 = h.engine.resume();
    h.engine.pause();
    const r3 = h.engine.resume();
    await Promise.all([r1, r2, r3]);
    expect(connects(h)).toBe(2);

    await answerJoin(h, server, docs);
    expect(h.engine.getStatus()).toBe('connected');
    expect(h.socket().emits.filter((e) => e.event === 'project:join')).toHaveLength(1);
    await h.engine.stop();
  });

  it('stays disconnected after a pause and a resume cut short by another pause', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    h.engine.pause();
    const resumed = h.engine.resume();
    h.engine.pause();
    await resumed;
    await flushAsync();
    expect(connects(h)).toBe(1);
    expect(h.engine.isPaused()).toBe(true);
    expect(h.engine.getStatus()).toBe('offline');
    await h.engine.stop();
  });

  it('records changes in an engine paused before it started, and connects on resume', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    h.engine.pause();
    await h.engine.start();
    expect(h.socketIfBuilt()).toBeNull();
    expect(h.engine.getStatus()).toBe('offline');

    await userRename(h, 'a.md', 'b.md');
    expect(queue(h)).toEqual(['RENAME a.md -> b.md']);

    await h.engine.resume();
    await answerJoin(h, server, docs);
    expect(server.applied).toEqual(['f1 a.md -> b.md']);
    expect(disk(h)).toEqual(['b.md=A\n']);
    await h.engine.stop();
  });

  it('stops cleanly while paused: a change it holds is queued, and nothing runs after', async () => {
    const { h, server, docs } = await seeded([['a.md', 'f1', 'A\n']]);
    await h.engine.start();
    await answerJoin(h, server, docs);
    h.engine.pause();

    const read = h.vault.gate('readBinary');
    h.vault.files.set('pic.png', encode('pic'));
    const handled = h.engine.handleVaultEvent(vaultEvent('create', 'pic.png'));
    await read.reached;
    await h.engine.stop();
    const mark = markOf(h);
    read.release();
    await handled;
    await h.engine.resume();
    await flushAsync(20);

    expect(queue(h)).toEqual(['CREATE pic.png']);
    expectQuietSince(h, mark);
  });
});
