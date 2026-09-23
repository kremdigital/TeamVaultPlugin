// Prints one version's section of CHANGELOG.md — the body of that version's
// GitHub release. `.github/workflows/release.yml` runs it for the pushed tag:
//
//   node scripts/release-notes.mjs 0.3.5 > notes.md
//   node scripts/release-notes.mjs 0.3.5 path/to/CHANGELOG.md
//
// Through 0.3.4 the workflow attached the whole CHANGELOG.md to every release,
// so each release page repeated the project's entire history. A section runs
// from its `## [X.Y.Z] — date` heading to the next `## [` heading or the end
// of the file. A missing or empty section fails the release instead of
// publishing it without notes. No dependencies, so it runs on a bare
// checkout.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECTION_PREFIX = '## [';

/**
 * @param {string} changelog CHANGELOG.md contents
 * @param {string} version exact version, e.g. `0.3.4`
 * @returns {string} the section, heading included, LF line endings, one
 *   trailing newline
 */
export function extractReleaseNotes(changelog, version) {
  const heading = `${SECTION_PREFIX}${version}]`;
  const lines = changelog.split(/\r?\n/);
  // The closing bracket is part of the match, so `0.3.4` never picks up
  // `## [0.3.40]`.
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) throw new Error(`CHANGELOG.md has no "${heading}" section`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith(SECTION_PREFIX));
  const section = lines.slice(start, next === -1 ? lines.length : next);
  if (section.slice(1).join('\n').trim() === '') {
    throw new Error(`CHANGELOG.md section "${heading}" is empty`);
  }
  return `${section.join('\n').trim()}\n`;
}

function main(args) {
  const [version, changelogPath = 'CHANGELOG.md'] = args;
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]');
    process.exit(2);
  }
  try {
    process.stdout.write(extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only a direct `node scripts/release-notes.mjs …` run is the CLI. Tests
// import this module through a CJS transform where `import.meta` is empty.
const entry = process.argv[1];
if (import.meta.url && entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main(process.argv.slice(2));
}
