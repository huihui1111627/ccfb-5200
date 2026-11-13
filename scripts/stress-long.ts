// Long-recording stress: 1 hour synthetic, many chunk borders, verify the
// 0.5 s timing requirement holds throughout (not just on short clips).
import { analyzeChunk } from '../src/dsp/analyze';
import { computeWeatherMask, detectEvents, detectWeather } from '../src/dsp/detect';
import { CHUNK_SEC, DEFAULT_DETECTION_SETTINGS, FrameStats, STFT } from '../src/types';
import { synthesize } from './synth';

const DURATION = 3600;
const { samples, groundTruth } = synthesize({
  durationSec: DURATION, seed: 20260412, callsPerMinute: 3, includeWeather: true,
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
  chunks.push(analyzeChunk(piece, sr, readStart, STFT.fftSize, STFT.hopSize));
  cursor += fresh;
}
const seen = new Set<number>();
const per = chunks.map((c) => {
  const k: number[] = [];
  for (let f = 0; f < c.times.length; f++) {
    const key = Math.round(c.times[f] * 1e5);
    if (!seen.has(key)) { seen.add(key); k.push(f); }
  }
  return { c, k };
});
const total = per.reduce((n, x) => n + x.k.length, 0);
const stats: FrameStats = {
  rmsDb: new Float32Array(total), flux: new Float32Array(total), centroid: new Float32Array(total),
  lowDb: new Float32Array(total), midDb: new Float32Array(total), highDb: new Float32Array(total),
  times: new Float32Array(total),
};
let off = 0;
for (const { c, k } of per) for (const f of k) {
  stats.rmsDb[off] = c.rmsDb[f]; stats.flux[off] = c.flux[f]; stats.centroid[off] = c.centroid[f];
  stats.lowDb[off] = c.lowDb[f]; stats.midDb[off] = c.midDb[f]; stats.highDb[off] = c.highDb[f];
  stats.times[off] = c.times[f]; off++;
}
const mask = computeWeatherMask(stats, DEFAULT_DETECTION_SETTINGS);
const events = detectEvents(stats, sr, DEFAULT_DETECTION_SETTINGS, mask);
const weather = detectWeather(stats, DEFAULT_DETECTION_SETTINGS, mask);

let matched = 0; let maxStart = 0; let maxEnd = 0;
const inWeather = (t: number) =>
  groundTruth.wind.some((w) => t >= w.startSec && t <= w.endSec) ||
  groundTruth.rain.some((r) => t >= r.startSec && t <= r.endSec);
let clearTotal = 0; let clearMatched = 0;
for (const gt of groundTruth.calls) {
  const hit = events.find((d) => d.endSec >= gt.startSec && d.startSec <= gt.endSec);
  const mid = (gt.startSec + gt.endSec) / 2;
  if (!inWeather(mid)) clearTotal++;
  if (hit) {
    matched++;
    if (!inWeather(mid)) clearMatched++;
    maxStart = Math.max(maxStart, Math.abs(hit.startSec - gt.startSec));
    maxEnd = Math.max(maxEnd, Math.abs(hit.endSec - gt.endSec));
  }
}
console.log(`1h recording: ${groundTruth.calls.length} GT calls, ${events.length} detections`);
console.log(`all recall ${(matched / groundTruth.calls.length * 100).toFixed(1)}%, clear recall ${(clearMatched / clearTotal * 100).toFixed(1)}%`);
console.log(`max start err ${maxStart.toFixed(3)}s, max end err ${maxEnd.toFixed(3)}s`);
console.log(`weather: wind ${weather.wind.length}/${groundTruth.wind.length} rain ${weather.rain.length}/${groundTruth.rain.length}`);
const pass = maxStart <= 0.5 && maxEnd <= 0.5 && clearMatched / clearTotal >= 0.95;
console.log(pass ? 'LONG STRESS PASS ✅' : 'LONG STRESS FAIL ❌');
process.exit(pass ? 0 : 1);
