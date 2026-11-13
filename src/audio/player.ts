// Streaming playback engine.
//
// Decodes short windows on demand from the IDB-stored file and schedules them
// gaplessly on a shared AudioContext via AudioBufferSourceNodes. Never holds
// more than ~6 s of decoded audio. Supports variable playback rate, a biquad
// band-pass filter and in/out looping (used for focused listening).

import { Recording } from '../types';
import {
  BlobRead,
  decodeFlacRange,
  decodeWavRange,
  FlacAnchor,
} from '../audio/stream-decoder';
import { readFlacMeta, FlacMeta } from '../audio/flac';
import { readWavHeader, WavHeader } from '../audio/wav';
import { getChunks, getFileBlob } from '../db';

const WINDOW_SEC = 2;
const LOOKAHEAD_WINDOWS = 3;

export interface LoopRange {
  startSec: number;
  endSec: number;
}

interface Scheduled {
  source: AudioBufferSourceNode;
  /** Recording-relative sample of the window start. */
  startSample: number;
  frames: number;
  /** Context time when playback of this window begins. */
  atCtx: number;
}

export class PlayerEngine {
  private ctx: AudioContext | null = null;
  private bandpass: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private recording: Recording | null = null;
  private read: BlobRead | null = null;
  private wavHeader: WavHeader | null = null;
  private flacMeta: FlacMeta | null = null;
  private anchors: FlacAnchor[] = [];
  private fileSize = 0;

  private playing = false;
  private rate = 1;
  private loop: LoopRange | null = null;
  private filterOn = false;
  private filterLowHz = 1000;
  private filterHighHz = 8000;

  /** Playhead position (recording seconds) at ctx reference time 0 anchor. */
  private anchorSec = 0;
  private anchorCtx = 0;
  private scheduled: Scheduled[] = [];
  private timer: number | null = null;

  onTime?: (sec: number) => void;
  onEnded?: () => void;

  get durationSec(): number {
    return this.recording?.durationSec ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentRate(): number {
    return this.rate;
  }

  async open(recording: Recording): Promise<void> {
    this.stopInternal();
    const blob = await getFileBlob(recording.id);
    if (!blob) throw new Error('录音文件已从存储中移除');
    this.recording = recording;
    this.fileSize = blob.size;
    this.read = async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

    if (recording.format === 'wav') {
      this.wavHeader = await readWavHeader(this.read, blob.size);
      this.flacMeta = null;
    } else {
      this.flacMeta = await readFlacMeta(this.read, blob.size);
      this.wavHeader = null;
      const chunkRec = await getChunks(recording.id);
      this.anchors = chunkRec?.flacAnchors ?? [];
    }
  }

  private ensureGraph(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.bandpass = this.ctx.createBiquadFilter();
      this.bandpass.type = 'bandpass';
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.bandpass.connect(this.gain);
      this.gain.connect(this.ctx.destination);
    }
    this.applyFilter();
    return this.ctx;
  }

  private get inputNode(): AudioNode {
    return this.filterOn ? (this.bandpass as BiquadFilterNode) : (this.gain as GainNode);
  }

  private async decodeWindow(startSample: number, frames: number): Promise<Float32Array> {
    if (!this.read || !this.recording) throw new Error('player not opened');
    if (this.recording.format === 'wav' && this.wavHeader) {
      return decodeWavRange(this.read, this.wavHeader, startSample, frames);
    }
    if (this.flacMeta) {
      return decodeFlacRange(
        this.read,
        this.flacMeta,
        this.anchors,
        this.fileSize,
        startSample,
        frames,
      );
    }
    throw new Error('player not initialised');
  }

  async play(fromSec?: number): Promise<void> {
    if (!this.recording) return;
    const ctx = this.ensureGraph();
    await ctx.resume();
    if (typeof fromSec === 'number') this.anchorSec = fromSec;
    this.anchorCtx = ctx.currentTime;
    this.playing = true;
    this.clearTimer();
    this.timer = window.setInterval(() => void this.tick(), 200);
    void this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorSec = this.currentTime;
    this.playing = false;
    this.clearTimer();
    this.stopSources();
  }

  stop(): void {
    this.stopInternal();
    this.anchorSec = 0;
    this.loop = null;
  }

  private stopInternal(): void {
    this.playing = false;
    this.clearTimer();
    this.stopSources();
  }

  seek(sec: number): void {
    if (!this.recording) return;
    const clamped = Math.max(0, Math.min(this.recording.durationSec, sec));
    this.anchorSec = clamped;
    if (this.ctx) this.anchorCtx = this.ctx.currentTime;
    if (this.playing) {
      this.stopSources();
      void this.tick();
    }
    this.onTime?.(clamped);
  }

  setRate(rate: number): void {
    // Preserve current position when changing rate.
    if (this.playing && this.ctx) this.anchorSec = this.currentTime;
    this.rate = Math.max(0.25, Math.min(4, rate));
    if (this.playing && this.ctx) {
      this.anchorCtx = this.ctx.currentTime;
      this.stopSources();
      void this.tick();
    }
  }

  setLoop(loop: LoopRange | null): void {
    this.loop = loop;
    if (this.playing) {
      this.anchorSec = this.currentTime;
      this.anchorCtx = this.ctx!.currentTime;
      this.stopSources();
      void this.tick();
    }
  }

  setBandpass(on: boolean, lowHz?: number, highHz?: number): void {
    this.filterOn = on;
    if (lowHz !== undefined) this.filterLowHz = lowHz;
    if (highHz !== undefined) this.filterHighHz = highHz;
    this.applyFilter();
  }

  private applyFilter(): void {
    if (!this.bandpass || !this.ctx) return;
    const center = (this.filterLowHz + this.filterHighHz) / 2;
    this.bandpass.frequency.setTargetAtTime(center, this.ctx.currentTime, 0.02);
    this.bandpass.Q.setTargetAtTime(
      center / Math.max(50, this.filterHighHz - this.filterLowHz),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** Unwrapped virtual position in recording seconds (loop folded in). */
  get currentTime(): number {
    if (!this.ctx || !this.recording) return this.anchorSec;
    if (!this.playing) return this.anchorSec;
    const raw = this.anchorSec + (this.ctx.currentTime - this.anchorCtx) * this.rate;
    if (!this.loop) return Math.min(raw, this.recording.durationSec);
    const { startSec, endSec } = this.loop;
    const span = endSec - startSec;
    if (raw <= endSec) return Math.max(raw, startSec);
    return startSec + ((raw - endSec) % span);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stopSources(): void {
    for (const s of this.scheduled) {
      try {
        s.source.onended = null;
        s.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        s.source.disconnect();
      } catch {
        /* noop */
      }
    }
    this.scheduled = [];
  }

  private async tick(): Promise<void> {
    if (!this.playing || !this.ctx || !this.recording) return;
    const sr = this.recording.sampleRate;
    const ctxNow = this.ctx.currentTime;

    // Drop windows that have finished playing.
    this.scheduled = this.scheduled.filter((s) => {
      const endCtx = s.atCtx + s.frames / sr / this.rate;
      if (endCtx <= ctxNow) {
        try {
          s.source.disconnect();
        } catch {
          /* noop */
        }
        return false;
      }
      return true;
    });

    const horizonSec = this.anchorSec + (ctxNow - this.anchorCtx + WINDOW_SEC * LOOKAHEAD_WINDOWS) * this.rate;
    const lastEnd = this.scheduled.length
      ? this.scheduled[this.scheduled.length - 1].atCtx +
        this.scheduled[this.scheduled.length - 1].frames / sr / this.rate
      : ctxNow;
    let virtualFrom = this.scheduled.length
      ? this.anchorSec + (lastEnd - this.anchorCtx) * this.rate
      : this.anchorSec + (ctxNow - this.anchorCtx) * this.rate;

    let guard = 0;
    while (virtualFrom < horizonSec && guard++ < 16) {
      let winStart = virtualFrom;
      let winEnd = Math.min(this.recording.durationSec, winStart + WINDOW_SEC);

      if (this.loop) {
        const { startSec, endSec } = this.loop;
        if (winStart < startSec) winStart = startSec;
        if (winStart >= endSec) {
          // Fold back to loop start.
          const span = endSec - startSec;
          winStart = startSec + ((winStart - endSec) % span);
        }
        winEnd = Math.min(winStart + WINDOW_SEC, endSec);
      }
      if (winEnd - winStart < 0.05) break;

      const startSample = Math.round(winStart * sr);
      const frames = Math.round((winEnd - winStart) * sr);
      const atCtx = this.anchorCtx + (winStart - this.anchorSec) / this.rate;
      if (atCtx < ctxNow - 0.05) {
        // Fell behind (slow decode): resync anchor to now.
        this.anchorSec = this.currentTime;
        this.anchorCtx = ctxNow;
        this.stopSources();
        break;
      }

      const interleaved = await this.decodeWindow(startSample, frames);
      if (!this.playing || !this.ctx) return;
      const channels = this.recording.channels;
      const buffer = this.ctx.createBuffer(channels, frames, sr);
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < frames; i++) data[i] = interleaved[i * channels + c] ?? 0;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.inputNode);
      const when = Math.max(ctxNow + 0.05, atCtx);
      source.start(when);
      this.scheduled.push({ source, startSample, frames, atCtx: when });

      if (!this.loop && winEnd >= this.recording.durationSec) {
        const ms = (when - ctxNow) * 1000 + (frames / sr / this.rate) * 1000 + 200;
        window.setTimeout(() => {
          if (this.playing) {
            this.playing = false;
            this.clearTimer();
            this.anchorSec = this.recording!.durationSec;
            this.onEnded?.();
          }
        }, ms);
        break;
      }
      virtualFrom = winEnd;
    }

    this.onTime?.(this.currentTime);
  }
}
