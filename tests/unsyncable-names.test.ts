import { Notice } from './__mocks__/obsidian';
import { setLanguage } from '@/i18n';
import { UNSYNCABLE_NAME_LOG, UnsyncableNameReporter } from '@/ui/unsyncable-names';
import {
  ObsidianWatcher,
  type UnsyncableName,
  type VaultEvent,
  type WatchableVault,
} from '@/watcher/obsidian-events';
import { windowsRefusal } from '@/watcher/path-utils';
import { RecentlyApplied } from '@/watcher/recently-applied';
import type { VaultBinding } from '@/settings/settings';

/**
 * A name Windows can't keep (`Why?.md`, a folder `U.S.`) is never synced, on
 * any system. Obsidian allows such names on macOS and Linux, and the refusal
 * used to be silent: renaming a note `Why does it fail?.md` on a Mac sent a
 * delete to the whole team, and its author went on writing in a note nobody
 * else would see — no notice, not even a line in `sync.log`. Now the Obsidian
 * watcher reports such a note and the user gets a notice, once per name.
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

function binding(over: Partial<VaultBinding> = {}): VaultBinding {
  return {
    id: 'b1',
    serverId: 's',
    projectId: 'p',
    projectName: 'Proj',
    localFolder: '/',
    enabled: true,
    lastSyncedAt: 0,
    lastVectorClock: {},
    ...over,
  };
}

function watch(
  bindings: VaultBinding[] = [binding()],
  onUnsyncableName: (event: UnsyncableName) => void = () => undefined,
): { vault: FakeVault; events: VaultEvent[] } {
  const vault = new FakeVault();
  const events: VaultEvent[] = [];
  const watcher = new ObsidianWatcher({
    bindings: () => bindings,
    recentlyApplied: new RecentlyApplied(),
    modifyDebounceMs: 0,
    setTimeout: (cb) => {
      cb();
      return 0;
    },
    clearTimeout: () => undefined,
    onUnsyncableName,
  });
  watcher.onEvent((e) => events.push(e));
  watcher.start(vault as unknown as WatchableVault);
  return { vault, events };
}

describe('windowsRefusal — the name to report', () => {
  it.each([
    ['Why does it fail?.md', 'Why does it fail?.md', { kind: 'character', character: '?' }],
    ['Ideas/The "best" idea.md', 'Ideas/The "best" idea.md', { kind: 'character', character: '"' }],
    ['a|b.md', 'a|b.md', { kind: 'character', character: '|' }],
    ['time 10:30.md', 'time 10:30.md', { kind: 'character', character: ':' }],
    ['U.S./Idea.md', 'U.S.', { kind: 'trailing' }],
    ['Projects/Notes /a.md', 'Projects/Notes ', { kind: 'trailing' }],
    ['Bell\u0007.md', 'Bell\u0007.md', { kind: 'control' }],
    ['Draft~1.md', 'Draft~1.md', { kind: 'short-name' }],
    // Spelled as NFC, the way the path is compared.
    ['Cafe\u0301?.md', 'Caf\u00e9?.md', { kind: 'character', character: '?' }],
  ])('%j → %j', (path, name, problem) => {
    expect(windowsRefusal(path)).toEqual({ name, problem });
  });

  it.each([
    'Idea.md',
    'Projects/U.S/Idea.md',
    // On the list: not a note anyone meant to share.
    '.trash/Why?.md',
    'drafts~/Why?.md',
    '.obsidian/Why?.md',
    'Icon\r',
  ])('%j → null', (path) => {
    expect(windowsRefusal(path)).toBeNull();
  });

  it('keeps a custom config folder on the list', () => {
    expect(windowsRefusal('.config-work/Why?.md', '.config-work')).toBeNull();
    expect(windowsRefusal('.config-work/Why?.md')).not.toBeNull();
  });
});

describe('ObsidianWatcher — a note dropped for a name Windows cannot keep', () => {
  it('reports a rename to such a name, which the team gets as a delete', () => {
    const reported: UnsyncableName[] = [];
    const { vault, events } = watch([binding()], (e) => reported.push(e));

    vault.fire('rename', { path: 'Why does it fail?.md' }, 'Idea.md');

    expect(events).toEqual([
      { type: 'delete', bindingId: 'b1', path: 'Idea.md', source: 'obsidian' },
    ]);
    expect(reported).toEqual([
      {
        path: 'Why does it fail?.md',
        name: 'Why does it fail?.md',
        problem: { kind: 'character', character: '?' },
        renamedFrom: 'Idea.md',
      },
    ]);
  });

  it('reports each note of a folder renamed to such a name, by the folder', () => {
    const reported: UnsyncableName[] = [];
    const { vault } = watch([binding()], (e) => reported.push(e));

    vault.fire('rename', { path: 'U.S.', kind: 'folder' }, 'US');
    vault.fire('rename', { path: 'U.S./a.md' }, 'US/a.md');
    vault.fire('rename', { path: 'U.S./b.md' }, 'US/b.md');

    expect(reported.map((e) => [e.path, e.name, e.renamedFrom])).toEqual([
      ['U.S./a.md', 'U.S.', 'US/a.md'],
      ['U.S./b.md', 'U.S.', 'US/b.md'],
    ]);
  });

  it('reports a note created or edited under such a name', () => {
    const reported: UnsyncableName[] = [];
    const { vault, events } = watch([binding()], (e) => reported.push(e));

    vault.fire('create', { path: 'Why?.md' });
    vault.fire('modify', { path: 'Why?.md' });

    expect(events).toEqual([]);
    expect(reported.map((e) => [e.path, e.renamedFrom])).toEqual([
      ['Why?.md', undefined],
      ['Why?.md', undefined],
    ]);
  });

  it('reports a rename between two such names without a delete to warn about', () => {
    const reported: UnsyncableName[] = [];
    const { vault, events } = watch([binding()], (e) => reported.push(e));

    vault.fire('rename', { path: 'Why??.md' }, 'Why?.md');

    expect(events).toEqual([]);
    expect(reported.map((e) => [e.path, e.renamedFrom])).toEqual([['Why??.md', undefined]]);
  });

  it('says nothing about names on the list, deletes, or files no binding covers', () => {
    const reported: UnsyncableName[] = [];
    const { vault } = watch(
      [
        binding({ localFolder: 'notes' }),
        binding({ id: 'b2', localFolder: 'off', enabled: false }),
      ],
      (e) => reported.push(e),
    );

    vault.fire('rename', { path: '.trash/Idea.md' }, 'notes/Idea.md'); // "Move to Obsidian trash"
    vault.fire('create', { path: 'notes/draft.md~' });
    vault.fire('delete', { path: 'notes/Why?.md' });
    vault.fire('create', { path: 'other/Why?.md' });
    vault.fire('create', { path: 'off/Why?.md' });
    vault.fire('create', { path: 'notes/Idea.md' });

    expect(reported).toEqual([]);
  });

  it('does not report a rename from outside every binding as one from a synced note', () => {
    const reported: UnsyncableName[] = [];
    const { vault } = watch([binding({ localFolder: 'notes' })], (e) => reported.push(e));

    vault.fire('rename', { path: 'notes/Why?.md' }, 'inbox/Why.md');

    expect(reported.map((e) => [e.path, e.renamedFrom])).toEqual([['notes/Why?.md', undefined]]);
  });

  it('still sends the delete when the listener throws', () => {
    const { vault, events } = watch([binding()], () => {
      throw new Error('listener failed');
    });

    vault.fire('rename', { path: 'Why?.md' }, 'Idea.md');

    expect(events).toEqual([
      { type: 'delete', bindingId: 'b1', path: 'Idea.md', source: 'obsidian' },
    ]);
  });
});

describe('UnsyncableNameReporter', () => {
  const renamed: UnsyncableName = {
    path: 'Why does it fail?.md',
    name: 'Why does it fail?.md',
    problem: { kind: 'character', character: '?' },
    renamedFrom: 'Idea.md',
  };

  // Names reported together share one notice, shown after a short pause.
  beforeEach(() => {
    jest.useFakeTimers();
    setLanguage('en');
    Notice.shown = [];
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => setLanguage('en'));

  it('shows a notice that names the note and the character, and logs it', () => {
    const log = jest.fn();
    new UnsyncableNameReporter({ log }).report(renamed);
    jest.runOnlyPendingTimers();

    expect(Notice.shown).toHaveLength(1);
    const { message, timeout } = Notice.shown[0] ?? { message: '', timeout: 0 };
    expect(message).toContain('"Why does it fail?.md"');
    expect(message).toContain('the character ?');
    expect(message).toContain('the rename looks like a delete');
    expect(message).toContain('Rename it again');
    expect(timeout).toBe(15_000);
    expect(log).toHaveBeenCalledWith(UNSYNCABLE_NAME_LOG, {
      path: 'Why does it fail?.md',
      name: 'Why does it fail?.md',
      problem: 'character',
      character: '?',
      renamedFrom: 'Idea.md',
    });
  });

  it('tells a name once while the plugin runs, and every rename of a synced note to it', () => {
    const show = jest.fn();
    const log = jest.fn();
    const reporter = new UnsyncableNameReporter({ show, log });
    const inFolder = (file: string): UnsyncableName => ({
      path: `U.S./${file}`,
      name: 'U.S.',
      problem: { kind: 'trailing' },
    });

    for (const event of [
      inFolder('a.md'),
      inFolder('b.md'),
      renamed,
      // Renamed back and to the bad name again: another delete for the team.
      renamed,
      // Another synced note given that name: another delete for the team.
      { ...renamed, renamedFrom: 'Other.md' },
    ]) {
      reporter.report(event);
      jest.runOnlyPendingTimers();
    }

    expect(show).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{ kind: 'trailing' }, 'имя оканчивается точкой или пробелом'],
    [{ kind: 'control' }, 'в имени есть управляющий символ'],
    [{ kind: 'short-name' }, 'имя похоже на короткое имя Windows'],
    [{ kind: 'character', character: '*' }, 'в имени есть символ *'],
  ] as const)('explains %j in the interface language', (problem, text) => {
    setLanguage('ru');
    const show = jest.fn<void, [string]>();
    new UnsyncableNameReporter({ show }).report({ path: 'x/a.md', name: 'x', problem });
    jest.runOnlyPendingTimers();

    const message = String(show.mock.calls[0]?.[0]);
    expect(message).toContain('«x»');
    expect(message).toContain(text);
    // `x` is the folder the note is in.
    expect(message).toContain('Переименуйте папку, чтобы синхронизировать её заметки');
    expect(message).not.toContain('удаление');
  });
});
