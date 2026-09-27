/**
 * This device's own operations, known by their `opId`s (TASK-0035, spec §6.6):
 * a broadcast is this device's own when it carries the `opId` of an operation
 * on its way from here, and a catch-up row when its `opId` is one this device
 * knows — never by the client id alone, which a vault copied along with its
 * `data.json` shares. And what the server says of a file it broadcasts is
 * taken as it says it: where it stored a teammate's create (under a conflict
 * name too), and the file's type. A `yjs:update` is a note's only.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { newOpId } from '@/sync/operation-log';
import { Logger, type LogEntry } from '@/utils/logger';
import type { VaultEvent } from '@/watcher/obsidian-events';
import type { ServerOperation } from '@/client/socket';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  bytes,
  connect,
  encode,
  flushAsync,
  joinsOf,
  nextJoin,
  serverDocWith,
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
  entries: LogEntry[];
}

/** Notes and attachments on disk, in `state.json` and on the server; connected. */
async function online(notes: Seed = [], attachments: Seed = []): Promise<Bench> {
  const entries: LogEntry[] = [];
  const logger = new Logger('debug', { write: (e) => void entries.push(e) });
  const h = buildHarness({ logger });
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
  return { h, server, docs, entries };
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

/** The lines logged about another device using this device's client id. */
function twinLines(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.message.includes('uses the same id'));
}

async function emitted(h: Harness, name: string): Promise<Emit> {
  for (let i = 0; i < 50; i++) {
    const hit = h.socket().emits.find((e) => e.event === name);
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

// -- The catch-up ----------------------------------------------------------------

describe('SyncEngine — its own rows in a catch-up, by their opIds', () => {
  // A note this device created under the name of a note a teammate deleted,
  // its answer lost: the server brought the deleted note's id back for it.
  // A catch-up that returns this device's create next to the teammate's
  // delete showed the note deleted and created again — taken for one a
  // teammate made while this device was away, the rename made here since was
  // dropped, and the note went back to its old name for the whole team.
  it('does not take a note it created under a deleted one’s name for one made while away', async () => {
    const b = await online([['u.md', 'f1', 'old\n']]);
    b.server.teammateDelete('f1');
    await b.docs.drive();
    expect(disk(b.h)).toEqual([]);

    b.h.vault.files.set('u.md', encode('mine\n'));
    const creating = b.h.engine.handleVaultEvent(event('create', 'u.md'));
    const create = await emitted(b.h, 'file:create');
    // Applied — the server brings f1 back for it — and the answer is lost.
    create.ack = (): void => undefined;
    expect(b.server.serveNext()).toBe(true);
    drop(b.h);
    await creating;
    // Offline, the user gives it a name.
    await userRename(b.h, 'u.md', 't.md');

    const before = joinsOf(b.h);
    b.h.socket().connect();
    // The whole journal, this device's own create among it.
    (await nextJoin(b.h, before)).ack(
      b.server.joinAnswer('whole journal', { yjsDocs: b.docs.snapshots(), clock: {} }),
    );
    await b.docs.drive();

    expect(live(b.server)).toEqual(['f1:t.md']);
    expect(disk(b.h)).toEqual(['t.md=mine\n']);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    expect(twinLines(b.entries)).toEqual([]);
    await b.h.engine.stop();
  });

  /** A catch-up row of an attachment update by `clientId`, with an `opId` of its own. */
  function updateRow(clientId: string | null, hash: string, clock: number): ServerOperation {
    return {
      id: `l${clock}`,
      opType: 'UPDATE',
      filePath: 'img.png',
      newPath: null,
      authorId: 'u1',
      clientId,
      opId: clientId === null ? null : newOpId(),
      vectorClock: { [clientId ?? 'device-9']: clock },
      payload: { fileId: 'f2', contentHash: hash, size: 2, fileType: 'BINARY' },
      createdAt: '2026-01-01',
    };
  }

  /**
   * `img.png` synced here at `v1`; the server has `v2`, uploaded by `rows`
   * (under this device's client id, but not from here). `hadState`: whether
   * the binding had synced on this device before.
   */
  async function catchUpOn(
    rows: (hash: string) => ServerOperation[],
    hadState: boolean,
  ): Promise<{ h: Harness; entries: LogEntry[] }> {
    const entries: LogEntry[] = [];
    const h = buildHarness({ logger: new Logger('debug', { write: (e) => void entries.push(e) }) });
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
    return { h, entries };
  }

  it('applies rows under its client id with opIds it does not know as a teammate’s, said once', async () => {
    const { h, entries } = await catchUpOn(
      (hash) => [updateRow('device-1', hash, 7), updateRow('device-1', hash, 8)],
      true,
    );

    expect(h.vault.text('img.png')).toBe('v2');
    expect(twinLines(entries)).toHaveLength(1);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });

  it('says nothing of them when the binding had never synced here (state.json lost)', async () => {
    const { h, entries } = await catchUpOn((hash) => [updateRow('device-1', hash, 7)], false);

    expect(h.vault.text('img.png')).toBe('v2');
    expect(twinLines(entries)).toEqual([]);
    await h.engine.stop();
  });

  it('applies a row logged before the server recorded clients as a teammate’s', async () => {
    const { h, entries } = await catchUpOn((hash) => [updateRow(null, hash, 7)], true);

    expect(h.vault.text('img.png')).toBe('v2');
    expect(twinLines(entries)).toEqual([]);
    await h.engine.stop();
  });
});

// -- Broadcasts -----------------------------------------------------------------

describe('SyncEngine — what a broadcast says of a file', () => {
  // Deferred item 4 of the spec: the outcome of a create stored under a
  // conflict name has no `path`, and a teammate's such create waited for the
  // next connect.
  it('brings a teammate’s create stored under a conflict name in at once', async () => {
    const b = await online([['a.md', 'f1', 'mine\n']]);

    const id = await b.server.teammateCreate('a.md', 'theirs\n');
    await b.docs.drive();

    expect(disk(b.h)).toEqual(['a.conflict-device-2.md=theirs\n', 'a.md=mine\n']);
    expect(b.h.engine.getFileIdForPath('a.conflict-device-2.md')).toBe(id);
    expect(b.h.engine.getFileIdForPath('a.md')).toBe('f1');
    await b.h.engine.stop();
  });

  it('finds where it went in the outcome when the broadcast does not say', async () => {
    const b = await online([['a.md', 'f1', 'mine\n']]);
    const log = { id: 'l9', vectorClock: { 'device-2': 9 }, createdAt: '2026-01-01' };

    b.h.socket().fire('file:created', {
      result: {
        outcome: {
          kind: 'conflict_create_renamed',
          fileId: 'f7',
          originalPath: 'a.md',
          finalPath: 'a.conflict-device-2.md',
        },
        log,
      },
      clientId: 'device-2',
      opId: newOpId(),
      revived: false,
      log,
    });
    await flushAsync(20);
    b.h.socket().fire('yjs:update', {
      fileId: 'f7',
      update: Array.from(Y.encodeStateAsUpdate(serverDocWith('theirs\n'))),
    });
    await flushAsync(40);
    await b.h.settle();

    expect(disk(b.h)).toEqual(['a.conflict-device-2.md=theirs\n', 'a.md=mine\n']);
    expect(b.h.engine.getFileIdForPath('a.conflict-device-2.md')).toBe('f7');
    await b.h.engine.stop();
  });

  // A name without an extension is an attachment by its name alone; the
  // server knows the file for a note. Taken for an attachment, its bytes were
  // asked for over REST and its text never came.
  it('takes the file type the server gives', async () => {
    const b = await online([['a.md', 'f1', 'A\n']]);

    const id = await b.server.teammateCreate('LICENSE', 'MIT\n');
    await b.docs.drive();

    expect(b.h.vault.text('LICENSE')).toBe('MIT\n');
    expect(b.h.engine.getFileIdForPath('LICENSE')).toBe(id);
    expect(b.h.requests.filter((r) => r.path.includes(`/files/${id}`))).toEqual([]);
    expect(b.h.engine.getStatus()).toBe('connected');
    await b.h.engine.stop();
  });

  // Deferred item 3 of the spec: a server that took a `yjs:update` for an
  // attachment passed it on; applied, it opened a doc under the attachment's
  // name, and the snapshot wrote the doc's text over its bytes.
  it('leaves an attachment alone when a yjs:update comes for it', async () => {
    const b = await online([], [['img.png', 'f2', 'bytes']]);

    b.h.socket().fire('yjs:update', {
      fileId: 'f2',
      update: Array.from(Y.encodeStateAsUpdate(serverDocWith('text over the bytes'))),
    });
    await flushAsync(40);
    b.docs.answerFetches();
    await flushAsync(40);
    await b.h.settle();

    expect(b.h.vault.text('img.png')).toBe('bytes');
    expect(b.h.doc.has('b1', 'img.png')).toBe(false);
    expect(b.h.socket().fetches).toEqual([]);
    expect(b.h.engine.getStatus()).toBe('connected');
    await b.h.engine.stop();
  });

  it('takes a broadcast of its own by the opId on its way, not by the client id', async () => {
    const b = await online([['a.md', 'f1', 'A\n']]);
    const renaming = userRename(b.h, 'a.md', 'b.md');
    await renaming;

    // The server answered it (see `userRename`): its broadcast came back
    // first and changed nothing, and nothing more goes out.
    expect(disk(b.h)).toEqual(['b.md=A\n']);
    expect(live(b.server)).toEqual(['f1:b.md']);
    expect(b.h.socket().emits.filter((e) => e.event.startsWith('file:'))).toHaveLength(1);
    expect(twinLines(b.entries)).toEqual([]);

    // The same broadcast again, now that nothing is on its way: another
    // device's under this device's client id — applied.
    const log = { id: 'l9', vectorClock: { 'device-1': 9 }, createdAt: '2026-01-01' };
    b.h.socket().fire('file:renamed', {
      fileId: 'f1',
      newPath: 'c.md',
      requestedPath: 'c.md',
      outcome: { kind: 'renamed', fileId: 'f1', from: 'b.md', to: 'c.md' },
      clientId: 'device-1',
      opId: newOpId(),
      log,
    });
    await flushAsync(40);
    await b.h.settle();

    expect(disk(b.h)).toEqual(['c.md=A\n']);
    expect(twinLines(b.entries)).toHaveLength(1);
    await b.h.engine.stop();
  });
});
