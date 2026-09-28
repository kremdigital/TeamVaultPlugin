/**
 * Which client id a vault syncs under (`settings/client-identity.ts`): the
 * one `data.json` has, bound to the vault in its local storage in Obsidian,
 * which a copy of the vault does not take along — a copy gets a new id. So
 * does a vault another device was seen sending under. At most one change a
 * day, and an id is bound only once it reads back from the storage.
 */
import {
  CLIENT_ID_CHANGE_MIN_INTERVAL_MS,
  CLIENT_ID_KEY,
  resolveClientIdentity,
  settleClientIdentity,
  type ClientIdentity,
  type IdentityInput,
  type VaultStore,
} from '@/settings/client-identity';
import { PREVIOUS_CLIENT_IDS_MAX } from '@/settings/settings';

const NOW = Date.UTC(2026, 8, 28, 12);
const DAY = CLIENT_ID_CHANGE_MIN_INTERVAL_MS;

/** A `data.json` as 0.4.0 left it: an id, none of the new fields. */
function identity(patch: Partial<ClientIdentity> = {}): ClientIdentity {
  return {
    clientId: 'C',
    clientIdClaimed: false,
    twinClientId: '',
    clientIdRotatedAt: 0,
    previousClientIds: [],
    ...patch,
  };
}

/** New ids, `N1`, `N2`, … */
function ids(): () => string {
  let n = 0;
  return () => `N${++n}`;
}

function resolve(
  current: ClientIdentity,
  stored: unknown,
  opts: Partial<Omit<IdentityInput, 'current' | 'stored'>> = {},
): ReturnType<typeof resolveClientIdentity> {
  return resolveClientIdentity({
    current,
    stored,
    storeAvailable: true,
    now: NOW,
    newId: ids(),
    ...opts,
  });
}

/**
 * A vault's local storage as Obsidian keeps it: JSON under the key, and a
 * write that fails dropped without a word (`saveLocalStorage` in app.js
 * 1.13.7) — here while `full` is set.
 */
class MemoryStore implements VaultStore {
  readonly items = new Map<string, string>();
  full = false;
  load(key: string): unknown {
    const raw = this.items.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as unknown);
  }
  save(key: string, value: string | null): void {
    if (value === null) {
      this.items.delete(key);
      return;
    }
    if (this.full) return;
    this.items.set(key, JSON.stringify(value));
  }
}

describe('resolveClientIdentity', () => {
  it('makes a new id on a first run, and binds it', () => {
    expect(resolve(identity({ clientId: '' }), null)).toEqual({
      clientId: 'N1',
      reason: 'first-run',
      rotated: false,
      previous: null,
      claim: true,
    });
  });

  it('takes the vault’s own id back when data.json has none (deleted, reset)', () => {
    expect(resolve(identity({ clientId: '' }), 'L')).toMatchObject({
      clientId: 'L',
      reason: 'from-vault-store',
      rotated: false,
      claim: true,
    });
  });

  it('keeps the id the local storage and data.json agree on', () => {
    expect(resolve(identity({ clientIdClaimed: true }), 'C')).toMatchObject({
      clientId: 'C',
      reason: 'kept',
      rotated: false,
      claim: true,
    });
  });

  it('keeps the vault’s own id when data.json came from elsewhere (a synced folder)', () => {
    expect(resolve(identity({ clientId: 'OTHER', clientIdClaimed: true }), 'L')).toEqual({
      clientId: 'L',
      reason: 'from-vault-store',
      rotated: false,
      previous: 'OTHER',
      claim: true,
    });
  });

  it('binds data.json’s id on the first start with a local storage: no change', () => {
    expect(resolve(identity(), null)).toMatchObject({
      clientId: 'C',
      reason: 'claimed',
      rotated: false,
      claim: true,
    });
  });

  it('gives a copy of the vault a new id: data.json’s is bound to another vault', () => {
    expect(resolve(identity({ clientIdClaimed: true }), null)).toEqual({
      clientId: 'N1',
      reason: 'vault-copied',
      rotated: true,
      previous: 'C',
      claim: true,
    });
  });

  it('gives a vault a new id once another device was seen sending under it', () => {
    expect(resolve(identity({ clientIdClaimed: true, twinClientId: 'C' }), 'C')).toMatchObject({
      clientId: 'N1',
      reason: 'twin-seen',
      rotated: true,
      previous: 'C',
    });
    // Seen under the id its local storage has, data.json holding another.
    expect(
      resolve(identity({ clientId: 'OTHER', clientIdClaimed: true, twinClientId: 'L' }), 'L'),
    ).toMatchObject({ clientId: 'N1', reason: 'twin-seen', rotated: true, previous: 'L' });
  });

  it('ignores a twin seen under an id the vault no longer has', () => {
    expect(resolve(identity({ clientIdClaimed: true, twinClientId: 'OLD' }), 'C')).toMatchObject({
      clientId: 'C',
      reason: 'kept',
      rotated: false,
    });
  });

  it('without a local storage keeps data.json’s id, but still leaves one a twin uses', () => {
    const none = { storeAvailable: false };
    expect(resolve(identity({ clientIdClaimed: true }), 'L', none)).toEqual({
      clientId: 'C',
      reason: 'no-store',
      rotated: false,
      previous: null,
      claim: false,
    });
    expect(resolve(identity({ clientId: '' }), null, none)).toMatchObject({
      clientId: 'N1',
      reason: 'first-run',
      claim: false,
    });
    expect(resolve(identity({ twinClientId: 'C' }), null, none)).toMatchObject({
      clientId: 'N1',
      reason: 'twin-seen',
      rotated: true,
      claim: false,
    });
  });

  it.each([
    ['a number', 42],
    ['an empty string', ''],
    ['blanks', '  '],
    ['an object', { id: 'C' }],
  ])('takes %s in the local storage for no id', (_what, stored) => {
    expect(resolve(identity({ clientIdClaimed: true }), stored)).toMatchObject({
      reason: 'vault-copied',
      rotated: true,
    });
  });

  it('does not go back to an id the vault moved on from that the storage still holds', () => {
    expect(
      resolve(identity({ clientId: 'N1', clientIdClaimed: false, previousClientIds: ['C'] }), 'C'),
    ).toMatchObject({ clientId: 'N1', reason: 'store-outdated', rotated: false, claim: true });
  });

  it('changes the id at most once a day', () => {
    const copied = identity({ clientIdClaimed: true, clientIdRotatedAt: NOW - DAY + 60_000 });
    expect(resolve(copied, null)).toEqual({
      clientId: 'C',
      reason: 'deferred',
      deferred: 'vault-copied',
      rotated: false,
      previous: null,
      claim: false,
    });
    const twin = identity({
      clientIdClaimed: true,
      twinClientId: 'C',
      clientIdRotatedAt: NOW - 60_000,
    });
    expect(resolve(twin, 'C')).toMatchObject({
      clientId: 'C',
      reason: 'deferred',
      deferred: 'twin-seen',
      rotated: false,
    });
    // A clock set back does not hold a change off for good.
    expect(resolve({ ...copied, clientIdRotatedAt: NOW + 3 * DAY }, null)).toMatchObject({
      reason: 'vault-copied',
      rotated: true,
    });
    expect(resolve({ ...copied, clientIdRotatedAt: NOW - DAY }, null)).toMatchObject({
      reason: 'vault-copied',
      rotated: true,
    });
    // The first id is not a change.
    expect(resolve({ ...copied, clientId: '' }, null)).toMatchObject({ reason: 'first-run' });
  });
});

describe('settleClientIdentity', () => {
  function settle(
    current: ClientIdentity,
    store: VaultStore | null,
    opts: { now?: number; newId?: () => string } = {},
  ): ReturnType<typeof settleClientIdentity> {
    return settleClientIdentity({
      current,
      store,
      now: opts.now ?? NOW,
      newId: opts.newId ?? ids(),
    });
  }

  it('binds data.json’s id on the first start with a local storage, and keeps it after', () => {
    const store = new MemoryStore();
    const first = settle(identity(), store);
    expect(first.decision.reason).toBe('claimed');
    expect(first.next).toEqual(identity({ clientIdClaimed: true }));
    expect(first.store).toBe('verified');
    expect(store.load(CLIENT_ID_KEY)).toBe('C');

    const second = settle(first.next, store);
    expect(second.decision.reason).toBe('kept');
    expect(second.next).toEqual(first.next);
  });

  it('gives the copy a new id and leaves the original’s alone', () => {
    const original = new MemoryStore();
    const data = settle(identity(), original).next;
    // The folder copied, data.json with it; the copy's local storage is empty.
    const copy = new MemoryStore();
    const copied = settle(data, copy);
    expect(copied.decision).toMatchObject({ reason: 'vault-copied', rotated: true, previous: 'C' });
    expect(copied.next).toEqual({
      clientId: 'N1',
      clientIdClaimed: true,
      twinClientId: '',
      clientIdRotatedAt: NOW,
      previousClientIds: ['C'],
    });
    expect(copy.load(CLIENT_ID_KEY)).toBe('N1');
    // Each keeps its id from then on.
    expect(settle(copied.next, copy, { now: NOW + 5 * DAY }).next.clientId).toBe('N1');
    expect(settle(data, original, { now: NOW + 5 * DAY }).next.clientId).toBe('C');
  });

  it('clears the twin once the id is left, and keeps it while the change waits', () => {
    const store = new MemoryStore();
    store.save(CLIENT_ID_KEY, 'C');
    const seen = identity({ clientIdClaimed: true, twinClientId: 'C' });
    const left = settle(seen, store);
    expect(left.decision.reason).toBe('twin-seen');
    expect(left.next).toMatchObject({ clientId: 'N1', twinClientId: '', previousClientIds: ['C'] });
    expect(store.load(CLIENT_ID_KEY)).toBe('N1');

    const store2 = new MemoryStore();
    store2.save(CLIENT_ID_KEY, 'C');
    const waits = settle({ ...seen, clientIdRotatedAt: NOW - 1_000 }, store2);
    expect(waits.decision.reason).toBe('deferred');
    expect(waits.next.twinClientId).toBe('C');
    expect(waits.next.clientId).toBe('C');
  });

  // A write Obsidian drops without a word (a full local storage), taken for
  // one that stuck: `clientIdClaimed` set, the id not there, and each start
  // took the vault for a copy — a new key in every vector clock of the
  // project on every start.
  it('does not bind an id the local storage did not keep: the id stays the same start after start', () => {
    const store = new MemoryStore();
    store.full = true;
    let current = identity();
    const seen = new Set<string>();
    const newId = ids();
    for (let start = 0; start < 3; start++) {
      const outcome = settle(current, store, { now: NOW + start * 2 * DAY, newId });
      expect(outcome.store).toBe('failed');
      expect(outcome.next.clientIdClaimed).toBe(false);
      current = outcome.next;
      seen.add(current.clientId);
    }
    expect([...seen]).toEqual(['C']);
  });

  it('removes an id it left from a local storage that does not take the new one', () => {
    const store = new MemoryStore();
    store.save(CLIENT_ID_KEY, 'C');
    store.full = true;
    const left = settle(identity({ clientIdClaimed: true, twinClientId: 'C' }), store);
    expect(left.decision.reason).toBe('twin-seen');
    expect(left.store).toBe('failed');
    expect(left.next).toMatchObject({ clientId: 'N1', clientIdClaimed: false });
    expect(store.load(CLIENT_ID_KEY)).toBeNull();

    // Back to a storage that takes writes: the new id is bound, the old one
    // never comes back.
    store.full = false;
    const next = settle(left.next, store, { now: NOW + 2 * DAY });
    expect(next.decision.reason).toBe('claimed');
    expect(next.next).toMatchObject({ clientId: 'N1', clientIdClaimed: true });
  });

  it('changes the id once when the local storage loses what was written (a crash before it reached the disk)', () => {
    const store = new MemoryStore();
    const bound = settle(identity(), store).next;
    store.items.clear();
    const newId = ids();
    const once = settle(bound, store, { now: NOW + 1_000, newId });
    expect(once.decision.reason).toBe('vault-copied');
    const again = settle(once.next, store, { now: NOW + 2_000, newId });
    expect(again.decision.reason).toBe('kept');
    expect(again.next.clientId).toBe(once.next.clientId);
  });

  it('keeps the previous ids to a bounded list, the latest first', () => {
    let current = identity({ clientIdClaimed: true });
    const newId = ids();
    for (let i = 0; i < PREVIOUS_CLIENT_IDS_MAX + 3; i++) {
      // Each start another copy: an empty local storage.
      current = settle(current, new MemoryStore(), { now: NOW + i * 2 * DAY, newId }).next;
    }
    expect(current.previousClientIds).toHaveLength(PREVIOUS_CLIENT_IDS_MAX);
    const last = PREVIOUS_CLIENT_IDS_MAX + 3;
    expect(current.clientId).toBe(`N${last}`);
    expect(current.previousClientIds[0]).toBe(`N${last - 1}`);
    expect(current.previousClientIds).not.toContain(current.clientId);
  });

  it('without a local storage changes nothing but a first run', () => {
    expect(settle(identity({ clientIdClaimed: true }), null)).toEqual({
      decision: { clientId: 'C', reason: 'no-store', rotated: false, previous: null, claim: false },
      next: identity({ clientIdClaimed: true }),
      store: 'unavailable',
    });
    expect(settle(identity({ clientId: '' }), null).next.clientId).toBe('N1');
  });

  it('takes a local storage that throws for none', () => {
    const store: VaultStore = {
      load: () => {
        throw new Error('SecurityError');
      },
      save: () => undefined,
    };
    const outcome = settle(identity({ clientIdClaimed: true }), store);
    expect(outcome.decision.reason).toBe('no-store');
    expect(outcome.store).toBe('unavailable');
    expect(outcome.next.clientId).toBe('C');
  });
});
