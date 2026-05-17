/**
 * In-memory TTL set used to break echo loops.
 *
 * Scenario:
 *   1. Server pushes a file mutation.
 *   2. The plugin applies it via `vault.modify(...)`.
 *   3. Obsidian's `vault.on('modify', ...)` fires — but we DON'T want to
 *      ship the same change back upstream.
 *
 * The fix: right before applying, the sync engine calls `mark(path, count)`.
 * The watcher then consults `take(path)` (or `has(path)`) and skips the
 * event when there's an outstanding marker.
 *
 * One disk operation commonly produces *several* watcher events:
 *   - Obsidian's `vault.on(...)` fires once for the editor's perspective.
 *   - chokidar fires once for the FS perspective.
 *   - on Windows, an in-place write can split into a chokidar
 *     `unlink` + `add` pair if the editor used an atomic-rename pattern.
 *
 * `mark(path, count)` therefore takes a count of expected echoes (default
 * 1 for the legacy single-take call sites) and `take()` decrements it,
 * dropping the marker once the budget is spent. Re-marking the same path
 * within the TTL *adds* to the remaining count so two overlapping system
 * writes each get their own echo budget.
 *
 * Markers expire on a TTL (default 2 s). That's long enough that vault
 * events arriving on the next tick still see them, but short enough that
 * a stuck marker doesn't permanently silence a real edit.
 */

export interface RecentlyAppliedOptions {
  /** TTL in ms before a marked path is automatically forgotten. */
  ttlMs?: number;
  /** Test seam for clock injection. */
  now?: () => number;
}

interface Entry {
  /** Remaining takes before the marker falls through as a real event. */
  count: number;
  expiresAt: number;
}

export class RecentlyApplied {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: RecentlyAppliedOptions = {}) {
    this.ttlMs = options.ttlMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Mark a path as recently mutated by us. `count` is how many incoming
   * watcher events should be suppressed before the next one falls through
   * as a real change — caller chooses based on how many echoes the disk
   * operation is expected to produce.
   *
   * Re-marking the same path within the TTL ADDS to the remaining count
   * (two overlapping system writes each contribute their own budget) and
   * refreshes the expiry.
   */
  mark(path: string, count = 1): void {
    if (count <= 0) return;
    const existing = this.entries.get(path);
    const expiresAt = this.now() + this.ttlMs;
    if (existing && existing.expiresAt > this.now()) {
      existing.count += count;
      existing.expiresAt = expiresAt;
      return;
    }
    this.entries.set(path, { count, expiresAt });
  }

  /** True if `path` has a non-expired marker. Does not consume it. */
  has(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(path);
      return false;
    }
    return true;
  }

  /**
   * Atomic "consume" — true (and decrements the remaining budget) if the
   * path was marked, false otherwise. After every marked echo has been
   * consumed, subsequent events fall through and are treated as real
   * changes.
   */
  take(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(path);
      return false;
    }
    entry.count -= 1;
    if (entry.count <= 0) {
      this.entries.delete(path);
    }
    return true;
  }

  /** For tests / debug surfaces. */
  size(): number {
    // Lazy-purge during reads is enough for our scale; size() shouldn't
    // get called on a hot path.
    for (const [path, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(path);
    }
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
