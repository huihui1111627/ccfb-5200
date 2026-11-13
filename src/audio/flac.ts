// FLAC container parsing: STREAMINFO + VORBIS_COMMENT, plus frame-sync scanning.
// Actual audio decoding lives in stream-decoder.ts via @wasm-audio-decoders/flac.

export interface FlacMeta {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  totalSamples: number;
  durationSec: number;
  audioOffset: number; // byte offset where audio frames begin
  tags: Record<string, string>;
}

const META_PROBE = 1024 * 1024;

export async function readFlacMeta(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  fileSize: number,
): Promise<FlacMeta> {
  const buf = await read(0, Math.min(fileSize, META_PROBE));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) {
    throw new Error('not a FLAC file (missing fLaC marker)');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let totalSamples = 0;
  let audioOffset = 4;
  const tags: Record<string, string> = {};

  let pos = 4;
  let last = false;
  while (!last && pos + 4 <= buf.length) {
    const header = dv.getUint32(pos);
    last = (header & 0x80000000) !== 0;
    const type = (header >>> 24) & 0x7f;
    const length = header & 0x00ffffff;
    const body = pos + 4;
    audioOffset = body + length;

    if (type === 0 && length >= 34) {
      // STREAMINFO (FLAC format spec §8). Packed tail starting at body+10:
      //   sample rate : 20 bits (body+10,11,12 high nibble)
      //   channels-1  : 3 bits  (body+12 low nibble high 3 bits)
      //   bps-1       : 5 bits  (body+12 low bit + body+13 high nibble)
      //   total samples: 36 bits (body+13 low nibble + body+14..17)
      const b10 = dv.getUint8(body + 10);
      const b11 = dv.getUint8(body + 11);
      const b12 = dv.getUint8(body + 12);
      const b13 = dv.getUint8(body + 13);
      sampleRate = (b10 << 12) | (b11 << 4) | (b12 >>> 4);
      channels = ((b12 >>> 1) & 0x7) + 1;
      const bpsMinus1 = ((b12 & 0x01) << 4) | (b13 >>> 4);
      bitDepth = bpsMinus1 + 1;
      const hi4 = b13 & 0x0f;
      const lo32 = dv.getUint32(body + 14);
      totalSamples = hi4 * 0x100000000 + lo32;
    } else if (type === 4) {
      parseVorbisComment(buf, body, length, tags);
    }
    pos = body + length;
    if (type === 127) break; // invalid padding block per spec
  }

  if (!sampleRate || !totalSamples) {
    throw new Error('incomplete FLAC STREAMINFO');
  }
  return {
    sampleRate,
    channels,
    bitDepth,
    totalSamples,
    durationSec: totalSamples / sampleRate,
    audioOffset,
    tags,
  };
}

function parseVorbisComment(
  buf: Uint8Array,
  body: number,
  length: number,
  tags: Record<string, string>,
): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = body;
  // FLAC vorbis comment block has no framing header (Ogg does); first field is vendor length.
  const vendorLen = dv.getUint32(p, true);
  p += 4 + vendorLen;
  if (p + 4 > body + length) return;
  const count = dv.getUint32(p, true);
  p += 4;
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count && p + 4 <= body + length; i++) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (len <= 0 || p + len > body + length) break;
    const raw = dec.decode(buf.subarray(p, p + len));
    p += len;
    const eq = raw.indexOf('=');
    if (eq > 0) tags[`vorbis:${raw.slice(0, eq).toLowerCase()}`] = raw.slice(eq + 1);
  }
}

/**
 * Scan a byte window for FLAC frame sync codes (0xFFF8..0xFFF9).
 * Returns absolute byte offsets. Frame headers also require valid CRC-ish structure;
 * the sync word plus reserved-bit check is enough for anchor building.
 */
export function findFrameSyncs(buf: Uint8Array, baseOffset: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xfe) === 0xf8) {
      out.push(baseOffset + i);
    }
  }
  return out;
}
