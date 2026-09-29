/**
 * Waiting on a live system: no fixed sleeps. A scenario waits for a state
 * ({@link eventually}), never for a time, and never assumes an order between
 * independent operations of two devices.
 */

export interface EventuallyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Run `check` until it neither throws nor returns `false`, then return its
 * value; past the timeout, throw the last failure.
 */
export async function eventually<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 20_000, intervalMs = 50 }: EventuallyOptions = {},
): Promise<Exclude<T, false>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== false) return value as Exclude<T, false>;
      lastError = new Error('the condition is still false');
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      if (lastError instanceof Error) {
        lastError.message = `still failing after ${timeoutMs} ms: ${lastError.message}`;
        throw lastError;
      }
      throw new Error(`still failing after ${timeoutMs} ms: ${String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Wait `ms`: only to see that nothing more happens, never to let something happen. */
export function quietFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
