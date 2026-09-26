/**
 * Building blocks of `SyncEngine.stop()` (TASK-0030): the dependency fence,
 * the abortable offline-queue drain and the cancellable binary transfers;
 * and of Pause sync, the connection's own signal within the engine's. The
 * engine-level regression tests live in `engine-stop.test.ts` and
 * `engine-pause.test.ts`.
 */
import { EngineStoppedError, SyncPausedError, childController, fence } from '@/sync/stop-fence';
import { flushPendingQueue, type PendingEmitter, type ReplayOutcome } from '@/sync/reconnect';
import { OperationLog } from '@/sync/operation-log';
import {
  ApiClient,
  ApiError,
  type BinaryRequestFn,
  type RequestFn,
  type RequestUrlResponse,
} from '@/client/api';

class Counter {
  private count = 0;
  private readonly ticks: number[] = [];

  bump(): number {
    this.count += 1;
    return this.count;
  }

  /** Awaits, then touches private state again — the continuation must work. */
  async bumpLater(gate: Promise<void>): Promise<number> {
    await gate;
    this.ticks.push(this.count);
    return this.bump();
  }

  get value(): number {
    return this.count;
  }
}

function stopper(): { controller: AbortController; reason: EngineStoppedError } {
  const controller = new AbortController();
  return { controller, reason: new EngineStoppedError() };
}

describe('fence', () => {
  it('passes calls through, with the real object as `this`', () => {
    const { controller } = stopper();
    const counter = new Counter();
    const fenced = fence(counter, controller.signal);
    expect(fenced.bump()).toBe(1);
    expect(fenced.bump()).toBe(2);
    expect(counter.value).toBe(2);
  });

  it('throws the stop reason for every call once aborted, without running it', () => {
    const { controller, reason } = stopper();
    const counter = new Counter();
    const bump = jest.spyOn(counter, 'bump');
    const fenced = fence(counter, controller.signal);
    fenced.bump();
    controller.abort(reason);

    expect(() => fenced.bump()).toThrow(reason);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(counter.value).toBe(1);
    // Reads stay available.
    expect(fenced.value).toBe(1);
  });

  it('lets a call made before the abort finish its own work', async () => {
    const { controller, reason } = stopper();
    const counter = new Counter();
    const fenced = fence(counter, controller.signal);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = fenced.bumpLater(gate);
    controller.abort(reason);
    open();
    // The dependency's internals run on the real object, past the abort.
    await expect(pending).resolves.toBe(1);
    expect(() => fenced.bump()).toThrow(EngineStoppedError);
  });
});

describe('childController — the connection within the engine lifetime', () => {
  it('aborts with the parent, and with the reason the parent gives', () => {
    const parent = new AbortController();
    const child = childController(parent.signal);
    const reason = new EngineStoppedError();
    parent.abort(reason);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe(reason);
  });

  it('aborts on its own without touching the parent, and stops following it', () => {
    const parent = new AbortController();
    const remove = jest.spyOn(parent.signal, 'removeEventListener');
    const child = childController(parent.signal);
    child.abort(new SyncPausedError());
    expect(parent.signal.aborted).toBe(false);
    expect(child.signal.reason).toBeInstanceOf(SyncPausedError);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    parent.abort(new EngineStoppedError());
    expect(child.signal.reason).toBeInstanceOf(SyncPausedError);
  });

  it('starts aborted under an aborted parent', () => {
    const parent = new AbortController();
    parent.abort(new EngineStoppedError());
    expect(childController(parent.signal).signal.reason).toBeInstanceOf(EngineStoppedError);
  });
});

describe('flushPendingQueue — stop signal', () => {
  function queue(...paths: string[]): OperationLog {
    const log = new OperationLog();
    for (const filePath of paths) log.enqueueOperation('b1', { opType: 'CREATE', filePath });
    return log;
  }

  const queued = (log: OperationLog): string[] =>
    log.dequeueOperations('b1').map((op) => op.filePath);

  it('records each outcome as it arrives, not at the end of the pass', async () => {
    const log = queue('a.md', 'b.md', 'c.md');
    const seen: string[][] = [];
    const emit: PendingEmitter = async (op) => {
      seen.push(queued(log));
      return op.filePath === 'b.md'
        ? { ok: false, retryable: false, error: 'forbidden' }
        : { ok: true };
    };

    const result = await flushPendingQueue('b1', log, emit);

    expect(seen).toEqual([['a.md', 'b.md', 'c.md'], ['b.md', 'c.md'], ['c.md']]);
    expect(result).toMatchObject({ sent: 2, droppedCount: 1, remaining: 0 });
  });

  it('ignores an answer that lands after the abort and emits nothing more', async () => {
    const log = queue('a.md', 'b.md', 'c.md');
    const { controller, reason } = stopper();
    const emitted: string[] = [];
    let answerB!: (outcome: ReplayOutcome) => void;
    const emit: PendingEmitter = (op) => {
      emitted.push(op.filePath);
      if (op.filePath === 'a.md') return Promise.resolve({ ok: true });
      return new Promise<ReplayOutcome>((resolve) => {
        answerB = resolve;
      });
    };

    const drain = flushPendingQueue('b1', log, emit, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual(['a.md', 'b.md']);
    controller.abort(reason);
    answerB({ ok: true });

    await expect(drain).rejects.toBe(reason);
    expect(emitted).toEqual(['a.md', 'b.md']);
    // a.md was acknowledged before the stop; b.md's late answer counts for nothing.
    expect(queued(log)).toEqual(['b.md', 'c.md']);
  });

  it('emits nothing when the signal is already aborted', async () => {
    const log = queue('a.md');
    const { controller, reason } = stopper();
    controller.abort(reason);
    const emit = jest.fn<Promise<ReplayOutcome>, Parameters<PendingEmitter>>();

    await expect(flushPendingQueue('b1', log, emit, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(emit).not.toHaveBeenCalled();
    expect(queued(log)).toEqual(['a.md']);
  });
});

describe('ApiClient — cancellable binary transfers', () => {
  const server = { url: 'https://sync.example.com', apiKey: 'osk_secret' };
  const noRequest: RequestFn = async () => {
    throw new Error('binary test should not call requestUrl');
  };
  const ok = (buf = new ArrayBuffer(0)): RequestUrlResponse => ({
    status: 200,
    json: { ok: true },
    arrayBuffer: buf,
    headers: {},
    text: '',
  });

  it('hands the signal to the binary transport for downloads and blob uploads', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const binary: BinaryRequestFn = async (params) => {
      signals.push(params.signal);
      return ok();
    };
    const client = new ApiClient(server, noRequest, binary);
    const { signal } = new AbortController();

    await client.downloadFile('p1', 'f1', { signal });
    await client.uploadBlob('p1', 'a'.repeat(64), new ArrayBuffer(1), { signal });
    await client.downloadFileVersion('p1', 'f1', 'v1', { signal });
    await client.downloadFile('p1', 'f1');

    expect(signals).toEqual([signal, signal, signal, undefined]);
  });

  it('passes the signal on to fetch', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
    try {
      const client = new ApiClient(server, noRequest);
      const { signal } = new AbortController();
      const buf = await client.downloadFile('p1', 'f1', { signal });
      expect(buf.byteLength).toBe(2);
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a cancelled transfer with the abort reason, not as a network error', async () => {
    const { controller, reason } = stopper();
    const binary: BinaryRequestFn = (params) =>
      new Promise((_resolve, reject) => {
        params.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new ApiClient(server, noRequest, binary);

    const download = client.downloadFile('p1', 'f1', { signal: controller.signal });
    controller.abort(reason);

    await expect(download).rejects.toBe(reason);
  });

  it('still maps a transport failure without an abort to a retryable network error', async () => {
    const binary: BinaryRequestFn = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const client = new ApiClient(server, noRequest, binary);
    const { signal } = new AbortController();

    await expect(client.uploadBlob('p1', 'h', new ArrayBuffer(1), { signal })).rejects.toEqual(
      expect.objectContaining({ kind: 'network', retryable: true }),
    );
    await expect(client.downloadFile('p1', 'f1', { signal })).rejects.toBeInstanceOf(ApiError);
  });
});
