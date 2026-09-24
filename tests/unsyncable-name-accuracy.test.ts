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
import { manualStep, readme } from './docs-text';

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
 *
 * A fourth review found that MANUAL-TEST S16 steps 4 and 5, done as they
 * read, gave one warning where they promised two: the renames that come in
 * while a notice waits out the gap after the one before share it. And the
 * text meant for the CHANGELOG said the notice about a note in a folder
 * `U.S.` says to rename the folder even for a synced note moved there, while
 * that notice rightly says the move is a delete and to rename it again.
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
      renamed: 'To your teammates the rename looks like a delete. Rename it again to sync it.',
    },
  ],
  [
    'ru',
    {
      folder: 'Переименуйте папку, чтобы синхронизировать её заметки с командой',
      folderOlder: 'переименуйте папку или эти заметки',
      note: 'Переименуйте, чтобы синхронизировать с командой',
      noteOlder: 'Если заметку уже синхронизировала старая версия Team Vault',
      renamed:
        'Для коллег это переименование выглядит как удаление. Переименуйте ещё раз, чтобы синхронизировать.',
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

  // The CHANGELOG says the notice names the folder and says to rename it for
  // a note created or edited in it — not for a synced note moved into it:
  // that note is to be moved out again, and the notice says so.
  it.each([
    ['a.md', 'U.S./a.md'],
    ['Work/a.md', 'Notes./a.md'],
  ])(
    'speaks of the rename, not of the folder, for a synced note moved from %s to %s',
    (from, to) => {
      const { vault, notices } = bench();
      vault.fire('rename', { path: to }, from);
      jest.runOnlyPendingTimers();

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(text.renamed);
      expect(notices[0]).not.toContain(text.folder);
      expect(notices[0]).not.toContain(text.folderOlder);
    },
  );
});

describe('what the docs say about these notices', () => {
  it('README: every rename of a synced note to such a name gets a notice and a log line', () => {
    expect(readme()).toContain(
      'a notice says so for every such rename, even if the name was reported before or the same note was renamed so earlier',
    );
    expect(readme()).toContain('`sync.log` gets a line for each, naming the note it was');
  });

  it('README and MANUAL-TEST S16 step 2: the gap between notices is fixed', () => {
    const { vault, notices, shownAt } = bench();

    vault.fire('create', { path: 'Why?.md' });
    jest.advanceTimersByTime(1000);
    expect(notices).toHaveLength(1);
    // Whether the first is still up or was clicked away, the next one
    // waits out the gap from when the first came up.
    vault.fire('create', { path: 'Who?.md' });
    jest.runOnlyPendingTimers();
    expect(notices).toHaveLength(2);
    const gap = (shownAt[1] ?? 0) - (shownAt[0] ?? 0);
    expect(gap).toBe(15_000);

    expect(readme()).not.toContain('waits for it to go');
    expect(readme()).toContain(
      `A notice comes no sooner than ${gap / 1000} seconds after the one before`,
    );
    const step2 = manualStep('S16', 2);
    expect(step2).not.toContain('на экране их не больше одного');
    expect(step2).toContain(`не чаще раза в ${gap / 1000} секунд`);
    expect(step2).toContain('Пауза не зависит от того, видно ли предыдущее');
  });

  it('MANUAL-TEST S16 step 4: the notice about a new note in `U.S.` is described as it is', () => {
    setLanguage('ru');
    const { vault, notices } = bench();
    vault.fire('create', { path: 'U.S./Без названия.md' });
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    const notice = notices[0] ?? '';
    // It does speak of deleting: a leftover copy, and how not to on Windows.
    expect(notice).toContain('удалите копию');
    expect(notice).toContain('На Windows не удаляйте файл или папку');
    expect(notice).not.toContain('выглядит как удаление');

    const step4 = manualStep('S16', 4);
    expect(step4).not.toContain('без слов об удалении');
    // The step quotes the notice.
    const quoted = 'Переименуйте папку, чтобы синхронизировать её заметки с командой';
    expect(notice).toContain(quoted);
    expect(step4).toContain(quoted);
    expect(step4).toContain(
      'Фразы «для коллег это переименование выглядит как удаление» в нём нет',
    );
    expect(step4).toContain('предупреждение, что на Windows такое имя нельзя удалять');
  });
});

describe('MANUAL-TEST S16: a warning per rename, when the step waits for each', () => {
  const DELETE = 'это переименование выглядит как удаление';
  /** A tester's pace: a rename or a drag takes a few seconds. */
  const PACE_MS = 3000;

  /** Waits for the notice now due, as a tester waits to read it. */
  function untilShown(b: Bench): number {
    const before = b.notices.length;
    jest.runOnlyPendingTimers();
    expect(b.notices).toHaveLength(before + 1);
    return b.shownAt[before] ?? 0;
  }

  function rename(b: Bench, from: string, to: string): void {
    b.vault.fire('rename', { path: to }, from);
    jest.advanceTimersByTime(PACE_MS);
  }

  const renamedFrom = (b: Bench, from: string) =>
    b.logged.filter((e) => e['renamedFrom'] === from).length;

  beforeEach(() => setLanguage('ru'));

  it('step 5: `Plan.md` renamed to `Plan?.md`, back, and again', () => {
    // Done back to back right after the notice about `Question 2??.md`, the
    // renames of `Plan` come in while the next notice waits out the gap:
    // they share it, though `sync.log` has a line for each.
    const hurried = bench();
    rename(hurried, 'FAQ 2026/Question 2?.md', 'FAQ 2026/Question 2??.md');
    rename(hurried, 'Plan.md', 'Plan?.md');
    rename(hurried, 'Plan?.md', 'Plan.md');
    rename(hurried, 'Plan.md', 'Plan?.md');
    jest.runOnlyPendingTimers();
    expect(hurried.notices.filter((n) => n.includes(DELETE))).toHaveLength(1);
    expect(renamedFrom(hurried, 'Plan.md')).toBe(2);

    // As the step reads: wait for the notice about `Question 2??.md` to go
    // by itself, rename `Plan` and wait for the warning, then rename it back
    // and again.
    const b = bench();
    b.vault.fire('rename', { path: 'FAQ 2026/Question 2??.md' }, 'FAQ 2026/Question 2?.md');
    untilShown(b);
    jest.advanceTimersByTime(15_000);
    b.vault.fire('rename', { path: 'Plan?.md' }, 'Plan.md');
    const first = untilShown(b);
    rename(b, 'Plan?.md', 'Plan.md');
    rename(b, 'Plan.md', 'Plan?.md');
    const second = untilShown(b);

    const warnings = b.notices.filter((n) => n.includes(DELETE));
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) expect(warning).toContain('«Plan?.md»');
    const gap = second - first;
    expect(gap).toBe(15_000);
    expect(renamedFrom(b, 'Plan.md')).toBe(2);
    expect(b.events.map((e) => e.type)).toEqual(['delete', 'create', 'delete']);

    const step5 = manualStep('S16', 5);
    expect(step5).not.toContain('приходит оба раза');
    expect(step5).toContain('Дождаться, пока оно исчезнет само');
    expect(step5).toContain('`Plan.md` в `Plan?.md` и дождаться предупреждения');
    expect(step5).toContain(
      `предупреждение приходит второй раз, не раньше чем через ${gap / 1000} секунд после первого`,
    );
    expect(step5).toContain(
      'три переименования `Plan` сразу после `Question 2??.md` дают одно предупреждение',
    );
  });

  it('step 4: two synced notes dragged into `U.S.`', () => {
    // Both dragged in before the warning about the first comes: one warning.
    const hurried = bench();
    hurried.vault.fire('create', { path: 'U.S./Без названия.md' });
    untilShown(hurried);
    rename(hurried, 'a.md', 'U.S./a.md');
    rename(hurried, 'b.md', 'U.S./b.md');
    jest.runOnlyPendingTimers();
    expect(hurried.notices).toHaveLength(2);
    expect(hurried.notices.filter((n) => n.includes(DELETE))).toHaveLength(1);
    expect(hurried.logged.filter((e) => e['renamedFrom'] !== undefined)).toHaveLength(2);

    // As the step reads: the second one dragged in once the warning about
    // the first has come.
    const b = bench();
    b.vault.fire('create', { path: 'U.S./Без названия.md' });
    const folderNotice = untilShown(b);
    rename(b, 'a.md', 'U.S./a.md');
    const firstWarning = untilShown(b);
    rename(b, 'b.md', 'U.S./b.md');
    const secondWarning = untilShown(b);

    expect(b.notices).toHaveLength(3);
    expect(b.notices[0]).not.toContain(DELETE);
    expect(b.notices[1]).toContain(DELETE);
    expect(b.notices[2]).toContain(DELETE);
    expect(firstWarning - folderNotice).toBe(15_000);
    expect(secondWarning - firstWarning).toBe(15_000);

    const step4 = manualStep('S16', 4);
    expect(step4).toContain(
      'приходит второе уведомление (не раньше чем через 15 секунд после первого)',
    );
    expect(step4).toContain('Дождавшись этого уведомления, перетащить в `U.S.` вторую');
    expect(step4).toContain('тоже не раньше чем через 15 секунд после предыдущего');
    expect(step4).toContain(
      'Если перетащить обе, пока второе уведомление ещё не показано, предупреждение о них будет одно',
    );
  });
});
