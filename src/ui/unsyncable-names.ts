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

/** …but no longer than this after the first of them. */
const MAX_WAIT_MS = 5000;

/** The `warn` line in `sync.log`, one per refused name and kind of report. */
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
 * Each name is told once while the plugin runs, by the name at fault (`U.S.`,
 * `Why?.md`), not by the file: renaming a folder to `U.S.` reports every note
 * in it, and one notice says it for all of them. The warning that a rename
 * looks like a delete to the team is kept apart — a name already told about
 * as merely unsynced still gets it once. Names reported together, such as a
 * link update touching thirty notes named `What is N?.md`, share one notice
 * that names one of them and sends the user to `sync.log` for the rest.
 * Always shown, like a conflict — the "Show sync notifications" setting is
 * about routine status, and this needs the user to act.
 */
export class UnsyncableNameReporter {
  private readonly show: (message: string) => void;
  private readonly log:
    | ((message: string, context: Record<string, unknown>) => boolean | void)
    | undefined;
  /** `kind\0name` (the refused path) written to `sync.log`. */
  private readonly logged = new Set<string>();
  /** `kind\0segment` (the refused name alone) put in a notice. */
  private readonly told = new Set<string>();
  private pending: UnsyncableName[] = [];
  private batchStartedAt = 0;
  private timer: number | null = null;
  private disposed = false;

  constructor(options: UnsyncableNameReporterOptions = {}) {
    this.show = options.show ?? ((message) => new Notice(message, NOTICE_TIMEOUT_MS));
    this.log = options.log;
  }

  report(event: UnsyncableName): void {
    if (this.disposed) return;
    const renamed = event.renamedFrom !== undefined;
    const logKey = `${kindOf(renamed)}\u0000${event.name}`;
    if (!this.logged.has(logKey)) {
      const written = this.log?.(UNSYNCABLE_NAME_LOG, {
        path: event.path,
        name: event.name,
        problem: event.problem.kind,
        ...(event.problem.kind === 'character' ? { character: event.problem.character } : {}),
        ...(renamed ? { renamedFrom: event.renamedFrom } : {}),
      });
      if (written !== false) remember(this.logged, logKey);
    }
    // The rename warning says all the plain notice does, and more.
    const segment = refusedSegment(event.name);
    if (this.told.has(`renamed\u0000${segment}`)) return;
    if (!remember(this.told, `${kindOf(renamed)}\u0000${segment}`)) return;
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
    const wait = Math.min(QUIET_MS, this.batchStartedAt + MAX_WAIT_MS - now);
    // `window.*`, as the directory's guidelines ask (popout windows).
    this.timer = window.setTimeout(() => this.flush(), Math.max(0, wait));
  }

  private flush(): void {
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) this.show(noticeFor(batch));
  }
}

function kindOf(renamed: boolean): 'renamed' | 'plain' {
  return renamed ? 'renamed' : 'plain';
}

/** Adds `key` to `seen`; false when it was there already. */
function remember(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size >= MAX_REPORTED) seen.clear();
  seen.add(key);
  return true;
}

function noticeFor(batch: UnsyncableName[]): string {
  const renamed = batch.find((e) => e.renamedFrom !== undefined);
  const example = renamed ?? batch[0];
  if (example === undefined) return '';
  const segments = new Set(batch.map((e) => refusedSegment(e.name)));
  const params = { name: example.name, problem: describeProblem(example.problem) };
  if (segments.size === 1) {
    return [
      t('notice.unsyncableName', params),
      example.problem.kind === 'short-name'
        ? t('notice.unsyncableName.alias')
        : t('notice.unsyncableName.cannotKeep'),
      renamed !== undefined
        ? t('notice.unsyncableName.renamed')
        : t('notice.unsyncableName.rename'),
    ].join(' ');
  }
  return [
    t('notice.unsyncableName.many', { ...params, count: segments.size }),
    ...(renamed !== undefined ? [t('notice.unsyncableName.many.renamed')] : []),
    t('notice.unsyncableName.many.rename'),
  ].join(' ');
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
