/**
 * E3 (MANUAL-TEST S18, step 2). Sync is paused in the middle of a chain of
 * renames: the first rename is applied and its answer never comes, the next
 * one is made as the connection closes. A teammate renames the note meanwhile.
 * After resume nothing of the chain is applied twice, the note ends up under
 * the name of the last rename the server applied — whichever device made it —
 * and a note created while paused is created once.
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

describe('E3: pause in the middle of a chain of renames', () => {
  it('nothing is applied twice; the last rename on the server wins', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId } = team;
    a.write('r1.md', 'a chain of renames\n');
    await eventually(() => expect(b.paths()).toEqual(['r1.md']));
    await a.settled();

    const held = a.chaos.holdAck('file:rename', (p) => p.filePath === 'r1.md');
    await a.rename('r1.md', 'r2.md');
    await held.answered;
    await a.rename('r2.md', 'r3.md');
    a.pause();
    held.discard();
    a.write('paused.md', 'created while paused\n');

    // The teammate renames the note from wherever it has it, once it has what
    // the server has: r2.md, or r3.md if the second rename got out before the
    // connection closed. Either way, B's rename comes after A's on the server.
    const note = await eventually(async () => {
      await b.settled();
      const [file, ...more] = await stand.liveFiles(projectId);
      expect(more).toEqual([]);
      expect(b.paths()).toEqual([file!.path]);
      return file!;
    });
    await b.rename(note.path, 'r5.md');
    await b.settled();

    await a.resume();
    await expectConverged(stand, projectId, [a, b]);

    const ops = await stand.ops(projectId);
    expect(ops.filter((op) => op.newPath === 'r5.md').map((op) => op.clientId)).toEqual([
      b.clientId,
    ]);
    const renames = ops.filter((op) => op.opType === 'RENAME' && fileIdOf(op) === note.id);
    const live = await stand.liveFiles(projectId);
    expect(live.find((f) => f.id === note.id)?.path).toBe(renames.at(-1)?.newPath);
    expect(ops.filter((op) => op.opType === 'CREATE').map((op) => op.filePath)).toEqual([
      'r1.md',
      'paused.md',
    ]);
    expect(b.text('paused.md')).toBe('created while paused\n');
  });
});
