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
}

export type PersistenceFactory = (name: string, doc: Y.Doc) => DocPersistence | null;

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

function defaultDbName(bindingId: string, filePath: string): string {
  // IndexedDB names are case-sensitive but otherwise free-form; we still
  // prefer slash-free, predictable identifiers for grep-ability in DevTools.
  const slug = filePath.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `team-vault-${bindingId}-${slug}`;
}

export class DocManager {
  private readonly persistenceFactory: PersistenceFactory;
  private readonly dbName: (bindingId: string, filePath: string) => string;
  private readonly cache = new Map<string, ManagedEntry>();

  constructor(options: DocManagerOptions = {}) {
    this.persistenceFactory = options.persistenceFactory ?? (() => null);
    this.dbName = options.dbName ?? defaultDbName;
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
}
