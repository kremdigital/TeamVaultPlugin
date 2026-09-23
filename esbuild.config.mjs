import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { Buffer } from 'node:buffer';
import { copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectBundledLicenses, formatLicenseComment } from './scripts/bundle-licenses.mjs';

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
 *   `node esbuild.config.mjs --vault`   → after every build (each rebuild with
 *                                         `--watch`), copy the three release files
 *                                         (main.js, manifest.json, styles.css) into a
 *                                         vault plugin dir (TEST_VAULT env)
 */

const isWatch = process.argv.includes('--watch');
const copyToVault = process.argv.includes('--vault');
const isProd = !isWatch;

// Node built-ins stay external in both spellings: the bundle requires
// `node:fs`, `node:path`, … and a dependency importing bare `fs` must not
// get it bundled either. `builtinModules` lists bare names only, except the
// few modules that exist solely behind the prefix (`node:sqlite`,
// `node:test`, …), which it already lists with it. This replaced the
// `builtin-modules` package, which the directory's lint flags as a
// dependency with a native replacement.
const nodeBuiltins = builtinModules.flatMap((name) =>
  name.startsWith('node:') ? [name] : [name, `node:${name}`],
);

const OUTFILE = 'main.js';

/**
 * Writes the build output itself (esbuild runs with `write: false`) so the
 * license notices of the bundled packages land at the end of `main.js` in
 * every mode — one-shot, `--watch`, `--vault`. The directory ships `main.js`
 * alone, so the notices can't live in a separate file. See
 * `scripts/bundle-licenses.mjs`.
 *
 * @type {import('esbuild').Plugin}
 */
const writeWithLicenses = {
  name: 'write-with-licenses',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0 || !result.metafile || !result.outputFiles) return;
      const packages = collectBundledLicenses(result.metafile, OUTFILE, process.cwd());
      const notice = formatLicenseComment(packages);
      const bundlePath = resolve(OUTFILE);
      for (const file of result.outputFiles) {
        const isBundle = resolve(file.path) === bundlePath;
        await writeFile(file.path, isBundle ? `${file.text}${notice}` : file.contents);
      }
      // esbuild's own size line is printed before the notices are appended.
      const kb = (Buffer.byteLength(notice) / 1024).toFixed(1);
      console.log(`[licenses] ${packages.length} bundled packages, +${kb}kb of notices`);
      // Here and not after `ctx.watch()`: that returns before the first
      // build has written anything, so the vault used to get the previous
      // `main.js` and never the rebuilds.
      if (copyToVault) {
        try {
          await copyArtifactsToVault();
        } catch (err) {
          console.error('[vault]', err);
          if (!isWatch) process.exitCode = 1;
        }
      }
    });
  },
};

const banner = `/*
 * Team Vault — built bundle.
 * Do not edit directly. Source lives in src/.
 */`;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: OUTFILE,
  // The plugin above writes the output, appending the license notices.
  write: false,
  metafile: true,
  plugins: [writeWithLicenses],
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
    // NOTE: nothing outside this list may stay external. Obsidian's plugin
    // loader ships `main.js` + `manifest.json` + `styles.css` and nothing
    // else, so a `require` that expects the plugin's own `node_modules/`
    // resolves only on hand-built installs. That's why `better-sqlite3` was
    // dropped entirely in 0.3.0 (the operation log is JSON now) and why
    // `chokidar` — pure JS, `fs`/`path`/`os` stay external below — is
    // bundled rather than required at runtime.
    //
    // NOTE: Yjs is NOT external — Obsidian's plugin loader
    // doesn't traverse the plugin-local `node_modules/` for non-native
    // packages, so `require('yjs')` fails at load time. Bundling pays a
    // ~75 KB cost and prints a "Yjs was already imported" warning if
    // Obsidian's CodeMirror collab integration happens to import Yjs —
    // the warning is non-fatal and we never cross the instance boundary
    // (Yjs documents only flow within the plugin).
    ...nodeBuiltins,
  ],
  sourcemap: isWatch ? 'inline' : false,
  minify: isProd,
  define: {
    'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
  },
};

/** The files a release attaches — and all an install ever gets. */
const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'];

async function copyArtifactsToVault() {
  const vault = process.env.TEST_VAULT;
  if (!vault) {
    console.warn('[vault] TEST_VAULT env not set — skipping copy');
    return;
  }
  const dest = `${vault}/.obsidian/plugins/team-vault`;
  // Exactly what a release ships and the directory installs. Leaving
  // styles.css out (as this did until 0.3.2) gave dev installs a plugin with
  // no styling at all — every rule lives there since 0.3.0.
  for (const file of RELEASE_FILES) await copyFile(file, `${dest}/${file}`);
  console.log(`[vault] copied ${RELEASE_FILES.join(' + ')} → ${dest}`);
}

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching for changes…');
} else {
  await esbuild.build(options);
  console.log('esbuild: build complete');
}
