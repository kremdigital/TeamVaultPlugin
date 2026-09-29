/**
 * The stand itself: two devices of two users sync a note, its edit, its rename
 * and its deletion through the real server.
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

describe('e2e stand', () => {
  it('a note travels from one device to the other and back', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];

    a.write('n.md', 'v1\n');
    await eventually(() => expect(b.text('n.md')).toBe('v1\n'));

    b.write('n.md', 'v1\nfrom B\n');
    await eventually(() => expect(a.text('n.md')).toBe('v1\nfrom B\n'));

    await a.rename('n.md', 'm.md');
    await eventually(() => expect(b.paths()).toEqual(['m.md']));

    b.remove('m.md');
    await eventually(() => expect(a.paths()).toEqual([]));

    await expectConverged(team.stand, team.projectId, team.devices);
  });
});
