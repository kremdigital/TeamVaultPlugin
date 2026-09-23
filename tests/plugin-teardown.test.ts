import {
  awaitPreviousTeardown,
  claimStateFile,
  handOffTeardown,
  teardownPlugin,
} from '@/integration/plugin-teardown';

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued promise reaction run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Records the order in which the parts were touched. */
function buildParts(): {
  calls: string[];
  engines: ReturnType<typeof deferred>;
  chokidar: ReturnType<typeof deferred>;
  warn: jest.Mock;
  parts: Parameters<typeof teardownPlugin>[0];
} {
  const calls: string[] = [];
  const engines = deferred();
  const chokidar = deferred();
  const warn = jest.fn();
  return {
    calls,
    engines,
    chokidar,
    warn,
    parts: {
      unsubscribes: [() => void calls.push('unsubscribe'), null],
      obsidianWatcher: { stop: () => void calls.push('obsidianWatcher.stop') },
      fsWatcher: {
        stop: () => {
          calls.push('fsWatcher.stop');
          return chokidar.promise;
        },
      },
      statusBar: { destroy: () => void calls.push('statusBar.destroy') },
      engineManager: {
        stop: () => {
          calls.push('engineManager.stop');
          return engines.promise;
        },
      },
      docManager: {
        destroy: async () => {
          calls.push('docManager.destroy');
        },
      },
      operationLog: {
        close: async () => {
          calls.push('operationLog.close');
        },
      },
      logger: { warn },
    },
  };
}

describe('teardownPlugin', () => {
  it('detaches listeners, watchers, the status bar and the sockets before it returns', () => {
    const { calls, parts } = buildParts();

    // Neither the engines nor chokidar have settled: Obsidian would not wait.
    void teardownPlugin(parts);

    // The status subscription goes first: stopping the engines turns the
    // aggregate offline, and that must not raise a "connection lost" notice.
    expect(calls).toEqual([
      'unsubscribe',
      'obsidianWatcher.stop',
      'fsWatcher.stop',
      'statusBar.destroy',
      'engineManager.stop',
    ]);
  });

  it('flushes the log and closes the offline docs once the engines stop, without waiting for chokidar', async () => {
    // The next instance of the plugin reads `state.json` as soon as this
    // teardown is done; chokidar can take its time closing.
    const { calls, engines, chokidar, parts } = buildParts();
    const done = teardownPlugin(parts);
    let finished = false;
    void done.then(() => {
      finished = true;
    });

    await settle();
    expect(calls).not.toContain('operationLog.close');
    expect(calls).not.toContain('docManager.destroy');

    engines.resolve();
    await settle();
    expect(calls.slice(5)).toEqual(['operationLog.close', 'docManager.destroy']);
    expect(finished).toBe(false);

    chokidar.resolve();
    await done;
    expect(finished).toBe(true);
  });

  it('logs a failed step and still runs the ones after it', async () => {
    const { calls, engines, chokidar, warn, parts } = buildParts();
    parts.obsidianWatcher = {
      stop: () => {
        throw new Error('offref failed');
      },
    };
    parts.docManager = { destroy: () => Promise.reject(new Error('idb blocked')) };
    const done = teardownPlugin(parts);
    engines.reject(new Error('socket gone'));
    chokidar.resolve();

    await expect(done).resolves.toBeUndefined();
    expect(calls).toContain('statusBar.destroy');
    expect(calls).toContain('operationLog.close');
    expect(warn.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'unload: vault listeners failed',
      'unload: sync engines failed',
      'unload: offline documents failed',
    ]);
  });

  it('tolerates parts that onload never built', async () => {
    await expect(
      teardownPlugin({
        unsubscribes: [null],
        obsidianWatcher: null,
        fsWatcher: null,
        statusBar: null,
        engineManager: null,
        docManager: null,
        operationLog: null,
        logger: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('teardown handoff', () => {
  it('lets the next instance load at once when nothing is shutting down', async () => {
    await expect(awaitPreviousTeardown({}, 'team-vault', 60_000)).resolves.toBe(true);
  });

  it('makes the next instance wait for the previous teardown, then clears the slot', async () => {
    const host = {};
    const teardown = deferred();
    handOffTeardown(host, 'team-vault', teardown.promise);

    let waited = false;
    const wait = awaitPreviousTeardown(host, 'team-vault', 60_000).then((ok) => {
      waited = true;
      return ok;
    });
    await settle();
    expect(waited).toBe(false);

    teardown.resolve();
    await expect(wait).resolves.toBe(true);
    expect(Object.getOwnPropertySymbols(host)).toEqual([]);
  });

  it('gives up on a teardown that never settles', async () => {
    jest.useFakeTimers();
    try {
      const host = {};
      handOffTeardown(host, 'team-vault', new Promise<void>(() => undefined));
      const wait = awaitPreviousTeardown(host, 'team-vault', 5000);
      jest.advanceTimersByTime(5000);
      await expect(wait).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keys the slot by plugin id and keeps a newer teardown when an older one settles', async () => {
    const host = {};
    const older = deferred();
    const newer = deferred();
    handOffTeardown(host, 'team-vault', older.promise);
    handOffTeardown(host, 'team-vault', newer.promise);
    older.resolve();
    await settle();

    await expect(awaitPreviousTeardown(host, 'another-plugin', 60_000)).resolves.toBe(true);
    let waited = false;
    const wait = awaitPreviousTeardown(host, 'team-vault', 60_000).then(() => {
      waited = true;
    });
    await settle();
    expect(waited).toBe(false);
    newer.resolve();
    await wait;
  });
});

describe('teardown handoff — an instance unloaded while loading', () => {
  it('keeps waiting for the slow teardown before a quick one', async () => {
    // A's teardown is slow; B was disabled while still loading and tore down
    // at once. C must still wait for A.
    const host = {};
    const slow = deferred();
    handOffTeardown(host, 'team-vault', slow.promise);
    handOffTeardown(host, 'team-vault', Promise.resolve());
    await settle();

    let waited = false;
    const wait = awaitPreviousTeardown(host, 'team-vault', 60_000).then(() => {
      waited = true;
    });
    await settle();
    expect(waited).toBe(false);

    slow.resolve();
    await wait;
    await settle();
    expect(Object.getOwnPropertySymbols(host)).toEqual([]);
  });
});

describe('claimStateFile', () => {
  it('hands the state file to the latest instance', () => {
    const host = {};
    const first = claimStateFile(host, 'team-vault');
    expect(first()).toBe(true);

    const second = claimStateFile(host, 'team-vault');
    expect(first()).toBe(false);
    expect(second()).toBe(true);

    // Another plugin id is a file of its own.
    const other = claimStateFile(host, 'another-plugin');
    expect(other()).toBe(true);
    expect(second()).toBe(true);
  });
});
