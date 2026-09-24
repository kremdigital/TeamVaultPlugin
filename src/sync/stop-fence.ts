/**
 * Stop fence for the sync engine.
 *
 * `SyncEngine.stop()` cannot cancel work that is already under way: a catch-up,
 * an offline-queue drain, a download, a hydration all sit on `await`s — socket
 * acks, `requestUrl`, disk reads — that nothing can interrupt. Each of them
 * used to run to the end after the plugin was disabled, paused or the binding
 * removed: writing vault files, rewriting the operation log and the offline
 * Y.Docs, issuing more requests.
 *
 * So the engine holds every dependency it talks to — the vault, the log, the
 * doc manager, the REST and socket clients, the echo set, the conflict modal —
 * through {@link fence}. Once the engine's lifetime signal is aborted, every
 * call through a fenced dependency throws the stop reason instead of reaching
 * the dependency. That is the check after every `await`: whatever a flow wakes
 * up to after `stop()` (a late response, a finished read), the next thing it
 * touches refuses, and the {@link EngineStoppedError} unwinds the flow to its
 * entry point, which drops it quietly.
 */

/** Unwinds a flow that resumed after `SyncEngine.stop()`. Never a failure. */
export class EngineStoppedError extends Error {
  constructor() {
    super('sync engine stopped');
    this.name = 'EngineStoppedError';
  }
}

/**
 * Wrap `target` so that every method called on it after `signal` aborts throws
 * `signal.reason` instead of running.
 *
 * - Only the call is gated. A call made before the abort runs to completion,
 *   and its result is simply returned to a caller that is about to hit the
 *   fence on its next call.
 * - Methods run on the real object, never on the proxy: the dependency's own
 *   background work (the operation log's debounced write, say) keeps working
 *   after the abort — the fence is about what the engine may still ask for.
 * - Property reads pass through untouched.
 */
export function fence<T extends object>(target: T, signal: AbortSignal): T {
  return new Proxy(target, {
    get(obj, prop): unknown {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        signal.throwIfAborted();
        return method.apply(obj, args);
      };
    },
  });
}
