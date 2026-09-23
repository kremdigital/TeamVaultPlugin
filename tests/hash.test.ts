import { sha256Hex } from '@/sync/hash';
import { stubWindow } from './window-stub';

describe('sha256Hex', () => {
  it('matches the canonical empty-input digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces a stable digest for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('handles ArrayBuffer + Uint8Array inputs identically to strings', async () => {
    const text = 'hello';
    const buffer = new TextEncoder().encode(text);
    const fromString = await sha256Hex(text);
    const fromBuffer = await sha256Hex(buffer);
    const fromArrayBuffer = await sha256Hex(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    expect(fromBuffer).toBe(fromString);
    expect(fromArrayBuffer).toBe(fromString);
  });

  it('returns lowercase hex of length 64', async () => {
    const digest = await sha256Hex('test');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex — platform crypto', () => {
  it('digests through window.crypto', async () => {
    const digest = jest.fn(() => Promise.resolve(new Uint8Array([0xab, 0x01]).buffer));
    const win = stubWindow({ crypto: { subtle: { digest } } });
    try {
      await expect(sha256Hex('x')).resolves.toBe('ab01');
      expect(digest).toHaveBeenCalledWith('SHA-256', expect.anything());
    } finally {
      win.restore();
    }
  });
});
