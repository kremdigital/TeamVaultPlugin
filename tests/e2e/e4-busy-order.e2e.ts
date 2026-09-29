/**
 * E4. Order after `busy`, on the server's real barrier. A teammate's operation
 * holds the project queue; the device deletes x.md and gets `busy`. The
 * teammate's operation then goes through and the queue is free again — the
 * connection's barrier is gone — before the device's delete is sent again.
 * Now the user renames y.md to x.md. The rename has to wait behind the refused
 * delete, on the same connection: sent at once, it would reach x.md while x.md
 * is still there and land on a conflict name, and the delete would then take
 * x.md away.
 *
 * No clock decides the order: the teammate's journal insert is held until the
 * test lets it go, and the device's delete gets `busy` at the queue's deadline.
 * The device tries its queue again only after 4 s, long after the rename.
 */
import { expectConverged, rowOf } from './converged';
import { eventually } from './eventually';
import { SERVER_BUSY, type LiveClient } from './live-client';
import { openTeam, type Team } from './team';

let team: Team | null = null;

afterEach(async () => {
  await team?.stand.fault({ kind: 'clear' });
  await team?.close();
  team = null;
});

describe('E4: order after busy', () => {
  it('a rename onto the name of a refused delete waits for it: x.md, no conflict copy', async () => {
    team = await openTeam([
      { name: 'A', member: 0, queueRetryMs: [4000, 1000] },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId } = team;
    a.write('x.md', 'x\n');
    a.write('y.md', 'y\n');
    await eventually(() => expect(b.paths()).toEqual(['x.md', 'y.md']));
    await a.settled();

    // The teammate's create holds the project queue.
    await stand.fault({ kind: 'hold-journal', projectId, filePath: 'blocker.md' });
    await stand.fault({ kind: 'queue-deadline', ms: 1000 });
    b.write('blocker.md', 'b\n');
    await eventually(async () => expect(await stand.journalWaiters()).toBeGreaterThan(0));

    a.remove('x.md');
    await eventually(() =>
      expect(a.chaos.answers('file:delete', (p) => p.filePath === 'x.md')).toContainEqual({
        ok: false,
        error: 'busy',
      }),
    );

    // The queue goes past the teammate's create and the refused delete.
    await stand.fault({ kind: 'release-journal' });
    await eventually(async () =>
      expect((await stand.liveFiles(projectId)).map((f) => f.path)).toContain('blocker.md'),
    );
    await stand.fault({ kind: 'clear' });

    // The refused delete still waits for its retry: new changes go behind it.
    expect(a.detail).toBe(SERVER_BUSY);
    expect(a.queue().map((op) => `${op.opType} ${op.filePath}`)).toEqual(['DELETE x.md']);
    await a.rename('y.md', 'x.md');

    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['blocker.md', 'x.md']);
    expect(b.text('x.md')).toBe('y\n');
    const mine = (await stand.ops(projectId))
      .filter((op) => op.clientId === a.clientId && op.opType !== 'CREATE')
      .map(rowOf);
    expect(mine).toEqual(['DELETE x.md', 'RENAME y.md -> x.md']);
  });
});
