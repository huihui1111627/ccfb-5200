// Scrollable spectrogram viewer.
//
// Renders 256x256 grayscale tiles (each = 16 s x 0..Nyquist) from IDB onto a
// canvas sized to the visible viewport plus an offscreen margin. Tiles are
// paged in lazily as the user scrolls, so an 8-hour recording never needs its
// full spectrogram in memory or in the DOM. Overlays (detections, weather,
// annotations, playback head, frequency-band drag selection) live on a second
// canvas redrawn only when the view changes.

import { getTile } from '../db';
import {
  Detection,
  Annotation,
  WeatherSegment,
  Recording,
  TILE_BIN_COUNT,
  TILE_FRAME_COUNT,
  TILE_SEC,
} from '../types';
import { clamp, el } from '../util';

export interface BandSelection {
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
}

export interface ViewerCallbacks {
  onTimeClick?: (sec: number) => void;
  onBandSelect?: (sel: BandSelection) => void;
  onRangeSelect?: (sel: { startSec: number; endSec: number }) => void;
  onViewportChange?: (startSec: number, endSec: number) => void;
}

const PIXELS_PER_SEC_DEFAULT = 22;
const SPEC_HEIGHT = 320;
const AXIS_WIDTH = 48;
const OFFSCREEN_TILES = 2;

export class SpectrogramViewer {
  readonly container: HTMLElement;
  private scrollBody: HTMLElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private tileCache = new Map<string, ImageData | null>();
  private pixelsPerSec = PIXELS_PER_SEC_DEFAULT;
  private rafPending = false;

  private detections: Detection[] = [];
  private annotations: Annotation[] = [];
  private weather: WeatherSegment[] = [];
  private playheadSec: number | null = null;
  private pendingBand: BandSelection | null = null;
  private drag: { mode: 'band' | 'range'; x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    private recording: Recording,
    private cb: ViewerCallbacks = {},
  ) {
    this.container = el('div', { class: 'spec-wrap' });
    const axis = el('canvas', { class: 'hz-axis' }) as HTMLCanvasElement;
    axis.width = AXIS_WIDTH;
    axis.height = SPEC_HEIGHT;
    this.canvas = el('canvas', { class: 'spec-canvas' }) as HTMLCanvasElement;
    this.overlay = el('canvas', {
      class: 'spec-canvas overlay-layer interactive',
      style: 'background:transparent',
    }) as HTMLCanvasElement;
    this.scrollBody = el('div', { style: `position:relative;height:${SPEC_HEIGHT}px;overflow:hidden;margin-left:${AXIS_WIDTH}px;` });
    this.scrollBody.append(this.canvas, this.overlay);
    this.container.append(axis, this.scrollBody);
    this.ctx = this.canvas.getContext('2d')!;
    this.octx = this.overlay.getContext('2d')!;
    this.drawHzAxis(axis);
    this.resizeCanvases();
    this.scrollBody.addEventListener('scroll', () => this.scheduleDraw());
    new ResizeObserver(() => { this.resizeCanvases(); this.scheduleDraw(); }).observe(this.scrollBody);
    this.bindPointer();
  }

  setData(data: {
    detections?: Detection[];
    annotations?: Annotation[];
    weather?: WeatherSegment[];
  }): void {
    if (data.detections) this.detections = data.detections;
    if (data.annotations) this.annotations = data.annotations;
    if (data.weather) this.weather = data.weather;
    this.scheduleDraw();
  }

  setPlayhead(sec: number | null): void {
    this.playheadSec = sec;
    this.scheduleDraw();
  }

  setPendingBand(sel: BandSelection | null): void {
    this.pendingBand = sel;
    this.scheduleDraw();
  }

  get zoom(): number {
    return this.pixelsPerSec;
  }

  setZoom(pxPerSec: number): void {
    const center = this.viewCenterSec();
    this.pixelsPerSec = clamp(pxPerSec, 4, 120);
    this.resizeCanvases();
    this.scrollToSec(center);
    this.scheduleDraw();
  }

  scrollToSec(sec: number): void {
    const target = clamp(sec, 0, this.recording.durationSec) * this.pixelsPerSec -
      this.scrollBody.clientWidth / 2;
    this.scrollBody.scrollLeft = Math.max(0, target);
    this.scheduleDraw();
  }

  get viewport(): { startSec: number; endSec: number } {
    return {
      startSec: this.scrollBody.scrollLeft / this.pixelsPerSec,
      endSec: (this.scrollBody.scrollLeft + this.scrollBody.clientWidth) / this.pixelsPerSec,
    };
  }

  private viewCenterSec(): number {
    const vp = this.viewport;
    return (vp.startSec + vp.endSec) / 2;
  }

  private resizeCanvases(): void {
    const w = this.scrollBody.clientWidth || 800;
    const h = SPEC_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      c.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private scheduleDraw(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      void this.draw();
    });
  }

  private async draw(): Promise<void> {
    const { ctx, octx } = this;
    const w = this.scrollBody.clientWidth;
    const h = SPEC_HEIGHT;
    const scroll = this.scrollBody.scrollLeft;
    ctx.fillStyle = '#05080b';
    ctx.fillRect(0, 0, w, h);

    const tilePxWidth = TILE_SEC * this.pixelsPerSec;
    const firstTile = Math.max(0, Math.floor(scroll / tilePxWidth) - OFFSCREEN_TILES);
    const lastTile = Math.ceil((scroll + w) / tilePxWidth) + OFFSCREEN_TILES;
    const totalTiles = Math.ceil(this.recording.durationSec / TILE_SEC);

    for (let tileIdx = firstTile; tileIdx <= Math.min(lastTile, totalTiles - 1); tileIdx++) {
      const chunkIndex = Math.floor((tileIdx * TILE_SEC) / this.recording.chunkSec);
      const tileInChunk = tileIdx % Math.ceil(this.recording.chunkSec / TILE_SEC);
      const key = `${this.recording.id}:${chunkIndex}:${tileInChunk}`;
      let img = this.tileCache.get(key);
      if (img === undefined) {
        const rec = await getTile(key);
        if (!rec) {
          this.tileCache.set(key, null);
          continue;
        }
        img = this.grayToImageData(rec.data, TILE_BIN_COUNT, TILE_FRAME_COUNT);
        this.tileCache.set(key, img);
      }
      if (!img) continue;
      const destX = tileIdx * tilePxWidth - scroll;
      // Image smoothing gives a continuous spectrogram when zoomed.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      this.putScaled(ctx, img, destX, 0, tilePxWidth, h);
    }

    // ---- Overlays -----------------------------------------------------------
    octx.clearRect(0, 0, w, h);
    const toX = (sec: number) => sec * this.pixelsPerSec - scroll;
    const toY = (hz: number) => h - (hz / (this.recording.sampleRate / 2)) * h;

    // Weather bands first (under everything).
    for (const ws of this.weather) {
      const x0 = toX(ws.startSec);
      const x1 = toX(ws.endSec);
      if (x1 < 0 || x0 > w) continue;
      octx.fillStyle = ws.kind === 'wind' ? 'rgba(201,168,106,0.18)' : 'rgba(106,168,201,0.18)';
      octx.fillRect(x0, 0, x1 - x0, h);
      octx.strokeStyle = ws.kind === 'wind' ? 'rgba(201,168,106,0.6)' : 'rgba(106,168,201,0.6)';
      octx.setLineDash([4, 4]);
      octx.strokeRect(x0, 0, x1 - x0, h);
      octx.setLineDash([]);
      octx.fillStyle = ws.kind === 'wind' ? '#c9a86a' : '#6aa8c9';
      octx.font = '11px sans-serif';
      octx.fillText(ws.kind === 'wind' ? '风' : '雨', x0 + 4, 14);
    }

    // Detections (orange outline).
    octx.lineWidth = 1.5;
    for (const d of this.detections) {
      const x0 = toX(d.startSec);
      const x1 = toX(d.endSec);
      if (x1 < 0 || x0 > w) continue;
      const y0 = toY(d.highHz);
      const y1 = toY(d.lowHz);
      octx.strokeStyle = d.confidence === 'high' ? 'rgba(255,138,92,0.95)' : 'rgba(255,138,92,0.55)';
      octx.strokeRect(x0, y0, Math.max(2, x1 - x0), y1 - y0);
    }

    // Annotations (green filled).
    for (const a of this.annotations) {
      const x0 = toX(a.startSec);
      const x1 = toX(a.endSec);
      if (x1 < 0 || x0 > w) continue;
      const y0 = toY(a.highHz);
      const y1 = toY(a.lowHz);
      octx.fillStyle = 'rgba(126,224,163,0.14)';
      octx.fillRect(x0, y0, Math.max(2, x1 - x0), y1 - y0);
      octx.strokeStyle = 'rgba(126,224,163,0.95)';
      octx.lineWidth = 2;
      octx.strokeRect(x0, y0, Math.max(2, x1 - x0), y1 - y0);
      octx.fillStyle = '#7ee0a3';
      octx.font = '11px sans-serif';
      octx.fillText(a.species || '?', x0 + 3, Math.max(12, y0 - 4));
    }

    // Pending band selection (drag in progress or externally supplied).
    const band = this.dragBand() ?? this.pendingBand;
    if (band) {
      const x0 = toX(band.startSec);
      const x1 = toX(band.endSec);
      const y0 = toY(band.highHz);
      const y1 = toY(band.lowHz);
      octx.fillStyle = 'rgba(76,194,255,0.15)';
      octx.fillRect(x0, y0, x1 - x0, y1 - y0);
      octx.strokeStyle = '#4cc2ff';
      octx.lineWidth = 1.5;
      octx.setLineDash([6, 3]);
      octx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      octx.setLineDash([]);
    }

    // Playhead.
    if (this.playheadSec !== null) {
      const x = toX(this.playheadSec);
      octx.strokeStyle = '#ffffff';
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.moveTo(x, 0);
      octx.lineTo(x, h);
      octx.stroke();
    }

    this.cb.onViewportChange?.(this.viewport.startSec, this.viewport.endSec);
  }

  private dragBand(): BandSelection | null {
    if (!this.drag) return null;
    const rect = this.overlay.getBoundingClientRect();
    const x0 = Math.min(this.drag.x0, this.drag.x1) - rect.left + this.scrollBody.scrollLeft;
    const x1 = Math.max(this.drag.x0, this.drag.x1) - rect.left + this.scrollBody.scrollLeft;
    const yTop = Math.min(this.drag.y0, this.drag.y1) - rect.top;
    const yBot = Math.max(this.drag.y0, this.drag.y1) - rect.top;
    const h = rect.height;
    const nyquist = this.recording.sampleRate / 2;
    return {
      startSec: x0 / this.pixelsPerSec,
      endSec: x1 / this.pixelsPerSec,
      lowHz: clamp((1 - yBot / h) * nyquist, 0, nyquist),
      highHz: clamp((1 - yTop / h) * nyquist, 0, nyquist),
    };
  }

  private bindPointer(): void {
    this.overlay.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      this.overlay.setPointerCapture(ev.pointerId);
      this.drag = { mode: ev.shiftKey ? 'range' : 'band', x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY };
    });
    this.overlay.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      this.drag.x1 = ev.clientX;
      this.drag.y1 = ev.clientY;
      this.scheduleDraw();
    });
    this.overlay.addEventListener('pointerup', (ev) => {
      if (!this.drag) return;
      const dx = Math.abs(ev.clientX - this.drag.x0);
      const band = this.dragBand();
      const mode = this.drag.mode;
      this.drag = null;
      this.scheduleDraw();
      if (!band) return;
      if (dx < 4) {
        this.cb.onTimeClick?.(band.startSec);
      } else if (mode === 'band' && band.highHz - band.lowHz > 60 && band.endSec - band.startSec > 0.02) {
        this.cb.onBandSelect?.(band);
      } else {
        this.cb.onRangeSelect?.({ startSec: band.startSec, endSec: band.endSec });
      }
    });
  }

  private grayToImageData(gray: Uint8Array, rows: number, cols: number): ImageData {
    const img = new ImageData(cols, rows);
    // Viridis-ish cheap mapping: keep grayscale but tint slightly blue for less eye strain.
    for (let i = 0; i < gray.length; i++) {
      const v = gray[i];
      img.data[i * 4] = v * 0.75;
      img.data[i * 4 + 1] = v * 0.95;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    return img;
  }

  private scaledCanvas: HTMLCanvasElement | null = null;

  private putScaled(c: CanvasRenderingContext2D, img: ImageData, x: number, y: number, w: number, h: number): void {
    if (!this.scaledCanvas) this.scaledCanvas = document.createElement('canvas');
    const tmp = this.scaledCanvas;
    if (tmp.width !== img.width || tmp.height !== img.height) {
      tmp.width = img.width;
      tmp.height = img.height;
    }
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    c.drawImage(tmp, x, y, w, h);
  }

  private drawHzAxis(axis: HTMLCanvasElement): void {
    const ctx = axis.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#181f26';
    ctx.fillRect(0, 0, AXIS_WIDTH, SPEC_HEIGHT);
    ctx.strokeStyle = '#2c3945';
    ctx.beginPath();
    ctx.moveTo(AXIS_WIDTH - 0.5, 0);
    ctx.lineTo(AXIS_WIDTH - 0.5, SPEC_HEIGHT);
    ctx.stroke();
    ctx.fillStyle = '#8aa0b4';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    const nyquist = this.recording.sampleRate / 2;
    const ticks = [0, 2000, 4000, 8000, 12000, 16000, 20000].filter((f) => f <= nyquist);
    for (const hz of ticks) {
      const y = SPEC_HEIGHT - (hz / nyquist) * SPEC_HEIGHT;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), AXIS_WIDTH - 6, y + 3);
      ctx.strokeStyle = 'rgba(138,160,180,0.25)';
      ctx.beginPath();
      ctx.moveTo(AXIS_WIDTH - 3, y);
      ctx.lineTo(AXIS_WIDTH, y);
      ctx.stroke();
    }
  }

  dispose(): void {
    this.tileCache.clear();
    this.scaledCanvas = null;
  }
}
