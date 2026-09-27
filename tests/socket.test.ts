import {
  SocketClient,
  type SocketFactory,
  type SocketFactoryOptions,
  type SocketLike,
} from '@/client/socket';
import { stubWindow } from './window-stub';

/**
 * Minimal socket.io-client stand-in. Just enough surface to drive the plugin
 * wrapper end-to-end without opening a real network socket.
 */
class FakeSocket implements SocketLike {
  connected = false;
  /** Recorded factory options — let tests assert handshake config. */
  static lastOptions: SocketFactoryOptions | null = null;
  static lastUrl: string | null = null;

  /** Recorded outgoing emits, in order. */
  emits: Array<{ event: string; args: unknown[] }> = [];

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    public readonly url: string,
    public readonly options: SocketFactoryOptions,
  ) {
    FakeSocket.lastUrl = url;
    FakeSocket.lastOptions = options;
  }

  on(event: string, cb: (...args: unknown[]) => void): SocketLike {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(cb);
    return this;
  }
  off(event: string, cb?: (...args: unknown[]) => void): SocketLike {
    if (!cb) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]): SocketLike {
    this.emits.push({ event, args });
    return this;
  }
  connect(): SocketLike {
    this.connected = true;
    this.fire('connect');
    return this;
  }
  disconnect(): SocketLike {
    this.connected = false;
    this.fire('disconnect', 'io client disconnect');
    return this;
  }

  /** Server-side simulator — fire any handler the wrapper registered. */
  fire(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(...args);
  }

  /** Resolve the most recent emit's ack callback (last arg). */
  ackLast(response: unknown): void {
    const last = this.emits[this.emits.length - 1];
    if (!last) throw new Error('no emit to ack');
    const ack = last.args[last.args.length - 1];
    if (typeof ack !== 'function') throw new Error('last emit had no ack callback');
    (ack as (r: unknown) => void)(response);
  }
}

const factory: SocketFactory = (url, options) => new FakeSocket(url, options);

const server = { url: 'https://sync.example.com/', apiKey: 'osk_secret' };
const clientId = 'device-1';
/** Operation ids of the tests. */
const OP = '3f1c2e4a-9b7d-4c1e-8f2a-0d5b6c7e8f90';
const OP2 = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

/** Wrap the factory so each test can keep a handle to the FakeSocket. */
function captureSocket(): {
  client: SocketClient;
  socket: () => FakeSocket;
} {
  let captured: FakeSocket | null = null;
  const cap: SocketFactory = (url, options) => {
    captured = new FakeSocket(url, options);
    return captured;
  };
  const client = new SocketClient({ server, clientId, factory: cap });
  return {
    client,
    socket: () => {
      if (!captured) throw new Error('socket not yet created — call connect() first');
      return captured;
    },
  };
}

afterEach(() => {
  FakeSocket.lastOptions = null;
  FakeSocket.lastUrl = null;
});

describe('SocketClient — handshake', () => {
  it('strips trailing slashes from base url', () => {
    const { client, socket } = captureSocket();
    client.connect();
    expect(socket().url).toBe('https://sync.example.com');
  });

  it('passes the API key via auth.apiKey', () => {
    const { client, socket } = captureSocket();
    client.connect();
    expect(socket().options.auth).toEqual({ apiKey: 'osk_secret' });
  });

  it('forces websocket transport', () => {
    const { client, socket } = captureSocket();
    client.connect();
    expect(socket().options.transports).toEqual(['websocket']);
  });

  it('configures infinite exponential reconnect (1s → 30s, no jitter)', () => {
    const { client, socket } = captureSocket();
    client.connect();
    const opts = socket().options;
    expect(opts.reconnection).toBe(true);
    expect(opts.reconnectionAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(opts.reconnectionDelay).toBe(1000);
    expect(opts.reconnectionDelayMax).toBe(30_000);
    expect(opts.randomizationFactor).toBe(0);
    expect(opts.autoConnect).toBe(false);
  });

  it('honors a custom reconnect strategy', () => {
    const cap: SocketFactory = (url, options) => new FakeSocket(url, options);
    new SocketClient({
      server,
      clientId,
      factory: cap,
      reconnect: { initialDelayMs: 250, maxDelayMs: 5000 },
    }).connect();
    expect(FakeSocket.lastOptions?.reconnectionDelay).toBe(250);
    expect(FakeSocket.lastOptions?.reconnectionDelayMax).toBe(5000);
  });
});

describe('SocketClient — lifecycle subscriptions', () => {
  it('fires onConnect / onDisconnect / onError', () => {
    const { client, socket } = captureSocket();
    const connected = jest.fn();
    const disconnected = jest.fn();
    const errored = jest.fn();
    client.onConnect(connected);
    client.onDisconnect(disconnected);
    client.onError(errored);
    client.connect();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);

    socket().fire('connect_error', new Error('boom'));
    expect(errored).toHaveBeenCalledWith(expect.any(Error));

    client.disconnect();
    expect(disconnected).toHaveBeenCalledWith('io client disconnect');
    expect(client.isConnected()).toBe(false);
  });

  it('wraps a connect_error payload that is not an Error', () => {
    const { client, socket } = captureSocket();
    const errored = jest.fn<void, [Error]>();
    client.onError(errored);
    client.connect();

    socket().fire('connect_error', 'xhr poll error');
    socket().fire('connect_error', { description: 401 });
    socket().fire('connect_error');

    expect(errored.mock.calls.map(([e]) => e.message)).toEqual([
      'xhr poll error',
      'connect_error',
      'connect_error',
    ]);
  });

  it('lets callers unsubscribe', () => {
    const { client, socket } = captureSocket();
    const cb = jest.fn();
    const off = client.onConnect(cb);
    client.connect();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    cb.mockClear();
    // Simulate a reconnect by re-firing the underlying 'connect' event.
    socket().fire('connect');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('SocketClient — emits', () => {
  it('joinProject sends the right payload and resolves with the server ack', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const promise = client.joinProject('p1', { node1: 5 }, true);
    expect(socket().emits[0]?.event).toBe('project:join');
    expect(socket().emits[0]?.args[0]).toEqual({
      projectId: 'p1',
      sinceVectorClock: { node1: 5 },
      streamYjs: true,
      // The whole-journal catch-up (see `OPERATIONS_CATCHUP`).
      operationsCatchup: 2,
    });
    socket().ackLast({ ok: true, operations: [], yjsDocs: [] });
    await expect(promise).resolves.toEqual({ ok: true, operations: [], yjsDocs: [] });
  });

  it('emitFileCreate serializes binary data as a number array', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const promise = client.emitFileCreate({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      filePath: 'note.md',
      fileType: 'TEXT',
      contentHash: 'h',
      size: 4,
      data: buf,
    });
    const args = socket().emits[0]?.args[0] as { data: unknown };
    expect(args.data).toEqual([1, 2, 3, 4]);
    socket().ackLast({ ok: true, outcome: 'created' });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('emitYjsUpdate converts Uint8Array to number[]', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const update = Uint8Array.from([10, 20, 30]);
    const promise = client.emitYjsUpdate({ projectId: 'p1', fileId: 'f1', update });
    const args = socket().emits[0]?.args[0] as { update: unknown };
    expect(args.update).toEqual([10, 20, 30]);
    socket().ackLast({ ok: true, changed: true });
    await expect(promise).resolves.toEqual({ ok: true, changed: true });
  });

  it('rejects an emit whose connection drops before the ack', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const rename = client.emitFileRename({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f1',
      filePath: 'a.md',
      newPath: 'b.md',
    });
    // socket.io drops a plain ack callback on disconnect: it is never called.
    socket().disconnect();
    await expect(rename).rejects.toThrow('disconnected');
    // A late answer changes nothing.
    socket().ackLast({ ok: true });
    await expect(rename).rejects.toThrow('disconnected');
  });

  it('waits for the ack of an emit made while disconnected once the socket reconnects', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    socket().disconnect();
    // socket.io buffers it and sends it on the next connect.
    const create = client.emitFileDelete({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f1',
      filePath: 'a.md',
    });
    socket().connect();
    socket().ackLast({ ok: true, outcome: { kind: 'deleted', fileId: 'f1' } });
    await expect(create).resolves.toMatchObject({ ok: true });
    // Sent now: the next drop rejects what is still waiting.
    const next = client.emitFileDelete({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f2',
      filePath: 'b.md',
    });
    socket().disconnect();
    await expect(next).rejects.toThrow('disconnected');
  });

  it('rejects every waiting emit when the client disconnects', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    socket().disconnect();
    const buffered = client.joinProject('p1');
    client.disconnect();
    await expect(buffered).rejects.toThrow('disconnected');
  });

  it('rejects if emit is called before connect', async () => {
    const client = new SocketClient({ server, clientId, factory });
    await expect(client.joinProject('p1')).rejects.toThrow('socket_not_connected');
  });

  it('emitFileRename / emitFileMove send the configured event name', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    void client.emitFileRename({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f1',
      filePath: 'old.md',
      newPath: 'new.md',
    });
    expect(socket().emits[0]?.event).toBe('file:rename');
    void client.emitFileMove({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f1',
      filePath: 'a/old.md',
      newPath: 'b/new.md',
    });
    expect(socket().emits[1]?.event).toBe('file:move');
  });

  it('fetchYjsDoc sends yjs:fetch and resolves with the doc state', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const promise = client.fetchYjsDoc('p1', 'f1');
    expect(socket().emits[0]?.event).toBe('yjs:fetch');
    expect(socket().emits[0]?.args[0]).toEqual({ projectId: 'p1', fileId: 'f1' });
    socket().ackLast({ ok: true, sync1: [1, 2], stateVector: [3] });
    await expect(promise).resolves.toEqual({ ok: true, sync1: [1, 2], stateVector: [3] });
  });

  it('fetchYjsDoc resolves with a timeout error when the server never acks', async () => {
    const { client } = captureSocket();
    client.connect();
    // Servers older than `yjs:fetch` silently drop the event.
    await expect(client.fetchYjsDoc('p1', 'f1', 5)).resolves.toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('fetchYjsDoc times out on window.setTimeout and clears it on the ack', async () => {
    const win = stubWindow();
    try {
      const { client, socket } = captureSocket();
      client.connect();
      const promise = client.fetchYjsDoc('p1', 'f1', 60_000);
      expect(win.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
      socket().ackLast({ ok: true, sync1: [], stateVector: [] });
      await promise;
      expect(win.clearTimeout).toHaveBeenCalledTimes(1);
    } finally {
      win.restore();
    }
  });

  // Pause sync closes the socket while a note's state may be on its way:
  // left to its timeout, the answer kept a save of the note waiting for 15 s
  // and took the server for one without `yjs:fetch` until the next connect.
  it('fetchYjsDoc answers at once when the client disconnects, and clears its timer', async () => {
    const win = stubWindow();
    try {
      const { client, socket } = captureSocket();
      client.connect();
      const promise = client.fetchYjsDoc('p1', 'f1', 60_000);
      client.disconnect();
      await expect(promise).resolves.toEqual({ ok: false, error: 'disconnected' });
      expect(win.clearTimeout).toHaveBeenCalledTimes(1);
      // A late answer on the closed socket changes nothing.
      socket().ackLast({ ok: true, sync1: [], stateVector: [] });
      await expect(promise).resolves.toEqual({ ok: false, error: 'disconnected' });
    } finally {
      win.restore();
    }
  });

  it('fetchYjsDoc resolves (does not reject) before connect', async () => {
    const client = new SocketClient({ server, clientId, factory });
    await expect(client.fetchYjsDoc('p1', 'f1')).resolves.toEqual({
      ok: false,
      error: 'socket_not_connected',
    });
  });
});

describe('SocketClient — incoming events', () => {
  it('translates file:created into a typed FileEvent', () => {
    const { client, socket } = captureSocket();
    const fileCb = jest.fn();
    client.onFileEvent(fileCb);
    client.connect();
    const log = { id: 'l1', vectorClock: { node1: 1 }, createdAt: '2026-01-01' };
    socket().fire('file:created', { result: { id: 'f1' }, log });
    expect(fileCb).toHaveBeenCalledWith({ type: 'created', result: { id: 'f1' }, log });
  });

  it('translates file:updated-binary', () => {
    const { client, socket } = captureSocket();
    const fileCb = jest.fn();
    client.onFileEvent(fileCb);
    client.connect();
    const log = { id: 'l2', vectorClock: {}, createdAt: '2026-01-02' };
    socket().fire('file:updated-binary', { fileId: 'f1', contentHash: 'h2', log });
    expect(fileCb).toHaveBeenCalledWith({
      type: 'updated-binary',
      fileId: 'f1',
      contentHash: 'h2',
      log,
    });
  });

  it('translates file:renamed and file:moved', () => {
    const { client, socket } = captureSocket();
    const fileCb = jest.fn();
    client.onFileEvent(fileCb);
    client.connect();
    const log = { id: 'l3', vectorClock: {}, createdAt: '2026-01-03' };
    socket().fire('file:renamed', { fileId: 'f1', newPath: 'new.md', outcome: 'renamed', log });
    socket().fire('file:moved', { fileId: 'f1', newPath: 'b/new.md', outcome: 'moved', log });
    expect(fileCb).toHaveBeenNthCalledWith(1, {
      type: 'renamed',
      fileId: 'f1',
      newPath: 'new.md',
      outcome: 'renamed',
      log,
    });
    expect(fileCb).toHaveBeenNthCalledWith(2, {
      type: 'moved',
      fileId: 'f1',
      newPath: 'b/new.md',
      outcome: 'moved',
      log,
    });
  });

  it('decodes yjs:update payload back to a Uint8Array', () => {
    const { client, socket } = captureSocket();
    const yjsCb = jest.fn<void, [{ fileId: string; update: Uint8Array }]>();
    client.onYjsUpdate(yjsCb);
    client.connect();
    socket().fire('yjs:update', { fileId: 'f1', update: [1, 2, 3] });
    expect(yjsCb).toHaveBeenCalledTimes(1);
    const arg = yjsCb.mock.calls[0]?.[0];
    expect(arg?.fileId).toBe('f1');
    expect(arg?.update).toBeInstanceOf(Uint8Array);
    expect(Array.from(arg?.update ?? [])).toEqual([1, 2, 3]);
  });

  it('swallows errors thrown by individual listeners', () => {
    const { client, socket } = captureSocket();
    const ok = jest.fn();
    client.onYjsUpdate(() => {
      throw new Error('listener exploded');
    });
    client.onYjsUpdate(ok);
    client.connect();
    expect(() => socket().fire('yjs:update', { fileId: 'f1', update: [1] })).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('SocketClient — operation ids', () => {
  it('sends the operation’s opId in the envelope of every file operation', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const base = { projectId: 'p1', clientId: 'device-1', opId: OP };
    void client.emitFileCreate({
      ...base,
      filePath: 'n.md',
      fileType: 'TEXT',
      contentHash: 'h',
      size: 0,
    });
    void client.emitFileUpdateBinary({ ...base, fileId: 'f1', contentHash: 'h', size: 1 });
    void client.emitFileDelete({ ...base, fileId: 'f1', filePath: 'a.md' });
    void client.emitFileRename({ ...base, fileId: 'f1', filePath: 'a.md', newPath: 'b.md' });
    void client.emitFileMove({ ...base, fileId: 'f1', filePath: 'a.md', newPath: 'd/b.md' });
    expect(socket().emits.map((e) => (e.args[0] as { opId?: unknown }).opId)).toEqual([
      OP,
      OP,
      OP,
      OP,
      OP,
    ]);
    await Promise.resolve();
  });

  it('resolves a file operation with the outcome, the log row and the duplicate mark', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const del = client.emitFileDelete({
      projectId: 'p1',
      clientId: 'device-1',
      opId: OP,
      fileId: 'f1',
      filePath: 'a.md',
    });
    const log = { id: 'cl_1', vectorClock: { 'device-1': 8 }, createdAt: '2026-10-01' };
    socket().ackLast({
      ok: true,
      outcome: { kind: 'deleted', fileId: 'f1' },
      log,
      duplicate: true,
    });
    await expect(del).resolves.toEqual({
      ok: true,
      outcome: { kind: 'deleted', fileId: 'f1' },
      log,
      duplicate: true,
    });
  });

  it('passes the join’s idempotency mark and the rows’ clientId and opId through', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const join = client.joinProject('p1', {}, true);
    const row = {
      id: 'cl_3',
      opType: 'RENAME',
      filePath: 'z.md',
      newPath: 'w.md',
      authorId: 'u2',
      clientId: 'c-B',
      opId: OP,
      vectorClock: { 'c-B': 4 },
      payload: { fileId: 'f1' },
      createdAt: '2026-10-01',
    };
    const old = { ...row, id: 'cl_1', clientId: null, opId: null };
    socket().ackLast({ ok: true, opIdempotency: 1, operationsCatchup: 2, operations: [old, row] });
    await expect(join).resolves.toEqual({
      ok: true,
      opIdempotency: 1,
      operationsCatchup: 2,
      operations: [old, row],
    });
  });

  it('opsStatus asks about the ids and resolves with what was applied and voided', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const asked = client.opsStatus('p1', [OP, OP2]);
    expect(socket().emits[0]?.event).toBe('ops:status');
    expect(socket().emits[0]?.args[0]).toEqual({ projectId: 'p1', opIds: [OP, OP2] });
    const applied = {
      opId: OP,
      opType: 'RENAME',
      logId: 'cl_9',
      filePath: 'x.md',
      newPath: 'y.md',
      outcome: { kind: 'renamed', fileId: 'f1', from: 'x.md', to: 'y.md' },
      vectorClock: { 'device-1': 12 },
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    socket().ackLast({ ok: true, applied: [applied, { opId: 42 }], voided: [OP2, 7] });
    await expect(asked).resolves.toEqual({ ok: true, applied: [applied], voided: [OP2] });
  });

  it('opsStatus passes the server’s refusal on, and a malformed answer is an error', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const busy = client.opsStatus('p1', [OP]);
    socket().ackLast({ ok: false, error: 'busy' });
    await expect(busy).resolves.toEqual({ ok: false, error: 'busy' });
    const odd = client.opsStatus('p1', [OP]);
    socket().ackLast({ ok: true, applied: 'nope' });
    await expect(odd).resolves.toEqual({ ok: false, error: 'invalid_ack' });
  });

  it('opsStatus times out on window.setTimeout and clears it on the ack', async () => {
    const win = stubWindow();
    try {
      const { client, socket } = captureSocket();
      client.connect();
      const late = client.opsStatus('p1', [OP], 5);
      await expect(late).resolves.toEqual({ ok: false, error: 'timeout' });
      const answered = client.opsStatus('p1', [OP], 60_000);
      socket().ackLast({ ok: true, applied: [], voided: [OP] });
      await expect(answered).resolves.toEqual({ ok: true, applied: [], voided: [OP] });
      expect(win.setTimeout.mock.calls.map(([, ms]) => ms)).toEqual([5, 60_000]);
      expect(win.clearTimeout).toHaveBeenCalledTimes(2);
    } finally {
      win.restore();
    }
  });

  it('opsStatus answers disconnected when the connection drops, and when the client disconnects', async () => {
    const { client, socket } = captureSocket();
    client.connect();
    const dropped = client.opsStatus('p1', [OP]);
    socket().disconnect();
    await expect(dropped).resolves.toEqual({ ok: false, error: 'disconnected' });
    socket().connect();
    const closed = client.opsStatus('p1', [OP]);
    client.disconnect();
    await expect(closed).resolves.toEqual({ ok: false, error: 'disconnected' });
  });

  it('opsStatus resolves (does not reject) before connect', async () => {
    const client = new SocketClient({ server, clientId, factory });
    await expect(client.opsStatus('p1', [OP])).resolves.toEqual({
      ok: false,
      error: 'socket_not_connected',
    });
  });

  it('reads the opId and the sender of every file event, and where file:created stored it', () => {
    const { client, socket } = captureSocket();
    const fileCb = jest.fn();
    client.onFileEvent(fileCb);
    client.connect();
    const log = { id: 'cl_4', vectorClock: { 'c-B': 5 }, createdAt: '2026-10-01' };
    const outcome = {
      kind: 'conflict_create_renamed',
      fileId: 'f2',
      originalPath: 'notes/a.md',
      finalPath: 'notes/a.conflict-c-B.md',
    };
    socket().fire('file:created', {
      result: { outcome, log },
      fileId: 'f2',
      path: 'notes/a.conflict-c-B.md',
      fileType: 'TEXT',
      clientId: 'c-B',
      opId: OP,
      revived: false,
      log,
    });
    socket().fire('file:deleted', { fileId: 'f4', clientId: 'rest:u2', opId: OP2, log });
    socket().fire('file:updated-binary', {
      fileId: 'f3',
      contentHash: 'h',
      clientId: '',
      opId: 12,
      log,
    });
    expect(fileCb).toHaveBeenNthCalledWith(1, {
      type: 'created',
      result: { outcome, log },
      fileId: 'f2',
      path: 'notes/a.conflict-c-B.md',
      fileType: 'TEXT',
      clientId: 'c-B',
      opId: OP,
      log,
    });
    expect(fileCb).toHaveBeenNthCalledWith(2, {
      type: 'deleted',
      fileId: 'f4',
      clientId: 'rest:u2',
      opId: OP2,
      log,
    });
    // Fields that are not what they should be are left out.
    expect(fileCb).toHaveBeenNthCalledWith(3, {
      type: 'updated-binary',
      fileId: 'f3',
      contentHash: 'h',
      log,
    });
  });
});
