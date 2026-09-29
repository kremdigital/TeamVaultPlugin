/**
 * E7. A folder deleted with what is in it — a note, an attachment, a note in a
 * subfolder. Obsidian reports each file and folder and the folder last, one
 * after another; the device sends one delete per file, each naming the folder
 * that went with it (`folder`). The teammate's device removes the folder,
 * emptied, with its subfolder — and keeps it when a file it does not sync is
 * still in it.
 */
import { expectConverged, fileIdOf } from './converged';
import { eventually } from './eventually';
import type { LiveClient } from './live-client';
import { openTeam, type Team } from './team';

let team: Team | null = null;

afterEach(async () => {
  await team?.close();
  team = null;
});

const FOLDER = 'живая';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function folderOnBoth(): Promise<[LiveClient, LiveClient]> {
  team = await openTeam([
    { name: 'A', member: 0 },
    { name: 'B', member: 1 },
  ]);
  const [a, b] = team.devices as [LiveClient, LiveClient];
  a.write(`${FOLDER}/n.md`, 'a note\n');
  a.writeBinary(`${FOLDER}/img.png`, PNG);
  a.write(`${FOLDER}/sub/c.md`, 'in the subfolder\n');
  a.write('keep.md', 'outside the folder\n');
  await expectConverged(team.stand, team.projectId, [a, b]);
  expect([...b.vault.folders].sort()).toEqual([FOLDER, `${FOLDER}/sub`]);
  return [a, b];
}

describe('E7: a folder deleted with what is in it', () => {
  it('one delete per file, and the emptied folder goes from the teammate’s disk', async () => {
    const [a, b] = await folderOnBoth();
    const { stand, projectId } = team!;
    const rows = (await stand.ops(projectId)).length;

    a.removeFolder(FOLDER);

    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['keep.md']);
    await eventually(() => expect([...b.vault.folders]).toEqual([]));
    const deletes = (await stand.ops(projectId)).slice(rows);
    expect(deletes.map((op) => [op.opType, op.filePath, op.payload.folder]).sort()).toEqual([
      ['DELETE', `${FOLDER}/img.png`, FOLDER],
      ['DELETE', `${FOLDER}/n.md`, FOLDER],
      ['DELETE', `${FOLDER}/sub/c.md`, FOLDER],
    ]);
    expect(new Set(deletes.map(fileIdOf)).size).toBe(3);
  });

  it('a folder that still holds a file the teammate does not sync stays there', async () => {
    const [a, b] = await folderOnBoth();
    const { stand, projectId } = team!;
    // A dotted file: never synced (`isAlwaysIgnored`), still on B's disk.
    b.vault.files.set(`${FOLDER}/sub/.local`, new Uint8Array([1]).buffer);

    a.removeFolder(FOLDER);

    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['keep.md', `${FOLDER}/sub/.local`]);
    expect([...b.vault.folders].sort()).toEqual([FOLDER, `${FOLDER}/sub`]);
  });
});
