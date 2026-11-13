import { openDB, IDBPDatabase } from 'idb';
import {
  Annotation,
  ChunkInfo,
  Detection,
  Project,
  Recording,
  WeatherSegment,
} from './types';

const DB_NAME = 'bird-song-screener';
const DB_VERSION = 1;

export const STORES = {
  projects: 'projects',
  recordings: 'recordings',
  blobs: 'blobs',
  chunks: 'chunks',
  tiles: 'tiles',
  stats: 'frameStats',
  detections: 'detections',
  annotations: 'annotations',
  weather: 'weather',
} as const;

import type { FlacAnchor } from './audio/stream-decoder';

export interface ChunkRecord {
  recordingId: string;
  chunks: ChunkInfo[];
  flacAnchors?: FlacAnchor[];
}

export interface TileRecord {
  key: string; // `${recordingId}:${chunkIndex}:${tileIndex}`
  recordingId: string;
  chunkIndex: number;
  tileIndex: number;
  frameCount: number;
  data: Uint8Array;
}

export interface StatsRecord {
  key: string; // `${recordingId}:${chunkIndex}`
  recordingId: string;
  chunkIndex: number;
  rmsDb: Float32Array;
  flux: Float32Array;
  centroid: Float32Array;
  lowDb: Float32Array;
  midDb: Float32Array;
  highDb: Float32Array;
  times: Float32Array;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore(STORES.projects, { keyPath: 'id' });
        const rec = database.createObjectStore(STORES.recordings, { keyPath: 'id' });
        rec.createIndex('projectId', 'projectId');
        database.createObjectStore(STORES.blobs, { keyPath: 'id' });
        const chunk = database.createObjectStore(STORES.chunks, { keyPath: 'recordingId' });
        chunk.createIndex('recordingId', 'recordingId');
        const tile = database.createObjectStore(STORES.tiles, { keyPath: 'key' });
        tile.createIndex('recordingId', 'recordingId');
        const stat = database.createObjectStore(STORES.stats, { keyPath: 'key' });
        stat.createIndex('recordingId', 'recordingId');
        const det = database.createObjectStore(STORES.detections, { keyPath: 'id' });
        det.createIndex('recordingId', 'recordingId');
        const ann = database.createObjectStore(STORES.annotations, { keyPath: 'id' });
        ann.createIndex('recordingId', 'recordingId');
        ann.createIndex('projectId', 'projectId');
        const w = database.createObjectStore(STORES.weather, { keyPath: 'id' });
        w.createIndex('recordingId', 'recordingId');
      },
    });
  }
  return dbPromise;
}

// ---- projects ---------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll(STORES.projects);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putProject(p: Project): Promise<void> {
  await (await db()).put(STORES.projects, p);
}

export async function deleteProject(id: string): Promise<void> {
  const database = await db();
  const recs = await database.getAllFromIndex(STORES.recordings, 'projectId', id);
  for (const r of recs) await deleteRecording(r.id);
  await database.delete(STORES.projects, id);
}

// ---- recordings & blobs -----------------------------------------------------

export async function listRecordings(projectId?: string): Promise<Recording[]> {
  const database = await db();
  const all = projectId
    ? await database.getAllFromIndex(STORES.recordings, 'projectId', projectId)
    : await database.getAll(STORES.recordings);
  return all.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  return (await db()).get(STORES.recordings, id);
}

export async function putRecording(r: Recording): Promise<void> {
  await (await db()).put(STORES.recordings, r);
}

export async function storeFileBlob(recordingId: string, file: Blob): Promise<void> {
  await (await db()).put(STORES.blobs, { id: recordingId, blob: file });
}

export async function getFileBlob(recordingId: string): Promise<Blob | undefined> {
  const rec = await (await db()).get(STORES.blobs, recordingId);
  return rec?.blob as Blob | undefined;
}

export async function deleteRecording(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    [STORES.recordings, STORES.blobs, STORES.chunks, STORES.tiles, STORES.stats, STORES.detections, STORES.annotations, STORES.weather],
    'readwrite',
  );
  await tx.objectStore(STORES.recordings).delete(id);
  await tx.objectStore(STORES.blobs).delete(id);
  await tx.objectStore(STORES.chunks).delete(id);

  const deleteByIndex = async (storeName: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = tx.objectStore(storeName as never);
    const records = await store.index('recordingId').getAll(IDBKeyRange.only(id));
    for (const rec of records) {
      await store.delete(rec[store.keyPath as string]);
    }
  };
  await deleteByIndex(STORES.tiles);
  await deleteByIndex(STORES.stats);
  await deleteByIndex(STORES.detections);
  await deleteByIndex(STORES.weather);
  await deleteByIndex(STORES.annotations);
  await tx.done;
}

// ---- analysis artefacts -----------------------------------------------------

export async function putChunks(
  recordingId: string,
  chunks: ChunkInfo[],
  flacAnchors?: FlacAnchor[],
): Promise<void> {
  const record: ChunkRecord = { recordingId, chunks };
  if (flacAnchors?.length) record.flacAnchors = flacAnchors;
  await (await db()).put(STORES.chunks, record);
}

export async function getChunks(recordingId: string): Promise<ChunkRecord | undefined> {
  return (await db()).get(STORES.chunks, recordingId);
}

export async function putTile(t: TileRecord): Promise<void> {
  await (await db()).put(STORES.tiles, t);
}

export async function getTile(key: string): Promise<TileRecord | undefined> {
  return (await db()).get(STORES.tiles, key);
}

export async function putStats(s: StatsRecord): Promise<void> {
  await (await db()).put(STORES.stats, s);
}

export async function getAllStats(recordingId: string): Promise<StatsRecord[]> {
  const all = await (await db()).getAllFromIndex(STORES.stats, 'recordingId', recordingId);
  return all.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

// ---- detections / annotations / weather ------------------------------------

export async function putDetections(ds: Detection[]): Promise<void> {
  if (!ds.length) return;
  const database = await db();
  const tx = database.transaction(STORES.detections, 'readwrite');
  for (const d of ds) tx.store.put(d);
  await tx.done;
}

export async function listDetections(recordingId: string): Promise<Detection[]> {
  const all = await (await db()).getAllFromIndex(STORES.detections, 'recordingId', recordingId);
  return all.sort((a, b) => a.startSec - b.startSec);
}

export async function deleteDetection(id: string): Promise<void> {
  await (await db()).delete(STORES.detections, id);
}

export async function putAnnotation(a: Annotation): Promise<void> {
  await (await db()).put(STORES.annotations, a);
}

export async function listAnnotations(recordingId?: string): Promise<Annotation[]> {
  const database = await db();
  const all = recordingId
    ? await database.getAllFromIndex(STORES.annotations, 'recordingId', recordingId)
    : await database.getAll(STORES.annotations);
  return all.sort((a, b) => a.startSec - b.startSec);
}

export async function deleteAnnotation(id: string): Promise<void> {
  await (await db()).delete(STORES.annotations, id);
}

export async function putWeather(ws: WeatherSegment[]): Promise<void> {
  if (!ws.length) return;
  const database = await db();
  const tx = database.transaction(STORES.weather, 'readwrite');
  for (const w of ws) tx.store.put(w);
  await tx.done;
}

export async function listWeather(recordingId: string): Promise<WeatherSegment[]> {
  const all = await (await db()).getAllFromIndex(STORES.weather, 'recordingId', recordingId);
  return all.sort((a, b) => a.startSec - b.startSec);
}

/** Best-effort persistent storage so the browser doesn't evict imported files. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
