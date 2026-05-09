import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';
import { copyFile } from 'node:fs/promises';

/**
 * Build the Obsidian plugin to `main.js` (CommonJS, single bundle).
 *
 * Obsidian loads plugins as CJS — `require('obsidian')` is provided by the
 * host at runtime, so it MUST stay external. Same goes for the electron host
 * APIs and Node built-ins, which esbuild would otherwise try to bundle.
 *
 * Modes:
 *   `node esbuild.config.mjs`           → one-shot production build (minified)
 *   `node esbuild.config.mjs --watch`   → watch mode (no minify, sourcemap inline)
 *   `node esbuild.config.mjs --vault`   → after build, copy main.js + manifest.json
 *                                         into a vault plugin dir (TEST_VAULT env)
 */

const isWatch = process.argv.includes('--watch');
const copyToVault = process.argv.includes('--vault');
const isProd = !isWatch;

const banner = `/*
 * Obsidian Team — built bundle.
 * Do not edit directly. Source lives in src/.
 */`;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
  treeShaking: true,
  banner: { js: banner },
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    // Native module — must be loaded at runtime via the host's `require`,
    // not bundled as JS. Obsidian's plugin loader resolves it from the
    // plugin's `node_modules/`.
    'better-sqlite3',
    // chokidar uses Node's `fs` / `path` / `os` heavily; bundling it pulls
    // in a long dependency chain (readdirp, etc.). Keep it external — the
    // host has Node available and the plugin's `node_modules/` ships it.
    'chokidar',
    // NOTE: Yjs / y-protocols are NOT external — Obsidian's plugin loader
    // doesn't traverse the plugin-local `node_modules/` for non-native
    // packages, so `require('yjs')` fails at load time. Bundling pays a
    // ~75 KB cost and prints a "Yjs was already imported" warning if
    // Obsidian's CodeMirror collab integration happens to import Yjs —
    // the warning is non-fatal and we never cross the instance boundary
    // (Yjs documents only flow within the plugin).
    ...builtins,
  ],
  sourcemap: isWatch ? 'inline' : false,
  minify: isProd,
  define: {
    'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
  },
};

async function copyArtifactsToVault() {
  const vault = process.env.TEST_VAULT;
  if (!vault) {
    console.warn('[vault] TEST_VAULT env not set — skipping copy');
    return;
  }
  const dest = `${vault}/.obsidian/plugins/obsidian-sync`;
  await copyFile('main.js', `${dest}/main.js`);
  await copyFile('manifest.json', `${dest}/manifest.json`);
  console.log(`[vault] copied main.js + manifest.json → ${dest}`);
}

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching for changes…');
  if (copyToVault) {
    // Initial copy after first build settles. esbuild fires onEnd after each
    // rebuild, but for simplicity we just do a one-shot copy here; users with
    // a more involved live-reload flow can wire onEnd themselves.
    await copyArtifactsToVault().catch((err) => console.error('[vault]', err));
  }
} else {
  await esbuild.build(options);
  if (copyToVault) {
    await copyArtifactsToVault();
  }
  console.log('esbuild: build complete');
}
