/**
 * Test bench for `SyncEngine`: an in-memory vault whose calls can be held, a
 * Socket.IO stand-in whose acks the test answers, REST routes read at request
 * time, and a record of every call the engine makes into its dependencies.
 *
 * The same bench as in `engine-stop.test.ts`, shared by the suites written
 * after it. `buildHarness(predecessor)` builds the engine the `EngineManager`
 * spawns after the one before it stopped — a reload, the binding switched off
 * and on: a fresh one on the same vault, log, docs and echo set. (Pause sync
 * keeps the engine: `engine.pause()` and `engine.resume()`.)
 *
 * Three things real Obsidian and the real server do are part of the bench,
 * because tests that left them out passed on code that looped in production:
 *
 *   - Obsidian's echo. Every `adapter.rename` — the plugin's own included —
 *     comes back as a vault `rename` event, fired inside the call before its
 *     promise resolves (app.js 1.13.7: `FileSystemAdapter.rename` triggers
 *     `renamed`, `Vault.onChange` turns it into `rename`). `MemoryVault.rename`
 *     does the same, and the event goes through a real `ObsidianWatcher` to
 *     the engine, the way `main.ts` wires them. A user's rename in Obsidian is
 *     that same call ({@link userRename}); a file moved while Obsidian was
 *     closed is {@link MemoryVault.move}.
 *   - The server's broadcasts. The server sends every file operation to the
 *     whole project room, the sender included, right before its ack. The
 *     {@link FakeServer} does that as the server this client needs does:
 *     with the sender's `clientId`, the operation's `opId` and the path the
 *     file was stored at.
 *   - A start without network. `offline: true` builds an engine whose socket
 *     cannot connect until {@link goOnline}.
 *
 * The {@link FakeServer} keeps the contract of `sync-protocol.md` §4 of the
 * 0.4 protocol (operation ids): it applies an `opId` once and answers a resend
 * with the original outcome (`duplicate`), answers `ops:status` — voiding what
 * it never applied — once the operations received before it are applied, and
 * puts `opId`s into its acks, journal rows and broadcasts. Its answers have the
 * shapes of the contract's examples, `tests/fixtures/protocol-0.4/`. And a
 * {@link FakeStorage} keeps `state.json` the way the disk has it: a restart
 * from it ({@link restartFromDisk}) sees only what was written.
 */
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import { SyncEngine, type EngineStatus } from '@/sync/engine';
import { OperationLog, isOpId, newOpId } from '@/sync/operation-log';
import type { LogStorage } from '@/utils/file-log-sink';
import {
  DocManager,
  type DocPersistence,
  type IdbRegistry,
  type PersistenceFactory,
} from '@/crdt/doc-manager';
import { diffChars, diffLines } from 'diff';
import { RecentlyApplied } from '@/watcher/recently-applied';
import {
  ObsidianWatcher,
  type VaultEvent,
  type WatchableFile,
  type WatchableVault,
} from '@/watcher/obsidian-events';
import { ApiClient, type RequestUrlResponse } from '@/client/api';
import type { ApiFile } from '@/client/types';
import {
  SocketClient,
  type ServerOperation,
  type SocketFactory,
  type SocketLike,
  type YjsDocSnapshot,
} from '@/client/socket';
import type {
  ConflictResolver,
  BinaryConflictResolution,
  DeleteConflictResolution,
} from '@/sync/conflict';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';
import type { Logger } from '@/utils/logger';

// -- Test doubles ---------------------------------------------------------------

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Record every method call made on `target` as `<label>.<method>`. */
function track<T extends object>(target: T, label: string, calls: string[]): T {
  return new Proxy(target, {
    get(obj, prop): unknown {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        calls.push(`${label}.${String(prop)}`);
        return method.apply(obj, args);
      };
    },
  });
}

export const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** A vault call held back until the test lets it through. */
export interface Gate {
  /** Resolves once the held call has started. */
  reached: Promise<void>;
  release(): void;
}

type RenameListener = (file: WatchableFile, oldPath: string) => void;

export class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
  /** `true` once {@link caseInsensitiveDisk} made it so. */
  isCaseInsensitive = (): boolean => false;
  private readonly renameListeners = new Set<RenameListener>();
  /**
   * The slice of `app.vault` an `ObsidianWatcher` listens on. Only `rename`
   * fires: the echo the engine has to tell from a user's rename. The engine's
   * writes and deletes are not echoed here — tests dispatch the events they
   * need.
   */
  readonly watchable = {
    on: (name: string, cb: RenameListener): unknown => {
      if (name === 'rename') this.renameListeners.add(cb);
      return cb;
    },
    offref: (ref: unknown): void => {
      this.renameListeners.delete(ref as RenameListener);
    },
  } as unknown as WatchableVault;
  private gates: Array<{
    method: string;
    skip: number;
    reached: () => void;
    open: Promise<void>;
  }> = [];

  /** Hold the next call of `method` (after `skip` calls) at its start. */
  gate(method: string, skip = 0): Gate {
    let release!: () => void;
    let reached!: () => void;
    const open = new Promise<void>((r) => {
      release = r;
    });
    const hit = new Promise<void>((r) => {
      reached = r;
    });
    this.gates.push({ method, skip, reached, open });
    return { reached: hit, release };
  }

  private async pass(method: string): Promise<void> {
    const gate = this.gates.find((g) => g.method === method);
    if (!gate) return;
    if (gate.skip > 0) {
      gate.skip -= 1;
      return;
    }
    this.gates.splice(this.gates.indexOf(gate), 1);
    gate.reached();
    await gate.open;
  }

  getBasePath(): string {
    return '/vault';
  }
  async exists(path: string): Promise<boolean> {
    await this.pass('exists');
    return this.files.has(path);
  }
  async readText(path: string): Promise<string> {
    await this.pass('readText');
    return new TextDecoder().decode(this.expect(path));
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    await this.pass('readBinary');
    return this.expect(path);
  }
  async createText(path: string, content: string): Promise<void> {
    await this.pass('createText');
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, encode(content));
  }
  async writeText(path: string, content: string): Promise<void> {
    await this.pass('writeText');
    this.files.set(path, encode(content));
  }
  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.pass('createBinary');
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, content);
  }
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.pass('writeBinary');
    this.files.set(path, content);
  }
  async delete(path: string): Promise<void> {
    await this.pass('delete');
    this.files.delete(path);
  }
  /**
   * `adapter.rename`, as Obsidian runs it: the file moves, then the vault
   * `rename` event fires — inside the call, before the promise resolves.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.pass('rename');
    this.move(oldPath, newPath);
    for (const cb of [...this.renameListeners]) cb({ path: newPath, kind: 'file' }, oldPath);
  }
  /** Move a file on disk without Obsidian seeing it: done while it was closed. */
  move(oldPath: string, newPath: string): void {
    const buf = this.expect(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, buf);
  }
  async ensureParentFolder(): Promise<void> {
    // No folders in memory.
    await this.pass('ensureParentFolder');
  }
  async list(folderPath: string): Promise<string[]> {
    const folder = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const paths = [...this.files.keys()];
    if (folder === '') return paths;
    return paths.filter((p) => p === folder || p.startsWith(`${folder}/`));
  }
  text(path: string): string | null {
    const buf = this.files.get(path);
    return buf ? new TextDecoder().decode(buf) : null;
  }
  private expect(path: string): ArrayBuffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`missing file ${path}`);
    return buf;
  }
}

/**
 * Make `vault` a disk that takes names differing only in case for one file,
 * as Obsidian's `FileSystemAdapter` on Windows or macOS sees it: a name is
 * found whatever its case, a write keeps the case the file has, a create or a
 * rename onto a name another file has fails, and a case-only rename changes
 * the case. The files map keeps each file under the case it has on disk.
 */
export function caseInsensitiveDisk(vault: MemoryVault): void {
  const key = (p: string): string => p.toLowerCase();
  const find = (p: string): string | undefined =>
    [...vault.files.keys()].find((k) => key(k) === key(p));
  const at = (p: string): ArrayBuffer => {
    const k = find(p);
    const buf = k === undefined ? undefined : vault.files.get(k);
    if (!buf) throw new Error(`ENOENT ${p}`);
    return buf;
  };
  const listeners = (vault as unknown as { renameListeners: Set<RenameListener> }).renameListeners;
  vault.isCaseInsensitive = (): boolean => true;
  vault.exists = (p) => Promise.resolve(find(p) !== undefined);
  vault.readBinary = (p) => Promise.resolve(at(p));
  vault.readText = (p) => Promise.resolve(new TextDecoder().decode(at(p)));
  vault.writeText = (p, c) => {
    vault.files.set(find(p) ?? p, encode(c));
    return Promise.resolve();
  };
  vault.writeBinary = (p, c) => {
    vault.files.set(find(p) ?? p, c);
    return Promise.resolve();
  };
  vault.createText = (p, c) => {
    if (find(p) !== undefined) return Promise.reject(new Error('exists'));
    vault.files.set(p, encode(c));
    return Promise.resolve();
  };
  vault.createBinary = (p, c) => {
    if (find(p) !== undefined) return Promise.reject(new Error('exists'));
    vault.files.set(p, c);
    return Promise.resolve();
  };
  vault.delete = (p) => {
    const k = find(p);
    if (k !== undefined) vault.files.delete(k);
    return Promise.resolve();
  };
  vault.rename = (from, to) => {
    if (from === to) return Promise.resolve();
    if (find(to) !== undefined && key(from) !== key(to)) {
      return Promise.reject(new Error('Destination file already exists!'));
    }
    const k = find(from);
    if (k === undefined) return Promise.reject(new Error(`ENOENT ${from}`));
    const buf = vault.files.get(k) as ArrayBuffer;
    vault.files.delete(k);
    vault.files.set(to, buf);
    for (const cb of [...listeners]) cb({ path: to, kind: 'file' }, from);
    return Promise.resolve();
  };
}

/** A database of Obsidian's own, listed next to the plugin's (see {@link FakeIndexedDb}). */
export const FOREIGN_DB = 'obsidian-vault-cache';

/**
 * y-indexeddb stand-in: one database per name, kept across releases and
 * restarts (a new `DocManager` on the same instance). Like the real one, a
 * store loads asynchronously and applies what it holds with itself as the
 * origin, stores the doc's own state when it opens (an update the doc got
 * before is kept, one it gets in between is not written twice), keeps a small
 * key/value area, and `clearData` deletes the database.
 * The registry lists and deletes databases by name, as the renderer's
 * `indexedDB` does for every vault on the machine.
 *
 * It starts with one database that is not the plugin's ({@link FOREIGN_DB}),
 * as Obsidian's origin always has: an empty listing is what a runtime that
 * cannot list databases returns, and `DocManager` then opens a store under
 * every name it checks — a path Obsidian never takes.
 */
export class FakeIndexedDb {
  readonly dbs = new Map<string, { updates: Uint8Array[]; custom: Map<string, unknown> }>([
    [FOREIGN_DB, { updates: [], custom: new Map() }],
  ]);
  /** Every database deleted, in order. */
  readonly deleted: string[] = [];
  readonly registry: IdbRegistry = {
    list: () => Promise.resolve([...this.dbs.keys()]),
    delete: (name) => {
      if (this.dbs.delete(name)) this.deleted.push(name);
      return Promise.resolve();
    },
  };
  readonly factory: PersistenceFactory = (name, doc) => this.open(name, doc);

  /** A fresh `DocManager` on these databases — what a restart of Obsidian builds. */
  manager(): DocManager {
    return new DocManager({ persistenceFactory: this.factory, idb: this.registry });
  }

  /** The text a database holds, as a doc loaded from it would show it. */
  textOf(name: string): string | null {
    const db = this.dbs.get(name);
    if (!db) return null;
    const doc = new Y.Doc();
    for (const u of db.updates) Y.applyUpdate(doc, u);
    const text = doc.getText('content').toJSON();
    doc.destroy();
    return text;
  }

  private open(name: string, doc: Y.Doc): DocPersistence {
    let db = this.dbs.get(name);
    if (!db) {
      db = { updates: [], custom: new Map() };
      this.dbs.set(name, db);
    }
    const store = db;
    let destroyed = false;
    let opened = false;
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (!destroyed && opened && origin !== persistence) store.updates.push(update);
    };
    const persistence: DocPersistence = {
      whenSynced: Promise.resolve().then(() => {
        if (destroyed) return;
        // What the doc got before its database opened is stored now, as
        // y-indexeddb does (`beforeApplyUpdatesCallback`): its update listener
        // writes nothing until then.
        opened = true;
        if (doc.store.clients.size > 0) store.updates.push(Y.encodeStateAsUpdate(doc));
        Y.transact(
          doc,
          () => {
            for (const u of store.updates) Y.applyUpdate(doc, u);
          },
          persistence,
          false,
        );
      }),
      destroy: () => {
        destroyed = true;
        doc.off('update', onUpdate);
      },
      clearData: () => {
        destroyed = true;
        doc.off('update', onUpdate);
        if (this.dbs.get(name) === store) {
          this.dbs.delete(name);
          this.deleted.push(name);
        }
      },
      get: (key) => Promise.resolve(store.custom.get(key)),
      set: (key, value) => {
        store.custom.set(key, value);
        return Promise.resolve();
      },
    };
    doc.on('update', onUpdate);
    return persistence;
  }
}

/** The database name `DocManager` gives the doc of `path` in binding `b1`. */
export function dbNameOf(path: string): string {
  return `team-vault-b1-${encodeURIComponent(path)}`;
}

export interface Emit {
  event: string;
  payload: unknown;
  ack: (response: unknown) => void;
  /** Order of the emit among every emit of the socket, `ops:status` included. */
  seq?: number;
  /** A `project:join` the test has answered (see {@link joinToAnswer}). */
  answered?: boolean;
}

/**
 * How an `ops:status` is answered when no {@link FakeServer} serves the
 * engine: every operation asked about is voided — the server never got it.
 */
function voidAll(e: Emit): void {
  const { opIds } = e.payload as { opIds: string[] };
  e.ack({ ok: true, applied: [], voided: [...opIds] });
}

/** Socket.IO stand-in: emits wait for the test to answer them. */
export class FakeSocket implements SocketLike {
  connected = false;
  /** `false` while there is no network: `connect()` fails until {@link goOnline}. */
  reachable = true;
  /** A connect was asked for while unreachable; {@link goOnline} completes it. */
  private wantsConnect = false;
  emits: Emit[] = [];
  /** `yjs:fetch` requests, answered by the test through `answer`. */
  fetches: Array<{ fileId: string; answer: (response: unknown) => void }> = [];
  /**
   * `ops:status` questions, in order. Kept out of {@link emits}, and answered
   * as they come by {@link statusResponder}.
   */
  statusQueries: Emit[] = [];
  /**
   * Answers an `ops:status` as it is emitted: the {@link FakeServer} serving
   * the engine, or else {@link voidAll}.
   */
  statusResponder: (e: Emit) => void = voidAll;
  private seq = 0;
  private killed = false;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, cb: (...args: unknown[]) => void): SocketLike {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(cb);
    return this;
  }
  off(event: string, cb?: (...args: unknown[]) => void): SocketLike {
    if (!cb) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]): SocketLike {
    // A process that is gone sends nothing (see `kill`).
    if (this.killed) return this;
    let ack = args[args.length - 1] as (response: unknown) => void;
    const seq = ++this.seq;
    if (event === 'yjs:fetch') {
      this.fetches.push({ fileId: (args[0] as { fileId: string }).fileId, answer: ack });
    } else if (event === 'ops:status') {
      const query: Emit = { event, payload: args[0], ack, seq };
      this.statusQueries.push(query);
      this.statusResponder(query);
    } else if (event === 'project:join') {
      const join: Emit = { event, payload: args[0], ack, seq };
      const answer = withIdempotency(ack);
      join.ack = (response): void => {
        join.answered = true;
        answer(response);
      };
      this.emits.push(join);
    } else {
      this.emits.push({ event, payload: args[0], ack, seq });
    }
    return this;
  }
  /**
   * The process is gone: nothing more goes out on this socket and nothing
   * comes back — no `disconnect` either.
   */
  kill(): void {
    this.killed = true;
    this.connected = false;
    this.reachable = false;
    this.wantsConnect = false;
    this.listeners.clear();
  }
  connect(): SocketLike {
    if (!this.reachable) {
      // What socket.io reports without network; it keeps retrying.
      this.wantsConnect = true;
      this.fire('connect_error', new Error('websocket error'));
      return this;
    }
    this.connected = true;
    this.fire('connect');
    return this;
  }
  /** The network is back: a connect asked for meanwhile goes through. */
  goOnline(): void {
    this.reachable = true;
    if (!this.wantsConnect) return;
    this.wantsConnect = false;
    this.connect();
  }
  /**
   * Closed on purpose: socket.io does not reconnect such a socket, so a
   * connect asked for while unreachable is dropped. A test that models the
   * connection coming back calls {@link connect} itself.
   */
  disconnect(): SocketLike {
    this.wantsConnect = false;
    this.connected = false;
    this.fire('disconnect', 'io client disconnect');
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  /** The latest emit of `event` (optionally for one file path). */
  pending(event: string, filePath?: string): Emit {
    const match = [...this.emits]
      .reverse()
      .find(
        (e) =>
          e.event === event &&
          (filePath === undefined || (e.payload as { filePath?: string }).filePath === filePath),
      );
    if (!match) throw new Error(`no ${event} emit${filePath ? ` for ${filePath}` : ''}`);
    return match;
  }
  /** Paths of every `file:create` sent so far. */
  created(): string[] {
    return this.emits
      .filter((e) => e.event === 'file:create')
      .map((e) => (e.payload as { filePath: string }).filePath);
  }
}

/**
 * The server this client needs says so in its join ack (`opIdempotency: 1`,
 * see `sync-protocol.md` §4.5): an answer a test gives without it gets it. A
 * test of an older server gives the key itself, `undefined`.
 */
function withIdempotency(ack: (response: unknown) => void): (response: unknown) => void {
  return (response) => {
    const r = response as Record<string, unknown> | null;
    if (r !== null && typeof r === 'object' && r.ok === true && !('opIdempotency' in r)) {
      ack({ ...r, opIdempotency: 1 });
      return;
    }
    ack(response);
  };
}

// -- Harness --------------------------------------------------------------------

export const server: ServerConfig = {
  id: 's1',
  name: 'Local',
  url: 'https://sync.example.com',
  apiKey: 'osk_test',
  addedAt: 0,
};

const binding: VaultBinding = {
  id: 'b1',
  serverId: 's1',
  projectId: 'p1',
  projectName: 'Test',
  localFolder: '/',
  enabled: true,
  lastSyncedAt: 0,
  lastVectorClock: {},
};

type Responder = () => RequestUrlResponse | Promise<RequestUrlResponse>;

export interface Request {
  method: string;
  path: string;
}

/**
 * The one `ObsidianWatcher` on a vault, as the plugin has one for all its
 * engines: shared by an engine and the ones built after it, it hands every
 * event to the newest.
 */
export interface EchoRoute {
  engine: SyncEngine | null;
  binding: VaultBinding;
  /** Handlers still running for events the watcher dispatched. */
  inflight: Set<Promise<void>>;
  /** What those handlers threw: in the plugin, an unhandled rejection. */
  errors: unknown[];
  /** The {@link FakeServer} answering this vault's engines, if any. */
  server: { serveNext(): boolean; answerStatus(e: Emit): void } | null;
}

export interface Harness {
  engine: SyncEngine;
  /** See {@link EchoRoute}. */
  route: EchoRoute;
  /** Errors thrown by handlers of events the watcher dispatched. */
  eventErrors: unknown[];
  /** Wait until every event the watcher dispatched has been handled. */
  settle: () => Promise<void>;
  vault: MemoryVault;
  log: OperationLog;
  doc: DocManager;
  echo: RecentlyApplied;
  socket: () => FakeSocket;
  /** The engine's socket, or `null` before `start()` built one. */
  socketIfBuilt: () => FakeSocket | null;
  /** Every call the engine made into one of its dependencies. */
  calls: string[];
  /** Every REST request that reached the transport. */
  requests: Request[];
  /** REST routes, keyed `METHOD /path`; blob uploads fall back to `PUT /blobs`. */
  routes: Map<string, Responder>;
  /** What the server lists — read at request time. */
  serverFiles: ApiFile[];
  /**
   * Tombstones: listed, with `deletedAt` set, only when asked for
   * (`?includeDeleted=true`), next to {@link serverFiles}.
   */
  deletedFiles: ApiFile[];
  statuses: EngineStatus[];
  modal: {
    binary: Deferred<BinaryConflictResolution>;
    del: Deferred<DeleteConflictResolution>;
  };
}

export interface HarnessOptions {
  /** The engine this one replaces: same vault, log, docs and echo set. */
  predecessor?: Harness;
  /**
   * The operation log, instead of a memory-only one (or the predecessor's):
   * one loaded from a {@link FakeStorage} (see {@link restartFromDisk}).
   */
  log?: OperationLog;
  /** Bind to a subfolder instead of the vault root. */
  localFolder?: string;
  logger?: Logger;
  /**
   * The docs the engine uses, instead of an in-memory `DocManager` (or the
   * predecessor's): `FakeIndexedDb.manager()` for docs that persist.
   */
  docs?: DocManager;
  /** Debounce of the disk snapshot after a remote edit; 0 (the next tick) by default. */
  diskSnapshotDebounceMs?: number;
  /** Start without network: the socket connects only after {@link goOnline}. */
  offline?: boolean;
  /**
   * Who answers `ops:status` instead of the {@link FakeServer} (or, without
   * one, {@link voidAll}): a server that is busy, say.
   */
  statusResponder?: (e: Emit) => void;
  /** The engine's pauses before it asks `ops:status` again (`SyncEngineDeps.opsStatusRetryMs`). */
  opsStatusRetryMs?: readonly number[];
}

export function json(body: unknown, status = 200): RequestUrlResponse {
  return { status, json: body, arrayBuffer: new ArrayBuffer(0), headers: {}, text: '' };
}

export function bytes(buf: ArrayBuffer): RequestUrlResponse {
  return { status: 200, json: null, arrayBuffer: buf, headers: {}, text: '' };
}

function listing(files: ApiFile[]): RequestUrlResponse {
  return json({ files: files.map((f) => ({ ...f, size: String(f.size) })) });
}

export function serverFile(
  id: string,
  path: string,
  fileType: 'TEXT' | 'BINARY',
  contentHash: string,
  size: number,
): ApiFile {
  return {
    id,
    path,
    fileType,
    contentHash,
    size,
    mimeType: null,
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastModifiedById: 'u1',
  };
}

export function buildHarness(opts: HarnessOptions = {}): Harness {
  const { predecessor } = opts;
  const calls: string[] = [];
  const requests: Request[] = [];
  const routes = new Map<string, Responder>();
  const vault = predecessor?.vault ?? new MemoryVault();
  const log = opts.log ?? predecessor?.log ?? new OperationLog();
  const doc = opts.docs ?? predecessor?.doc ?? new DocManager();
  const ra = predecessor?.echo ?? new RecentlyApplied();

  // Filled in below; the routes and the modal read it when they are called.
  const state = {
    serverFiles: [] as ApiFile[],
    deletedFiles: [] as ApiFile[],
    statuses: [] as EngineStatus[],
    modal: {
      binary: deferred<BinaryConflictResolution>(),
      del: deferred<DeleteConflictResolution>(),
    },
  };
  const h = state as Partial<Harness> & typeof state;

  routes.set('GET /api/projects/p1/files', () => listing(h.serverFiles));
  routes.set('GET /api/projects/p1/files?includeDeleted=true', () =>
    listing([...h.serverFiles, ...h.deletedFiles]),
  );
  routes.set('PUT /blobs', () => json({ ok: true }));

  const route = async (method: string, url: string): Promise<RequestUrlResponse> => {
    const path = url.replace(server.url, '');
    requests.push({ method, path });
    const responder =
      routes.get(`${method} ${path}`) ??
      (method === 'PUT' && path.includes('/blobs/') ? routes.get('PUT /blobs') : undefined);
    if (!responder) throw new Error(`unexpected request: ${method} ${path}`);
    return responder();
  };
  const api = new ApiClient(
    server,
    (p) => route(p.method ?? 'GET', p.url),
    // As `fetch` does: a transfer called off before it starts is never sent,
    // and one called off on its way rejects with the signal's reason.
    (p) =>
      p.signal?.aborted
        ? Promise.reject(abortReason(p.signal))
        : abortable(route(p.method, p.url), p.signal),
  );
  // Each engine gets its own socket, so a predecessor's late emits stay
  // apart from its successor's.
  let own: FakeSocket | null = null;
  // Built below; the socket asks it who answers `ops:status`.
  let routeRef: EchoRoute | null = null;
  const factory: SocketFactory = () => {
    const built = new FakeSocket();
    if (opts.offline) built.reachable = false;
    built.statusResponder = (e): void => {
      const serving = routeRef?.server;
      if (opts.statusResponder) opts.statusResponder(e);
      else if (serving) serving.answerStatus(e);
      else voidAll(e);
    };
    own = built;
    return built;
  };
  const socket = new SocketClient({ server, clientId: 'device-1', factory });
  const resolver: ConflictResolver = {
    resolveBinaryConflict: () => h.modal.binary.promise,
    resolveDeleteConflict: () => h.modal.del.promise,
  };

  const engineBinding =
    opts.localFolder === undefined ? binding : { ...binding, localFolder: opts.localFolder };
  const engine = new SyncEngine({
    binding: engineBinding,
    server,
    clientId: 'device-1',
    vault: track(vault, 'vault', calls),
    operationLog: track(log, 'log', calls),
    docManager: track(doc, 'doc', calls),
    recentlyApplied: track(ra, 'echo', calls),
    apiClient: track(api, 'api', calls),
    socketClient: track(socket, 'socket', calls),
    conflictResolver: track(resolver, 'modal', calls),
    diskSnapshotDebounceMs: opts.diskSnapshotDebounceMs ?? 0,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.opsStatusRetryMs ? { opsStatusRetryMs: opts.opsStatusRetryMs } : {}),
  });
  engine.onStatus((status) => h.statuses.push(status));

  const echoRoute = predecessor?.route ?? watchVault(vault, ra, engineBinding);
  echoRoute.engine = engine;
  routeRef = echoRoute;

  return Object.assign(h, {
    engine,
    route: echoRoute,
    eventErrors: echoRoute.errors,
    settle: () => settleEvents(echoRoute),
    vault,
    log,
    doc,
    echo: ra,
    calls,
    requests,
    routes,
    socket: (): FakeSocket => {
      if (!own) throw new Error('socket not built — start the engine first');
      return own;
    },
    socketIfBuilt: (): FakeSocket | null => own,
  });
}

/** The reason `signal` aborted with, as an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** `work`, rejected with `signal`'s reason as soon as `signal` aborts. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
  return Promise.race([work, aborted]);
}

/** Start the vault's `ObsidianWatcher`, wired to the engine as `main.ts` does. */
function watchVault(vault: MemoryVault, ra: RecentlyApplied, binding: VaultBinding): EchoRoute {
  const route: EchoRoute = {
    engine: null,
    binding,
    inflight: new Set(),
    errors: [],
    server: null,
  };
  const watcher = new ObsidianWatcher({
    bindings: () => [route.binding],
    recentlyApplied: ra,
    modifyDebounceMs: 0,
  });
  watcher.onEvent((event: VaultEvent) => {
    const engine = route.engine;
    if (!engine) return;
    const run = engine.handleVaultEvent(event).catch((err: unknown) => {
      route.errors.push(err);
    });
    route.inflight.add(run);
    void run.finally(() => route.inflight.delete(run));
  });
  watcher.start(vault.watchable);
  return route;
}

/**
 * Wait for the handlers of dispatched events, answering file operations on
 * the way when a {@link FakeServer} serves the engine: a handler may be
 * waiting for its ack.
 */
async function settleEvents(route: EchoRoute): Promise<void> {
  for (let idle = 0; idle < 200; ) {
    await flushAsync();
    if (route.server?.serveNext()) {
      idle = 0;
      continue;
    }
    if (route.inflight.size === 0) return;
    await Promise.race([Promise.allSettled([...route.inflight]), flushAsync(5)]);
    idle += 1;
  }
  throw new Error(`${route.inflight.size} vault event(s) still being handled`);
}

/**
 * The user renames a file in Obsidian: the file moves and the vault `rename`
 * event goes through the watcher to the engine. Resolves once handled.
 */
export async function userRename(h: Harness, from: string, to: string): Promise<void> {
  await h.vault.rename(from, to);
  await h.settle();
}

/**
 * The network is back for an engine started with `offline: true`: its socket
 * connects, and the join is answered with `join`.
 */
export async function goOnline(
  h: Harness,
  join: { operations?: ServerOperation[]; yjsDocs?: YjsDocSnapshot[] } = {},
): Promise<void> {
  const before = joinsOf(h);
  h.socket().goOnline();
  await flushAsync();
  (await nextJoin(h, before)).ack({
    ok: true,
    operations: join.operations ?? [],
    yjsDocs: join.yjsDocs ?? [],
  });
  await flushAsync();
}

/** How many `project:join` the engine's socket has sent; 0 before it has one. */
export function joinsOf(h: Harness): number {
  return h.socketIfBuilt()?.emits.filter((e) => e.event === 'project:join').length ?? 0;
}

/**
 * The engine's `project:join` the test has not answered yet, once it is sent:
 * with operations waiting for their answer, the engine asks `ops:status` first.
 */
export async function joinToAnswer(h: Harness): Promise<Emit> {
  for (let i = 0; i < 50; i++) {
    const joins = h.socketIfBuilt()?.emits.filter((e) => e.event === 'project:join') ?? [];
    const last = joins[joins.length - 1];
    if (last !== undefined && last.answered !== true) return last;
    await flushAsync(2);
  }
  throw new Error('no project:join to answer');
}

/**
 * The `project:join` after the first `before` ones, once the engine sends it:
 * with operations waiting for their answer, it asks `ops:status` first.
 */
export async function nextJoin(h: Harness, before: number): Promise<Emit> {
  for (let i = 0; i < 50; i++) {
    const joins = h.socketIfBuilt()?.emits.filter((e) => e.event === 'project:join') ?? [];
    const join = joins[before];
    if (join !== undefined) return join;
    await flushAsync(2);
  }
  throw new Error('no project:join sent');
}

export async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** The vector clock the engine's latest `project:join` carried. */
export function joinClockOf(h: Harness): Record<string, number> {
  const payload = h.socket().pending('project:join').payload as {
    sinceVectorClock?: Record<string, number> | null;
  };
  return payload.sinceVectorClock ?? {};
}

/** Start and answer `project:join`. */
export async function connect(
  h: Harness,
  join: { operations?: ServerOperation[]; yjsDocs?: YjsDocSnapshot[] } = {},
): Promise<void> {
  const before = joinsOf(h);
  await h.engine.start();
  (await nextJoin(h, before)).ack({
    ok: true,
    operations: join.operations ?? [],
    yjsDocs: join.yjsDocs ?? [],
  });
  await flushAsync();
}

export interface Mark {
  calls: number;
  requests: number;
  emits: number;
  statuses: number;
}

/** Where the records stand now; anything recorded after it is a late effect. */
export function markOf(h: Harness): Mark {
  return {
    calls: h.calls.length,
    requests: h.requests.length,
    emits: h.socketIfBuilt()?.emits.length ?? 0,
    statuses: h.statuses.length,
  };
}

export function expectQuietSince(h: Harness, mark: Mark): void {
  expect(h.calls.slice(mark.calls)).toEqual([]);
  expect(h.requests.slice(mark.requests)).toEqual([]);
  expect((h.socketIfBuilt()?.emits ?? []).slice(mark.emits).map((e) => e.event)).toEqual([]);
  expect(h.statuses.slice(mark.statuses)).toEqual([]);
  expect(h.engine.getStatus()).toBe('stopped');
}

/** The catch-up snapshot of a server doc, for file `fileId`. */
export function snapshotOf(serverDoc: Y.Doc, fileId: string): YjsDocSnapshot {
  return {
    fileId,
    sync1: Array.from(Y.encodeStateAsUpdate(serverDoc)),
    stateVector: Array.from(Y.encodeStateVector(serverDoc)),
  };
}

/** A server doc holding `text`. */
export function serverDocWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return doc;
}

/** Push a teammate's edit (`line` inserted at the top) as a live `yjs:update`. */
export function remoteEdit(h: Harness, serverDoc: Y.Doc, fileId: string, line: string): void {
  const seen = Y.encodeStateVector(serverDoc);
  serverDoc.getText('content').insert(0, line);
  h.socket().fire('yjs:update', {
    fileId,
    update: Array.from(Y.encodeStateAsUpdate(serverDoc, seen)),
  });
}

/** The `log` field every server file event carries. */
export const eventLog = { id: 'l1', vectorClock: { 'device-2': 2 }, createdAt: '2026-01-01' };

/** A teammate's operation id: `clock` in its last group. */
export function teammateOpId(clock: number): string {
  return `00000000-0000-4000-8000-${String(clock).padStart(12, '0')}`;
}

/** One entry of the join's operation list, authored by a teammate. */
export function op(
  opType: ServerOperation['opType'],
  filePath: string,
  newPath: string | null,
  payload: Record<string, unknown>,
  clock: number,
): ServerOperation {
  return {
    id: `op-${clock}`,
    opType,
    filePath,
    newPath,
    authorId: 'u2',
    clientId: 'device-2',
    opId: teammateOpId(clock),
    vectorClock: { 'device-2': clock },
    payload,
    createdAt: '2026-01-01',
  };
}

// -- Fake server ----------------------------------------------------------------

/** A file as the {@link FakeServer} holds it. */
export interface ServerFileRecord {
  id: string;
  path: string;
  fileType: 'TEXT' | 'BINARY';
  contentHash: string;
  size: number;
  deleted: boolean;
}

/** How the {@link FakeServer} answers `project:join`: see {@link FakeServer.joinAnswer}. */
export type CatchupForm = 'whole journal' | 'cut short';

/** The `fileId` of a journal row's payload, `''` when it has none. */
function fileIdOf(op: ServerOperation): string {
  const id = (op.payload as { fileId?: unknown } | null)?.fileId;
  return typeof id === 'string' ? id : '';
}

/** The operations a client sends that the {@link FakeServer} answers. */
const SERVED = new Set([
  'file:rename',
  'file:move',
  'file:create',
  'file:delete',
  'file:update-binary',
]);

/** The operation type a file event stands for; RENAME and MOVE are one for a resend. */
const OP_TYPE_OF: Record<string, ServerOperation['opType']> = {
  'file:create': 'CREATE',
  'file:update-binary': 'UPDATE',
  'file:delete': 'DELETE',
  'file:rename': 'RENAME',
  'file:move': 'MOVE',
};

/** Whether two operation types are the same for an `opId` (RENAME ≡ MOVE). */
function sameOpKind(a: ServerOperation['opType'], b: ServerOperation['opType']): boolean {
  const kind = (t: ServerOperation['opType']): string => (t === 'MOVE' ? 'RENAME' : t);
  return kind(a) === kind(b);
}

/** A log entry as acks and broadcasts carry it. */
interface LogEntry {
  id: string;
  vectorClock: Record<string, number>;
  createdAt: string;
}

/** What the {@link FakeServer} keeps of an operation it applied, by `opId`. */
interface AppliedOp {
  clientId: string;
  opType: ServerOperation['opType'];
  outcome: unknown;
  log: LogEntry;
  row: ServerOperation;
}

/** The user a client of the {@link FakeServer} works as: `device-1` is this device's. */
function authorOf(clientId: string): string {
  return clientId === 'device-1' ? 'u1' : 'u2';
}

/**
 * The server's side of file operations, enough to see what a client makes of
 * its own and its teammates' changes. Like `Project/server` (`handleMove`,
 * `applyMove`): a RENAME or MOVE is applied by file id without a precondition
 * on the source path, a collision stores the file under the first free
 * `<name>.conflict-<clientId>[-n]`, and the operation is broadcast to the
 * whole room — the sender included, with its `clientId`, its `opId` and the
 * path the file was stored at — right before the ack. CREATE, DELETE and a binary
 * UPDATE are applied the same way, without file contents. A CREATE on a name
 * taken by a live file with the same non-empty content is that file (`merged`);
 * one on a tombstone brings its id back.
 *
 * Operations are keyed by `opId` (`sync-protocol.md` §4): one without a valid
 * one is refused (`invalid_op_id`), one applied already is answered with its
 * original outcome and log row, `duplicate: true`, without being applied or
 * broadcast again (`op_id_conflict` when another client or another kind of
 * operation uses the id), and one `ops:status` voided is refused
 * (`op_voided`). The ack carries the operation's log row.
 *
 * Nothing is answered until {@link FakeServer.pump}: the test decides when
 * the server gets to work. `ops:status` is answered as it is asked — once the
 * operations the client sent before it are applied, as the server's project
 * queue does — unless {@link holdStatus} leaves it for {@link serveNext}. The
 * listing (`h.serverFiles`, tombstones in `h.deletedFiles`) follows every
 * change, and every operation goes to the {@link FakeServer.journal} the
 * catch-up is taken from ({@link FakeServer.catchupFor}).
 */
export class FakeServer {
  readonly files = new Map<string, ServerFileRecord>();
  /**
   * What the server applied, in order: `f1 a.md -> b.md`, `create x.md`,
   * `delete f1`, `update f1`.
   */
  readonly applied: string[] = [];
  /**
   * The operation log: every operation applied, in order, each with the
   * vector clock and log id its broadcast carried.
   */
  readonly journal: ServerOperation[] = [];
  /** The `opId` of every operation applied, in order: never one twice. */
  readonly appliedOpIds: string[] = [];
  /** Operations answered as a resend of one applied already (`duplicate`), by `opId`. */
  readonly duplicates: string[] = [];
  /** Every `ops:status` answered: the ids asked about, applied and voided. */
  readonly statusAnswers: Array<{ asked: string[]; applied: string[]; voided: string[] }> = [];
  /**
   * Leave `ops:status` for {@link serveNext}, in its order among the client's
   * emits — an operation received before it still being applied.
   */
  holdStatus = false;
  private readonly byOpId = new Map<string, AppliedOp>();
  private readonly voided = new Set<string>();
  private readonly served = new WeakSet<Emit>();
  /** Emits that reach the server only when the test says (see {@link delay}). */
  private readonly delayed = new WeakSet<Emit>();
  private seq = 0;

  constructor(private harness: Harness) {
    harness.route.server = this;
  }

  /** Serve the engine built after this one instead (see `buildHarness`). */
  attach(h: Harness): void {
    this.harness = h;
    h.route.server = this;
    this.publish();
  }

  /** A file the server has — also in the listing the engine reads. */
  add(file: Omit<ServerFileRecord, 'deleted'>): void {
    this.files.set(file.id, { ...file, deleted: false });
    this.publish();
  }

  /** Where the server has file `id`, or `null` when it is deleted or unknown. */
  pathOf(id: string): string | null {
    const file = this.files.get(id);
    return file && !file.deleted ? file.path : null;
  }

  /**
   * The operations of the catch-up `project:join` answers a client whose
   * vector clock is `clock` (by default what the harness's engine last
   * persisted): every one with a counter the clock has not reached.
   */
  catchupFor(
    clock: Record<string, number> = this.harness.log.getBindingState('b1')?.lastVectorClock ?? {},
  ): ServerOperation[] {
    return this.journal.filter((row) =>
      Object.entries(row.vectorClock).some(([client, n]) => n > (clock[client] ?? 0)),
    );
  }

  /**
   * The answer to `project:join` in one of the server's catch-up forms (see
   * `sync-protocol.md`, «Подключение»), for the vector clock the harness's
   * engine last persisted, with `opIdempotency: 1` and the echo
   * `operationsCatchup: 2`:
   *
   *   - `whole journal`: every operation the clock has not seen;
   *   - `cut short`: the newest `rows` unseen ones, and `operationsTruncated`
   *     when that left some out.
   *
   * The UPDATE rows of notes (a write through REST or MCP) are left out, as
   * the server leaves them out.
   *
   * `clock`: the clock to answer for, instead of the one persisted — the one
   * the join carried (see {@link joinClockOf}), as the server answers. They
   * differ after an operation whose ack was lost: the engine bumped its clock
   * for it and never persisted it.
   */
  joinAnswer(
    form: CatchupForm,
    opts: { rows?: number; yjsDocs?: YjsDocSnapshot[]; clock?: Record<string, number> } = {},
  ): Record<string, unknown> {
    const docs = { yjsDocs: opts.yjsDocs ?? [] };
    const unseen = this.catchupFor(opts.clock).filter(
      (op) => op.opType !== 'UPDATE' || this.files.get(fileIdOf(op))?.fileType !== 'TEXT',
    );
    const kept =
      form === 'cut short' ? unseen.slice(Math.max(0, unseen.length - (opts.rows ?? 1))) : unseen;
    return {
      ok: true,
      opIdempotency: 1,
      operations: kept,
      operationsCatchup: 2,
      ...(kept.length < unseen.length ? { operationsTruncated: true } : {}),
      ...docs,
    };
  }

  /**
   * Answer the client's file operations, one at a time, until it sends no
   * more. Throws when it is still sending after `maxOps` — a loop.
   */
  async pump(maxOps = 30): Promise<void> {
    let ops = 0;
    for (let idle = 0; idle < 3; ) {
      await flushAsync(15);
      if (!this.serveNext()) {
        idle += 1;
        continue;
      }
      idle = 0;
      if (++ops > maxOps) {
        throw new Error(`the client kept sending operations: ${this.applied.join(', ')}`);
      }
    }
  }

  /** Answer the client's oldest operation not answered yet; `false` when there is none. */
  serveNext(): boolean {
    const socket = this.harness.socketIfBuilt();
    if (!socket) return false;
    const candidates = [
      ...socket.emits.filter((e) => SERVED.has(e.event)),
      ...socket.statusQueries,
    ].filter((e) => !this.served.has(e) && !this.delayed.has(e));
    candidates.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const next = candidates[0];
    if (!next) return false;
    this.served.add(next);
    if (next.event === 'ops:status') this.answerStatusNow(next);
    else this.answer(next);
    return true;
  }

  /**
   * `emit` reaches the server only through {@link deliverLate}: a packet of a
   * connection that is gone, which the server gets after the client asked
   * `ops:status` on the next one.
   */
  delay(emit: Emit): void {
    this.delayed.add(emit);
  }

  /** The late packet of {@link delay} arrives now, and is answered. */
  deliverLate(emit: Emit): void {
    this.delayed.delete(emit);
    if (this.served.has(emit)) return;
    this.served.add(emit);
    this.answer(emit);
  }

  /**
   * An `ops:status` asked (see `FakeSocket.statusResponder`): answered now,
   * once every operation the client sent before it is applied — the server
   * queues it behind them — or left for {@link serveNext} while
   * {@link holdStatus} is set.
   */
  answerStatus(e: Emit): void {
    if (this.holdStatus) return;
    const socket = this.harness.socketIfBuilt();
    const before = (socket?.emits ?? []).filter(
      (other) =>
        SERVED.has(other.event) &&
        !this.served.has(other) &&
        !this.delayed.has(other) &&
        (other.seq ?? 0) < (e.seq ?? 0),
    );
    for (const other of before) {
      this.served.add(other);
      this.answer(other);
    }
    this.served.add(e);
    this.answerStatusNow(e);
  }

  /** `ops:status`, answered (see `sync-protocol.md` §4.4). */
  private answerStatusNow(e: Emit): void {
    const { opIds } = e.payload as { opIds?: unknown };
    if (
      !Array.isArray(opIds) ||
      opIds.length === 0 ||
      opIds.length > 500 ||
      !opIds.every((id) => isOpId(id))
    ) {
      e.ack({ ok: false, error: 'invalid_payload' });
      return;
    }
    const asked = opIds;
    const found = asked
      .map((opId) => ({ opId, applied: this.byOpId.get(opId) }))
      .filter(
        (hit): hit is { opId: string; applied: AppliedOp } =>
          hit.applied !== undefined && authorOf(hit.applied.clientId) === 'u1',
      )
      .sort((a, b) => this.journal.indexOf(a.applied.row) - this.journal.indexOf(b.applied.row));
    // Another user's operation under the id: neither reported nor voided.
    const voided = asked.filter((opId) => !this.byOpId.has(opId));
    for (const opId of voided) this.voided.add(opId);
    this.statusAnswers.push({ asked, applied: found.map((hit) => hit.opId), voided });
    e.ack({
      ok: true,
      applied: found.map(({ opId, applied }) => ({
        opId,
        opType: applied.row.opType,
        logId: applied.log.id,
        filePath: applied.row.filePath,
        newPath: applied.row.newPath,
        outcome: applied.outcome,
        vectorClock: applied.log.vectorClock,
        createdAt: applied.log.createdAt,
      })),
      voided,
    });
  }

  /** A teammate (`device-2`) renames file `id`; the broadcast reaches the engine. */
  teammateRename(id: string, newPath: string): void {
    const result = this.move(id, newPath, 'device-2', 'RENAME', newOpId());
    if ('error' in result) throw new Error(result.error);
  }

  private answer(e: Emit): void {
    const p = e.payload as {
      clientId: string;
      opId?: unknown;
      vectorClock?: Record<string, number>;
      fileId?: string;
      filePath: string;
      newPath?: string;
      fileType?: 'TEXT' | 'BINARY';
      contentHash?: string;
      size?: number;
    };
    const opType = OP_TYPE_OF[e.event];
    if (opType === undefined) return;
    if (!isOpId(p.opId)) {
      e.ack({ ok: false, error: 'invalid_op_id' });
      return;
    }
    const opId = p.opId;
    if (this.voided.has(opId)) {
      e.ack({ ok: false, error: 'op_voided' });
      return;
    }
    const earlier = this.byOpId.get(opId);
    if (earlier !== undefined) {
      if (earlier.clientId !== p.clientId || !sameOpKind(earlier.opType, opType)) {
        e.ack({ ok: false, error: 'op_id_conflict' });
        return;
      }
      // Applied already: the answer it got, and nothing else.
      this.duplicates.push(opId);
      e.ack({ ok: true, outcome: earlier.outcome, log: earlier.log, duplicate: true });
      return;
    }
    switch (e.event) {
      case 'file:rename':
      case 'file:move': {
        const result = this.move(
          p.fileId ?? '',
          p.newPath ?? '',
          p.clientId,
          e.event === 'file:rename' ? 'RENAME' : 'MOVE',
          opId,
          p.vectorClock,
        );
        e.ack(
          'error' in result
            ? { ok: false, error: result.error }
            : { ok: true, outcome: result.outcome, log: result.log },
        );
        return;
      }
      case 'file:create': {
        const created = this.create(p.filePath, { ...p, opId });
        e.ack({ ok: true, outcome: created.outcome, log: created.log });
        return;
      }
      case 'file:update-binary': {
        const file = this.files.get(p.fileId ?? '');
        if (!file) {
          e.ack({ ok: false, error: 'file_not_found' });
          return;
        }
        if (file.deleted) {
          // DELETE wins over UPDATE: logged, nothing changes.
          const log = this.log(p.clientId, p.vectorClock);
          const outcome = { kind: 'no_op', reason: 'tombstone', fileId: file.id };
          this.record(
            log,
            'UPDATE',
            file.path,
            null,
            { fileId: file.id, fileType: file.fileType, suppressed: 'tombstone' },
            { clientId: p.clientId, opId, outcome },
          );
          e.ack({ ok: true, outcome, log });
          return;
        }
        file.contentHash = p.contentHash ?? '';
        file.size = p.size ?? 0;
        this.applied.push(`update ${file.id}`);
        this.publish();
        const log = this.log(p.clientId, p.vectorClock);
        const outcome = {
          kind: 'updated',
          fileId: file.id,
          contentHash: file.contentHash,
          size: file.size,
        };
        this.record(
          log,
          'UPDATE',
          file.path,
          null,
          {
            fileId: file.id,
            contentHash: file.contentHash,
            size: file.size,
            fileType: file.fileType,
          },
          { clientId: p.clientId, opId, outcome },
        );
        this.broadcast(
          'file:updated-binary',
          { fileId: file.id, contentHash: file.contentHash, log },
          p.clientId,
          opId,
        );
        e.ack({ ok: true, outcome, log });
        return;
      }
      case 'file:delete': {
        const file = this.files.get(p.fileId ?? '');
        if (!file) {
          e.ack({ ok: false, error: 'file_not_found' });
          return;
        }
        // A tombstone stays one: logged and broadcast, nothing changes.
        if (!file.deleted) {
          file.deleted = true;
          this.applied.push(`delete ${file.id}`);
          this.publish();
        }
        const log = this.log(p.clientId, p.vectorClock);
        const outcome = { kind: 'deleted', fileId: file.id };
        this.record(
          log,
          'DELETE',
          file.path,
          null,
          { fileId: file.id },
          {
            clientId: p.clientId,
            opId,
            outcome,
          },
        );
        this.broadcast('file:deleted', { fileId: file.id, log }, p.clientId, opId);
        e.ack({ ok: true, outcome, log });
        return;
      }
    }
  }

  private move(
    id: string,
    requested: string,
    clientId: string,
    opType: 'RENAME' | 'MOVE',
    opId: string,
    sentClock?: Record<string, number>,
  ): { outcome: unknown; log: LogEntry } | { error: string } {
    const file = this.files.get(id);
    if (!file || file.deleted) return { error: 'file_not_found' };
    let outcome: unknown;
    let stored = requested;
    const from = file.path;
    if (file.path === requested) {
      outcome = { kind: 'no_op', reason: 'same_path', fileId: id };
    } else {
      const taken = [...this.files.values()].some(
        (f) => f !== file && !f.deleted && f.path === requested,
      );
      if (taken) {
        // A row there is taken over when it is a tombstone or this very file.
        stored = this.conflictPath(requested, clientId, (f) => f.deleted || f.id === id);
        this.dropTombstoneAt(stored);
        outcome = {
          kind: 'conflict_create_renamed',
          fileId: id,
          originalPath: requested,
          finalPath: stored,
        };
      } else {
        outcome = { kind: 'renamed', fileId: id, from: file.path, to: requested };
      }
      this.applied.push(`${id} ${file.path} -> ${stored}`);
      file.path = stored;
      this.publish();
    }
    const log = this.log(clientId, sentClock);
    this.record(log, opType, from, stored, { fileId: id }, { clientId, opId, outcome });
    this.broadcast(
      opType === 'RENAME' ? 'file:renamed' : 'file:moved',
      {
        fileId: id,
        newPath: stored,
        requestedPath: requested,
        outcome,
        log,
      },
      clientId,
      opId,
    );
    return { outcome, log };
  }

  /**
   * Called for each file a CREATE adds or revives, right after `file:created`
   * is broadcast: `data` is what the client sent, `revived` whether the id is
   * a deleted file's brought back. See {@link ServerDocs}.
   */
  onCreate?: (id: string, data: unknown, revived: boolean) => void;

  /** A teammate (`device-2`) creates `path` with `text`; the broadcast reaches the engine. */
  async teammateCreate(path: string, text: string): Promise<string> {
    const bytes = encode(text);
    const { outcome } = this.create(path, {
      clientId: 'device-2',
      opId: newOpId(),
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: bytes.byteLength,
      data: bytes,
    });
    return (outcome as { fileId: string }).fileId;
  }

  /** A teammate (`device-2`) uploads an attachment to `path`; the broadcast reaches the engine. */
  async teammateUpload(path: string, content: ArrayBuffer): Promise<string> {
    const { outcome } = this.create(path, {
      clientId: 'device-2',
      opId: newOpId(),
      fileType: 'BINARY',
      contentHash: await sha256Hex(content),
      size: content.byteLength,
    });
    return (outcome as { fileId: string }).fileId;
  }

  /** A teammate (`device-2`) deletes file `id`; the broadcast reaches the engine. */
  teammateDelete(id: string): void {
    const file = this.files.get(id);
    if (!file || file.deleted) throw new Error(`no file ${id}`);
    file.deleted = true;
    this.applied.push(`delete ${id}`);
    this.publish();
    const log = this.log('device-2');
    const opId = newOpId();
    const outcome = { kind: 'deleted', fileId: id };
    this.record(
      log,
      'DELETE',
      file.path,
      null,
      { fileId: id },
      {
        clientId: 'device-2',
        opId,
        outcome,
      },
    );
    this.broadcast('file:deleted', { fileId: id, log }, 'device-2', opId);
  }

  /**
   * A teammate writes note `id` through REST or MCP (`write_note`) with
   * `text`: the file takes its hash, and the journal gets the UPDATE the
   * server logs, `fileType` in its payload. No file event goes out: the REST
   * bridge sends none for a note. The doc is {@link ServerDocs.restWrite}'s.
   */
  async restWrite(id: string, text: string): Promise<void> {
    const file = this.files.get(id);
    if (!file || file.deleted) throw new Error(`no file ${id}`);
    file.contentHash = await sha256Hex(text);
    file.size = encode(text).byteLength;
    this.applied.push(`write ${id}`);
    this.publish();
    this.record(
      this.log('rest:u2'),
      'UPDATE',
      file.path,
      null,
      {
        fileId: id,
        contentHash: file.contentHash,
        size: file.size,
        fileType: file.fileType,
      },
      {
        clientId: 'rest:u2',
        opId: newOpId(),
        outcome: { kind: 'updated', fileId: id, contentHash: file.contentHash, size: file.size },
      },
    );
  }

  /**
   * A teammate (`device-2`) uploads a new version of attachment `id`; the
   * broadcast reaches the engine. Returns the new content hash.
   */
  async teammateUpdate(id: string, content: ArrayBuffer): Promise<string> {
    const file = this.files.get(id);
    if (!file || file.deleted) throw new Error(`no file ${id}`);
    file.contentHash = await sha256Hex(content);
    file.size = content.byteLength;
    this.applied.push(`update ${id}`);
    this.publish();
    const log = this.log('device-2');
    const opId = newOpId();
    this.record(
      log,
      'UPDATE',
      file.path,
      null,
      { fileId: id, contentHash: file.contentHash, size: file.size, fileType: file.fileType },
      {
        clientId: 'device-2',
        opId,
        outcome: { kind: 'updated', fileId: id, contentHash: file.contentHash, size: file.size },
      },
    );
    this.broadcast(
      'file:updated-binary',
      { fileId: id, contentHash: file.contentHash, log },
      'device-2',
      opId,
    );
    return file.contentHash;
  }

  private create(
    path: string,
    p: {
      clientId: string;
      opId: string;
      vectorClock?: Record<string, number>;
      fileType?: 'TEXT' | 'BINARY';
      contentHash?: string;
      size?: number;
      data?: unknown;
    },
  ): { outcome: unknown; log: LogEntry } {
    const live = [...this.files.values()].find((f) => !f.deleted && f.path === path);
    let outcome: Record<string, unknown>;
    let added: { id: string; revived: boolean } | null = null;
    let fileId: string;
    let at = path;
    let revived = false;
    const content = {
      contentHash: p.contentHash ?? '',
      size: p.size ?? 0,
      fileType: p.fileType ?? 'TEXT',
    };
    if (live && live.contentHash === p.contentHash && (p.size ?? 0) > 0) {
      // A live file with the same non-empty content: that file (§5.4).
      fileId = live.id;
      outcome = {
        kind: 'created',
        fileId,
        path,
        ...content,
        fileType: live.fileType,
        merged: true,
      };
    } else {
      // A row on the conflict name is taken over when it is a tombstone.
      at = !live ? path : this.conflictPath(path, p.clientId, (f) => f.deleted);
      const row = [...this.files.values()].find((f) => f.path === at);
      revived = row?.deleted === true;
      fileId = row?.id ?? `s${++this.seq}`;
      this.files.set(fileId, {
        id: fileId,
        path: at,
        fileType: p.fileType ?? 'TEXT',
        contentHash: p.contentHash ?? '',
        size: p.size ?? 0,
        deleted: false,
      });
      this.applied.push(`create ${at}`);
      this.publish();
      if (row === undefined || revived) added = { id: fileId, revived };
      outcome = live
        ? { kind: 'conflict_create_renamed', fileId, originalPath: path, finalPath: at, ...content }
        : { kind: 'created', fileId, path: at, ...content };
    }
    const log = this.log(p.clientId, p.vectorClock);
    this.record(
      log,
      'CREATE',
      at,
      null,
      {
        fileId,
        fileType: content.fileType,
        contentHash: content.contentHash,
        size: content.size,
        originalPath: path,
        ...(revived ? { revived: true } : {}),
      },
      { clientId: p.clientId, opId: p.opId, outcome },
    );
    const stored = this.files.get(fileId);
    this.broadcast(
      'file:created',
      {
        result: { outcome, log },
        fileId,
        path: stored?.path ?? at,
        fileType: stored?.fileType ?? content.fileType,
        revived,
        log,
      },
      p.clientId,
      p.opId,
    );
    if (added !== null) this.onCreate?.(added.id, p.data, added.revived);
    return { outcome, log };
  }

  /**
   * The server's `pickConflictPath`: the first `<path>.conflict-<clientId>[-n]`
   * without a row, or with one that `usable` takes over.
   */
  private conflictPath(
    path: string,
    clientId: string,
    usable: (row: ServerFileRecord) => boolean,
  ): string {
    for (let attempt = 1; ; attempt++) {
      const candidate = conflictName(path, clientId, attempt);
      const row = [...this.files.values()].find((f) => f.path === candidate);
      if (row === undefined || usable(row)) return candidate;
    }
  }

  /** A tombstone at `path` gives way to a file renamed there (the server's `dropTombstoneAt`). */
  private dropTombstoneAt(path: string): void {
    for (const [id, f] of this.files) if (f.deleted && f.path === path) this.files.delete(id);
  }

  /**
   * Add an applied operation to the {@link journal}, with the client and the
   * `opId` it came with and the outcome the client was answered.
   */
  private record(
    log: LogEntry,
    opType: ServerOperation['opType'],
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
    origin: { clientId: string; opId: string; outcome: unknown },
  ): void {
    const row: ServerOperation = {
      id: log.id,
      opType,
      filePath,
      newPath,
      authorId: authorOf(origin.clientId),
      clientId: origin.clientId,
      opId: origin.opId,
      vectorClock: log.vectorClock,
      payload,
      createdAt: log.createdAt,
    };
    this.journal.push(row);
    this.appliedOpIds.push(origin.opId);
    this.byOpId.set(origin.opId, {
      clientId: origin.clientId,
      opType,
      outcome: origin.outcome,
      log,
      row,
    });
  }

  /** Send `event` to the room, saying who sent it and the operation's `opId`. */
  private broadcast(
    event: string,
    payload: Record<string, unknown>,
    clientId: string,
    opId: string,
  ): void {
    const socket = this.harness.socketIfBuilt();
    if (!socket?.connected) return;
    socket.fire(event, { ...payload, clientId, opId });
  }

  /**
   * The log entry of an operation: a teammate's gets a counter of its own; a
   * client's gets the clock it sent with its counter one up, as the server
   * stores it (`increment(raw.vectorClock, raw.clientId)`). So the catch-up
   * returns a client's latest operation, and not the ones before it, which
   * its next bump covers.
   */
  private log(clientId: string, sent?: Record<string, number>): LogEntry {
    this.seq += 1;
    const vectorClock =
      sent === undefined
        ? { [clientId]: this.seq }
        : { ...sent, [clientId]: (sent[clientId] ?? 0) + 1 };
    return { id: `l${this.seq}`, vectorClock, createdAt: '2026-01-01' };
  }

  private publish(): void {
    this.harness.serverFiles = [...this.files.values()]
      .filter((f) => !f.deleted)
      .map((f) => serverFile(f.id, f.path, f.fileType, f.contentHash, f.size));
    this.harness.deletedFiles = [...this.files.values()]
      .filter((f) => f.deleted)
      .map((f) => ({
        ...serverFile(f.id, f.path, f.fileType, f.contentHash, f.size),
        deletedAt: '2026-01-02',
      }));
  }
}

/**
 * The notes' Yjs docs on a {@link FakeServer}, kept the way `Project/server`
 * keeps them. A text CREATE seeds a doc from the bytes sent. On a tombstone,
 * the new text goes on top of the stored history, as the server does — or,
 * with `replaceOnRevive`, a new history replaces it, as every server before
 * 0.3.8's did (and as a project seeded anew has new histories). Either way the
 * doc's full state follows `file:created` to the whole room as a `yjs:update`. What the client sends is applied by
 * {@link absorb}; `yjs:fetch` is answered by {@link answerFetches}.
 */
export class ServerDocs {
  readonly docs = new Map<string, Y.Doc>();
  private absorbed = new WeakSet<object>();

  constructor(
    readonly server: FakeServer,
    private harness: Harness,
    private readonly opts: { replaceOnRevive?: boolean } = {},
  ) {
    server.onCreate = (id, data, revived) => this.created(id, data, revived);
  }

  /** Serve the engine built after this one instead (with {@link FakeServer.attach}). */
  attach(h: Harness): void {
    this.harness = h;
    this.absorbed = new WeakSet();
  }

  /** A note the server has: its file, and its doc — by default one holding `text`. */
  async add(
    id: string,
    path: string,
    text: string,
    doc: Y.Doc = serverDocWith(text),
  ): Promise<void> {
    this.docs.set(id, doc);
    this.server.add({
      id,
      path,
      fileType: 'TEXT',
      contentHash: await sha256Hex(text),
      size: encode(text).byteLength,
    });
  }

  /**
   * A teammate writes note `id` through REST or MCP (`write_note`): the doc
   * takes `text` the way the server writes it — as the smallest edit that
   * makes it (see {@link serverTextEdit}). The change goes to the room as a
   * `yjs:update`; the file and the journal follow (see
   * {@link FakeServer.restWrite}).
   */
  async restWrite(id: string, text: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc || this.server.pathOf(id) === null) throw new Error(`no note ${id}`);
    const seen = Y.encodeStateVector(doc);
    const ytext = doc.getText('content');
    if (ytext.toJSON() !== text) {
      doc.transact(() => serverTextEdit(ytext, text));
    }
    const socket = this.harness.socketIfBuilt();
    if (socket?.connected) {
      socket.fire('yjs:update', {
        fileId: id,
        update: Array.from(Y.encodeStateAsUpdate(doc, seen)),
      });
    }
    await this.server.restWrite(id, text);
  }

  /** The text of note `id` on the server; `null` when it is deleted or has no doc. */
  text(id: string): string | null {
    if (this.server.pathOf(id) === null) return null;
    return this.docs.get(id)?.getText('content').toJSON() ?? null;
  }

  /** Every live note as `path=text`, sorted. */
  live(): string[] {
    return [...this.server.files.values()]
      .filter((f) => !f.deleted)
      .map((f) => `${f.path}=${this.text(f.id) ?? '?'}`)
      .sort();
  }

  /** The catch-up snapshots of every live note. */
  snapshots(): YjsDocSnapshot[] {
    return [...this.docs]
      .filter(([id]) => this.server.pathOf(id) !== null)
      .map(([id, doc]) => snapshotOf(doc, id));
  }

  /** Apply every `yjs:update` the engine has sent since the last call. */
  absorb(): void {
    for (const e of this.harness.socketIfBuilt()?.emits ?? []) {
      if (e.event !== 'yjs:update' || this.absorbed.has(e)) continue;
      this.absorbed.add(e);
      const p = e.payload as { fileId: string; update: Uint8Array | number[] };
      const doc = this.docs.get(p.fileId);
      if (doc && this.server.pathOf(p.fileId) !== null) {
        Y.applyUpdate(doc, Uint8Array.from(p.update));
      }
    }
  }

  /** Answer every `yjs:fetch` asked so far. */
  answerFetches(): void {
    for (const f of this.harness.socketIfBuilt()?.fetches.splice(0) ?? []) {
      const doc = this.docs.get(f.fileId);
      if (!doc || this.server.pathOf(f.fileId) === null) {
        f.answer({ ok: false, error: 'file_not_found' });
        continue;
      }
      f.answer({
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(doc)),
        stateVector: Array.from(Y.encodeStateVector(doc)),
      });
    }
  }

  /**
   * Let the server work until nothing moves: answer file operations and
   * `yjs:fetch`, and apply what the engine sends.
   */
  async drive(rounds = 12): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      await this.server.pump();
      await this.harness.settle();
      this.absorb();
      const asked = this.harness.socketIfBuilt()?.fetches.length ?? 0;
      this.answerFetches();
      await flushAsync(20);
      this.absorb();
      if (asked === 0 && round > 1) return;
    }
  }

  private created(id: string, data: unknown, revived: boolean): void {
    const file = this.server.files.get(id);
    if (!file || file.fileType !== 'TEXT') return;
    const text =
      data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : Array.isArray(data)
            ? new TextDecoder().decode(Uint8Array.from(data as number[]))
            : '';
    const stored = this.docs.get(id);
    if (revived && stored && !this.opts.replaceOnRevive) {
      const t = stored.getText('content');
      stored.transact(() => {
        t.delete(0, t.length);
        t.insert(0, text);
      });
    } else {
      this.docs.set(id, serverDocWith(text));
    }
    const socket = this.harness.socketIfBuilt();
    const doc = this.docs.get(id);
    if (socket?.connected && doc) {
      socket.fire('yjs:update', { fileId: id, update: Array.from(Y.encodeStateAsUpdate(doc)) });
    }
  }
}

/**
 * How the server writes a note's new text into its history (`editYText` in
 * `Project/server`, `src/lib/crdt/persistence.ts`): a character diff — the
 * one `applyTextDiff` makes — up to 1000 characters inserted and deleted; a
 * line diff up to 2000 lines past that; and past that, one span from the
 * first difference to the last. A text the device edited offline meanwhile
 * keeps its edits where they were: what the write left unchanged keeps its
 * items.
 */
function serverTextEdit(ytext: Y.Text, text: string): void {
  const current = ytext.toJSON();
  const changes =
    diffChars(current, text, { maxEditLength: 1000, timeout: 250 }) ??
    diffLines(current, text, { maxEditLength: 2000, timeout: 250 });
  if (changes) {
    let cursor = 0;
    for (const change of changes) {
      if (change.added) {
        ytext.insert(cursor, change.value);
        cursor += change.value.length;
      } else if (change.removed) {
        ytext.delete(cursor, change.value.length);
      } else {
        cursor += change.value.length;
      }
    }
    return;
  }
  let start = 0;
  const limit = Math.min(current.length, text.length);
  while (start < limit && current[start] === text[start]) start += 1;
  let end = 0;
  while (end < limit - start && current[current.length - 1 - end] === text[text.length - 1 - end]) {
    end += 1;
  }
  ytext.delete(start, current.length - end - start);
  ytext.insert(start, text.slice(start, text.length - end));
}

/** The server's `appendConflictSuffix`. */
function conflictName(path: string, clientId: string, attempt = 1): string {
  const tag =
    (clientId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'unknown') +
    (attempt > 1 ? `-${attempt}` : '');
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash) return `${path.slice(0, dot)}.conflict-${tag}${path.slice(dot)}`;
  return `${path}.conflict-${tag}`;
}

// -- The disk under state.json --------------------------------------------------

/** Where the plugin keeps `state.json` (vault-relative). */
export const STATE_PATH = '.obsidian/plugins/team-vault/state.json';

/**
 * `LogStorage` of an in-memory disk: a file holds what the last completed
 * write left there. {@link snapshot} is the disk as it is now — what the next
 * start of Obsidian would find, whatever the process still holds in memory.
 * `failWrites` makes every write fail (a full disk).
 */
export class FakeStorage implements LogStorage {
  readonly files = new Map<string, string>();
  /** Every `state.json` the disk has held, in order (after each completed step). */
  readonly states: string[] = [];
  failWrites = false;
  /** Called with each `state.json` as it lands on the disk (see {@link states}). */
  onState: ((state: StoredState) => void) | null = null;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  stat(path: string): Promise<{ size: number } | null> {
    const data = this.files.get(path);
    return Promise.resolve(data === undefined ? null : { size: data.length });
  }
  append(path: string, data: string): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('ENOSPC'));
    this.files.set(path, (this.files.get(path) ?? '') + data);
    return Promise.resolve();
  }
  write(path: string, data: string): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('ENOSPC'));
    this.files.set(path, data);
    this.noteState(path);
    return Promise.resolve();
  }
  rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) return Promise.reject(new Error(`ENOENT ${from}`));
    this.files.delete(from);
    this.files.set(to, data);
    this.noteState(to);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  read(path: string): Promise<string> {
    const data = this.files.get(path);
    return data === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(data);
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  /** The disk as it is now: a copy the process no longer writes to. */
  snapshot(): FakeStorage {
    const copy = new FakeStorage();
    for (const [path, data] of this.files) copy.files.set(path, data);
    return copy;
  }

  /** The `state.json` on disk now, parsed; `null` when there is none. */
  state(): StoredState | null {
    const raw = this.files.get(STATE_PATH) ?? this.files.get(`${STATE_PATH}.tmp`);
    return raw === undefined ? null : (JSON.parse(raw) as StoredState);
  }

  private noteState(path: string): void {
    if (path !== STATE_PATH) return;
    const data = this.files.get(path);
    if (data === undefined) return;
    this.states.push(data);
    this.onState?.(JSON.parse(data) as StoredState);
  }
}

/** `state.json` as the tests read it. */
export interface StoredState {
  version: number;
  nextOpId: number;
  bindings: Record<
    string,
    {
      pending: Array<{ id: number; opId: string; opType: string; filePath: string }>;
      inflight?: Array<{ id: number; opId: string; opType: string; filePath: string }>;
      files: Array<{ relativePath: string; serverFileId: string; contentHash: string }>;
      state: { lastVectorClock: Record<string, number> } | null;
    }
  >;
}

/**
 * An operation log on `storage`, loaded from it as the plugin loads
 * `state.json` at start. `flushDelayMs`: the debounce of its writes (the
 * plugin's is 500 ms).
 */
export async function logOn(storage: FakeStorage, flushDelayMs = 500): Promise<OperationLog> {
  const log = new OperationLog({ storage, filePath: STATE_PATH, flushDelayMs });
  await log.load();
  return log;
}

/**
 * Obsidian quits, or the process dies, now: the next start finds the vault's
 * disk and `state.json` as they are at this moment — not what the log holds
 * in memory — and a new engine starts from them (not connected yet). The old
 * engine's socket goes quiet; the old engine is then stopped, only so that it
 * does nothing more (what it writes then goes to the old disk's copy of
 * `state.json`, which nobody reads). `server` and `docs` serve the new engine.
 */
export async function restartFromDisk(
  h: Harness,
  storage: FakeStorage,
  opts: { server?: FakeServer; docs?: ServerDocs; manager?: DocManager; offline?: boolean } = {},
): Promise<{ next: Harness; storage: FakeStorage }> {
  const disk = storage.snapshot();
  h.socketIfBuilt()?.kill();
  await h.engine.stop();
  const log = await logOn(disk);
  const next = buildHarness({
    predecessor: h,
    log,
    ...(opts.manager ? { docs: opts.manager } : {}),
    ...(opts.offline ? { offline: true } : {}),
  });
  opts.server?.attach(next);
  opts.docs?.attach(next);
  return { next, storage: disk };
}

// -- The protocol's contract examples -------------------------------------------

/** One example of `tests/fixtures/protocol-0.4/` (`sync-protocol.md` §4), parsed. */
export function protocolFixture(name: string): unknown {
  const raw = readFileSync(joinPath(__dirname, 'fixtures', 'protocol-0.4', `${name}.json`), 'utf8');
  return JSON.parse(raw) as unknown;
}

/**
 * The shape of a JSON value: its keys, all the way down (an array by its
 * first element), and the type of each leaf. Two values of one shape have
 * the same fields where the contract's examples have them. A vector clock is
 * a map of clients: its shape is `'VectorClock'`, whoever is in it.
 */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      out[key] = key === 'vectorClock' ? 'VectorClock' : shapeOf(field);
    }
    return out;
  }
  return typeof value;
}
