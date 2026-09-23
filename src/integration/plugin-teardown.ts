import type { Logger } from '@/utils/logger';

/**
 * What `onunload` tears down. Every part is optional: `onload` can fail half
 * way, and whatever it had not built yet is still `null`.
 */
export interface TeardownParts {
  /** Plugin-side subscriptions (e.g. to the aggregate sync status). */
  unsubscribes?: ReadonlyArray<(() => void) | null>;
  obsidianWatcher?: { stop(): void } | null;
  fsWatcher?: { stop(): Promise<void> } | null;
  statusBar?: { destroy(): void } | null;
  engineManager?: { stop(): Promise<void> } | null;
  docManager?: { destroy(): Promise<void> } | null;
  operationLog?: { close(): Promise<void> } | null;
  logger?: Pick<Logger, 'warn'> | null;
}

/**
 * Tear the plugin down without making Obsidian wait for it.
 *
 * Obsidian calls `onunload()` and drops whatever it returns — `Component.unload`
 * never awaits it. The old `async onunload` detached the vault listeners only
 * after chokidar had closed, and whatever it still had to do ran after
 * Obsidian had already moved on.
 *
 * So everything that can call back into the plugin is detached here,
 * synchronously, before this function returns: the plugin's own status
 * subscriptions (first — stopping the engines flips them to offline, and a
 * "connection lost" notice on disabling the plugin is noise), the vault
 * listeners, chokidar together with its pending debounced events, the status
 * bar, and the engines — their sockets disconnect inside the synchronous part
 * of `stop()`.
 *
 * What remains is I/O and runs in the background. Once the engines have
 * stopped, the operation log flushes to `state.json` and the offline Yjs
 * documents close; neither waits for chokidar. A request an engine had in
 * flight can still settle after that — the log writes such a late change
 * straight to disk (see `OperationLog.touch`). A failing step is logged and
 * never stops the others.
 *
 * Returns the background part, never rejecting: `onunload` hands it to the
 * next instance of the plugin (`handOffTeardown`), and tests await it.
 */
export function teardownPlugin(parts: TeardownParts): Promise<void> {
  const report =
    (step: string) =>
    (err: unknown): void => {
      parts.logger?.warn(`unload: ${step} failed`, { err });
    };

  const now = (step: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      report(step)(err);
    }
  };

  const background = (step: string, run: () => Promise<void> | undefined): Promise<void> => {
    try {
      return (run() ?? Promise.resolve()).catch(report(step));
    } catch (err) {
      report(step)(err);
      return Promise.resolve();
    }
  };

  for (const unsubscribe of parts.unsubscribes ?? []) {
    now('status subscription', () => unsubscribe?.());
  }
  now('vault listeners', () => parts.obsidianWatcher?.stop());
  const watcherClosed = background('filesystem watcher', () => parts.fsWatcher?.stop());
  now('status bar', () => parts.statusBar?.destroy());
  const enginesStopped = background('sync engines', () => parts.engineManager?.stop());

  const logClosed = enginesStopped.then(() =>
    background('operation log', () => parts.operationLog?.close()),
  );
  const docsClosed = enginesStopped.then(() =>
    background('offline documents', () => parts.docManager?.destroy()),
  );
  return Promise.all([watcherClosed, logClosed, docsClosed]).then(() => undefined);
}

/** How long a fresh `onload` waits for the previous instance's teardown. */
export const TEARDOWN_HANDOFF_TIMEOUT_MS = 5000;

type HandoffSlots = Record<symbol, Promise<void> | undefined>;

/**
 * `Symbol.for`: the global symbol registry outlives `main.js`, so the next
 * evaluation of the module derives the same key.
 */
function handoffKey(pluginId: string): symbol {
  return Symbol.for(`${pluginId}:teardown`);
}

/**
 * Leave the background part of a teardown where the next instance of the
 * plugin finds it. Disabling and enabling the plugin, or an update, evaluates
 * `main.js` afresh: module state does not carry over, the window does.
 *
 * A teardown still running from an earlier instance stays in the slot: an
 * instance disabled while it was still loading tears down at once, and must
 * not let the next one skip the slow teardown before it. The slot clears
 * itself once everything in it has settled.
 */
export function handOffTeardown(host: object, pluginId: string, done: Promise<void>): void {
  const slots = host as HandoffSlots;
  const key = handoffKey(pluginId);
  const earlier = slots[key];
  const all = earlier ? Promise.all([earlier, done]).then(() => undefined) : done;
  slots[key] = all;
  void all.then(() => {
    if (slots[key] === all) delete slots[key];
  });
}

/**
 * Make this instance the one that writes `state.json`. Returns the check its
 * operation log passes as `ownsFile`: it turns false once a later instance
 * claims the file in turn, so requests the older instance still had in
 * flight can't overwrite the newer file (see `OperationLog`).
 */
export function claimStateFile(host: object, pluginId: string): () => boolean {
  const slots = host as Record<symbol, unknown>;
  const key = Symbol.for(`${pluginId}:state-owner`);
  const token = {};
  slots[key] = token;
  return () => slots[key] === token;
}

/**
 * Wait for the previous instance's teardown, if one is still running — it may
 * still be writing `state.json`, which the new instance is about to read. A
 * teardown stuck on I/O must not keep the plugin from loading, so the wait
 * gives up after `timeoutMs`. Resolves `false` only on that timeout.
 */
export async function awaitPreviousTeardown(
  host: object,
  pluginId: string,
  timeoutMs: number,
): Promise<boolean> {
  const pending = (host as HandoffSlots)[handoffKey(pluginId)];
  if (!pending) return true;
  let timer: number | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([pending.then(() => true), timedOut]);
  } finally {
    window.clearTimeout(timer);
  }
}
