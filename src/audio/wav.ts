// Minimal streaming WAV (RIFF/WAVE) reader.
// Supports PCM int8/16/24/32, IEEE float32, extensible format. Metadata chunks
// (LIST/INFO, bext, axml, id3) are captured without loading audio into memory.

export interface WavHeader {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  audioFormat: number; // 1 = PCM, 3 = float, 0xFFFE = extensible
  dataOffset: number; // byte offset of PCM data
  dataLength: number; // byte length of PCM data
  durationSec: number;
  blockAlign: number;
  tags: Record<string, string>;
}

/** Read a fixed-width FourCC-style field. Trailing spaces are significant
 *  (e.g. "fmt " and "data"), so only NULs terminate the string. */
function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g, '').trim();
  } catch {
    return '';
  }
}

/** Read the header by scanning RIFF chunks; needs only the first ~2 MB of the file. */
export async function readWavHeader(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  fileSize: number,
): Promise<WavHeader> {
  const probeLen = Math.min(fileSize, 2 * 1024 * 1024);
  const buf = await read(0, probeLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  const tags: Record<string, string> = {};
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let audioFormat = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitDepth = view.getUint16(body + 14, true);
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format GUID first two bytes hold the real format.
        audioFormat = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break; // audio follows; nothing of interest after it for our purposes
    } else if (id === 'LIST' && body + size <= buf.length) {
      parseListInfo(buf, body, size, tags);
    } else if (id === 'bext' && body + size <= buf.length) {
      parseBext(buf, body, size, tags);
    } else if (id === 'id3 ' || id === 'ID3 ') {
      tags['id3-block'] = `present@${body}`;
    }
    // All chunks (known or skipped) advance by body size + word alignment.
    pos = body + size + (size & 1);
  }

  if (!sampleRate || !channels || !bitDepth || !dataOffset) {
    throw new Error('incomplete WAV header or data chunk not found in first 2 MB');
  }
  // data chunk may run to EOF when size is the legacy 0xFFFFFFFF placeholder.
  if (dataLength === 0xffffffff || dataLength === 0) {
    dataLength = fileSize - dataOffset;
  }
  const bytesPerSec = sampleRate * channels * (bitDepth >> 3);
  const durationSec = dataLength / bytesPerSec;

  return {
    sampleRate,
    channels,
    bitDepth,
    audioFormat,
    dataOffset,
    dataLength,
    durationSec,
    blockAlign,
    tags,
  };
}

function parseListInfo(
  buf: Uint8Array,
  body: number,
  size: number,
  tags: Record<string, string>,
): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const listType = readAscii(view, body, 4);
  if (listType !== 'INFO') return;
  let p = body + 4;
  const end = body + size;
  while (p + 8 <= end) {
    const field = readAscii(view, p, 4);
    const fieldSize = view.getUint32(p + 4, true);
    if (fieldSize === 0 || p + 8 + fieldSize > end) break;
    const value = decodeUtf8(buf.subarray(p + 8, p + 8 + fieldSize));
    if (field && value) tags[`info:${field.toLowerCase()}`] = value;
    p += 8 + fieldSize + (fieldSize & 1);
  }
}

function parseBext(
  buf: Uint8Array,
  body: number,
  size: number,
  tags: Record<string, string>,
): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (off: number, len: number) => decodeUtf8(buf.subarray(body + off, body + off + len));
  if (size < 348) return;
  const description = str(0, 256);
  const originator = str(256, 32);
  const originatorRef = str(288, 32);
  const originDate = str(320, 10);
  const originTime = str(330, 8);
  if (description) tags['bext:description'] = description;
  if (originator) tags['bext:originator'] = originator;
  if (originatorRef) tags['bext:originator_reference'] = originatorRef;
  if (originDate) tags['bext:origin_date'] = originDate;
  if (originTime) tags['bext:origin_time'] = originTime;
  // Time reference: samples since midnight (or since the timestamp above).
  const timeRefLow = view.getUint32(body + 340, true);
  tags['bext:time_reference'] = String(timeRefLow);
}

/** Decode a byte range of PCM data into interleaved Float32 samples. */
export function decodePcmRange(
  bytes: Uint8Array,
  header: WavHeader,
): Float32Array {
  const { channels, bitDepth, audioFormat, blockAlign } = header;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = Math.floor(bytes.byteLength / blockAlign);
  const out = new Float32Array(frameCount * channels);

  if (audioFormat === 3 && bitDepth === 32) {
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  if (audioFormat === 3 && bitDepth === 64) {
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8, true);
    return out;
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`unsupported WAV audio format ${audioFormat}`);
  }

  switch (bitDepth) {
    case 8: // unsigned
      for (let i = 0; i < out.length; i++) out[i] = (view.getUint8(i) - 128) / 128;
      break;
    case 16:
      for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
      break;
    case 24: {
      for (let f = 0; f < frameCount; f++) {
        for (let c = 0; c < channels; c++) {
          const off = f * blockAlign + c * 3;
          const b0 = view.getUint8(off);
          const b1 = view.getUint8(off + 1);
          const b2 = view.getUint8(off + 2);
          let v = b0 | (b1 << 8) | (b2 << 16);
          if (v & 0x800000) v |= 0xff000000;
          out[f * channels + c] = v / 8388608;
        }
      }
      break;
    }
    case 32:
      for (let i = 0; i < out.length; i++) out[i] = view.getInt32(i * 4, true) / 2147483648;
      break;
    default:
      throw new Error(`unsupported PCM bit depth ${bitDepth}`);
  }
  return out;
}
