/**
 * E1. The server applied an operation and its answer was lost: the connection
 * dropped right after it came. On the next connection the device asks
 * `ops:status`, which says applied, and takes the answer in — nothing is sent
 * again, no conflict copy. The same when the process dies while the answer is
 * on its way (MANUAL-TEST S18, step 6): the restart finds the operation in
 * `state.json` and asks.
 */
import { expectConverged } from './converged';
import { eventually } from './eventually';
import type { LiveClient } from './live-client';
import { openTeam, type Team } from './team';

let team: Team | null = null;

afterEach(async () => {
  await team?.close();
  team = null;
});

const APPLIED = { asked: 1, applied: 1, voided: 0 };

async function twoDevices(): Promise<[LiveClient, LiveClient]> {
  team = await openTeam([
    { name: 'A', member: 0 },
    { name: 'B', member: 1 },
  ]);
  return team.devices as [LiveClient, LiveClient];
}

describe('E1: an answer lost after the server applied the operation', () => {
  it('a create and a rename are applied once; ops:status says applied', async () => {
    const [a, b] = await twoDevices();
    const { stand, projectId } = team!;

    let checks = a.queueChecks().length;
    const lostCreate = a.chaos.dropAck('file:create', (p) => p.filePath === 'n.md');
    a.write('n.md', 'v1\n');
    const created = await lostCreate;
    await eventually(() => expect(a.queueChecks().slice(checks)).toEqual([APPLIED]));
    await expectConverged(stand, projectId, [a, b]);
    const creates = (await stand.ops(projectId)).filter((op) => op.opType === 'CREATE');
    expect(creates.map((op) => [op.filePath, op.clientId, op.opId])).toEqual([
      ['n.md', a.clientId, created.opId],
    ]);

    // The note goes on syncing after it.
    a.write('n.md', 'v1\nv2\n');
    await eventually(() => expect(b.text('n.md')).toBe('v1\nv2\n'));

    checks = a.queueChecks().length;
    const lostRename = a.chaos.dropAck('file:rename', (p) => p.filePath === 'n.md');
    await a.rename('n.md', 'm.md');
    const renamed = await lostRename;
    await eventually(() => expect(a.queueChecks().slice(checks)).toEqual([APPLIED]));
    await expectConverged(stand, projectId, [a, b]);
    const renames = (await stand.ops(projectId)).filter((op) => op.opType === 'RENAME');
    expect(renames.map((op) => [op.filePath, op.newPath, op.opId])).toEqual([
      ['n.md', 'm.md', renamed.opId],
    ]);
    expect(b.text('m.md')).toBe('v1\nv2\n');
  });

  it('the process dies while the answer of a create is on its way (S18, step 6)', async () => {
    const [a, b] = await twoDevices();
    const { stand, projectId } = team!;

    const checks = a.queueChecks().length;
    const held = a.chaos.holdAck('file:create', (p) => p.filePath === 'c.md');
    a.write('c.md', 'written before the crash\n');
    await held.answered;
    await a.crashRestart();

    await eventually(() => expect(a.queueChecks().slice(checks)).toEqual([APPLIED]));
    await expectConverged(stand, projectId, [a, b]);
    const creates = (await stand.ops(projectId)).filter((op) => op.opType === 'CREATE');
    expect(creates.map((op) => op.filePath)).toEqual(['c.md']);
    expect(b.text('c.md')).toBe('written before the crash\n');
  });
});
