/**
 * Native-module loader.
 *
 * Obsidian's plugin runtime executes the bundled `main.js` in a context
 * where `require(specifier)` resolves through Electron's renderer, NOT
 * relative to the plugin's own folder. The result: a bundled
 * `require("better-sqlite3")` fails with `Cannot find module
 * 'better-sqlite3'` even when the package is installed under
 * `<plugin>/node_modules/`.
 *
 * Fix: build an absolute path to the package inside the plugin folder
 * and pass it to `require`. Node's resolver accepts an absolute path
 * unchanged.
 *
 * This module is the single place that touches the global `require`. The
 * plugin top-level (`main.ts`) calls `setPluginDir(absolutePath)` once
 * during `onload`; everything else uses `loadNative<T>(name)`.
 *
 * In Jest the helper isn't reachable — tests inject the constructor
 * directly via `OperationLogOptions.Database`.
 */

let pluginDir = '';

/** Set once at plugin startup. Idempotent — safe to call again. */
export function setPluginDir(dir: string): void {
  pluginDir = dir;
}

/** Currently registered plugin folder (absolute path). */
export function getPluginDir(): string {
  return pluginDir;
}

/**
 * Load a node module from the plugin's local `node_modules/`. Throws if
 * `setPluginDir` was never called.
 */
export function loadNative<T>(name: string): T {
  if (!pluginDir) {
    throw new Error('native-loader: pluginDir not set. Call setPluginDir() before loadNative().');
  }
  const path = `${pluginDir}/node_modules/${name}`;
  // Electron's renderer exposes Node's `require` as `globalThis.require`
  // when nodeIntegration is on (which Obsidian sets for plugins).
  const req = (globalThis as unknown as { require?: (id: string) => unknown }).require;
  if (!req) {
    throw new Error('native-loader: globalThis.require is not available');
  }
  return req(path) as T;
}
