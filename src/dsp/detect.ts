import { Confidence, DetectionSettings, FrameStats } from '../types';

export interface RawEvent {
  startFrame: number;
  endFrame: number; // exclusive
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
  score: number;
  confidence: Confidence;
  activeFrames: number;
}

/** Median via copy-sort; frame counts are modest (a few thousand per chunk). */
function median(a: Float32Array, from: number, to: number): number {
  const slice = Array.from(a.subarray(from, to)).sort((x, y) => x - y);
  if (slice.length === 0) return 0;
  const mid = slice.length >> 1;
  return slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
}

function percentile(a: Float32Array, p: number): number {
  const sorted = Array.from(a).sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export interface WeatherMask {
  wind: Uint8Array;
  rain: Uint8Array;
}

/**
 * Weather noise mask, computed first so the event detector can suppress frames
 * dominated by wind/rain.
 *
 * - wind: sustained elevated energy below 1 kHz with low spectral centroid
 * - rain: sustained broadband energy with all three bands close together and
 *   a high centroid
 */
export function computeWeatherMask(
  stats: FrameStats,
  settings: DetectionSettings,
): WeatherMask {
  const n = stats.times.length;
  const wind = new Uint8Array(n);
  const rain = new Uint8Array(n);
  if (n < 8) return { wind, rain };

  const floor = {
    low: percentile(stats.lowDb, 0.2),
    mid: percentile(stats.midDb, 0.2),
    high: percentile(stats.highDb, 0.2),
  };
  const centMed = percentile(stats.centroid, 0.5);

  for (let i = 0; i < n; i++) {
    const lowOver = stats.lowDb[i] - floor.low;
    const midOver = stats.midDb[i] - floor.mid;
    const highOver = stats.highDb[i] - floor.high;
    const lowMidGap = stats.lowDb[i] - stats.midDb[i];
    const midHighGap = stats.midDb[i] - stats.highDb[i];

    if (
      lowOver >= settings.windDbOverFloor &&
      stats.centroid[i] < centMed * 0.9 &&
      lowMidGap > 6
    ) {
      wind[i] = 1;
    }
    if (
      midOver >= settings.rainDbOverFloor &&
      highOver >= settings.rainDbOverFloor * 0.8 &&
      midHighGap < 8 &&
      stats.centroid[i] > centMed * 1.3
    ) {
      rain[i] = 1;
    }
  }

  // Majority-vote smoothing over ~1 s windows removes isolated frame flicker.
  smoothMask(wind, stats, 0.5);
  smoothMask(rain, stats, 0.5);
  return { wind, rain };
}

function smoothMask(mask: Uint8Array, stats: FrameStats, winSec: number): void {
  const n = mask.length;
  const frameSec = n > 1 ? stats.times[1] - stats.times[0] : 0.0116;
  const radius = Math.max(1, Math.round(winSec / frameSec / 2));
  const out = new Uint8Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      for (let k = 0; k <= radius && k < n; k++) sum += mask[k];
    } else {
      sum -= mask[Math.max(0, i - radius - 1)];
      sum += mask[Math.min(n - 1, i + radius)];
    }
    const span = Math.min(n, i + radius + 1) - Math.max(0, i - radius);
    out[i] = sum / span >= 0.5 ? 1 : 0;
  }
  mask.set(out);
}

/**
 * Bird-call event detector over merged per-frame statistics.
 *
 * Adaptive per-band noise floor (rolling median) + SNR gate, spectral-flux
 * gate (adaptive percentile) to reject steady noise, morphological closure
 * over short gaps, then duration / duty-cycle / bandwidth post-filters.
 * Frames flagged as wind or rain are excluded.
 */
export function detectEvents(
  stats: FrameStats,
  sampleRate: number,
  settings: DetectionSettings,
  weather?: WeatherMask,
): RawEvent[] {
  const n = stats.times.length;
  if (n < 4) return [];
  const frameSec = n > 1 ? stats.times[1] - stats.times[0] : 0.0116;

  // Noise floor. A short rolling median gets contaminated by the call's own
  // loud frames (a 0.15 s call pollutes ~5 s of context on each side, making
  // preceding quiet frames look like high-SNR onsets). Use the global 20th
  // percentile — calls occupy only a tiny fraction of a long recording — and
  // blend with a wide 60 s rolling median to track slow ambience drift.
  const globalMidFloor = percentile(stats.midDb, 0.2);
  const globalHighFloor = percentile(stats.highDb, 0.2);
  const wideFrames = Math.max(64, Math.round(60 / frameSec));
  const wideHalf = wideFrames >> 1;
  const midFloor = new Float32Array(n);
  const highFloor = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - wideHalf);
    const to = Math.min(n, i + wideHalf);
    const rollMid = median(stats.midDb, from, to);
    const rollHigh = median(stats.highDb, from, to);
    midFloor[i] = Math.min(globalMidFloor, rollMid);
    highFloor[i] = Math.min(globalHighFloor, rollHigh);
  }

  // Adaptive flux gate. A raw percentile saturates on long recordings where
  // ~95% of frames are silent ambience (flux ≈ 0): p85 then equals ~0 and the
  // gate loses all discrimination. Rank only frames with measurable flux.
  const nonzeroFlux: number[] = [];
  for (let i = 0; i < n; i++) if (stats.flux[i] > 1e-6) nonzeroFlux.push(stats.flux[i]);
  nonzeroFlux.sort((a, b) => a - b);
  const fluxPct = nonzeroFlux.length
    ? nonzeroFlux[Math.floor(0.35 * (nonzeroFlux.length - 1))]
    : Infinity;
  const fluxGateVal = Math.max(fluxPct, 0.00008);
  const active = new Uint8Array(n);
  const scoreAt = new Float32Array(n);
  // Two-state gate: a flux transient ARMS an event; subsequent frames stay
  // active purely on band SNR (steady tonal frames have ~zero spectral flux,
  // so requiring flux throughout would gut every sustained call). The event
  // ends when SNR drops below the gate, after which a new flux onset is needed.
  let armed = false;
  for (let i = 0; i < n; i++) {
    if (weather && (weather.wind[i] || weather.rain[i])) {
      armed = false;
      continue;
    }
    const snrMid = stats.midDb[i] - midFloor[i];
    const snrHigh = stats.highDb[i] - highFloor[i];
    const bandHit =
      (snrMid >= settings.snrDb && stats.centroid[i] > 900) ||
      (snrHigh >= settings.snrDb && stats.centroid[i] > 1500);
    if (!bandHit) {
      armed = false;
      continue;
    }
    if (!armed) {
      // Need a transient (or an exceptionally strong frame) to (re)start.
      if (stats.flux[i] < fluxGateVal && snrMid < settings.snrDb + 12 && snrHigh < settings.snrDb + 12) {
        continue;
      }
      armed = true;
    }
    active[i] = 1;
    scoreAt[i] = Math.max(snrMid, snrHigh);
  }

  // Morphological closure: bridge gaps up to maxGapSec.
  const maxGapFrames = Math.max(1, Math.round(settings.maxGapSec / frameSec));
  const closed = new Uint8Array(active);
  let i = 0;
  while (i < n) {
    if (active[i] === 1) {
      let j = i + 1;
      let gap = 0;
      while (j < n && gap < maxGapFrames) {
        if (active[j] === 1) {
          for (let k = i; k <= j; k++) closed[k] = 1;
          i = j;
          gap = 0;
        } else {
          gap++;
        }
        j++;
      }
    }
    i++;
  }

  const minEventFrames = Math.max(2, Math.round(settings.minEventSec / frameSec));
  const events: RawEvent[] = [];
  let s = -1;
  for (let f = 0; f <= n; f++) {
    const on = f < n && closed[f] === 1;
    if (on && s < 0) s = f;
    if (!on && s >= 0) {
      const e = f;
      const len = e - s;
      let activeCount = 0;
      let scoreSum = 0;
      for (let k = s; k < e; k++) {
        activeCount += active[k];
        scoreSum += scoreAt[k];
      }
      const duty = activeCount / len;
      const durationSec = len * frameSec;
      if (len >= minEventFrames && duty >= settings.minDutyCycle) {
        const score = scoreSum / Math.max(1, activeCount);
        // Post-filter: long low-duty events are usually residual noise.
        const longNoisy = durationSec > 3 && duty < 0.25;
        if (!longNoisy) {
          const ev = buildEvent(s, e, stats, frameSec, active, score, sampleRate);
          refineOnsetOffset(ev, stats, active, frameSec);
          events.push(ev);
        }
      }
      s = -1;
    }
  }

  return mergeAdjacentEvents(joinNearbyEvents(mergeEvents(events), frameSec), frameSec);
}

/**
 * Global post-pass: merge any events separated by <= 3 frames. FFT spectral
 * leakage can split one vocalisation into a faint lead-in event plus the real
 * event; the gap between them is only a frame or two. Runs after refinement,
 * so the merged extent is bounded by the stronger event's envelope.
 */
export function mergeAdjacentEvents(events: RawEvent[], frameSec: number): RawEvent[] {
  if (events.length <= 1) return events;
  const sorted = [...events].sort((a, b) => a.startFrame - b.startFrame);
  const out: RawEvent[] = [];
  const maxGap = Math.max(2, Math.round(0.05 / frameSec));
  for (const ev of sorted) {
    const last = out[out.length - 1];
    if (last && ev.startFrame - last.endFrame <= maxGap) {
      last.endFrame = Math.max(last.endFrame, ev.endFrame);
      last.endSec = Math.max(last.endSec, ev.endSec);
      last.lowHz = Math.min(last.lowHz, ev.lowHz);
      last.highHz = Math.max(last.highHz, ev.highHz);
      last.score = Math.max(last.score, ev.score);
      last.activeFrames += ev.activeFrames;
      last.confidence = rank(last.confidence) >= rank(ev.confidence) ? last.confidence : ev.confidence;
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

/**
 * Merge events separated by short silences when both sides are themselves
 * short: trills and closely spaced syllables of one vocalisation otherwise
 * fragment into a leading event plus a "missed" trailing one.
 */
export function joinNearbyEvents(events: RawEvent[], frameSec: number): RawEvent[] {
  if (events.length <= 1) return events;
  const sorted = [...events].sort((a, b) => a.startFrame - b.startFrame);
  const maxGapFrames = Math.round(0.4 / frameSec);
  const out: RawEvent[] = [];
  for (const ev of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...ev });
      continue;
    }
    const gap = ev.startFrame - last.endFrame;
    const bothShort =
      (last.endFrame - last.startFrame) * frameSec < 0.6 &&
      (ev.endFrame - ev.startFrame) * frameSec < 0.6;
    if (gap <= maxGapFrames && bothShort) {
      last.endFrame = ev.endFrame;
      last.endSec = ev.endSec;
      last.lowHz = Math.min(last.lowHz, ev.lowHz);
      last.highHz = Math.max(last.highHz, ev.highHz);
      last.score = Math.max(last.score, ev.score);
      last.activeFrames += ev.activeFrames;
      last.confidence = rank(last.confidence) >= rank(ev.confidence) ? last.confidence : ev.confidence;
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

/**
 * Snap event boundaries to the real energy envelope. Segmentation includes
 * spectrally-smeared FFT frames whose windows only clip the call's edges;
 * those frames sit well below the event peak. Requiring a fraction of peak
 * band energy removes the lead-in/tail without touching the true extent.
 */
function refineOnsetOffset(
  ev: RawEvent,
  stats: FrameStats,
  active: Uint8Array,
  frameSec: number,
): void {
  const s = ev.startFrame;
  const e = ev.endFrame;
  let peak = -Infinity;
  let peakFlux = 0;
  for (let k = s; k < e; k++) {
    peak = Math.max(peak, stats.midDb[k], stats.highDb[k]);
    peakFlux = Math.max(peakFlux, stats.flux[k]);
  }
  const onsetThreshold = peak - 12; // dB below peak counts as part of the event
  // Spectral leakage into FFT windows just outside the real call has energy
  // but almost no spectral flux. Require a fraction of the event's peak flux
  // so leakage-only lead-in frames cannot define the onset.
  const fluxThreshold = peakFlux * 0.15;

  let first = s;
  while (
    first < e - 1 &&
    (Math.max(stats.midDb[first], stats.highDb[first]) < onsetThreshold ||
      stats.flux[first] < fluxThreshold)
  ) {
    first++;
  }
  let last = e - 1;
  while (
    last > first &&
    (Math.max(stats.midDb[last], stats.highDb[last]) < onsetThreshold ||
      stats.flux[last] < fluxThreshold)
  ) {
    last--;
  }
  ev.startFrame = first;
  ev.endFrame = last + 1;
  ev.startSec = stats.times[first];
  ev.endSec = stats.times[Math.min(stats.times.length - 1, last)] + frameSec;
  ev.activeFrames = 0;
  for (let k = first; k <= last; k++) ev.activeFrames += active[k];
}

function buildEvent(
  s: number,
  e: number,
  stats: FrameStats,
  frameSec: number,
  active: Uint8Array,
  score: number,
  sampleRate: number,
): RawEvent {
  // Frequency bounds from centroid spread over active frames, padded generously.
  let meanC = 0;
  let cnt = 0;
  for (let k = s; k < e; k++) if (active[k]) { meanC += stats.centroid[k]; cnt++; }
  meanC /= Math.max(1, cnt);
  let varC = 0;
  for (let k = s; k < e; k++) if (active[k]) varC += (stats.centroid[k] - meanC) ** 2;
  const sdC = Math.sqrt(varC / Math.max(1, cnt));
  const nyquist = sampleRate / 2;
  let lowHz = clamp(meanC - 1.5 * sdC - 300, 120, nyquist - 100);
  let highHz = clamp(meanC + 1.5 * sdC + 300, lowHz + 200, nyquist);
  if (highHz - lowHz < 400) {
    const mid = (highHz + lowHz) / 2;
    lowHz = clamp(mid - 250, 100, nyquist - 200);
    highHz = clamp(mid + 250, lowHz + 100, nyquist);
  }
  return {
    startFrame: s,
    endFrame: e,
    // Pad one frame left: the first active frame's window already contains the
    // onset, and its start timestamp sits up to one hop before the active flag.
    startSec: stats.times[Math.max(0, s - 1)],
    endSec: stats.times[Math.min(stats.times.length - 1, e - 1)] + frameSec,
    lowHz: Math.round(lowHz / 10) * 10,
    highHz: Math.round(highHz / 10) * 10,
    score,
    confidence: score >= 12 ? 'high' : score >= 8 ? 'medium' : 'low',
    activeFrames: cnt,
  };
}

function mergeEvents(events: RawEvent[]): RawEvent[] {
  if (events.length <= 1) return events;
  const sorted = [...events].sort((a, b) => a.startFrame - b.startFrame);
  const out: RawEvent[] = [];
  for (const ev of sorted) {
    const last = out[out.length - 1];
    if (last && ev.startFrame <= last.endFrame + 2) {
      last.endFrame = Math.max(last.endFrame, ev.endFrame);
      last.endSec = Math.max(last.endSec, ev.endSec);
      last.lowHz = Math.min(last.lowHz, ev.lowHz);
      last.highHz = Math.max(last.highHz, ev.highHz);
      last.score = Math.max(last.score, ev.score);
      last.activeFrames += ev.activeFrames;
      last.confidence = rank(last.confidence) >= rank(ev.confidence) ? last.confidence : ev.confidence;
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

function rank(c: Confidence): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface WeatherResult {
  wind: Array<{ startSec: number; endSec: number; severity: number }>;
  rain: Array<{ startSec: number; endSec: number; severity: number }>;
}

/** Convert smoothed masks into minimum-length segments with mean severity. */
export function segmentsFromMask(
  mask: Uint8Array,
  stats: FrameStats,
  severity: Float32Array,
  settings: DetectionSettings,
): Array<{ startSec: number; endSec: number; severity: number }> {
  const n = mask.length;
  if (n < 2) return [];
  const frameSec = stats.times[1] - stats.times[0];
  const out: Array<{ startSec: number; endSec: number; severity: number }> = [];
  let s = -1;
  for (let f = 0; f <= n; f++) {
    const on = f < n && mask[f] === 1;
    if (on && s < 0) s = f;
    if (!on && s >= 0) {
      const e = f;
      if ((e - s) * frameSec >= settings.weatherMinSec) {
        let sev = 0;
        for (let k = s; k < e; k++) sev += severity[k];
        out.push({
          startSec: stats.times[s],
          endSec: stats.times[Math.min(n - 1, e - 1)] + frameSec,
          severity: Math.round((sev / (e - s)) * 100) / 100,
        });
      }
      s = -1;
    }
  }
  return out;
}

export function detectWeather(
  stats: FrameStats,
  settings: DetectionSettings,
  mask?: WeatherMask,
): WeatherResult {
  const m = mask ?? computeWeatherMask(stats, settings);
  const floor = {
    low: percentile(stats.lowDb, 0.2),
    mid: percentile(stats.midDb, 0.2),
  };
  const windSev = new Float32Array(stats.times.length);
  const rainSev = new Float32Array(stats.times.length);
  for (let i = 0; i < stats.times.length; i++) {
    windSev[i] = clamp((stats.lowDb[i] - floor.low - settings.windDbOverFloor) / 12 + 0.3, 0, 1);
    rainSev[i] = clamp((stats.midDb[i] - floor.mid - settings.rainDbOverFloor) / 12 + 0.3, 0, 1);
  }
  return {
    wind: segmentsFromMask(m.wind, stats, windSev, settings),
    rain: segmentsFromMask(m.rain, stats, rainSev, settings),
  };
}
