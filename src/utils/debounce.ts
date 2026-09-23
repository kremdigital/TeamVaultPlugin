/**
 * Trailing-edge debounce: collapses bursts of calls into a single invocation
 * that fires `wait` ms after the last call.
 *
 * The standard `lodash.debounce` would do, but pulling in lodash for one
 * function adds ~20 KB minified to the plugin bundle for no win — this
 * implementation is ~30 lines and easy to reason about.
 *
 * - `cancel()` — drop the pending call, if any.
 * - `flush()`  — invoke the pending call immediately and clear the timer.
 *
 * The wrapped function's return value is dropped (we run on a timer, the
 * caller can't `await` anything anyway).
 */

export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
  flush(): void;
}

export interface DebounceOptions {
  /** Optional clock injection — tests substitute fake timers. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  waitMs: number,
  options: DebounceOptions = {},
): DebouncedFunction<Args> {
  // `window.*` rather than the bare globals, as the directory's guidelines ask
  // (popout-window compatibility). Resolved on each call, not captured once.
  const setT =
    options.setTimeout ?? ((cb: () => void, ms: number): unknown => window.setTimeout(cb, ms));
  const clearT =
    options.clearTimeout ?? ((handle: unknown): void => window.clearTimeout(handle as number));

  let handle: unknown = null;
  let lastArgs: Args | null = null;

  const debounced = ((...args: Args): void => {
    lastArgs = args;
    if (handle !== null) clearT(handle);
    handle = setT(() => {
      handle = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, waitMs);
  }) as DebouncedFunction<Args>;

  debounced.cancel = (): void => {
    if (handle !== null) clearT(handle);
    handle = null;
    lastArgs = null;
  };

  debounced.flush = (): void => {
    if (handle === null) return;
    clearT(handle);
    handle = null;
    const a = lastArgs;
    lastArgs = null;
    if (a) fn(...a);
  };

  return debounced;
}
