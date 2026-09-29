/**
 * A note deleted offline, after edits to it: some sent while online, some
 * made offline. A queued delete is held back when the server's text is not
 * one this device knew (a teammate changed the note since, or made it anew),
 * and the note comes back instead.
 *
 * Before: "known" were the note's last synced content and its fold marker
 * only. An offline edit moves the marker past the text the server has — the
 * one the online edit sent — so the delete of a note nobody else touched
 * never went out: the note came back, for good.
 *
 * Now the delete also carries what the note's history held when it was
 * deleted, and the server's doc is checked against it: a server with nothing
 * that history lacks has had no edit from anyone else.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import {
  FakeIndexedDb,
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  dbNameOf,
  encode,
  flushAsync,
  json,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

/** The key of the stamp that says whose history a note's store holds (see `DocManager`). */
const OWNER = 'team-vault-file-id';

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function event(h: Harness, type: 'modify' | 'delete', path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });
}

/** The server's listing follows its doc, as its snapshot of the doc does. */
async function snapshot(server: FakeServer, docs: ServerDocs, id: string): Promise<void> {
  const file = server.files.get(id);
  const text = docs.docs.get(id)?.getText('content').toJSON();
  if (!file || text === undefined) throw new Error(`no note ${id}`);
  server.add({ ...file, contentHash: await sha256Hex(text), size: encode(text).byteLength });
}

/**
 * `P.md` synced — new to this device, the catch-up writes it — edited online
 * (the edit reaches the server), then the network drops and it is edited
 * again.
 */
async function editedOnlineThenOffline(
  docs?: FakeIndexedDb,
): Promise<{ h: Harness; server: FakeServer; serverDocs: ServerDocs }> {
  const h = buildHarness(docs ? { docs: docs.manager() } : {});
  const server = new FakeServer(h);
  const serverDocs = new ServerDocs(server, h);
  // New to this device: the catch-up writes it out.
  h.routes.set('GET /api/projects/p1/files/f1/versions', () => json({ versions: [] }));
  await serverDocs.add('f1', 'P.md', 'A\n');
  await connect(h, { yjsDocs: serverDocs.snapshots() });
  await serverDocs.drive();
  expect(disk(h)).toEqual(['P.md=A\n']);

  h.vault.files.set('P.md', encode('A\nB\n'));
  // The note's state comes from the server first (`yjs:fetch`).
  const saved = event(h, 'modify', 'P.md');
  await serverDocs.drive();
  await saved;
  await serverDocs.drive();
  expect(serverDocs.text('f1')).toBe('A\nB\n');
  await snapshot(server, serverDocs, 'f1');

  h.socket().disconnect();
  await flushAsync();
  h.vault.files.set('P.md', encode('A\nB\nC\n'));
  await event(h, 'modify', 'P.md');
  return { h, server, serverDocs };
}

async function deleteHere(h: Harness): Promise<void> {
  h.vault.files.delete('P.md');
  await event(h, 'delete', 'P.md');
  expect(h.log.dequeueOperations('b1').map((op) => op.opType)).toEqual(['DELETE']);
}

async function reconnect(h: Harness, serverDocs: ServerDocs): Promise<void> {
  h.socket().connect();
  await flushAsync();
  h.socket()
    .pending('project:join')
    .ack({ ok: true, operations: [], yjsDocs: serverDocs.snapshots() });
  await serverDocs.drive();
}

describe('SyncEngine — a note edited online, then offline, then deleted offline', () => {
  it('sends the delete: nobody else changed the note', async () => {
    const { h, server, serverDocs } = await editedOnlineThenOffline();
    await deleteHere(h);

    await reconnect(h, serverDocs);

    expect(server.pathOf('f1')).toBeNull();
    expect(disk(h)).toEqual([]);
    expect(h.log.dequeueOperations('b1')).toEqual([]);
    await h.engine.stop();
  });

  it('sends the delete after a restart in between, from the history in the store', async () => {
    const idb = new FakeIndexedDb();
    const { h, server, serverDocs } = await editedOnlineThenOffline(idb);
    await h.engine.stop();
    // Obsidian started again without network: the note's history is in
    // the store only.
    const next = buildHarness({ predecessor: h, docs: idb.manager(), offline: true });
    server.attach(next);
    serverDocs.attach(next);
    await next.engine.start();
    await flushAsync();
    await deleteHere(next);

    next.socket().goOnline();
    await flushAsync();
    next
      .socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: serverDocs.snapshots() });
    await serverDocs.drive();

    expect(server.pathOf('f1')).toBeNull();
    expect(disk(next)).toEqual([]);
    await next.engine.stop();
  });

  it('sends the delete of a note whose history has no stamp (a store from before 0.3.8), from that history', async () => {
    const idb = new FakeIndexedDb();
    const { h, server, serverDocs } = await editedOnlineThenOffline(idb);
    await h.engine.stop();
    // Written by a build before 0.3.8: the store under the note's name does
    // not say whose history it is. Nothing else is recorded under the name,
    // so it is the note's.
    const store = idb.dbs.get(dbNameOf('P.md'));
    expect(store?.custom.get(OWNER)).toBe('f1');
    store?.custom.delete(OWNER);
    const next = buildHarness({ predecessor: h, docs: idb.manager(), offline: true });
    server.attach(next);
    serverDocs.attach(next);
    await next.engine.start();
    await flushAsync();
    await deleteHere(next);

    next.socket().goOnline();
    await flushAsync();
    next
      .socket()
      .pending('project:join')
      .ack({ ok: true, operations: [], yjsDocs: serverDocs.snapshots() });
    await serverDocs.drive();

    expect(server.pathOf('f1')).toBeNull();
    expect(disk(next)).toEqual([]);
    await next.engine.stop();
  });

  it('holds the delete back when a teammate edited the note meanwhile', async () => {
    const { h, server, serverDocs } = await editedOnlineThenOffline();
    await deleteHere(h);
    // A teammate's edit the server got while this device was offline.
    const doc = serverDocs.docs.get('f1') as Y.Doc;
    doc.getText('content').insert(0, 'theirs\n');
    await snapshot(server, serverDocs, 'f1');

    await reconnect(h, serverDocs);

    expect(server.pathOf('f1')).toBe('P.md');
    expect(serverDocs.text('f1')).toBe('theirs\nA\nB\n');
    expect(disk(h)).toEqual(['P.md=theirs\nA\nB\n']);
    await h.engine.stop();
  });
});
