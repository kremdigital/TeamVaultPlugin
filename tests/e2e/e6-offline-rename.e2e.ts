/**
 * E6 (MANUAL-TEST S18, step 6, in part). Renames made offline: a note created
 * and renamed goes up once under its last name, and a note the teammate edits
 * meanwhile keeps the edit under its new name — no duplicate, no conflict copy.
 *
 * The same for a note renamed the moment it is made, as a template does, with
 * no wait for the plugin in between: online and offline. The rename can come
 * before the create looked for the file, while it reads it, or once it is
 * sent or queued; whichever it is, the note goes up once, under its new name,
 * and no handler fails.
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

describe('E6: renames made offline', () => {
  it('a new note under its last name, a teammate’s edit under the new name', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId } = team;
    a.write('a.md', 'alpha\n');
    await eventually(() => expect(b.text('a.md')).toBe('alpha\n'));
    await a.settled();

    a.net.offline();
    await eventually(() => expect(a.status).not.toBe('connected'));
    a.write('e.md', 'made offline\n');
    await a.handled();
    await a.rename('e.md', 'e2.md');
    await a.rename('a.md', 'b.md');
    b.write('a.md', 'alpha\nfrom B\n');
    await b.settled();
    await eventually(async () =>
      expect((await stand.texts(projectId))['a.md']).toContain('from B'),
    );

    a.net.online();
    await expectConverged(stand, projectId, [a, b]);
    expect(a.paths()).toEqual(['b.md', 'e2.md']);
    expect(a.text('b.md')).toBe('alpha\nfrom B\n');
    expect(b.text('e2.md')).toBe('made offline\n');
    const ops = await stand.ops(projectId);
    expect(ops.some((op) => op.filePath === 'e.md' || op.newPath === 'e.md')).toBe(false);
  });

  it('a note renamed the moment it is made goes up once, under its new name', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId } = team;

    a.write('Untitled.md', 'made by a template\n');
    await a.rename('Untitled.md', 'Meeting.md');
    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['Meeting.md']);
    expect(b.text('Meeting.md')).toBe('made by a template\n');

    a.net.offline();
    await eventually(() => expect(a.status).not.toBe('connected'));
    a.write('Untitled.md', 'made offline\n');
    await a.rename('Untitled.md', 'Offline.md');
    a.net.online();
    await expectConverged(stand, projectId, [a, b]);
    expect(b.paths()).toEqual(['Meeting.md', 'Offline.md']);
    expect(b.text('Offline.md')).toBe('made offline\n');
    const ops = await stand.ops(projectId);
    expect(ops.filter((op) => op.opType === 'CREATE')).toHaveLength(2);
  });
});
