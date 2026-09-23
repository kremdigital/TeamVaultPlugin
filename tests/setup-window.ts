/**
 * Jest setup (see `setupFiles` in jest.config.mjs).
 *
 * The plugin goes through `window` for timers and `crypto`, as the Obsidian
 * directory's guidelines ask (popout-window compatibility). Jest runs in the
 * `node` environment, which has no `window`: alias it to the global object,
 * where Node keeps the same timers and `crypto`. Jest's fake timers patch the
 * global object, so they reach `window.*` as well. Obsidian itself is
 * untouched — this file only ever runs under Jest.
 */
if (typeof window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
}
