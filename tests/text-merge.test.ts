import { mergeText3 } from '@/crdt/text-merge';

describe('mergeText3', () => {
  it('returns the changed side when only one side changed', () => {
    expect(mergeText3('a\nb\n', 'a\nb\nc\n', 'a\nb\n')).toBe('a\nb\nc\n');
    expect(mergeText3('a\nb\n', 'a\nb\n', 'z\na\nb\n')).toBe('z\na\nb\n');
  });

  it('returns the shared result when both sides made the same change', () => {
    expect(mergeText3('a\n', 'a\nb\n', 'a\nb\n')).toBe('a\nb\n');
  });

  it('keeps a local append and a remote prepend (the reverted-edit incident shape)', () => {
    expect(mergeText3('v1\n', 'v1\nlocal line\n', 'remote line\nv1\n')).toBe(
      'remote line\nv1\nlocal line\n',
    );
  });

  it('applies non-overlapping edits from both sides', () => {
    const base = 'one\ntwo\nthree\nfour\n';
    const ours = 'one\n2\nthree\nfour\n';
    const theirs = 'one\ntwo\nthree\nfour\nfive\n';
    expect(mergeText3(base, ours, theirs)).toBe('one\n2\nthree\nfour\nfive\n');
  });

  it('deletes text removed by both sides only once', () => {
    const base = 'keep\ndrop\nkeep too\n';
    expect(mergeText3(base, 'keep\nkeep too\n', 'keep\nkeep too\n')).toBe('keep\nkeep too\n');
    expect(mergeText3(base, 'keep\nkeep too\nours\n', 'keep\nkeep too\n')).toBe(
      'keep\nkeep too\nours\n',
    );
  });

  it('keeps a local insert inside a range the remote side deleted', () => {
    const base = 'head\nmiddle part\ntail\n';
    const ours = 'head\nmiddle NEW part\ntail\n';
    const theirs = 'head\ntail\n';
    const merged = mergeText3(base, ours, theirs);
    expect(merged).toContain('NEW');
    expect(merged.startsWith('head\n')).toBe(true);
    expect(merged.endsWith('tail\n')).toBe(true);
  });

  it('keeps a remote insert inside a range the local side deleted', () => {
    const base = 'head\nmiddle part\ntail\n';
    const ours = 'head\ntail\n';
    const theirs = 'head\nmiddle REMOTE part\ntail\n';
    const merged = mergeText3(base, ours, theirs);
    expect(merged).toContain('REMOTE');
    expect(merged.startsWith('head\n')).toBe(true);
    expect(merged.endsWith('tail\n')).toBe(true);
  });

  it('keeps both inserts at the same position, remote first', () => {
    expect(mergeText3('a\n', 'a\nours\n', 'a\ntheirs\n')).toBe('a\ntheirs\nours\n');
  });

  it('does not treat a short remote insert as a prefix of a longer local one', () => {
    // Remote inserted a bare newline, local inserted a paragraph starting
    // with one — both are real edits.
    expect(mergeText3('x', 'x\nmore', 'x\n')).toBe('x\n\nmore');
  });

  it('keeps both replacements when both sides rewrote the same word', () => {
    const merged = mergeText3('the cat sat', 'the dog sat', 'the cow sat');
    expect(merged.startsWith('the ')).toBe(true);
    expect(merged.endsWith(' sat')).toBe(true);
    expect(merged).not.toContain('cat');
    // Nothing either side typed is lost.
    for (const ch of ['d', 'g', 'w']) expect(merged).toContain(ch);
  });

  it('preserves CRLF line endings', () => {
    expect(mergeText3('a\r\nb\r\n', 'a\r\nb\r\nc\r\n', 'z\r\na\r\nb\r\n')).toBe(
      'z\r\na\r\nb\r\nc\r\n',
    );
  });

  it('handles empty bases and results', () => {
    expect(mergeText3('', 'ours', '')).toBe('ours');
    expect(mergeText3('', '', 'theirs')).toBe('theirs');
    expect(mergeText3('gone', '', '')).toBe('');
    expect(mergeText3('gone\n', '', 'gone\nremote\n')).toBe('remote\n');
  });

  it('merges independent edits on separate halves exactly (seeded random)', () => {
    const random = mulberry32(20260916);
    const pick = (n: number): number => Math.floor(random() * n);
    const alphabet = 'abc de\n';
    const line = (): string => {
      let s = '';
      const len = 1 + pick(12);
      for (let i = 0; i < len; i++) s += alphabet[pick(alphabet.length)];
      return `${s.replace(/\n/g, '')}\n`;
    };
    const lines = (n: number): string[] => Array.from({ length: n }, line);
    const edit = (src: string[]): string[] => {
      const out = [...src];
      const ops = 1 + pick(4);
      for (let i = 0; i < ops; i++) {
        const at = pick(out.length + 1);
        switch (pick(3)) {
          case 0:
            out.splice(at, 0, line());
            break;
          case 1:
            if (out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
            break;
          default:
            if (out.length > 0) out[Math.min(at, out.length - 1)] = line();
        }
      }
      return out;
    };

    const SEP = '=====SEPARATOR=====\n';
    for (let round = 0; round < 300; round++) {
      const top = lines(pick(8));
      const bottom = lines(pick(8));
      const base = top.join('') + SEP + bottom.join('');
      const oursTop = edit(top).join('');
      const theirsBottom = edit(bottom).join('');
      const ours = oursTop + SEP + bottom.join('');
      const theirs = top.join('') + SEP + theirsBottom;
      expect(mergeText3(base, ours, theirs)).toBe(oursTop + SEP + theirsBottom);
    }
  });
});

/** Small seeded PRNG — keeps the randomized test deterministic. */
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
