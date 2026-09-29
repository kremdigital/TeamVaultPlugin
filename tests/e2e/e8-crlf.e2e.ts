/**
 * E8. A note with Windows line ends (`\r\n`), as many in a vault that came from
 * Windows editors. The server keeps its text as is, and the plugin does not
 * normalize: edits from both devices, one after another and at once, keep
 * every line end `\r\n` on both disks, and the note goes up once — no second
 * upload, no conflict copy.
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

/** Every line end of `text` is `\r\n`. */
function crlfOnly(text: string | null): boolean {
  return text !== null && !/[^\r]\n|^\n|\r(?!\n)/.test(text);
}

describe('E8: a note with CRLF line ends', () => {
  it('edits from two devices keep every line end', async () => {
    team = await openTeam([
      { name: 'A', member: 0 },
      { name: 'B', member: 1 },
    ]);
    const [a, b] = team.devices as [LiveClient, LiveClient];
    const { stand, projectId } = team;

    a.write('crlf.md', 'one\r\ntwo\r\nthree\r\n');
    await eventually(() => expect(b.text('crlf.md')).toBe('one\r\ntwo\r\nthree\r\n'));
    await a.settled();

    b.write('crlf.md', 'one\r\ntwo B\r\nthree\r\n');
    await eventually(() => expect(a.text('crlf.md')).toBe('one\r\ntwo B\r\nthree\r\n'));
    await b.settled();

    a.write('crlf.md', 'one A\r\ntwo B\r\nthree\r\n');
    b.write('crlf.md', 'one\r\ntwo B\r\nthree\r\nfour B\r\n');

    await expectConverged(stand, projectId, [a, b]);
    expect(a.text('crlf.md')).toBe('one A\r\ntwo B\r\nthree\r\nfour B\r\n');
    expect(crlfOnly(a.text('crlf.md'))).toBe(true);
    expect(crlfOnly(b.text('crlf.md'))).toBe(true);
    expect(crlfOnly((await stand.texts(projectId))['crlf.md'] ?? null)).toBe(true);
    const ops = await stand.ops(projectId);
    expect(ops.map((op) => `${op.opType} ${op.filePath}`)).toEqual(['CREATE crlf.md']);
  });
});
