import { FFT } from './fft';
import { hannWindow, windowSum } from './window';
import { STFT, TILE_BIN_COUNT, TILE_FRAME_COUNT } from '../types';

export const SPEC_DB_MIN = -100;
export const SPEC_DB_MAX = -20;
const EPS = 1e-10;

export interface ChunkAnalysis {
  frameCount: number;
  /** Absolute sample index at which this chunk's first sample sits. */
  startSample: number;
  /** Centre time of each frame, seconds. */
  times: Float32Array;
  rmsDb: Float32Array;
  flux: Float32Array;
  centroid: Float32Array;
  lowDb: Float32Array;
  midDb: Float32Array;
  highDb: Float32Array;
  /** 256x256 grayscale tiles, row 0 = highest frequency, column 0 = earliest frame. */
  tiles: Uint8Array[];
  /** Frames actually written into each tile (last one may be partial). */
  tileFrameCounts: number[];
}

/** Downmix interleaved PCM to mono Float32. */
export function downmixMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels === 1) return interleaved;
  const frames = interleaved.length / channels;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += interleaved[i * channels + c];
    out[i] = s / channels;
  }
  return out;
}

function bandMeanDb(
  mag: Float32Array,
  binStart: number,
  binEnd: number,
  norm: number,
): number {
  let sum = 0;
  for (let k = binStart; k < binEnd; k++) sum += mag[k] * norm;
  const meanAmp = sum / Math.max(1, binEnd - binStart);
  return 20 * Math.log10(meanAmp + EPS);
}

/**
 * Analyse one chunk of mono samples.
 *
 * `startSample` is the absolute sample index of mono[0] within the full
 * recording; frame timestamps are derived from it directly so chunking can
 * never shift the time axis. The caller is expected to overlap successive
 * chunks by (fftSize - hopSize) samples so no STFT frame is lost at a border.
 * Never retains references to the input samples after returning.
 */
export function analyzeChunk(
  mono: Float32Array,
  sampleRate: number,
  startSample: number,
  fftSize = STFT.fftSize,
  hopSize = STFT.hopSize,
): ChunkAnalysis {
  const fft = new FFT(fftSize);
  const win = hannWindow(fftSize);
  const wSum = windowSum(win);
  const ampNorm = 2 / wSum;
  const binHz = sampleRate / fftSize;
  const lowEnd = Math.max(1, Math.min(fftSize / 2, Math.round(1000 / binHz)));
  const midEnd = Math.max(lowEnd + 1, Math.min(fftSize / 2, Math.round(6000 / binHz)));
  const highEnd = fftSize / 2;

  const frameCount = Math.max(0, Math.floor((mono.length - fftSize) / hopSize) + 1);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const mag = new Float32Array(fftSize / 2 + 1);
  const prevMag = new Float32Array(fftSize / 2 + 1);

  const times = new Float32Array(frameCount);
  const rmsDb = new Float32Array(frameCount);
  const flux = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);
  const lowDb = new Float32Array(frameCount);
  const midDb = new Float32Array(frameCount);
  const highDb = new Float32Array(frameCount);

  const tileCount = Math.ceil(frameCount / TILE_FRAME_COUNT) || (frameCount === 0 ? 0 : 1);
  const tiles: Uint8Array[] = [];
  const tileFrameCounts: number[] = [];
  for (let t = 0; t < tileCount; t++) {
    tiles.push(new Uint8Array(TILE_FRAME_COUNT * TILE_BIN_COUNT));
    tileFrameCounts.push(0);
  }
  const dbSpan = SPEC_DB_MAX - SPEC_DB_MIN;

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    let energy = 0;
    for (let n = 0; n < fftSize; n++) {
      const x = mono[start + n] * win[n];
      re[n] = x;
      im[n] = 0;
      energy += x * x;
    }
    fft.transform(re, im);

    let magSum = 0;
    let weightedFreq = 0;
    let fluxSum = 0;
    for (let k = 0; k <= fftSize / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      magSum += m;
      weightedFreq += m * k * binHz;
      const diff = m - prevMag[k];
      if (diff > 0) fluxSum += diff;
    }

    const t = f;
    // Timestamp = window START in absolute recording time. Event segmentation
    // then aligns onsets to the first frame whose window contains the rise.
    times[f] = (startSample + t * hopSize) / sampleRate;
    rmsDb[f] = 20 * Math.log10(Math.sqrt(energy / fftSize) + EPS);
    flux[f] = (fluxSum * ampNorm) / (fftSize / 2);
    centroid[f] = magSum > EPS ? weightedFreq / magSum : 0;
    lowDb[f] = bandMeanDb(mag, 0, lowEnd, ampNorm);
    midDb[f] = bandMeanDb(mag, lowEnd, midEnd, ampNorm);
    highDb[f] = bandMeanDb(mag, midEnd, highEnd, ampNorm);

    // Spectrogram tile: decimate bins by 2 to 256 rows, row 0 = top (highest freq).
    const tileIdx = Math.floor(f / TILE_FRAME_COUNT);
    const col = f % TILE_FRAME_COUNT;
    const tile = tiles[tileIdx];
    tileFrameCounts[tileIdx] = col + 1;
    for (let r = 0; r < TILE_BIN_COUNT; r++) {
      const bin = (TILE_BIN_COUNT - 1 - r) * 2;
      const db = 20 * Math.log10(mag[bin] * ampNorm + EPS);
      const v = Math.round(((db - SPEC_DB_MIN) / dbSpan) * 255);
      tile[r * TILE_FRAME_COUNT + col] = v < 0 ? 0 : v > 255 ? 255 : v;
    }

    prevMag.set(mag);
  }

  return {
    frameCount,
    startSample,
    times,
    rmsDb,
    flux,
    centroid,
    lowDb,
    midDb,
    highDb,
    tiles,
    tileFrameCounts,
  };
}

/** Tile row (0=top) -> frequency in Hz. */
export function tileRowToHz(row: number, sampleRate: number): number {
  const bin = (TILE_BIN_COUNT - 1 - row) * 2;
  return (bin * sampleRate) / STFT.fftSize;
}

/** Frequency -> nearest tile row. */
export function hzToTileRow(hz: number, sampleRate: number): number {
  const bin = (hz * STFT.fftSize) / sampleRate;
  const row = TILE_BIN_COUNT - 1 - Math.round(bin / 2);
  return Math.max(0, Math.min(TILE_BIN_COUNT - 1, row));
}
