/**
 * Byte-level helpers shared by the segment proxies (/api/proxy/ts, /api/proxy/segment).
 *
 * Some hosts disguise MPEG-TS segments as images by prepending a fake header.
 * Stripping that header is only safe on plaintext media: scanning AES ciphertext
 * or fMP4 data for "0x47 every 188 bytes" can hit a false positive and cut the
 * segment at a random offset, which corrupts playback.
 */

const TS_PACKET_SIZE = 188;
const FMP4_BOX_TYPES = new Set(["ftyp", "moof", "styp", "mdat", "emsg", "sidx", "prft", "free"]);

export function isFmp4Buffer(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  const box = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  return FMP4_BOX_TYPES.has(box);
}

export function isPlainTsAt(buf: Uint8Array, offset: number): boolean {
  if (buf[offset] !== 0x47) return false;
  if (offset + TS_PACKET_SIZE < buf.length && buf[offset + TS_PACKET_SIZE] !== 0x47) return false;
  if (offset + TS_PACKET_SIZE * 2 < buf.length && buf[offset + TS_PACKET_SIZE * 2] !== 0x47) return false;
  return true;
}

/** True when the buffer starts with a well-known image signature (PNG, JPEG, GIF, BMP, WEBP). */
export function hasImageSignature(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true; // GIF8
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true; // RIFF....WEBP
  }
  return false;
}

/**
 * Returns the offset of the first MPEG-TS packet when a fake header precedes it, 0 when
 * the buffer already starts with TS, or -1 when no TS stream was found.
 *
 * `encrypted` disables the blind scan unless an image signature proves there is a
 * wrapper to strip.
 */
export function findTsStartOffset(buf: Uint8Array, encrypted = false, maxScan = 2048): number {
  if (buf.length < TS_PACKET_SIZE) return -1;
  if (isPlainTsAt(buf, 0)) return 0;
  if (isFmp4Buffer(buf)) return -1;
  if (encrypted && !hasImageSignature(buf)) return -1;

  const limit = Math.min(buf.length - TS_PACKET_SIZE * 2, maxScan);
  for (let i = 1; i < limit; i++) {
    if (
      buf[i] === 0x47 &&
      buf[i + TS_PACKET_SIZE] === 0x47 &&
      (i + TS_PACKET_SIZE * 2 >= buf.length || buf[i + TS_PACKET_SIZE * 2] === 0x47)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Detects HTML/JSON/XML error pages returned with a 200 status. Binary media
 * (including ciphertext, whose first byte can be any value) is never flagged.
 */
export function looksLikeTextErrorPayload(buf: Uint8Array): boolean {
  if (buf.length === 0) return true;
  const n = Math.min(buf.length, 256);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  if (printable < n * 0.95) return false;

  let sample = "";
  for (let i = 0; i < Math.min(n, 128); i++) sample += String.fromCharCode(buf[i]);
  sample = sample.trimStart().toLowerCase();
  return (
    sample.startsWith("<") ||
    sample.startsWith("{") ||
    sample.startsWith("[") ||
    sample.includes("cloudflare") ||
    sample.includes("error") ||
    sample.includes("forbidden")
  );
}
