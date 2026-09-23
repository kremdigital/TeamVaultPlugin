/**
 * `scripts/release-notes.mjs` — the body of a GitHub release is the pushed
 * version's CHANGELOG.md section, not the whole file.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractReleaseNotes } from '../scripts/release-notes.mjs';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs');
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const SAMPLE = [
  '# Changelog',
  '',
  'Intro paragraph.',
  '',
  '## [Unreleased]',
  '',
  '- Not released yet.',
  '',
  '## [0.3.40] — 2026-10-01',
  '',
  '- Forty.',
  '',
  '## [0.3.4] — 2026-09-22',
  '',
  '### Changed',
  '',
  '- Four.',
  '',
  '## [0.3.3] — 2026-09-21',
  '',
  '### Fixed',
  '',
  '- Three.',
  '',
].join('\n');

describe('extractReleaseNotes', () => {
  it('extracts the 0.3.4 section of the real CHANGELOG.md whole and without its neighbours', () => {
    const notes = extractReleaseNotes(CHANGELOG, '0.3.4');
    const from = CHANGELOG.indexOf('## [0.3.4]');
    const to = CHANGELOG.indexOf('## [0.3.3]');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);

    expect(notes).toBe(`${CHANGELOG.slice(from, to).replace(/\r\n/g, '\n').trim()}\n`);
    expect(notes).toMatch(/^## \[0\.3\.4\] — \d{4}-\d{2}-\d{2}\n/);
    expect(notes).toMatch(/^### /m);
    // Exactly one version heading: nothing of 0.3.3 or of anything above.
    expect(notes.match(/^## \[/gm)).toHaveLength(1);
    expect(notes.length).toBeLessThan(CHANGELOG.length / 4);
  });

  it('stops at the next version heading', () => {
    expect(extractReleaseNotes(SAMPLE, '0.3.4')).toBe(
      '## [0.3.4] — 2026-09-22\n\n### Changed\n\n- Four.\n',
    );
  });

  it('does not take 0.3.40 for 0.3.4', () => {
    expect(extractReleaseNotes(SAMPLE, '0.3.40')).toBe('## [0.3.40] — 2026-10-01\n\n- Forty.\n');
    expect(extractReleaseNotes(SAMPLE, '0.3.4')).not.toContain('Forty');
  });

  it('runs the last section to the end of the file', () => {
    expect(extractReleaseNotes(SAMPLE, '0.3.3')).toBe(
      '## [0.3.3] — 2026-09-21\n\n### Fixed\n\n- Three.\n',
    );
  });

  it('matches a heading without a date', () => {
    const changelog = '## [1.0.0]\n\n- One.\n';
    expect(extractReleaseNotes(changelog, '1.0.0')).toBe('## [1.0.0]\n\n- One.\n');
  });

  it('normalizes CRLF line endings to LF', () => {
    const notes = extractReleaseNotes(SAMPLE.replace(/\n/g, '\r\n'), '0.3.4');
    expect(notes).toBe('## [0.3.4] — 2026-09-22\n\n### Changed\n\n- Four.\n');
  });

  it('throws when the version has no section', () => {
    expect(() => extractReleaseNotes(SAMPLE, '9.9.9')).toThrow(
      'CHANGELOG.md has no "## [9.9.9]" section',
    );
  });

  it('throws when the section is empty', () => {
    const changelog = '## [0.3.5] — 2026-09-23\n\n\n## [0.3.4] — 2026-09-22\n\n- Four.\n';
    expect(() => extractReleaseNotes(changelog, '0.3.5')).toThrow(
      'CHANGELOG.md section "## [0.3.5]" is empty',
    );
  });
});

describe('release-notes CLI', () => {
  // Exactly how the Release workflow calls it.
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

  it('prints the section of the given version', () => {
    expect(run('0.3.4')).toBe(extractReleaseNotes(CHANGELOG, '0.3.4'));
  });

  it('exits non-zero with a message when the version has no section', () => {
    let failure: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [SCRIPT, '9.9.9'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      failure = err as { status?: number; stderr?: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain('CHANGELOG.md has no "## [9.9.9]" section');
  });
});
