/**
 * A teammate deletes a note and creates it again under its name while this
 * device connects, on a server that replaces a revived note's history (every
 * server before 0.3.8's, production when it came out).
 *
 * The server encodes each doc of the catch-up when it sends it, and the
 * engine keeps what arrives before the listing — slow on a large vault. So
 * the revival's broadcasts can be applied before a catch-up doc encoded ahead
 * of them: the deleted note's history. Before, that old history was taken for
 * the note's own and the new one deleted: the deleted note's text came back
 * to disk, the next edit here went to the server on the old history, and once
 * the two histories met there the note's text was doubled for the whole team
 * (or the deleted note's text merged into the new one). An edit made offline
 * after such a connect went into a conflict copy, and a delete was not sent.
 */
import { sha256Hex } from '@/sync/hash';
import type { YjsDocSnapshot } from '@/client/socket';
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  deferred,
  encode,
  flushAsync,
  type BroadcastFormat,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(30_000);

const LIST = 'GET /api/projects/p1/files';
const OLD = 'shopping list\nmilk\n';

async function remember(h: Harness, path: string, fileId: string, text: string): Promise<void> {
  const hash = await sha256Hex(text);
  h.vault.files.set(path, encode(text));
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: encode(text).byteLength,
    fileType: 'TEXT',
    lastSyncedAt: 1,
    foldedHash: hash,
  });
}

/** How the server delivers the docs: in the join's answer, or streamed after it. */
type Delivery = 'inline' | 'streamed';

/** Production's answer to the join: the journal's first rows, no echo. */
async function answerJoin(
  h: Harness,
  server: FakeServer,
  delivery: Delivery,
  docs: YjsDocSnapshot[],
): Promise<void> {
  const answer = server.joinAnswer('first rows');
  if (delivery === 'inline') {
    h.socket()
      .pending('project:join')
      .ack({ ...answer, yjsDocs: docs });
    return;
  }
  h.socket()
    .pending('project:join')
    .ack({ ...answer, yjsStream: true, yjsCount: docs.length });
  await flushAsync(3);
  h.socket().fire('yjs:catchup', { projectId: 'p1', docs, done: true });
}

/**
 * Plan.md (and Other.md) synced; then a reconnect whose listing is slow, and
 * whose catch-up docs are encoded before the teammate deletes Plan.md and
 * creates it again with `text`.
 */
async function revivedWhileConnecting(delivery: Delivery, text: string, format: BroadcastFormat) {
  const h = buildHarness();
  const server = new FakeServer(h, format);
  // A server that sends `clientId` continues the history instead.
  const docs = new ServerDocs(server, h, { replaceOnRevive: format === 'legacy' });
  await remember(h, 'Plan.md', 'f1', OLD);
  await docs.add('f1', 'Plan.md', OLD);
  await remember(h, 'Other.md', 'f2', 'other\n');
  await docs.add('f2', 'Other.md', 'other\n');
  await h.engine.start();
  await answerJoin(h, server, delivery, docs.snapshots());
  await docs.drive();

  h.socket().disconnect();
  await flushAsync();
  const listing = h.routes.get(LIST);
  if (!listing) throw new Error('no listing');
  const gate = deferred<void>();
  h.routes.set(LIST, () => gate.promise.then(() => listing()));
  h.socket().connect();
  await flushAsync();
  await answerJoin(h, server, delivery, docs.snapshots());
  await flushAsync(10);
  server.teammateDelete('f1');
  await flushAsync(20);
  await server.teammateCreate('Plan.md', text);
  await flushAsync(40);
  h.routes.set(LIST, listing);
  gate.resolve();
  await flushAsync(40);
  await docs.drive();
  return { h, server, docs };
}

async function reconnect(h: Harness, server: FakeServer, docs: ServerDocs): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
  h.socket().connect();
  await flushAsync();
  await answerJoin(h, server, 'streamed', docs.snapshots());
  await flushAsync(40);
  await docs.drive();
}

function conflictCopies(h: Harness): string[] {
  return [...h.vault.files.keys()].filter((p) => p.includes('.conflict-'));
}

describe.each([
  ['streamed', 'legacy'],
  ['inline', 'legacy'],
  ['streamed', 'current'],
] as const)(
  'SyncEngine — a note revived while this device connects, docs %s, %s broadcasts',
  (delivery, format) => {
    it.each([
      ['the same text', OLD],
      ['another text', 'new plan\n'],
    ])('keeps the new note, created again with %s, and an edit to it once', async (_, text) => {
      const { h, server, docs } = await revivedWhileConnecting(delivery, text, format);
      expect(h.vault.text('Plan.md')).toBe(text);
      expect(docs.text('f1')).toBe(text);

      // The user edits the note, and sync connects again.
      h.vault.files.set('Plan.md', encode(`${text}mine\n`));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await h.settle();
      await docs.drive();
      expect(docs.text('f1')).toBe(`${text}mine\n`);
      await reconnect(h, server, docs);

      expect(docs.text('f1')).toBe(`${text}mine\n`);
      expect(h.vault.text('Plan.md')).toBe(`${text}mine\n`);
      expect(conflictCopies(h)).toEqual([]);
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    });

    it('sends an edit made to it offline into it', async () => {
      const { h, server, docs } = await revivedWhileConnecting(delivery, 'new plan\n', format);
      h.socket().disconnect();
      await flushAsync();
      h.vault.files.set('Plan.md', encode('new plan\nmine\n'));
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await h.settle();
      await reconnect(h, server, docs);

      expect(docs.live()).toEqual(['Other.md=other\n', 'Plan.md=new plan\nmine\n']);
      expect(h.vault.text('Plan.md')).toBe('new plan\nmine\n');
      expect(conflictCopies(h)).toEqual([]);
      await h.engine.stop();
    });

    it('sends a delete of it made offline', async () => {
      const { h, server, docs } = await revivedWhileConnecting(delivery, 'new plan\n', format);
      h.socket().disconnect();
      await flushAsync();
      h.vault.files.delete('Plan.md');
      await h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'delete',
        path: 'Plan.md',
        source: 'obsidian',
      });
      await h.settle();
      await reconnect(h, server, docs);

      expect(docs.live()).toEqual(['Other.md=other\n']);
      expect(h.vault.text('Plan.md')).toBeNull();
      await h.engine.stop();
    });
  },
);

describe('SyncEngine — a note deleted here and created again while this device connects', () => {
  it('keeps the new note', async () => {
    const h = buildHarness();
    const server = new FakeServer(h, 'legacy');
    const docs = new ServerDocs(server, h, { replaceOnRevive: true });
    await remember(h, 'Untitled.md', 'f1', OLD);
    await docs.add('f1', 'Untitled.md', OLD);
    await h.engine.start();
    await answerJoin(h, server, 'streamed', docs.snapshots());
    await docs.drive();

    h.socket().disconnect();
    await flushAsync();
    h.socket().connect();
    await flushAsync();
    // The listing is in; the docs of a large vault are still streaming, and
    // the batch with this note is encoded before what the user does next.
    const stale = docs.snapshots();
    h.socket()
      .pending('project:join')
      .ack({ ...server.joinAnswer('first rows'), yjsStream: true, yjsCount: 1 });
    await flushAsync(20);
    // The user deletes the note, and Ctrl+N makes a new "Untitled".
    h.vault.files.delete('Untitled.md');
    const deleting = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'delete',
      path: 'Untitled.md',
      source: 'obsidian',
    });
    await server.pump();
    await deleting;
    h.vault.files.set('Untitled.md', encode('new note\n'));
    const creating = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'create',
      path: 'Untitled.md',
      source: 'obsidian',
    });
    await server.pump();
    await creating;
    expect(server.applied).toEqual(['delete f1', 'create Untitled.md']);
    h.socket().fire('yjs:catchup', { projectId: 'p1', docs: stale, done: true });
    await flushAsync(40);
    await docs.drive();

    expect(h.vault.text('Untitled.md')).toBe('new note\n');
    expect(docs.text('f1')).toBe('new note\n');
    h.vault.files.set('Untitled.md', encode('new note\nmine\n'));
    const editing = h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'Untitled.md',
      source: 'obsidian',
    });
    await docs.drive();
    await editing;
    await docs.drive();
    expect(docs.text('f1')).toBe('new note\nmine\n');
    await reconnect(h, server, docs);

    expect(docs.text('f1')).toBe('new note\nmine\n');
    expect(h.vault.text('Untitled.md')).toBe('new note\nmine\n');
    expect(conflictCopies(h)).toEqual([]);
    await h.engine.stop();
  });
});
