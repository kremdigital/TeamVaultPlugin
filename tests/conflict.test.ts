import {
  buildConflictPath,
  defaultConflictResolver,
  detectBinaryConflict,
  detectDeleteConflict,
  serverConflictPath,
} from '@/sync/conflict';

describe('detectBinaryConflict', () => {
  it('returns false when nothing changed', () => {
    expect(detectBinaryConflict({ storedHash: 'a', localHash: 'a', serverHash: 'a' })).toBe(false);
  });

  it('returns false when only the server moved (clean fast-forward)', () => {
    expect(detectBinaryConflict({ storedHash: 'a', localHash: 'a', serverHash: 'b' })).toBe(false);
  });

  it('returns false when only the local file moved', () => {
    expect(detectBinaryConflict({ storedHash: 'a', localHash: 'b', serverHash: 'a' })).toBe(false);
  });

  it('returns false when both sides arrive at the same new content', () => {
    // Both moved to "b" independently — equivalent, not a conflict.
    expect(detectBinaryConflict({ storedHash: 'a', localHash: 'b', serverHash: 'b' })).toBe(false);
  });

  it('returns true when both sides diverged differently', () => {
    expect(detectBinaryConflict({ storedHash: 'a', localHash: 'b', serverHash: 'c' })).toBe(true);
  });
});

describe('detectDeleteConflict', () => {
  it('returns false when local matches the stored hash (no unsaved edits)', () => {
    expect(detectDeleteConflict({ storedHash: 'a', localHash: 'a' })).toBe(false);
  });

  it('returns true when local has uncommitted edits', () => {
    expect(detectDeleteConflict({ storedHash: 'a', localHash: 'b' })).toBe(true);
  });
});

describe('buildConflictPath', () => {
  it('inserts the conflict marker before the extension', () => {
    expect(buildConflictPath('notes/foo.png', 1700000000000)).toBe(
      'notes/foo.conflict-1700000000000.png',
    );
  });

  it('appends a marker when the file has no extension', () => {
    expect(buildConflictPath('Makefile', 17)).toBe('Makefile.conflict-17');
  });

  it('handles dot-prefixed files (.gitignore) without misinterpreting', () => {
    expect(buildConflictPath('.gitignore', 5)).toBe('.gitignore.conflict-5');
  });

  it('handles deep paths', () => {
    expect(buildConflictPath('a/b/c/data.json', 42)).toBe('a/b/c/data.conflict-42.json');
  });

  it('handles bare filenames', () => {
    expect(buildConflictPath('image.jpg', 99)).toBe('image.conflict-99.jpg');
  });
});

describe('serverConflictPath', () => {
  it('names the conflict copy the way the server does', () => {
    expect(serverConflictPath('notes/U.md', 'device-1')).toBe('notes/U.conflict-device-1.md');
    expect(serverConflictPath('notes/U.md', 'device-1', 2)).toBe('notes/U.conflict-device-1-2.md');
    expect(serverConflictPath('a.b/Makefile', 'device-1', 3)).toBe(
      'a.b/Makefile.conflict-device-1-3',
    );
  });

  it('keeps the counter after an id cut to 32 characters, anything odd in it made `_`', () => {
    const id = 'dev ice/'.padEnd(40, 'x');
    expect(serverConflictPath('U.md', id, 2)).toBe(`U.conflict-dev_ice_${'x'.repeat(24)}-2.md`);
    expect(serverConflictPath('U.md', '')).toBe('U.conflict-unknown.md');
  });
});

describe('defaultConflictResolver', () => {
  it('returns keep-server for binary conflicts', async () => {
    expect(
      await defaultConflictResolver.resolveBinaryConflict({
        filePath: 'a',
        localSize: 0,
        serverSize: 0,
      }),
    ).toBe('keep-server');
  });

  it('returns delete-local for delete conflicts', async () => {
    expect(
      await defaultConflictResolver.resolveDeleteConflict({
        filePath: 'a',
        localSize: 0,
      }),
    ).toBe('delete-local');
  });
});
