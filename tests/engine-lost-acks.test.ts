/**
 * Creates the server applied while their ack never reached this device: the
 * connection dropped between the two (socket.io drops the ack callback), or
 * the engine stopped (Pause sync, a reload) with the ack on its way.
 *
 * Before: the emit waited for its ack forever — a note renamed right after
 * its create was never renamed, the old name came back and the new one was
 * uploaded next to it. A note created offline whose create landed that way
 * was taken for another device's file on the next connect: an edit made
 * meanwhile went out as a conflict copy for the whole team. And a create
 * stored under a conflict name left its copy under the name asked for, which
 * the file the server has under that name took for its own after a restart:
 * its text was replaced for everyone.
 */
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function queue(h: Harness): string[] {
  return h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.filePath}`);
}

function event(h: Harness, type: 'create' | 'modify', path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });
}

/** The next start: a new engine on the same vault, log and docs. */
async function restart(h: Harness, server: FakeServer, docs: ServerDocs): Promise<Harness> {
  await h.engine.stop();
  const next = buildHarness({ predecessor: h });
  server.attach(next);
  docs.attach(next);
  await connect(next, { operations: server.catchupFor(), yjsDocs: docs.snapshots() });
  await docs.drive();
  return next;
}

/** Wi-Fi back: the socket connects again and the join is answered. */
async function reconnect(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: server.catchupFor(), yjsDocs: docs.snapshots() });
  await docs.drive();
}

/**
 * The server applies the create waiting for its ack, and the connection
 * drops before the ack gets back: socket.io never calls it.
 */
async function createLandsAckLost(h: Harness, server: FakeServer): Promise<void> {
  const out = h.socket().emits.find((e) => e.event === 'file:create');
  if (!out) throw new Error('no create out');
  out.ack = (): void => undefined;
  h.socket().disconnect();
  expect(server.serveNext()).toBe(true);
  await flushAsync(20);
}

/** A device that synced once, then a session without network. */
async function offlineSession(
  format: BroadcastFormat,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const first = buildHarness();
  const server = new FakeServer(first, format);
  const docs = new ServerDocs(server, first);
  await connect(first);
  await flushAsync(20);
  await first.engine.stop();
  const h = buildHarness({ predecessor: first, offline: true });
  server.attach(h);
  docs.attach(h);
  await h.engine.start();
  return { h, server, docs };
}

/** The network is back for a session that started without it; the join is answered. */
async function online(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  h.socket().goOnline();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: server.catchupFor(), yjsDocs: docs.snapshots() });
  await flushAsync(40);
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a create applied on the server without its ack, %s broadcasts',
  (format) => {
    it('takes the note created offline for its own when the drain’s ack is lost, and keeps the edit made since', async () => {
      const { h, server, docs } = await offlineSession(format);
      h.vault.files.set('N.md', encode('v1\n'));
      await event(h, 'create', 'N.md');
      await online(h, server, docs);
      await createLandsAckLost(h, server);
      expect(server.applied).toEqual(['create N.md']);

      // Typed on while the network is gone again.
      h.vault.files.set('N.md', encode('v1\nv2\n'));
      await event(h, 'modify', 'N.md');
      await reconnect(h, server, docs);

      expect(docs.live()).toEqual(['N.md=v1\nv2\n']);
      expect(disk(h)).toEqual(['N.md=v1\nv2\n']);
      expect(server.applied).toEqual(['create N.md']);
      expect(queue(h)).toEqual([]);

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['N.md=v1\nv2\n']);
      expect(disk(next)).toEqual(['N.md=v1\nv2\n']);
      await next.engine.stop();
    });

    it('takes it for its own after a Pause landing between the server’s apply and the ack', async () => {
      const { h, server, docs } = await offlineSession(format);
      h.vault.files.set('N.md', encode('v1\n'));
      await event(h, 'create', 'N.md');
      await online(h, server, docs);
      expect(h.socket().created()).toEqual(['N.md']);
      const stopping = h.engine.stop();
      expect(server.serveNext()).toBe(true);
      await stopping;

      // The next session starts offline; the note is edited, then Wi-Fi comes.
      const next = buildHarness({ predecessor: h, offline: true });
      server.attach(next);
      docs.attach(next);
      await next.engine.start();
      next.vault.files.set('N.md', encode('v1\nv2\n'));
      await event(next, 'modify', 'N.md');
      await online(next, server, docs);
      await docs.drive();

      expect(docs.live()).toEqual(['N.md=v1\nv2\n']);
      expect(disk(next)).toEqual(['N.md=v1\nv2\n']);
      expect(server.applied).toEqual(['create N.md']);
      await next.engine.stop();
    });

    it('frees the name for the teammate’s note when its own create is on the conflict name already', async () => {
      const { h, server, docs } = await offlineSession(format);
      h.vault.files.set('N.md', encode('my N\n'));
      await event(h, 'create', 'N.md');
      await server.teammateCreate('N.md', 'their N\n');
      await online(h, server, docs);
      // Stored under the conflict name; the ack is lost.
      await createLandsAckLost(h, server);
      expect(server.applied).toEqual(['create N.md', 'create N.conflict-device-1.md']);

      await reconnect(h, server, docs);

      const both = ['N.conflict-device-1.md=my N\n', 'N.md=their N\n'];
      expect(docs.live()).toEqual(both);
      expect(disk(h)).toEqual(both);
      expect(queue(h)).toEqual([]);

      // A restart does not take the copy for their note.
      const next = await restart(h, server, docs);
      expect(docs.live()).toEqual(both);
      expect(disk(next)).toEqual(both);
      await next.engine.stop();
    });

    it('queues a rename and a delete whose connection drops before they reach the server', async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h);
      for (const [path, id, text] of [
        ['a.md', 'f1', 'A\n'],
        ['c.md', 'f2', 'C\n'],
      ] as const) {
        h.vault.files.set(path, encode(text));
        await docs.add(id, path, text);
      }
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();

      const lose = (event: string): void => {
        const i = h.socket().emits.findIndex((e) => e.event === event);
        if (i < 0) throw new Error(`no ${event} out`);
        h.socket().emits.splice(i, 1);
      };
      await h.vault.rename('a.md', 'b.md');
      await flushAsync(5);
      h.vault.files.delete('c.md');
      const deleted = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'delete',
        path: 'c.md',
        source: 'obsidian',
      });
      await flushAsync(5);
      // Lost with the connection before the server read them.
      lose('file:rename');
      lose('file:delete');
      h.socket().disconnect();
      await deleted;
      await h.settle();
      expect(queue(h)).toEqual(['RENAME a.md', 'DELETE c.md']);

      await reconnect(h, server, docs);

      expect(server.applied).toEqual(['f1 a.md -> b.md', 'delete f2']);
      expect(docs.live()).toEqual(['b.md=A\n']);
      expect(disk(h)).toEqual(['b.md=A\n']);
      expect(queue(h)).toEqual([]);
      await h.engine.stop();
    });

    // Renamed after the drop, without network: the create is queued by then,
    // and it was queued again under the new name — the team got the note
    // under both names.
    it.each(['the connection is back', 'Pause sync and Resume sync'] as const)(
      'renames the note renamed without network after its create went out, its ack lost (%s)',
      async (how) => {
        let h = buildHarness();
        const server = new FakeServer(h, format);
        const docs = new ServerDocs(server, h);
        await connect(h);
        await flushAsync(20);

        h.vault.files.set('Untitled.md', encode('tpl\n'));
        const created = event(h, 'create', 'Untitled.md');
        await flushAsync(5);
        await createLandsAckLost(h, server);
        await created;
        await h.settle();
        if (how === 'Pause sync and Resume sync') {
          await h.engine.stop();
          const next = buildHarness({ predecessor: h, offline: true });
          server.attach(next);
          docs.attach(next);
          await next.engine.start();
          h = next;
        }
        await h.vault.rename('Untitled.md', 'Meeting.md');
        await flushAsync(5);
        await h.settle();
        expect(queue(h)).toEqual(['CREATE Meeting.md']);

        if (how === 'the connection is back') await reconnect(h, server, docs);
        else await online(h, server, docs);
        await docs.drive();

        expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Meeting.md']);
        expect(docs.live()).toEqual(['Meeting.md=tpl\n']);
        expect(disk(h)).toEqual(['Meeting.md=tpl\n']);
        expect(queue(h)).toEqual([]);
        await h.engine.stop();
      },
    );

    // Typed into before the rename: the save queued a second create, which
    // never went out, and the rename took that one for the note's only entry.
    // The one that went out stayed under the old name, and the next connect
    // recorded the note there — gone from the disk, written back — while the
    // rename went out as a second create: the note twice, for the whole team.
    it.each(['the connection is back', 'Pause sync and Resume sync'] as const)(
      'renames the note edited and then renamed without network after its create went out, its ack lost (%s)',
      async (how) => {
        let h = buildHarness();
        const server = new FakeServer(h, format);
        const docs = new ServerDocs(server, h);
        await connect(h);
        await flushAsync(20);

        h.vault.files.set('Untitled.md', encode('tpl\n'));
        const created = event(h, 'create', 'Untitled.md');
        await flushAsync(5);
        await createLandsAckLost(h, server);
        await created;
        await h.settle();
        if (how === 'Pause sync and Resume sync') {
          await h.engine.stop();
          const next = buildHarness({ predecessor: h, offline: true });
          server.attach(next);
          docs.attach(next);
          await next.engine.start();
          h = next;
        }
        h.vault.files.set('Untitled.md', encode('tpl\nmine\n'));
        await event(h, 'modify', 'Untitled.md');
        await h.settle();
        expect(queue(h)).toEqual(['CREATE Untitled.md', 'CREATE Untitled.md']);
        await h.vault.rename('Untitled.md', 'Meeting.md');
        await flushAsync(5);
        await h.settle();
        expect(queue(h)).toEqual(['CREATE Meeting.md', 'CREATE Meeting.md']);

        if (how === 'the connection is back') await reconnect(h, server, docs);
        else await online(h, server, docs);
        await docs.drive();

        expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Meeting.md']);
        expect(docs.live()).toEqual(['Meeting.md=tpl\nmine\n']);
        expect(disk(h)).toEqual(['Meeting.md=tpl\nmine\n']);
        expect(queue(h)).toEqual([]);
        await h.engine.stop();
      },
    );

    it('renames the note it created right before, once the connection is back', async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h);
      await connect(h);
      await flushAsync(20);

      h.vault.files.set('Untitled.md', encode('tpl\n'));
      const created = event(h, 'create', 'Untitled.md');
      await flushAsync(5);
      expect(h.socket().created()).toEqual(['Untitled.md']);
      // Templater renames the note before the ack.
      await h.vault.rename('Untitled.md', 'Meeting.md');
      await flushAsync(5);
      await createLandsAckLost(h, server);
      // The rename is not held forever by an ack that never comes.
      await created;
      await h.settle();

      await reconnect(h, server, docs);

      expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Meeting.md']);
      expect(docs.live()).toEqual(['Meeting.md=tpl\n']);
      expect(disk(h)).toEqual(['Meeting.md=tpl\n']);
      expect(queue(h)).toEqual([]);

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['Meeting.md=tpl\n']);
      expect(disk(next)).toEqual(['Meeting.md=tpl\n']);
      await next.engine.stop();
    });
  },
);
