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
 * The notices about names Windows can't keep (see `unsyncable-names.test.ts`)
 * must say something true and must not bury the user:
 *
 *   - renaming the folder `FAQ` that holds forty notes `Question N?.md` gave
 *     forty notices, though nothing changed for the team (Obsidian renames a
 *     folder's notes one by one), and a link update over thirty notes
 *     `What is N?.md` gave thirty;
 *   - a folder `U.S.` already told about as unsynced swallowed the one
 *     warning that dragging a synced note into it deletes that note for the
 *     team;
 *   - the notice told the author of a note an older version had synced to
 *     rename it in Obsidian, which uploads a second copy — the README says to
 *     rename it in the web interface or through MCP;
 *   - a name shaped like a Windows short name (`Notes~2.md`) was said to be
 *     one Windows can't keep, while Windows keeps it: the danger is that it
 *     can open another file by its 8.3 alias.
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
  logged: Array<Record<string, unknown>>;
  reporter: UnsyncableNameReporter;
}

/** The Obsidian watcher wired to a reporter, as `main.ts` wires them. */
function bench(bindings: VaultBinding[] = [BINDING]): Bench {
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
  return { vault, events, notices, logged, reporter };
}

beforeEach(() => {
  jest.useFakeTimers();
  setLanguage('en');
});
afterEach(() => jest.useRealTimers());
afterAll(() => setLanguage('en'));

describe('no storm of notices', () => {
  it('says nothing when a folder holding such notes is renamed', () => {
    const { vault, events, notices, logged } = bench();

    // What Obsidian fires for renaming the folder `FAQ` to `FAQ 2026`.
    vault.fire('rename', { path: 'FAQ 2026', kind: 'folder' }, 'FAQ');
    for (let i = 1; i <= 40; i++) {
      vault.fire('rename', { path: `FAQ 2026/Question ${i}?.md` }, `FAQ/Question ${i}?.md`);
    }
    jest.runOnlyPendingTimers();

    expect(events).toEqual([]);
    expect(notices).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('says nothing when such a note moves or a note in such a folder is renamed', () => {
    const { vault, notices } = bench();

    vault.fire('rename', { path: 'Archive/Why?.md' }, 'Why?.md');
    vault.fire('rename', { path: 'U.S./b.md' }, 'U.S./a.md');
    vault.fire('rename', { path: 'Trip/U.S./a.md' }, 'U.S./a.md');
    jest.runOnlyPendingTimers();

    expect(notices).toEqual([]);
  });

  it('still reports a rename that changes the name at fault, or brings the note in', () => {
    const { vault, notices } = bench([{ ...BINDING, localFolder: 'notes' }]);

    vault.fire('rename', { path: 'notes/Why??.md' }, 'notes/Why?.md');
    jest.runOnlyPendingTimers();
    vault.fire('rename', { path: 'notes/Who?.md' }, 'inbox/Who?.md');
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('"notes/Why??.md"');
    expect(notices[1]).toContain('"notes/Who?.md"');
  });

  it('gives one notice for thirty such notes edited at once, and a log line for each', () => {
    const { vault, notices, logged } = bench();

    // A link update after renaming a note they all link to.
    for (let i = 1; i <= 30; i++) vault.fire('modify', { path: `Q/What is ${i}?.md` });
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('notes under 30 names');
    expect(notices[0]).toContain('"Q/What is 1?.md"');
    expect(notices[0]).toContain('sync.log');
    expect(logged).toHaveLength(30);
    expect(logged[0]).toMatchObject({
      message: 'not synced: Windows cannot keep this name as spelled',
      path: 'Q/What is 1?.md',
    });
  });

  it('groups what arrives in a burst, but shows a long one in parts', () => {
    const { vault, notices } = bench();

    for (let i = 1; i <= 12; i++) {
      vault.fire('create', { path: `In/Idea ${i}?.md` });
      jest.advanceTimersByTime(500);
    }
    jest.runOnlyPendingTimers();

    // Twelve names over six seconds: the first notice is due five seconds in.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('notes under 10 names');
    expect(notices[1]).toContain('notes under 2 names');
  });

  it('tells a name once, whatever folder it turns up in', () => {
    const { vault, notices, logged } = bench();

    vault.fire('modify', { path: 'FAQ/Question 1?.md' });
    jest.runOnlyPendingTimers();
    vault.fire('modify', { path: 'Other/Question 1?.md' });
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    // The log still names each file.
    expect(logged.map((e) => e['path'])).toEqual(['FAQ/Question 1?.md', 'Other/Question 1?.md']);
  });

  it('drops a notice still waiting when the plugin unloads', () => {
    const { vault, notices, reporter } = bench();

    vault.fire('create', { path: 'Why?.md' });
    reporter.dispose();
    vault.fire('create', { path: 'Who?.md' });
    jest.runOnlyPendingTimers();

    expect(notices).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('the warning that a rename is a delete for the team', () => {
  it('comes even after the name was told about as unsynced', () => {
    const { vault, events, notices } = bench();

    vault.fire('create', { path: 'U.S./New.md' });
    jest.runOnlyPendingTimers();
    vault.fire('rename', { path: 'U.S./Trip plan.md' }, 'Trip plan.md');
    jest.runOnlyPendingTimers();

    expect(events).toContainEqual({
      type: 'delete',
      bindingId: 'b1',
      path: 'Trip plan.md',
      source: 'obsidian',
    });
    expect(notices).toHaveLength(2);
    expect(notices[0]).not.toContain('looks like a delete');
    expect(notices[1]).toContain('"U.S."');
    expect(notices[1]).toContain('the rename looks like a delete');
  });

  it('makes a later plain notice about the same name unnecessary', () => {
    const { vault, notices } = bench();

    vault.fire('rename', { path: 'U.S./Trip plan.md' }, 'Trip plan.md');
    jest.runOnlyPendingTimers();
    vault.fire('create', { path: 'U.S./New.md' });
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('the rename looks like a delete');
  });

  it('is one notice, not two, when both come together', () => {
    const { vault, notices } = bench();

    vault.fire('create', { path: 'U.S./New.md' });
    vault.fire('rename', { path: 'U.S./Trip plan.md' }, 'Trip plan.md');
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('"U.S."');
    expect(notices[0]).toContain('the rename looks like a delete');
  });

  it('is in the notice that groups several names', () => {
    const { vault, notices } = bench();

    vault.fire('modify', { path: 'Why?.md' });
    vault.fire('rename', { path: 'Plan|B.md' }, 'Plan B.md');
    jest.runOnlyPendingTimers();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('notes under 2 names');
    expect(notices[0]).toContain('"Plan|B.md"');
    expect(notices[0]).toContain('those renames look like deletes');
  });
});

describe('what the notice advises', () => {
  const edited: UnsyncableName = {
    path: 'Why?.md',
    name: 'Why?.md',
    problem: { kind: 'character', character: '?' },
  };

  function noticeFor(...events: UnsyncableName[]): string {
    const notices: string[] = [];
    const reporter = new UnsyncableNameReporter({ show: (m) => notices.push(m) });
    for (const event of events) reporter.report(event);
    jest.runOnlyPendingTimers();
    expect(notices).toHaveLength(1);
    return notices[0] ?? '';
  }

  it('sends a note an older version synced to the web interface or MCP', () => {
    const message = noticeFor(edited);
    expect(message).toContain('Rename it to sync it with your team');
    expect(message).toContain('If an older version of Team Vault already synced it');
    expect(message).toContain("the project's web interface or through MCP");

    setLanguage('ru');
    const ru = noticeFor(edited);
    expect(ru).toContain('Переименуйте, чтобы синхронизировать с командой');
    expect(ru).toContain('Если заметку уже синхронизировала старая версия Team Vault');
    expect(ru).toContain('в веб-интерфейсе проекта или через MCP');
  });

  it('does so for several names too', () => {
    const message = noticeFor(edited, { ...edited, path: 'Who?.md', name: 'Who?.md' });
    expect(message).toContain("the project's web interface or through MCP");
  });

  it.each([
    ['en', "Windows can't keep such a name", 'such a name can open a different file'],
    ['ru', 'Windows не может сохранить такое имя', 'такое имя может открыть другой файл'],
  ] as const)(
    'gives a short name its own reason (%s): Windows keeps it, but it may open another file',
    (language, cannotKeep, alias) => {
      setLanguage(language);
      const shortName: UnsyncableName = {
        path: 'Notes~2.md',
        name: 'Notes~2.md',
        problem: { kind: 'short-name' },
      };

      for (const message of [
        noticeFor(shortName),
        noticeFor({ ...shortName, renamedFrom: 'Notes.md' }),
      ]) {
        expect(message).toContain(alias);
        expect(message).not.toContain(cannotKeep);
      }
      for (const message of [noticeFor(edited), noticeFor({ ...edited, renamedFrom: 'Idea.md' })]) {
        expect(message).toContain(cannotKeep);
        expect(message).not.toContain(alias);
      }
    },
  );
});
