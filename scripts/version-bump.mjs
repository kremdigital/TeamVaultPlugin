// Keeps manifest.json + versions.json in lockstep with package.json.
//
// Run via `pnpm version <patch|minor|major|x.y.z>` — npm sets
// package.json#version first, then fires this script through the
// "version" lifecycle hook (see package.json). We copy that version
// into manifest.json and append a versions.json entry mapping it to the
// current minAppVersion, then stage both files so they land in the
// version-bump commit npm creates.
//
// Obsidian's Community Plugins catalogue reads versions.json to decide
// which release a given Obsidian build is allowed to install, so the
// entry has to exist before the release tag is cut.
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.env.npm_package_version;
if (!target) {
  console.error('npm_package_version is not set — run this via `pnpm version`.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = target;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[target] = manifest.minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');

console.log(
  `Synced manifest.json + versions.json to ${target} (minAppVersion ${manifest.minAppVersion}).`,
);
