import { diffChars } from 'diff';

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
 */
export function mergeText3(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;

  const ourEdits = editsFrom(base, ours);
  const theirEdits = editsFrom(base, theirs);

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
 * Turn a character diff into replacements over `base`. Adjacent removed and
 * added parts collapse into one edit, so a replaced word is a single edit
 * rather than a delete and an insert that could be merged apart.
 */
function editsFrom(base: string, next: string): Edit[] {
  const edits: Edit[] = [];
  let pos = 0;
  for (const part of diffChars(base, next)) {
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

function combineInserts(theirs: string, ours: string): string {
  return theirs === ours ? theirs : theirs + ours;
}
