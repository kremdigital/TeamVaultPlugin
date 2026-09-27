/**
 * A note created offline under a name a teammate used meanwhile goes to the
 * server under a conflict name, `<name>.conflict-<clientId>[-n]`: the first
 * free one. (Production when 0.3.8 came out always took the first and
 * overwrote a live file under it; this client no longer connects to it.)
 *
 * The second collision of a name while the first conflict copy is still there
 * goes under the next free name, and the same create sent again after its ack
 * was lost is not applied again: the connect asks the server about it
 * (`ops:status`) and the copy here follows it to the conflict name.
 */
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  joinToAnswer,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function event(h: Harness, type: 'create' | 'modify', path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });
}

/** The server's answer to the join: the whole journal, and the docs. */
function answer(server: FakeServer, docs: ServerDocs) {
  return server.joinAnswer('whole journal', {
    yjsDocs: docs.snapshots(),
  });
}

async function drop(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

async function reconnect(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  h.socket().connect();
  (await joinToAnswer(h)).ack(answer(server, docs));
  await docs.drive();
  await h.settle();
  await docs.drive();
}

describe('SyncEngine — a name taken on the server a second time', () => {
  it('keeps the first conflict copy and stores the second under a free name', async () => {
    const h = buildHarness();
    const server = new FakeServer(h);
    const docs = new ServerDocs(server, h);
    await connect(h);
    await docs.drive();

    // Day one: this device makes U.md offline, and so does a teammate.
    await drop(h);
    h.vault.files.set('U.md', encode('day one\n'));
    await event(h, 'create', 'U.md');
    await server.teammateCreate('U.md', 'T two\n');
    await reconnect(h, server, docs);
    expect(docs.live()).toEqual(['U.conflict-device-1.md=day one\n', 'U.md=T two\n']);

    // The teammate renames theirs; day two goes the same way.
    const theirs = [...server.files.values()].find((f) => f.path === 'U.md')?.id ?? '';
    server.teammateRename(theirs, 'T two.md');
    await docs.drive();
    await drop(h);
    h.vault.files.set('U.md', encode('day two\n'));
    await event(h, 'create', 'U.md');
    await server.teammateCreate('U.md', 'T three\n');
    await reconnect(h, server, docs);

    const all = [
      'T two.md=T two\n',
      'U.conflict-device-1-2.md=day two\n',
      'U.conflict-device-1.md=day one\n',
      'U.md=T three\n',
    ];
    expect(docs.live()).toEqual(all);
    expect(disk(h)).toEqual(all);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    expect(h.socket().created()).toHaveLength(2);

    // Nothing more goes out, and a restart takes nothing for another file.
    await drop(h);
    await reconnect(h, server, docs);
    await h.engine.stop();
    const next = buildHarness({ predecessor: h });
    server.attach(next);
    docs.attach(next);
    await next.engine.start();
    next.socket().pending('project:join').ack(answer(server, docs));
    await docs.drive();
    await next.settle();
    await docs.drive();
    expect(docs.live()).toEqual(all);
    expect(disk(next)).toEqual(all);
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });

  it.each([false, true])(
    'sends a create whose conflict copy landed, its ack lost, no more (edited since: %s)',
    async (edited) => {
      const first = buildHarness();
      const server = new FakeServer(first);
      const docs = new ServerDocs(server, first);
      await connect(first);
      await flushAsync(20);
      await first.engine.stop();
      const h = buildHarness({ predecessor: first, offline: true });
      server.attach(h);
      docs.attach(h);
      await h.engine.start();

      h.vault.files.set('N.md', encode('my N\n'));
      await event(h, 'create', 'N.md');
      await server.teammateCreate('N.md', 'their N\n');
      h.socket().goOnline();
      await flushAsync();
      h.socket().pending('project:join').ack(answer(server, docs));
      await flushAsync(40);
      // Stored under the conflict name; the ack is lost with the connection.
      const out = h.socket().emits.find((e) => e.event === 'file:create');
      if (!out) throw new Error('no create out');
      out.ack = (): void => undefined;
      await drop(h);
      expect(server.serveNext()).toBe(true);
      await flushAsync(20);
      expect(server.applied).toEqual(['create N.md', 'create N.conflict-device-1.md']);

      if (edited) {
        h.vault.files.set('N.md', encode('my N\nmore\n'));
        await event(h, 'modify', 'N.md');
        await h.settle();
      }
      await reconnect(h, server, docs);

      // The connect learns from `ops:status` where the note went: the copy
      // here follows it to the conflict name, and an edit made since is an
      // edit of that note.
      expect(server.statusAnswers.at(-1)?.applied).toHaveLength(1);
      const all = [`N.conflict-device-1.md=my N\n${edited ? 'more\n' : ''}`, 'N.md=their N\n'];
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      expect(h.socket().created()).toEqual(['N.md']);
      expect(server.applied).toEqual(['create N.md', 'create N.conflict-device-1.md']);

      await drop(h);
      await reconnect(h, server, docs);
      expect(docs.live()).toEqual(all);
      expect(disk(h)).toEqual(all);
      await h.engine.stop();
    },
  );
});
