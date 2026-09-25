import { RecentlyApplied } from '@/watcher/recently-applied';

describe('RecentlyApplied', () => {
  it('reports unmarked paths as absent', () => {
    const r = new RecentlyApplied();
    expect(r.has('a.md')).toBe(false);
    expect(r.take('a.md')).toBe(false);
  });

  it('mark + has returns true within the TTL window', () => {
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md');
    now = 50;
    expect(r.has('a.md')).toBe(true);
  });

  it('expires after the TTL window', () => {
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md');
    now = 200;
    expect(r.has('a.md')).toBe(false);
    // Expired entries are purged from the map on read.
    expect(r.size()).toBe(0);
  });

  it('take() consumes the marker', () => {
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md');
    expect(r.take('a.md')).toBe(true);
    expect(r.take('a.md')).toBe(false);
    expect(r.has('a.md')).toBe(false);
  });

  it('take() honours the count parameter — one mark, N suppressed echoes', () => {
    // A single disk write can fan out into 2-3 watcher events (Obsidian
    // onModify + chokidar `change` and, on Windows, a stray `unlink` +
    // `add` from the atomic-rename pattern). `mark(path, count)` budgets
    // for them all; the take after the budget falls through.
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md', 3);
    expect(r.take('a.md')).toBe(true);
    expect(r.take('a.md')).toBe(true);
    expect(r.take('a.md')).toBe(true);
    expect(r.take('a.md')).toBe(false);
    expect(r.has('a.md')).toBe(false);
  });

  it('re-marking within the TTL window adds to the remaining budget', () => {
    // Two overlapping system writes — each contributes its own echo
    // budget instead of one stomping on the other.
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md', 2);
    expect(r.take('a.md')).toBe(true); // 1 left
    r.mark('a.md', 2); // budget is now 3
    expect(r.take('a.md')).toBe(true); // 2 left
    expect(r.take('a.md')).toBe(true); // 1 left
    expect(r.take('a.md')).toBe(true); // 0 left
    expect(r.take('a.md')).toBe(false);
  });

  it('mark() bumps the TTL on repeats', () => {
    let now = 0;
    const r = new RecentlyApplied({ ttlMs: 100, now: () => now });
    r.mark('a.md');
    now = 80;
    r.mark('a.md');
    now = 150;
    expect(r.has('a.md')).toBe(true);
  });

  it('mark() with count <= 0 is a no-op', () => {
    const r = new RecentlyApplied({ ttlMs: 100 });
    r.mark('a.md', 0);
    expect(r.has('a.md')).toBe(false);
    r.mark('a.md', -1);
    expect(r.has('a.md')).toBe(false);
  });

  it('clear() drops everything', () => {
    const r = new RecentlyApplied();
    r.mark('a.md');
    r.mark('b.md');
    r.expectRename('a.md', 'b.md');
    r.clear();
    expect(r.has('a.md')).toBe(false);
    expect(r.has('b.md')).toBe(false);
    expect(r.takeRename('a.md', 'b.md')).toBe(false);
  });
});

describe('RecentlyApplied — expected renames', () => {
  it('matches the exact pair once, and nothing else', () => {
    const r = new RecentlyApplied();
    r.expectRename('Note.md', 'note.md');
    expect(r.takeRename('note.md', 'Note.md')).toBe(false);
    expect(r.takeRename('Note.md', 'NOTE.md')).toBe(false);
    expect(r.takeRename('Note.md', 'note.md')).toBe(true);
    expect(r.takeRename('Note.md', 'note.md')).toBe(false);
  });

  it('forgets an echo that did not come, and expires', () => {
    let now = 0;
    const r = new RecentlyApplied({ renameTtlMs: 100, now: () => now });
    r.expectRename('a.md', 'b.md');
    r.forgetRename('a.md', 'b.md');
    expect(r.takeRename('a.md', 'b.md')).toBe(false);
    r.expectRename('a.md', 'b.md');
    now = 150;
    expect(r.takeRename('a.md', 'b.md')).toBe(false);
  });

  it('counts the same pair registered twice', () => {
    const r = new RecentlyApplied();
    r.expectRename('a.md', 'b.md');
    r.expectRename('a.md', 'b.md');
    expect(r.takeRename('a.md', 'b.md')).toBe(true);
    expect(r.takeRename('a.md', 'b.md')).toBe(true);
    expect(r.takeRename('a.md', 'b.md')).toBe(false);
  });
});
