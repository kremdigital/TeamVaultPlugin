/**
 * UUID v4 helper. Wraps the platform's `crypto.randomUUID` so call sites
 * stay short and tests can mock the indirection if they ever need to.
 *
 * Electron (Obsidian's runtime) ships `crypto.randomUUID` on `window`; under
 * Node (Jest, the CLI emulator) `window` is aliased to `globalThis`, which has
 * had it since Node 19. No polyfill needed.
 */
export function uuid(): string {
  return window.crypto.randomUUID();
}
