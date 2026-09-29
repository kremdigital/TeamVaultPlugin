/**
 * E3 (MANUAL-TEST S18, step 2). Sync is paused in the middle of a chain of
 * renames: the first rename is applied and its answer never comes, the next
 * one is made as the connection closes. A teammate renames the note meanwhile.
 * After resume `ops:status` settles the first rename, and nothing of the chain
 * is applied twice: each device's renames of the note are on the server once
 * each, in the order made — the second one here got out before the connection
 * closed or goes out after resume, so the note ends up under whichever of its
 * name and the teammate's the server applied last. A note created while paused
 * is created once.
 *
 * Then the same chain with both renames applied before the pause, both answers
 * lost: `ops:status` settles both, nothing goes out again, and the teammate's
 * later rename stays. Sent again, the chain moved the note back to its name
 * for the whole team.
 */
import { expectConverged, fileIdOf } from './converged';
import { eventually } from './eventually';
import type { LiveClient } from './live-client';
import type { ServerOpRow } from './stand';
import { openTeam, type Team } from './team';

let team: Team | null = null;

afterEach(async () => {
  await team?.close();
  team = null;
});

/** Two devices of two users, and a note of A's both have. */
async function noteOnBoth(path: string): Promise<[LiveClient, LiveClient]> {
  team = await openTeam([
    { name: 'A', member: 0 },
    { name: 'B', member: 1 },
  ]);
  const [a, b] = team.devices as [LiveClient, LiveClient];
  a.write(path, 'a chain of renames\n');
  await eventually(() => expect(b.paths()).toEqual([path]));
  await a.settled();
  return [a, b];
}

/**
 * The names `device` renamed file `fileId` to, in the server's order. By the
 * name asked for: a row's `filePath` is where the server had the file.
 */
function renamesBy(ops: readonly ServerOpRow[], fileId: string, device: LiveClient): string[] {
  return ops
    .filter((op) => op.opType === 'RENAME' || op.opType === 'MOVE')
    .filter((op) => fileIdOf(op) === fileId && op.clientId === device.clientId)
    .map((op) => String(op.newPath));
}

/** What the checks of A's queue with the server after `mark` found applied. */
function appliedSince(device: LiveClient, mark: number): number {
  return (device.queueChecks().slice(mark) as Array<{ applied: number }>).reduce(
    (sum, check) => sum + check.applied,
    0,
  );
}

describe('E3: pause in the middle of a chain of renames', () => {
  it('nothing is applied twice; the last rename on the server wins', async () => {
    const [a, b] = await noteOnBoth('r1.md');
    const { stand, projectId } = team!;

    const held = a.chaos.holdAck('file:rename', (p) => p.filePath === 'r1.md');
    await a.rename('r1.md', 'r2.md');
    const first = await held.sent;
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

    const checks = a.queueChecks().length;
    await a.resume();
    await expectConverged(stand, projectId, [a, b]);

    // The first rename, its answer lost, is settled as applied: on the server
    // once, under its own id.
    await eventually(() => expect(appliedSince(a, checks)).toBeGreaterThanOrEqual(1));
    const ops = await stand.ops(projectId);
    expect(
      ops.filter((op) => op.opId === first.opId).map((op) => [op.opType, op.clientId]),
    ).toEqual([['RENAME', a.clientId]]);
    expect(renamesBy(ops, note.id, a)).toEqual(['r2.md', 'r3.md']);
    expect(renamesBy(ops, note.id, b)).toEqual(['r5.md']);
    expect(['r3.md', 'r5.md']).toContain(a.paths().find((p) => p !== 'paused.md'));
    expect(ops.filter((op) => op.opType === 'CREATE').map((op) => op.filePath)).toEqual([
      'r1.md',
      'paused.md',
    ]);
    expect(b.text('paused.md')).toBe('created while paused\n');
  });

  it('both renames applied, both answers lost: none goes out again', async () => {
    const [a, b] = await noteOnBoth('q1.md');
    const { stand, projectId } = team!;

    const held1 = a.chaos.holdAck('file:rename', (p) => p.filePath === 'q1.md');
    await a.rename('q1.md', 'q2.md');
    const first = await held1.sent;
    await held1.answered;
    const held2 = a.chaos.holdAck('file:rename', (p) => p.filePath === 'q2.md');
    await a.rename('q2.md', 'q3.md');
    const second = await held2.sent;
    await held2.answered;
    a.pause();
    held1.discard();
    held2.discard();

    await eventually(() => expect(b.paths()).toEqual(['q3.md']));
    await b.settled();
    await b.rename('q3.md', 'q5.md');
    await b.settled();

    const checks = a.queueChecks().length;
    await a.resume();
    await expectConverged(stand, projectId, [a, b]);

    await eventually(() => expect(appliedSince(a, checks)).toBe(2));
    const ops = await stand.ops(projectId);
    const [note] = await stand.liveFiles(projectId);
    for (const sent of [first, second]) {
      expect(
        ops.filter((op) => op.opId === sent.opId).map((op) => [op.opType, op.clientId]),
      ).toEqual([['RENAME', a.clientId]]);
    }
    expect(renamesBy(ops, note!.id, a)).toEqual(['q2.md', 'q3.md']);
    expect(renamesBy(ops, note!.id, b)).toEqual(['q5.md']);
    // The teammate's rename came last, and stays.
    expect(a.paths()).toEqual(['q5.md']);
  });
});
