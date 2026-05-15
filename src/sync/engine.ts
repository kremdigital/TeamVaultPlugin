import type { ServerConfig, VaultBinding } from '@/settings/settings';
import { ApiClient } from '@/client/api';
import {
  SocketClient,
  type FileEvent as SocketFileEvent,
  type ServerOperation,
  type YjsUpdateMessage,
} from '@/client/socket';
import { DocManager } from '@/crdt/doc-manager';
import { OperationLog, type FileMeta, type OperationType } from './operation-log';
import { classifyFileType, type FileType } from './file-type';
import { sha256Hex } from './hash';
import { increment, type VectorClock } from './vector-clock';
import type { VaultAdapter } from './vault-adapter';
import {
  computeDeepSyncDiff,
  flushPendingQueue,
  type DeepSyncDiff,
  type PendingEmitter,
  type ReplayOutcome,
} from './reconnect';
import {
  buildConflictPath,
  defaultConflictResolver,
  detectBinaryConflict,
  detectDeleteConflict,
  type ConflictResolver,
} from './conflict';
import type { VaultEvent } from '@/watcher/obsidian-events';
import type { RecentlyApplied } from '@/watcher/recently-applied';
import { isInBinding } from '@/watcher/path-utils';
import { debounce, type DebouncedFunction } from '@/utils/debounce';

/**
 * Per-binding sync engine — the central orchestrator.
 *
 * One `SyncEngine` runs per `VaultBinding`. Top-level wiring (a future
 * `EngineManager` on Stage 9-10) creates one per active binding and feeds
 * vault events to all of them; each engine filters by its own binding id.
 *
 * Responsibilities:
 *
 *   - Open the Socket.IO connection, do `project:join`, apply the
 *     catch-up payload (operation log + Yjs sync-step1).
 *   - Translate vault watcher events into REST/Socket emits with proper
 *     vector clock bumps; queue offline edits in the operation log.
 *   - Translate server-pushed `FileEvent` / Yjs updates back into vault
 *     mutations, marking each path in `RecentlyApplied` to break echo.
 *
 * Construction is deeply DI-friendly so unit tests can drive every flow
 * without a real server, real Yjs persistence, or a real Obsidian vault.
 */

export interface SyncEngineDeps {
  binding: VaultBinding;
  server: ServerConfig;
  /** Stable per-device id. Same value goes into the vector clock keys. */
  clientId: string;
  vault: VaultAdapter;
  operationLog: OperationLog;
  docManager: DocManager;
  recentlyApplied: RecentlyApplied;
  /** Test seam — defaults to a real `ApiClient` for the server config. */
  apiClient?: ApiClient;
  /** Test seam — defaults to a real `SocketClient`. */
  socketClient?: SocketClient;
  /** Debounce window (ms) for "Yjs update applied → write file to disk". Default 500. */
  diskSnapshotDebounceMs?: number;
  /** UI hook for binary / delete conflicts. Defaults to keep-server. */
  conflictResolver?: ConflictResolver;
  /** Test seam — `Date.now` substitute. Used for `buildConflictPath`. */
  now?: () => number;
}

export type EngineStatus = 'stopped' | 'connecting' | 'syncing' | 'connected' | 'error' | 'offline';

export type StatusListener = (status: EngineStatus, detail?: string) => void;

interface FileMetaIndex {
  byPath: Map<string, FileMeta & { fileId: string }>;
  byId: Map<string, FileMeta & { fileId: string }>;
}

export class SyncEngine {
  private readonly binding: VaultBinding;
  private readonly server: ServerConfig;
  private readonly clientId: string;
  private readonly vault: VaultAdapter;
  private readonly operationLog: OperationLog;
  private readonly docManager: DocManager;
  private readonly recentlyApplied: RecentlyApplied;
  private readonly api: ApiClient;
  private readonly socket: SocketClient;
  private readonly diskSnapshotDebounceMs: number;
  private readonly conflictResolver: ConflictResolver;
  private readonly now: () => number;

  /** Local vector clock for the binding — bumped before each outgoing op. */
  private vectorClock: VectorClock;

  private status: EngineStatus = 'stopped';
  private statusListeners = new Set<StatusListener>();

  /**
   * In-memory mirror of `file_meta` rows for this binding, plus the
   * server-side `fileId`. We keep both for fast lookup during event
   * dispatch (path → id, id → path).
   */
  private fileIndex: FileMetaIndex = { byPath: new Map(), byId: new Map() };

  /**
   * `Y.Doc` → file snapshot debouncers, keyed by file path. We persist
   * disk snapshots after Yjs updates settle so the file-on-disk stays
   * in lockstep with the editor's CRDT state.
   */
  private snapshotDebouncers = new Map<string, DebouncedFunction<[]>>();

  /** Subscriber tear-down list. */
  private cleanups: Array<() => void> = [];

  constructor(deps: SyncEngineDeps) {
    this.binding = deps.binding;
    this.server = deps.server;
    this.clientId = deps.clientId;
    this.vault = deps.vault;
    this.operationLog = deps.operationLog;
    this.docManager = deps.docManager;
    this.recentlyApplied = deps.recentlyApplied;
    this.api = deps.apiClient ?? new ApiClient(deps.server);
    this.socket =
      deps.socketClient ?? new SocketClient({ server: deps.server, clientId: deps.clientId });
    this.diskSnapshotDebounceMs = deps.diskSnapshotDebounceMs ?? 500;
    this.conflictResolver = deps.conflictResolver ?? defaultConflictResolver;
    this.now = deps.now ?? Date.now;

    const persisted = this.operationLog.getBindingState(this.binding.id);
    this.vectorClock = persisted?.lastVectorClock ?? this.binding.lastVectorClock ?? {};
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Connect to the server, run the catch-up handshake, drain any queued
   * pending operations. Idempotent — calling on a started engine is a
   * no-op.
   */
  async start(): Promise<void> {
    if (this.status !== 'stopped' && this.status !== 'error') return;
    this.setStatus('connecting');

    this.cleanups.push(this.socket.onConnect(() => void this.onSocketConnect()));
    this.cleanups.push(
      this.socket.onDisconnect((reason) => {
        this.setStatus('offline', reason);
      }),
    );
    this.cleanups.push(
      this.socket.onError((err) => {
        this.setStatus('error', err.message);
      }),
    );
    this.cleanups.push(this.socket.onFileEvent((event) => void this.handleServerFileEvent(event)));
    this.cleanups.push(this.socket.onYjsUpdate((msg) => this.handleServerYjsUpdate(msg)));

    this.socket.connect();
  }

  async stop(): Promise<void> {
    for (const cb of this.cleanups) cb();
    this.cleanups = [];
    for (const d of this.snapshotDebouncers.values()) d.cancel();
    this.snapshotDebouncers.clear();
    this.socket.disconnect();
    this.setStatus('stopped');
  }

  /** Subscribe to status transitions. Returns an unsubscribe handle. */
  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getBindingId(): string {
    return this.binding.id;
  }

  /**
   * Look up the server-side file id the engine has cached for a vault
   * path. Returns `null` if the engine doesn't know about the file
   * (either it's outside the binding's `localFolder`, or the file
   * index hasn't been refreshed yet — usually because the engine isn't
   * connected).
   *
   * Used by the History view (Stage 14) to talk to the right file
   * without reaching into engine internals.
   */
  getFileIdForPath(vaultPath: string): string | null {
    return this.fileIndex.byPath.get(vaultPath)?.fileId ?? null;
  }

  /**
   * Entry point for events coming out of the watchers. The engine filters
   * by binding id and dispatches to the per-type handler.
   */
  async handleVaultEvent(event: VaultEvent): Promise<void> {
    if (event.bindingId !== this.binding.id) return;
    if (!this.binding.enabled) return;
    switch (event.type) {
      case 'create':
        await this.handleLocalCreate(event.path);
        break;
      case 'modify':
        await this.handleLocalModify(event.path);
        break;
      case 'delete':
        await this.handleLocalDelete(event.path);
        break;
      case 'rename':
        await this.handleLocalRename(event.oldPath, event.newPath);
        break;
    }
  }

  // -- Connection / catch-up -----------------------------------------------

  private async onSocketConnect(): Promise<void> {
    try {
      this.setStatus('syncing');
      // Fire `project:join` synchronously (no await before it) so tests can
      // observe the emit immediately, and let the file-index refresh run
      // in parallel.
      const joinPromise = this.socket.joinProject(this.binding.projectId, this.vectorClock);
      const filesPromise = this.refreshFileIndex();
      const [result] = await Promise.all([joinPromise, filesPromise]);
      if (!result.ok) {
        this.setStatus('error', result.error);
        return;
      }

      // Apply server-side operations the client missed.
      for (const op of result.operations) {
        await this.applyServerOperation(op);
      }

      // Hydrate Yjs docs from sync-step1 payloads — and, in the same loop,
      // push back anything the server is missing. y-indexeddb keeps offline
      // text edits across reloads but the local-update fan-out only fires
      // for *future* edits, so without this round-trip the offline ops stay
      // stuck client-side forever and the server's `changed`-detection sees
      // every subsequent live edit as a no-op replay (the parent structs of
      // the new op are missing on the server).
      for (const snap of result.yjsDocs) {
        const meta = this.fileIndex.byId.get(snap.fileId);
        if (!meta) continue;
        const update = Uint8Array.from(snap.sync1);
        this.docManager.applyRemoteUpdate(this.binding.id, meta.relativePath, update);
        await this.snapshotDocToDisk(meta.relativePath);

        if (snap.stateVector && snap.stateVector.length > 0) {
          const serverVector = Uint8Array.from(snap.stateVector);
          const missing = this.docManager.encodeStateAsUpdate(
            this.binding.id,
            meta.relativePath,
            serverVector,
          );
          // An "empty" Yjs delta is ~2 bytes (zero-struct, zero-delete
          // markers). A larger buffer means we actually have local ops the
          // server doesn't know about yet — push them.
          if (missing.length > 2) {
            void this.socket.emitYjsUpdate({
              projectId: this.binding.projectId,
              fileId: meta.fileId,
              update: missing,
            });
          }
        }
      }

      // Subscribe each known text doc to local-update emits — Yjs will
      // start broadcasting from here on out.
      for (const meta of this.fileIndex.byPath.values()) {
        if (meta.fileType === 'TEXT') this.wireYjsForTextFile(meta.fileId, meta.relativePath);
      }

      this.persistVectorClock();
      this.setStatus('connected');

      // Reconnect catch-up tail, kicked off in the background so the
      // `connected` status doesn't wait on every queued upload. Ordering
      // inside is load-bearing — see `drainThenInitialPush`.
      void this.drainThenInitialPush();
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : 'sync_failed');
    }
  }

  /**
   * Reconnect catch-up tail. The pending-operation queue **must** drain
   * before the initial-push pass runs — they used to race, and the race
   * is exactly the S4 offline-drain bug: `initialPush` walks the vault
   * and re-uploads a file that already has a queued CREATE/RENAME, so the
   * server sees two operations for one path and conflict-renames the
   * duplicate into `<name>.conflict-<clientId>`.
   *
   * Draining first means the queued ops (the user's real intent, in
   * order) win, and `replayPending` keeps `fileIndex` authoritative as it
   * goes — so the `initialPush` that follows recognises every file the
   * queue already synced and skips it.
   */
  private async drainThenInitialPush(): Promise<void> {
    try {
      await this.flushPendingOperations();
    } catch {
      // A failed drain must not block the initial-push pass — pre-existing
      // files still need their first upload, and whatever stayed queued is
      // retried on the next reconnect. `initialPush` itself skips paths
      // that are still queued.
    }
    await this.initialPush();
  }

  /**
   * Walk the binding's local folder, upload anything not in the server's
   * file index. Idempotent — files already mirrored on the server are
   * skipped via the `fileIndex` lookup, and files whose CREATE/RENAME is
   * still queued are skipped via `pendingPaths` (the queue is the source
   * of truth for those — re-uploading here would duplicate them on the
   * server). Errors per-file are swallowed so one bad file doesn't block
   * the rest.
   */
  private async initialPush(): Promise<void> {
    const paths = await this.vault.list(this.binding.localFolder);
    const pending = this.operationLog.pendingPaths(this.binding.id);
    for (const path of paths) {
      if (this.fileIndex.byPath.has(path)) continue;
      if (pending.has(path)) continue;
      try {
        await this.handleLocalCreate(path);
      } catch {
        // Per-file failures are swallowed — the watcher / next reconnect
        // will surface them again.
      }
    }
  }

  private async refreshFileIndex(): Promise<void> {
    const files = await this.api.getProjectFiles(this.binding.projectId);
    const byPath = new Map<string, FileMeta & { fileId: string }>();
    const byId = new Map<string, FileMeta & { fileId: string }>();
    for (const f of files) {
      const meta: FileMeta & { fileId: string } = {
        bindingId: this.binding.id,
        relativePath: f.path,
        serverFileId: f.id,
        fileId: f.id,
        contentHash: f.contentHash,
        size: f.size,
        fileType: f.fileType,
        lastSyncedAt: Date.now(),
      };
      byPath.set(f.path, meta);
      byId.set(f.id, meta);
      // Mirror into SQLite so the next reconnect has it.
      this.operationLog.setFileMeta(meta);
    }
    this.fileIndex = { byPath, byId };
  }

  // -- Local → Server -------------------------------------------------------

  private async handleLocalCreate(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    if (this.fileIndex.byPath.has(path)) {
      // The server already knows about this — treat as a modify.
      await this.handleLocalModify(path);
      return;
    }
    const fileType = classifyFileType(path);
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);

    if (this.socket.isConnected()) {
      const ack = await this.socket.emitFileCreate({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        filePath: path,
        fileType,
        contentHash: hash,
        size: buffer.byteLength,
        data: buffer,
      });
      if (ack.ok) {
        // Server ack carries `outcome.{fileId, path}` — record the file in
        // the local index immediately. Without this the broadcast event
        // that follows would treat the file as new and try to BINARY-
        // download it (404), and the next CREATE pass on this path would
        // re-upload (creating server-side conflict-renamed copies).
        const outcome = (ack as { outcome?: { fileId?: string; path?: string } }).outcome;
        if (outcome?.fileId && outcome?.path) {
          this.recordCreatedFile(outcome.fileId, outcome.path, fileType, hash, buffer.byteLength);
        }
        this.persistVectorClock();
        return;
      }
    }
    // Offline (or NACK) — queue and bail; the engine will replay on reconnect.
    this.queue('CREATE', path, null, {
      fileType,
      contentHash: hash,
      size: buffer.byteLength,
    });
  }

  /**
   * Record a freshly server-acknowledged CREATE in the in-memory file
   * index + the SQLite mirror, and wire its Yjs doc when it's text.
   * Shared by the online CREATE path (`handleLocalCreate`) and the
   * offline-queue replay (`replayPending`) so both keep `fileIndex`
   * authoritative — the initial-push pass relies on that to avoid
   * re-uploading files the server already has.
   */
  private recordCreatedFile(
    fileId: string,
    path: string,
    fileType: FileType,
    contentHash: string,
    size: number,
  ): void {
    const meta: FileMeta & { fileId: string } = {
      bindingId: this.binding.id,
      relativePath: path,
      serverFileId: fileId,
      fileId,
      contentHash,
      size,
      fileType,
      lastSyncedAt: Date.now(),
    };
    this.fileIndex.byPath.set(path, meta);
    this.fileIndex.byId.set(fileId, meta);
    this.operationLog.setFileMeta(meta);
    if (fileType === 'TEXT') this.wireYjsForTextFile(fileId, path);
  }

  private async handleLocalModify(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    const meta = this.fileIndex.byPath.get(path);
    if (!meta) {
      // No server record yet — promote to a CREATE.
      await this.handleLocalCreate(path);
      return;
    }
    if (meta.fileType === 'TEXT') {
      // Text edits flow through Yjs. Read the disk content and diff into
      // the doc — the docManager fan-out will ship a `yjs:update` for us.
      const content = await this.vault.readText(path);
      this.docManager.setText(this.binding.id, path, content);
      return;
    }
    const buffer = await this.vault.readBinary(path);
    const hash = await sha256Hex(buffer);
    if (hash === meta.contentHash) return; // nothing changed

    if (this.socket.isConnected()) {
      const ack = await this.socket.emitFileUpdateBinary({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId: meta.fileId,
        contentHash: hash,
        size: buffer.byteLength,
        data: buffer,
      });
      if (ack.ok) {
        meta.contentHash = hash;
        meta.size = buffer.byteLength;
        this.operationLog.setFileMeta(meta);
        this.persistVectorClock();
        return;
      }
    }
    this.queue('UPDATE', path, null, {
      fileId: meta.fileId,
      contentHash: hash,
      size: buffer.byteLength,
    });
  }

  private async handleLocalDelete(path: string): Promise<void> {
    if (!isInBinding(path, this.binding.localFolder)) return;
    const meta = this.fileIndex.byPath.get(path);
    const fileId = meta?.fileId ?? '';
    if (this.socket.isConnected() && fileId) {
      const ack = await this.socket.emitFileDelete({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId,
        filePath: path,
      });
      if (ack.ok) {
        this.fileIndex.byPath.delete(path);
        this.fileIndex.byId.delete(fileId);
        this.operationLog.deleteFileMeta(this.binding.id, path);
        this.persistVectorClock();
        return;
      }
    }
    this.queue('DELETE', path, null, { fileId });
  }

  private async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    const meta = this.fileIndex.byPath.get(oldPath);
    const fileId = meta?.fileId ?? '';
    if (this.socket.isConnected() && fileId) {
      const ack = await this.socket.emitFileRename({
        projectId: this.binding.projectId,
        clientId: this.clientId,
        vectorClock: this.bumpClock(),
        fileId,
        filePath: oldPath,
        newPath,
      });
      if (ack.ok) {
        if (meta) {
          this.operationLog.deleteFileMeta(this.binding.id, oldPath);
          meta.relativePath = newPath;
          this.operationLog.setFileMeta(meta);
          this.fileIndex.byPath.delete(oldPath);
          this.fileIndex.byPath.set(newPath, meta);
        }
        this.persistVectorClock();
        return;
      }
    }
    this.queue('RENAME', oldPath, newPath, { fileId });
  }

  /** Wire a text file's Yjs doc to the socket so future edits stream upstream. */
  private wireYjsForTextFile(fileId: string, path: string): void {
    const off = this.docManager.onLocalUpdate(this.binding.id, path, (update) => {
      if (!this.socket.isConnected()) return; // y-indexeddb keeps it; reconnect resends.
      void this.socket.emitYjsUpdate({
        projectId: this.binding.projectId,
        fileId,
        update,
      });
    });
    this.cleanups.push(off);
  }

  // -- Server → Local -------------------------------------------------------

  private async handleServerFileEvent(event: SocketFileEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'created': {
          // Server broadcasts `{ result: { outcome, log }, log }`. Pull
          // fileId + path out of `result.outcome`. Skip if we already
          // know about this file — that's the echo of our own push.
          const outcome = (
            event.result as
              | { outcome?: { fileId?: string; path?: string; kind?: string } }
              | undefined
          )?.outcome;
          if (!outcome?.fileId || !outcome?.path) break;
          if (this.fileIndex.byId.has(outcome.fileId)) break;
          await this.applyServerCreate({
            id: outcome.fileId,
            path: outcome.path,
            // Server doesn't ship the file type; classify locally. Good
            // enough for the markdown / text vs. binary split we care
            // about here.
            fileType: classifyFileType(outcome.path),
          });
          break;
        }
        case 'updated-binary':
          await this.applyServerUpdateBinary(event.fileId);
          break;
        case 'deleted':
          await this.applyServerDelete(event.fileId);
          break;
        case 'renamed':
        case 'moved':
          await this.applyServerRename(event.fileId, event.newPath);
          break;
      }
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : 'apply_failed');
    }
  }

  private handleServerYjsUpdate(msg: YjsUpdateMessage): void {
    const meta = this.fileIndex.byId.get(msg.fileId);
    if (!meta) return;
    this.docManager.applyRemoteUpdate(this.binding.id, meta.relativePath, msg.update);
    this.scheduleSnapshotToDisk(meta.relativePath);
  }

  /** Apply one operation from the project:join catch-up. */
  private async applyServerOperation(op: ServerOperation): Promise<void> {
    switch (op.opType) {
      case 'CREATE': {
        if (!isInBinding(op.filePath, this.binding.localFolder)) return;
        const payload = (op.payload ?? {}) as { fileType?: FileType; fileId?: string };
        const fileId = payload.fileId ?? this.fileIndex.byPath.get(op.filePath)?.fileId ?? '';
        if (!fileId) return;
        await this.applyServerCreate({
          id: fileId,
          path: op.filePath,
          fileType: payload.fileType ?? 'TEXT',
        });
        break;
      }
      case 'UPDATE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (fileId) await this.applyServerUpdateBinary(fileId);
        break;
      }
      case 'DELETE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (fileId) await this.applyServerDelete(fileId);
        break;
      }
      case 'RENAME':
      case 'MOVE': {
        const fileId = (op.payload as { fileId?: string } | null)?.fileId ?? '';
        if (fileId && op.newPath) await this.applyServerRename(fileId, op.newPath);
        break;
      }
    }
    if (op.vectorClock) {
      this.vectorClock = mergeClocks(this.vectorClock, op.vectorClock);
    }
  }

  private async applyServerCreate(payload: {
    id: string;
    path: string;
    fileType: FileType;
  }): Promise<void> {
    const meta: FileMeta & { fileId: string } = {
      bindingId: this.binding.id,
      relativePath: payload.path,
      serverFileId: payload.id,
      fileId: payload.id,
      contentHash: '',
      size: 0,
      fileType: payload.fileType,
      lastSyncedAt: Date.now(),
    };
    this.fileIndex.byPath.set(payload.path, meta);
    this.fileIndex.byId.set(payload.id, meta);

    // Pull initial bytes — Yjs takes over for text after the first
    // snapshot, but the file on disk needs to exist.
    if (payload.fileType === 'TEXT') {
      this.wireYjsForTextFile(payload.id, payload.path);
    } else {
      const buf = await this.api.downloadFile(this.binding.projectId, payload.id);
      this.recentlyApplied.mark(payload.path);
      await this.vault.ensureParentFolder(payload.path);
      await this.vault.createBinary(payload.path, buf);
      meta.size = buf.byteLength;
      meta.contentHash = await sha256Hex(buf);
      this.operationLog.setFileMeta(meta);
    }
  }

  private async applyServerUpdateBinary(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const newBuf = await this.api.downloadFile(this.binding.projectId, fileId);
    const newHash = await sha256Hex(newBuf);

    // Conflict detection — only triggers when the user has uncommitted edits.
    if (await this.vault.exists(meta.relativePath)) {
      const localBuf = await this.vault.readBinary(meta.relativePath);
      const localHash = await sha256Hex(localBuf);
      const conflict = detectBinaryConflict({
        storedHash: meta.contentHash,
        localHash,
        serverHash: newHash,
      });
      if (conflict) {
        const resolution = await this.conflictResolver.resolveBinaryConflict({
          filePath: meta.relativePath,
          localSize: localBuf.byteLength,
          serverSize: newBuf.byteLength,
        });
        if (resolution === 'keep-local') {
          // Push our local content as the new server version. Bump clock,
          // emit; if offline, queue. The server will then broadcast it
          // back as `file:updated-binary` — by then `meta.contentHash`
          // matches the local hash, so the second pass is a no-op.
          if (this.socket.isConnected()) {
            await this.socket.emitFileUpdateBinary({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              vectorClock: this.bumpClock(),
              fileId,
              contentHash: localHash,
              size: localBuf.byteLength,
              data: localBuf,
            });
          }
          meta.contentHash = localHash;
          meta.size = localBuf.byteLength;
          this.operationLog.setFileMeta(meta);
          return;
        }
        if (resolution === 'keep-both') {
          // Move the local edits aside, then write the server's version.
          const aside = buildConflictPath(meta.relativePath, this.now());
          this.recentlyApplied.mark(aside);
          await this.vault.ensureParentFolder(aside);
          await this.vault.rename(meta.relativePath, aside);
          // Note: the renamed file is NOT auto-uploaded — the user can
          // decide what to do with it; if they keep it, the next vault
          // event picks it up as a fresh CREATE.
        }
        // 'keep-server' falls through to the standard apply path below.
      }
    }

    this.recentlyApplied.mark(meta.relativePath);
    if (await this.vault.exists(meta.relativePath)) {
      await this.vault.writeBinary(meta.relativePath, newBuf);
    } else {
      await this.vault.ensureParentFolder(meta.relativePath);
      await this.vault.createBinary(meta.relativePath, newBuf);
    }
    meta.size = newBuf.byteLength;
    meta.contentHash = newHash;
    this.operationLog.setFileMeta(meta);
  }

  private async applyServerDelete(fileId: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;

    // Delete-vs-update guard: if the local file still exists and has
    // uncommitted edits, ask the user before clobbering them.
    if (await this.vault.exists(meta.relativePath)) {
      const localBuf = await this.vault.readBinary(meta.relativePath);
      const localHash = await sha256Hex(localBuf);
      const conflict = detectDeleteConflict({
        storedHash: meta.contentHash,
        localHash,
      });
      if (conflict) {
        const resolution = await this.conflictResolver.resolveDeleteConflict({
          filePath: meta.relativePath,
          localSize: localBuf.byteLength,
        });
        if (resolution === 'restore-server') {
          // Push the local content as a fresh CREATE so the server
          // un-deletes it. The recipient broadcast will reset our state.
          if (this.socket.isConnected()) {
            await this.socket.emitFileCreate({
              projectId: this.binding.projectId,
              clientId: this.clientId,
              vectorClock: this.bumpClock(),
              filePath: meta.relativePath,
              fileType: meta.fileType,
              contentHash: localHash,
              size: localBuf.byteLength,
              data: localBuf,
            });
          }
          // Don't drop local state — we want the file to stay.
          return;
        }
        // 'delete-local' falls through.
      }
    }

    this.recentlyApplied.mark(meta.relativePath);
    if (await this.vault.exists(meta.relativePath)) {
      await this.vault.delete(meta.relativePath);
    }
    this.fileIndex.byPath.delete(meta.relativePath);
    this.fileIndex.byId.delete(fileId);
    this.operationLog.deleteFileMeta(this.binding.id, meta.relativePath);
    await this.docManager.release(this.binding.id, meta.relativePath);
  }

  private async applyServerRename(fileId: string, newPath: string): Promise<void> {
    const meta = this.fileIndex.byId.get(fileId);
    if (!meta) return;
    const oldPath = meta.relativePath;
    if (oldPath === newPath) return;
    this.recentlyApplied.mark(oldPath);
    this.recentlyApplied.mark(newPath);
    if (await this.vault.exists(oldPath)) {
      if (await this.vault.exists(newPath)) {
        // Destination already materialised locally — e.g. an initial-push
        // pass created it, or this rename was partially applied before.
        // `adapter.rename` throws "Destination file already exists" here,
        // which would otherwise crash the engine to `error` status. The
        // server is authoritative and `newPath` is the canonical name, so
        // drop the stale source instead of colliding into it.
        await this.vault.delete(oldPath);
      } else {
        await this.vault.ensureParentFolder(newPath);
        await this.vault.rename(oldPath, newPath);
      }
    }
    this.operationLog.deleteFileMeta(this.binding.id, oldPath);
    meta.relativePath = newPath;
    this.operationLog.setFileMeta(meta);
    this.fileIndex.byPath.delete(oldPath);
    this.fileIndex.byPath.set(newPath, meta);
  }

  // -- Yjs disk snapshotting ------------------------------------------------

  private scheduleSnapshotToDisk(path: string): void {
    let d = this.snapshotDebouncers.get(path);
    if (!d) {
      d = debounce<[]>(() => {
        this.snapshotDebouncers.delete(path);
        void this.snapshotDocToDisk(path);
      }, this.diskSnapshotDebounceMs);
      this.snapshotDebouncers.set(path, d);
    }
    d();
  }

  private async snapshotDocToDisk(path: string): Promise<void> {
    if (!this.docManager.has(this.binding.id, path)) return;
    const text = this.docManager.getText(this.binding.id, path);
    this.recentlyApplied.mark(path);
    if (await this.vault.exists(path)) {
      await this.vault.writeText(path, text);
    } else {
      await this.vault.ensureParentFolder(path);
      await this.vault.createText(path, text);
    }
    const meta = this.fileIndex.byPath.get(path);
    if (meta) {
      meta.contentHash = await sha256Hex(text);
      meta.size = new TextEncoder().encode(text).byteLength;
      this.operationLog.setFileMeta(meta);
    }
  }

  // -- Pending queue --------------------------------------------------------

  private queue(
    opType: OperationType,
    filePath: string,
    newPath: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.operationLog.enqueueOperation(this.binding.id, {
      opType,
      filePath,
      newPath,
      payload,
    });
  }

  /**
   * Replay every pending operation for this binding via the shared
   * `flushPendingQueue` helper from `reconnect.ts`. Splitting the loop
   * out of the engine lets us reuse the same drain machinery from a
   * future "Sync now" command.
   */
  private async flushPendingOperations(): Promise<void> {
    const emit: PendingEmitter = (op) => this.replayPending(op);
    await flushPendingQueue(this.binding.id, this.operationLog, emit);
  }

  private async replayPending(op: {
    opType: OperationType;
    filePath: string;
    newPath: string | null;
    payload: Record<string, unknown>;
  }): Promise<ReplayOutcome> {
    try {
      switch (op.opType) {
        case 'CREATE': {
          if (!(await this.vault.exists(op.filePath))) {
            // The file was deleted locally before we managed to flush —
            // dropping the op is the right thing.
            return { ok: false, retryable: false, error: 'local_file_missing' };
          }
          const data = await this.vault.readBinary(op.filePath);
          // Hash the bytes we're *actually* sending, not the stale
          // `payload.contentHash` captured at enqueue time. A file created
          // then edited while offline enqueues several CREATEs whose
          // payload hashes diverge; replaying those stale hashes makes the
          // server see "same path, different hash" and conflict-rename
          // every retry. A fresh hash matches the bytes, so the server's
          // idempotent-replay path collapses the duplicates instead.
          const fileType = (op.payload['fileType'] as FileType) ?? classifyFileType(op.filePath);
          const contentHash = await sha256Hex(data);
          const ack = await this.socket.emitFileCreate({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            filePath: op.filePath,
            fileType,
            contentHash,
            size: data.byteLength,
            data,
          });
          if (ack.ok) {
            // Keep `fileIndex` authoritative so the initial-push pass that
            // runs right after the drain skips this file instead of
            // re-uploading it.
            const outcome = (ack as { outcome?: { fileId?: string; path?: string } }).outcome;
            if (outcome?.fileId && outcome?.path) {
              this.recordCreatedFile(
                outcome.fileId,
                outcome.path,
                fileType,
                contentHash,
                data.byteLength,
              );
            }
          }
          return ackToOutcome(ack);
        }
        case 'UPDATE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          const data = await this.vault.readBinary(op.filePath);
          // Hash the bytes being sent, not the stale enqueue-time snapshot
          // — same reasoning as the CREATE case above.
          const contentHash = await sha256Hex(data);
          const ack = await this.socket.emitFileUpdateBinary({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            contentHash,
            size: data.byteLength,
            data,
          });
          if (ack.ok) {
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) {
              meta.contentHash = contentHash;
              meta.size = data.byteLength;
              this.operationLog.setFileMeta(meta);
            }
          }
          return ackToOutcome(ack);
        }
        case 'DELETE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId) return { ok: false, retryable: false, error: 'no_file_id' };
          const ack = await this.socket.emitFileDelete({
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
          });
          if (ack.ok) {
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) this.fileIndex.byPath.delete(meta.relativePath);
            this.fileIndex.byId.delete(fileId);
            this.operationLog.deleteFileMeta(this.binding.id, op.filePath);
          }
          return ackToOutcome(ack);
        }
        case 'RENAME':
        case 'MOVE': {
          const fileId = String(op.payload['fileId'] ?? '');
          if (!fileId || !op.newPath) {
            return { ok: false, retryable: false, error: 'missing_target' };
          }
          const newPath = op.newPath;
          const event =
            op.opType === 'RENAME' ? this.socket.emitFileRename : this.socket.emitFileMove;
          const ack = await event.call(this.socket, {
            projectId: this.binding.projectId,
            clientId: this.clientId,
            vectorClock: this.bumpClock(),
            fileId,
            filePath: op.filePath,
            newPath,
          });
          if (ack.ok) {
            // Move the index entry so the post-drain initial-push pass
            // recognises the file at its new path instead of re-uploading
            // it. If the server actually conflict-renamed (a genuine
            // concurrent rename onto the same target), the broadcast
            // `renamed` event reconciles `fileIndex` to the real path
            // afterwards.
            const meta = this.fileIndex.byId.get(fileId);
            if (meta) {
              this.operationLog.deleteFileMeta(this.binding.id, meta.relativePath);
              this.fileIndex.byPath.delete(meta.relativePath);
              meta.relativePath = newPath;
              this.fileIndex.byPath.set(newPath, meta);
              this.operationLog.setFileMeta(meta);
            }
          }
          return ackToOutcome(ack);
        }
      }
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  /**
   * Compare local file metadata against the server's authoritative list.
   * Used by the long-offline catch-up flow (`tasks.md` 8.3) and exposed
   * for the future "Deep sync" command (Stage 10).
   */
  async runDeepSyncDiff(): Promise<DeepSyncDiff> {
    return computeDeepSyncDiff(
      this.binding.id,
      this.binding.projectId,
      this.api,
      this.operationLog,
    );
  }

  // -- Misc internals -------------------------------------------------------

  private bumpClock(): VectorClock {
    this.vectorClock = increment(this.vectorClock, this.clientId);
    return this.vectorClock;
  }

  private persistVectorClock(): void {
    this.operationLog.updateLastVectorClock(this.binding.id, this.vectorClock);
  }

  private setStatus(status: EngineStatus, detail?: string): void {
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status, detail);
      } catch {
        // swallow
      }
    }
  }
}

// -- Local helpers ------------------------------------------------------------

function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k] ?? 0;
    if (v > cur) out[k] = v;
  }
  return out;
}

/**
 * Translate the socket ack ({ ok: true } | { ok: false, error }) into the
 * `ReplayOutcome` shape that `flushPendingQueue` expects. We classify
 * server errors heuristically: `*_not_found` is non-retryable (the op no
 * longer makes sense), everything else is retryable (transient).
 */
function ackToOutcome(ack: { ok: true } | { ok: false; error: string }): ReplayOutcome {
  if (ack.ok) return { ok: true };
  const error = ack.error;
  const retryable = !error.endsWith('_not_found') && error !== 'forbidden';
  return { ok: false, retryable, error };
}
