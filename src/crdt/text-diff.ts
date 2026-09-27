import { diffChars, diffLines, lineDiff } from 'diff';
import * as Y from 'yjs';

/**
 * Limits of the staged text diff ({@link diffText}): the same steps and
 * numbers as the server's `editYText` (`Project/server`,
 * `src/lib/crdt/persistence.ts`), which writes REST and socket edits into a
 * note's history. Only the time differs: the server gives each step its own,
 * here the steps share it — the plugin diffs on Obsidian's UI thread.
 */
export interface TextDiffLimits {
  /** Characters (code points) a character diff may insert and delete in total. */
  chars: number;
  /** Lines a line diff — the first fallback — may insert and delete in total. */
  lines: number;
  /**
   * Time for one whole diff, every step together, ms. The character diff gets
   * up to half of it, the line diff the rest.
   */
  timeoutMs: number;
}

/**
 * A character diff (Myers) costs about the square of the number of edits: a
 * rewritten 20 KB note took over 20 s, on the UI thread, with Obsidian frozen.
 * An edit past these limits goes as a line diff, and past those as one span.
 */
export const TEXT_DIFF_LIMITS: Readonly<TextDiffLimits> = {
  chars: 1000,
  lines: 2000,
  timeoutMs: 250,
};

/**
 * Which step produced a diff: none needed, the character diff, the line diff,
 * or one span from the first difference to the last. The last two are coarse:
 * text they replace goes as a whole, even the parts that stayed.
 */
export type TextDiffPath = 'none' | 'chars' | 'lines' | 'span';

/** One part of a diff, as jsdiff reports it: kept, added or removed text. */
export interface TextChange {
  value: string;
  added: boolean;
  removed: boolean;
}

export interface TextDiff {
  path: TextDiffPath;
  /** The parts, left to right; applied in order they turn the old text into the new one. */
  changes: TextChange[];
}

/**
 * Diff `oldText` against `newText` within `limits`.
 *
 * The character diff first — within its limits it is exactly the diff jsdiff's
 * `diffChars` has always made here, so small edits don't change at all. Past
 * them, a line diff; past those, one span from the first difference to the
 * last. The applied result is always exactly `newText`, and no step cuts a
 * surrogate pair: jsdiff splits text into code points and lines, and the span
 * is aligned to code points (Yjs turns half a pair into U+FFFD).
 *
 * `timeoutMs` covers all the steps together. The character diff gets up to
 * half of it: on a rewrite it fails its edit limit only after tens of
 * milliseconds, more on a slow machine, and the line diff a rewrite needs
 * must still have time. A step that can't fit its edit limit is skipped
 * without running: the edits it would need are counted from below first.
 */
export function diffText(
  oldText: string,
  newText: string,
  limits: TextDiffLimits = TEXT_DIFF_LIMITS,
): TextDiff {
  const deadline = Date.now() + limits.timeoutMs;
  return (
    diffTextByChars(oldText, newText, limits, limits.timeoutMs / 2) ??
    diffTextCoarsely(oldText, newText, limits, deadline)
  );
}

/**
 * The first step of {@link diffText} alone: the character diff, if it fits
 * `limits.chars` within `timeoutMs`; `undefined` if not.
 */
export function diffTextByChars(
  oldText: string,
  newText: string,
  limits: TextDiffLimits,
  timeoutMs: number,
): TextDiff | undefined {
  if (oldText === newText) return { path: 'none', changes: [] };
  const ends = commonEnds(oldText, newText);
  const oldMiddle = oldText.slice(ends.start, ends.oldEnd);
  const newMiddle = newText.slice(ends.start, ends.newEnd);
  if (fewestEdits(oldMiddle, newMiddle) > limits.chars) return undefined;
  const chars = diffChars(oldText, newText, { maxEditLength: limits.chars, timeout: timeoutMs });
  return chars ? { path: 'chars', changes: chars } : undefined;
}

/**
 * The coarse steps of {@link diffText}, for an edit the character diff
 * couldn't take: the line diff, if it fits `limits.lines` before `deadline`
 * (a `Date.now()` value); one span if not.
 */
export function diffTextCoarsely(
  oldText: string,
  newText: string,
  limits: TextDiffLimits,
  deadline: number,
): TextDiff {
  if (oldText === newText) return { path: 'none', changes: [] };
  const left = deadline - Date.now();
  if (left > 0 && fewestEdits(lineTokens(oldText), lineTokens(newText)) <= limits.lines) {
    const lines = diffLines(oldText, newText, { maxEditLength: limits.lines, timeout: left });
    if (lines) return { path: 'lines', changes: lines };
  }
  return { path: 'span', changes: spanChanges(oldText, newText, commonEnds(oldText, newText)) };
}

/**
 * Apply a string-level diff to a `Y.Text` so that its contents become equal
 * to `newContent`. The diff comes from {@link diffText} and is translated into
 * `insert` / `delete` calls — wrapped in a single `transact` so subscribers
 * see one Yjs update instead of N.
 *
 * Why we don't just `delete-all + insert`: a wholesale rewrite would
 * generate one massive Yjs update on every disk-side edit, which loses
 * the structural advantage of CRDT (per-character operations merge cleanly
 * with concurrent edits in the editor; a wholesale replace would step on
 * any in-flight typing). Only an edit too large for a finer diff within
 * `limits` goes as lines or as one span (see {@link diffText}).
 *
 * The `origin` argument is forwarded to `transact` so consumers (e.g. the
 * doc manager) can distinguish disk-driven mutations from editor input.
 *
 * Returns the step the diff took (see {@link TextDiffPath}).
 */
export function applyTextDiff(
  ytext: Y.Text,
  newContent: string,
  origin?: unknown,
  limits: TextDiffLimits = TEXT_DIFF_LIMITS,
): TextDiffPath {
  // `toJSON()` is `toString()` under a name the typings declare.
  const { path, changes } = diffText(ytext.toJSON(), newContent, limits);
  if (path === 'none') return path;

  const apply = (): void => {
    let cursor = 0;
    for (const part of changes) {
      const len = part.value.length;
      if (part.added) {
        ytext.insert(cursor, part.value);
        cursor += len;
      } else if (part.removed) {
        ytext.delete(cursor, len);
        // cursor unchanged — what stood here is now gone.
      } else {
        cursor += len;
      }
    }
  };

  const doc = ytext.doc;
  if (doc) {
    doc.transact(apply, origin);
  } else {
    apply();
  }
  return path;
}

/** Where two texts stop agreeing: the common prefix and suffix, in UTF-16 units. */
interface CommonEnds {
  /** Length of the common prefix. */
  start: number;
  /** Where the common suffix starts in the old text. */
  oldEnd: number;
  /** Where the common suffix starts in the new text. */
  newEnd: number;
}

/**
 * The common prefix and suffix of two texts, not overlapping, and aligned to
 * code points: a pair that differs only in its low half is left out of the
 * prefix, one that differs only in its high half — out of the suffix.
 */
function commonEnds(oldText: string, newText: string): CommonEnds {
  const limit = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < limit && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1;
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start -= 1;
  let end = 0;
  while (
    end < limit - start &&
    oldText.charCodeAt(oldText.length - 1 - end) === newText.charCodeAt(newText.length - 1 - end)
  ) {
    end += 1;
  }
  if (end > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - end))) end -= 1;
  return { start, oldEnd: oldText.length - end, newEnd: newText.length - end };
}

/** Replace everything between the common ends in one piece: remove, then insert. */
function spanChanges(oldText: string, newText: string, ends: CommonEnds): TextChange[] {
  const { start, oldEnd, newEnd } = ends;
  const changes: TextChange[] = [];
  if (start > 0) changes.push({ value: oldText.slice(0, start), added: false, removed: false });
  if (oldEnd > start) {
    changes.push({ value: oldText.slice(start, oldEnd), added: false, removed: true });
  }
  if (newEnd > start) {
    changes.push({ value: newText.slice(start, newEnd), added: true, removed: false });
  }
  if (oldEnd < oldText.length) {
    changes.push({ value: oldText.slice(oldEnd), added: false, removed: false });
  }
  return changes;
}

/**
 * A lower bound on the inserts and deletes any diff of the two token
 * sequences needs: every token of one without a partner in the other must go.
 * One pass tells a large paste or deletion, or lines rewritten, from an edit;
 * a diff that fails its edit limit costs about the limit squared first.
 * Strings are walked by code points — the tokens of jsdiff's `diffChars`.
 */
function fewestEdits(oldTokens: Iterable<string>, newTokens: Iterable<string>): number {
  const unmatched = new Map<string, number>();
  let oldCount = 0;
  for (const token of oldTokens) {
    unmatched.set(token, (unmatched.get(token) ?? 0) + 1);
    oldCount += 1;
  }
  let newCount = 0;
  let matched = 0;
  for (const token of newTokens) {
    newCount += 1;
    const left = unmatched.get(token);
    if (left) {
      unmatched.set(token, left - 1);
      matched += 1;
    }
  }
  return oldCount + newCount - 2 * matched;
}

/** The tokens jsdiff's `diffLines` compares: lines with their line breaks. */
function lineTokens(text: string): string[] {
  return lineDiff.tokenize(text, {}).filter((line) => line.length > 0);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
