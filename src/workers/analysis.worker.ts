// Background analysis pipeline. Runs entirely off the main thread:
//   blob -> streaming decode -> per-chunk STFT/tile + frame stats -> IDB
//   -> merged stats -> event detection + weather labelling -> IDB
//
// Progress is posted per chunk; the full PCM stream is never held in memory.

import {
  CHUNK_SEC,
  ChunkInfo,
  DEFAULT_DETECTION_SETTINGS,
  Detection,
  DetectionSettings,
  FrameStats,
  Recording,
  STFT,
  WeatherSegment,
} from '../types';
import { analyzeChunk, ChunkAnalysis } from '../dsp/analyze';
import {
  computeWeatherMask,
  detectEvents,
  detectWeather,
} from '../dsp/detect';
import {
  createFlacStreamer,
  createWavStreamer,
  FlacAnchor,
  Streamer,
} from '../audio/stream-decoder';
import { readWavHeader, WavHeader } from '../audio/wav';
import { readFlacMeta, FlacMeta } from '../audio/flac';
import {
  getChunks,
  getAllStats,
  putChunks,
  putDetections,
  putStats,
  putTile,
  putWeather,
} from '../db';

export interface AnalyzeRequest {
  type: 'analyze';
  recording: Recording;
  /** Stored file blob, transferred (or structured-cloned) into the worker. */
  blob: Blob;
  settings?: DetectionSettings;
  /** Reuse existing chunks/tiles and only re-run detection. */
  detectOnly?: boolean;
}

export type AnalyzeProgress =
  | { kind: 'status'; message: string }
  | { kind: 'chunk'; index: number; total: number }
  | { kind: 'detecting' }
  | { kind: 'done'; detectionCount: number; weatherCount: number; durationSec: number }
  | { kind: 'error'; message: string };

const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);

async function makeBlobReader(blob: Blob) {
  return async (offset: number, length: number): Promise<Uint8Array> => {
    const slice = blob.slice(offset, offset + length);
    const ab = await slice.arrayBuffer();
    return new Uint8Array(ab);
  };
}

async function runAnalysis(req: AnalyzeRequest, post: (p: AnalyzeProgress) => void): Promise<void> {
  const { recording, blob } = req;
  const settings = req.settings ?? DEFAULT_DETECTION_SETTINGS;
  const read = await makeBlobReader(blob);

  let streamer: Streamer;
  let wavHeader: WavHeader | null = null;
  let flacMeta: FlacMeta | null = null;

  post({ kind: 'status', message: '读取文件头…' });
  if (recording.format === 'wav') {
    wavHeader = await readWavHeader(read, blob.size);
    streamer = createWavStreamer(read, wavHeader, CHUNK_SEC);
  } else {
    flacMeta = await readFlacMeta(read, blob.size);
    streamer = await createFlacStreamer(read, flacMeta, blob.size, CHUNK_SEC);
  }

  const totalChunks = Math.ceil(streamer.handle.durationSec / CHUNK_SEC);
  const chunkInfos: ChunkInfo[] = [];
  const sr = streamer.handle.sampleRate;

  let chunkIndex = 0;
  while (true) {
    const chunk = await streamer.nextChunk();
    if (!chunk) break;
    post({ kind: 'status', message: `分析第 ${chunkIndex + 1}/${totalChunks} 块…` });

    const analysis: ChunkAnalysis = analyzeChunk(
      chunk.mono,
      sr,
      chunk.startSample,
      STFT.fftSize,
      STFT.hopSize,
    );

    const startSec = chunk.startSample / sr;
    const endSec = Math.min(
      streamer.handle.durationSec,
      (chunk.startSample + chunk.mono.length) / sr,
    );
    chunkInfos.push({
      recordingId: recording.id,
      index: chunk.index,
      startSec,
      endSec,
      frameCount: analysis.frameCount,
      byteOffset: recording.format === 'wav' && wavHeader
        ? wavHeader.dataOffset + chunk.startSample * wavHeader.blockAlign
        : streamer.anchors[chunk.index]?.byteOffset ?? 0,
    });

    // Tiles (each in its own IDB record so rendering can page them lazily).
    for (let t = 0; t < analysis.tiles.length; t++) {
      await putTile({
        key: `${recording.id}:${chunk.index}:${t}`,
        recordingId: recording.id,
        chunkIndex: chunk.index,
        tileIndex: t,
        frameCount: analysis.tileFrameCounts[t],
        data: analysis.tiles[t],
      });
    }

    await putStats({
      key: `${recording.id}:${chunk.index}`,
      recordingId: recording.id,
      chunkIndex: chunk.index,
      rmsDb: analysis.rmsDb,
      flux: analysis.flux,
      centroid: analysis.centroid,
      lowDb: analysis.lowDb,
      midDb: analysis.midDb,
      highDb: analysis.highDb,
      times: analysis.times,
    });

    chunkIndex++;
    post({ kind: 'chunk', index: chunkIndex, total: totalChunks });
  }
  streamer.dispose?.();

  await putChunks(recording.id, chunkInfos, streamer.anchors);

  post({ kind: 'detecting' });
  await runDetection(recording, settings, post);
}

/** Concatenate per-chunk stats and run event + weather detection. */
async function runDetection(
  recording: Recording,
  settings: DetectionSettings,
  post: (p: AnalyzeProgress) => void,
): Promise<void> {
  const statRecords = await getAllStatsSorted(recording.id);
  if (!statRecords.length) {
    post({ kind: 'done', detectionCount: 0, weatherCount: 0, durationSec: recording.durationSec });
    return;
  }
  // Chunk overlap duplicates frames at borders; dedup on rounded timestamps.
  const seenTime = new Set<number>();
  const filtered = statRecords.map((r) => {
    const keep: number[] = [];
    for (let f = 0; f < r.times.length; f++) {
      const key = Math.round(r.times[f] * 100000);
      if (seenTime.has(key)) continue;
      seenTime.add(key);
      keep.push(f);
    }
    return { r, keep };
  });
  const totalFrames = filtered.reduce((n, x) => n + x.keep.length, 0);
  const stats: FrameStats = {
    rmsDb: new Float32Array(totalFrames),
    flux: new Float32Array(totalFrames),
    centroid: new Float32Array(totalFrames),
    lowDb: new Float32Array(totalFrames),
    midDb: new Float32Array(totalFrames),
    highDb: new Float32Array(totalFrames),
    times: new Float32Array(totalFrames),
  };
  let off = 0;
  for (const { r, keep } of filtered) {
    for (const f of keep) {
      stats.rmsDb[off] = r.rmsDb[f];
      stats.flux[off] = r.flux[f];
      stats.centroid[off] = r.centroid[f];
      stats.lowDb[off] = r.lowDb[f];
      stats.midDb[off] = r.midDb[f];
      stats.highDb[off] = r.highDb[f];
      stats.times[off] = r.times[f];
      off++;
    }
  }

  const weatherMask = computeWeatherMask(stats, settings);
  const rawEvents = detectEvents(stats, recording.sampleRate, settings, weatherMask);
  const now = Date.now();
  const detections: Detection[] = rawEvents.map((e) => ({
    id: uid(),
    recordingId: recording.id,
    startSec: e.startSec,
    endSec: e.endSec,
    lowHz: e.lowHz,
    highHz: e.highHz,
    score: Math.round(e.score * 100) / 100,
    confidence: e.confidence,
    source: 'auto',
    createdAt: now,
  }));
  await putDetections(detections);

  const weather = detectWeather(stats, settings, weatherMask);
  const segments: WeatherSegment[] = [
    ...weather.wind.map((w) => ({
      id: uid(), recordingId: recording.id, kind: 'wind' as const,
      startSec: w.startSec, endSec: w.endSec, severity: w.severity,
      source: 'auto' as const, createdAt: now,
    })),
    ...weather.rain.map((w) => ({
      id: uid(), recordingId: recording.id, kind: 'rain' as const,
      startSec: w.startSec, endSec: w.endSec, severity: w.severity,
      source: 'auto' as const, createdAt: now,
    })),
  ];
  await putWeather(segments);

  post({
    kind: 'done',
    detectionCount: detections.length,
    weatherCount: segments.length,
    durationSec: recording.durationSec,
  });
}

async function getAllStatsSorted(recordingId: string) {
  return getAllStats(recordingId);
}

export async function getFlacAnchors(recordingId: string): Promise<FlacAnchor[]> {
  const rec = await getChunks(recordingId);
  return rec?.flacAnchors ?? [];
}

const ctx = self as unknown as {
  postMessage: (m: AnalyzeProgress) => void;
  onmessage: ((ev: MessageEvent<AnalyzeRequest>) => void) | null;
};

ctx.onmessage = async (ev: MessageEvent<AnalyzeRequest>) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  try {
    if (req.detectOnly) {
      const settings = req.settings ?? DEFAULT_DETECTION_SETTINGS;
      ctx.postMessage({ kind: 'detecting' });
      await runDetection(req.recording, settings, (p) => ctx.postMessage(p));
    } else {
      await runAnalysis(req, (p) => ctx.postMessage(p));
    }
  } catch (err) {
    ctx.postMessage({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
