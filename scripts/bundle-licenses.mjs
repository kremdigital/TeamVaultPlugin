// License notices of the third-party packages bundled into `main.js`.
//
// The Obsidian directory installs `main.js`, `manifest.json` and `styles.css`
// and nothing else, so a LICENSE file next to the bundle never reaches a
// user. The MIT and BSD licenses of what we bundle (yjs, lib0, diff,
// socket.io-client, chokidar, …) require their notices to travel with every
// copy — so `esbuild.config.mjs` appends the block built here to `main.js`.
// Through 0.3.4 only chokidar's in-source `/*! … */` comment made it through.
//
// The output has to be deterministic: the directory's build verification
// rebuilds the plugin and compares it with the release asset. Hence sorted
// packages and files, LF line endings, and no dates or absolute paths.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** LICENSE / LICENCE / COPYING in any case, with any extension or suffix. */
export const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/i;

const NODE_MODULES = 'node_modules/';

/**
 * esbuild prefixes virtual modules with a namespace — `(disabled):…` is the
 * empty stub for a browser-field `false` — and they carry no code of the
 * package they name. A Windows drive letter (`C:/…`, what the metafile holds
 * for a file on another drive than the project) is not a namespace.
 *
 * @param {string} inputPath
 */
function isVirtualModule(inputPath) {
  return /^[^/\\]+:/.test(inputPath) && !/^[a-z]:[/\\]/i.test(inputPath);
}

/**
 * The package root of one esbuild metafile input, e.g.
 * `node_modules/.pnpm/diff@9.0.0/node_modules/diff/libesm/index.js` →
 * `node_modules/.pnpm/diff@9.0.0/node_modules/diff`. The last `node_modules/`
 * wins, so pnpm's store layout, npm's flat one and nested copies all work.
 *
 * @param {string} inputPath metafile input key: relative to the working
 *   directory, or absolute when it can't be (another drive on Windows)
 * @returns {string | null} null for first-party files and virtual modules
 */
export function packageDirOf(inputPath) {
  if (isVirtualModule(inputPath)) return null;
  const path = inputPath.replace(/\\/g, '/');
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const [scopeOrName, scopedName] = path.slice(at + NODE_MODULES.length).split('/');
  if (!scopeOrName) return null;
  const name = scopeOrName.startsWith('@') ? `${scopeOrName}/${scopedName}` : scopeOrName;
  return path.slice(0, at + NODE_MODULES.length) + name;
}

/**
 * Package roots of every dependency file that contributed bytes to
 * `outfile`. A package whose code was tree-shaken away entirely is not
 * redistributed and is left out. A dependency file that maps to no package
 * fails the build: its notice would silently go missing.
 *
 * @param {import('esbuild').Metafile} metafile
 * @param {string} outfile output key in the metafile, e.g. `main.js`
 * @returns {string[]}
 */
export function bundledPackageDirs(metafile, outfile) {
  const output = metafile.outputs[outfile];
  if (!output) throw new Error(`esbuild metafile has no output "${outfile}"`);
  const dirs = new Set();
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    if (bytesInOutput === 0) continue;
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
    else if (!isVirtualModule(input) && input.replace(/\\/g, '/').includes(NODE_MODULES)) {
      throw new Error(`cannot tell which package bundled file "${input}" belongs to`);
    }
  }
  return [...dirs];
}

/**
 * @typedef {{ name: string, version: string, license: string,
 *   files: { file: string, text: string }[] }} BundledPackage
 */

/**
 * `license` from package.json, including the legacy `{ type }` object and
 * `licenses: [{ type }]` array forms.
 *
 * @param {Record<string, unknown>} pkg
 * @returns {string}
 */
function licenseOf(pkg) {
  const { license, licenses } = /** @type {any} */ (pkg);
  if (typeof license === 'string' && license) return license;
  if (license && typeof license.type === 'string') return license.type;
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((entry) => entry?.type ?? String(entry)).join(' OR ');
  }
  return 'unknown';
}

/** LF line endings, no BOM, no surrounding blank lines — the same bytes on every OS. */
function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * @param {string} root directory the metafile paths are relative to
 * @param {string} dir package root relative to `root`
 * @returns {BundledPackage}
 */
export function readPackageLicense(root, dir) {
  // `resolve`, not `join`: `dir` is absolute when the metafile path was.
  const abs = resolve(root, dir);
  const pkg = JSON.parse(readFileSync(resolve(abs, 'package.json'), 'utf8'));
  const files = readdirSync(abs)
    .filter((file) => LICENSE_FILE_PATTERN.test(file))
    // Plain code-unit order, not localeCompare: the ICU locale must not
    // change the bytes of the bundle.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => ({ file, text: normalizeText(readFileSync(resolve(abs, file), 'utf8')) }));
  return { name: String(pkg.name), version: String(pkg.version), license: licenseOf(pkg), files };
}

/**
 * Every package bundled into `outfile`, one entry per name@version, sorted
 * by name and then version.
 *
 * @param {import('esbuild').Metafile} metafile
 * @param {string} outfile
 * @param {string} root
 * @returns {BundledPackage[]}
 */
export function collectBundledLicenses(metafile, outfile, root) {
  const byId = new Map();
  for (const dir of bundledPackageDirs(metafile, outfile)) {
    const pkg = readPackageLicense(root, dir);
    byId.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...byId.values()].sort(comparePackages);
}

function comparePackages(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

const RULE = '-'.repeat(72);

/**
 * One `/*! … *\/` comment: the package list, then each package's license
 * text verbatim. `/*!` marks it as a legal comment that minifiers keep.
 *
 * @param {BundledPackage[]} packages
 * @returns {string} the comment followed by a newline
 */
export function formatLicenseComment(packages) {
  const sorted = [...packages].sort(comparePackages);
  const id = (pkg) => `${pkg.name}@${pkg.version} (${pkg.license})`;
  const lines = ['Third-party packages bundled into this file and their license notices:', ''];
  for (const pkg of sorted) {
    lines.push(`- ${id(pkg)}${pkg.files.length === 0 ? ' - no license file in the package' : ''}`);
  }
  for (const pkg of sorted) {
    if (pkg.files.length === 0) {
      lines.push('', RULE, id(pkg), RULE, '');
      lines.push(`The package ships no license file; package.json declares ${pkg.license}.`);
      continue;
    }
    for (const { file, text } of pkg.files) {
      lines.push('', RULE, `${id(pkg)}: ${file}`, RULE, '', text);
    }
  }
  // A `*/` inside a license text would close the comment early and turn
  // the rest of the notice into code.
  const body = lines.join('\n').replaceAll('*/', '*\\/');
  return `/*! ${body}\n*/\n`;
}
