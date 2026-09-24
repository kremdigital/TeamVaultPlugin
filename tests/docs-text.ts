import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The plugin's docs as tests read them, to check that what they tell a user
 * or a tester is what the plugin does. Line breaks and indentation are
 * folded into single spaces, so a phrase can be looked up across lines.
 */

const ROOT = join(__dirname, '..');

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** README.md, on one line. */
export function readme(): string {
  return oneLine(read('README.md'));
}

/**
 * Step `n` of scenario `id` (`S14`) in MANUAL-TEST.md, on one line. Throws
 * when there is no such step, so a renumbered scenario fails loudly.
 */
export function manualStep(id: string, n: number): string {
  const text = read('MANUAL-TEST.md');
  const start = text.indexOf(`\n### ${id} `);
  if (start === -1) throw new Error(`MANUAL-TEST.md has no scenario ${id}`);
  const lines = text
    .slice(start + 1)
    .split(/\r?\n/)
    .slice(1);
  const end = lines.findIndex((line) => line.startsWith('#'));
  const scenario = end === -1 ? lines : lines.slice(0, end);
  const from = scenario.findIndex((line) => line.startsWith(`${n}. `));
  if (from === -1) throw new Error(`MANUAL-TEST.md has no step ${n} in ${id}`);
  const step: string[] = [];
  for (const line of scenario.slice(from)) {
    if (step.length > 0 && !line.startsWith('   ')) break;
    step.push(line);
  }
  return oneLine(step.join(' '));
}
