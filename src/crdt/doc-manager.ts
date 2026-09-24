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
/** A note's history carried to its new name — see {@link DocManager.move}. */
const MOVE_ORIGIN = Symbol('team-vault-move');

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
  /**
   * y-indexeddb's small key/value store, kept in the doc's own database next
   * to its updates. The owner stamp lives there (see {@link DocManager.open}),
   * so it goes wherever the database goes and is deleted with it. A backend
   * without it keeps the owner in memory only.
   */
  get?(key: string): Promise<unknown>;
  set?(key: string, value: string): Promise<unknown>;
}

/** Key of the owner stamp in {@link DocPersistence.get} / `set`. */
const OWNER_KEY = 'team-vault-file-id';

/**
 * How long a listing of database names is reused (see
 * {@link DocManager.move}): a folder renamed on the server arrives as one
 * rename per file, and each would otherwise list every database of every
 * vault on the machine again.
 */
const DB_LIST_TTL_MS = 2_000;

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
  /** `null` for an in-memory doc, or while {@link ready} is pending. */
  persistence: DocPersistence | null;
  /** Stored handler so we can unbind on release. */
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  /**
   * Id of the file whose history this doc holds: `null` while unknown — a
   * store nobody has opened for a file yet, or one written before 0.3.8.
   */
  owner: string | null;
  /** Reading the owner stamp from the store, once it has loaded. */
  ownerRead: Promise<void> | null;
  /**
   * Pending while the database under this name is still being deleted (see
   * {@link DocManager.clear}): the persistence is created once it is gone, so
   * a new doc never loads the old one's history.
   */
  ready: Promise<void> | null;
  /** {@link ready} has not run yet: no persistence was created. */
  waiting: boolean;
  /** Dropped from the cache: a deferred persistence is not created any more. */
  dead: boolean;
}

/** What {@link DocManager.open} found under the name. */
export interface OpenResult {
  /** The history there was not the file's: deleted, and the doc started anew. */
  discarded: boolean;
  /** Whose that history was, by its stamp; `null` when it had none. */
  owner: string | null;
}

const KEPT: OpenResult = { discarded: false, owner: null };

/** What {@link DocManager.move} found and did. */
export interface MoveResult {
  /** The history under the old name was carried to the new one. */
  carried: boolean;
  /**
   * The old name had a store that did not load in time: whatever it held
   * stayed behind.
   */
  lost: boolean;
  /**
   * The history under the old name belonged to another file, by its stamp:
   * not carried, deleted with the old name.
   */
  foreign: string | null;
  /** A history of another file sat under the new name and was deleted. */
  displaced: string | null;
}

/** Origins whose updates never go out as local edits. */
const SILENT_ORIGINS: ReadonlySet<unknown> = new Set([REMOTE_ORIGIN, MOVE_ORIGIN]);

/** Shared root of every y-indexeddb database name this plugin creates. */
const DB_PREFIX = 'team-vault-';

/** Cap on waiting for a persistence backend to load (see {@link DocManager.whenSynced}). */
const WHEN_SYNCED_TIMEOUT_MS = 10_000;

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
  /** Подписчики на «в этом биндинге появился документ», см. {@link onDocAcquired}. */
  private readonly acquiredSubs = new Map<string, Set<(filePath: string) => void>>();
  /**
   * Local-update subscribers, by cache key. Kept apart from the entries: a
   * doc started anew under the same name (see {@link open}) keeps them, and a
   * doc carried to a new name (see {@link move}) takes them along.
   */
  private readonly localSubs = new Map<string, Set<(update: Uint8Array) => void>>();
  /** Databases being deleted by {@link clear}, by cache key. */
  private readonly clearing = new Map<string, Promise<void>>();
  /** {@link open} and {@link move} runs, chained per cache key. */
  private readonly opening = new Map<string, Promise<unknown>>();
  /** Database names this manager opened; see {@link mayHaveStore}. */
  private readonly opened = new Set<string>();
  /** A recent listing of database names; see {@link DB_LIST_TTL_MS}. */
  private dbList: { at: number; names: Promise<Set<string> | null> } | null = null;

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
    // `toJSON()` is `toString()` under a name the typings declare.
    return entry.ytext.toJSON();
  }

  /**
   * True when the doc holds at least one integrated op — i.e. it has been
   * hydrated from the server (catch-up / seed broadcast), loaded from the
   * offline store, or locally edited. An op-less doc for a file the server
   * already has content for is a red flag for the engine: diffing the full
   * file text into it would create a SECOND, independent insertion of the
   * same content, and the CRDT merge with the server's copy keeps both
   * (the "doubled file" corruption).
   */
  hasState(bindingId: string, filePath: string): boolean {
    const entry = this.acquire(bindingId, filePath);
    return entry.doc.store.clients.size > 0;
  }

  /**
   * True while the doc sits on remote updates it could not integrate yet
   * (out-of-order delivery — Yjs parks them until the missing ops arrive).
   * The doc's visible text is a stale subset in that window; snapshotting
   * it to disk would roll the file back.
   */
  hasPendingRemoteUpdates(bindingId: string, filePath: string): boolean {
    const entry = this.acquire(bindingId, filePath);
    return entry.doc.store.pendingStructs !== null;
  }

  /**
   * Resolve once the doc's persistence backend (y-indexeddb) has loaded its
   * stored state into the `Y.Doc`. The engine MUST await this before using
   * a doc for catch-up or disk snapshots: persistence loads asynchronously,
   * and a doc observed before `whenSynced` looks empty — merging server
   * state into it and writing the result to disk rolls the file back to a
   * local-history-less view. No-op for in-memory docs. Guarded by a timeout
   * so a wedged IndexedDB degrades to the old behavior instead of stalling
   * every snapshot forever.
   */
  async whenSynced(bindingId: string, filePath: string): Promise<void> {
    await this.settle(this.acquire(bindingId, filePath));
  }

  /**
   * {@link whenSynced}, and make sure the history in the doc is that of file
   * `fileId`. Docs and their stores are kept by path, and a path changes
   * hands: a note renamed away, deleted, a new one created under its name. The
   * engine moves or deletes a doc at each of those steps (see {@link move},
   * {@link clear}); this is the check behind them, for a step cut short (the
   * app quit between two writes).
   *
   * The first file to open a doc stamps it with its id, in memory and in the
   * store. A doc stamped for another file is deleted and started anew — its
   * subscribers stay — and the result says whose it was, so the caller can
   * stop relying on what it had folded into it. A doc without a stamp is
   * taken as the file's own when `adoptUnstamped` (the default): every store
   * from before 0.3.8 is such a store, and it may hold edits the server has
   * not got yet. Without it, an unstamped history is discarded like another
   * file's — see {@link claimStored}. A store that did not load in time is
   * used as it is, unstamped, the way docs were used before.
   */
  open(
    bindingId: string,
    filePath: string,
    fileId: string,
    opts: { adoptUnstamped?: boolean } = {},
  ): Promise<OpenResult> {
    return this.serially([this.cacheKey(bindingId, filePath)], async () => {
      const entry = this.acquire(bindingId, filePath);
      if (!(await this.settle(entry))) return KEPT;
      const owner = entry.owner;
      if (owner === fileId) return KEPT;
      if (owner === null && (opts.adoptUnstamped !== false || !hasHistory(entry.doc))) {
        this.claim(entry, fileId);
        return KEPT;
      }
      await this.clear(bindingId, filePath, { keepSubscribers: true });
      const fresh = this.acquire(bindingId, filePath, false);
      await this.settle(fresh);
      this.claim(fresh, fileId);
      return { discarded: true, owner };
    });
  }

  /**
   * {@link open} for a file this device has no record of under `filePath` —
   * new to it there. A history under that name is then not the file's,
   * stamped or not, unless it is stamped for this very file: a build before
   * 0.3.8 left the history of a note renamed or deleted away under its old
   * name, unstamped, and the next note under the name took it for its own —
   * mixed text, pushed to the whole team.
   *
   * Opens a store only when the renderer lists one under the name (or the
   * doc is cached): a first sync opens no store at all, and a runtime that
   * can't list databases skips the check rather than open one per file.
   * `null` when nothing was opened.
   */
  async claimStored(
    bindingId: string,
    filePath: string,
    fileId: string,
  ): Promise<OpenResult | null> {
    const name = this.dbName(bindingId, filePath);
    if (!this.cache.has(this.cacheKey(bindingId, filePath)) && !this.opened.has(name)) {
      const names = await this.listedNames();
      if (names === null || !names.has(name)) return null;
    }
    return this.open(bindingId, filePath, fileId, { adoptUnstamped: false });
  }

  /**
   * Id of the file the cached doc at `filePath` holds the history of (see
   * {@link open}); `null` when unknown or not cached.
   */
  ownerOf(bindingId: string, filePath: string): string | null {
    return this.cache.get(this.cacheKey(bindingId, filePath))?.owner ?? null;
  }

  /**
   * Delete the doc at `filePath` and its store: no file's history is under
   * this name any more. Only this one database, by its exact name — never an
   * enumeration: IndexedDB is one store for every vault on the machine. A doc
   * acquired for the name meanwhile starts from nothing: its store is opened
   * once the old one is gone. Local-update subscribers go too, unless
   * `keepSubscribers`.
   */
  async clear(
    bindingId: string,
    filePath: string,
    opts: { keepSubscribers?: boolean } = {},
  ): Promise<void> {
    const key = this.cacheKey(bindingId, filePath);
    if (!opts.keepSubscribers) this.localSubs.delete(key);
    const name = this.dbName(bindingId, filePath);
    // One delete at a time per name: a store reopened while an earlier delete
    // has not reached IndexedDB yet would load the old history.
    const earlier = this.clearing.get(key);
    const run = (async (): Promise<void> => {
      if (earlier) await earlier;
      if (!(await this.clearCached(bindingId, filePath))) await this.deleteDb(name);
      this.opened.delete(name);
    })();
    const settled = run.catch(() => undefined);
    this.clearing.set(key, settled);
    try {
      await run;
    } finally {
      if (this.clearing.get(key) === settled) this.clearing.delete(key);
    }
  }

  /**
   * Carry the history of the doc at `from` to `to`, where file `owner` is
   * now, and delete the store under `from`: that name is free for the next
   * file. Whatever another file left under `to` is deleted first; a history of
   * `owner` already there (a move cut short before) is kept, and the one from
   * `from` merged into it.
   *
   * The history is applied as an update — the same operations, never a text
   * rebuilt from the old doc: a second, independent history of the same text
   * is what doubled notes on the server. A history `from` holds for another
   * file is not carried. Local-update subscribers move along with the doc.
   *
   * `switchOver` runs right after the history has landed under `to`, in the
   * same synchronous step: the caller moves its own records there, so a
   * remote update arriving meanwhile finds the file under one name or the
   * other, and never lands on a doc about to be deleted.
   */
  move(
    bindingId: string,
    from: string,
    to: string,
    owner: string,
    switchOver: () => void,
  ): Promise<MoveResult> {
    const fromKey = this.cacheKey(bindingId, from);
    const toKey = this.cacheKey(bindingId, to);
    return this.serially([fromKey, toKey], async () => {
      const result: MoveResult = { carried: false, lost: false, foreign: null, displaced: null };
      if (from === to) {
        switchOver();
        result.carried = true;
        return result;
      }
      let source = this.cache.get(fromKey) ?? null;
      if (source === null && (await this.mayHaveStore(bindingId, from))) {
        source = this.acquire(bindingId, from, false);
      }
      if (source !== null) {
        if (!(await this.settle(source))) result.lost = true;
        else if (source.owner !== null && source.owner !== owner) result.foreign = source.owner;
      }
      let target = this.cache.get(toKey) ?? null;
      if (target === null && (await this.mayHaveStore(bindingId, to))) {
        target = this.acquire(bindingId, to, false);
      }
      // Ours already: a move stopped after the history had landed here. A
      // store without a stamp is not taken for ours — it may be what a build
      // before 0.3.8 left under the name when another file moved away.
      const kept = target !== null && (await this.settle(target)) && target.owner === owner;
      if (!kept) {
        if (target !== null && target.owner !== null) result.displaced = target.owner;
        await this.clear(bindingId, to);
        target = null;
      }
      const carry = !result.lost && result.foreign === null && source !== null;
      if (carry && target === null) {
        target = this.acquire(bindingId, to, false);
        await this.settle(target);
      }
      // Synchronous from here to `switchOver`: nothing lands on the old doc
      // after its state was taken. (Remote updates for the file keep landing
      // on it while the awaits above yield, so its history is read only now.)
      const current = this.cache.get(fromKey);
      const landed =
        carry && current === source && target !== null && this.cache.get(toKey) === target;
      if (landed && target && current && hasHistory(current.doc)) {
        Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(current.doc), MOVE_ORIGIN);
      }
      result.carried = landed || kept;
      // Stamped before the old store goes: cut short in between, the history
      // is found here, as the file's own.
      if (result.carried && target) this.claim(target, owner);
      const subs = this.localSubs.get(fromKey);
      this.localSubs.delete(fromKey);
      if (subs) this.localSubs.set(toKey, subs);
      else if (!kept) this.localSubs.delete(toKey);
      switchOver();
      if (source !== null || this.cache.has(fromKey)) await this.clear(bindingId, from);
      return result;
    });
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
  /**
   * Подписка на появление документа в биндинге: колбэк зовётся, когда для
   * файла впервые создаётся `Y.Doc` (и его база `y-indexeddb`).
   *
   * Нужна, чтобы навешивать отправку локальных правок **лениво**. Раньше
   * движок после каждого `project:join` проходил по всем файлам проекта и звал
   * `onLocalUpdate`, а тот создаёт документ — то есть поднимал `Y.Doc` и
   * отдельную базу IndexedDB на КАЖДЫЙ файл. На вальте в 1062 файла это
   * блокировало поток интерфейса и приводило к лайвлоку переподключений
   * (инцидент 2026-08-06). Теперь подписка навешивается на те документы,
   * которые действительно понадобились.
   */
  onDocAcquired(bindingId: string, cb: (filePath: string) => void): () => void {
    let subs = this.acquiredSubs.get(bindingId);
    if (!subs) {
      subs = new Set();
      this.acquiredSubs.set(bindingId, subs);
    }
    subs.add(cb);
    return () => {
      subs?.delete(cb);
      if (subs && subs.size === 0) this.acquiredSubs.delete(bindingId);
    };
  }

  onLocalUpdate(bindingId: string, filePath: string, cb: (update: Uint8Array) => void): () => void {
    this.acquire(bindingId, filePath);
    const key = this.cacheKey(bindingId, filePath);
    let subs = this.localSubs.get(key);
    if (!subs) {
      subs = new Set();
      this.localSubs.set(key, subs);
    }
    subs.add(cb);
    // The set itself, not the key: a doc carried to another name takes it along.
    const own = subs;
    return () => {
      own.delete(cb);
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
    this.localSubs.delete(key);
    entry.dead = true;
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
   *
   * Always scoped to ONE named binding, never "everything we don't know":
   * Obsidian keeps IndexedDB in a single store shared by every vault on the
   * machine, so an enumeration filtered only by what *this* vault knows would
   * delete other vaults' live stores (0.2.12–0.3.0 did exactly that).
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

  /**
   * Wait for the entry's store to load and its owner stamp to be read. `false`
   * when the store did not load in time: the doc is then used as it is.
   */
  private async settle(entry: ManagedEntry): Promise<boolean> {
    if (entry.ready) await entry.ready;
    const persistence = entry.persistence;
    if (!persistence) return true;
    let timer: number | undefined;
    let synced = false;
    try {
      await Promise.race([
        persistence.whenSynced.then(() => {
          synced = true;
        }),
        new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, WHEN_SYNCED_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    if (!synced) return false;
    entry.ownerRead ??= this.readOwner(entry, persistence);
    await entry.ownerRead;
    return true;
  }

  private async readOwner(entry: ManagedEntry, persistence: DocPersistence): Promise<void> {
    if (!persistence.get) return;
    try {
      const stamp = await persistence.get(OWNER_KEY);
      // A stamp set while this one was being read is newer.
      if (entry.owner === null && typeof stamp === 'string' && stamp !== '') entry.owner = stamp;
    } catch {
      // Unreadable: the owner stays unknown.
    }
  }

  /**
   * Stamp the entry as the history of `fileId`, in memory at once and in its
   * store in the background: a write that never lands (a wedged IndexedDB)
   * must not hold up the flow that opened the doc. Best-effort — a store
   * without the stamp stays unknown, as a store from before 0.3.8 is.
   */
  private claim(entry: ManagedEntry, fileId: string): void {
    entry.owner = fileId;
    void (async (): Promise<void> => {
      await entry.ready;
      const persistence = entry.persistence;
      if (entry.dead || !persistence?.set) return;
      await persistence.set(OWNER_KEY, fileId);
    })().catch(() => undefined);
  }

  /** Run `task` after every earlier {@link open} / {@link move} on any of `keys`. */
  private serially<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    const earlier = keys.map((key) => this.opening.get(key)).filter((p) => p !== undefined);
    const run = Promise.allSettled(earlier).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    for (const key of keys) this.opening.set(key, tail);
    void tail.then(() => {
      for (const key of keys) if (this.opening.get(key) === tail) this.opening.delete(key);
    });
    return run;
  }

  /**
   * Whether a store may exist under `filePath`: one this manager opened, or a
   * name in the renderer's list of databases. A runtime that can't list them
   * is taken to have one — opening a store that isn't there costs an empty
   * database, which the caller deletes again.
   */
  private async mayHaveStore(bindingId: string, filePath: string): Promise<boolean> {
    const name = this.dbName(bindingId, filePath);
    if (this.opened.has(name)) return true;
    const names = await this.listedNames();
    return names === null || names.has(name);
  }

  /**
   * The renderer's database names, reused for {@link DB_LIST_TTL_MS}; `null`
   * when it lists none — a runtime that can't list them.
   */
  private listedNames(): Promise<Set<string> | null> {
    const now = Date.now();
    if (!this.dbList || now - this.dbList.at > DB_LIST_TTL_MS) {
      this.dbList = {
        at: now,
        names: this.listDbs().then((names) => (names.length === 0 ? null : new Set(names))),
      };
    }
    return this.dbList.names;
  }

  /**
   * `notify: false` for docs the manager opens for itself ({@link open},
   * {@link move}): the engine wires a doc to a file only once it knows which
   * file that is.
   */
  private acquire(bindingId: string, filePath: string, notify = true): ManagedEntry {
    const key = this.cacheKey(bindingId, filePath);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    const entry: ManagedEntry = {
      doc,
      ytext,
      persistence: null,
      updateHandler: () => undefined,
      owner: null,
      ownerRead: null,
      ready: null,
      waiting: false,
      dead: false,
    };
    entry.updateHandler = (update: Uint8Array, origin: unknown): void => {
      if (SILENT_ORIGINS.has(origin)) return;
      // The store loading its history (y-indexeddb applies it with itself as
      // the origin). What it holds reaches the server through the catch-up's
      // push-back, which sends only what the server lacks — and only once the
      // engine has checked whose history it is (see `open`). Fanned out here,
      // a store another file left under this name went out as this file's
      // edits the moment it loaded.
      if (origin !== null && origin === entry.persistence) return;
      const subs = this.localSubs.get(key);
      if (!subs) return;
      for (const cb of subs) {
        try {
          cb(update);
        } catch {
          // Listener errors must not break the doc — Stage 7 logs explicitly.
        }
      }
    };
    doc.on('update', entry.updateHandler);

    const name = this.dbName(bindingId, filePath);
    const openStore = (): void => {
      entry.persistence = this.persistenceFactory(name, doc);
      if (entry.persistence) this.opened.add(name);
    };
    const clearing = this.clearing.get(key);
    if (clearing) {
      entry.waiting = true;
      entry.ready = clearing.then(() => {
        entry.waiting = false;
        if (!entry.dead) openStore();
      });
    } else {
      openStore();
    }

    this.cache.set(key, entry);
    if (!notify) return entry;
    // Оповещаем ПОСЛЕ записи в кэш: подписчик может звать `onLocalUpdate` на
    // этот же путь, и тот должен найти готовую запись, а не создать вторую.
    const subs = this.acquiredSubs.get(bindingId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(filePath);
        } catch {
          // Ошибка подписчика не должна ломать создание документа.
        }
      }
    }
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
    entry.dead = true;
    entry.doc.off('update', entry.updateHandler);
    if (entry.waiting) {
      // Its persistence waits on a delete still running — perhaps the very
      // one this call is part of, so it is not waited for: once dead, the
      // entry never creates it. The caller deletes the database by name.
      entry.doc.destroy();
      return false;
    }
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

/** Whether a doc holds any integrated operation. */
function hasHistory(doc: Y.Doc): boolean {
  return doc.store.clients.size > 0;
}
