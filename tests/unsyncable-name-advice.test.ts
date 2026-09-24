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
 * Review of the notices about names Windows can't keep as spelled (see
 * `unsyncable-name-notices.test.ts`) found what they still got wrong:
 *
 *   - after a note an older version synced was renamed in the web interface,
 *     a teammate on this version keeps a copy under the old name; editing it
 *     gave the advice to rename it, which uploads a third copy;
 *   - that advice (and the README) now says to delete such a copy, and on
 *     Windows a copy named `Notes.` exists too — an older version wrote it as
 *     spelled. Deleted in File Explorer or to Obsidian's default system
 *     trash, Windows drops the dot and deletes the synced `Notes` next to it,
 *     for the whole team;
 *   - the notice that groups names called short names ones that "don't work
 *     on Windows" without saying why (Windows keeps them; they may open
 *     another file);
 *   - moving `Work/Why?.md` into the folder of another binding, `Team`, was
 *     taken for a rename that changes nothing and said nothing, though the
 *     note is meant for the other project's team and won't reach it.
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

const ROOT: VaultBinding = {
  id: 'b1',
  serverId: 's',
  projectId: 'p',
  projectName: 'Proj',
  localFolder: '/',
  enabled: true,
  lastSyncedAt: 0,
  lastVectorClock: {},
};

/** The Obsidian watcher wired to a reporter, as `main.ts` wires them. */
function bench(bindings: VaultBinding[] = [ROOT]): {
  vault: FakeVault;
  events: VaultEvent[];
  notices: string[];
  logged: Array<Record<string, unknown>>;
} {
  const vault = new FakeVault();
  const events: VaultEvent[] = [];
  const notices: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const reporter = new UnsyncableNameReporter({
    show: (message) => notices.push(message),
    log: (message, context) => void logged.push({ message, ...context }),
  });
  const watcher = new ObsidianWatcher({
    bindings: () => bindings,
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
  return { vault, events, notices, logged };
}

/** The one notice the reporter shows for these reports, given together. */
function noticeFor(...reports: UnsyncableName[]): string {
  const notices: string[] = [];
  const reporter = new UnsyncableNameReporter({ show: (m) => notices.push(m) });
  for (const report of reports) reporter.report(report);
  jest.runOnlyPendingTimers();
  expect(notices).toHaveLength(1);
  return notices[0] ?? '';
}

const why: UnsyncableName = {
  path: 'Why?.md',
  name: 'Why?.md',
  problem: { kind: 'character', character: '?' },
};
const notesDot: UnsyncableName = {
  path: 'Notes./Plan.md',
  name: 'Notes.',
  problem: { kind: 'trailing' },
};
const draft: UnsyncableName = {
  path: 'Draft~1.md',
  name: 'Draft~1.md',
  problem: { kind: 'short-name' },
};

const TEXT = {
  en: {
    leftover: 'If it was renamed there already, this is a leftover copy',
    leftoverSteps: 'copy any edits you made in it to the renamed one, then delete it',
    leftoverFolder: 'Those renamed there already are leftover copies',
    leftoverMany: 'One renamed there already is a leftover copy',
    windowsDelete:
      "On Windows, don't delete a file or folder whose name ends in a dot or a space in File Explorer",
    readme: 'The Team Vault README says how to delete it safely',
    manyLead: "Team Vault doesn't sync notes whose names Windows can't keep as spelled",
    alias: 'On Windows such a name can open a different file',
  },
  ru: {
    leftover: 'Если её там уже переименовали, это оставшаяся копия',
    leftoverSteps: 'перенесите сделанные в ней правки в переименованную и удалите её',
    leftoverFolder: 'Те, что там уже переименовали, — оставшиеся копии',
    leftoverMany: 'Если заметку там уже переименовали, это оставшаяся копия',
    windowsDelete:
      'На Windows не удаляйте файл или папку, имя которых оканчивается точкой или пробелом, в Проводнике',
    readme: 'Как удалить безопасно, написано в README Team Vault',
    manyLead: 'Team Vault не синхронизирует заметки с именами, которые не подходят для Windows',
    alias: 'На Windows такое имя может открыть другой файл',
  },
} as const;

beforeEach(() => {
  jest.useFakeTimers();
  setLanguage('en');
});
afterEach(() => jest.useRealTimers());
afterAll(() => setLanguage('en'));

describe.each(['en', 'ru'] as const)(
  'the advice about a copy left under the old name (%s)',
  (lang) => {
    const text = TEXT[lang];
    beforeEach(() => setLanguage(lang));

    it('tells the owner of such a copy to carry the edits over and delete it', () => {
      // A teammate renamed `Why?.md` to `Why.md` in the web interface; this
      // device got `Why.md` and still has the old `Why?.md`, now edited.
      const { vault, notices } = bench();
      vault.fire('modify', { path: 'Why?.md' });
      jest.runOnlyPendingTimers();

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(text.leftover);
      expect(notices[0]).toContain(text.leftoverSteps);
    });

    it('says it in the notice that groups several names', () => {
      const message = noticeFor(why, { ...why, path: 'Who?.md', name: 'Who?.md' });
      expect(message).toContain(text.leftoverMany);
    });

    it('says it in the rename warning about a folder older versions may have synced notes in', () => {
      const message = noticeFor({ ...notesDot, renamedFrom: 'Plan.md' });
      expect(message).toContain(text.leftoverFolder);
    });
  },
);

describe.each(['en', 'ru'] as const)(
  'deleting a name that ends in a dot or a space on Windows (%s)',
  (lang) => {
    const text = TEXT[lang];
    beforeEach(() => setLanguage(lang));

    it('is warned against wherever the notice says to delete a copy', () => {
      const { vault, notices } = bench();
      vault.fire('modify', { path: 'Notes./Plan.md' });
      jest.runOnlyPendingTimers();

      expect(notices).toHaveLength(1);
      for (const message of [
        notices[0] ?? '',
        noticeFor({ ...notesDot, renamedFrom: 'Plan.md' }),
        noticeFor(why, notesDot),
      ]) {
        expect(message).toContain(text.windowsDelete);
        expect(message).toContain(text.readme);
      }
    });

    it('is left out where no such name is in the notice, or nothing says to delete', () => {
      for (const message of [
        noticeFor(why),
        noticeFor(draft),
        noticeFor(why, draft),
        // A synced note renamed to `Plan.md.`: renaming it again is the advice.
        noticeFor({
          path: 'Plan.md.',
          name: 'Plan.md.',
          problem: { kind: 'trailing' },
          renamedFrom: 'Plan.md',
        }),
      ]) {
        expect(message).not.toContain(text.windowsDelete);
      }
    });
  },
);

describe.each(['en', 'ru'] as const)('the notice that groups several names (%s)', (lang) => {
  const text = TEXT[lang];
  beforeEach(() => setLanguage(lang));

  it('says why a short name is not synced', () => {
    const message = noticeFor(draft, { ...draft, path: 'Draft~2.md', name: 'Draft~2.md' });
    expect(message).toContain(text.manyLead);
    expect(message).toContain(text.alias);
  });

  it('gives the reason of the name it shows, not the alias for other names', () => {
    const message = noticeFor(why, draft);
    expect(message).toContain(text.manyLead);
    expect(message).not.toContain(text.alias);
  });
});

describe('the notice that groups several names', () => {
  it('no longer says that names "don\'t work on Windows"', () => {
    const message = noticeFor(why, draft);
    expect(message).not.toContain("don't work on Windows");
  });

  it('counts the names it shows: `Why?.md` in two folders is two notes to rename', () => {
    const { vault, notices, logged } = bench();

    vault.fire('rename', { path: 'Why?.md' }, 'Trip.md');
    vault.fire('rename', { path: 'Work/Why?.md' }, 'Work/Plan.md');
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('(names: 2)');
    expect(notices[0]).toContain('those renames look like deletes');
    expect(logged.map((e) => e['renamedFrom'])).toEqual(['Trip.md', 'Work/Plan.md']);

    const both = noticeFor(why, { ...why, path: 'Old/Who?.md', name: 'Old/Who?.md' });
    expect(both).toContain('(names: 2)');
  });
});

describe('moving such a note between bindings', () => {
  const work: VaultBinding = { ...ROOT, id: 'bA', projectId: 'pA', localFolder: 'Work' };
  const team: VaultBinding = { ...ROOT, id: 'bB', projectId: 'pB', localFolder: 'Team' };

  it("is reported: the note won't reach the other project's team", () => {
    const { vault, events, notices, logged } = bench([work, team]);

    vault.fire('rename', { path: 'Team/Why?.md' }, 'Work/Why?.md');
    jest.runOnlyPendingTimers();

    expect(events).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('"Team/Why?.md"');
    expect(notices[0]).not.toContain('looks like a delete');
    expect(logged).toEqual([
      expect.objectContaining({ path: 'Team/Why?.md', name: 'Team/Why?.md' }),
    ]);
  });

  it('is still quiet within one binding when there are several', () => {
    const { vault, notices, logged } = bench([work, team]);

    vault.fire('rename', { path: 'Work/Archive/Why?.md' }, 'Work/Why?.md');
    vault.fire('rename', { path: 'Team/U.S./b.md' }, 'Team/U.S./a.md');
    jest.runOnlyPendingTimers();

    expect(notices).toEqual([]);
    expect(logged).toEqual([]);
  });
});
