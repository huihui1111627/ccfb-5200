import { AudioFormat, GroundTruth, Recording, RecordingMeta } from '../types';
import { readWavHeader } from '../audio/wav';
import { readFlacMeta } from '../audio/flac';
import { mergeMeta, normalizeVorbisComments, parseFileName } from '../audio/meta';
import { putRecording, storeFileBlob } from '../db';
import { uid } from '../util';
import { CHUNK_SEC } from '../types';

export interface ImportPreview {
  fileName: string;
  size: number;
  format: AudioFormat;
  sampleRate: number;
  channels: number;
  durationSec: number;
  meta: RecordingMeta;
}

const blobReader = (blob: Blob) => async (offset: number, length: number) =>
  new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

export async function previewFile(file: File): Promise<ImportPreview> {
  const lower = file.name.toLowerCase();
  const read = blobReader(file);
  const fromName = parseFileName(file.name);

  if (lower.endsWith('.wav')) {
    const header = await readWavHeader(read, file.size);
    const meta = mergeMeta(fromName, header.tags);
    return {
      fileName: file.name,
      size: file.size,
      format: 'wav',
      sampleRate: header.sampleRate,
      channels: header.channels,
      durationSec: header.durationSec,
      meta,
    };
  }
  if (lower.endsWith('.flac')) {
    const flac = await readFlacMeta(read, file.size);
    const vorbis: Record<string, string> = {};
    for (const [k, v] of Object.entries(flac.tags)) {
      if (k.startsWith('vorbis:')) vorbis[k.slice(7)] = v;
    }
    const embedded = normalizeVorbisComments(Object.entries(vorbis));
    const meta = mergeMeta(fromName, embedded);
    return {
      fileName: file.name,
      size: file.size,
      format: 'flac',
      sampleRate: flac.sampleRate,
      channels: flac.channels,
      durationSec: flac.durationSec,
      meta,
    };
  }
  throw new Error(`不支持的文件类型：${file.name}（仅支持 .wav / .flac）`);
}

export async function importRecording(
  projectId: string,
  file: File,
  preview: ImportPreview,
  groundTruth?: GroundTruth,
): Promise<Recording> {
  const id = uid();
  const recording: Recording = {
    id,
    projectId,
    fileName: preview.fileName,
    format: preview.format,
    size: preview.size,
    sampleRate: preview.sampleRate,
    channels: preview.channels,
    durationSec: preview.durationSec,
    meta: preview.meta,
    importedAt: Date.now(),
    status: 'imported',
    chunkSec: CHUNK_SEC,
    chunkCount: Math.ceil(preview.durationSec / CHUNK_SEC),
    groundTruth,
  };
  await storeFileBlob(id, file);
  await putRecording(recording);
  return recording;
}

/** Read a .groundtruth.json sidecar dropped next to a synthetic wav. */
export async function readGroundTruth(file: File): Promise<GroundTruth> {
  const text = await file.text();
  const parsed = JSON.parse(text) as GroundTruth;
  if (!Array.isArray(parsed.calls)) throw new Error('ground truth 文件缺少 calls 数组');
  return parsed;
}
