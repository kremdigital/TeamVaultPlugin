/**
 * E5. Two devices of two users edit one note at the same time, online and
 * offline: both edits end up in the note on both. Offline, both also create
 * the same non-empty daily note (one note on the server) and an empty
 * `Untitled.md` each (one of them becomes a conflict copy: empty notes are
 * never merged).
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

async function twoUsers(): Promise<[LiveClient, LiveClient]> {
  team = await openTeam([
    { name: 'A', member: 0 },
    { name: 'B', member: 1 },
  ]);
  return team.devices as [LiveClient, LiveClient];
}

describe('E5: two devices edit one note at once', () => {
  it('online: both edits in the note on both devices', async () => {
    const [a, b] = await twoUsers();
    const { stand, projectId } = team!;
    a.write('n.md', 'one\ntwo\nthree\n');
    await eventually(() => expect(b.text('n.md')).toBe('one\ntwo\nthree\n'));
    await a.settled();

    a.write('n.md', 'one A\ntwo\nthree\n');
    b.write('n.md', 'one\ntwo\nthree B\n');

    await expectConverged(stand, projectId, [a, b]);
    expect(a.text('n.md')).toBe('one A\ntwo\nthree B\n');
  });

  it('offline: both edits, one daily note, an Untitled and its conflict copy', async () => {
    const [a, b] = await twoUsers();
    const { stand, projectId } = team!;
    a.write('n.md', 'one\ntwo\nthree\n');
    await eventually(() => expect(b.text('n.md')).toBe('one\ntwo\nthree\n'));
    await a.settled();

    a.net.offline();
    b.net.offline();
    await eventually(() => expect([a.status, b.status]).not.toContain('connected'));
    a.write('n.md', 'one\ntwo A\nthree\n');
    b.write('n.md', 'one\ntwo\nthree\nfour B\n');
    a.write('2026-09-29.md', '# Daily\n');
    b.write('2026-09-29.md', '# Daily\n');
    a.write('Untitled.md', '');
    b.write('Untitled.md', '');
    a.net.online();
    b.net.online();

    await expectConverged(stand, projectId, [a, b], { conflicts: 1 });
    expect(a.text('n.md')).toBe('one\ntwo A\nthree\nfour B\n');
    const paths = (await stand.liveFiles(projectId)).map((f) => f.path);
    expect(paths.filter((p) => p.startsWith('2026-09-29'))).toEqual(['2026-09-29.md']);
    expect(paths.filter((p) => p.startsWith('Untitled'))).toEqual([
      expect.stringMatching(/^Untitled\.conflict-.+\.md$/),
      'Untitled.md',
    ]);
  });
});
