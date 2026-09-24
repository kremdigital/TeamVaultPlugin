/**
 * Renames that meet another file, and the questions a server delete asks.
 *
 * - A rename made while this device was away can meet another file: two names
 *   swapped, a name another file was created under since, the name of a file
 *   deleted meanwhile, a file locked by another program. Each used to cost a
 *   file: a note got the other one's text, a deleted file came back as a
 *   conflict copy, the whole connect failed.
 * - A file deleted on the server whose name another file took while away was
 *   taken for that file: its text folded into the new note, its bytes counted
 *   as the new binary's.
 * - A rename that changes only the case deleted the only copy on a disk that
 *   ignores case.
 * - A binary created in another folder and moved into the binding while away
 *   was never downloaded.
 * - A teammate's delete, or rename to a name this client never writes, asked
 *   about "local changes" the server already had — any note saved since its
 *   last snapshot.
 */
import * as Y from 'yjs';
import { sha256Hex } from '@/sync/hash';
import type { FileType } from '@/sync/file-type';
import type { VaultAdapter } from '@/sync/vault-adapter';
import {
  buildHarness,
  bytes,
  connect,
  encode,
  eventLog,
  flushAsync,
  json,
  op,
  serverDocWith,
  serverFile,
  snapshotOf,
  type Harness,
  type MemoryVault,
} from './engine-test-kit';

/**
 * A file this device synced earlier: on disk, and in `state.json` at `path`
 * with the hash of `synced` — the disk may hold `onDisk` since. Returns the
 * synced hash.
 */
async function remember(
  h: Harness,
  path: string,
  fileId: string,
  synced: ArrayBuffer,
  onDisk: ArrayBuffer = synced,
  fileType: FileType = 'TEXT',
): Promise<string> {
  const hash = await sha256Hex(synced);
  h.vault.files.set(path, onDisk);
  h.log.setFileMeta({
    bindingId: 'b1',
    relativePath: path,
    serverFileId: fileId,
    contentHash: hash,
    size: synced.byteLength,
    fileType,
    lastSyncedAt: 1,
    ...(fileType === 'TEXT' ? { foldedHash: hash } : {}),
  });
  return hash;
}

/** Disconnect and connect again, answering the join with no catch-up. */
async function reconnect(h: Harness): Promise<void> {
  h.socket().disconnect();
  h.socket().connect();
  await flushAsync();
  h.socket().pending('project:join').ack({ ok: true, operations: [], yjsDocs: [] });
  await flushAsync();
}

const rename = (from: string, to: string, fileId: string, clock: number) =>
  op('RENAME', from, to, { fileId }, clock);

/** Apply every `yjs:update` the engine sent for `fileId` to the server's doc. */
function applySent(h: Harness, serverDoc: Y.Doc, fileId: string): void {
  for (const e of h.socket().emits) {
    if (e.event !== 'yjs:update') continue;
    const p = e.payload as { fileId: string; update: Uint8Array | number[] };
    if (p.fileId === fileId) Y.applyUpdate(serverDoc, Uint8Array.from(p.update));
  }
}

/** The server's version history of `fileId`: one version per hash. */
function versionsRoute(h: Harness, fileId: string, hashes: string[]): void {
  h.routes.set(`GET /api/projects/p1/files/${fileId}/versions`, () =>
    json({
      versions: hashes.map((contentHash, i) => ({
        id: `v${i + 1}`,
        versionNumber: i + 1,
        contentHash,
        authorId: 'u1',
        message: null,
        createdAt: '2026-01-01',
        author: null,
      })),
    }),
  );
}

/** Make `vault` see names the way Windows and macOS do: without case. */
function ignoreCase(vault: MemoryVault): void {
  const key = (path: string): string | undefined =>
    [...vault.files.keys()].find((k) => k.toLowerCase() === path.toLowerCase());
  const bufferAt = (path: string): ArrayBuffer => {
    const k = key(path);
    const buf = k === undefined ? undefined : vault.files.get(k);
    if (!buf) throw new Error(`ENOENT ${path}`);
    return buf;
  };
  vault.exists = async (path) => key(path) !== undefined;
  vault.readBinary = async (path) => bufferAt(path);
  vault.delete = async (path) => {
    const k = key(path);
    if (k !== undefined) vault.files.delete(k);
  };
  vault.rename = async (from, to) => {
    const buf = bufferAt(from);
    const k = key(from);
    if (k !== undefined) vault.files.delete(k);
    vault.files.set(to, buf);
  };
}

describe('SyncEngine — a rename made while away that meets another file', () => {
  it('swaps two notes whose names were swapped; both stay as they are on the server', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'));
    await remember(h, 'b.md', 'f2', encode('B\n'));
    const d1 = serverDocWith('A\n');
    const d2 = serverDocWith('B\n');
    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f2', 'a.md', 'TEXT', await sha256Hex('B\n'), 2),
    ];

    // Away: `a.md` → `tmp.md`, `b.md` → `a.md`, `tmp.md` → `b.md`.
    await connect(h, {
      operations: [
        rename('a.md', 'tmp.md', 'f1', 1),
        rename('b.md', 'a.md', 'f2', 2),
        rename('tmp.md', 'b.md', 'f1', 3),
      ],
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2')],
    });
    await flushAsync(20);
    applySent(h, d1, 'f1');
    applySent(h, d2, 'f2');

    expect(h.engine.getStatus()).toBe('connected');
    expect([...h.vault.files.keys()].sort()).toEqual(['a.md', 'b.md']);
    expect(h.vault.text('a.md')).toBe('B\n');
    expect(h.vault.text('b.md')).toBe('A\n');
    expect(h.engine.getFileIdForPath('a.md')).toBe('f2');
    expect(h.engine.getFileIdForPath('b.md')).toBe('f1');
    // Neither note got the other one's text, and no conflict copy went up.
    expect(d1.getText('content').toJSON()).toBe('A\n');
    expect(d2.getText('content').toJSON()).toBe('B\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('swaps two attachments the same way, without downloading them', async () => {
    const h = buildHarness();
    const A = new Uint8Array([1, 1, 1]).buffer;
    const B = new Uint8Array([2, 2, 2, 2]).buffer;
    const ha = await remember(h, 'a.png', 'f1', A, A, 'BINARY');
    const hb = await remember(h, 'b.png', 'f2', B, B, 'BINARY');
    h.serverFiles = [
      serverFile('f1', 'b.png', 'BINARY', ha, 3),
      serverFile('f2', 'a.png', 'BINARY', hb, 4),
    ];

    await connect(h, {
      operations: [
        rename('a.png', 'tmp.png', 'f1', 1),
        rename('b.png', 'a.png', 'f2', 2),
        rename('tmp.png', 'b.png', 'f1', 3),
      ],
    });

    expect([...h.vault.files.keys()].sort()).toEqual(['a.png', 'b.png']);
    expect(h.vault.files.get('a.png')).toBe(B);
    expect(h.vault.files.get('b.png')).toBe(A);
    expect(h.log.getFileMeta('b1', 'a.png')).toMatchObject({ serverFileId: 'f2', contentHash: hb });
    expect(h.log.getFileMeta('b1', 'b.png')).toMatchObject({ serverFileId: 'f1', contentHash: ha });
    expect(h.requests.filter((r) => /\/files\/f\d$/.test(r.path))).toEqual([]);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('moves an edited note out of its old name before the note created there since takes it', async () => {
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'), encode('A\nlocal\n'));
    const d1 = serverDocWith('A\n');
    const d3 = serverDocWith('new\n');
    h.serverFiles = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f3', 'a.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];

    await connect(h, {
      operations: [
        rename('a.md', 'b.md', 'f1', 1),
        op('CREATE', 'a.md', null, { fileId: 'f3' }, 2),
      ],
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d3, 'f3')],
    });
    await flushAsync(20);
    applySent(h, d1, 'f1');
    applySent(h, d3, 'f3');

    // The offline edit went to the note it was made in; the teammate's new
    // note under the old name is untouched.
    expect(d3.getText('content').toJSON()).toBe('new\n');
    expect(d1.getText('content').toJSON()).toBe('A\nlocal\n');
    expect(h.vault.text('a.md')).toBe('new\n');
    expect(h.vault.text('b.md')).toBe('A\nlocal\n');
    // The new note starts from its own hash, not the moved note's.
    expect(h.log.getFileMeta('b1', 'a.md')).toMatchObject({
      serverFileId: 'f3',
      contentHash: await sha256Hex('new\n'),
    });
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('moves an attachment out of its old name; the one created there since is downloaded', async () => {
    const h = buildHarness();
    const A = new Uint8Array([1, 1, 1]).buffer;
    const N = new Uint8Array([7, 7, 7, 7, 7]).buffer;
    const ha = await remember(h, 'a.png', 'f1', A, A, 'BINARY');
    h.serverFiles = [
      serverFile('f1', 'b.png', 'BINARY', ha, 3),
      serverFile('f3', 'a.png', 'BINARY', await sha256Hex(N), 5),
    ];
    h.routes.set('GET /api/projects/p1/files/f3', () => bytes(N));

    await connect(h, {
      operations: [
        rename('a.png', 'b.png', 'f1', 1),
        op('CREATE', 'a.png', null, { fileId: 'f3', fileType: 'BINARY' }, 2),
      ],
    });

    expect(h.vault.files.get('b.png')).toBe(A);
    expect(h.vault.files.get('a.png')).toBe(N);
    expect(h.log.getFileMeta('b1', 'a.png')?.contentHash).toBe(await sha256Hex(N));
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — the copy of a file deleted while away, whose name another file took', () => {
  // Away: `report` deleted, then `draft` renamed to `report`.
  it.each([['TEXT'], ['BINARY']])(
    'is removed when another %s file is renamed into its name',
    async (kind) => {
      const h = buildHarness();
      const binary = kind === 'BINARY';
      const draft = binary ? 'draft.png' : 'draft.md';
      const report = binary ? 'report.png' : 'report.md';
      const A = binary ? new Uint8Array([1, 1, 1]).buffer : encode('draft\n');
      const B = binary ? new Uint8Array([2, 2, 2, 2]).buffer : encode('old report\n');
      const ha = await remember(h, draft, 'f1', A, A, kind as FileType);
      await remember(h, report, 'f2', B, B, kind as FileType);
      h.serverFiles = [serverFile('f1', report, kind as 'TEXT' | 'BINARY', ha, A.byteLength)];

      await connect(h, {
        operations: [
          op('DELETE', report, null, { fileId: 'f2' }, 1),
          rename(draft, report, 'f1', 2),
        ],
        yjsDocs: binary ? [] : [snapshotOf(serverDocWith('draft\n'), 'f1')],
      });
      await flushAsync(20);

      expect([...h.vault.files.keys()]).toEqual([report]);
      expect(h.vault.files.get(report)).toBe(A);
      expect(h.engine.getFileIdForPath(report)).toBe('f1');
      // Not parked aside as a conflict and uploaded: that brought the deleted
      // file back for everyone.
      expect(h.socket().created()).toEqual([]);
      expect(h.calls).not.toContain('modal.resolveDeleteConflict');
      await h.engine.stop();
    },
  );

  it('is kept, and uploaded under a new name, when it holds edits the server never had', async () => {
    const h = buildHarness();
    const ha = await remember(h, 'draft.md', 'f1', encode('draft\n'));
    await remember(h, 'report.md', 'f2', encode('old report\n'), encode('old report\nmine\n'));
    h.serverFiles = [serverFile('f1', 'report.md', 'TEXT', ha, 6)];
    versionsRoute(h, 'f2', [await sha256Hex('old report\n')]);

    await connect(h, {
      operations: [
        op('DELETE', 'report.md', null, { fileId: 'f2' }, 1),
        rename('draft.md', 'report.md', 'f1', 2),
      ],
      yjsDocs: [snapshotOf(serverDocWith('draft\n'), 'f1')],
    });
    await flushAsync(20);

    const aside = [...h.vault.files.keys()].filter((p) => p !== 'report.md');
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^report\.conflict-\d+\.md$/);
    expect(h.vault.text(aside[0] ?? '')).toBe('old report\nmine\n');
    expect(h.vault.text('report.md')).toBe('draft\n');
    expect(h.socket().created()).toEqual(aside);
    await h.engine.stop();
  });

  it('is removed when the server’s history has its last save, though no snapshot recorded it', async () => {
    const h = buildHarness();
    const ha = await remember(h, 'draft.md', 'f1', encode('draft\n'));
    // Saved and sent before the teammate deleted it: the disk is ahead of the
    // note's `contentHash`, and the server's history has the text.
    await remember(h, 'report.md', 'f2', encode('old report\n'), encode('old report\nmine\n'));
    h.serverFiles = [serverFile('f1', 'report.md', 'TEXT', ha, 6)];
    versionsRoute(h, 'f2', [
      await sha256Hex('old report\n'),
      await sha256Hex('old report\nmine\n'),
    ]);

    await connect(h, {
      operations: [
        op('DELETE', 'report.md', null, { fileId: 'f2' }, 1),
        rename('draft.md', 'report.md', 'f1', 2),
      ],
      yjsDocs: [snapshotOf(serverDocWith('draft\n'), 'f1')],
    });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['report.md']);
    expect(h.vault.text('report.md')).toBe('draft\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('is removed, not parked, when it matches what the file renamed into its name brings', async () => {
    const h = buildHarness();
    // Our copy of the renamed file has an edit; the deleted file's copy holds
    // exactly the renamed file's server content.
    const hs = await remember(h, 'draft.md', 'f1', encode('same\n'), encode('same\nmine\n'));
    await remember(h, 'report.md', 'f2', encode('same\n'));
    h.serverFiles = [serverFile('f1', 'report.md', 'TEXT', hs, 5)];

    await connect(h, {
      operations: [
        op('DELETE', 'report.md', null, { fileId: 'f2' }, 1),
        rename('draft.md', 'report.md', 'f1', 2),
      ],
      yjsDocs: [snapshotOf(serverDocWith('same\n'), 'f1')],
    });
    await flushAsync(20);

    expect([...h.vault.files.keys()]).toEqual(['report.md']);
    expect(h.vault.text('report.md')).toBe('same\nmine\n');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it.each([['TEXT'], ['BINARY']])(
    'gives way to the %s file created under its name',
    async (kind) => {
      const h = buildHarness();
      const binary = kind === 'BINARY';
      const path = binary ? 'report.png' : 'report.md';
      const old = binary ? new Uint8Array([2, 2]).buffer : encode('old\n');
      const created = binary ? new Uint8Array([3, 3, 3]).buffer : encode('new\n');
      await remember(h, path, 'f2', old, old, kind as FileType);
      const d3 = serverDocWith('new\n');
      h.serverFiles = [
        serverFile(
          'f3',
          path,
          kind as 'TEXT' | 'BINARY',
          await sha256Hex(created),
          created.byteLength,
        ),
      ];
      h.routes.set('GET /api/projects/p1/files/f3', () => bytes(created));

      await connect(h, {
        operations: [
          op('DELETE', path, null, { fileId: 'f2' }, 1),
          op('CREATE', path, null, { fileId: 'f3', fileType: kind }, 2),
        ],
        yjsDocs: binary ? [] : [snapshotOf(d3, 'f3')],
      });
      await flushAsync(20);
      if (!binary) applySent(h, d3, 'f3');

      expect([...h.vault.files.keys()]).toEqual([path]);
      expect(new Uint8Array(h.vault.files.get(path) ?? new ArrayBuffer(0))).toEqual(
        new Uint8Array(created),
      );
      expect(h.log.getFileMeta('b1', path)).toMatchObject({
        serverFileId: 'f3',
        contentHash: await sha256Hex(created),
      });
      // The deleted note's text was not folded into the new one.
      expect(d3.getText('content').toJSON()).toBe('new\n');
      expect(h.socket().created()).toEqual([]);
      await h.engine.stop();
    },
  );
});

describe('SyncEngine — a rename that changes only the case', () => {
  it.each([['made while away'], ['live']])(
    'keeps the only copy on a disk that ignores case (%s)',
    async (mode) => {
      const h = buildHarness();
      ignoreCase(h.vault);
      const img = new Uint8Array([4, 4, 4]).buffer;
      const hash = await remember(h, 'Photo.png', 'f1', img, img, 'BINARY');
      if (mode === 'live') {
        h.serverFiles = [serverFile('f1', 'Photo.png', 'BINARY', hash, 3)];
        await connect(h);
        h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'photo.png', log: eventLog });
        await flushAsync();
      } else {
        h.serverFiles = [serverFile('f1', 'photo.png', 'BINARY', hash, 3)];
        await connect(h, { operations: [rename('Photo.png', 'photo.png', 'f1', 1)] });
      }

      expect([...h.vault.files.keys()]).toEqual(['photo.png']);
      expect(h.vault.files.get('photo.png')).toBe(img);
      expect(h.engine.getFileIdForPath('photo.png')).toBe('f1');
      expect(h.log.getFileMeta('b1', 'Photo.png')).toBeNull();
      expect(h.socket().created()).toEqual([]);
      expect(h.engine.getStatus()).toBe('connected');
      await h.engine.stop();
    },
  );

  it('still parks a different file that holds the new name on a disk that tells case apart', async () => {
    const h = buildHarness();
    const img = new Uint8Array([4, 4, 4]).buffer;
    const other = new Uint8Array([5]).buffer;
    const hash = await remember(h, 'Photo.png', 'f1', img, img, 'BINARY');
    h.vault.files.set('photo.png', other);
    h.serverFiles = [serverFile('f1', 'Photo.png', 'BINARY', hash, 3)];
    await connect(h);

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'photo.png', log: eventLog });
    await flushAsync();

    expect(h.vault.files.get('photo.png')).toBe(img);
    const aside = [...h.vault.files.keys()].filter((p) => p.startsWith('photo.conflict-'));
    expect(aside).toHaveLength(1);
    expect(h.vault.files.get(aside[0] ?? '')).toBe(other);
    expect(h.vault.files.has('Photo.png')).toBe(false);
    await h.engine.stop();
  });
});

describe('SyncEngine — a rename made while away that cannot be applied yet', () => {
  it('connects all the same when the file is locked, and moves it on the next connect', async () => {
    const h = buildHarness();
    const X = new Uint8Array([5, 5, 5]).buffer;
    const hx = await remember(h, 'report.xlsx', 'f1', X, X, 'BINARY');
    h.serverFiles = [serverFile('f1', 'report-final.xlsx', 'BINARY', hx, 3)];
    const rename0 = h.vault.rename.bind(h.vault);
    let locked = true;
    h.vault.rename = async (from, to) => {
      if (locked && from === 'report.xlsx') throw new Error('EBUSY: resource busy or locked');
      return rename0(from, to);
    };

    await connect(h, { operations: [rename('report.xlsx', 'report-final.xlsx', 'f1', 1)] });
    await flushAsync(20);

    expect(h.statuses).not.toContain('error');
    expect(h.engine.getStatus()).toBe('connected');
    // Still known under the old name, so not uploaded as a new file.
    expect([...h.vault.files.keys()]).toEqual(['report.xlsx']);
    expect(h.engine.getFileIdForPath('report.xlsx')).toBe('f1');
    expect(h.socket().created()).toEqual([]);

    locked = false;
    await reconnect(h);
    expect([...h.vault.files.keys()]).toEqual(['report-final.xlsx']);
    expect(h.engine.getFileIdForPath('report-final.xlsx')).toBe('f1');
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });

  it('moves nothing into the name of a file whose own move failed', async () => {
    // Away: `a.bin` → `archive/c.bin`, then `b.bin` → `a.bin`. The folder
    // `archive` can't be created, so `a.bin` stays — renamable, but ours.
    const h = buildHarness();
    const A = new Uint8Array([1]).buffer;
    const B = new Uint8Array([2, 2]).buffer;
    const ha = await remember(h, 'a.bin', 'f1', A, A, 'BINARY');
    const hb = await remember(h, 'b.bin', 'f2', B, B, 'BINARY');
    h.serverFiles = [
      serverFile('f1', 'archive/c.bin', 'BINARY', ha, 1),
      serverFile('f2', 'a.bin', 'BINARY', hb, 2),
    ];
    let denied = true;
    const vault: VaultAdapter = h.vault;
    vault.ensureParentFolder = async (path: string): Promise<void> => {
      if (denied && path.startsWith('archive/')) throw new Error('EPERM: operation not permitted');
    };

    await connect(h, {
      operations: [rename('a.bin', 'archive/c.bin', 'f1', 1), rename('b.bin', 'a.bin', 'f2', 2)],
    });
    await flushAsync(20);

    expect(h.engine.getStatus()).toBe('connected');
    // Neither moved — the catch-up's RENAME included. Moved in, `b.bin` would
    // have parked our `a.bin` aside as a conflict and uploaded it.
    expect([...h.vault.files.keys()].sort()).toEqual(['a.bin', 'b.bin']);
    expect(h.vault.files.get('a.bin')).toBe(A);
    expect(h.engine.getFileIdForPath('a.bin')).toBe('f1');
    expect(h.engine.getFileIdForPath('b.bin')).toBe('f2');
    expect(h.socket().created()).toEqual([]);

    denied = false;
    await reconnect(h);
    expect([...h.vault.files.keys()].sort()).toEqual(['a.bin', 'archive/c.bin']);
    expect(h.vault.files.get('a.bin')).toBe(B);
    expect(h.vault.files.get('archive/c.bin')).toBe(A);
    expect(h.socket().created()).toEqual([]);
    await h.engine.stop();
  });
});

describe('SyncEngine — a stop between the renames made while away', () => {
  it('leaves the next engine the old name of a file not moved yet', async () => {
    // Away: `a.md` → `b.md`, `c.md` → `d.md`, and a new note at `c.md`. The
    // stop lands on the first move; the second is the next engine's.
    const h = buildHarness();
    await remember(h, 'a.md', 'f1', encode('A\n'));
    await remember(h, 'c.md', 'f2', encode('C\n'), encode('C\nlocal\n'));
    const d1 = serverDocWith('A\n');
    const d2 = serverDocWith('C\n');
    const d3 = serverDocWith('new\n');
    const files = [
      serverFile('f1', 'b.md', 'TEXT', await sha256Hex('A\n'), 2),
      serverFile('f2', 'd.md', 'TEXT', await sha256Hex('C\n'), 2),
      serverFile('f3', 'c.md', 'TEXT', await sha256Hex('new\n'), 4),
    ];
    h.serverFiles = files;
    const move = h.vault.gate('rename');
    await h.engine.start();
    await move.reached;
    const stopping = h.engine.stop();
    move.release();
    await stopping;
    expect(h.vault.text('b.md')).toBe('A\n');
    // The new note's record did not take the place of the unmoved one's.
    expect(h.log.getFileMeta('b1', 'c.md')?.serverFileId).toBe('f2');

    const next = buildHarness({ predecessor: h });
    next.serverFiles = files;
    await connect(next, {
      yjsDocs: [snapshotOf(d1, 'f1'), snapshotOf(d2, 'f2'), snapshotOf(d3, 'f3')],
    });
    await flushAsync(20);
    applySent(next, d2, 'f2');
    applySent(next, d3, 'f3');

    expect(d3.getText('content').toJSON()).toBe('new\n');
    expect(d2.getText('content').toJSON()).toBe('C\nlocal\n');
    expect(next.vault.text('c.md')).toBe('new\n');
    expect(next.vault.text('d.md')).toBe('C\nlocal\n');
    expect(next.socket().created()).toEqual([]);
    await next.engine.stop();
  });
});

describe('SyncEngine — a binary created in another folder and moved in while away', () => {
  it('is downloaded into the binding', async () => {
    const h = buildHarness({ localFolder: 'notes' });
    const img = new Uint8Array([9, 9]).buffer;
    h.serverFiles = [serverFile('f1', 'notes/x.png', 'BINARY', await sha256Hex(img), 2)];
    h.routes.set('GET /api/projects/p1/files/f1', () => bytes(img));

    await connect(h, {
      operations: [
        op('CREATE', 'other/x.png', null, { fileId: 'f1', fileType: 'BINARY' }, 1),
        op('MOVE', 'other/x.png', 'notes/x.png', { fileId: 'f1' }, 2),
      ],
    });

    expect([...h.vault.files.keys()]).toEqual(['notes/x.png']);
    expect(h.vault.files.get('notes/x.png')).toBe(img);
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });
});

describe('SyncEngine — no question over note edits the server already has', () => {
  /** Connect with `note.md`, then save `saved` and send it. */
  async function connectAndSave(h: Harness, saved: string): Promise<void> {
    const serverDoc = serverDocWith('v1\n');
    h.serverFiles = [serverFile('f1', 'note.md', 'TEXT', await sha256Hex('v1\n'), 3)];
    await connect(h, { yjsDocs: [snapshotOf(serverDoc, 'f1')] });
    h.vault.files.set('note.md', encode(saved));
    await h.engine.handleVaultEvent({
      bindingId: 'b1',
      type: 'modify',
      path: 'note.md',
      source: 'obsidian',
    });
    await flushAsync();
    applySent(h, serverDoc, 'f1');
    expect(serverDoc.getText('content').toJSON()).toBe(saved);
  }

  it('removes a note renamed to a name this client never writes, after a save that went out', async () => {
    const h = buildHarness();
    await connectAndSave(h, 'v1\nmine\n');

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'note.md~', log: eventLog });
    await flushAsync();

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('note.md')).toBe(false);
    expect(h.engine.getFileIdForPath('note.md')).toBeNull();
    await h.engine.stop();
  });

  it('removes a note a teammate deleted after a save that went out', async () => {
    const h = buildHarness();
    await connectAndSave(h, 'v1\nmine\n');

    h.socket().fire('file:deleted', { fileId: 'f1', log: eventLog });
    await flushAsync();

    expect(h.calls).not.toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('note.md')).toBe(false);
    await h.engine.stop();
  });

  it('still asks about a save that is not in the doc yet', async () => {
    const h = buildHarness();
    await connectAndSave(h, 'v1\nmine\n');
    // Saved again; the watcher has not reported it.
    h.vault.files.set('note.md', encode('v1\nmine\nmore\n'));

    h.socket().fire('file:renamed', { fileId: 'f1', newPath: 'note.md~', log: eventLog });
    await flushAsync();

    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.files.has('note.md')).toBe(true);
    h.modal.del.resolve('delete-local');
    await flushAsync();
    await h.engine.stop();
  });

  it('still asks, on connect, about a save folded while offline and not sent yet', async () => {
    const h = buildHarness();
    const synced = encode('v1\n');
    const edited = encode('v1\noffline\n');
    await remember(h, 'note.md', 'f1', synced, edited);
    // Folded into the doc while offline: the marker names the disk, but the
    // doc has not been pushed back yet — the catch-up does that.
    const meta = h.log.getFileMeta('b1', 'note.md');
    if (!meta) throw new Error('no meta');
    h.log.setFileMeta({ ...meta, foldedHash: await sha256Hex(edited) });
    h.serverFiles = [serverFile('f1', 'note.md~', 'TEXT', await sha256Hex(synced), 3)];

    await connect(h, { operations: [rename('note.md', 'note.md~', 'f1', 1)] });

    expect(h.calls).toContain('modal.resolveDeleteConflict');
    expect(h.vault.text('note.md')).toBe('v1\noffline\n');
    h.modal.del.resolve('delete-local');
    await flushAsync();
    expect(h.engine.getStatus()).toBe('connected');
    await h.engine.stop();
  });
});
