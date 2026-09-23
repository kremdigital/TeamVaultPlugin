/**
 * SHA-256 hex digest used as the canonical content hash for files. Electron
 * exposes `crypto.subtle` on `window`; under Node (Jest, the CLI emulator)
 * `window` is aliased to `globalThis`, which has had `crypto` since Node 19.
 */

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let view: ArrayBuffer | Uint8Array;
  if (typeof data === 'string') {
    view = new TextEncoder().encode(data);
  } else {
    view = data;
  }
  // crypto.subtle.digest accepts BufferSource; both Uint8Array and ArrayBuffer work.
  const digest = await window.crypto.subtle.digest('SHA-256', view as BufferSource);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
