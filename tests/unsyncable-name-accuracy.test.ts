import { setLanguage } from '@/i18n';
import { UnsyncableNameReporter } from '@/ui/unsyncable-names';
import {
  ObsidianWatcher,
  type UnsyncableName,
  type VaultEvent,
  type WatchableVault,
} from '@/watcher/obsidian-events';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { VaultBinding } from '@/settings/settings';

/**
 * A third review of the notices about names Windows can't keep as spelled
 * (see `unsyncable-name-notices.test.ts`, `unsyncable-name-advice.test.ts`)
 * found where they, and the docs about them, still said something untrue:
 *
 *   - a synced note renamed to `Why?.md`, back, and to `Why?.md` again was
 *     deleted for the team a second time without a notice or a `sync.log`
 *     line — the rename was remembered as told for good — and so was a
 *     second new note titled `Why?` where the first had been
 *     (`Untitled.md` → `Why?.md` twice), though the README promised both;
 *   - the notice that groups names counted them by the name at fault but was
 *     chosen by the path, so it could say "(names: 1)" and then "Some of
 *     them are synced notes you renamed";
 *   - the Russian notice about a note in a folder `U.S.` or `Notes.` called
 *     the folder a note ("Если заметку уже синхронизировала…, переименуйте
 *     её"), and the English one said only "it": neither said that the
 *     folder is what to rename;
 *   - the README and MANUAL-TEST said the next notice waits for the one on
 *     screen to go, while the gap is a fixed 15 s (a notice stays up while
 *     the pointer is over it, and a click hides it at once); and MANUAL-TEST
 *     S16 step 4 expected the notice about a new note in `U.S.` "without
 *     words about deleting", while it advises deleting a leftover copy and
 *     warns how not to delete such a name on Windows.
 */

class FakeVault {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on(name: string, cb: (...args: unknown[]) => void): unknown {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(cb);
    return { name, cb };
  }
  offref(): void {}
  fire(name: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(...args);
  }
}

const BINDING: VaultBinding = {
  id: 'b1',
  serverId: 's',
  projectId: 'p',
  projectName: 'Proj',
  localFolder: '/',
  enabled: true,
  lastSyncedAt: 0,
  lastVectorClock: {},
};

interface Bench {
  vault: FakeVault;
  events: VaultEvent[];
  notices: string[];
  /** When each notice came up (`Date.now()`, faked). */
  shownAt: number[];
  logged: Array<Record<string, unknown>>;
}

/** The Obsidian watcher wired to a reporter, as `main.ts` wires them. */
function bench(): Bench {
  const vault = new FakeVault();
  const events: VaultEvent[] = [];
  const notices: string[] = [];
  const shownAt: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const reporter = new UnsyncableNameReporter({
    show: (message) => {
      notices.push(message);
      shownAt.push(Date.now());
    },
    log: (message, context) => void logged.push({ message, ...context }),
  });
  const watcher = new ObsidianWatcher({
    bindings: () => [BINDING],
    recentlyApplied: new RecentlyApplied(),
    modifyDebounceMs: 0,
    setTimeout: (cb) => {
      cb();
      return 0;
    },
    clearTimeout: () => undefined,
    onUnsyncableName: (event) => reporter.report(event),
  });
  watcher.onEvent((e) => events.push(e));
  watcher.start(vault as unknown as WatchableVault);
  return { vault, events, notices, shownAt, logged };
}

/** The notices one reporter shows for these reports, given together. */
function noticesFor(...reports: UnsyncableName[]): string[] {
  const notices: string[] = [];
  const reporter = new UnsyncableNameReporter({ show: (m) => notices.push(m) });
  for (const report of reports) reporter.report(report);
  jest.runOnlyPendingTimers();
  return notices;
}

beforeEach(() => {
  jest.useFakeTimers();
  setLanguage('en');
});
afterEach(() => jest.useRealTimers());
afterAll(() => setLanguage('en'));

describe('the warning that a rename is a delete for the team', () => {
  it('comes for a second new note given the title the first one had', () => {
    const { vault, events, notices, logged } = bench();

    // Ctrl+N, then the title `Why?`: Obsidian creates `Untitled.md` and
    // renames it. The first such note is filed away, and the same again.
    vault.fire('create', { path: 'Untitled.md' });
    vault.fire('rename', { path: 'Why?.md' }, 'Untitled.md');
    jest.runOnlyPendingTimers();
    vault.fire('rename', { path: 'Old/Why?.md' }, 'Why?.md');
    vault.fire('create', { path: 'Untitled.md' });
    vault.fire('rename', { path: 'Why?.md' }, 'Untitled.md');
    jest.runOnlyPendingTimers();

    expect(events.map((e) => [e.type, 'path' in e ? e.path : ''])).toEqual([
      ['create', 'Untitled.md'],
      ['delete', 'Untitled.md'],
      ['create', 'Untitled.md'],
      ['delete', 'Untitled.md'],
    ]);
    expect(notices).toHaveLength(2);
    for (const notice of notices) expect(notice).toContain('the rename looks like a delete');
    expect(logged.map((e) => [e['path'], e['renamedFrom']])).toEqual([
      ['Why?.md', 'Untitled.md'],
      ['Why?.md', 'Untitled.md'],
    ]);
  });

  it('comes each time the same note is given that name again', () => {
    const { vault, events, notices, logged } = bench();

    for (let round = 0; round < 3; round++) {
      vault.fire('rename', { path: 'U.S./Plan.md' }, 'Plan.md');
      jest.runOnlyPendingTimers();
      vault.fire('rename', { path: 'Plan.md' }, 'U.S./Plan.md');
      jest.runOnlyPendingTimers();
    }

    expect(events.filter((e) => e.type === 'delete')).toHaveLength(3);
    expect(notices).toHaveLength(3);
    expect(logged.map((e) => e['renamedFrom'])).toEqual(['Plan.md', 'Plan.md', 'Plan.md']);
  });

  it('shares one notice for renames close together, with a log line for each', () => {
    const { vault, notices, logged } = bench();

    vault.fire('rename', { path: 'Why?.md' }, 'Trip.md');
    vault.fire('rename', { path: 'Trip.md' }, 'Why?.md');
    vault.fire('rename', { path: 'Why?.md' }, 'Trip.md');
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(logged.map((e) => e['renamedFrom'])).toEqual(['Trip.md', 'Trip.md']);
  });
});

describe('the count in the notice that groups several names', () => {
  it.each([
    ['en', '(names: 2)', 'Some of them are synced notes you renamed'],
    ['ru', '(имён: 2)', 'Среди них есть синхронизированные заметки, которые вы переименовали'],
  ] as const)(
    'counts `Why?.md` edited in one folder and given to a synced note in another as two (%s)',
    (language, count, someRenamed) => {
      setLanguage(language);
      const { vault, notices } = bench();

      vault.fire('modify', { path: 'A/Why?.md' });
      vault.fire('rename', { path: 'B/Why?.md' }, 'B/b.md');
      jest.runOnlyPendingTimers();

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(count);
      expect(notices[0]).toContain(someRenamed);
    },
  );

  it('is never below two, whatever the names reported together', () => {
    const why = (path: string): UnsyncableName => ({
      path,
      name: path,
      problem: { kind: 'character', character: '?' },
    });
    const inUS = (file: string): UnsyncableName => ({
      path: `U.S./${file}`,
      name: 'U.S.',
      problem: { kind: 'trailing' },
    });
    const pool: UnsyncableName[] = [
      why('Why?.md'),
      { ...why('Why?.md'), renamedFrom: 'Trip.md' },
      { ...why('Work/Why?.md'), renamedFrom: 'Work/Plan.md' },
      why('Old/Why?.md'),
      why('Who?.md'),
      inUS('a.md'),
      { ...inUS('b.md'), renamedFrom: 'b.md' },
      { ...inUS('c.md'), renamedFrom: 'c.md' },
      { ...inUS('d.md'), renamedFrom: 'Archive/U.S./d.md' },
      { ...inUS('e.md'), name: 'Trip/U.S.', path: 'Trip/U.S./e.md', renamedFrom: 'e.md' },
    ];

    let grouped = 0;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const batch = pool.filter((_, i) => (mask & (1 << i)) !== 0);
      for (const notice of noticesFor(...batch)) {
        const count = /\(names: (\d+)\)/.exec(notice)?.[1];
        if (count === undefined) continue;
        grouped++;
        expect(Number(count)).toBeGreaterThanOrEqual(2);
      }
    }
    expect(grouped).toBeGreaterThan(100);
  });
});

describe.each([
  [
    'en',
    {
      folder: 'Rename the folder to sync the notes in it with your team',
      folderOlder: 'rename the folder or those notes',
      note: 'Rename it to sync it with your team',
      noteOlder: 'If an older version of Team Vault already synced it,',
    },
  ],
  [
    'ru',
    {
      folder: 'Переименуйте папку, чтобы синхронизировать её заметки с командой',
      folderOlder: 'переименуйте папку или эти заметки',
      note: 'Переименуйте, чтобы синхронизировать с командой',
      noteOlder: 'Если заметку уже синхронизировала старая версия Team Vault',
    },
  ],
] as const)('the notice about a folder with such a name (%s)', (language, text) => {
  beforeEach(() => setLanguage(language));

  it.each(['Notes./Plan.md', 'U.S./Без названия.md', 'Trip/U.S./a.md'])(
    'says the folder is what to rename, for %s',
    (path) => {
      const { vault, notices } = bench();
      vault.fire('modify', { path });
      jest.runOnlyPendingTimers();

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(text.folder);
      expect(notices[0]).toContain(text.folderOlder);
      expect(notices[0]).not.toContain(text.note);
      expect(notices[0]).not.toContain(text.noteOlder);
    },
  );

  it('still speaks of the note when the note has such a name', () => {
    const { vault, notices } = bench();
    vault.fire('modify', { path: 'Trip/Why?.md' });
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(text.note);
    expect(notices[0]).toContain(text.noteOlder);
    expect(notices[0]).not.toContain(text.folder);
  });
});
