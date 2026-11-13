import { Annotation, Detection, Recording } from './types';

function csvEscape(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function absoluteTime(rec: Recording, sec: number): string {
  if (!rec.meta.recordedAt) return '';
  return new Date(rec.meta.recordedAt + sec * 1000).toISOString();
}

export interface ExportRow {
  annotation?: Annotation;
  detection?: Detection;
}

/**
 * Build a screening CSV. Annotations first; detections not yet annotated are
 * appended with an empty species column.
 */
export function buildCsv(
  rows: ExportRow[],
  recordings: Map<string, Recording>,
): string {
  const header = [
    'recording', 'site', 'recorder', 'selection',
    'start_sec', 'end_sec', 'duration_sec', 'low_hz', 'high_hz',
    'start_absolute', 'end_absolute',
    'species', 'vocalization_type', 'confidence', 'source', 'notes',
  ];
  const lines = [header.join(',')];

  let selection = 1;
  for (const row of rows) {
    const a = row.annotation;
    const d = row.detection;
    const startSec = a?.startSec ?? d?.startSec ?? 0;
    const endSec = a?.endSec ?? d?.endSec ?? 0;
    const lowHz = a?.lowHz ?? d?.lowHz ?? 0;
    const highHz = a?.highHz ?? d?.highHz ?? 0;
    const recId = a?.recordingId ?? d?.recordingId ?? '';
    const rec = recordings.get(recId);
    lines.push([
      csvEscape(rec?.fileName ?? recId),
      csvEscape(rec?.meta.site ?? ''),
      csvEscape(rec?.meta.recorder ?? ''),
      selection++,
      round3(startSec),
      round3(endSec),
      round3(endSec - startSec),
      Math.round(lowHz),
      Math.round(highHz),
      csvEscape(rec ? absoluteTime(rec, startSec) : ''),
      csvEscape(rec ? absoluteTime(rec, endSec) : ''),
      csvEscape(a?.species ?? ''),
      csvEscape(a?.vocalizationType ?? ''),
      csvEscape(d?.confidence ?? ''),
      csvEscape(a ? 'manual' : 'auto'),
      csvEscape(a?.notes ?? ''),
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * Raven Pro selection table (tab-separated, UTF-8 with BOM so Excel/Windows
 * tooling reads it correctly). Column names follow Raven 1.6 conventions.
 */
export function buildRavenTable(
  rows: ExportRow[],
  recordings: Map<string, Recording>,
): string {
  const header = [
    'Selection', 'View', 'Channel',
    'Begin Time (s)', 'End Time (s)', 'Delta Time (s)',
    'Low Freq (Hz)', 'High Freq (Hz)',
    'Begin Path', 'Species', 'Type', 'Confidence', 'Notes',
  ];
  const lines = [header.join('\t')];

  let selection = 1;
  for (const row of rows) {
    const a = row.annotation;
    const d = row.detection;
    const startSec = a?.startSec ?? d?.startSec ?? 0;
    const endSec = a?.endSec ?? d?.endSec ?? 0;
    const lowHz = a?.lowHz ?? d?.lowHz ?? 0;
    const highHz = a?.highHz ?? d?.highHz ?? 0;
    const recId = a?.recordingId ?? d?.recordingId ?? '';
    const rec = recordings.get(recId);
    lines.push([
      selection++,
      'Spectrogram',
      1,
      round3(startSec),
      round3(endSec),
      round3(endSec - startSec),
      Math.round(lowHz),
      Math.round(highHz),
      rec?.fileName ?? recId,
      a?.species ?? '',
      a?.vocalizationType ?? '',
      d?.confidence ?? '',
      a?.notes ?? '',
    ].join('\t'));
  }
  return '﻿' + lines.join('\n');
}

export function downloadTextFile(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Merge annotations with the auto detections they did not originate from. */
export function mergeExportRows(
  annotations: Annotation[],
  detections: Detection[],
): ExportRow[] {
  const usedDetections = new Set(annotations.map((a) => a.detectionId).filter(Boolean));
  const rows: ExportRow[] = annotations.map((annotation) => {
    const detection = detections.find((d) => d.id === annotation.detectionId);
    return { annotation, detection };
  });
  for (const detection of detections) {
    if (!usedDetections.has(detection.id)) rows.push({ detection });
  }
  rows.sort((x, y) => {
    const xr = (x.annotation?.recordingId ?? x.detection?.recordingId ?? '');
    const yr = (y.annotation?.recordingId ?? y.detection?.recordingId ?? '');
    if (xr !== yr) return xr.localeCompare(yr);
    return (x.annotation?.startSec ?? x.detection?.startSec ?? 0) -
      (y.annotation?.startSec ?? y.detection?.startSec ?? 0);
  });
  return rows;
}
