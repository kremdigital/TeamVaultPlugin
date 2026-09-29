/**
 * E2. An operation never reached the server: the connection dropped as it
 * went out. On the next connection `ops:status` voids its id, and the device
 * sends it again under a new one. The lost packet, reaching the server late on
 * a connection of its own, is refused (`op_voided`) and changes nothing.
 */
import { expectConverged } from './converged';
import { eventually } from './eventually';
import { ghostEmit } from './chaos';
import type { LiveClient } from './live-client';
import { openTeam, type Team } from './team';

let team: Team | null = null;

afterEach(async () => {
  await team?.close();
  team = null;
});

describe('E2: a packet that never reached the server', () => {
  it('is voided and sent again under a new id; the late packet is refused', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId, project } = team;
    a.write('r1.md', 'renamed while the packet was lost\n');
    await eventually(() => expect(b.paths()).toEqual(['r1.md']));
    await a.settled();

    const checks = a.queueChecks().length;
    const lost = a.chaos.dropEmit('file:rename', (p) => p.filePath === 'r1.md');
    await a.rename('r1.md', 'r2.md');
    const packet = await lost;
    await eventually(() =>
      expect(a.queueChecks().slice(checks)).toEqual([{ asked: 1, applied: 0, voided: 1 }]),
    );
    await expectConverged(stand, projectId, [a, b]);
    const renames = (await stand.ops(projectId)).filter((op) => op.opType === 'RENAME');
    expect(renames.map((op) => [op.filePath, op.newPath, op.clientId])).toEqual([
      ['r1.md', 'r2.md', a.clientId],
    ]);
    expect(renames[0]?.opId).not.toBe(packet.opId);

    const late = await ghostEmit(stand.url, project.members[0]!.apiKey, 'file:rename', packet);
    expect(late).toEqual({ ok: false, error: 'op_voided' });
    expect((await stand.ops(projectId)).filter((op) => op.opType === 'RENAME')).toHaveLength(1);
    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['r2.md']);
  });
});
