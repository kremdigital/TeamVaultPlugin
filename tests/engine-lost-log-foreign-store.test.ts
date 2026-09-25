/**
 * `state.json` lost (deleted by hand, or unreadable: the log is a cache and
 * starts empty) while the binding is kept. Meanwhile a teammate renamed
 * `Untitled.md` (f5) to `Plan.md` and created a new `Untitled.md` (f9) — the
 * usual Ctrl+N and a title. This device still has f5's copy on disk under
 * `Untitled.md`, and f5's history in the store under that name, stamped f5.
 *
 * Before: the store was found to be another file's and started anew, and the
 * copy on disk was then folded into f9 with no base — "disk content wins":
 * f9's text was replaced with f5's for the whole team.
 *
 * Now the copy is settled as the old history's: when the server has its text
 * — the file the history belonged to has it — it goes; otherwise it is kept
 * aside under a conflict name.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
  json,
  serverDocWith,
  serverFile,
  snapshotOf,
} from './engine-test-kit';

jest.setTimeout(30_000);

/** The stamp `DocManager` keeps with a store: the id of the file whose history it is. */
const OWNER = 'team-vault-file-id';

async function lostLog(copy: string): Promise<{ disk: string[]; f9: string; f5: string }> {
  const idb = new FakeIndexedDb();
  const f5 = serverDocWith('old note f5\n');
  idb.dbs.set(dbNameOf('Untitled.md'), {
    updates: [Y.encodeStateAsUpdate(f5)],
    custom: new Map([[OWNER, 'f5']]),
  });
  const f9 = serverDocWith('teammate new note f9\n');
  const h = buildHarness({ docs: idb.manager() });
  h.vault.files.set('Untitled.md', encode(copy));
  h.serverFiles = [
    serverFile('f5', 'Plan.md', 'TEXT', await sha256Hex('old note f5\n'), 12),
    serverFile('f9', 'Untitled.md', 'TEXT', await sha256Hex('teammate new note f9\n'), 21),
  ];
  h.routes.set('GET /api/projects/p1/files/f5/versions', () => json({ versions: [] }));
  h.routes.set('GET /api/projects/p1/files/f9/versions', () => json({ versions: [] }));

  await connect(h, { yjsDocs: [snapshotOf(f5, 'f5'), snapshotOf(f9, 'f9')] });
  await flushAsync(80);
  for (const e of h.socket().emits) {
    if (e.event !== 'yjs:update') continue;
    const p = e.payload as { fileId: string; update: Uint8Array };
    Y.applyUpdate(p.fileId === 'f9' ? f9 : f5, Uint8Array.from(p.update));
  }
  const disk = [...h.vault.files.keys()]
    .sort()
    .map((p) => `${p.replace(/conflict-\d+/, 'conflict-<ts>')}=${h.vault.text(p) ?? ''}`);
  await h.engine.stop();
  return { disk, f9: f9.getText('content').toJSON(), f5: f5.getText('content').toJSON() };
}

describe('SyncEngine — state.json lost, the store under a new note’s name stamped for another file', () => {
  it('keeps the new note’s text, and lets go of a copy the server has', async () => {
    const out = await lostLog('old note f5\n');

    expect(out.f9).toBe('teammate new note f9\n');
    expect(out.f5).toBe('old note f5\n');
    expect(out.disk).toEqual(['Plan.md=old note f5\n', 'Untitled.md=teammate new note f9\n']);
  });

  it('keeps the new note’s text, and keeps aside a copy with edits the server never got', async () => {
    const out = await lostLog('old note f5\nedited offline\n');

    expect(out.f9).toBe('teammate new note f9\n');
    expect(out.f5).toBe('old note f5\n');
    expect(out.disk).toEqual([
      'Plan.md=old note f5\n',
      'Untitled.conflict-<ts>.md=old note f5\nedited offline\n',
      'Untitled.md=teammate new note f9\n',
    ]);
  });
});
