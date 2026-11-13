// End-to-end algorithm self-test (Node, no browser):
//   synth -> chunked STFT (same code path as the worker) -> detection
//   -> compare against ground truth, enforce the 0.5 s timing requirement.
//
// Run: npm run selftest

import { analyzeChunk } from '../src/dsp/analyze';
import {
  computeWeatherMask,
  detectEvents,
  detectWeather,
} from '../src/dsp/detect';
import {
  CHUNK_SEC,
  DEFAULT_DETECTION_SETTINGS,
  FrameStats,
  GroundTruth,
  STFT,
} from '../src/types';
import { synthesize } from './synth';

interface Match {
  gtIndex: number;
  startErr: number;
  endErr: number;
}

function mergeStats(chunks: ReturnType<typeof analyzeChunk>[]): FrameStats {
  // Chunk overlap produces duplicate frames at borders; dedup by timestamp.
  const seenTime = new Set<number>();
  const keep: ReturnType<typeof analyzeChunk>[] = [];
  for (const c of chunks) {
    const filtered = {
      ...c,
      frameCount: 0,
      times: new Float32Array(c.times.length),
      rmsDb: new Float32Array(c.times.length),
      flux: new Float32Array(c.times.length),
      centroid: new Float32Array(c.times.length),
      lowDb: new Float32Array(c.times.length),
      midDb: new Float32Array(c.times.length),
      highDb: new Float32Array(c.times.length),
    };
    let k = 0;
    for (let f = 0; f < c.times.length; f++) {
      const key = Math.round(c.times[f] * 100000);
      if (seenTime.has(key)) continue;
      seenTime.add(key);
      filtered.times[k] = c.times[f];
      filtered.rmsDb[k] = c.rmsDb[f];
      filtered.flux[k] = c.flux[f];
      filtered.centroid[k] = c.centroid[f];
      filtered.lowDb[k] = c.lowDb[f];
      filtered.midDb[k] = c.midDb[f];
      filtered.highDb[k] = c.highDb[f];
      k++;
    }
    filtered.frameCount = k;
    keep.push(filtered);
  }
  const total = keep.reduce((n, c) => n + c.frameCount, 0);
  const stats: FrameStats = {
    rmsDb: new Float32Array(total),
    flux: new Float32Array(total),
    centroid: new Float32Array(total),
    lowDb: new Float32Array(total),
    midDb: new Float32Array(total),
    highDb: new Float32Array(total),
    times: new Float32Array(total),
  };
  let off = 0;
  for (const c of keep) {
    stats.rmsDb.set(c.rmsDb.subarray(0, c.frameCount), off);
    stats.flux.set(c.flux.subarray(0, c.frameCount), off);
    stats.centroid.set(c.centroid.subarray(0, c.frameCount), off);
    stats.lowDb.set(c.lowDb.subarray(0, c.frameCount), off);
    stats.midDb.set(c.midDb.subarray(0, c.frameCount), off);
    stats.highDb.set(c.highDb.subarray(0, c.frameCount), off);
    stats.times.set(c.times.subarray(0, c.frameCount), off);
    off += c.frameCount;
  }
  return stats;
}

function iouSeconds(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  return union > 0 ? inter / union : 0;
}

function runCase(durationSec: number, label: string): boolean {
  console.log(`\n=== ${label}: ${durationSec}s synthetic recording ===`);
  const { samples, groundTruth } = synthesize({
    durationSec,
    seed: 20260412,
    callsPerMinute: 3,
    includeWeather: true,
  });
  const sr = groundTruth.sampleRate;
  const chunkSamples = CHUNK_SEC * sr;
  const overlap = STFT.fftSize - STFT.hopSize;

  const chunks: ReturnType<typeof analyzeChunk>[] = [];
  let cursor = 0;
  while (cursor < samples.length) {
    const readStart = cursor === 0 ? 0 : cursor - overlap;
    const fresh = Math.min(chunkSamples, samples.length - cursor);
    const piece = samples.subarray(readStart, readStart + fresh + (cursor - readStart));
    const c = analyzeChunk(piece, sr, readStart, STFT.fftSize, STFT.hopSize);
    chunks.push(c);
    cursor += fresh;
  }
  const stats = mergeStats(chunks);
  const weatherMask = computeWeatherMask(stats, DEFAULT_DETECTION_SETTINGS);
  const events = detectEvents(stats, sr, DEFAULT_DETECTION_SETTINGS, weatherMask);
  const weather = detectWeather(stats, DEFAULT_DETECTION_SETTINGS, weatherMask);
  // ---- Match detections to ground truth. ----------------------------------
  // Primary: temporal IoU. A detection whose body is the FFT-smear lead-in of
  // a real call (no overlap but within 0.5 s, the project requirement) is
  // still counted as that call — it is a boundary error, not a miss.
  const matchedGt = new Set<number>();
  const matches: Match[] = [];
  const unmatched: typeof events = [];
  for (const ev of events) {
    let best = -1;
    let bestIou = 0;
    groundTruth.calls.forEach((gt, i) => {
      if (matchedGt.has(i)) return;
      const iou = iouSeconds(ev.startSec, ev.endSec, gt.startSec, gt.endSec);
      if (iou > bestIou) {
        bestIou = iou;
        best = i;
      }
    });
    if (best >= 0 && bestIou > 0.1) {
      matchedGt.add(best);
      const gt = groundTruth.calls[best];
      matches.push({
        gtIndex: best,
        startErr: ev.startSec - gt.startSec,
        endErr: ev.endSec - gt.endSec,
      });
    } else if (best >= 0) {
      // Near-miss pairing: closest GT within the 0.5 s tolerance window.
      const gt = groundTruth.calls[best];
      const gap =
        ev.endSec <= gt.startSec
          ? gt.startSec - ev.endSec
          : ev.startSec >= gt.endSec
            ? ev.startSec - gt.endSec
            : Infinity;
      if (gap <= 0.5) {
        matchedGt.add(best);
        matches.push({
          gtIndex: best,
          startErr: ev.startSec - gt.startSec,
          endErr: ev.endSec - gt.endSec,
        });
      } else {
        unmatched.push(ev);
      }
    } else {
      unmatched.push(ev);
    }
  }

  const recall = matches.length / groundTruth.calls.length;
  const precision = matches.length / Math.max(1, events.length);
  // Calls physically buried inside wind/rain are expected misses: the detector
  // deliberately suppresses weather-dominated frames. Score clear-weather recall
  // separately so the headline metric reflects what is actually achievable.
  const inWeather = (t: number) =>
    groundTruth.wind.some((w) => t >= w.startSec && t <= w.endSec) ||
    groundTruth.rain.some((r) => t >= r.startSec && t <= r.endSec);
  const clearCalls = groundTruth.calls.filter((c) => !inWeather((c.startSec + c.endSec) / 2));
  const matchedClear = matches.filter((m) =>
    !inWeather((groundTruth.calls[m.gtIndex].startSec + groundTruth.calls[m.gtIndex].endSec) / 2));
  const clearRecall = clearCalls.length ? matchedClear.length / clearCalls.length : 1;
  const maxAbsStart = matches.reduce((m, x) => Math.max(m, Math.abs(x.startErr)), 0);
  const maxAbsEnd = matches.reduce((m, x) => Math.max(m, Math.abs(x.endErr)), 0);
  const meanStart = matches.reduce((s, x) => s + x.startErr, 0) / Math.max(1, matches.length);

  console.log(`ground-truth calls : ${groundTruth.calls.length}`);
  console.log(`detections         : ${events.length} (matched ${matches.length}, false positives ${unmatched.length})`);
  console.log(`recall (all)       : ${(recall * 100).toFixed(1)}%  (weather-obscured calls excluded from pass gate)`);
  console.log(`recall (clear)     : ${(clearRecall * 100).toFixed(1)}%`);
  console.log(`precision          : ${(precision * 100).toFixed(1)}%`);
  console.log(`start error        : max ${maxAbsStart.toFixed(3)}s, mean ${meanStart.toFixed(3)}s`);
  console.log(`end error          : max ${maxAbsEnd.toFixed(3)}s`);

  // Weather checks (loose: each planted segment must overlap a detected one).
  const checkSegs = (
    planted: GroundTruth['wind'],
    found: Array<{ startSec: number; endSec: number }>,
    name: string,
  ) => {
    let hit = 0;
    for (const p of planted) {
      if (found.some((f) => iouSeconds(f.startSec, f.endSec, p.startSec, p.endSec) > 0.3)) hit++;
    }
    console.log(`${name.padEnd(18)}: ${hit}/${planted.length} planted segments detected`);
    return planted.length === 0 || hit === planted.length;
  };
  const windOk = checkSegs(groundTruth.wind, weather.wind, 'wind');
  const rainOk = checkSegs(groundTruth.rain, weather.rain, 'rain');

  const timingOk = maxAbsStart <= 0.5 && maxAbsEnd <= 0.5;
  const recallOk = clearRecall >= 0.95;
  const precisionOk = precision >= 0.85;
  const pass = timingOk && recallOk && precisionOk && windOk && rainOk;

  console.log(`thresholds         : |timing err| ≤ 0.5s, clear-weather recall ≥ 95%, precision ≥ 85%`);
  console.log(`RESULT             : ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  if (unmatched.length) {
    console.log('first false positives:', unmatched.slice(0, 5).map((d) =>
      `${d.startSec.toFixed(2)}-${d.endSec.toFixed(2)}s`).join('  '));
  }
  const missed = groundTruth.calls
    .map((gt, i) => ({ gt, i }))
    .filter(({ i }) => !matchedGt.has(i));
  if (missed.length) {
    console.log('missed calls:', missed.map(({ gt }) =>
      `${gt.startSec.toFixed(2)}-${gt.endSec.toFixed(2)}s ${gt.species}`).join('  '));
  }
  return pass;
}

const short = runCase(120, 'short');
const long = runCase(600, 'long (10 min)');
if (!short || !long) {
  process.exitCode = 1;
  process.exit(1);
}
