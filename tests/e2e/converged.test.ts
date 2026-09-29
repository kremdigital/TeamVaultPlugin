/**
 * The end-to-end suite's check that nothing reached the server twice
 * ({@link repeatsIn}), on journals as the server writes them. Part of
 * `pnpm test`: it needs no stand.
 *
 * A rename sent again under a new operation id used to pass: the check keyed
 * renames by the row's `filePath`, which the server writes as where the file
 * was when it applied the rename, so the repeat never matched the first row.
 */
import { repeatsIn } from './converged';
import type { ServerOpRow } from './stand';

let seq = 0;

function row(
  opType: ServerOpRow['opType'],
  filePath: string,
  newPath: string | null,
  clientId: string,
  outcome: ServerOpRow['outcome'],
  payload: ServerOpRow['payload'] = {},
): ServerOpRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    opType,
    filePath,
    newPath,
    clientId,
    opId: `op-${seq}`,
    authorId: 'user',
    outcome,
    payload,
  };
}

function created(path: string, clientId: string, fileId: string): ServerOpRow {
  return row('CREATE', path, null, clientId, { kind: 'created', fileId });
}

function renamed(from: string, to: string, clientId: string, fileId: string): ServerOpRow {
  return row('RENAME', from, to, clientId, { kind: 'renamed', fileId, from, to }, { fileId });
}

function sameName(path: string, clientId: string, fileId: string): ServerOpRow {
  return row(
    'RENAME',
    path,
    path,
    clientId,
    { kind: 'no_op', reason: 'same_path', fileId },
    { fileId },
  );
}

describe('repeatsIn — the end-to-end check of operations applied twice', () => {
  it('finds a rename sent again after it was applied: a no-op under the name it gave', () => {
    const ops = [created('n.md', 'A', 'f1'), renamed('n.md', 'm.md', 'A', 'f1')];
    expect(repeatsIn(ops)).toEqual([]);

    expect(repeatsIn([...ops, sameName('m.md', 'A', 'f1')])).toEqual([
      'rename of file f1 to m.md by A (2 times)',
    ]);
  });

  it('finds a rename sent again after a teammate renamed the file', () => {
    const ops = [
      created('r1.md', 'A', 'f1'),
      renamed('r1.md', 'r2.md', 'A', 'f1'),
      renamed('r2.md', 'r5.md', 'B', 'f1'),
      renamed('r5.md', 'r2.md', 'A', 'f1'),
    ];
    expect(repeatsIn(ops)).toEqual(['rename of file f1 to r2.md by A (2 times)']);
  });

  it('finds a rename onto a taken name sent again: by the name it asked for', () => {
    const conflict = (from: string): ServerOpRow =>
      row(
        'RENAME',
        from,
        'x.conflict-A.md',
        'A',
        { kind: 'conflict_create_renamed', fileId: 'f1', finalPath: 'x.conflict-A.md' },
        { fileId: 'f1', originalNewPath: 'x.md', conflict: true },
      );
    const ops = [created('x.md', 'B', 'f2'), created('y.md', 'A', 'f1'), conflict('y.md')];
    expect(repeatsIn(ops)).toEqual([]);
    expect(repeatsIn([...ops, conflict('x.conflict-A.md')])).toEqual([
      'rename of file f1 to x.md by A (2 times)',
    ]);
  });

  it('passes a chain of renames and a teammate’s rename in between', () => {
    expect(
      repeatsIn([
        created('r1.md', 'A', 'f1'),
        renamed('r1.md', 'r2.md', 'A', 'f1'),
        renamed('r2.md', 'r5.md', 'B', 'f1'),
        renamed('r5.md', 'r3.md', 'A', 'f1'),
      ]),
    ).toEqual([]);
  });

  it('passes a rename to a name another device asked for too', () => {
    expect(
      repeatsIn([
        created('a.md', 'A', 'f1'),
        renamed('a.md', 'b.md', 'A', 'f1'),
        renamed('b.md', 'a.md', 'B', 'f1'),
        renamed('a.md', 'b.md', 'B', 'f1'),
      ]),
    ).toEqual([]);
  });

  it('finds a second delete of a file, whoever sent it', () => {
    expect(
      repeatsIn([
        created('n.md', 'A', 'f1'),
        row('DELETE', 'n.md', null, 'A', { kind: 'deleted', fileId: 'f1' }, { fileId: 'f1' }),
        row('DELETE', 'n.md', null, 'B', { kind: 'no_op', fileId: 'f1' }, { fileId: 'f1' }),
      ]),
    ).toEqual(['DELETE of file f1 (2 times)']);
  });

  it('finds a second create of a path by one device, not by two', () => {
    expect(repeatsIn([created('n.md', 'A', 'f1'), created('n.md', 'B', 'f2')])).toEqual([]);
    expect(repeatsIn([created('n.md', 'A', 'f1'), created('n.md', 'A', 'f2')])).toEqual([
      'CREATE n.md by A (2 times)',
    ]);
  });
});
