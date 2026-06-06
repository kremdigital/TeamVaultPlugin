import {
  SocketClient,
  type SocketFactory,
  type SocketFactoryOptions,
  type SocketLike,
} from '@/client/socket';

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
      fileId: 'f1',
      filePath: 'old.md',
      newPath: 'new.md',
    });
    expect(socket().emits[0]?.event).toBe('file:rename');
    void client.emitFileMove({
      projectId: 'p1',
      clientId: 'device-1',
      fileId: 'f1',
      filePath: 'a/old.md',
      newPath: 'b/new.md',
    });
    expect(socket().emits[1]?.event).toBe('file:move');
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
    const yjsCb = jest.fn();
    client.onYjsUpdate(yjsCb);
    client.connect();
    socket().fire('yjs:update', { fileId: 'f1', update: [1, 2, 3] });
    expect(yjsCb).toHaveBeenCalledTimes(1);
    const arg = yjsCb.mock.calls[0]?.[0] as { fileId: string; update: Uint8Array };
    expect(arg.fileId).toBe('f1');
    expect(arg.update).toBeInstanceOf(Uint8Array);
    expect(Array.from(arg.update)).toEqual([1, 2, 3]);
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
