import { SyncEngine, type EngineStatus } from '@/sync/engine';
import { OperationLog } from '@/sync/operation-log';
import { DocManager } from '@/crdt/doc-manager';
import { RecentlyApplied } from '@/watcher/recently-applied';
import { ApiClient, type RequestUrlResponse } from '@/client/api';
import {
  SocketClient,
  type SocketFactory,
  type SocketFactoryOptions,
  type SocketLike,
} from '@/client/socket';
import { FsWatcher, type FsWatcherFactory } from '@/watcher/fs-watcher';
import { ObsidianWatcher, type VaultEvent, type WatchableVault } from '@/watcher/obsidian-events';
import type { ServerConfig, VaultBinding } from '@/settings/settings';
import type { VaultAdapter } from '@/sync/vault-adapter';

/**
 * Служебные файлы ОС и других синхронизаторов. С 0.3.4 привязка всегда
 * охватывает весь вальт, и то, что Finder, Проводник, Syncthing или Dropbox
 * оставляют в корне вальта, уходило в проект и дальше на диски всей команды.
 * Фильтр один (`isAlwaysIgnored` в `path-utils`), а здесь проверено, что его
 * соблюдают все стороны: chokidar, вотчер Obsidian, исходящий гейт движка,
 * начальная выгрузка, очередь офлайн-операций и гейт путей от сервера.
 *
 * Отдельный файл, а не `sync-engine.test.ts`: харнесс ниже — урезанная копия
 * тамошнего, ровно на эти сценарии.
 */

// -- Engine harness -------------------------------------------------------------

class MemoryVault implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();

  getBasePath(): string {
    return '/vault';
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(this.expect(path));
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.expect(path);
  }
  async createText(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, bytes(content));
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, bytes(content));
  }
  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, content);
  }
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const buf = this.expect(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, buf);
  }
  async ensureParentFolder(): Promise<void> {
    /* no-op for the in-memory adapter */
  }
  async list(folderPath: string): Promise<string[]> {
    const norm = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const paths = [...this.files.keys()];
    if (norm === '') return paths;
    return paths.filter((p) => p === norm || p.startsWith(`${norm}/`));
  }

  private expect(path: string): ArrayBuffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`missing file ${path}`);
    return buf;
  }
}

class FakeSocket implements SocketLike {
  connected = false;
  emits: Array<{ event: string; args: unknown[] }> = [];
  static last: FakeSocket | null = null;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor() {
    FakeSocket.last = this;
  }

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
    if (event === 'yjs:fetch') {
      const ack = args[args.length - 1] as (r: unknown) => void;
      ack({ ok: false, error: 'not_supported' });
      return this;
    }
    this.emits.push({ event, args });
    return this;
  }
  connect(): SocketLike {
    this.connected = true;
    this.fire('connect');
    return this;
  }
  disconnect(): SocketLike {
    this.connected = false;
    this.fire('disconnect', 'manual');
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
  }
  ackOk(extra: Record<string, unknown> = {}): void {
    const last = this.emits[this.emits.length - 1];
    const ack = last?.args[last.args.length - 1] as ((r: unknown) => void) | undefined;
    if (ack) ack({ ok: true, ...extra });
  }
  /** Paths of every `file:create` the engine sent. */
  createdPaths(): string[] {
    return this.emits
      .filter((e) => e.event === 'file:create')
      .map((e) => (e.args[0] as { filePath: string }).filePath);
  }
}

const socketFactory: SocketFactory = (_url: string, _options: SocketFactoryOptions) =>
  new FakeSocket();

const server: ServerConfig = {
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

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function response(over: Partial<RequestUrlResponse>): () => RequestUrlResponse {
  return () => ({
    status: 200,
    json: {},
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
    text: '',
    ...over,
  });
}

function listing(files: Array<{ id: string; path: string; fileType?: 'TEXT' | 'BINARY' }>) {
  return response({
    json: {
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        fileType: f.fileType ?? 'TEXT',
        contentHash: 'h',
        size: '5',
        mimeType: 'application/octet-stream',
        deletedAt: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        lastModifiedById: 'u1',
      })),
    },
  });
}

interface Harness {
  engine: SyncEngine;
  vault: MemoryVault;
  socket: () => FakeSocket;
  apiCalls: Array<{ url: string; method?: string | undefined }>;
  apiResponses: Map<string, () => RequestUrlResponse>;
  log: OperationLog;
  ra: RecentlyApplied;
}

function buildHarness(): Harness {
  const vault = new MemoryVault();
  const log = new OperationLog();
  const ra = new RecentlyApplied();
  const apiCalls: Array<{ url: string; method?: string | undefined }> = [];
  const apiResponses = new Map<string, () => RequestUrlResponse>();
  apiResponses.set('GET /api/projects/p1/files', listing([]));
  apiResponses.set('GET /api/projects/p1/files?includeDeleted=true', listing([]));

  const respond = async (params: { url: string; method?: string }) => {
    apiCalls.push({ url: params.url, method: params.method });
    const path = params.url.replace(server.url, '');
    if (params.method === 'PUT' && path.includes('/blobs/')) return response({})();
    const responder = apiResponses.get(`${params.method ?? 'GET'} ${path}`);
    if (!responder) throw new Error(`unexpected request: ${params.method ?? 'GET'} ${path}`);
    return responder();
  };
  const api = new ApiClient(server, respond, respond);
  const engine = new SyncEngine({
    binding,
    server,
    clientId: 'device-1',
    vault,
    operationLog: log,
    docManager: new DocManager(),
    recentlyApplied: ra,
    apiClient: api,
    socketClient: new SocketClient({ server, clientId: 'device-1', factory: socketFactory }),
  });
  return {
    engine,
    vault,
    socket: () => {
      if (!FakeSocket.last) throw new Error('socket not yet built — call engine.start() first');
      return FakeSocket.last;
    },
    apiCalls,
    apiResponses,
    log,
    ra,
  };
}

/** Start the engine and answer `project:join` with an empty catch-up. */
async function startJoined(h: Harness): Promise<void> {
  await h.engine.start();
  h.socket().ackOk({ operations: [], yjsDocs: [] });
  await flushAsync(20);
}

async function flushAsync(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

afterEach(() => {
  FakeSocket.last = null;
});

// -- Watcher fakes --------------------------------------------------------------

class FakeChokidar {
  static last: FakeChokidar | null = null;
  options: { ignored?: (p: string) => boolean } = {};
  private listeners = new Map<string, Set<(p: string) => void>>();

  constructor(_paths: string[], options: unknown) {
    FakeChokidar.last = this;
    this.options = options as { ignored?: (p: string) => boolean };
  }
  on(event: string, cb: (p: string) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(cb);
    return this;
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
  /**
   * What real chokidar does: a path its `ignored` predicate refuses is never
   * reported (and a refused folder is never descended into).
   */
  fire(event: string, absolutePath: string): void {
    if (this.options.ignored?.(absolutePath)) return;
    for (const cb of this.listeners.get(event) ?? []) cb(absolutePath);
  }
}

const chokidarFactory: FsWatcherFactory = (paths, options) =>
  new FakeChokidar(paths, options) as unknown as ReturnType<FsWatcherFactory>;

class FakeObsidianVault {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on(name: string, cb: (...args: unknown[]) => void): unknown {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(cb);
    return { name, cb };
  }
  offref(ref: unknown): void {
    const r = ref as { name: string; cb: (...args: unknown[]) => void };
    this.listeners.get(r.name)?.delete(r.cb);
  }
  fire(name: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(...args);
  }
}

// -- Tests ----------------------------------------------------------------------

describe('служебные файлы — вотчеры', () => {
  afterEach(() => {
    FakeChokidar.last = null;
  });

  it('chokidar не сообщает о .DS_Store, desktop.ini, Thumbs.db и папках Syncthing', () => {
    const events: VaultEvent[] = [];
    const watcher = new FsWatcher({
      vaultBasePath: 'D:\\vault',
      bindings: () => [binding],
      recentlyApplied: new RecentlyApplied(),
      factory: chokidarFactory,
    });
    watcher.onEvent((e) => events.push(e));
    watcher.start();
    const chokidar = FakeChokidar.last;
    if (!chokidar) throw new Error('chokidar not constructed');

    // Сам предикат `ignored`: по нему chokidar не заходит в папку вовсе.
    expect(chokidar.options.ignored?.('D:\\vault\\.stversions')).toBe(true);
    expect(chokidar.options.ignored?.('D:\\vault\\.stfolder')).toBe(true);
    expect(chokidar.options.ignored?.('D:\\vault\\notes')).toBe(false);

    for (const p of [
      'D:\\vault\\.DS_Store',
      'D:\\vault\\notes\\.DS_Store',
      'D:\\vault\\desktop.ini',
      'D:\\vault\\images\\Thumbs.db',
      'D:\\vault\\.stfolder\\syncthing-folder-0a1b2c.txt',
      'D:\\vault\\.stversions\\idea~20260922-101500.md',
    ]) {
      chokidar.fire('add', p);
      chokidar.fire('unlink', p);
    }
    chokidar.fire('add', 'D:\\vault\\notes\\idea.md');

    expect(events).toEqual([
      { type: 'create', bindingId: 'b1', path: 'notes/idea.md', source: 'fs' },
    ]);
    void watcher.stop();
  });

  it('вотчер Obsidian не пропускает desktop.ini и Thumbs.db', () => {
    // Obsidian не индексирует пути с точкой, так что `.DS_Store` до него не
    // доходит; а вот `desktop.ini` и `Thumbs.db` для него обычные файлы.
    const vault = new FakeObsidianVault();
    const events: VaultEvent[] = [];
    const timers: Array<() => void> = [];
    const watcher = new ObsidianWatcher({
      bindings: () => [binding],
      recentlyApplied: new RecentlyApplied(),
      setTimeout: (cb) => timers.push(cb),
      clearTimeout: () => undefined,
    });
    watcher.onEvent((e) => events.push(e));
    watcher.start(vault as unknown as WatchableVault);

    for (const path of ['desktop.ini', 'Проекты/desktop.ini', 'Thumbs.db', 'images/THUMBS.DB']) {
      vault.fire('create', { path, kind: 'file' });
      vault.fire('modify', { path, kind: 'file' });
      vault.fire('delete', { path, kind: 'file' });
    }
    for (const t of timers) t();
    vault.fire('create', { path: 'idea.md', kind: 'file' });

    expect(events).toEqual([
      { type: 'create', bindingId: 'b1', path: 'idea.md', source: 'obsidian' },
    ]);
    watcher.stop();
  });
});

describe('служебные файлы — движок', () => {
  it('созданный локально .DS_Store не выгружается ни событием, ни очередью', async () => {
    const h = buildHarness();
    await startJoined(h);
    const before = h.socket().emits.length;
    const callsBefore = h.apiCalls.length;

    h.vault.files.set('notes/.DS_Store', bytes('\0\0\0\u0001Bud1'));
    h.vault.files.set('desktop.ini', bytes('[.ShellClassInfo]\r\nIconResource=x.ico,0\r\n'));
    // Не `await`: без гейта `file:create` ждал бы ack, которого тут нет.
    void h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'notes/.DS_Store',
      source: 'fs',
    });
    void h.engine.handleVaultEvent({
      type: 'create',
      bindingId: 'b1',
      path: 'desktop.ini',
      source: 'obsidian',
    });
    await flushAsync(20);

    expect(h.socket().emits.slice(before)).toHaveLength(0);
    // Ни байтов на сервер (бинарные уходят PUT-ом в /blobs/ ещё до emit),
    // ни операции в очереди на следующий реконнект.
    expect(h.apiCalls.slice(callsBefore)).toHaveLength(0);
    expect(h.log.pendingCount('b1')).toBe(0);
    await h.engine.stop();
  });

  it('chokidar → движок: .DS_Store, появившийся на диске, не уходит на сервер', async () => {
    const h = buildHarness();
    await startJoined(h);
    const watcher = new FsWatcher({
      vaultBasePath: '/vault',
      bindings: () => [binding],
      recentlyApplied: h.ra,
      factory: chokidarFactory,
    });
    watcher.onEvent((e) => void h.engine.handleVaultEvent(e));
    watcher.start();
    const chokidar = FakeChokidar.last;
    if (!chokidar) throw new Error('chokidar not constructed');

    h.vault.files.set('.DS_Store', bytes('\0\0\0\u0001Bud1'));
    chokidar.fire('add', '/vault/.DS_Store');
    await flushAsync(20);

    expect(h.socket().createdPaths()).toEqual([]);
    expect(h.log.pendingCount('b1')).toBe(0);
    await watcher.stop();
    await h.engine.stop();
  });

  it('начальная выгрузка пропускает служебные файлы ОС и Syncthing', async () => {
    const h = buildHarness();
    // Служебные — ПЕРВЫМИ: initialPush ждёт ack на каждый файл, и если бы
    // первым шёл обычный файл, до остальных цикл бы не дошёл — тест был бы
    // зелёным независимо от фильтра.
    h.vault.files.set('.DS_Store', bytes('\0\0\0\u0001Bud1'));
    h.vault.files.set('desktop.ini', bytes('[.ShellClassInfo]'));
    h.vault.files.set('images/Thumbs.db', bytes('thumbs'));
    h.vault.files.set('.stfolder/syncthing-folder-0a1b2c.txt', bytes('marker'));
    h.vault.files.set('.stversions/idea~20260922-101500.md', bytes('old'));
    h.vault.files.set('.dropbox.cache/2026-09-22/idea.md', bytes('cache'));
    h.vault.files.set('idea.md', bytes('ok'));

    await startJoined(h);
    h.socket().ackOk({ outcome: { fileId: 'f1', path: 'idea.md' } });
    await flushAsync(20);

    expect(h.socket().createdPaths()).toEqual(['idea.md']);
    await h.engine.stop();
  });

  it('операция по .DS_Store из очереди старой сборки выбрасывается, а не выгружается', async () => {
    const h = buildHarness();
    h.log.enqueueOperation('b1', {
      opType: 'CREATE',
      filePath: '.DS_Store',
      payload: { contentHash: 'h', size: 8, fileType: 'BINARY' },
    });
    h.vault.files.set('.DS_Store', bytes('\0\0\0\u0001Bud1'));

    await startJoined(h);

    expect(h.socket().createdPaths()).toEqual([]);
    expect(h.log.pendingCount('b1')).toBe(0);
    await h.engine.stop();
  });

  it('.DS_Store, пришедший с сервера, не скачивается и не пишется на диск', async () => {
    const h = buildHarness();
    // Ответ на скачивание есть: без гейта движок записал бы эти байты.
    h.apiResponses.set(
      'GET /api/projects/p1/files/f9',
      response({ arrayBuffer: bytes('\0\0\0\u0001Bud1') }),
    );
    await startJoined(h);
    const seen: EngineStatus[] = [];
    h.engine.onStatus((s) => seen.push(s));

    h.socket().fire('file:created', {
      result: { outcome: { fileId: 'f9', path: 'notes/.DS_Store' } },
      log: { id: 'l1', vectorClock: { srv: 1 }, createdAt: '2026-01-01' },
    });
    await flushAsync(20);

    expect(await h.vault.exists('notes/.DS_Store')).toBe(false);
    expect(h.apiCalls.filter((c) => c.url.endsWith('/files/f9'))).toHaveLength(0);
    expect(h.engine.getFileIdForPath('notes/.DS_Store')).toBeNull();
    expect(seen).not.toContain('error');
    await h.engine.stop();
  });

  it('служебные файлы из листинга сервера не индексируются, и их удаление не трогает локальные', async () => {
    // Такие файлы уже лежат на сервере: их выгрузили 0.3.4–0.3.7. Локальный
    // desktop.ini — файл Проводника этой машины: ни перезаписать, ни удалить
    // его по команде сервера нельзя.
    const h = buildHarness();
    h.apiResponses.set(
      'GET /api/projects/p1/files',
      listing([
        { id: 'f1', path: 'idea.md' },
        { id: 'f2', path: '.DS_Store', fileType: 'BINARY' },
        { id: 'f3', path: 'desktop.ini', fileType: 'BINARY' },
        { id: 'f4', path: '.stversions/idea~20260922-101500.md' },
      ]),
    );
    h.vault.files.set('idea.md', bytes('ok'));
    h.vault.files.set('desktop.ini', bytes('[.ShellClassInfo]'));
    // Запись state.json, оставленная сборкой без фильтра, тоже вычищается.
    h.log.setFileMeta({
      bindingId: 'b1',
      relativePath: 'desktop.ini',
      serverFileId: 'f3',
      contentHash: 'h',
      size: 5,
      fileType: 'BINARY',
      lastSyncedAt: 0,
    });

    await startJoined(h);

    expect(h.engine.getFileIdForPath('idea.md')).toBe('f1');
    expect(h.engine.getFileIdForPath('.DS_Store')).toBeNull();
    expect(h.engine.getFileIdForPath('desktop.ini')).toBeNull();
    expect(h.engine.getFileIdForPath('.stversions/idea~20260922-101500.md')).toBeNull();
    expect(h.log.getFileMeta('b1', 'desktop.ini')).toBeNull();

    h.socket().fire('file:deleted', { fileId: 'f3' });
    h.socket().fire('file:updated-binary', { fileId: 'f3' });
    await flushAsync(20);

    expect(await h.vault.readText('desktop.ini')).toBe('[.ShellClassInfo]');
    expect(h.apiCalls.filter((c) => c.url.endsWith('/files/f3'))).toHaveLength(0);
    await h.engine.stop();
  });
});
