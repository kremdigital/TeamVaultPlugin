/**
 * A note created here and renamed before the server acknowledged its create:
 * a template plugin that renames the note it has just made (Templater's
 * `tp.file.rename`), or a title typed in on a slow connection.
 *
 * The rename found no record of the note yet and sent a second create under
 * the new name. The ack of the first then recorded the note under the old
 * name, where the disk had nothing: the whole team got the note twice, and
 * the next start wrote the old name back to disk. Now the rename waits for
 * the create, then goes out as the rename of the note the server has.
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

// Each case runs the server's side too, and a second start.
jest.setTimeout(30_000);

function disk(h: Harness): string[] {
  return [...h.vault.files.keys()].sort().map((p) => `${p}=${h.vault.text(p) ?? ''}`);
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

describe.each(['current', 'legacy'] as const)(
  'SyncEngine — a note renamed before its create is acknowledged, %s broadcasts',
  (format) => {
    it('sends one create and then the rename, and records the note under its new name', async () => {
      const { h, server, docs } = await connected(format);

      h.vault.files.set('Untitled.md', encode('# Meeting\n'));
      const created = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'create',
        path: 'Untitled.md',
        source: 'obsidian',
      });
      await flushAsync(5);
      expect(h.socket().created()).toEqual(['Untitled.md']);
      // Renamed while the create waits for its ack.
      await h.vault.rename('Untitled.md', 'Meeting.md');
      await flushAsync(5);
      await docs.drive();
      await created;
      await docs.drive();

      expect(h.socket().created()).toEqual(['Untitled.md']);
      expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Meeting.md']);
      expect(docs.live()).toEqual(['Meeting.md=# Meeting\n']);
      expect(disk(h)).toEqual(['Meeting.md=# Meeting\n']);
      expect(h.engine.getFileIdForPath('Meeting.md')).toBe('s1');
      expect(h.engine.getFileIdForPath('Untitled.md')).toBeNull();
      expect(h.log.listFileMeta('b1').map((m) => `${m.serverFileId}:${m.relativePath}`)).toEqual([
        's1:Meeting.md',
      ]);
      expect(h.log.dequeueOperations('b1')).toEqual([]);
      expect(h.eventErrors).toEqual([]);

      // The next start has nothing to bring back.
      await h.engine.stop();
      const next = buildHarness({ predecessor: h });
      server.attach(next);
      docs.attach(next);
      await connect(next, { yjsDocs: docs.snapshots() });
      await docs.drive();
      expect(disk(next)).toEqual(['Meeting.md=# Meeting\n']);
      expect(next.socket().created()).toEqual([]);
      expect(docs.live()).toEqual(['Meeting.md=# Meeting\n']);
      await next.engine.stop();
    });

    it('keeps an edit saved under the new name right after', async () => {
      const { h, server, docs } = await connected(format);

      h.vault.files.set('Untitled.md', encode('# Meeting\n'));
      const created = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'create',
        path: 'Untitled.md',
        source: 'obsidian',
      });
      await flushAsync(5);
      await h.vault.rename('Untitled.md', 'Meeting.md');
      h.vault.files.set('Meeting.md', encode('# Meeting\nagenda\n'));
      const saved = h.engine.handleVaultEvent({
        bindingId: 'b1',
        type: 'modify',
        path: 'Meeting.md',
        source: 'obsidian',
      });
      await flushAsync(5);
      await docs.drive();
      await created;
      await saved;
      await docs.drive();

      expect(h.socket().created()).toEqual(['Untitled.md']);
      expect(server.applied).toEqual(['create Untitled.md', 's1 Untitled.md -> Meeting.md']);
      expect(docs.live()).toEqual(['Meeting.md=# Meeting\nagenda\n']);
      expect(disk(h)).toEqual(['Meeting.md=# Meeting\nagenda\n']);
      expect(h.eventErrors).toEqual([]);
      await h.engine.stop();
    });
  },
);
