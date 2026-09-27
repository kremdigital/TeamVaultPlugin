import {
  TEXT_DIFF_LIMITS,
  diffTextByChars,
  diffTextCoarsely,
  type TextChange,
  type TextDiffLimits,
  type TextDiffPath,
} from './text-diff';

/** Options of {@link mergeText3}. */
export interface MergeOptions {
  /** Limits of each side's diff against the base (see `diffText`). */
  limits?: TextDiffLimits;
  /**
   * Called when a side's diff against the base went past the character diff —
   * to lines or to one span: a large rewrite. The merge is coarse then: the
   * other side's edits inside the rewritten part keep their text, but not
   * necessarily their place. The caller logs it.
   */
  onCoarse?: (paths: { ours: TextDiffPath; theirs: TextDiffPath }) => void;
}

/**
 * Three-way text merge: `base` is the common ancestor, `ours` and `theirs`
 * are two independent edits of it, and the result carries both.
 *
 * The engine needs this when a note changed on BOTH sides of the disk↔CRDT
 * bridge at once — the user saved an edit (disk) while a teammate's edit
 * was already in the `Y.Doc` but not yet written to disk. A two-way diff of
 * the doc against the disk can't tell those apart: everything the disk lacks
 * looks like a local deletion, so the teammate's edit was deleted from the
 * CRDT and the deletion shipped to the server.
 *
 * Semantics mirror concurrent CRDT edits rather than a conflict-marker diff3:
 * a base character survives only if neither side deleted it, and inserted
 * text from both sides is kept. At the same position `theirs` goes first,
 * except that an identical insert is kept once — that's the same text
 * reaching both sides through two channels, not two people typing it. Only
 * exact duplicates collapse: a remote `"\n"` next to a local `"\nmore"` is
 * two edits, and treating the shorter as a prefix of the longer would drop it.
 *
 * Each side is diffed against the base within `options.limits` (see
 * `diffText`): a character diff for edits, lines or one span for a
 * rewrite. So a rewritten note merges in bounded time rather than freezing
 * Obsidian for seconds — both diffs together take at most `timeoutMs` — and
 * the merge still holds every edit of both sides; only its placement inside
 * a rewritten part is coarser. `options.onCoarse` reports that case.
 */
export function mergeText3(
  base: string,
  ours: string,
  theirs: string,
  options: MergeOptions = {},
): string {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;

  // One time budget for both diffs. Each side tries characters first, with up
  // to a quarter of it: an edit takes a moment. The rest goes to the sides
  // that need lines — a rewrite, usually one of the two — shared if both do.
  const limits = options.limits ?? TEXT_DIFF_LIMITS;
  const deadline = Date.now() + limits.timeoutMs;
  const ourChars = diffTextByChars(base, ours, limits, limits.timeoutMs / 4);
  const theirChars = diffTextByChars(base, theirs, limits, limits.timeoutMs / 4);
  const ourDiff =
    ourChars ?? diffTextCoarsely(base, ours, limits, theirChars ? deadline : halfwayTo(deadline));
  const theirDiff = theirChars ?? diffTextCoarsely(base, theirs, limits, deadline);
  if (isCoarse(ourDiff.path) || isCoarse(theirDiff.path)) {
    options.onCoarse?.({ ours: ourDiff.path, theirs: theirDiff.path });
  }
  const ourEdits = editsFrom(ourDiff.changes);
  const theirEdits = editsFrom(theirDiff.changes);

  const coverage = new Map<number, number>();
  const bump = (pos: number, delta: number): void => {
    coverage.set(pos, (coverage.get(pos) ?? 0) + delta);
  };
  const inserts = new Map<number, { ours: string; theirs: string }>();
  const addInsert = (pos: number, side: 'ours' | 'theirs', text: string): void => {
    const slot = inserts.get(pos) ?? { ours: '', theirs: '' };
    slot[side] += text;
    inserts.set(pos, slot);
  };
  const boundaries = new Set<number>([0, base.length]);
  const register = (edit: Edit, side: 'ours' | 'theirs'): void => {
    boundaries.add(edit.start);
    boundaries.add(edit.end);
    if (edit.end > edit.start) {
      bump(edit.start, 1);
      bump(edit.end, -1);
    }
    if (edit.text.length > 0) addInsert(edit.start, side, edit.text);
  };
  for (const edit of ourEdits) register(edit, 'ours');
  for (const edit of theirEdits) register(edit, 'theirs');

  const points = [...boundaries].sort((a, b) => a - b);
  let out = '';
  let deleting = 0;
  for (let i = 0; i < points.length; i++) {
    const pos = points[i] ?? 0;
    deleting += coverage.get(pos) ?? 0;
    const slot = inserts.get(pos);
    if (slot) out += combineInserts(slot.theirs, slot.ours);
    const next = points[i + 1];
    if (next !== undefined && next > pos && deleting === 0) out += base.slice(pos, next);
  }
  return out;
}

/** Replace `base[start, end)` with `text`, in base coordinates. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Turn a diff of `base` into replacements over it. Adjacent removed and
 * added parts collapse into one edit, so a replaced word is a single edit
 * rather than a delete and an insert that could be merged apart.
 */
function editsFrom(changes: readonly TextChange[]): Edit[] {
  const edits: Edit[] = [];
  let pos = 0;
  for (const part of changes) {
    const len = part.value.length;
    if (!part.added && !part.removed) {
      pos += len;
      continue;
    }
    const last = edits[edits.length - 1];
    const extend = last !== undefined && last.end === pos;
    if (part.added) {
      if (extend) last.text += part.value;
      else edits.push({ start: pos, end: pos, text: part.value });
    } else {
      if (extend) last.end += len;
      else edits.push({ start: pos, end: pos + len, text: '' });
      pos += len;
    }
  }
  return edits;
}

/** The `Date.now()` value halfway from now to `deadline`. */
function halfwayTo(deadline: number): number {
  const now = Date.now();
  return now + Math.max(0, deadline - now) / 2;
}

function isCoarse(path: TextDiffPath): boolean {
  return path === 'lines' || path === 'span';
}

function combineInserts(theirs: string, ours: string): string {
  return theirs === ours ? theirs : theirs + ours;
}
