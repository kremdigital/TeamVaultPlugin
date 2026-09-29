/**
 * The {@link FakeServer} the engine suites run against keeps the contract of
 * operation ids (`sync-protocol.md`, §4 of the 0.4 protocol): its acks,
 * `ops:status` answers, join answers and broadcasts have the shapes of the
 * contract's examples in `tests/fixtures/protocol-0.4/` — the same set the
 * server's tests write from what the real server sends — and it applies an
 * `opId` once, answers a resend with the original outcome and voids what
 * `ops:status` finds unapplied.
 */
import { newOpId } from '@/sync/operation-log';
import {
  FakeServer,
  FakeSocket,
  ServerDocs,
  protocolFixture,
  shapeOf,
  type Emit,
  type Harness,
} from './engine-test-kit';

/**
 * A server with a room of one connected socket, no engine. `joined: false`:
 * the socket connected and has not joined the project yet.
 */
function room(opts: { joined?: boolean } = {}): {
  server: FakeServer;
  socket: FakeSocket;
  heard: Array<[string, unknown]>;
  harness: Harness;
} {
  const socket = new FakeSocket();
  socket.connected = true;
  socket.inRoom = opts.joined ?? true;
  const heard: Array<[string, unknown]> = [];
  for (const event of [
    'file:created',
    'file:updated-binary',
    'file:deleted',
    'file:renamed',
    'file:moved',
    'yjs:update',
  ]) {
    socket.on(event, (data: unknown) => heard.push([event, data]));
  }
  const stub = {
    route: { server: null },
    socketIfBuilt: () => socket,
    serverFiles: [],
    deletedFiles: [],
    log: { getBindingState: () => null },
  } as unknown as Harness;
  const server = new FakeServer(stub);
  socket.statusResponder = (e): void => server.answerStatus(e);
  return { server, socket, heard, harness: stub };
}

/** Send `event` from device-1 and let the server answer it; resolves with the ack. */
function send(
  server: FakeServer,
  socket: FakeSocket,
  event: string,
  payload: Record<string, unknown>,
): unknown {
  let answer: unknown;
  socket.emit(
    event,
    { projectId: 'p1', clientId: 'device-1', vectorClock: { 'device-1': 1 }, ...payload },
    (ack: unknown) => {
      answer = ack;
    },
  );
  server.serveNext();
  return answer;
}

/** Ask `ops:status` about `opIds`; the answer. */
function status(socket: FakeSocket, opIds: unknown[]): unknown {
  let answer: unknown;
  socket.emit('ops:status', { projectId: 'p1', opIds }, (ack: unknown) => {
    answer = ack;
  });
  return answer;
}

const TEXT = { fileType: 'TEXT', contentHash: 'a'.repeat(64), size: 12 };

describe('FakeServer — the shapes of the contract’s examples', () => {
  it('answers a create with the outcome and the log row, and broadcasts where it stored it', () => {
    const { server, socket, heard } = room();
    const ack = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'notes/a.md',
      ...TEXT,
    });
    expect(shapeOf(ack)).toEqual(shapeOf(protocolFixture('ack-ok')));
    expect(shapeOf((ack as { outcome: unknown }).outcome)).toEqual(
      shapeOf(protocolFixture('outcome-created')),
    );
    const [, event] = heard[0] ?? [];
    const conflictEvent = protocolFixture('event-file-created') as Record<string, unknown>;
    expect(shapeOf({ ...(event as object), result: null })).toEqual(
      shapeOf({ ...conflictEvent, result: null }),
    );
  });

  it('answers a resend of the same opId with the original answer, marked duplicate, and nothing else', () => {
    const { server, socket, heard } = room();
    const opId = newOpId();
    const first = send(server, socket, 'file:create', { opId, filePath: 'n.md', ...TEXT });
    const again = send(server, socket, 'file:create', {
      opId,
      filePath: 'n.md',
      ...TEXT,
      contentHash: 'c'.repeat(64),
    });
    expect(shapeOf(again)).toEqual(shapeOf(protocolFixture('ack-duplicate')));
    expect(again).toEqual({ ...(first as object), duplicate: true });
    expect(server.applied).toEqual(['create n.md']);
    expect(server.appliedOpIds).toEqual([opId]);
    expect(server.duplicates).toEqual([opId]);
    expect(heard).toHaveLength(1);
  });

  it('refuses an operation without a valid opId, and one another client or kind uses', () => {
    const { server, socket } = room();
    expect(send(server, socket, 'file:create', { filePath: 'n.md', ...TEXT })).toEqual({
      ok: false,
      error: 'invalid_op_id',
    });
    expect(
      send(server, socket, 'file:create', { opId: 'NOT-A-UUID', filePath: 'n.md', ...TEXT }),
    ).toEqual({ ok: false, error: 'invalid_op_id' });
    const opId = newOpId();
    const created = send(server, socket, 'file:create', { opId, filePath: 'n.md', ...TEXT }) as {
      outcome: { fileId: string };
    };
    const asDelete = send(server, socket, 'file:delete', {
      opId,
      fileId: created.outcome.fileId,
      filePath: 'n.md',
    });
    expect(shapeOf(asDelete)).toEqual(shapeOf(protocolFixture('ack-error')));
    expect(asDelete).toEqual({ ok: false, error: 'op_id_conflict' });
    let other: unknown;
    socket.emit(
      'file:create',
      { projectId: 'p1', clientId: 'device-2', opId, filePath: 'n.md', ...TEXT },
      (ack: unknown) => {
        other = ack;
      },
    );
    server.serveNext();
    expect(other).toEqual({ ok: false, error: 'op_id_conflict' });
  });

  it('answers ops:status with what it applied and voids the rest; a voided opId is refused', () => {
    const { server, socket } = room();
    server.add({ id: 'f1', path: 'x.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    const landed = newOpId();
    const lost = newOpId();
    send(server, socket, 'file:rename', {
      opId: landed,
      fileId: 'f1',
      filePath: 'x.md',
      newPath: 'y.md',
    });
    const answer = status(socket, [landed, lost]);
    expect(shapeOf(answer)).toEqual(shapeOf(protocolFixture('ops-status-ack')));
    expect(answer).toMatchObject({ ok: true, applied: [{ opId: landed }], voided: [lost] });
    expect(
      send(server, socket, 'file:rename', {
        opId: lost,
        fileId: 'f1',
        filePath: 'y.md',
        newPath: 'z.md',
      }),
    ).toEqual({ ok: false, error: 'op_voided' });
    expect(server.pathOf('f1')).toBe('y.md');
  });

  it('applies what reached it before ops:status first; a late packet after it is voided', () => {
    const { server, socket } = room();
    server.add({ id: 'f1', path: 'x.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    const first = newOpId();
    const late = newOpId();
    const acks: unknown[] = [];
    socket.emit(
      'file:rename',
      {
        projectId: 'p1',
        clientId: 'device-1',
        opId: first,
        fileId: 'f1',
        filePath: 'x.md',
        newPath: 'y.md',
      },
      (ack: unknown) => acks.push(ack),
    );
    socket.emit(
      'file:rename',
      {
        projectId: 'p1',
        clientId: 'device-1',
        opId: late,
        fileId: 'f1',
        filePath: 'y.md',
        newPath: 'z.md',
      },
      (ack: unknown) => acks.push(ack),
    );
    const lateEmit = socket.emits[1] as Emit;
    server.delay(lateEmit);
    expect(status(socket, [first, late])).toMatchObject({
      applied: [{ opId: first }],
      voided: [late],
    });
    server.deliverLate(lateEmit);
    expect(acks[1]).toEqual({ ok: false, error: 'op_voided' });
    expect(server.pathOf('f1')).toBe('y.md');
  });

  it('leaves ops:status for its turn when told to hold it', () => {
    const { server, socket } = room();
    server.holdStatus = true;
    const answer = status(socket, [newOpId()]);
    expect(answer).toBeUndefined();
    expect(server.serveNext()).toBe(true);
    expect(server.statusAnswers).toHaveLength(1);
  });

  it('refuses an ops:status that asks about nothing, too much, or not ids', () => {
    const { socket } = room();
    const refused = { ok: false, error: 'invalid_payload' };
    expect(shapeOf(status(socket, []))).toEqual(shapeOf(protocolFixture('ops-status-error')));
    expect(status(socket, [])).toEqual(refused);
    expect(status(socket, ['nope'])).toEqual(refused);
    expect(
      status(
        socket,
        Array.from({ length: 501 }, () => newOpId()),
      ),
    ).toEqual(refused);
  });

  it('gives every outcome the shape of its example', () => {
    const { server, socket, heard } = room();
    server.add({ id: 'f3', path: 'img.png', fileType: 'BINARY', contentHash: 'h0', size: 1 });
    server.add({ id: 'f5', path: 'a.md', fileType: 'TEXT', contentHash: 'h1', size: 1 });
    server.add({ id: 'f6', path: 'b.md', fileType: 'TEXT', contentHash: 'h2', size: 1 });
    server.add({ id: 'f7', path: 'daily.md', ...TEXT, fileType: 'TEXT' });
    const outcome = (ack: unknown): unknown => (ack as { outcome: unknown }).outcome;
    const updated = send(server, socket, 'file:update-binary', {
      opId: newOpId(),
      fileId: 'f3',
      contentHash: 'b'.repeat(64),
      size: 2048,
    });
    expect(shapeOf(outcome(updated))).toEqual(shapeOf(protocolFixture('outcome-updated')));
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(
      shapeOf(protocolFixture('event-file-updated-binary')),
    );

    const renamed = send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f5',
      filePath: 'a.md',
      newPath: 'c.md',
    });
    expect(shapeOf(outcome(renamed))).toEqual(shapeOf(protocolFixture('outcome-renamed')));
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(shapeOf(protocolFixture('event-file-renamed')));
    send(server, socket, 'file:move', {
      opId: newOpId(),
      fileId: 'f5',
      filePath: 'c.md',
      newPath: 'd/c.md',
    });
    expect(heard.at(-1)?.[0]).toBe('file:moved');
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(shapeOf(protocolFixture('event-file-moved')));

    const conflict = send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f5',
      filePath: 'd/c.md',
      newPath: 'b.md',
    });
    expect(shapeOf(outcome(conflict))).toEqual(shapeOf(protocolFixture('outcome-conflict-move')));
    const samePath = send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f6',
      filePath: 'b.md',
      newPath: 'b.md',
    });
    expect(shapeOf(outcome(samePath))).toEqual(shapeOf(protocolFixture('outcome-no-op-same-path')));

    const merged = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'daily.md',
      ...TEXT,
    });
    expect(shapeOf(outcome(merged))).toEqual(shapeOf(protocolFixture('outcome-created-merged')));
    expect(outcome(merged)).toMatchObject({ fileId: 'f7', merged: true });
    const copy = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'b.md',
      ...TEXT,
    });
    expect(shapeOf(outcome(copy))).toEqual(shapeOf(protocolFixture('outcome-conflict-create')));
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(shapeOf(protocolFixture('event-file-created')));

    const deleted = send(server, socket, 'file:delete', {
      opId: newOpId(),
      fileId: 'f3',
      filePath: 'img.png',
    });
    expect(shapeOf(outcome(deleted))).toEqual(shapeOf(protocolFixture('outcome-deleted')));
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(shapeOf(protocolFixture('event-file-deleted')));
    const tombstone = send(server, socket, 'file:update-binary', {
      opId: newOpId(),
      fileId: 'f3',
      contentHash: 'c'.repeat(64),
      size: 3,
    });
    expect(shapeOf(outcome(tombstone))).toEqual(
      shapeOf(protocolFixture('outcome-no-op-tombstone')),
    );
  });

  it('keeps the folder that vanished with a delete, rename or move, as the examples carry it', () => {
    const { server, socket, heard } = room();
    server.add({
      id: 'f4',
      path: 'archive/2025/old.md',
      fileType: 'TEXT',
      contentHash: 'h',
      size: 1,
    });
    server.add({ id: 'f5', path: 'drafts/a.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    server.add({ id: 'f6', path: 'inbox/x.png', fileType: 'BINARY', contentHash: 'h', size: 1 });
    send(server, socket, 'file:delete', {
      opId: newOpId(),
      fileId: 'f4',
      filePath: 'archive/2025/old.md',
      folder: 'archive',
    });
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(
      shapeOf(protocolFixture('event-file-deleted-folder')),
    );
    expect(shapeOf(server.journal.at(-1))).toEqual(
      shapeOf(protocolFixture('catchup-row-delete-folder')),
    );
    send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f5',
      filePath: 'drafts/a.md',
      newPath: 'final/a.md',
      folder: 'drafts',
    });
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(
      shapeOf(protocolFixture('event-file-renamed-folder')),
    );
    send(server, socket, 'file:move', {
      opId: newOpId(),
      fileId: 'f6',
      filePath: 'inbox/x.png',
      newPath: 'assets/x.png',
      folder: 'inbox',
    });
    expect(shapeOf(heard.at(-1)?.[1])).toEqual(shapeOf(protocolFixture('event-file-moved-folder')));
    expect(heard.map(([, e]) => (e as { folder?: string }).folder)).toEqual([
      'archive',
      'drafts',
      'inbox',
    ]);
  });

  it('drops a folder that is not one the file was in, or that the file went to', () => {
    const { server, socket, heard } = room();
    server.add({ id: 'f1', path: 'a/b/x.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    server.add({ id: 'f2', path: 'c/y.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    server.add({ id: 'f3', path: 'd/z.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    // Not a folder of the file, nor one at all.
    send(server, socket, 'file:delete', {
      opId: newOpId(),
      fileId: 'f1',
      filePath: 'a/b/x.md',
      folder: 'a/b/x.md',
    });
    send(server, socket, 'file:delete', {
      opId: newOpId(),
      fileId: 'f2',
      filePath: 'c/y.md',
      folder: 42,
    });
    // The folder the file went into.
    send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f3',
      filePath: 'd/z.md',
      newPath: 'd/e/z.md',
      folder: 'd',
    });
    expect(heard.map(([, e]) => 'folder' in (e as object))).toEqual([false, false, false]);
    expect(server.journal.map((row) => 'folder' in (row.payload as object))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('keeps the folder normalized, as the server does, and drops one the server refuses', () => {
    const { server, socket, heard } = room();
    const cases: Array<[string, string, string | undefined]> = [
      // A path spelled otherwise: kept as the server normalizes it.
      ['notes/', 'notes/a.md', 'notes'],
      ['notes//sub', 'notes/sub/a.md', 'notes/sub'],
      ['notes\\sub', 'notes/sub/b.md', 'notes/sub'],
      ['./notes', 'notes/c.md', 'notes'],
      ['живая-040/sub', 'живая-040/sub/c.md', 'живая-040/sub'],
      // A path the server refuses: dropped.
      ['/notes', 'notes/d.md', undefined],
      ['../notes', 'notes/e.md', undefined],
      ['notes/..', 'notes/f.md', undefined],
      ['.', 'g.md', undefined],
      ['.trash', '.trash/h.md', undefined],
      ['.OBSIDIAN', '.OBSIDIAN/i.md', undefined],
      ['a/.git', 'a/.git/j.md', undefined],
      ['OBSIDI~1', 'OBSIDI~1/k.md', undefined],
      ['notes.', 'notes./l.md', undefined],
      ['no:tes', 'no:tes/m.md', undefined],
      ['no\u0007tes', 'no\u0007tes/p.md', undefined],
      ['no*tes', 'no*tes/q.md', undefined],
      // Not an ancestor once normalized, or not in the same case.
      ['Notes', 'notes/n.md', undefined],
      ['notes/su', 'notes/sub/o.md', undefined],
    ];
    for (const [i, [, path]] of cases.entries()) {
      server.add({ id: `k${i}`, path, fileType: 'TEXT', contentHash: 'h', size: 1 });
    }
    for (const [i, [folder, path]] of cases.entries()) {
      send(server, socket, 'file:delete', {
        opId: newOpId(),
        fileId: `k${i}`,
        filePath: path,
        folder,
      });
    }
    const expected = cases.map(([, , kept]) => kept);
    expect(heard.map(([, e]) => (e as { folder?: string }).folder)).toEqual(expected);
    expect(server.journal.map((row) => (row.payload as { folder?: string }).folder)).toEqual(
      expected,
    );
  });

  it('keeps the normalized folder of a move only when the file did not go into it', () => {
    const { server, socket, heard } = room();
    server.add({ id: 'm1', path: 'a/b/x.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    server.add({ id: 'm2', path: 'c/b/y.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'm1',
      filePath: 'a/b/x.md',
      newPath: 'a/c/x.md',
      folder: 'a/',
    });
    send(server, socket, 'file:move', {
      opId: newOpId(),
      fileId: 'm2',
      filePath: 'c/b/y.md',
      newPath: 'd/b/y.md',
      folder: 'c//',
    });
    expect(heard.map(([, e]) => (e as { folder?: string }).folder)).toEqual([undefined, 'c']);
  });

  it('merges a create of the same content only when it is not empty', () => {
    const { server, socket } = room();
    const empty = { fileType: 'TEXT', contentHash: 'e'.repeat(64), size: 0 };
    const first = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'Untitled.md',
      ...empty,
    });
    const second = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'Untitled.md',
      ...empty,
    });
    expect((first as { outcome: { kind: string } }).outcome.kind).toBe('created');
    expect((second as { outcome: unknown }).outcome).toMatchObject({
      kind: 'conflict_create_renamed',
      finalPath: 'Untitled.conflict-device-1.md',
    });
    // A conflict copy with the same content is not taken over either.
    const third = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'Untitled.md',
      ...empty,
    });
    expect((third as { outcome: unknown }).outcome).toMatchObject({
      finalPath: 'Untitled.conflict-device-1-2.md',
    });
  });

  it('answers the join and lists the journal in the shape of the example', () => {
    const { server, socket } = room();
    server.add({ id: 'f1', path: 'z.md', fileType: 'TEXT', contentHash: 'h', size: 1 });
    server.teammateRename('f1', 'w.md');
    const answer = server.joinAnswer('whole journal', { clock: {} });
    const example = protocolFixture('join-ack') as Record<string, unknown>;
    expect(answer).toMatchObject({ ok: true, opIdempotency: 1, operationsCatchup: 2 });
    // The docs are not in the answer: it says they come streamed.
    expect(Object.keys(answer).sort()).toEqual(Object.keys(example).sort());
    expect(answer).toMatchObject({ yjsStream: true, yjsCount: 0 });
    expect(shapeOf((answer.operations as unknown[])[0])).toEqual(
      shapeOf((example.operations as unknown[])[0]),
    );
    expect(socket.emits).toEqual([]);
  });

  it('streams the docs after the join answer, which never carries them', () => {
    const { server, socket } = room({ joined: false });
    const batches: Array<{ projectId: string; docs: Array<{ fileId: string }>; done: boolean }> =
      [];
    socket.on('yjs:catchup', (batch: unknown) => batches.push(batch as (typeof batches)[number]));
    const docs = Array.from({ length: 25 }, (_, i) => ({
      fileId: `f${i}`,
      sync1: [0, 0],
      stateVector: [0],
    }));
    const answers: unknown[] = [];
    socket.emit('project:join', { projectId: 'p1' }, (ack: unknown) => answers.push(ack));
    socket.emits.at(-1)?.ack(server.joinAnswer('whole journal', { yjsDocs: docs }));

    const example = protocolFixture('join-ack') as Record<string, unknown>;
    expect(Object.keys(answers[0] as object).sort()).toEqual(Object.keys(example).sort());
    expect(answers[0]).toMatchObject({ yjsStream: true, yjsCount: 25 });
    expect(batches.map((b) => [b.projectId, b.docs.length, b.done])).toEqual([
      ['p1', 20, false],
      ['p1', 5, true],
    ]);
    expect(batches.flatMap((b) => b.docs.map((d) => d.fileId))).toEqual(docs.map((d) => d.fileId));

    // Nothing to stream: one `done` batch, as the server sends.
    batches.length = 0;
    socket.emit('project:join', { projectId: 'p1' }, (ack: unknown) => answers.push(ack));
    socket.emits.at(-1)?.ack(server.joinAnswer('whole journal'));
    expect(answers[1]).toMatchObject({ yjsStream: true, yjsCount: 0 });
    expect(batches).toEqual([{ projectId: 'p1', docs: [], done: true }]);

    // A join answered after its connection ended: the stream never comes.
    batches.length = 0;
    socket.emit('project:join', { projectId: 'p1' }, (ack: unknown) => answers.push(ack));
    const late = socket.emits.at(-1);
    socket.disconnect();
    socket.connect();
    late?.ack(server.joinAnswer('whole journal', { yjsDocs: docs }));
    expect(batches).toEqual([]);
  });
});

/**
 * Where the {@link FakeServer} used to part from `Project/server` (the
 * integration check of TASK-0035): the room, a rename onto a deleted file's
 * name, an update of a deleted attachment, a create merged into a note, and
 * an `ops:status` asking about an id twice.
 */
describe('FakeServer — as the server does', () => {
  it('broadcasts only to a socket that joined the project since it connected', () => {
    const { server, socket, heard } = room({ joined: false });
    // Connected, still asking ops:status: the server has not taken it into the room.
    send(server, socket, 'file:create', { opId: newOpId(), filePath: 'a.md', ...TEXT });
    expect(heard).toEqual([]);

    socket.emit('project:join', { projectId: 'p1' }, () => undefined);
    expect(socket.inRoom).toBe(true);
    send(server, socket, 'file:create', { opId: newOpId(), filePath: 'b.md', ...TEXT });
    expect(heard.map(([event]) => event)).toEqual(['file:created']);

    // A new connection is out of the room until it joins again.
    socket.disconnect();
    socket.connect();
    send(server, socket, 'file:create', { opId: newOpId(), filePath: 'c.md', ...TEXT });
    expect(heard).toHaveLength(1);
  });

  it('drops the tombstone where a rename goes, conflict name or not', () => {
    const { server, socket, harness } = room();
    server.add({ id: 'f1', path: 'x.md', fileType: 'TEXT', contentHash: 'h1', size: 1 });
    server.add({ id: 'f2', path: 'y.md', fileType: 'TEXT', contentHash: 'h2', size: 1 });
    send(server, socket, 'file:delete', { opId: newOpId(), fileId: 'f2', filePath: 'y.md' });
    expect(harness.deletedFiles.map((f) => f.path)).toEqual(['y.md']);

    send(server, socket, 'file:rename', {
      opId: newOpId(),
      fileId: 'f1',
      filePath: 'x.md',
      newPath: 'y.md',
    });
    expect(server.pathOf('f1')).toBe('y.md');
    expect(server.files.has('f2')).toBe(false);
    expect(harness.deletedFiles).toEqual([]);
    // A create there later is a conflict copy of f1's name, not f2 revived.
    const again = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'y.md',
      ...TEXT,
    });
    expect((again as { outcome: unknown }).outcome).toMatchObject({
      kind: 'conflict_create_renamed',
      finalPath: 'y.conflict-device-1.md',
    });
  });

  it('broadcasts an update of a deleted attachment, and never a note’s as an attachment’s', () => {
    const { server, socket, heard } = room();
    server.add({ id: 'f3', path: 'img.png', fileType: 'BINARY', contentHash: 'h0', size: 1 });
    server.add({ id: 'f4', path: 'n.md', fileType: 'TEXT', contentHash: 'h1', size: 1 });
    send(server, socket, 'file:delete', { opId: newOpId(), fileId: 'f3', filePath: 'img.png' });
    const opId = newOpId();
    const onTombstone = send(server, socket, 'file:update-binary', {
      opId,
      fileId: 'f3',
      contentHash: 'c'.repeat(64),
      size: 3,
    });
    expect(onTombstone).toMatchObject({ outcome: { kind: 'no_op', reason: 'tombstone' } });
    const [event, payload] = heard.at(-1) ?? [];
    expect(event).toBe('file:updated-binary');
    expect(payload).toMatchObject({ fileId: 'f3', contentHash: 'c'.repeat(64), opId });
    expect(shapeOf(payload)).toEqual(shapeOf(protocolFixture('event-file-updated-binary')));

    const before = heard.length;
    const note = send(server, socket, 'file:update-binary', {
      opId: newOpId(),
      fileId: 'f4',
      contentHash: 'd'.repeat(64),
      size: 3,
    });
    expect(note).toMatchObject({ outcome: { kind: 'updated', fileId: 'f4' } });
    expect(heard).toHaveLength(before);
  });

  it('sends the doc of the note a create was merged into to the room', async () => {
    const { server, socket, heard, harness } = room();
    const docs = new ServerDocs(server, harness);
    const text = 'daily\n';
    await docs.add('f7', 'daily.md', text);
    const bytes = new TextEncoder().encode(text);
    const merged = send(server, socket, 'file:create', {
      opId: newOpId(),
      filePath: 'daily.md',
      fileType: 'TEXT',
      contentHash: server.files.get('f7')?.contentHash,
      size: bytes.byteLength,
      data: Array.from(bytes),
    });
    expect(merged).toMatchObject({ outcome: { fileId: 'f7', merged: true } });
    expect(heard.map(([event]) => event)).toEqual(['file:created', 'yjs:update']);
    expect(heard[1]?.[1]).toMatchObject({ fileId: 'f7' });
    // The stored doc is untouched: the merge wrote nothing into it.
    expect(docs.text('f7')).toBe(text);
  });

  it('counts an id asked twice in ops:status once', () => {
    const { socket } = room();
    const lost = newOpId();
    expect(status(socket, [lost, lost])).toEqual({ ok: true, applied: [], voided: [lost] });
  });
});
