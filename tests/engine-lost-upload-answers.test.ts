/**
 * Attachment and canvas uploads whose answers were lost (TASK-0035, spec
 * §9.2): the reproductions of the 0.3.8 review rounds — V0, VD, VG, K6–K8 —
 * as regression tests. The teammate replacing the file (VE, K1–K5, K9, K10)
 * is in `engine-lost-upload-replaced.test.ts`.
 *
 * This device uploads a version of an attachment; the answer is cut off — the
 * connection drops, Pause sync, Obsidian quitting or the process dying right
 * after the server applied it — or it came, and the record of it never
 * reached `state.json`. A teammate then saves another version, or reverts to
 * the one before. Before operation ids, the device took its own version for a
 * teammate's, or a teammate's for its own: "Content conflict" came up against
 * its own upload, and **Keep local** or **Keep both** wrote an older version
 * over the teammate's for everyone; a revert byte for byte never came down.
 *
 * Expected, unless a test says otherwise: no "Content conflict" (R2); the
 * teammate's version reaches this disk and stays on the server (R3); the own
 * upload is applied once (R1); nothing saved here is lost (R5).
 */
import { AttachmentBench, encode } from './engine-test-kit';

jest.setTimeout(60_000);

afterEach(() => AttachmentBench.closeAll());

// -- V0, VD: the record of an answered upload lost ------------------------------------

describe('an upload answered while Obsidian ends; a teammate saves another version before the next start', () => {
  it.each(['keep-local', 'keep-both'] as const)(
    'brings the teammate’s version down, asking nothing (answered, the record lost; %s)',
    async (answer) => {
      const b = await AttachmentBench.online('board.canvas', answer);
      await b.uploaded('v2');
      const disk = await b.cut('crash');
      await b.savedByTeammate('v3');
      await b.back('crash', disk);

      b.expectEverywhere('v3');
      expect(b.server.applied).toEqual(['update f2', 'update f2']);
      expect(b.downloads).toContain('v3');
      expect(b.downloads.filter((v) => v !== 'v3')).toEqual([]);
      await b.h.engine.stop();
    },
  );

  it('brings the teammate’s version down, asking nothing (still on its way at the end)', async () => {
    const b = await AttachmentBench.online('board.canvas');
    const { out } = await b.uploadOut('v2');
    const disk = await b.cut('crash');
    expect(b.server.serveNext()).toBe(true);
    expect(b.uploads()).toEqual([out]);
    await b.savedByTeammate('v3');
    await b.back('crash', disk);

    b.expectEverywhere('v3');
    expect(b.server.applied).toEqual(['update f2', 'update f2']);
    await b.h.engine.stop();
  });

  it('brings the teammate’s version down, asking nothing (sent by the drain)', async () => {
    const b = await AttachmentBench.online('board.canvas');
    await b.cut('pause');
    b.h.vault.files.set(b.name, encode('v2'));
    await b.h.engine.handleVaultEvent(b.event('modify'));
    await b.back('pause', null);
    expect(b.onServer()).toBe('v2');
    const disk = await b.cut('crash');
    await b.savedByTeammate('v3');
    await b.back('crash', disk);

    b.expectEverywhere('v3');
    expect(b.server.applied).toEqual(['update f2', 'update f2']);
    await b.h.engine.stop();
  });

  it('brings the teammate’s version down, asking nothing (answered, Obsidian’s quit)', async () => {
    const b = await AttachmentBench.online('board.canvas');
    await b.uploaded('v2');
    const disk = await b.cut('quit');
    await b.savedByTeammate('v3');
    await b.back('quit', disk);

    b.expectEverywhere('v3');
    expect(b.server.applied).toEqual(['update f2', 'update f2']);
    await b.h.engine.stop();
  });

  it('keeps its own version without the teammate: not uploaded again, nothing downloaded', async () => {
    const b = await AttachmentBench.online('board.canvas');
    await b.uploaded('v2');
    await b.cutAndBack('crash');

    b.expectEverywhere('v2');
    expect(b.server.applied).toEqual(['update f2']);
    expect(b.downloads).toEqual([]);
    await b.h.engine.stop();
  });

  it.each([
    ['board.canvas', null],
    ['board.canvas', 'v4'],
    ['p.png', 'v4'],
  ] as const)(
    '%s: brings down the teammate’s revert to the version before the upload, and their next one (%s)',
    async (name, next) => {
      const b = await AttachmentBench.online(name);
      await b.uploaded('v2');
      const disk = await b.cut('crash');
      await b.savedByTeammate('v1');
      await b.back('crash', disk);

      b.expectEverywhere('v1');
      expect(b.server.applied).toEqual(['update f2', 'update f2']);
      if (next !== null) {
        await b.savedByTeammate(next);
        b.expectEverywhere(next);
        expect(b.server.applied).toEqual(['update f2', 'update f2', 'update f2']);
      }
      await b.h.engine.stop();
    },
  );
});

// -- VG: the answer cut off, the teammate reverts -----------------------------------------

describe('an upload whose answer the pause or a dropped connection cut off; the teammate reverts it', () => {
  it.each(['pause', 'drop'] as const)(
    'brings the revert down and does not upload its own version again (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploadOut('v2');
      const disk = await b.cut(how);
      expect(b.server.serveNext()).toBe(true);
      expect(b.onServer()).toBe('v2');
      await b.savedByTeammate('v1');
      await b.back(how, disk);

      b.expectEverywhere('v1');
      expect(b.server.applied).toEqual(['update f2', 'update f2']);
      expect(b.downloads).toContain('v1');
      await b.h.engine.stop();
    },
  );
});

// -- K8: ordinary online sequences --------------------------------------------------------

describe('own, teammate’s and own versions in turn, then a reconnect and a teammate’s version', () => {
  it.each(['drop', 'stop'] as const)('asks nothing and takes each (%s)', async (how) => {
    const b = await AttachmentBench.online();
    await b.uploaded('v2');
    await b.savedByTeammate('v3');
    expect(b.disk()).toEqual(['p.png=v3']);
    await b.uploaded('v4');
    await b.cutAndBack(how);

    b.expectEverywhere('v4');
    await b.savedByTeammate('v5');
    b.expectEverywhere('v5');
    expect(b.server.applied).toEqual(['update f2', 'update f2', 'update f2', 'update f2']);
    await b.h.engine.stop();
  });
});

// -- K6, K7: this device's own delete and re-add; the teammate's same bytes --------------

describe('this device deletes the attachment after its upload and adds another under its name', () => {
  it.each(['crash', 'stop'] as const)(
    'keeps the new one, sending nothing again (%s)',
    async (how) => {
      const b = await AttachmentBench.online();
      await b.uploaded('v2');
      await b.userDoes('delete');
      await b.userDoes('create', 'R2');
      await b.cutAndBack(how);

      b.expectEverywhere('R2');
      expect(b.serverFiles()).toEqual(['p.png=R2']);
      expect(b.server.applied).toEqual(['update f2', 'delete f2', 'create p.png']);
      await b.h.engine.stop();
    },
  );
});

describe('an upload answered while Obsidian ends; a teammate adds the same bytes under the name', () => {
  it('keeps one file: the teammate’s create is the file this device uploaded', async () => {
    const b = await AttachmentBench.online();
    await b.uploaded('v2');
    const disk = await b.cut('crash');
    expect(await b.server.teammateUpload(b.name, encode('v2'))).toBe('f2');
    await b.back('crash', disk);

    b.expectEverywhere('v2');
    expect(b.serverFiles()).toEqual(['p.png=v2']);
    expect(b.server.applied).toEqual(['update f2']);
    expect(b.downloads).toEqual([]);
    await b.h.engine.stop();
  });
});
