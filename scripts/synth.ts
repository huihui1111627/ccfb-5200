// Deterministic synthetic field-recording generator.
//
// Produces 48 kHz mono Float32 audio containing:
//   - low-level forest ambience (filtered random noise)
//   - known bird-call events at precise timestamps (FM sweeps + chirp trains)
//   - wind passages: strong low-frequency modulated noise
//   - rain passages: broadband noise
// plus a GroundTruth descriptor. Used by the browser import page and the
// Node-side accuracy self-test.

import { GroundTruth, GroundTruthCall } from '../src/types';

export const SYNTH_SAMPLE_RATE = 48000;

/** Mulberry32 — small deterministic PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  durationSec: number;
  seed?: number;
  /** Call density per minute; positions are still deterministic. */
  callsPerMinute?: number;
  includeWeather?: boolean;
}

interface WindSpec {
  startSec: number;
  endSec: number;
}
interface RainSpec {
  startSec: number;
  endSec: number;
}

export interface SynthResult {
  samples: Float32Array;
  groundTruth: GroundTruth;
}

export function synthesize(opts: SynthOptions): SynthResult {
  const sr = SYNTH_SAMPLE_RATE;
  const seed = opts.seed ?? 20260412;
  const rng = makeRng(seed);
  const total = Math.round(opts.durationSec * sr);
  const out = new Float32Array(total);

  // ---- 1. Base ambience: white noise through a cheap one-pole low-pass. ----
  let lp = 0;
  const ambienceGain = 0.012;
  for (let i = 0; i < total; i++) {
    const white = rng() * 2 - 1;
    lp += 0.08 * (white - lp);
    out[i] += lp * ambienceGain;
  }

  // ---- 2. Weather layers. --------------------------------------------------
  const wind: WindSpec[] = [];
  const rain: RainSpec[] = [];
  if (opts.includeWeather && opts.durationSec > 45) {
    // Fit both weather types into any recording longer than ~45 s.
    // Long field-style recordings get 30 s passages; short clips get compact 6 s.
    const longForm = opts.durationSec >= 240;
    const segLen = longForm ? 30 : 6;
    if (longForm) {
      wind.push({ startSec: 120, endSec: 150 });
      rain.push({ startSec: 300, endSec: 330 });
      if (opts.durationSec > 900) wind.push({ startSec: 900, endSec: 940 });
      if (opts.durationSec > 1600) rain.push({ startSec: 1500, endSec: 1545 });
    } else {
      const windStart = Math.max(2, opts.durationSec * 0.2);
      const rainStart = windStart + segLen + 4;
      wind.push({ startSec: windStart, endSec: windStart + segLen });
      if (rainStart + segLen < opts.durationSec - 2) {
        rain.push({ startSec: rainStart, endSec: rainStart + segLen });
      }
    }
  }
  for (const w of wind) addWind(out, sr, w.startSec, w.endSec, rng);
  for (const r of rain) addRain(out, sr, r.startSec, r.endSec, rng);

  // ---- 3. Bird calls at known, evenly-jittered positions. ------------------
  const callsPerMinute = opts.callsPerMinute ?? 3;
  const spacing = 60 / callsPerMinute;
  const calls: GroundTruthCall[] = [];
  const species = ['Phylloscopus_collybita', 'Turdus_merula', 'Parus_major', 'Cuculus_canorus'];
  let t = spacing * 0.5 + rng() * 2;
  let idx = 0;
  while (t < opts.durationSec - 5) {
    const sp = species[idx % species.length];
    const kind = idx % 3;
    const startSec = Math.round(t * 1000) / 1000;
    const durSec = kind === 2 ? 0.5 + rng() * 0.4 : 0.12 + rng() * 0.18;
    const baseHz = 1800 + rng() * 4200;
    const sweepHz = kind === 0 ? 800 + rng() * 1200 : kind === 1 ? -(600 + rng() * 900) : 0;
    addCall(out, sr, startSec, durSec, baseHz, sweepHz, kind, rng);
    calls.push({
      startSec,
      endSec: Math.round((startSec + durSec) * 1000) / 1000,
      lowHz: Math.round(Math.max(300, baseHz + Math.min(0, sweepHz) - 400)),
      highHz: Math.round(baseHz + Math.max(0, sweepHz) + 400),
      species: sp,
    });
    t += spacing + (rng() - 0.5) * spacing * 0.4;
    idx++;
  }

  // Soft saturation to keep everything inside [-1, 1].
  for (let i = 0; i < total; i++) {
    const x = out[i];
    out[i] = Math.tanh(x * 1.2) / 1.2;
  }

  return {
    samples: out,
    groundTruth: {
      generatedAt: Date.UTC(2026, 3, 12, 21, 30, 0),
      sampleRate: sr,
      durationSec: opts.durationSec,
      seed,
      calls,
      wind: wind.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
      rain: rain.map((r) => ({ startSec: r.startSec, endSec: r.endSec })),
    },
  };
}

function addCall(
  out: Float32Array,
  sr: number,
  startSec: number,
  durSec: number,
  baseHz: number,
  sweepHz: number,
  kind: number,
  rng: () => number,
): void {
  const start = Math.round(startSec * sr);
  const dur = Math.round(durSec * sr);
  const gain = 0.12 + rng() * 0.1;
  if (kind === 2) {
    // Chirp train: 4-7 overlapping short pulses (natural vibrato-like trill).
    const pulses = 4 + Math.floor(rng() * 4);
    const step = Math.floor(dur / pulses);
    const pulseLen = Math.floor(step * 1.35); // overlap neighbours, no hard silence
    for (let p = 0; p < pulses; p++) {
      const pStart = start + p * step;
      for (let n = 0; n < pulseLen; n++) {
        const i = pStart + n;
        if (i >= out.length) return;
        const local = n / sr;
        const env = Math.sin((Math.PI * n) / pulseLen);
        const f = baseHz + Math.sin(2 * Math.PI * 9 * local) * 200;
        out[i] += gain * 0.8 * env * Math.sin(2 * Math.PI * f * local);
      }
    }
    return;
  }
  for (let n = 0; n < dur; n++) {
    const i = start + n;
    if (i >= out.length) break;
    const local = n / dur;
    // Attack/sustain/release envelope.
    const env =
      local < 0.15
        ? local / 0.15
        : local > 0.85
          ? (1 - local) / 0.15
          : 1;
    const f = baseHz + sweepHz * local;
    // Fundamental + a weaker harmonic for spectral structure.
    const sig =
      Math.sin(2 * Math.PI * f * (n / sr)) +
      0.35 * Math.sin(2 * Math.PI * f * 2 * (n / sr));
    // Slow amplitude tremolo typical of many songs.
    const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 18 * (n / sr));
    out[i] += gain * env * trem * sig;
  }
}

function addWind(
  out: Float32Array,
  sr: number,
  startSec: number,
  endSec: number,
  rng: () => number,
): void {
  const start = Math.round(startSec * sr);
  const end = Math.round(endSec * sr);
  let lp1 = 0;
  let lp2 = 0;
  // Slow LFO for gusts.
  for (let i = start; i < end && i < out.length; i++) {
    const white = rng() * 2 - 1;
    lp1 += 0.02 * (white - lp1); // very low-passed rumble
    lp2 += 0.005 * (white - lp2);
    const lfo = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.15 * ((i - start) / sr));
    out[i] += (lp1 * 0.55 + lp2 * 0.25) * lfo * 0.5;
  }
}

function addRain(
  out: Float32Array,
  sr: number,
  startSec: number,
  endSec: number,
  rng: () => number,
): void {
  const start = Math.round(startSec * sr);
  const end = Math.round(endSec * sr);
  // Broadband hiss with sparse droplet transients.
  for (let i = start; i < end && i < out.length; i++) {
    const white = rng() * 2 - 1;
    const droplet = rng() > 0.995 ? (rng() * 2 - 1) * 0.25 : 0;
    out[i] += white * 0.06 + droplet;
  }
}
