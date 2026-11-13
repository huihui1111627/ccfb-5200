// Format-agnostic streaming reader. Feeds byte ranges of the stored file blob
// into per-format decoders and hands fixed-size mono chunks to the analyser.
//
// Memory contract: at any moment we hold at most one read window (~1 MB),
// one decoder-internal buffer and one analysis chunk. The full 8-hour PCM
// stream is never materialised.

import { FLACDecoder } from '@wasm-audio-decoders/flac';
import { decodePcmRange, WavHeader } from './wav';
import { FlacMeta } from './flac';
import { downmixMono } from '../dsp/analyze';
import { STFT } from '../types';

export type BlobRead = (offset: number, length: number) => Promise<Uint8Array>;

export interface FlacAnchor {
  byteOffset: number;
  sampleIndex: number;
}

export interface StreamHandle {
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface ChunkOutput {
  mono: Float32Array;
  /** Absolute sample index of mono[0] in the recording. */
  startSample: number;
  /** Number of fresh (non-overlap) samples this chunk advances. */
  advanceSamples: number;
  index: number;
}

const READ_WINDOW = 1024 * 1024;
/** STFT overlap carried across chunk borders so no frame is dropped. */
export const CHUNK_OVERLAP = STFT.fftSize - STFT.hopSize;

export interface Streamer {
  handle: StreamHandle;
  nextChunk: () => Promise<ChunkOutput | null>;
  /** FLAC only: byte/sample anchors for later random-access playback. */
  anchors: FlacAnchor[];
  dispose?: () => void;
}

/** WAV: direct byte-range reads, no decoder state. */
export function createWavStreamer(
  read: BlobRead,
  header: WavHeader,
  chunkSec: number,
): Streamer {
  const framesPerChunk = Math.round(header.sampleRate * chunkSec);
  const totalFrames = Math.floor(header.dataLength / header.blockAlign);
  let chunkIndex = 0;
  let frameCursor = 0;

  return {
    handle: {
      sampleRate: header.sampleRate,
      channels: header.channels,
      durationSec: totalFrames / header.sampleRate,
    },
    anchors: [],
    async nextChunk() {
      if (frameCursor >= totalFrames) return null;
      const readStart = frameCursor === 0 ? 0 : frameCursor - CHUNK_OVERLAP;
      const startSample = readStart;
      const fresh = Math.min(framesPerChunk, totalFrames - frameCursor);
      const frames = Math.min(fresh + (frameCursor - readStart), totalFrames - readStart);
      const byteStart = header.dataOffset + readStart * header.blockAlign;
      const bytes = await read(byteStart, frames * header.blockAlign);
      const interleaved = decodePcmRange(bytes, header);
      const advance = fresh;
      frameCursor += fresh;
      chunkIndex++;
      return {
        mono: downmixMono(interleaved, header.channels),
        startSample,
        advanceSamples: advance,
        index: chunkIndex - 1,
      };
    },
  };
}

/** FLAC: feed file windows into the streaming WASM decoder. */
export async function createFlacStreamer(
  read: BlobRead,
  meta: FlacMeta,
  fileSize: number,
  chunkSec: number,
): Promise<Streamer> {
  const decoder = new FLACDecoder();
  await decoder.ready;
  const framesPerChunk = Math.round(meta.sampleRate * chunkSec);
  const anchors: FlacAnchor[] = [{ byteOffset: meta.audioOffset, sampleIndex: 0 }];

  let byteCursor = meta.audioOffset;
  // `consumed` = samples already handed out as chunk output (absolute index).
  // `carry` = decoded samples not yet emitted, starting at absolute index
  // `consumed` (its length grows in decoder-sized bursts independently of the
  // 32 s output cadence).
  let consumed = 0;
  let carry: Float32Array[] | null = null;
  let chunkIndex = 0;
  let done = false;

  const carryLength = () => (carry ? carry[0].length : 0);

  return {
    handle: {
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      durationSec: meta.durationSec,
    },
    anchors,
    async nextChunk(): Promise<ChunkOutput | null> {
      const freshWanted = Math.min(framesPerChunk, meta.totalSamples - consumed);
      if (freshWanted <= 0) return null;
      const lookback = Math.min(CHUNK_OVERLAP, consumed);
      const needCarry = freshWanted + lookback;

      // Keep decoding until the carry buffer covers this output chunk.
      while (!done && carryLength() < needCarry) {
        if (byteCursor >= fileSize) {
          const flushed = await decoder.flush();
          done = true;
          if (flushed.samplesDecoded > 0) {
            carry = mergeChannelData(carry, flushed.channelData, meta.channels);
          }
          break;
        }
        const windowStart = byteCursor;
        const bytes = await read(byteCursor, Math.min(READ_WINDOW, fileSize - byteCursor));
        byteCursor += bytes.byteLength;
        const res = await decoder.decode(bytes);
        if (res.samplesDecoded > 0) {
          // Anchor maps a byte position to the absolute sample index reached
          // after this decode window: consumed + everything currently buffered.
          anchors.push({
            byteOffset: windowStart + bytes.byteLength,
            sampleIndex: consumed + carryLength() + res.samplesDecoded,
          });
          carry = mergeChannelData(carry, res.channelData, meta.channels);
        }
      }

      if (!carry || carryLength() <= lookback) return null;
      const available = carryLength() - lookback;
      const takeFresh = Math.min(freshWanted, available);
      // Output window begins `lookback` samples before the fresh region.
      const startInCarry = carryLength() - lookback - takeFresh;
      const mono = new Float32Array(takeFresh + lookback);
      for (let i = 0; i < mono.length; i++) {
        let s = 0;
        for (let c = 0; c < meta.channels; c++) s += carry[c][startInCarry + i];
        mono[i] = s / meta.channels;
      }
      const startSample = consumed - lookback;
      // Drop the consumed fresh samples; the remaining tail (including the
      // lookback portion) becomes the next iteration's carry.
      carry = carry.map((c) => c.subarray(startInCarry + takeFresh).slice());
      consumed += takeFresh;
      chunkIndex++;
      return {
        mono,
        startSample,
        advanceSamples: takeFresh,
        index: chunkIndex - 1,
      };
    },
    dispose() {
      decoder.free();
    },
  };
}

function mergeChannelData(
  prev: Float32Array[] | null,
  next: Float32Array[],
  channels: number,
): Float32Array[] {
  if (!prev) return next.map((c) => c.slice());
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const merged = new Float32Array(prev[c].length + next[c].length);
    merged.set(prev[c], 0);
    merged.set(next[c], prev[c].length);
    out.push(merged);
  }
  return out;
}

/**
 * Random-access decode for playback (FLAC): start feeding from the nearest
 * preceding anchor and return `framesWanted` interleaved samples.
 */
export async function decodeFlacRange(
  read: BlobRead,
  meta: FlacMeta,
  anchors: FlacAnchor[],
  fileSize: number,
  startSample: number,
  framesWanted: number,
): Promise<Float32Array> {
  // Fall back to the audio start when no anchors were persisted (e.g. legacy
  // records); playback then decodes from the beginning, still correct.
  const anchor =
    [...anchors].reverse().find((a) => a.sampleIndex <= startSample) ??
    anchors[0] ??
    { byteOffset: meta.audioOffset, sampleIndex: 0 };
  const decoder = new FLACDecoder();
  await decoder.ready;
  try {
    let collected: Float32Array[] = [];
    let have = 0;
    let offset = anchor.byteOffset;
    const skip = startSample - anchor.sampleIndex;
    const target = skip + framesWanted;

    while (have < target && offset < fileSize) {
      const bytes = await read(offset, Math.min(READ_WINDOW, fileSize - offset));
      offset += bytes.byteLength;
      const res = await decoder.decode(bytes);
      if (res.samplesDecoded > 0) {
        collected = mergeChannelData(collected.length ? collected : null, res.channelData, meta.channels);
        have += res.samplesDecoded;
      }
    }
    if (have < target) {
      const flushed = await decoder.flush();
      if (flushed.samplesDecoded > 0) {
        collected = mergeChannelData(collected.length ? collected : null, flushed.channelData, meta.channels);
        have += flushed.samplesDecoded;
      }
    }

    const take = Math.min(framesWanted, collected[0].length - skip);
    const interleaved = new Float32Array(take * meta.channels);
    for (let i = 0; i < take; i++) {
      for (let c = 0; c < meta.channels; c++) {
        interleaved[i * meta.channels + c] = collected[c][skip + i] ?? 0;
      }
    }
    return interleaved;
  } finally {
    decoder.free();
  }
}

/** Random-access decode for playback (WAV). */
export async function decodeWavRange(
  read: BlobRead,
  header: WavHeader,
  startSample: number,
  framesWanted: number,
): Promise<Float32Array> {
  const totalFrames = Math.floor(header.dataLength / header.blockAlign);
  const frames = Math.min(framesWanted, totalFrames - startSample);
  const byteStart = header.dataOffset + startSample * header.blockAlign;
  const bytes = await read(byteStart, frames * header.blockAlign);
  return decodePcmRange(bytes, header);
}
