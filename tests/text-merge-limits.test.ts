import type { TextDiffLimits, TextDiffPath } from '@/crdt/text-diff';
import { mergeText3 } from '@/crdt/text-merge';

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

/** How the merge ran before the limits: unlimited character diffs. */
const UNLIMITED: TextDiffLimits = { chars: Infinity, lines: Infinity, timeoutMs: Infinity };
const LINES: TextDiffLimits = { chars: 0, lines: 100_000, timeoutMs: 10_000 };
const SPAN: TextDiffLimits = { chars: 0, lines: 0, timeoutMs: 10_000 };

/** Marks one side's edit: no generated note contains it. */
const MARK = '⟦edit⟧';

type Paths = { ours: TextDiffPath; theirs: TextDiffPath };

describe('mergeText3: small edits are unchanged', () => {
  it('merges exactly as the unlimited diff did, and never reports a coarse merge', () => {
    const random = mulberry32(31);
    const base = note(41, 20_000);
    const coarse: Paths[] = [];
    for (let round = 0; round < 30; round++) {
      const ours = smallEdits(base, random);
      const theirs = smallEdits(base, random);
      const merged = mergeText3(base, ours, theirs, { onCoarse: (paths) => coarse.push(paths) });
      expect(merged).toBe(mergeText3(base, ours, theirs, { limits: UNLIMITED }));
    }
    expect(coarse).toEqual([]);
  });
});

describe('mergeText3: a rewritten note', () => {
  const base = note(1, 20_000);
  const rewrite = note(2, 20_000);
  const edited = insertAt(base, lineStartAfter(base, 10_000), MARK);

  it('merges a rewrite with an edit in under 300 ms, keeping the edit', () => {
    // The unlimited character diff took over 20 s here, freezing Obsidian.
    const coarse: Paths[] = [];
    const run = timedMerge(base, rewrite, edited, (paths) => coarse.push(paths));
    expect(run.ms).toBeLessThan(300);
    // Only an insert on their side: the result is ours with it somewhere.
    expect(run.merged).toContain(MARK);
    expect(run.merged.replace(MARK, '')).toBe(rewrite);
    expect(coarse[0]?.theirs).toBe('chars');
    expect(['lines', 'span']).toContain(coarse[0]?.ours);
  });

  it('merges an edit with a rewrite in under 300 ms, keeping the edit', () => {
    const coarse: Paths[] = [];
    const run = timedMerge(base, edited, rewrite, (paths) => coarse.push(paths));
    expect(run.ms).toBeLessThan(300);
    expect(run.merged.replace(MARK, '')).toBe(rewrite);
    expect(coarse[0]?.ours).toBe('chars');
    expect(['lines', 'span']).toContain(coarse[0]?.theirs);
  });

  it.each([
    ['rewritten with other words', base, rewrite, note(3, 20_000)],
    // Lines from a few hundred possible ones: the line diff can't be skipped and can't finish.
    ['short lines, all shuffled', note(4, 20_000, 2), note(5, 20_000, 2), note(6, 20_000, 2)],
  ])('%s on both sides: under 300 ms', (_name, from, ours, theirs) => {
    // Both diffs share one budget: each with its own would take twice as long.
    expect(timedMerge(from, ours, theirs).ms).toBeLessThan(300);
  });

  it('keeps both rewrites whole, theirs first, when they share nothing with the base', () => {
    // Nothing kept on either side — not a line, not the first or the last
    // character: whatever step each diff takes, it replaces the whole base,
    // and both replacements stand at its start.
    const latin = note(11, 20_000, 12, WORDS.slice(0, 13)).slice(0, -1);
    const cyrillic = note(12, 20_000, 12, WORDS.slice(13, 18)).slice(0, -1);
    const emoji = note(13, 20_000, 12, WORDS.slice(18)).slice(0, -1);
    const run = timedMerge(latin, cyrillic, emoji);
    expect(run.ms).toBeLessThan(300);
    expect(run.merged).toBe(emoji + cyrillic);
  });

  it('merges edits outside the rewritten part exactly', () => {
    const head = note(7, 1_000);
    const middle = note(8, 20_000);
    const tail = note(9, 1_000);
    const newMiddle = note(10, 20_000);
    const ours = head + newMiddle + tail;
    const theirHead = head.replace(/\S+/, 'HEAD');
    const theirTail = insertAt(tail, lineStartAfter(tail, 500), MARK);
    const run = timedMerge(head + middle + tail, ours, theirHead + middle + theirTail);
    expect(run.ms).toBeLessThan(300);
    expect(run.merged).toBe(theirHead + newMiddle + theirTail);
  });

  it('returns the one side that changed, whatever its size', () => {
    expect(mergeText3(base, rewrite, base)).toBe(rewrite);
    expect(mergeText3(base, base, rewrite)).toBe(rewrite);
    expect(mergeText3(base, rewrite, rewrite)).toBe(rewrite);
  });
});

describe('mergeText3: coarse steps', () => {
  it.each([
    ['lines', LINES],
    ['one span', SPAN],
  ] as const)(
    '%s: independent edits on separate halves merge exactly (seeded random)',
    (_name, limits) => {
      const random = mulberry32(20260927);
      const pick = (n: number): number => Math.floor(random() * n);
      const line = (): string => `${WORDS[pick(WORDS.length)] ?? ''} ${pick(100)}\n`;
      const lines = (n: number): string[] => Array.from({ length: n }, line);
      const edit = (src: string[]): string[] => {
        const out = [...src];
        for (let i = 1 + pick(4); i > 0; i--) {
          const at = pick(out.length + 1);
          if (pick(2) === 0 || out.length === 0) out.splice(at, 0, line());
          else out[Math.min(at, out.length - 1)] = line();
        }
        return out;
      };
      const SEP = '=====SEPARATOR=====\n';
      for (let round = 0; round < 200; round++) {
        const top = lines(pick(8));
        const bottom = lines(pick(8));
        const ourTop = edit(top).join('');
        const theirBottom = edit(bottom).join('');
        const base = top.join('') + SEP + bottom.join('');
        const ours = ourTop + SEP + bottom.join('');
        const theirs = top.join('') + SEP + theirBottom;
        expect(mergeText3(base, ours, theirs, { limits })).toBe(ourTop + SEP + theirBottom);
      }
    },
  );

  it('reports the steps of a coarse merge once', () => {
    const coarse: Paths[] = [];
    mergeText3('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\nd\n', {
      limits: LINES,
      onCoarse: (paths) => coarse.push(paths),
    });
    expect(coarse).toEqual([{ ours: 'lines', theirs: 'lines' }]);
  });

  it('keeps every edit and never cuts a surrogate pair (seeded random)', () => {
    const random = mulberry32(5);
    // Pairs sharing a high half (😀😁) or a low one (😀🨀), and plain text.
    const alphabet = ['😀', '😁', '🨀', 'a', 'b', '\n'];
    const text = (n: number): string =>
      Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let round = 0; round < 300; round++) {
      const base = text(Math.floor(random() * 16));
      const ours = text(Math.floor(random() * 16));
      const at = Array.from(base)
        .slice(0, Math.floor(random() * 8))
        .join('').length;
      const theirs = insertAt(base, at, MARK);
      // One span: their insert stays an insert, so the result is ours with it.
      const bySpan = mergeText3(base, ours, theirs, { limits: SPAN });
      expect(bySpan).not.toMatch(lonely);
      expect(bySpan.replace(MARK, '')).toBe(ours);
      // Lines: their insert replaces its line, so that line may come back.
      const byLines = mergeText3(base, ours, theirs, { limits: LINES });
      expect(byLines).not.toMatch(lonely);
      expect(byLines).toContain(MARK);
    }
  });
});

describe('mergeText3: one time budget', () => {
  // `Date.now()` ticking 1 ms per read: jsdiff reads it once per edit length it
  // tries, so a time budget becomes a number of edit lengths — deterministic.
  let spy: jest.SpiedFunction<typeof Date.now>;
  beforeEach(() => {
    let now = 1_000_000;
    spy = jest.spyOn(Date, 'now').mockImplementation(() => now++);
  });
  afterEach(() => spy.mockRestore());

  // 300 lines, each edited: 300 characters to insert, 600 lines to replace.
  const base = Array.from({ length: 300 }, (_v, i) => `line ${i}\n`).join('');
  const everyLine = base.replace(/^(?=.)/gm, 'x');
  const appended = `${base}tail\n`;
  const limits: TextDiffLimits = { chars: 1e9, lines: 1e9, timeoutMs: 1_000 };

  it.each([
    ['ours', everyLine, appended, { ours: 'lines', theirs: 'chars' }],
    ['theirs', appended, everyLine, { ours: 'chars', theirs: 'lines' }],
  ] as const)(
    'characters get a quarter each; the rest goes to the side that needs lines (%s edits every line)',
    (_side, ours, theirs, paths) => {
      // Characters: 250 edit lengths, short of 300. Lines: the ~740 left — half
      // of it would be short of 600 and give a span.
      const coarse: Paths[] = [];
      const merged = mergeText3(base, ours, theirs, {
        limits,
        onCoarse: (reported) => coarse.push(reported),
      });
      expect(coarse).toEqual([paths]);
      expect(merged).toBe(`${everyLine}tail\n`);
    },
  );

  it('two sides that need lines share what is left', () => {
    // Ours reverses 400 lines: nothing for characters to skip, and ~800 lines
    // to replace — more than the whole budget. Theirs appends 100 lines: too
    // many characters to try, 100 lines to insert. Sharing, theirs gets ~370
    // edit lengths and makes it; after ours, it would get none.
    const lines = Array.from({ length: 400 }, (_v, i) => `line ${i}\n`);
    const from = lines.join('');
    const reversed = [...lines].reverse().join('');
    const added = Array.from({ length: 100 }, (_v, i) => `added line ${i}\n`).join('');
    const coarse: Paths[] = [];
    const merged = mergeText3(from, reversed, from + added, {
      limits: { chars: 1_000, lines: 1e9, timeoutMs: 1_000 },
      onCoarse: (reported) => coarse.push(reported),
    });
    expect(coarse).toEqual([{ ours: 'span', theirs: 'lines' }]);
    expect(merged).toBe(reversed + added);
  });
});

/** `mergeText3`, timed: the fastest of three runs, in ms, with its result. */
function timedMerge(
  base: string,
  ours: string,
  theirs: string,
  onCoarse?: (paths: Paths) => void,
): { ms: number; merged: string } {
  let best = { ms: Infinity, merged: '' };
  for (let i = 0; i < 3; i++) {
    const coarse: Paths[] = [];
    const started = performance.now();
    const merged = mergeText3(base, ours, theirs, { onCoarse: (paths) => coarse.push(paths) });
    const ms = performance.now() - started;
    if (i === 0) coarse.forEach((paths) => onCoarse?.(paths));
    if (ms < best.ms) best = { ms, merged };
  }
  return best;
}

function insertAt(text: string, at: number, insert: string): string {
  return text.slice(0, at) + insert + text.slice(at);
}

/** Where the first line starting at or after `at` begins: never inside a surrogate pair. */
function lineStartAfter(text: string, at: number): number {
  return text.indexOf('\n', at) + 1;
}

/** A note of about `size` characters: lines of 1 to `wordsPerLine` random words. */
function note(seed: number, size: number, wordsPerLine = 12, words = WORDS): string {
  const random = mulberry32(seed);
  let out = '';
  while (out.length < size) {
    const count = 1 + Math.floor(random() * wordsPerLine);
    const line: string[] = [];
    for (let i = 0; i < count; i++) line.push(words[Math.floor(random() * words.length)] ?? '');
    out += `${line.join(' ')}\n`;
  }
  return out;
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
