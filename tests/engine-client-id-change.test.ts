/**
 * The engine after the vault's client id changed (`settings/client-identity`:
 * a copy of the vault, or another device seen under the id): its own
 * operations are known by their `opId`s whatever id they went out under, its
 * counters under the ids it sent under before move up with the operations the
 * server applied for it — a copy has no such id, and the original's operations
 * reach it in the catch-up — and nothing of the queue goes out under the new
 * id with an `opId` the server may have applied under the old one. Another
 * device under this device's id is reported to the plugin, which gives the
 * vault a new id on its next start.
 *
 * The engine runs against the {@link FakeServer} on a {@link FakeStorage}: a
 * restart is a new engine, under the new id, from the `state.json` the disk
 * has at that moment.
 */
import { settleClientIdentity, type VaultStore } from '@/settings/client-identity';
import { sha256Hex } from '@/sync/hash';
import { newOpId } from '@/sync/operation-log';
import type { ServerOperation } from '@/client/socket';
import { Logger, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import {
  FakeServer,
  FakeStorage,
  ServerDocs,
  buildHarness,
  bytes,
  connect,
  encode,
  flushAsync,
  joinClockOf,
  joinsOf,
  logOn,
  nextJoin,
  restartFromDisk,
  serverFile,
  userRename,
  type Emit,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

type Seed = ReadonlyArray<readonly [path: string, fileId: string, content: string]>;

interface Bench {
  h: Harness;
  server: FakeServer;
  docs: ServerDocs;
  storage: FakeStorage;
  entries: LogEntry[];
  /** The client ids the engines reported another device under. */
  twins: string[];
}

function recorder(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: new Logger('debug', { write: (e) => void entries.push(e) }), entries };
}

/** Notes on disk, in `state.json` and on the server; connected as `device-1`. */
async function online(notes: Seed): Promise<Bench> {
  const storage = new FakeStorage();
  const log = await logOn(storage);
  const { logger, entries } = recorder();
  const twins: string[] = [];
  const h = buildHarness({ log, logger, onTwinDetected: (id) => void twins.push(id) });
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
  return { h, server, docs, storage, entries, twins };
}

/**
 * Obsidian quits (`state.json` written) and starts again, the vault's client
 * id changed to `device-1b` meanwhile: it left `device-1`, which another device
 * used too, and under which it had sent its operations. The new engine is not
 * started.
 */
async function restartAsNewId(b: Bench): Promise<Bench> {
  await b.h.log.persistNow();
  const { logger, entries } = recorder();
  const twins: string[] = [];
  const { next, storage } = await restartFromDisk(b.h, b.storage, {
    server: b.server,
    docs: b.docs,
    identity: {
      clientId: 'device-1b',
      previousClientIds: ['device-1'],
      onTwinDetected: (id) => void twins.push(id),
      logger,
    },
  });
  return { ...b, h: next, storage, entries, twins };
}

function event(type: VaultEvent['type'], path: string): VaultEvent {
  return { bindingId: 'b1', type, path, source: 'obsidian' } as VaultEvent;
}

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function live(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => `${f.id}:${f.path}`)
    .sort();
}

function queue(h: Harness): string[] {
  return h.log
    .dequeueOperations('b1')
    .map((op) => `${op.opType} ${op.filePath}${op.newPath ? ` -> ${op.newPath}` : ''}`);
}

/** The lines logged about another device using this device's client id. */
function twinLines(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.message.includes('uses the same id'));
}

/** The server applied each opId once. */
function appliedOnce(server: FakeServer): void {
  expect(new Set(server.appliedOpIds).size).toBe(server.appliedOpIds.length);
}

async function emitted(h: Harness, name: string, count = 1): Promise<Emit> {
  for (let i = 0; i < 50; i++) {
    const hit = h.socket().emits.filter((e) => e.event === name)[count - 1];
    if (hit !== undefined) return hit;
    await flushAsync(2);
  }
  throw new Error(`no ${name} sent`);
}

/** The connection drops: emits waiting for their answers get none. */
function drop(h: Harness): void {
  h.socket().connected = false;
  h.socket().fire('disconnect', 'transport close');
}

/** Lose the ack of `e`: the server applies it, the answer never comes. */
function loseAck(e: Emit): void {
  e.ack = (): void => undefined;
}

/** The user renames `from`; resolves once its rename is out, not answered yet. */
async function renameOut(h: Harness, from: string, to: string): Promise<Emit> {
  const before = h.socket().emits.filter((e) => e.event === 'file:rename').length;
  await h.vault.rename(from, to);
  return emitted(h, 'file:rename', before + 1);
}

/** Let the server work until the engine's queue is empty (a bounded number of rounds). */
async function serveQueue(b: Bench): Promise<void> {
  await b.docs.drive();
  for (let round = 0; round < 5 && b.h.log.dequeueOperations('b1').length > 0; round++) {
    await b.docs.drive();
  }
}

/**
 * On `device-1`: the teammate deletes note `u.md` (f1); the user makes a note
 * under its name, and the server applies the create — bringing f1 back for it
 * — while the answer is lost; offline, the user renames the note to `t.md`.
 */
async function createdUnderDeletedName(): Promise<Bench> {
  const b = await online([['u.md', 'f1', 'old\n']]);
  b.server.teammateDelete('f1');
  await b.docs.drive();
  expect(disk(b.h)).toEqual([]);

  b.h.vault.files.set('u.md', encode('mine\n'));
  const creating = b.h.engine.handleVaultEvent(event('create', 'u.md'));
  loseAck(await emitted(b.h, 'file:create'));
  expect(b.server.serveNext()).toBe(true);
  drop(b.h);
  await creating;
  await userRename(b.h, 'u.md', 't.md');
  return b;
}

// -- Its own operations under the id it had before ----------------------------

describe('SyncEngine — its own operations after the client id changed', () => {
  // The whole journal, from an empty clock: this device's create comes back
  // under `device-1`, next to the teammate's delete, in the connect that
  // settled it with `ops:status`. Its `opId` is known, whatever id it went out
  // under: nothing of it is applied again, and the offline rename reaches the
  // server. A safeguard, like the own rows of the current id: the counter the
  // join carries leaves such a row out (see the next test).
  it('takes its own create under the previous id, settled in this connect, for its own', async () => {
    const b = await restartAsNewId(await createdUnderDeletedName());
    const before = joinsOf(b.h);
    await b.h.engine.start();
    // The whole journal, this device's create among it under `device-1`.
    (await nextJoin(b.h, before)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots(), clock: {} }),
    );
    await serveQueue(b);

    expect(live(b.server)).toEqual(['f1:t.md']);
    expect(disk(b.h)).toEqual(['t.md=mine\n']);
    expect(queue(b.h)).toEqual([]);
    expect(twinLines(b.entries)).toEqual([]);
    expect(b.twins).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  // The connect that settled the create with the server dropped before its
  // catch-up. The next one no longer knew the create's opId, and its counter
  // under `device-1` had stayed where it was: the catch-up returned the create
  // as an operation of another device.
  it('moves its counter under the previous id up with an operation settled under it', async () => {
    const b = await restartAsNewId(await createdUnderDeletedName());
    const created = b.server.journal.find((row) => row.opType === 'CREATE');
    const counter = created?.vectorClock['device-1'] ?? 0;
    expect(created?.clientId).toBe('device-1');
    expect(counter).toBeGreaterThan(0);

    const first = joinsOf(b.h);
    await b.h.engine.start();
    await nextJoin(b.h, first);
    // `ops:status` answered the create applied; the connection drops before
    // the join is answered.
    expect(b.server.statusAnswers.at(-1)?.applied).toHaveLength(1);
    drop(b.h);
    await flushAsync(20);

    const second = joinsOf(b.h);
    b.h.socket().connect();
    const join = await nextJoin(b.h, second);
    const clock = joinClockOf(b.h);
    expect(clock['device-1']).toBeGreaterThanOrEqual(counter);
    // The catch-up for that clock leaves the create out.
    expect(b.server.catchupFor(clock).filter((row) => row.clientId === 'device-1')).toEqual([]);
    join.ack(b.server.joinAnswer('whole journal', { clock, yjsDocs: b.docs.snapshots() }));
    await serveQueue(b);

    expect(live(b.server)).toEqual(['f1:t.md']);
    expect(disk(b.h)).toEqual(['t.md=mine\n']);
    expect(queue(b.h)).toEqual([]);
    expect(twinLines(b.entries)).toEqual([]);
    appliedOnce(b.server);
    await b.h.engine.stop();
  });

  it('sends nothing of the queue under the new id with an opId from before ops:status', async () => {
    const b = await online([
      ['a.md', 'f1', 'a\n'],
      ['c.md', 'f2', 'c\n'],
      ['e.md', 'f3', 'e\n'],
    ]);
    // Applied, its answer lost.
    const applied = await renameOut(b.h, 'a.md', 'b.md');
    loseAck(applied);
    expect(b.server.serveNext()).toBe(true);
    // Lost on its way: the server never gets it.
    const lost = await renameOut(b.h, 'e.md', 'g.md');
    b.server.delay(lost);
    b.h.socket().disconnect();
    await flushAsync(20);
    // Offline: queued, never sent.
    await userRename(b.h, 'c.md', 'd.md');
    const old = [applied, lost].map((e) => (e.payload as { opId: string }).opId);
    const queued = b.h.log.dequeueOperations('b1').map((op) => op.opId);
    for (const opId of old) expect(queued).toContain(opId);
    expect(queued).toHaveLength(3);

    const n = await restartAsNewId(b);
    const before = joinsOf(n.h);
    await n.h.engine.start();
    (await nextJoin(n.h, before)).ack(
      n.server.joinAnswer('whole journal', { yjsDocs: n.docs.snapshots() }),
    );
    await serveQueue(n);

    const socket = n.h.socket();
    const status = socket.statusQueries[0];
    expect((status?.payload as { opIds: string[] }).opIds.sort()).toEqual([...queued].sort());
    const ops = socket.emits.filter((e) => e.event.startsWith('file:'));
    expect(ops.length).toBeGreaterThan(0);
    for (const e of ops) {
      const payload = e.payload as { opId: string; clientId: string };
      expect(queued).not.toContain(payload.opId);
      expect(payload.clientId).toBe('device-1b');
      expect(e.seq ?? 0).toBeGreaterThan(status?.seq ?? Number.POSITIVE_INFINITY);
    }
    expect(live(n.server)).toEqual(['f1:b.md', 'f2:d.md', 'f3:g.md']);
    expect(disk(n.h)).toEqual(['b.md=a\n', 'd.md=c\n', 'g.md=e\n']);
    expect(queue(n.h)).toEqual([]);
    // Applied under `device-1` once, never again under `device-1b`.
    expect(n.server.appliedOpIds.filter((id) => id === old[0])).toHaveLength(1);
    expect(n.server.appliedOpIds).not.toContain(old[1]);
    appliedOnce(n.server);
    await n.h.engine.stop();
  });
});

// -- A copy of the vault -------------------------------------------------------

describe('SyncEngine — a copy of the vault, under the id it was given', () => {
  /** A vault's local storage in Obsidian, empty: the copy's. */
  function emptyStore(): VaultStore {
    const items = new Map<string, string>();
    return {
      load: (key) => items.get(key) ?? null,
      save: (key, value) => {
        if (value === null) items.delete(key);
        else items.set(key, value);
      },
    };
  }

  // The regression: the copy took the original's id — in use by the original
  // — for one it had synced under, and moved its counter under it up with the
  // queue it took along. An operation of that queue the original sent after
  // the copy was made, after an attachment it replaced meanwhile, lifted the
  // copy's counter past the replacement: it never came to the copy in a
  // catch-up, and the copy kept the old attachment for good.
  it('gets every operation the original sent after the copy in its catch-up', async () => {
    const b = await online([['a.md', 'f1', 'a\n']]);
    const v1 = encode('v1');
    const v2 = encode('v2');
    const hash1 = await sha256Hex(v1);
    const hash2 = await sha256Hex(v2);
    b.h.vault.files.set('img.png', v1);
    b.h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'img.png',
      serverFileId: 'f2',
      contentHash: hash1,
      size: 2,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    b.server.add({ id: 'f2', path: 'img.png', fileType: 'BINARY', contentHash: hash1, size: 2 });
    // Offline, the user renames the note: queued, not sent yet.
    b.h.socket().disconnect();
    await flushAsync(20);
    await userRename(b.h, 'a.md', 'b.md');
    const queued = b.h.log.dequeueOperations('b1');
    expect(queued.map((op) => op.opType)).toEqual(['RENAME']);
    const renameOpId = queued[0]?.opId ?? '';
    const clock = { ...(b.h.log.getBindingState('b1')?.lastVectorClock ?? {}) };
    await b.h.log.persistNow();

    // The vault is copied now, its data.json and state.json with it, and
    // opened as a vault of its own: its local storage in Obsidian is empty.
    const { next: identity } = settleClientIdentity({
      current: {
        clientId: 'device-1',
        clientIdClaimed: true,
        twinClientId: '',
        clientIdRotatedAt: 0,
        previousClientIds: [],
      },
      store: emptyStore(),
      now: Date.now(),
      newId: () => 'device-1b',
    });
    expect(identity.clientId).toBe('device-1b');
    const { logger, entries } = recorder();
    const { next: copy } = await restartFromDisk(b.h, b.storage, {
      server: b.server,
      docs: b.docs,
      identity: {
        clientId: identity.clientId,
        previousClientIds: identity.previousClientIds,
        logger,
      },
    });

    // The original, meanwhile, under `device-1`: it replaces the attachment,
    // then sends the rename the copy's queue holds too.
    const base = clock['device-1'] ?? 0;
    expect(
      b.server.serveFrom('file:update-binary', {
        clientId: 'device-1',
        opId: newOpId(),
        vectorClock: clock,
        fileId: 'f2',
        filePath: 'img.png',
        fileType: 'BINARY',
        contentHash: hash2,
        size: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(
      b.server.serveFrom('file:rename', {
        clientId: 'device-1',
        opId: renameOpId,
        vectorClock: { ...clock, 'device-1': base + 1 },
        fileId: 'f1',
        filePath: 'a.md',
        newPath: 'b.md',
      }),
    ).toMatchObject({ ok: true });
    copy.routes.set('GET /api/projects/p1/files/f2', () => bytes(v2));

    const before = joinsOf(copy);
    await copy.engine.start();
    const join = await nextJoin(copy, before);
    // The server applied the rename of the copy's queue — the original's.
    expect(b.server.statusAnswers.at(-1)?.applied).toEqual([renameOpId]);
    join.ack(
      b.server.joinAnswer('whole journal', {
        clock: joinClockOf(copy),
        yjsDocs: b.docs.snapshots(),
      }),
    );
    await serveQueue({ ...b, h: copy });
    await flushAsync(20);

    expect(disk(copy)).toEqual(['b.md=a\n', 'img.png=v2']);
    expect(copy.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(hash2);
    expect(live(b.server)).toEqual(['f1:b.md', 'f2:img.png']);
    expect(queue(copy)).toEqual([]);
    expect(twinLines(entries)).toEqual([]);
    appliedOnce(b.server);
    await copy.engine.stop();
  });
});

// -- Rows of the id it had before, of another device --------------------------

describe('SyncEngine — rows under the id the vault had before', () => {
  /** A catch-up row of an attachment update by `clientId`, with an `opId` of its own. */
  function updateRow(clientId: string, hash: string, clock: number): ServerOperation {
    return {
      id: `l${clock}`,
      opType: 'UPDATE',
      filePath: 'img.png',
      newPath: null,
      authorId: 'u1',
      clientId,
      opId: newOpId(),
      vectorClock: { [clientId]: clock },
      payload: { fileId: 'f2', contentHash: hash, size: 2, fileType: 'BINARY' },
      createdAt: '2026-01-01',
    };
  }

  /**
   * `img.png` synced here at `v1` by `clientId`, its clock `{device-1: 3}`
   * (`hadState`: the binding synced here before); the server has `v2`,
   * uploaded under the ids `rows` says.
   */
  async function catchUpOn(
    clientId: string,
    rows: (hash: string) => ServerOperation[],
    hadState = true,
  ): Promise<{ h: Harness; entries: LogEntry[]; twins: string[] }> {
    const { logger, entries } = recorder();
    const twins: string[] = [];
    const h = buildHarness({
      clientId,
      previousClientIds: clientId === 'device-1' ? [] : ['device-1'],
      logger,
      onTwinDetected: (id) => void twins.push(id),
    });
    const v1 = encode('v1');
    const v2 = encode('v2');
    h.vault.files.set('img.png', v1);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'img.png',
      serverFileId: 'f2',
      contentHash: await sha256Hex(v1),
      size: 2,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    if (hadState) h.log.updateLastVectorClock('b1', { 'device-1': 3 });
    const hash = await sha256Hex(v2);
    h.serverFiles = [serverFile('f2', 'img.png', 'BINARY', hash, 2)];
    h.routes.set('GET /api/projects/p1/files/f2', () => bytes(v2));
    await connect(h, { operations: rows(hash) });
    await flushAsync(20);
    return { h, entries, twins };
  }

  // Not a regression of its own: the vault left `device-1` to a twin, and
  // what the twin sends under it is a teammate's to it — applied, nothing
  // reported.
  it('applies an update under its previous id with an opId it does not know', async () => {
    const { h, entries, twins } = await catchUpOn('device-1b', (hash) => [
      updateRow('device-1', hash, 4),
    ]);

    expect(h.vault.text('img.png')).toBe('v2');
    expect(h.log.getFileMeta('b1', 'img.png')?.contentHash).toBe(await sha256Hex(encode('v2')));
    expect(twinLines(entries)).toEqual([]);
    expect(twins).toEqual([]);
    await h.engine.stop();
  });
});

// -- Another device under this device's id ------------------------------------

describe('SyncEngine — another device under its client id', () => {
  function updateRow(hash: string, clock: number): ServerOperation {
    return {
      id: `l${clock}`,
      opType: 'UPDATE',
      filePath: 'img.png',
      newPath: null,
      authorId: 'u1',
      clientId: 'device-1',
      opId: newOpId(),
      vectorClock: { 'device-1': clock },
      payload: { fileId: 'f2', contentHash: hash, size: 2, fileType: 'BINARY' },
      createdAt: '2026-01-01',
    };
  }

  async function catchUpOn(
    rows: (hash: string) => ServerOperation[],
    hadState: boolean,
  ): Promise<{ h: Harness; entries: LogEntry[]; twins: string[] }> {
    const { logger, entries } = recorder();
    const twins: string[] = [];
    const h = buildHarness({ logger, onTwinDetected: (id) => void twins.push(id) });
    const v1 = encode('v1');
    const v2 = encode('v2');
    h.vault.files.set('img.png', v1);
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'img.png',
      serverFileId: 'f2',
      contentHash: await sha256Hex(v1),
      size: 2,
      fileType: 'BINARY',
      lastSyncedAt: 1,
    });
    if (hadState) h.log.updateLastVectorClock('b1', { 'device-1': 3 });
    const hash = await sha256Hex(v2);
    h.serverFiles = [serverFile('f2', 'img.png', 'BINARY', hash, 2)];
    h.routes.set('GET /api/projects/p1/files/f2', () => bytes(v2));
    await connect(h, { operations: rows(hash) });
    await flushAsync(20);
    return { h, entries, twins };
  }

  it('tells the plugin once, with the id, when a catch-up has rows of another device under it', async () => {
    const { h, entries, twins } = await catchUpOn(
      (hash) => [updateRow(hash, 7), updateRow(hash, 8)],
      true,
    );

    expect(h.vault.text('img.png')).toBe('v2');
    expect(twins).toEqual(['device-1']);
    const lines = twinLines(entries);
    expect(lines).toHaveLength(1);
    // What told, for a false alarm to be looked into.
    const detail = lines[0]?.args[0] as Record<string, unknown> | undefined;
    expect(detail).toMatchObject({ where: 'catch-up', clientId: 'device-1', opType: 'UPDATE' });
    expect(typeof detail?.opId).toBe('string');
    await h.engine.stop();
  });

  it('tells nothing when the binding had never synced here (state.json lost)', async () => {
    const { twins, entries } = await catchUpOn((hash) => [updateRow(hash, 7)], false);
    expect(twins).toEqual([]);
    expect(twinLines(entries)).toEqual([]);
  });

  it('tells nothing of its own operation it settled with ops:status', async () => {
    // The create went out under `device-1`, the id this engine still has.
    const b = await createdUnderDeletedName();
    const before = joinsOf(b.h);
    b.h.socket().connect();
    (await nextJoin(b.h, before)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots(), clock: {} }),
    );
    await b.docs.drive();

    expect(b.server.statusAnswers.at(-1)?.applied).toHaveLength(1);
    expect(live(b.server)).toEqual(['f1:t.md']);
    expect(b.twins).toEqual([]);
    expect(twinLines(b.entries)).toEqual([]);
    await b.h.engine.stop();
  });

  it('tells the plugin once per engine of broadcasts under its id it did not send', async () => {
    const b = await online([['a.md', 'f1', 'A\n']]);
    // Its own rename: the broadcast of it comes back while it is on its way.
    await userRename(b.h, 'a.md', 'b.md');
    expect(b.twins).toEqual([]);

    for (const newPath of ['c.md', 'd.md']) {
      const log = { id: `l-${newPath}`, vectorClock: { 'device-1': 9 }, createdAt: '2026-01-01' };
      b.h.socket().fire('file:renamed', {
        fileId: 'f1',
        newPath,
        requestedPath: newPath,
        outcome: { kind: 'renamed', fileId: 'f1', from: 'x', to: newPath },
        clientId: 'device-1',
        opId: newOpId(),
        log,
      });
      await flushAsync(40);
      await b.h.settle();
    }

    expect(disk(b.h)).toEqual(['d.md=A\n']);
    expect(b.twins).toEqual(['device-1']);
    expect(twinLines(b.entries)).toHaveLength(1);
    await b.h.engine.stop();
  });
});
