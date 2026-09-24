/**
 * The write phase of a note snapshot — a teammate's Yjs edit written to disk.
 *
 * The file meta, the write and the fold marker are one local phase: a `stop()`
 * landing on the write used to let the file be written while the marker kept
 * naming the old disk, and the next engine folded that disk against a base it
 * does not descend from. The re-read before the write treats a note deleted
 * between its two calls as gone, and a stopped engine logs no retry.
 */
import type * as Y from 'yjs';
import { Logger, type LogEntry } from '@/utils/logger';
import { sha256Hex } from '@/sync/hash';
import {
  buildHarness,
  bytes,
  connect,
  encode,
  expectQuietSince,
  flushAsync,
  json,
  markOf,
  remoteEdit,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
} from './engine-test-kit';

/** A note the server and the disk agree on, its doc loaded by the catch-up. */
async function connectWithNote(h: Harness, text: string): Promise<Y.Doc> {
  const serverDoc = serverDocWith(text);
  h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', await sha256Hex(text), text.length)];
  // Not on disk yet: the catch-up writes it, so the doc is loaded and trusted.
  await connect(h, { yjsDocs: [snapshotOf(serverDoc, 'f1')] });
  expect(h.vault.text('note.md')).toBe(text);
  return serverDoc;
}

describe('SyncEngine — a stop landing on a note snapshot’s write', () => {
  // (a) the version history can't give the old base back: the successor's
  // fold used to let the disk win and delete R2 everywhere; (b) it can: the
  // merge used to double R1.
  it.each([
    ['without the old version in the history', false],
    ['with the old version in the history', true],
  ])(
    'finishes the phase, and the next engine keeps a remote edit that arrived during the write (%s)',
    async (_label, historyHasBase) => {
      const h = buildHarness();
      const serverDoc = await connectWithNote(h, 'v1\n');
      const v1 = await sha256Hex('v1\n');
      expect(h.log.getFileMeta('b1', 'note.md')?.foldedHash).toBe(v1);

      // R1 lands, its snapshot parks in the write.
      const write = h.vault.gate('writeText');
      remoteEdit(h, serverDoc, 'f1', 'r1\n');
      await write.reached;
      // R2 reaches the doc while the file is being written; then the stop.
      remoteEdit(h, serverDoc, 'f1', 'r2\n');
      let settled = false;
      const stopping = h.engine.stop().then(() => {
        settled = true;
      });
      await flushAsync();
      // The write is part of the local phase `stop()` waits for.
      expect(settled).toBe(false);
      write.release();
      await stopping;

      const written = await sha256Hex('r1\nv1\n');
      expect(h.vault.text('note.md')).toBe('r1\nv1\n');
      expect(h.log.getFileMeta('b1', 'note.md')?.contentHash).toBe(written);
      // The marker names the text the disk now holds — not the old disk.
      expect(h.log.getFileMeta('b1', 'note.md')?.foldedHash).toBe(written);
      const mark = markOf(h);
      await flushAsync();
      expectQuietSince(h, mark);

      // The next engine, on the same vault, log and docs (pause → resume).
      const next = buildHarness({ predecessor: h });
      if (historyHasBase) {
        next.routes.set('GET /api/projects/p1/files/f1/versions', () =>
          json({
            versions: [
              {
                id: 'ver1',
                versionNumber: 1,
                contentHash: v1,
                authorId: 'u1',
                message: null,
                createdAt: '2026-01-01',
                author: null,
              },
            ],
          }),
        );
        next.routes.set('GET /api/projects/p1/files/f1/versions/ver1', () => bytes(encode('v1\n')));
      }
      const serverText = serverDoc.getText('content').toJSON();
      next.serverFiles = [
        serverFile('f1', 'note.md', 'TEXT', await sha256Hex(serverText), serverText.length),
      ];
      await connect(next, { yjsDocs: [snapshotOf(serverDoc, 'f1')] });
      await flushAsync(20);

      expect(next.doc.getText('b1', 'note.md')).toBe('r2\nr1\nv1\n');
      expect(next.vault.text('note.md')).toBe('r2\nr1\nv1\n');
      // Nothing was folded out of the doc, so nothing goes back to the server.
      expect(next.socket().emits.filter((e) => e.event === 'yjs:update')).toEqual([]);
      await next.engine.stop();
    },
  );
});

describe('SyncEngine — the re-read right before a snapshot’s write', () => {
  it('treats a note deleted between its exists() and its read as gone, not as a failure', async () => {
    const h = buildHarness();
    const serverDoc = await connectWithNote(h, 'v1\n');
    await h.engine.stop();
    // A teammate's edit that the next catch-up brings.
    serverDoc.getText('content').insert(0, 'r1\n');

    const next = buildHarness({ predecessor: h });
    const serverText = serverDoc.getText('content').toJSON();
    next.serverFiles = [
      serverFile('f1', 'note.md', 'TEXT', await sha256Hex(serverText), serverText.length),
    ];
    // Once the doc holds R1, the snapshot runs: its first exists() reads the
    // note, the second one — the re-read — still finds it, and the note is
    // deleted before the read that follows.
    const exists = next.vault.exists.bind(next.vault);
    let seen = 0;
    next.vault.exists = async (path: string): Promise<boolean> => {
      const there = await exists(path);
      if (
        path === 'note.md' &&
        next.doc.has('b1', 'note.md') &&
        next.doc.getText('b1', 'note.md').startsWith('r1')
      ) {
        seen += 1;
        if (seen === 2) next.vault.files.delete('note.md');
      }
      return there;
    };
    await connect(next, { yjsDocs: [snapshotOf(serverDoc, 'f1')] });
    await flushAsync(20);

    expect(seen).toBeGreaterThanOrEqual(2);
    // The catch-up went through, and the delete stands.
    expect(next.statuses).not.toContain('error');
    expect(next.engine.getStatus()).toBe('connected');
    expect(next.vault.files.has('note.md')).toBe(false);
    await next.engine.stop();
  });

  it('logs no retry once stopped while the disk kept changing under the snapshot', async () => {
    const entries: LogEntry[] = [];
    const logger = new Logger('debug', {
      write: (entry) => {
        entries.push(entry);
      },
    });
    const h = buildHarness({ logger });
    const serverDoc = await connectWithNote(h, 'v1\n');

    // Every read of the note is followed by another save, so each attempt
    // finds the disk changed. Held: the fourth read — the last attempt's
    // re-read.
    const read = h.vault.readText.bind(h.vault);
    let reads = 0;
    let disk = 'v1\n';
    h.vault.readText = async (path: string): Promise<string> => {
      const text = await read(path);
      reads += 1;
      disk += `save ${reads}\n`;
      h.vault.files.set('note.md', encode(disk));
      return text;
    };
    const last = h.vault.gate('readText', 3);
    remoteEdit(h, serverDoc, 'f1', 'r1\n');
    await last.reached;

    await h.engine.stop();
    const mark = markOf(h);
    const logged = entries.length;
    last.release();
    await flushAsync();

    expectQuietSince(h, mark);
    // A stopped engine retries nothing, so it doesn't say it will.
    expect(entries.slice(logged).map((e) => e.message)).toEqual([]);
  });
});
