/**
 * A note a teammate moves into the binding's folder from a folder of the
 * project the binding does not sync. No doc update follows a rename, so the
 * note's text has to be pulled from the server.
 *
 * Before: it reached the disk only with the next teammate's edit of it or
 * the next connect — in a connected session, and, when the move came while
 * this device was connecting, also after the catch-up, whose doc of the note
 * was left out as if the note had been created anew since the join.
 */
import * as Y from 'yjs';
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

jest.setTimeout(60_000);

const LIST = 'GET /api/projects/p1/files';

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

/** Answer the pending join, and stream the docs the server has now. */
function answerJoin(
  h: Harness,
  server: FakeServer,
  docs: ServerDocs,
  format: BroadcastFormat,
): void {
  h.socket()
    .pending('project:join')
    .ack({
      ...server.joinAnswer(format === 'current' ? 'whole journal' : 'first rows'),
      yjsStream: true,
      yjsCount: docs.snapshots().length,
    });
}

function stream(h: Harness, docs: ServerDocs): void {
  h.socket().fire('yjs:catchup', { projectId: 'p1', docs: docs.snapshots(), done: true });
}

describe.each(['current', 'legacy'] as BroadcastFormat[])(
  'SyncEngine — a note moved into the binding by a teammate, %s broadcasts',
  (format) => {
    it.each(['connected', 'connecting, batch first', 'connecting, batch last'] as const)(
      'is written to disk at once (%s)',
      async (when) => {
        const h = buildHarness({ localFolder: 'Team' });
        const server = new FakeServer(h, format);
        const docs = new ServerDocs(server, h);
        await docs.add('f1', 'Other/x.md', 'hello\n');
        await docs.add('f2', 'Team/y.md', 'y\n');
        h.vault.files.set('Team/y.md', encode('y\n'));
        await h.engine.start();
        answerJoin(h, server, docs, format);
        await flushAsync(3);
        stream(h, docs);
        await docs.drive();
        expect(disk(h)).toEqual(['Team/y.md=y\n']);

        if (when === 'connected') {
          server.teammateRename('f1', 'Team/x.md');
          await flushAsync(40);
          await docs.drive();
        } else {
          // A large vault: the listing takes a while.
          const listing = h.routes.get(LIST);
          if (!listing) throw new Error('no listing route');
          const gate = deferred<void>();
          h.routes.set(LIST, () => gate.promise.then(() => listing()));
          h.socket().disconnect();
          await flushAsync();
          h.socket().connect();
          await flushAsync();
          answerJoin(h, server, docs, format);
          await flushAsync(3);
          if (when === 'connecting, batch first') stream(h, docs);
          await flushAsync(10);
          server.teammateRename('f1', 'Team/x.md');
          await flushAsync(40);
          if (when === 'connecting, batch last') stream(h, docs);
          h.routes.set(LIST, listing);
          gate.resolve();
          await flushAsync(40);
          await docs.drive();
        }

        expect(h.engine.getStatus()).toBe('connected');
        expect(disk(h)).toEqual(['Team/x.md=hello\n', 'Team/y.md=y\n']);
        expect(h.socket().created()).toEqual([]);

        // A teammate's edit lands on it as on any note.
        const doc = docs.docs.get('f1') as Y.Doc;
        const seen = Y.encodeStateVector(doc);
        doc.getText('content').insert(doc.getText('content').length, 'teammate\n');
        h.socket().fire('yjs:update', {
          fileId: 'f1',
          update: Array.from(Y.encodeStateAsUpdate(doc, seen)),
        });
        await flushAsync(40);
        await docs.drive();
        expect(disk(h)).toEqual(['Team/x.md=hello\nteammate\n', 'Team/y.md=y\n']);
        expect(docs.live()).toEqual(['Team/x.md=hello\nteammate\n', 'Team/y.md=y\n']);
        await h.engine.stop();
      },
    );
  },
);

// A server that cannot be asked for a note (`yjs:fetch`, which servers
// before it lack): the catch-up's doc is where the note's text comes from,
// and it is not left out as one of a note created anew since the join.
describe.each(['current', 'legacy'] as BroadcastFormat[])(
  'SyncEngine — a note moved into the binding while connecting to a server that cannot be asked for it, %s broadcasts',
  (format) => {
    it.each(['batch first', 'batch last'] as const)(
      'is written from the catch-up (%s)',
      async (when) => {
        const h = buildHarness({ localFolder: 'Team' });
        const server = new FakeServer(h, format);
        const docs = new ServerDocs(server, h);
        await docs.add('f1', 'Other/x.md', 'hello\n');
        await docs.add('f2', 'Team/y.md', 'y\n');
        h.vault.files.set('Team/y.md', encode('y\n'));
        await h.engine.start();
        answerJoin(h, server, docs, format);
        await flushAsync(3);
        stream(h, docs);
        await docs.drive();

        const refuse = (): void => {
          for (const f of h.socket().fetches.splice(0)) f.answer({ ok: false, error: 'timeout' });
        };
        const listing = h.routes.get(LIST);
        if (!listing) throw new Error('no listing route');
        const gate = deferred<void>();
        h.routes.set(LIST, () => gate.promise.then(() => listing()));
        h.socket().disconnect();
        await flushAsync();
        h.socket().connect();
        await flushAsync();
        answerJoin(h, server, docs, format);
        await flushAsync(3);
        if (when === 'batch first') stream(h, docs);
        await flushAsync(10);
        server.teammateRename('f1', 'Team/x.md');
        await flushAsync(40);
        if (when === 'batch last') stream(h, docs);
        h.routes.set(LIST, listing);
        gate.resolve();
        for (let round = 0; round < 6; round++) {
          await flushAsync(40);
          refuse();
          await server.pump();
        }

        expect(h.engine.getStatus()).toBe('connected');
        expect(disk(h)).toEqual(['Team/x.md=hello\n', 'Team/y.md=y\n']);
        expect(h.socket().created()).toEqual([]);
        await h.engine.stop();
      },
    );
  },
);
