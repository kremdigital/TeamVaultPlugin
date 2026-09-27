import { diffChars, diffLines } from 'diff';
import * as Y from 'yjs';
import {
  TEXT_DIFF_LIMITS,
  applyTextDiff,
  diffText,
  type TextDiffLimits,
  type TextDiffPath,
} from '@/crdt/text-diff';

// The real jsdiff, watched: a step whose edit limit can't be met must not run.
jest.mock('diff', () => {
  const actual: typeof import('diff') = jest.requireActual('diff');
  return {
    ...actual,
    diffChars: jest.fn(actual.diffChars),
    diffLines: jest.fn(actual.diffLines),
  };
});

/** Words of the generated notes: Latin, Cyrillic, and characters outside the BMP. */
const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'labore',
  'magna',
  'aliqua',
  'привет',
  'мир',
  'заметка',
  'текст',
  'синхронизация',
  '😀',
  '🎉',
];

const FULL: TextDiffLimits = { chars: 100_000, lines: 100_000, timeoutMs: 10_000 };
const LINES: TextDiffLimits = { chars: 0, lines: 100_000, timeoutMs: 10_000 };
const SPAN: TextDiffLimits = { chars: 0, lines: 0, timeoutMs: 10_000 };

/**
 * The test vectors of the server's `editYText` (`Project/server`,
 * `src/lib/crdt/persistence.test.ts`): the plugin and the server run the same
 * steps, and each step must give exactly the new text.
 */
const SERVER_PAIRS: Array<[string, string]> = [
  ['', 'abc\n'],
  ['abc\n', ''],
  ['alpha beta\ngamma\ndelta\n', 'alpha beta\nGAMMA\ndelta\n'],
  // A shared high surrogate (U+1F600 → U+1F601) and a shared low one (U+1F600 → U+1FA00).
  ['x😀y', 'x😁y'],
  ['a😀b', 'a🨀b'],
  ['😀😀\n', '😀\n'],
  ['a😀\nb', 'a😀\nb😀c'],
  ['a\r\nb\r\n', 'a\nb\n'],
  ['line1\nline2', 'line1\nline2\n'],
  ['\n\n\n', '\n'],
  ['абв где\nжз', 'абв ГДЕ\nжз\nик'],
];

describe('diffText: steps within limits', () => {
  it.each([
    ['characters', FULL, 'chars'],
    ['lines', LINES, 'lines'],
    ['one span', SPAN, 'span'],
  ] as const)(
    '%s: exactly the new text, surrogate pairs whole, the prior history converges',
    (_name, limits, path) => {
      for (const [before, after] of SERVER_PAIRS) {
        const seed = new Y.Doc();
        seed.getText('content').insert(0, before);
        const doc = new Y.Doc();
        const device = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
        Y.applyUpdate(device, Y.encodeStateAsUpdate(seed));

        expect(applyTextDiff(doc.getText('content'), after, undefined, limits)).toBe(path);
        // A cut pair would have turned into U+FFFD.
        expect(doc.getText('content').toJSON()).toBe(after);

        Y.applyUpdate(device, Y.encodeStateAsUpdate(doc));
        expect(device.getText('content').toJSON()).toBe(after);
      }
    },
  );

  it('does nothing for the same text', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    ytext.insert(0, 'same\n');
    let updates = 0;
    doc.on('update', () => updates++);
    expect(applyTextDiff(ytext, 'same\n')).toBe('none');
    expect(diffText('same\n', 'same\n')).toEqual({ path: 'none', changes: [] });
    expect(updates).toBe(0);
  });

  it('keeps surrogate pairs whole at the span edges (seeded random)', () => {
    const random = mulberry32(20260927);
    // Pairs sharing a high half (😀😁) or a low one (😀🨀), and a plain letter.
    const alphabet = ['😀', '😁', '🨀', 'a', '\n'];
    const text = (n: number): string =>
      Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    for (let round = 0; round < 500; round++) {
      const before = text(Math.floor(random() * 12));
      const after = text(Math.floor(random() * 12));
      for (const limits of [SPAN, LINES, FULL]) {
        const doc = new Y.Doc();
        const ytext = doc.getText('content');
        ytext.insert(0, before);
        applyTextDiff(ytext, after, undefined, limits);
        expect(ytext.toJSON()).toBe(after);
      }
    }
  });
});

describe('diffText: small edits are unchanged', () => {
  it('gives exactly the character diff jsdiff always gave (seeded random)', () => {
    const random = mulberry32(7);
    const base = note(11, 20_000);
    for (let round = 0; round < 40; round++) {
      const edited = smallEdits(base, random);
      const diff = diffText(base, edited);
      expect(diff.path).toBe('chars');
      expect(diff.changes).toEqual(diffChars(base, edited));
    }
  });

  it('writes the same Yjs update as the unlimited diff did', () => {
    const random = mulberry32(8);
    const base = note(12, 5_000);
    for (let round = 0; round < 20; round++) {
      const edited = smallEdits(base, random);
      const now = docWith(base);
      const before = docWith(base);
      applyTextDiff(now.getText('content'), edited);
      unlimitedApply(before.getText('content'), edited);
      expect(Buffer.from(Y.encodeStateAsUpdate(now))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(before)),
      );
    }
  });
});

describe('diffText: a rewritten note', () => {
  const base = note(1, 20_000);
  const shapes: Array<[string, string, string]> = [
    ['rewritten with other words', base, note(2, 20_000)],
    ['every line edited', base, upperEveryThirdWord(base)],
    ['one word per line, all lines new', note(3, 20_000, 1), note(4, 20_000, 1)],
    ['one long line rewritten', flat(base), flat(note(2, 20_000))],
    [
      'a 15 KB paste',
      base.slice(0, 5_000),
      base.slice(0, 2_500) + note(5, 15_000) + base.slice(2_500, 5_000),
    ],
    ['15 KB deleted', base, base.slice(0, 2_500) + base.slice(17_500)],
  ];

  it.each(shapes)('%s: under 300 ms, exactly the new text', (_name, before, after) => {
    // The unlimited character diff took over 20 s here, freezing Obsidian.
    const run = timedApply(before, after);
    expect(run.text).toBe(after);
    expect(run.ms).toBeLessThan(300);
    expect(['lines', 'span']).toContain(run.path);
  });

  it('gives the character diff at most half the time, the line diff the rest', () => {
    // No edit limits: only the time stops a diff. 40 long lines, all new: the
    // character diff would run for seconds, the line diff needs a moment.
    const limits: TextDiffLimits = { chars: 1e9, lines: 1e9, timeoutMs: 200 };
    const run = timedApply(
      flatLines(note(31, 20_000), 40),
      flatLines(note(32, 20_000), 40),
      limits,
    );
    expect(run.path).toBe('lines');
    expect(run.ms).toBeLessThan(150);
  });

  it('holds one time budget for all the steps', () => {
    // No edit limits, and the line diff can't finish either: with a budget per
    // step it would get another full 200 ms after the character diff.
    const limits: TextDiffLimits = { chars: 1e9, lines: 1e9, timeoutMs: 200 };
    const after = note(4, 20_000, 1);
    const run = timedApply(note(3, 20_000, 1), after, limits);
    expect(run.path).toBe('span');
    expect(run.text).toBe(after);
    expect(run.ms).toBeLessThan(250);
  });
});

describe('diffText: a step that cannot fit its edit limit is skipped', () => {
  beforeEach(() => {
    jest.mocked(diffChars).mockClear();
    jest.mocked(diffLines).mockClear();
  });

  it('a small edit runs the character diff alone', () => {
    const base = note(21, 20_000);
    expect(diffText(base, base.replace('lorem', 'LOREM')).path).toBe('chars');
    expect(diffChars).toHaveBeenCalledTimes(1);
    expect(diffLines).not.toHaveBeenCalled();
  });

  it('a large paste skips the character diff', () => {
    const base = note(22, 5_000);
    const after = base.slice(0, 2_500) + note(23, 15_000) + base.slice(2_500);
    const diff = diffText(base, after);
    expect(diff.path).toBe('lines');
    expect(diffChars).not.toHaveBeenCalled();
    expect(diffLines).toHaveBeenCalledTimes(1);
    expect(joinNew(diff.changes)).toBe(after);
  });

  it('a rewrite past both limits goes as one span without running either diff', () => {
    // No character and no line in common: 2400 lines to replace.
    const before = Array.from({ length: 1_200 }, (_v, i) => `line ${i}\n`).join('');
    const after = Array.from({ length: 1_200 }, (_v, i) => `строка ${i}\n`).join('');
    const diff = diffText(before, after);
    expect(diff.path).toBe('span');
    expect(diffChars).not.toHaveBeenCalled();
    expect(diffLines).not.toHaveBeenCalled();
    expect(joinNew(diff.changes)).toBe(after);
  });

  it('the default limits are the server ones', () => {
    expect(TEXT_DIFF_LIMITS).toEqual({ chars: 1000, lines: 2000, timeoutMs: 250 });
  });
});

/** The new text a diff describes: everything but the removed parts. */
function joinNew(changes: ReadonlyArray<{ value: string; removed: boolean }>): string {
  return changes
    .filter((part) => !part.removed)
    .map((part) => part.value)
    .join('');
}

/** `applyTextDiff` as it was before the limits: an unlimited character diff. */
function unlimitedApply(ytext: Y.Text, next: string): void {
  const parts = diffChars(ytext.toJSON(), next);
  ytext.doc?.transact(() => {
    let cursor = 0;
    for (const part of parts) {
      if (part.added) {
        ytext.insert(cursor, part.value);
        cursor += part.value.length;
      } else if (part.removed) {
        ytext.delete(cursor, part.value.length);
      } else {
        cursor += part.value.length;
      }
    }
  });
}

/** A doc holding `text`, written by the same client every time. */
function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.getText('content').insert(0, text);
  return doc;
}

/**
 * `applyTextDiff` from `before` to `after`, timed: the fastest of three runs,
 * each on a fresh doc, in ms — with the step it took and the text it left.
 */
function timedApply(
  before: string,
  after: string,
  limits: TextDiffLimits = TEXT_DIFF_LIMITS,
): { ms: number; path: TextDiffPath; text: string } {
  let best = { ms: Infinity, path: 'none' as TextDiffPath, text: before };
  for (let i = 0; i < 3; i++) {
    const ytext = docWith(before).getText('content');
    const started = performance.now();
    const path = applyTextDiff(ytext, after, undefined, limits);
    const ms = performance.now() - started;
    if (ms < best.ms) best = { ms, path, text: ytext.toJSON() };
  }
  return best;
}

/** A note of about `size` characters: lines of 1 to `wordsPerLine` random words. */
function note(seed: number, size: number, wordsPerLine = 12): string {
  const random = mulberry32(seed);
  let out = '';
  while (out.length < size) {
    const count = 1 + Math.floor(random() * wordsPerLine);
    const line: string[] = [];
    for (let i = 0; i < count; i++) line.push(WORDS[Math.floor(random() * WORDS.length)] ?? '');
    out += `${line.join(' ')}\n`;
  }
  return out;
}

/** `text` as `count` lines of about the same length, cut between code points. */
function flatLines(text: string, count: number): string {
  const points = Array.from(flat(text));
  const size = Math.ceil(points.length / count);
  let out = '';
  for (let i = 0; i < points.length; i += size) out += `${points.slice(i, i + size).join('')}\n`;
  return out;
}

function flat(text: string): string {
  return text.replace(/\n/g, ' ');
}

function upperEveryThirdWord(text: string): string {
  let n = 0;
  return text.replace(/\S+/g, (word) => (n++ % 3 === 0 ? word.toUpperCase() : word));
}

/** One to five small edits — inserts, deletes, replacements of up to 30 characters. */
function smallEdits(text: string, random: () => number): string {
  let out = text;
  const count = 1 + Math.floor(random() * 5);
  for (let i = 0; i < count; i++) {
    // Cut after a line break and by code points: no edit splits a surrogate pair.
    const breaks = [...out.matchAll(/\n/g)].map((m) => (m.index ?? 0) + 1);
    const at = breaks[Math.floor(random() * breaks.length)] ?? 0;
    const cut = Array.from(out.slice(at, at + 60))
      .slice(0, Math.floor(random() * 30))
      .join('').length;
    const typed = random() < 0.3 ? '' : `edit ${Math.floor(random() * 1000)} `;
    out = out.slice(0, at) + typed + out.slice(at + cut);
  }
  return out;
}

/** Small seeded PRNG — keeps the randomized tests deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
