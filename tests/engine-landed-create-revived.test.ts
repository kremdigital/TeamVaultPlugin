/**
 * A note created here under the name of a deleted one — Obsidian reuses
 * "Untitled" for every new note — whose create reached the server while its
 * ack and broadcast were lost with the connection. The server brought the
 * tombstone back under its old id, and one that continues the history marks
 * the CREATE `revived`. The note was renamed right after (Templater), and
 * maybe typed into.
 *
 * Before: the next catch-up returned that CREATE (the server stores this
 * device's operation one count past the clock it sent), and a `revived` mark
 * without its DELETE was taken for a note deleted and made again by a
 * teammate while this device was away — also when the DELETE was left out
 * because the clock had seen it, applied here on an earlier connect. The
 * rename queued for the note was dropped as overtaken, and the old name came
 * back: without an edit, the rename was lost; with one, the team got the note
 * twice, `Untitled.md` and `Meeting.md`. Also when the catch-up brought the
 * DELETE along, the note being this device's own.
 */
import {
  FakeServer,
  ServerDocs,
  buildHarness,
  connect,
  encode,
  flushAsync,
  joinClockOf,
  type CatchupForm,
  type Harness,
} from './engine-test-kit';

jest.setTimeout(60_000);

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
}

function event(h: Harness, type: 'create' | 'modify' | 'delete', path: string): Promise<void> {
  return h.engine.handleVaultEvent({ bindingId: 'b1', type, path, source: 'obsidian' });
}

/** Connect again; the join is answered for the clock it carried, as the server does. */
async function reconnect(
  h: Harness,
  server: FakeServer,
  docs: ServerDocs,
  form: CatchupForm = 'whole journal',
  rows?: number,
): Promise<Record<string, unknown>> {
  h.socket().connect();
  await flushAsync();
  const answer = server.joinAnswer(form, {
    clock: joinClockOf(h),
    yjsDocs: docs.snapshots(),
    ...(rows !== undefined ? { rows } : {}),
  });
  h.socket().pending('project:join').ack(answer);
  await docs.drive();
  await h.settle();
  await docs.drive();
  return answer;
}

async function drop(h: Harness): Promise<void> {
  h.socket().disconnect();
  await flushAsync();
}

type Delete = 'own' | 'teammate';
/**
 * `earlier connect`: the DELETE reached the clock on a connect before the
 * create — the catch-up leaves it out. `live`: only applied live, which does
 * not move the clock — the catch-up brings it along with the CREATE.
 * `cut short`: seen earlier too, and the catch-up is cut short to its newest
 * operation, the CREATE.
 */
type Seen = 'earlier connect' | 'live' | 'cut short';

const cases: Array<[Delete, Seen]> = [
  ['own', 'earlier connect'],
  ['teammate', 'earlier connect'],
  ['teammate', 'live'],
  ['teammate', 'cut short'],
];

describe.each(cases)(
  'SyncEngine — a note created under the name of one deleted (%s delete, seen: %s), its ack lost',
  (who, seen) => {
    it.each([false, true])(
      'keeps the rename made before the drop, one note for the team (typed into after: %s)',
      async (typed) => {
        const h = buildHarness();
        const server = new FakeServer(h, 'current');
        const docs = new ServerDocs(server, h);
        h.vault.files.set('Untitled.md', encode('old\n'));
        await docs.add('f1', 'Untitled.md', 'old\n');
        await connect(h, { yjsDocs: docs.snapshots() });
        await docs.drive();

        if (who === 'own') {
          h.vault.files.delete('Untitled.md');
          const deleted = event(h, 'delete', 'Untitled.md');
          await docs.drive();
          await deleted;
        } else {
          server.teammateDelete('f1');
          await docs.drive();
        }
        expect(disk(h)).toEqual([]);
        if (seen !== 'live') {
          await drop(h);
          await reconnect(h, server, docs);
        }
        // A teammate's note, applied live: left out of a catch-up cut short to
        // its newest operation.
        if (seen === 'cut short') {
          await server.teammateCreate('Other.md', 'other\n');
          await docs.drive();
        }

        // Ctrl+N, and Templater renames the note right away.
        h.vault.files.set('Untitled.md', encode('tpl\n'));
        const created = event(h, 'create', 'Untitled.md');
        await flushAsync(5);
        await h.vault.rename('Untitled.md', 'Meeting.md');
        await flushAsync(5);
        const out = h.socket().emits.find((e) => e.event === 'file:create');
        if (!out) throw new Error('no create out');
        // The server applies it; its broadcast and ack are lost with the connection.
        out.ack = (): void => undefined;
        await drop(h);
        expect(server.serveNext()).toBe(true);
        await flushAsync(20);
        await created;
        await h.settle();
        expect(server.journal[server.journal.length - 1]?.payload).toMatchObject({
          fileId: 'f1',
          revived: true,
        });
        const text = typed ? 'tpl\nmine\n' : 'tpl\n';
        if (typed) {
          h.vault.files.set('Meeting.md', encode(text));
          await event(h, 'modify', 'Meeting.md');
          await h.settle();
        }
        const answer = await reconnect(
          h,
          server,
          docs,
          seen === 'cut short' ? 'cut short' : 'whole journal',
          seen === 'cut short' ? 1 : undefined,
        );
        const ops = (answer['operations'] as Array<{ opType: string }>).map((op) => op.opType);
        expect(ops).toEqual(seen === 'live' ? ['DELETE', 'CREATE'] : ['CREATE']);
        if (seen === 'cut short') expect(answer['operationsTruncated']).toBe(true);

        const others = seen === 'cut short' ? ['Other.md=other\n'] : [];
        expect(server.applied).toContain('f1 Untitled.md -> Meeting.md');
        expect(docs.live()).toEqual([`Meeting.md=${text}`, ...others]);
        expect(disk(h)).toEqual([`Meeting.md=${text}`, ...others]);
        expect(h.log.dequeueOperations('b1')).toEqual([]);

        // And it stays so.
        await drop(h);
        await reconnect(h, server, docs);
        expect(docs.live()).toEqual([`Meeting.md=${text}`, ...others]);
        expect(disk(h)).toEqual([`Meeting.md=${text}`, ...others]);
        await h.engine.stop();
      },
    );
  },
);
