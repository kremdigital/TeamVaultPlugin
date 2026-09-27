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
  protocolFixture,
  shapeOf,
  type Emit,
  type Harness,
} from './engine-test-kit';

/** A server with a room of one connected socket, no engine. */
function room(): { server: FakeServer; socket: FakeSocket; heard: Array<[string, unknown]> } {
  const socket = new FakeSocket();
  socket.connected = true;
  const heard: Array<[string, unknown]> = [];
  for (const event of [
    'file:created',
    'file:updated-binary',
    'file:deleted',
    'file:renamed',
    'file:moved',
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
  return { server, socket, heard };
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
    expect(shapeOf((answer.operations as unknown[])[0])).toEqual(
      shapeOf((example.operations as unknown[])[0]),
    );
    expect(socket.emits).toEqual([]);
  });
});
