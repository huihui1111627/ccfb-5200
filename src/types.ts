// Shared domain types — used by main thread, workers and Node scripts alike.

export type AudioFormat = 'wav' | 'flac';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  notes?: string;
}

export interface RecordingMeta {
  /** Recorder-embedded or filename-parsed recording start time (ms epoch), if known. */
  recordedAt?: number;
  /** Site / point id parsed from metadata or filename. */
  site?: string;
  /** Recorder serial parsed from metadata or filename. */
  recorder?: string;
  /** Free-form key/value pairs harvested from LIST / vorbis-comment metadata. */
  tags: Record<string, string>;
  /** Where each field came from: 'metadata' | 'filename' | 'manual'. */
  tagSources: Record<string, 'metadata' | 'filename' | 'manual'>;
}

export interface Recording {
  id: string;
  projectId: string;
  fileName: string;
  format: AudioFormat;
  /** Original file size in bytes. The File blob itself lives in the 'blobs' store. */
  size: number;
  sampleRate: number;
  channels: number;
  durationSec: number;
  meta: RecordingMeta;
  importedAt: number;
  /** Analysis state machine. */
  status: 'imported' | 'analyzing' | 'analyzed' | 'error';
  analyzeError?: string;
  /** Chunk timing parameters used during analysis. */
  chunkSec: number;
  chunkCount: number;
  /** Ground truth for synthetic test files (JSON sidecar / embedded filename marker). */
  groundTruth?: GroundTruth;
}

export interface ChunkInfo {
  recordingId: string;
  index: number;
  startSec: number;
  endSec: number;
  frameCount: number;
  /** FLAC: byte offset of the decoder position at chunk start (WAV: PCM byte offset). */
  byteOffset: number;
}

/** Per-frame statistics produced during spectrogram analysis. */
export interface FrameStats {
  /** Overall band-limited energy (dBFS-ish, negative numbers). */
  rmsDb: Float32Array;
  /** Spectral flux (0..~2). */
  flux: Float32Array;
  /** Spectral centroid in Hz. */
  centroid: Float32Array;
  /** Low-band (<1 kHz) mean energy dB. */
  lowDb: Float32Array;
  /** Mid-band (1–6 kHz) mean energy dB. */
  midDb: Float32Array;
  /** High-band (>6 kHz) mean energy dB. */
  highDb: Float32Array;
  /** Frame centre timestamps in seconds (relative to recording start). */
  times: Float32Array;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Detection {
  id: string;
  recordingId: string;
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
  score: number;
  confidence: Confidence;
  source: 'auto' | 'manual';
  /** Was this detection merged into a manual annotation? */
  annotationId?: string;
  createdAt: number;
}

export interface Annotation {
  id: string;
  recordingId: string;
  projectId: string;
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
  species: string;
  /** 'call' | 'song' | 'alarm' | 'unknown' | custom. */
  vocalizationType: string;
  notes?: string;
  /** Associated auto detection id when the annotation was created from one. */
  detectionId?: string;
  createdAt: number;
  updatedAt: number;
}

export type WeatherKind = 'wind' | 'rain';

export interface WeatherSegment {
  id: string;
  recordingId: string;
  kind: WeatherKind;
  startSec: number;
  endSec: number;
  severity: number; // 0..1
  source: 'auto' | 'manual';
  createdAt: number;
}

/** Known call positions embedded in synthetic test recordings. */
export interface GroundTruthCall {
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
  species: string;
}

export interface GroundTruth {
  generatedAt: number;
  sampleRate: number;
  durationSec: number;
  seed: number;
  calls: GroundTruthCall[];
  wind: Array<{ startSec: number; endSec: number }>;
  rain: Array<{ startSec: number; endSec: number }>;
}

export interface DetectionSettings {
  /** Frames must exceed local noise floor by this many dB. */
  snrDb: number;
  /** Min event duration after closure (s). */
  minEventSec: number;
  /** Max gap bridged by morphological closure (s). */
  maxGapSec: number;
  /** Active-frame ratio inside an event below which it is rejected. */
  minDutyCycle: number;
  /** Minimum spectral flux percentile gate (0..1). */
  fluxGate: number;
  windDbOverFloor: number;
  rainDbOverFloor: number;
  weatherMinSec: number;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  snrDb: 6,
  minEventSec: 0.08,
  maxGapSec: 0.25,
  minDutyCycle: 0.12,
  fluxGate: 0.85,
  windDbOverFloor: 8,
  rainDbOverFloor: 12,
  weatherMinSec: 4,
};

/** STFT parameters shared by analysis, rendering and docs. */
export const STFT = {
  fftSize: 1024,
  hopSize: 512,
  window: 'hann' as const,
};

export const CHUNK_SEC = 32;
export const TILE_SEC = 16;
export const TILE_BIN_COUNT = 256;
export const TILE_FRAME_COUNT = 256;
