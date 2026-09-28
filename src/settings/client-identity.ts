import { PREVIOUS_CLIENT_IDS_MAX, type PluginSettings } from './settings';

/**
 * Which client id this vault syncs under, decided once per start before any
 * engine is built.
 *
 * The id lives in `data.json`, and a vault copied to another folder or
 * computer takes `data.json` along: two devices then send their operations
 * under one id. They share one counter in the vector clocks, so an operation
 * of one whose counter the other has reached never comes to the other in a
 * catch-up — an attachment the copy replaced while the original was offline
 * stayed old there for good.
 *
 * So the id is also kept in the vault's local storage in Obsidian
 * (`App.saveLocalStorage`): Obsidian keys it by the vault's id in its vault
 * list (`localStorage.getItem(appId + "-" + key)`, app.js 1.13.7), which a copy
 * opened as a vault of its own — in another folder or on another computer —
 * does not have. `data.json` notes that the id was bound there
 * (`clientIdClaimed`): a vault whose `data.json` says so while its local
 * storage has no id is a copy, and takes a new id.
 *
 * A pair made before this existed, or a whole profile copied along with
 * Obsidian's local storage, the engine finds out when it sees an operation
 * under this vault's id that it did not send (`twinClientId`, see
 * `SyncEngine.reportTwin`): the next start takes a new id then.
 *
 * A new id is harmless to what is synced: the server answers `ops:status` by
 * the user, not by the id, this device knows its operations by their
 * `opId`s, and its counters under the ids it had before move up with its
 * operations as under the new one (`previousClientIds`, see
 * `SyncEngine.adoptOwnCounter`). What it costs is one more key in every
 * vector clock of the project, for good — hence at most one change a day
 * ({@link CLIENT_ID_CHANGE_MIN_INTERVAL_MS}), and an id is bound to the vault
 * only once it is read back from the local storage: Obsidian drops a write
 * that fails (a full storage) without a word, and an id taken for bound then
 * would change on every start.
 */

/** The key of the id in the vault's local storage. */
export const CLIENT_ID_KEY = 'team-vault-client-id';

/**
 * The shortest time between two automatic changes of the id, 24 h. The first
 * id of a vault is not a change.
 */
export const CLIENT_ID_CHANGE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The vault's local storage in Obsidian (`App.loadLocalStorage` / `saveLocalStorage`). */
export interface VaultStore {
  load(key: string): unknown;
  /** `null` removes the key. */
  save(key: string, value: string | null): void;
}

/** The settings this decides. */
export type ClientIdentity = Pick<
  PluginSettings,
  'clientId' | 'clientIdClaimed' | 'twinClientId' | 'clientIdRotatedAt' | 'previousClientIds'
>;

export type IdentityReason =
  /** No id anywhere: a new one. */
  | 'first-run'
  /** The vault's local storage and `data.json` agree. */
  | 'kept'
  /** The first start with a local storage: `data.json`'s id is bound to this vault. */
  | 'claimed'
  /** `data.json` has another id, or none: this vault's own, from its local storage. */
  | 'from-vault-store'
  /** The local storage holds an id this vault has moved on from: `data.json`'s id instead. */
  | 'store-outdated'
  /** `data.json`'s id was bound to a vault, and not to this one: a copy. */
  | 'vault-copied'
  /** Another device was seen sending under this vault's id. */
  | 'twin-seen'
  /** No local storage to go by (Obsidian before 1.8.7, or duplicate plugin folders). */
  | 'no-store'
  /** A change the last one came too early for (see {@link CLIENT_ID_CHANGE_MIN_INTERVAL_MS}). */
  | 'deferred';

export interface IdentityDecision {
  /** The id to sync under from now on. */
  clientId: string;
  reason: IdentityReason;
  /** A new id replaced one this vault was syncing under. */
  rotated: boolean;
  /**
   * For a change, the id replaced; for `from-vault-store`, the one
   * `data.json` had. `null` otherwise.
   */
  previous: string | null;
  /** Bind `clientId` to this vault: write it to the local storage. */
  claim: boolean;
  /** For `deferred`: the change put off. */
  deferred?: 'vault-copied' | 'twin-seen';
}

export interface IdentityInput {
  current: ClientIdentity;
  /** What the vault's local storage has under {@link CLIENT_ID_KEY}. */
  stored: unknown;
  /** Whether there is a local storage to go by. */
  storeAvailable: boolean;
  now: number;
  newId: () => string;
}

/** An id worth keeping: a string with something in it. */
function usable(id: unknown): id is string {
  return typeof id === 'string' && id.trim() !== '';
}

/** Whether the id changed less than {@link CLIENT_ID_CHANGE_MIN_INTERVAL_MS} ago (or ahead of the clock). */
function changedRecently(at: number, now: number): boolean {
  return at > 0 && Math.abs(now - at) < CLIENT_ID_CHANGE_MIN_INTERVAL_MS;
}

/**
 * Which id this vault syncs under. `D` is `data.json`'s id, `L` the one the
 * vault's local storage has:
 *
 *   1. no `D`: `L`, or a new one (`from-vault-store`, `first-run`);
 *   2. no local storage: `D` (`no-store`);
 *   3. `L` = `D`: `kept`;
 *   4. `L` ≠ `D`: `L` — `data.json` came from elsewhere (`from-vault-store`),
 *      unless this vault has moved on from `L`: `D` then (`store-outdated`);
 *   5. no `L`, `D` never bound: `D`, bound now (`claimed`);
 *   6. no `L`, `D` bound — to another vault: a new id (`vault-copied`).
 *
 * The id so chosen gives way to a new one when another device was seen
 * sending under it (`twin-seen`). A change of either kind waits while the
 * last one is less than a day old (`deferred`).
 */
export function resolveClientIdentity(input: IdentityInput): IdentityDecision {
  const { current, storeAvailable, now, newId } = input;
  const D = usable(current.clientId) ? current.clientId : '';
  const L = storeAvailable && usable(input.stored) ? input.stored : null;

  if (D === '') {
    if (L !== null) {
      return {
        clientId: L,
        reason: 'from-vault-store',
        rotated: false,
        previous: null,
        claim: true,
      };
    }
    return {
      clientId: newId(),
      reason: 'first-run',
      rotated: false,
      previous: null,
      claim: storeAvailable,
    };
  }

  let base: IdentityDecision;
  let copied = false;
  if (!storeAvailable) {
    base = { clientId: D, reason: 'no-store', rotated: false, previous: null, claim: false };
  } else if (L === D) {
    base = { clientId: D, reason: 'kept', rotated: false, previous: null, claim: true };
  } else if (L !== null && !current.previousClientIds.includes(L)) {
    base = { clientId: L, reason: 'from-vault-store', rotated: false, previous: D, claim: true };
  } else if (L !== null) {
    base = { clientId: D, reason: 'store-outdated', rotated: false, previous: null, claim: true };
  } else if (!current.clientIdClaimed) {
    base = { clientId: D, reason: 'claimed', rotated: false, previous: null, claim: true };
  } else {
    // Not bound to this vault: kept as it is while the change waits.
    base = { clientId: D, reason: 'vault-copied', rotated: false, previous: null, claim: false };
    copied = true;
  }

  const twin = current.twinClientId !== '' && current.twinClientId === base.clientId;
  if (!copied && !twin) return base;
  const change = copied ? 'vault-copied' : 'twin-seen';
  if (changedRecently(current.clientIdRotatedAt, now)) {
    return { ...base, reason: 'deferred', deferred: change, previous: null };
  }
  return {
    clientId: newId(),
    reason: change,
    rotated: true,
    previous: base.clientId,
    claim: storeAvailable,
  };
}

/** What `current` becomes by `decision`; `claimed`: whether the id was bound to this vault (`null`: not tried). */
export function nextIdentity(
  current: ClientIdentity,
  decision: IdentityDecision,
  claimed: boolean | null,
  now: number,
): ClientIdentity {
  const left =
    decision.rotated && decision.previous !== null
      ? [decision.previous, ...current.previousClientIds]
      : current.previousClientIds;
  const previousClientIds: string[] = [];
  for (const id of left) {
    if (id === decision.clientId || previousClientIds.includes(id)) continue;
    previousClientIds.push(id);
    if (previousClientIds.length === PREVIOUS_CLIENT_IDS_MAX) break;
  }
  return {
    clientId: decision.clientId,
    clientIdClaimed: claimed ?? current.clientIdClaimed,
    // Kept only while the change it asks for waits.
    twinClientId: current.twinClientId === decision.clientId ? current.twinClientId : '',
    clientIdRotatedAt: decision.rotated ? now : current.clientIdRotatedAt,
    previousClientIds,
  };
}

export interface IdentityOutcome {
  decision: IdentityDecision;
  next: ClientIdentity;
  /**
   * The vault's local storage: the id written and read back (`verified`),
   * written and not read back (`failed`), not written (`untouched`), or not
   * there (`unavailable`).
   */
  store: 'verified' | 'failed' | 'untouched' | 'unavailable';
}

/**
 * Decide the id ({@link resolveClientIdentity}) and bind it to the vault:
 * write it to the local storage and read it back. Only an id read back is
 * bound (`clientIdClaimed`); one that is not is left unbound, and the id the
 * storage may still hold, one this vault has moved on from, is removed. The
 * caller saves `next` to `data.json` after this.
 */
export function settleClientIdentity(input: {
  current: ClientIdentity;
  store: VaultStore | null;
  now: number;
  newId: () => string;
}): IdentityOutcome {
  const { current, store, now, newId } = input;
  let stored: unknown = null;
  let storeAvailable = store !== null;
  if (store !== null) {
    try {
      stored = store.load(CLIENT_ID_KEY);
    } catch {
      storeAvailable = false;
    }
  }
  const decision = resolveClientIdentity({ current, stored, storeAvailable, now, newId });
  let claimed: boolean | null = null;
  let result: IdentityOutcome['store'] = storeAvailable ? 'untouched' : 'unavailable';
  if (store !== null && storeAvailable && decision.claim) {
    claimed = bindToVault(store, decision.clientId);
    result = claimed ? 'verified' : 'failed';
  }
  return { decision, next: nextIdentity(current, decision, claimed, now), store: result };
}

/** Write `clientId` to the vault's local storage; whether it reads back. */
function bindToVault(store: VaultStore, clientId: string): boolean {
  try {
    store.save(CLIENT_ID_KEY, clientId);
    if (store.load(CLIENT_ID_KEY) === clientId) return true;
  } catch {
    // Taken as a write that did not stick.
  }
  // What the storage still holds is an id this vault is leaving: a later start
  // must not go back to it. Should the removal fail too, that id is in
  // `previousClientIds` by then, or the storage had none (see rule 4).
  try {
    store.save(CLIENT_ID_KEY, null);
  } catch {
    // As above.
  }
  return false;
}
