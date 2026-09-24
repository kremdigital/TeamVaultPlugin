import { Notice } from 'obsidian';
import { t } from '@/i18n';
import type { UnsyncableName } from '@/watcher/obsidian-events';
import type { WindowsNameProblem } from '@/watcher/path-utils';

/** How long the notice stays up. It asks for an action, so longer than the default. */
const NOTICE_TIMEOUT_MS = 15_000;

/** Names remembered as reported; past that the memory starts over. */
const MAX_REPORTED = 1000;

export interface UnsyncableNameReporterOptions {
  /** Test seam — defaults to `new Notice(message, 15 s)`. */
  show?: (message: string) => void;
  /** Where the `warn` line goes — the plugin's logger, i.e. `sync.log`. */
  log?: (message: string, context: Record<string, unknown>) => void;
}

/**
 * Tells the user that a note won't sync because Windows can't keep its name
 * (`Why?.md`, a folder `U.S.`) — once per name while the plugin runs, with a
 * `warn` line in `sync.log`. Without it, renaming a note to such a name on a
 * Mac deleted it for the whole team, and its author went on writing in a note
 * nobody else would ever see.
 *
 * Keyed by the refused name, not by the file: renaming a folder to `U.S.`
 * reports every note in it, and one notice says it for all of them. Always
 * shown, like a conflict — the "Show sync notifications" setting is about
 * routine status, and this needs the user to act.
 */
export class UnsyncableNameReporter {
  private readonly show: (message: string) => void;
  private readonly log: ((message: string, context: Record<string, unknown>) => void) | undefined;
  private readonly reported = new Set<string>();

  constructor(options: UnsyncableNameReporterOptions = {}) {
    this.show = options.show ?? ((message) => new Notice(message, NOTICE_TIMEOUT_MS));
    this.log = options.log;
  }

  report(event: UnsyncableName): void {
    if (this.reported.has(event.name)) return;
    if (this.reported.size >= MAX_REPORTED) this.reported.clear();
    this.reported.add(event.name);
    this.log?.('not synced: Windows cannot keep this name', {
      path: event.path,
      name: event.name,
      problem: event.problem.kind,
      ...(event.problem.kind === 'character' ? { character: event.problem.character } : {}),
      ...(event.renamedFrom !== undefined ? { renamedFrom: event.renamedFrom } : {}),
    });
    const params = { name: event.name, problem: describeProblem(event.problem) };
    this.show(
      event.renamedFrom !== undefined
        ? t('notice.unsyncableName.renamed', params)
        : t('notice.unsyncableName', params),
    );
  }
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
