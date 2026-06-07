import * as Y from 'yjs';
import { applyTextDiff } from './text-diff';

/**
 * Per-text-file Y.Doc cache + remote-update plumbing.
 *
 * Stage-5 responsibility: keep one `Y.Doc` per `(bindingId, filePath)`,
 * surface a `Y.Text` named `'content'` for editor binding, and let the
 * sync engine plug in:
 *
 *   - **persistence** — durable storage for the doc; production passes
 *     a `y-indexeddb` factory, tests pass a no-op,
 *   - **local update fan-out** — forward every locally-originated Yjs
 *     update to whoever wants to ship it over the wire (Stage 7),
 *   - **remote update intake** — a marker origin so applying server
 *     updates doesn't echo them back through the local fan-out.
 *
 * The "Yjs document is for text only" detail comes from the spec: binary
 * files are versioned via REST blobs and don't get a Y.Doc.
 */

export const REMOTE_ORIGIN = Symbol('team-vault-remote');
export const DISK_ORIGIN = Symbol('team-vault-disk');
export const EDITOR_ORIGIN = Symbol('team-vault-editor');

/**
 * Minimal contract a persistence backend must satisfy. `y-indexeddb`'s
 * `IndexeddbPersistence` matches it natively; tests pass `null`.
 */
export interface DocPersistence {
  whenSynced: Promise<unknown>;
  destroy(): Promise<void> | void;
  /**
   * Delete the backing data, not just close the connection. y-indexeddb's
   * `clearData()` (which calls `deleteDB`) implements this; an in-memory or
   * test backend with nothing on disk may omit it, in which case
   * {@link DocManager.purgeBinding} falls back to deleting the db by name.
   */
  clearData?(): Promise<void> | void;
}

export type PersistenceFactory = (name: string, doc: Y.Doc) => DocPersistence | null;

/**
 * Enumerate + delete IndexedDB databases by name. {@link DocManager.purgeBinding}
 * uses this to erase a removed binding's y-indexeddb stores — including docs
 * never opened this session, which the in-memory cache never saw.
 *
 * The renderer's global `indexedDB` is adapted to this shape in `main.ts`
 * (it references browser globals that don't belong in this env-agnostic
 * module); tests inject a fake. The default is a no-op, so a `DocManager`
 * built without one simply skips the on-disk delete.
 */
export interface IdbRegistry {
  /** Names of every database visible to the renderer; `[]` if unsupported. */
  list(): Promise<string[]>;
  /** Delete one database by name. Resolves when gone (best-effort). */
  delete(name: string): Promise<void>;
}

const NOOP_IDB: IdbRegistry = {
  list: () => Promise.resolve([]),
  delete: () => Promise.resolve(),
};

export interface DocManagerOptions {
  /**
   * Build a persistence layer for a freshly created doc, or return `null`
   * for an in-memory-only doc (tests + first connection in offline mode).
   */
  persistenceFactory?: PersistenceFactory;
  /**
   * Database-name builder. Defaults to `team-vault-{bindingId}-{slug}`,
   * where slug is a URL-safe encoding of the file path. Exposed so tests
   * can verify naming, and so future schema bumps can prefix differently.
   */
  dbName?: (bindingId: string, filePath: string) => string;
  /**
   * Prefix shared by every database of a binding — defaults to
   * `team-vault-{bindingId}-`. Must stay consistent with {@link dbName};
   * {@link DocManager.purgeBinding} enumerates a binding's stores by it.
   */
  dbPrefix?: (bindingId: string) => string;
  /**
   * IndexedDB enumerate/delete seam used by {@link DocManager.purgeBinding}
   * to drop a removed binding's offline stores. Production injects a registry
   * backed by the renderer's `indexedDB`; tests inject a fake. Defaults to a
   * no-op (skips the on-disk delete).
   */
  idb?: IdbRegistry;
}

/** Internal entry kept in the cache. */
interface ManagedEntry {
  doc: Y.Doc;
  ytext: Y.Text;
  persistence: DocPersistence | null;
  /** Subscriber set for local-origin updates. */
  localSubs: Set<(update: Uint8Array) => void>;
  /** Stored handler so we can unbind on release. */
  updateHandler: (update: Uint8Array, origin: unknown) => void;
}

const REMOTE_ORIGINS: ReadonlySet<unknown> = new Set([REMOTE_ORIGIN]);

/** Shared root of every y-indexeddb database name this plugin creates. */
const DB_PREFIX = 'team-vault-';

function defaultDbName(bindingId: string, filePath: string): string {
  // The database name MUST be a lossless, injective function of the file
  // path. The previous slug — `filePath.replace(/[^a-zA-Z0-9._-]+/g, '_')` —
  // replaced every non-ASCII char (all Cyrillic/CJK letters) AND `/` with
  // `_`, so distinct non-ASCII paths collapsed onto ONE database name
  // (`персонажи/андрей-перминов.md` and `персонажи/иван-воренок.md` both →
  // `_-_.md`). Files sharing an offline store accumulate each other's Y.Doc
  // content — catastrophic content-mixing corruption on any non-Latin vault.
  //
  // `encodeURIComponent` is injective (distinct paths → distinct names),
  // synchronous, and keeps ASCII paths readable for DevTools grep while
  // percent-escaping `/` and every non-ASCII byte. IndexedDB names are
  // free-form DOMStrings, so `%`-escapes are valid.
  return `${defaultDbPrefix(bindingId)}${encodeURIComponent(filePath)}`;
}

/**
 * Prefix common to all of a binding's databases. The trailing `-` keeps
 * binding ids from colliding by prefix (e.g. `b1` vs `b10`) when
 * {@link DocManager.purgeBinding} filters enumerated database names.
 */
function defaultDbPrefix(bindingId: string): string {
  return `${DB_PREFIX}${bindingId}-`;
}

export class DocManager {
  private readonly persistenceFactory: PersistenceFactory;
  private readonly dbName: (bindingId: string, filePath: string) => string;
  private readonly dbPrefix: (bindingId: string) => string;
  private readonly idb: IdbRegistry;
  private readonly cache = new Map<string, ManagedEntry>();

  constructor(options: DocManagerOptions = {}) {
    this.persistenceFactory = options.persistenceFactory ?? (() => null);
    this.dbName = options.dbName ?? defaultDbName;
    this.dbPrefix = options.dbPrefix ?? defaultDbPrefix;
    this.idb = options.idb ?? NOOP_IDB;
  }

  /**
   * Return the cached entry for the path, creating it on first access.
   * The returned `Y.Doc` carries a `Y.Text` named `'content'` — that's
   * the canonical editor target.
   */
  get(bindingId: string, filePath: string): { doc: Y.Doc; ytext: Y.Text } {
    const entry = this.acquire(bindingId, filePath);
    return { doc: entry.doc, ytext: entry.ytext };
  }

  /**
   * Replace the document text via a minimal diff. Used when the file is
   * mutated outside the editor (an external agent or a chunked download
   * applied during catch-up sync).
   *
   * Origin defaults to {@link DISK_ORIGIN} so subscribers can choose
   * whether to ship the resulting update upstream.
   */
  setText(
    bindingId: string,
    filePath: string,
    content: string,
    origin: unknown = DISK_ORIGIN,
  ): void {
    const entry = this.acquire(bindingId, filePath);
    applyTextDiff(entry.ytext, content, origin);
  }

  /** Read the document contents synchronously. */
  getText(bindingId: string, filePath: string): string {
    const entry = this.acquire(bindingId, filePath);
    return entry.ytext.toString();
  }

  /**
   * Apply a Yjs update from the server. Tagged with {@link REMOTE_ORIGIN}
   * so {@link onLocalUpdate} subscribers don't echo it back upstream.
   */
  applyRemoteUpdate(bindingId: string, filePath: string, update: Uint8Array): void {
    const entry = this.acquire(bindingId, filePath);
    Y.applyUpdate(entry.doc, update, REMOTE_ORIGIN);
  }

  /**
   * Subscribe to local-origin Yjs updates. The callback is *not* invoked
   * for updates whose origin is {@link REMOTE_ORIGIN} — those came from
   * the server and re-broadcasting them would trip an echo loop.
   *
   * Returns an unsubscribe function.
   */
  onLocalUpdate(bindingId: string, filePath: string, cb: (update: Uint8Array) => void): () => void {
    const entry = this.acquire(bindingId, filePath);
    entry.localSubs.add(cb);
    return () => {
      entry.localSubs.delete(cb);
    };
  }

  /**
   * Take a snapshot of the doc as a Yjs update. Pass `targetStateVector`
   * (the output of `Y.encodeStateVector` on the remote peer's doc) to get
   * back only the ops the target is missing — used by the engine on
   * reconnect to push local offline edits to the server.
   *
   * Without a target vector, returns the full state of the doc.
   */
  encodeStateAsUpdate(
    bindingId: string,
    filePath: string,
    targetStateVector?: Uint8Array,
  ): Uint8Array {
    const entry = this.acquire(bindingId, filePath);
    return Y.encodeStateAsUpdate(entry.doc, targetStateVector);
  }

  /** Whether this manager has an entry for the given key. */
  has(bindingId: string, filePath: string): boolean {
    return this.cache.has(this.cacheKey(bindingId, filePath));
  }

  /**
   * Drop an entry: destroy the persistence (closes the IDB connection
   * but does NOT delete data — the doc may be reopened later) and free
   * the in-memory `Y.Doc`.
   */
  async release(bindingId: string, filePath: string): Promise<void> {
    const key = this.cacheKey(bindingId, filePath);
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    entry.doc.off('update', entry.updateHandler);
    if (entry.persistence) {
      await entry.persistence.destroy();
    }
    entry.doc.destroy();
  }

  /** Drop all entries for a binding (useful when the binding is removed). */
  async releaseBinding(bindingId: string): Promise<void> {
    const prefix = `${bindingId}::`;
    const pending: Array<Promise<void>> = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        const filePath = key.slice(prefix.length);
        pending.push(this.release(bindingId, filePath));
      }
    }
    await Promise.all(pending);
  }

  /**
   * Delete (not just close) every y-indexeddb database belonging to a binding,
   * including docs never loaded this session — the in-memory cache never saw
   * those, so {@link releaseBinding} can't reach them. Call when a binding is
   * removed from settings: `release` / `releaseBinding` only close the
   * IndexedDB connection, leaking the on-disk data (the CRDT analogue of the
   * operation-log `purgeBinding`).
   *
   * Cached (open) docs are cleared through their persistence (`clearData`,
   * which closes the handle *and* deletes the db). The rest are found by
   * enumerating the binding's `team-vault-{id}-` databases and deleting each
   * by name. `knownPaths` — file paths from `OperationLog.listFileMeta`,
   * captured BEFORE the log rows are purged — are a fallback for runtimes
   * whose IndexedDB can't enumerate databases.
   *
   * Best-effort and idempotent: per-db failures are swallowed (the startup
   * sweep retries). Returns the database names actually deleted.
   */
  async purgeBinding(bindingId: string, knownPaths: readonly string[] = []): Promise<string[]> {
    const deleted = new Set<string>();

    // 1. Cached docs hold the only live IndexedDB connections. Clear each
    //    through its persistence (clearData = close + delete); closing first
    //    is required so the deletes in step 3 aren't blocked by an open handle.
    const cachePrefix = `${bindingId}::`;
    const cachedPaths: string[] = [];
    for (const key of [...this.cache.keys()]) {
      if (!key.startsWith(cachePrefix)) continue;
      const filePath = key.slice(cachePrefix.length);
      cachedPaths.push(filePath);
      if (await this.clearCached(bindingId, filePath)) {
        deleted.add(this.dbName(bindingId, filePath));
      }
    }

    // 2. Collect every other candidate name: enumerated by prefix
    //    (authoritative — covers docs never opened this session, the common
    //    case when deleting a binding), plus names derived from knownPaths and
    //    the just-closed cached paths as a fallback when enumeration is absent.
    const candidates = new Set<string>();
    for (const path of knownPaths) candidates.add(this.dbName(bindingId, path));
    for (const path of cachedPaths) candidates.add(this.dbName(bindingId, path));
    const prefix = this.dbPrefix(bindingId);
    for (const name of await this.listDbs()) {
      if (name.startsWith(prefix)) candidates.add(name);
    }

    // 3. Delete each candidate by name (a no-op if clearData already erased it).
    for (const name of candidates) {
      if (deleted.has(name)) continue;
      if (await this.deleteDb(name)) deleted.add(name);
    }

    return [...deleted];
  }

  /** Drop everything. Idempotent. */
  async destroy(): Promise<void> {
    const keys = [...this.cache.keys()];
    await Promise.all(
      keys.map((key) => {
        const sep = key.indexOf('::');
        if (sep < 0) return Promise.resolve();
        const bindingId = key.slice(0, sep);
        const filePath = key.slice(sep + 2);
        return this.release(bindingId, filePath);
      }),
    );
  }

  // -- internals ------------------------------------------------------------

  private acquire(bindingId: string, filePath: string): ManagedEntry {
    const key = this.cacheKey(bindingId, filePath);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    const localSubs = new Set<(update: Uint8Array) => void>();

    const updateHandler = (update: Uint8Array, origin: unknown): void => {
      if (REMOTE_ORIGINS.has(origin)) return;
      for (const cb of localSubs) {
        try {
          cb(update);
        } catch {
          // Listener errors must not break the doc — Stage 7 logs explicitly.
        }
      }
    };
    doc.on('update', updateHandler);

    const persistence = this.persistenceFactory(this.dbName(bindingId, filePath), doc);

    const entry: ManagedEntry = {
      doc,
      ytext,
      persistence,
      localSubs,
      updateHandler,
    };
    this.cache.set(key, entry);
    return entry;
  }

  private cacheKey(bindingId: string, filePath: string): string {
    return `${bindingId}::${filePath}`;
  }

  /**
   * Evict a cached entry and erase its persisted data via `clearData`. Returns
   * whether the data was actually deleted — `false` when the backend only
   * supports `destroy` (close), so {@link purgeBinding} knows it must still
   * delete the database by name.
   */
  private async clearCached(bindingId: string, filePath: string): Promise<boolean> {
    const key = this.cacheKey(bindingId, filePath);
    const entry = this.cache.get(key);
    if (!entry) return false;
    this.cache.delete(key);
    entry.doc.off('update', entry.updateHandler);
    let cleared = false;
    if (entry.persistence?.clearData) {
      await entry.persistence.clearData();
      cleared = true;
    } else if (entry.persistence) {
      await entry.persistence.destroy();
    } else {
      cleared = true; // in-memory only — nothing on disk to delete.
    }
    entry.doc.destroy();
    return cleared;
  }

  /** Enumerate database names; never throws (returns `[]` on failure). */
  private async listDbs(): Promise<string[]> {
    try {
      return await this.idb.list();
    } catch {
      return [];
    }
  }

  /** Delete one database; never throws (returns `false` on failure). */
  private async deleteDb(name: string): Promise<boolean> {
    try {
      await this.idb.delete(name);
      return true;
    } catch {
      return false;
    }
  }
}
