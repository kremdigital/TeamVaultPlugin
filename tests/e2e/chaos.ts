/**
 * Network faults between a live client and the sync stand.
 *
 * - {@link NetSwitch}: a TCP relay the client's socket goes through — the
 *   network off and on, or every connection cut at once.
 * - {@link ChaosSockets}: the socket factory of a `SocketClient`, wrapping the
 *   real socket.io client. It records every emit with its answer and can lose
 *   one answer (the server applied the operation), one packet (the server never
 *   got it), or hold one answer back until the test lets it through.
 * - {@link ghostEmit}: a packet of a connection that is gone, reaching the
 *   server late.
 */
import { createServer, connect, type Server, type Socket as TcpSocket } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type { SocketFactory, SocketLike } from '@/client/socket';

// -- The network --------------------------------------------------------------------

/**
 * A TCP relay on 127.0.0.1 to the stand: a client that connects here is on the
 * network while it is {@link online}.
 */
export class NetSwitch {
  private readonly links = new Set<TcpSocket>();
  private readonly server: Server;
  private down = false;
  private port = 0;

  private constructor(private readonly targetPort: number) {
    this.server = createServer((client) => this.relay(client));
  }

  /** A relay to `targetPort` on 127.0.0.1, on the network. */
  static async open(targetPort: number): Promise<NetSwitch> {
    const sw = new NetSwitch(targetPort);
    await new Promise<void>((resolve, reject) => {
      sw.server.once('error', reject);
      sw.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = sw.server.address();
    if (address === null || typeof address === 'string') throw new Error('relay: no port');
    sw.port = address.port;
    return sw;
  }

  /** Where a client connects to go through the relay. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isOffline(): boolean {
    return this.down;
  }

  /** The network goes: every connection drops, and none gets through until {@link online}. */
  offline(): void {
    this.down = true;
    this.cut();
  }

  online(): void {
    this.down = false;
  }

  /** Every connection drops at once; new ones get through. */
  cut(): void {
    for (const end of [...this.links]) end.destroy();
    this.links.clear();
  }

  async close(): Promise<void> {
    this.offline();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private relay(client: TcpSocket): void {
    if (this.down) {
      client.destroy();
      return;
    }
    const upstream = connect({ port: this.targetPort, host: '127.0.0.1' });
    const pair = [client, upstream];
    const drop = (): void => {
      for (const end of pair) {
        end.destroy();
        this.links.delete(end);
      }
    };
    for (const end of pair) {
      this.links.add(end);
      end.on('error', drop);
      end.on('close', drop);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  }
}

// -- The socket -------------------------------------------------------------------

/** An emit with an ack, and the answer the server gave it. */
export interface Exchange {
  event: string;
  payload: Record<string, unknown>;
  /** The server's answer, once it came — whether the client got it or not. */
  answer?: unknown;
  /** What a fault did to it. */
  fault?: 'answer lost' | 'packet lost' | 'answer held';
}

/** An answer held back from the client (see {@link ChaosSockets.holdAck}). */
export interface HeldAck {
  /** The payload of the emit, once it went out. */
  readonly sent: Promise<Record<string, unknown>>;
  /** The server's answer, once it came: the server is done with the operation. */
  readonly answered: Promise<unknown>;
  /** Hand the answer to the client (now, or when it comes). */
  release(): void;
  /** Never hand it: the client waits until its connection drops. */
  discard(): void;
}

type Match = (payload: Record<string, unknown>) => boolean;

interface Rule {
  kind: 'drop answer' | 'drop packet' | 'hold answer';
  event: string;
  match: Match;
  /** Resolved with the payload once the rule fired. */
  fired: (payload: Record<string, unknown>) => void;
  hold?: Hold;
}

class Hold implements HeldAck {
  readonly sent: Promise<Record<string, unknown>>;
  readonly answered: Promise<unknown>;
  noteSent!: (payload: Record<string, unknown>) => void;
  private noteAnswered!: (answer: unknown) => void;
  private deliver: (() => void) | null = null;
  private state: 'held' | 'released' | 'discarded' = 'held';

  constructor() {
    this.sent = new Promise((resolve) => {
      this.noteSent = resolve;
    });
    this.answered = new Promise((resolve) => {
      this.noteAnswered = resolve;
    });
  }

  arrive(answer: unknown, deliver: () => void): void {
    this.noteAnswered(answer);
    if (this.state === 'released') deliver();
    else if (this.state === 'held') this.deliver = deliver;
  }

  release(): void {
    if (this.state !== 'held') return;
    this.state = 'released';
    this.deliver?.();
    this.deliver = null;
  }

  discard(): void {
    if (this.state !== 'held') return;
    this.state = 'discarded';
    this.deliver = null;
  }
}

/** Close the transport under `raw`: the client sees its connection drop. */
function closeTransport(raw: Socket): void {
  (raw.io.engine as { close?: () => void } | undefined)?.close?.();
}

/**
 * The socket factory of a live client (`SocketClientOptions.factory`): the real
 * socket.io client, with its emits in the test's hands. Each fault is one-shot
 * and fires on the first emit of its event that `match` takes.
 */
export class ChaosSockets {
  /** Every emit with an ack (`file:*`, `ops:status`, `project:join`, …), in order. */
  readonly exchanges: Exchange[] = [];
  private readonly raws: Socket[] = [];
  private rules: Rule[] = [];

  readonly factory: SocketFactory = (url, options) => {
    const raw = io(url, options);
    this.raws.push(raw);
    return this.wrap(raw);
  };

  /**
   * The server gets the next `event` that `match` takes, applies it and
   * answers — and the answer is lost: the connection drops right after it
   * came, never before (a packet the server reads after a disconnect is
   * dropped, which is {@link dropEmit}). Resolves with the payload.
   */
  dropAck(event: string, match: Match = () => true): Promise<Record<string, unknown>> {
    return new Promise((fired) => this.rules.push({ kind: 'drop answer', event, match, fired }));
  }

  /**
   * The next `event` that `match` takes never reaches the server: the
   * connection drops instead. Resolves with the payload — the packet a late
   * delivery would bring (see {@link ghostEmit}).
   */
  dropEmit(event: string, match: Match = () => true): Promise<Record<string, unknown>> {
    return new Promise((fired) => this.rules.push({ kind: 'drop packet', event, match, fired }));
  }

  /** The server's answer to the next `event` that `match` takes waits for the test. */
  holdAck(event: string, match: Match = () => true): HeldAck {
    const hold = new Hold();
    this.rules.push({ kind: 'hold answer', event, match, fired: hold.noteSent, hold });
    return hold;
  }

  /** The answers the server gave to `event`, for payloads `match` takes. */
  answers(event: string, match: Match = () => true): unknown[] {
    return this.exchanges
      .filter((e) => e.event === event && 'answer' in e && match(e.payload))
      .map((e) => e.answer);
  }

  /** Every connection of these sockets drops; they connect again. */
  cutTransport(): void {
    for (const raw of this.raws) closeTransport(raw);
  }

  /** The process is gone: every socket drops and never connects again. */
  killAll(): void {
    for (const raw of this.raws) {
      raw.io.reconnection(false);
      closeTransport(raw);
      raw.disconnect();
    }
  }

  private wrap(raw: Socket): SocketLike {
    const proxy: SocketLike = new Proxy(raw, {
      get: (target, prop) => {
        if (prop === 'emit') {
          return (event: string, ...args: unknown[]): SocketLike => {
            this.emit(target, event, args);
            return proxy;
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    return proxy;
  }

  private take(event: string, payload: Record<string, unknown>): Rule | null {
    const rule = this.rules.find((r) => r.event === event && r.match(payload));
    if (!rule) return null;
    this.rules = this.rules.filter((r) => r !== rule);
    return rule;
  }

  private emit(raw: Socket, event: string, args: unknown[]): void {
    const [payload, ack] = args;
    if (typeof ack !== 'function' || typeof payload !== 'object' || payload === null) {
      raw.emit(event, ...args);
      return;
    }
    const answer = ack as (response: unknown) => void;
    const body = payload as Record<string, unknown>;
    const exchange: Exchange = { event, payload: body };
    this.exchanges.push(exchange);
    const rule = this.take(event, body);
    if (rule === null) {
      raw.emit(event, body, (response: unknown) => {
        exchange.answer = response;
        answer(response);
      });
      return;
    }
    rule.fired(body);
    switch (rule.kind) {
      case 'drop answer':
        exchange.fault = 'answer lost';
        raw.emit(event, body, (response: unknown) => {
          exchange.answer = response;
          // After the server's answer came, never before: the operation is applied.
          queueMicrotask(() => closeTransport(raw));
        });
        return;
      case 'drop packet':
        exchange.fault = 'packet lost';
        queueMicrotask(() => closeTransport(raw));
        return;
      case 'hold answer':
        exchange.fault = 'answer held';
        raw.emit(event, body, (response: unknown) => {
          exchange.answer = response;
          rule.hold?.arrive(response, () => answer(response));
        });
        return;
    }
  }
}

// -- A late packet ------------------------------------------------------------------

/**
 * `event` with `payload` reaches the server on a connection of its own, as a
 * packet of a connection gone reaches it late; resolves with the answer.
 */
export async function ghostEmit(
  standUrl: string,
  apiKey: string,
  event: string,
  payload: unknown,
): Promise<unknown> {
  const socket = io(standUrl, {
    auth: { apiKey },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return (await socket.timeout(10_000).emitWithAck(event, payload)) as unknown;
  } finally {
    socket.disconnect();
  }
}
