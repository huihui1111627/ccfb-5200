// Filename + embedded-tag parsing for field recorder conventions.
//
// Supported filename patterns (case-insensitive), examples:
//   SITE07_20260412_213000.wav
//   SITE07-2026-04-12T21-30-00.flac
//   20260412_213000_SITE07.wav
//   SMU01234_20260412_213000_SITE07.wav     (Wildlife Acoustics SM prefix = recorder)
// Also accepts a leading recorder serial like SN:xxx or plain alnum token.

import { RecordingMeta } from '../types';

const DATE_TIME_RE =
  /(?:(20\d{2})[-_]?(\d{2})[-_]?(\d{2}))[ T_-]?(\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?/;

// Wildlife Acoustics / common recorder serial prefixes.
const RECORDER_RE = /(?:^|[_-])(SMU?\d{4,}|SMM?\d{4,}|SN[ _:-]?[A-Z0-9]{4,}|[A-Z]{1,3}\d{5,})(?:[_-]|$)/i;

export function parseFileName(fileName: string): Pick<RecordingMeta, 'tags' | 'tagSources'> & {
  recordedAt?: number;
  site?: string;
  recorder?: string;
} {
  const base = fileName.replace(/\.(wav|flac)$/i, '');
  const tags: Record<string, string> = {};
  const tagSources: Record<string, 'metadata' | 'filename' | 'manual'> = {};
  let recordedAt: number | undefined;
  let site: string | undefined;
  let recorder: string | undefined;

  const dt = base.match(DATE_TIME_RE);
  if (dt) {
    const [, y, mo, d, h, mi, s] = dt;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}`;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) {
      recordedAt = ms;
      tags['filename:recorded_at'] = new Date(ms).toISOString();
      tagSources['filename:recorded_at'] = 'filename';
    }
  }

  const rec = base.match(RECORDER_RE);
  if (rec) {
    recorder = rec[1].replace(/[ _:-]/g, '');
    tags['filename:recorder'] = recorder;
    tagSources['filename:recorder'] = 'filename';
  }

  // Site: first token that is not the date/time, recorder serial or pure number.
  const tokens = base.split(/[_-]+/).filter(Boolean);
  const used = new Set<string>();
  if (dt) {
    const matched = dt[0].split(/[_-]+/).filter(Boolean);
    matched.forEach((m) => used.add(m.replace(/[:T]/g, '')));
  }
  for (const tok of tokens) {
    const clean = tok.replace(/[:T]/g, '');
    if (/^20\d{6,}$/.test(clean) || /^\d{6}$/.test(clean)) continue;
    if (recorder && clean.toUpperCase() === recorder.toUpperCase()) continue;
    if (/^\d+$/.test(clean)) continue;
    if (!/^[A-Za-z0-9]+$/.test(clean)) continue;
    site = tok;
    tags['filename:site'] = site;
    tagSources['filename:site'] = 'filename';
    break;
  }

  return { recordedAt, site, recorder, tags, tagSources };
}

/** Merge embedded metadata tags on top of filename-derived values. */
export function mergeMeta(
  fromName: ReturnType<typeof parseFileName>,
  embedded: Record<string, string>,
): RecordingMeta {
  const tags = { ...fromName.tags, ...embedded };
  const tagSources = { ...fromName.tagSources };
  for (const k of Object.keys(embedded)) {
    if (!(k in tagSources)) tagSources[k] = 'metadata';
  }

  let recordedAt = fromName.recordedAt;
  // bext origin date/time: YYYY-MM-DD + HH:MM:SS
  const d = embedded['bext:origin_date'];
  const t = embedded['bext:origin_time'];
  if (d && t) {
    const ms = Date.parse(`${d}T${t}`);
    if (!Number.isNaN(ms)) {
      recordedAt = ms;
      tags['metadata:recorded_at'] = new Date(ms).toISOString();
      tagSources['metadata:recorded_at'] = 'metadata';
    }
  }
  if (embedded['info:icrd']) {
    const ms = Date.parse(embedded['info:icrd']);
    if (!Number.isNaN(ms)) {
      recordedAt = ms;
      tags['metadata:recorded_at'] = new Date(ms).toISOString();
      tagSources['metadata:recorded_at'] = 'metadata';
    }
  }

  const site = embedded['info:itch'] ?? embedded['info:isft']?.match(/site[=:]\s*(\S+)/i)?.[1] ?? fromName.site;
  if (embedded['info:itch']) {
    tags['metadata:site'] = embedded['info:itch'];
    tagSources['metadata:site'] = 'metadata';
  }
  const recorder = embedded['bext:originator'] ?? fromName.recorder;
  if (embedded['bext:originator']) {
    tags['metadata:recorder'] = embedded['bext:originator'];
    tagSources['metadata:recorder'] = 'metadata';
  }

  return { recordedAt, site, recorder, tags, tagSources };
}

/** FLAC vorbis comment keys we care about (lower-case comparison). */
export function normalizeVorbisComments(comments: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of comments) {
    const key = rawKey.toLowerCase();
    if (key === 'date' || key === 'recordingdate') {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) out['metadata:recorded_at'] = new Date(ms).toISOString();
      else out[`vorbis:${key}`] = value;
    } else if (key === 'location' || key === 'site' || key === 'custom_site') {
      out['metadata:site'] = value;
    } else if (key === 'encoded-by' || key === 'encoder' || key === 'device') {
      out['metadata:recorder'] = value;
    } else {
      out[`vorbis:${key}`] = value;
    }
  }
  return out;
}
