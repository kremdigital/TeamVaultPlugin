import { IndexeddbPersistence } from 'y-indexeddb';

/**
 * The object stores of a y-indexeddb database (y-indexeddb 9.0.12,
 * `src/y-indexeddb.js`): the doc's updates, one per transaction, and the small
 * key/value area `get` / `set` use.
 */
const UPDATES_STORE = 'updates';
const CUSTOM_STORE = 'custom';

/**
 * Put `value` under `key` in the key/value area of a y-indexeddb database, in
 * a read-write transaction over the updates as well. IndexedDB runs read-write
 * transactions whose scopes overlap in the order they were created: this one
 * commits after every update y-indexeddb was handed before it (each goes in a
 * transaction of its own over the updates, created as the doc changes).
 * `set` takes the key/value area alone, and its write can land before them.
 */
export function putOrdered(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([UPDATES_STORE, CUSTOM_STORE], 'readwrite');
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('idb_error'));
    tx.onabort = (): void => reject(tx.error ?? new Error('idb_aborted'));
    tx.objectStore(CUSTOM_STORE).put(value, key);
  });
}

/**
 * y-indexeddb's persistence with `setOrdered` (see `DocPersistence.setOrdered`):
 * the mark of a note written to disk must not reach the database before the
 * edits the written text holds. Landed first, a crash in between left a mark
 * of a text the stored history does not have.
 */
export class TeamVaultIdbPersistence extends IndexeddbPersistence {
  setOrdered(key: string, value: string): Promise<void> {
    return this._db.then((db) => putOrdered(db, key, value));
  }
}
