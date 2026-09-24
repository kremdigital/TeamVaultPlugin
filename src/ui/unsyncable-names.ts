import { Notice } from 'obsidian';
import { t } from '@/i18n';
import { refusedSegment, type UnsyncableName } from '@/watcher/obsidian-events';
import type { WindowsNameProblem } from '@/watcher/path-utils';

/** How long the notice stays up. It asks for an action, so longer than the default. */
const NOTICE_TIMEOUT_MS = 15_000;

/** Names remembered as reported; past that the memory starts over. */
const MAX_REPORTED = 1000;

/**
 * Names reported this close together share one notice: the notice waits for
 * this long a pause in reports…
 */
const QUIET_MS = 1000;

/** …but no longer than this after the first of them… */
const MAX_WAIT_MS = 5000;

/**
 * …and not while the previous one is still up: what comes in meanwhile
 * waits for it to go and then shares the next one. A folder that another
 * sync tool fills a note at a time gives a notice every 15 s, not every 5.
 */
const MIN_GAP_MS = NOTICE_TIMEOUT_MS;

/**
 * The `warn` line in `sync.log`: one per refused name, and one per synced
 * note renamed to it (with `renamedFrom`).
 */
export const UNSYNCABLE_NAME_LOG = 'not synced: Windows cannot keep this name as spelled';

export interface UnsyncableNameReporterOptions {
  /** Test seam — defaults to `new Notice(message, 15 s)`. */
  show?: (message: string) => void;
  /**
   * Where the `warn` line goes — the plugin's logger, i.e. `sync.log`.
   * Returns `false` when the line was not written (Log level at Errors
   * only): the name is then logged at its next report, once the level lets
   * it through.
   */
  log?: (message: string, context: Record<string, unknown>) => boolean | void;
}

/**
 * Tells the user that a note won't sync because Windows can't keep its name
 * as spelled (`Why?.md`, a folder `U.S.`, a note `Draft~1.md`), with a `warn`
 * line in `sync.log`. Without it, renaming a note to such a name on a Mac
 * deleted it for the whole team, and its author went on writing in a note
 * nobody else would ever see.
 *
 * A note created or edited under such a name is told once while the plugin
 * runs, by the name at fault (`U.S.`, `Why?.md`), not by the file: every note
 * in a folder `U.S.` shares one notice. A synced note renamed or moved to
 * such a name is a delete for the team, so each one gets that warning — even
 * when the name was told about before, and even the second note moved into
 * the same folder `U.S.` — once per note and name. Names reported together,
 * such as a link update touching thirty notes named `What is N?.md`, share
 * one notice that names one of them and sends the user to `sync.log` for the
 * rest; while a notice is up, the next one waits. Always shown, like a
 * conflict — the "Show sync notifications" setting is about routine status,
 * and this needs the user to act.
 */
export class UnsyncableNameReporter {
  private readonly show: (message: string) => void;
  private readonly log:
    | ((message: string, context: Record<string, unknown>) => boolean | void)
    | undefined;
  /** What was written to `sync.log`: see `reportKey`. */
  private readonly logged = new Set<string>();
  /**
   * What was put in a notice: `renamed` by `reportKey`, `plain` by the name
   * at fault alone.
   */
  private readonly told = new Set<string>();
  /**
   * Refused names (`WindowsRefusal.name`) a rename warning was given for.
   * That warning says all a plain notice about the same name would: it
   * carries the advice about notes an older version synced whenever the
   * name may hold some (a folder).
   */
  private readonly warnedNames = new Set<string>();
  private pending: UnsyncableName[] = [];
  private batchStartedAt = 0;
  private lastShownAt = Number.NEGATIVE_INFINITY;
  private timer: number | null = null;
  private disposed = false;

  constructor(options: UnsyncableNameReporterOptions = {}) {
    this.show = options.show ?? ((message) => new Notice(message, NOTICE_TIMEOUT_MS));
    this.log = options.log;
  }

  report(event: UnsyncableName): void {
    if (this.disposed) return;
    const renamed = event.renamedFrom !== undefined;
    const key = reportKey(event);
    if (!this.logged.has(key)) {
      const written = this.log?.(UNSYNCABLE_NAME_LOG, {
        path: event.path,
        name: event.name,
        problem: event.problem.kind,
        ...(event.problem.kind === 'character' ? { character: event.problem.character } : {}),
        ...(renamed ? { renamedFrom: event.renamedFrom } : {}),
      });
      if (written !== false) remember(this.logged, key);
    }
    if (renamed) {
      if (!remember(this.told, key)) return;
      remember(this.warnedNames, event.name);
    } else {
      if (this.warnedNames.has(event.name)) return;
      if (!remember(this.told, `plain\u0000${refusedSegment(event.name)}`)) return;
    }
    this.enqueue(event);
  }

  /** Drop the notice still waiting; nothing is shown or reported after this. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  private enqueue(event: UnsyncableName): void {
    const now = Date.now();
    if (this.pending.length === 0) this.batchStartedAt = now;
    this.pending.push(event);
    if (this.timer !== null) window.clearTimeout(this.timer);
    const due = Math.max(
      Math.min(now + QUIET_MS, this.batchStartedAt + MAX_WAIT_MS),
      this.lastShownAt + MIN_GAP_MS,
    );
    // `window.*`, as the directory's guidelines ask (popout windows).
    this.timer = window.setTimeout(() => this.flush(), Math.max(0, due - now));
  }

  private flush(): void {
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    this.lastShownAt = Date.now();
    this.show(noticeFor(batch));
  }
}

/**
 * A plain report by the refused name; a rename also by the synced note it
 * took from the team, which is what its warning is about.
 */
function reportKey(event: UnsyncableName): string {
  return event.renamedFrom !== undefined
    ? `renamed\u0000${event.name}\u0000${event.renamedFrom}`
    : `plain\u0000${event.name}`;
}

/** Adds `key` to `seen`; false when it was there already. */
function remember(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size >= MAX_REPORTED) seen.clear();
  seen.add(key);
  return true;
}

/**
 * Besides renaming, the notice tells how to deal with notes an older version
 * synced under such a name: rename them in the web interface or through MCP,
 * and once they are renamed there, carry over the edits made in the copy
 * left under the old name and delete it. Whatever advises deleting also
 * warns Windows users off deleting a name that ends in a dot or a space the
 * usual way — Windows would delete the one without the dot or space.
 */
function noticeFor(batch: UnsyncableName[]): string {
  const renamed = batch.find((e) => e.renamedFrom !== undefined);
  const example = renamed ?? batch[0];
  if (example === undefined) return '';
  const names = new Set(batch.map((e) => e.name));
  const params = { name: example.name, problem: describeProblem(example.problem) };
  const parts: string[] = [];
  let advisesDelete = true;
  if (names.size > 1) {
    // Counted by the name at fault: `Why?.md` in two folders is one name.
    const count = new Set(batch.map((e) => refusedSegment(e.name))).size;
    parts.push(t('notice.unsyncableName.many', { ...params, count }));
    if (example.problem.kind === 'short-name') parts.push(t('notice.unsyncableName.many.alias'));
    parts.push(t('notice.unsyncableName.many.log'));
    if (renamed !== undefined) parts.push(t('notice.unsyncableName.many.renamed'));
    parts.push(t('notice.unsyncableName.many.rename'));
  } else {
    parts.push(
      t('notice.unsyncableName', params),
      example.problem.kind === 'short-name'
        ? t('notice.unsyncableName.alias')
        : t('notice.unsyncableName.cannotKeep'),
    );
    if (renamed === undefined) {
      parts.push(t('notice.unsyncableName.rename'));
    } else {
      parts.push(t('notice.unsyncableName.renamed'));
      // A note renamed to `Why?.md` was synced under its old name, and
      // renaming it again in Obsidian is right. A folder `U.S.` may also hold
      // notes an older version synced: renamed in Obsidian, those would be
      // uploaded a second time. (One name in the batch: a plain report of the
      // same file can't come with it.)
      advisesDelete = example.name !== example.path;
      if (advisesDelete) parts.push(t('notice.unsyncableName.renamed.older'));
    }
  }
  if (advisesDelete && batch.some((e) => e.problem.kind === 'trailing')) {
    parts.push(t('notice.unsyncableName.trailingOnWindows'));
  }
  return parts.join(' ');
}

function describeProblem(problem: WindowsNameProblem): string {
  switch (problem.kind) {
    case 'character':
      return t('notice.unsyncableName.character', { character: problem.character });
    case 'control':
      return t('notice.unsyncableName.control');
    case 'trailing':
      return t('notice.unsyncableName.trailing');
    case 'short-name':
      return t('notice.unsyncableName.shortName');
  }
}
