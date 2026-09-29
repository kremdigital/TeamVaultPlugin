/**
 * E9. One user on two devices: the same API key, a client id each. The server
 * checks `ops:status` by author and a device knows its own operations by client
 * id, so this is where the two could mix up. Each device's operations stay its
 * own: a lost answer is settled on the device that sent it, the other takes the
 * change as a teammate's, and neither takes the other for a copy of itself.
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

describe('E9: one user on two devices', () => {
  it('edits, a lost answer, a delete and the same note made on both', async () => {
    team = await openTeam(
      [
        { name: 'laptop', member: 0 },
        { name: 'desktop', member: 0 },
      ],
      1,
    );
    const [laptop, desktop] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId, project } = team;

    laptop.write('n.md', 'from the laptop\n');
    await eventually(() => expect(desktop.text('n.md')).toBe('from the laptop\n'));
    desktop.write('n.md', 'from the laptop\nand the desktop\n');
    await eventually(() => expect(laptop.text('n.md')).toBe('from the laptop\nand the desktop\n'));

    const checks = laptop.queueChecks().length;
    const lost = laptop.chaos.dropAck('file:rename', (p) => p.filePath === 'n.md');
    await laptop.rename('n.md', 'm.md');
    await lost;
    await eventually(() =>
      expect(laptop.queueChecks().slice(checks)).toEqual([{ asked: 1, applied: 1, voided: 0 }]),
    );
    await eventually(() => expect(desktop.paths()).toEqual(['m.md']));
    // The desktop took the rename as another device's, not as its own.
    expect(desktop.queueChecks()).toEqual([]);

    desktop.remove('m.md');
    await eventually(() => expect(laptop.paths()).toEqual([]));

    laptop.write('same.md', 'the same text\n');
    desktop.write('same.md', 'the same text\n');

    await expectConverged(stand, projectId, [laptop, desktop]);
    expect(laptop.paths()).toEqual(['same.md']);
    const ops = await stand.ops(projectId);
    const owner = project.members[0]!.userId;
    expect(new Set(ops.map((op) => op.authorId))).toEqual(new Set([owner]));
    expect(ops.map((op) => `${op.opType} ${op.filePath} ${String(op.clientId)}`)).toEqual([
      `CREATE n.md ${laptop.clientId}`,
      `RENAME n.md ${laptop.clientId}`,
      `DELETE m.md ${desktop.clientId}`,
      expect.stringMatching(/^CREATE same\.md /),
      expect.stringMatching(/^CREATE same\.md /),
    ]);
  });
});
