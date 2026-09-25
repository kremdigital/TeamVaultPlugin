/**
 * Creates of this device's that meet another file on the way: a save or a
 * rename while a create replayed from the offline queue waits for its ack, a
 * teammate's create of the same name the server applies first, and a note
 * renamed right after its create when a teammate took its name meanwhile.
 *
 * Before: the save and the rename found no record of the replayed note and
 * went out as a second create (a conflict copy, or the note under both names,
 * for the whole team); the teammate's note was recorded over the copy of this
 * device's, and the first snapshot put this device's text into it for
 * everyone; the note renamed right after its create was sent a second time,
 * or the teammate's note was renamed in its place.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
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

function records(h: Harness): string[] {
  return h.log
    .listFileMeta('b1')
    .map((m) => `${m.serverFileId}:${m.relativePath}`)
    .sort();
}

/** Every live file on the server as `id:path`. */
function ids(server: FakeServer): string[] {
  return [...server.files.values()]
    .filter((f) => !f.deleted)
    .map((f) => `${f.id}:${f.path}`)
    .sort();
}

async function connected(
  format: BroadcastFormat,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  const docs = new ServerDocs(server, h);
  await connect(h);
  await flushAsync(20);
  return { h, server, docs };
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

function create(h: Harness, path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type: 'create', path, source: 'obsidian' });
}

function modify(h: Harness, path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type: 'modify', path, source: 'obsidian' });
}

/**
 * A note created offline; the network is back, and the drain has sent its
 * create, which the server has not answered yet.
 */
async function replayedCreateOut(
  format: BroadcastFormat,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const { h, server, docs } = await connected(format);
  h.socket().disconnect();
  await flushAsync();
  h.vault.files.set('Untitled.md', encode('draft\n'));
  await create(h, 'Untitled.md');
  expect(h.log.dequeueOperations('b1').map((op) => `${op.opType} ${op.filePath}`)).toEqual([
    'CREATE Untitled.md',
  ]);
  h.socket().connect();
  await flushAsync();
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
  await flushAsync(40);
  expect(h.socket().created()).toEqual(['Untitled.md']);
  return { h, server, docs };
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a create replayed from the offline queue, %s broadcasts',
  (format) => {
    it('takes a save made while it waits for its ack for a save of the note', async () => {
      const { h, server, docs } = await replayedCreateOut(format);

      h.vault.files.set('Untitled.md', encode('draft\nmore\n'));
      const saved = modify(h, 'Untitled.md');
      await flushAsync(10);
      // No second create: the save waits for the one on its way.
      expect(h.socket().created()).toEqual(['Untitled.md']);
      await docs.drive();
      await saved;
      await docs.drive();

      expect(server.applied).toEqual(['create Untitled.md']);
      expect(docs.live()).toEqual(['Untitled.md=draft\nmore\n']);
      expect(disk(h)).toEqual(['Untitled.md=draft\nmore\n']);

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['Untitled.md=draft\nmore\n']);
      expect(disk(next)).toEqual(['Untitled.md=draft\nmore\n']);
      await next.engine.stop();
    });

    it('sends a rename made while it waits for its ack as the rename of the note', async () => {
      const { h, server, docs } = await replayedCreateOut(format);

      await h.vault.rename('Untitled.md', 'Plan.md');
      await flushAsync(10);
      expect(h.socket().created()).toEqual(['Untitled.md']);
      await docs.drive();
      await h.settle();
      await docs.drive();

      expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Plan.md']);
      expect(docs.live()).toEqual(['Plan.md=draft\n']);
      expect(disk(h)).toEqual(['Plan.md=draft\n']);
      expect(records(h)).toEqual(['s1:Plan.md']);

      const next = await restart(h, server, docs);
      expect(docs.live()).toEqual(['Plan.md=draft\n']);
      expect(disk(next)).toEqual(['Plan.md=draft\n']);
      await next.engine.stop();
    });
  },
);

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a teammate creates a note under the name of one being created here, %s broadcasts',
  (format) => {
    const P = '2026-09-25.md';

    it('keeps their note as it is and stores this one under a conflict name', async () => {
      const { h, server, docs } = await connected(format);

      h.vault.files.set(P, encode('mine\n'));
      const created = create(h, P);
      await flushAsync(5);
      expect(h.socket().created()).toEqual([P]);
      // The server applies the teammate's create first; its broadcast comes
      // while this device's create waits for its ack.
      await server.teammateCreate(P, 'theirs\n');
      await flushAsync(40);
      // Not taken for the note under the name here.
      expect(h.engine.getFileIdForPath(P)).toBeNull();
      expect(disk(h)).toEqual([`${P}=mine\n`]);

      await docs.drive();
      await created;
      await docs.drive();

      const both = ['2026-09-25.conflict-device-1.md=mine\n', `${P}=theirs\n`];
      expect(docs.live()).toEqual(both);
      expect(disk(h)).toEqual(both);
      expect(records(h)).toEqual(['s1:2026-09-25.md', 's3:2026-09-25.conflict-device-1.md']);

      const next = await restart(h, server, docs);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(both);
      expect(disk(next)).toEqual(both);
      await next.engine.stop();
    });
  },
);

/**
 * A note created here and renamed right away (Templater), while a teammate's
 * note already took its first name on the server. `order`: whether the
 * teammate's broadcast reaches this device before the ack of its own create
 * or after.
 */
async function renamedRightAfter(
  format: BroadcastFormat,
  order: 'ack-first' | 'broadcast-first',
  mine: string,
  theirs: string,
): Promise<{ h: Harness; server: FakeServer; docs: ServerDocs }> {
  const { h, server, docs } = await connected(format);
  h.vault.files.set('Untitled.md', encode(mine));
  const created = create(h, 'Untitled.md');
  await flushAsync(5);
  expect(h.socket().created()).toEqual(['Untitled.md']);
  // Renamed before any answer.
  await h.vault.rename('Untitled.md', 'Meeting.md');
  await flushAsync(5);
  if (order === 'broadcast-first') {
    await server.teammateCreate('Untitled.md', theirs);
    await flushAsync(40);
  } else {
    // On the server already, its broadcast still on the way.
    await docs.add('f9', 'Untitled.md', theirs);
  }
  // This device's create is answered.
  server.serveNext();
  await flushAsync(40);
  if (order === 'ack-first') {
    const outcome = { kind: 'created', fileId: 'f9', path: 'Untitled.md' };
    const log = { id: 'l99', vectorClock: { 'device-2': 99 }, createdAt: '2026-01-01' };
    h.socket().fire('file:created', {
      result: { outcome, log },
      log,
      ...(format === 'current' ? { clientId: 'device-2', revived: false } : {}),
    });
    const doc = docs.docs.get('f9');
    if (!doc) throw new Error('no doc f9');
    h.socket().fire('yjs:update', { fileId: 'f9', update: Array.from(Y.encodeStateAsUpdate(doc)) });
    await flushAsync(40);
  }
  await docs.drive();
  await created;
  await h.settle();
  await docs.drive();
  return { h, server, docs };
}

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a note renamed right after its create, its first name taken by a teammate, %s broadcasts',
  (format) => {
    it.each(['ack-first', 'broadcast-first'] as const)(
      'moves this note from its conflict name to the new one and keeps theirs (%s)',
      async (order) => {
        const { h, server, docs } = await renamedRightAfter(format, order, 'mine\n', 'theirs\n');

        // Created once, then renamed from the name the server stored it at.
        expect(h.socket().created()).toEqual(['Untitled.md']);
        expect(server.applied.filter((a) => a.startsWith('create'))).toHaveLength(
          order === 'ack-first' ? 1 : 2,
        );
        expect(server.applied[server.applied.length - 1]).toMatch(
          /^s\d+ Untitled\.conflict-device-1\.md -> Meeting\.md$/,
        );
        const both = ['Meeting.md=mine\n', 'Untitled.md=theirs\n'];
        expect(docs.live()).toEqual(both);
        expect(disk(h)).toEqual(both);

        const next = await restart(h, server, docs);
        expect(next.socket().created()).toEqual([]);
        expect(docs.live()).toEqual(both);
        expect(disk(next)).toEqual(both);
        await next.engine.stop();
      },
    );
  },
);

describe('SyncEngine — a note renamed right after its create, a teammate made the same note first', () => {
  it('does not rename their note: this one goes out under the new name', async () => {
    const { h, server, docs } = await renamedRightAfter('current', 'broadcast-first', '', '');

    // The server gave this device's create the teammate's note (same content).
    expect(ids(server)).toEqual(['s1:Untitled.md', 's4:Meeting.md']);
    expect(server.applied).toEqual(['create Untitled.md', 'create Meeting.md']);
    expect(docs.live()).toEqual(['Meeting.md=', 'Untitled.md=']);
    expect(disk(h)).toEqual(['Meeting.md=', 'Untitled.md=']);
    await h.engine.stop();
  });
});

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — Restore on server for a note a teammate deleted while this device was away, %s broadcasts',
  (format) => {
    it('uploads the note once: its own broadcast is not taken for a teammate’s', async () => {
      const h = buildHarness();
      const server = new FakeServer(h, format);
      const docs = new ServerDocs(server, h);
      const hash = await sha256Hex('x1\n');
      h.vault.files.set('X.md', encode('x1\n'));
      h.log.setFileMeta({
        bindingId: 'b1',
        relativePath: 'X.md',
        serverFileId: 'f1',
        contentHash: hash,
        size: 3,
        fileType: 'TEXT',
        lastSyncedAt: 1,
        foldedHash: hash,
      });
      await docs.add('f1', 'X.md', 'x1\n');
      await connect(h, { yjsDocs: docs.snapshots() });
      await docs.drive();
      await h.engine.stop();

      // Edited while Obsidian was closed; a teammate deleted it meanwhile.
      h.vault.files.set('X.md', encode('x1\nmine\n'));
      server.teammateDelete('f1');

      const next = buildHarness({ predecessor: h });
      server.attach(next);
      docs.attach(next);
      next.modal.del.resolve('restore-server');
      await connect(next, { operations: server.catchupFor(), yjsDocs: docs.snapshots() });
      await docs.drive();

      expect(next.calls.filter((c) => c.startsWith('modal.'))).toEqual([
        'modal.resolveDeleteConflict',
      ]);
      expect(docs.live()).toEqual(['X.md=x1\nmine\n']);
      expect(disk(next)).toEqual(['X.md=x1\nmine\n']);

      const third = await restart(next, server, docs);
      expect(third.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['X.md=x1\nmine\n']);
      expect(disk(third)).toEqual(['X.md=x1\nmine\n']);
      await third.engine.stop();
    });
  },
);
