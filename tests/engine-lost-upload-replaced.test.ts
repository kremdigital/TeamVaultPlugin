/**
 * An attachment a teammate deletes and adds again under its name — the
 * server brings the old id back — around an upload of this device's whose
 * answer was lost (TASK-0035, spec §9.2): the reproductions VE, K1–K5, K9 and
 * K10 of the 0.3.8 review rounds, as regression tests. The other lost uploads
 * are in `engine-lost-upload-answers.test.ts`.
 *
 * Before operation ids, the device took its own older upload for the file the
 * teammate put under the name, or the other way round: "Content conflict"
 * came up at the teammate's next version, and **Keep local** wrote the old
 * file over it for everyone. When the teammate replaced the file while this
 * device was away, the new file never came down until their next version.
 *
 * Expected, unless a test says otherwise: no "Content conflict" (R2); the
 * teammate's file, and their next version, reach this disk and stay on the
 * server (R3); the own upload is applied once (R1).
 */
import { AttachmentBench, encode, type FakeStorage } from './engine-test-kit';

jest.setTimeout(60_000);

afterEach(() => AttachmentBench.closeAll());

// -- VE, K4, K5, K10: replaced while connected ----------------------------------------

describe('the teammate replaces the attachment after this device’s upload, applied here live', () => {
  it.each(['drop', 'pause', 'stop'] as const)(
    'takes their file, not its own older upload, and their next version asks nothing (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploaded('v2');
      await b.replacedByTeammate();
      expect(b.disk()).toEqual(['p.png=R']);
      await b.cutAndBack(how);

      b.expectEverywhere('R');
      await b.savedByTeammate('v5');
      b.expectEverywhere('v5');
      expect(b.server.applied).toEqual(['update f2', 'delete f2', 'create p.png', 'update f2']);
      await b.h.engine.stop();
    },
  );

  it.each(['drop', 'pause', 'stop', 'crash'] as const)(
    'sends an edit made after it once, and the teammate’s next version asks nothing (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploaded('v2');
      await b.replacedByTeammate();
      await b.uploaded('v3');
      await b.cutAndBack(how);

      b.expectEverywhere('v3');
      await b.savedByTeammate('v5');
      b.expectEverywhere('v5');
      expect(b.server.applied).toEqual([
        'update f2',
        'delete f2',
        'create p.png',
        'update f2',
        'update f2',
      ]);
      await b.h.engine.stop();
    },
  );

  it('asks about a real conflict: an edit here and the teammate’s version while paused', async () => {
    const b = await AttachmentBench.online('p.png', 'keep-local');
    await b.uploaded('v2');
    await b.replacedByTeammate();
    await b.cut('pause');
    b.h.vault.files.set(b.name, encode('v3'));
    await b.h.engine.handleVaultEvent(b.event('modify'));
    await b.savedByTeammate('v5');
    await b.back('pause', null);

    expect(b.conflicts()).toBe(1);
    expect(b.onServer()).toBe('v3');
    expect(b.disk()).toEqual(['p.png=v3']);
    expect(b.h.log.dequeueOperations('b1')).toEqual([]);
    await b.h.engine.stop();
  });

  it('takes their file, not its own older upload, when the process ended and the records of both were lost', async () => {
    const b = await AttachmentBench.online();
    await b.uploaded('v2');
    await b.replacedByTeammate();
    expect(b.disk()).toEqual(['p.png=R']);
    await b.cutAndBack('crash');

    // Its copy is the teammate's file: not kept aside, not uploaded as a new one.
    b.expectEverywhere('R');
    expect(b.serverFiles()).toEqual(['p.png=R']);
    await b.savedByTeammate('v5');
    b.expectEverywhere('v5');
    expect(b.server.applied).toEqual(['update f2', 'delete f2', 'create p.png', 'update f2']);
    await b.h.engine.stop();
  });
});

// -- K1, K2, K3, K9: replaced while this device is away ---------------------------------

describe('the teammate replaces the attachment while this device is away, after its own upload', () => {
  it.each(['drop', 'stop'] as const)(
    'takes their file after an upload answered and recorded (%s)',
    async (how) => {
      const b = await AttachmentBench.online('p.png', 'keep-server');
      await b.uploaded('v2');
      await b.h.log.flush();
      const disk = await b.cut(how);
      await b.replacedByTeammate();
      await b.back(how, disk);

      b.expectEverywhere('R');
      expect(b.downloads).toEqual(['R']);
      await b.savedByTeammate('v5');
      b.expectEverywhere('v5');
      await b.h.engine.stop();
    },
  );

  it.each(['pause', 'drop'] as const)(
    'takes their file after an upload whose answer was cut off (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploadOut('v2');
      const disk = await b.cut(how);
      expect(b.server.serveNext()).toBe(true);
      await b.replacedByTeammate();
      await b.back(how, disk);

      b.expectEverywhere('R');
      expect(b.server.applied).toEqual(['update f2', 'delete f2', 'create p.png']);
      await b.savedByTeammate('v5');
      b.expectEverywhere('v5');
      await b.h.engine.stop();
    },
  );

  it.each([
    ['answered', null, null, 'keep-local'],
    ['on its way', null, null, 'keep-local'],
    ['answered', 'v5', null, 'keep-both'],
    ['on its way', 'v5', null, 'keep-local'],
    ['answered', null, 'v6', 'keep-server'],
  ] as const)(
    'takes their file when Obsidian ended right after the upload (%s; %s while closed, %s live; %s)',
    async (when, closed, liveAfter, answer) => {
      const b = await AttachmentBench.online('p.png', answer);
      let disk: FakeStorage | null;
      if (when === 'answered') {
        await b.uploaded('v2');
        disk = await b.cut('crash');
      } else {
        await b.uploadOut('v2');
        disk = await b.cut('crash');
        expect(b.server.serveNext()).toBe(true);
      }
      await b.replacedByTeammate();
      if (closed !== null) await b.savedByTeammate(closed);
      await b.back('crash', disk);

      b.expectEverywhere(closed ?? 'R');
      if (liveAfter !== null) {
        await b.savedByTeammate(liveAfter);
        b.expectEverywhere(liveAfter);
      }
      expect(b.server.applied.slice(0, 3)).toEqual(['update f2', 'delete f2', 'create p.png']);
      await b.h.engine.stop();
    },
  );
});

describe('the teammate deletes the attachment, and this device adds another under its name', () => {
  it.each(['drop', 'stop'] as const)(
    'the teammate’s next version of it asks nothing (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploaded('v2');
      b.server.teammateDelete('f2');
      await b.settleLive();
      expect(b.disk()).toEqual([]);
      await b.userDoes('create', 'R2');
      expect(b.serverFiles()).toEqual(['p.png=R2']);
      await b.cutAndBack(how);

      b.expectEverywhere('R2');
      await b.savedByTeammate('v5');
      b.expectEverywhere('v5');
      expect(b.server.applied).toEqual(['update f2', 'delete f2', 'create p.png', 'update f2']);
      await b.h.engine.stop();
    },
  );
});
