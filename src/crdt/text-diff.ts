import { diffChars } from 'diff';
import * as Y from 'yjs';

/**
 * Apply a string-level diff to a `Y.Text` so that its contents become equal
 * to `newContent`. We use char-level diff (`jsdiff`) and translate the
 * result into `insert` / `delete` calls — wrapped in a single `transact`
 * so subscribers see one Yjs update instead of N.
 *
 * Why we don't just `delete-all + insert`: a wholesale rewrite would
 * generate one massive Yjs update on every disk-side edit, which loses
 * the structural advantage of CRDT (per-character operations merge cleanly
 * with concurrent edits in the editor; a wholesale replace would step on
 * any in-flight typing).
 *
 * The `origin` argument is forwarded to `transact` so consumers (e.g. the
 * doc manager) can distinguish disk-driven mutations from editor input.
 */
export function applyTextDiff(ytext: Y.Text, newContent: string, origin?: unknown): void {
  // `toJSON()` is `toString()` under a name the typings declare.
  const oldContent = ytext.toJSON();
  if (oldContent === newContent) return;

  const parts = diffChars(oldContent, newContent);
  const doc = ytext.doc;

  const apply = (): void => {
    let cursor = 0;
    for (const part of parts) {
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

  if (doc) {
    doc.transact(apply, origin);
  } else {
    apply();
  }
}
