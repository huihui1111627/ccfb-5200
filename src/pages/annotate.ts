import { el, clear, formatTime, uid, clamp } from '../util';
import {
  Annotation,
  Detection,
  Recording,
  WeatherSegment,
} from '../types';
import {
  deleteDetection,
  getRecording,
  listAnnotations,
  listDetections,
  listRecordings,
  listWeather,
  putAnnotation,
  putWeather,
} from '../db';
import { App } from '../app';
import { SpectrogramViewer, BandSelection } from '../components/spectrogram-viewer';
import { PlayerEngine } from '../audio/player';

const VOCAL_TYPES = ['song', 'call', 'alarm', 'unknown'];

export class AnnotatePage {
  private viewer?: SpectrogramViewer;
  private player = new PlayerEngine();
  private recording?: Recording;
  private detections: Detection[] = [];
  private annotations: Annotation[] = [];
  private weather: WeatherSegment[] = [];
  private selectedDetection: Detection | null = null;
  private selectedBand: BandSelection | null = null;
  private listEl?: HTMLElement;
  private timeLabel?: HTMLElement;
  private playBtn?: HTMLButtonElement;
  private loopBtn?: HTMLButtonElement;
  private filterBtn?: HTMLButtonElement;
  private headTimer: number | null = null;
  private rateSelect?: HTMLSelectElement;

  constructor(
    private host: HTMLElement,
    private app: App,
    private projectId: string,
    private initialRecordingId?: string,
  ) {}

  async mount(): Promise<void> {
    const recs = await listRecordings(this.projectId);
    if (!recs.length) {
      this.host.append(el('div', { class: 'card muted', text: '暂无录音，请先导入并分析。' }));
      return;
    }
    const recording =
      (this.initialRecordingId ? await getRecording(this.initialRecordingId) : undefined) ??
      recs.find((r) => r.status === 'analyzed') ??
      recs[0];
    this.recording = recording;

    // ---- Top: recording selector -------------------------------------------
    const header = el('div', { class: 'card row' });
    const select = el('select') as HTMLSelectElement;
    for (const r of recs) {
      const opt = el('option', { value: r.id, text: `${r.fileName} (${formatTime(r.durationSec)})` }) as HTMLOptionElement;
      if (r.id === recording.id) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      history.replaceState(null, '', `#/annotate/${this.projectId}/${select.value}`);
      this.dispose();
      this.mount();
    });
    header.append(el('strong', { text: '录音：' }), select, el('div', { class: 'spacer' }));
    if (recording.groundTruth) {
      header.append(el('span', { class: 'pill high', text: `合成埋点 ${recording.groundTruth.calls.length} 个` }));
    }
    this.host.append(header);

    if (recording.status !== 'analyzed') {
      this.host.append(el('div', { class: 'card warn', text: '该录音尚未分析，请先在「检测」页运行自动检测。' }));
      return;
    }

    await this.loadData(recording);
    await this.player.open(recording);
    this.buildLayout();
    this.player.onTime = (sec) => {
      this.viewer?.setPlayhead(sec);
      if (this.timeLabel) this.timeLabel.textContent = `${formatTime(sec)} / ${formatTime(recording.durationSec)}`;
    };
    this.player.onEnded = () => {
      if (this.playBtn) this.playBtn.textContent = '播放';
      this.viewer?.setPlayhead(null);
    };
  }

  private async loadData(recording: Recording): Promise<void> {
    [this.detections, this.annotations, this.weather] = await Promise.all([
      listDetections(recording.id),
      listAnnotations(recording.id),
      listWeather(recording.id),
    ]);
  }

  private buildLayout(): void {
    if (!this.recording) return;
    const wrap = el('div', { class: 'with-sidebar', style: 'height:calc(100vh - 180px);min-height:480px' });

    // ---- Main column: viewer + transport -----------------------------------
    const main = el('div', { class: 'main-col' });
    this.viewer = new SpectrogramViewer(this.recording, {
      onTimeClick: (sec) => this.seek(sec),
      onBandSelect: (band) => this.handleBandSelect(band),
      onRangeSelect: (range) => {
        this.player.setLoop(range);
        if (this.loopBtn) this.loopBtn.classList.add('active');
        this.seek(range.startSec);
        void this.player.play();
      },
    });
    this.viewer.setData({
      detections: this.detections,
      annotations: this.annotations,
      weather: this.weather,
    });
    main.append(this.viewer.container, this.buildTransport());

    // ---- Sidebar -------------------------------------------------------------
    const sidebar = el('div', { class: 'sidebar stack' });
    sidebar.append(this.buildAnnotationForm(), this.buildDetectionList());
    wrap.append(main, sidebar);
    this.host.append(wrap);

    // Keyboard shortcuts.
    window.addEventListener('keydown', this.onKey);
  }

  private buildTransport(): HTMLElement {
    const bar = el('div', { class: 'transport' });
    this.playBtn = el('button', { class: 'primary', text: '播放' }) as HTMLButtonElement;
    this.playBtn.addEventListener('click', () => this.togglePlay());
    const stopBtn = el('button', { text: '停止' }) as HTMLButtonElement;
    stopBtn.addEventListener('click', () => {
      this.player.stop();
      this.viewer?.setPlayhead(null);
      if (this.playBtn) this.playBtn.textContent = '播放';
      if (this.loopBtn) this.loopBtn.classList.remove('active');
    });

    this.rateSelect = el('select') as HTMLSelectElement;
    for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const opt = el('option', { value: String(rate), text: `${rate}×` }) as HTMLOptionElement;
      if (rate === 1) opt.selected = true;
      this.rateSelect.append(opt);
    }
    this.rateSelect.addEventListener('change', () =>
      this.player.setRate(Number(this.rateSelect!.value)));

    this.loopBtn = el('button', { text: '区间循环' }) as HTMLButtonElement;
    this.loopBtn.addEventListener('click', () => {
      const looping = this.loopBtn!.classList.toggle('active');
      if (!looping) this.player.setLoop(null);
    });
    this.filterBtn = el('button', { text: '带通滤波' }) as HTMLButtonElement;
    this.filterBtn.addEventListener('click', () => {
      const on = this.filterBtn!.classList.toggle('active');
      const band = this.selectedBand ?? this.selectedDetection;
      if (band) this.player.setBandpass(on, band.lowHz, band.highHz);
      else this.player.setBandpass(on, 1000, 8000);
    });

    const zoomOut = el('button', { text: '−' }) as HTMLButtonElement;
    const zoomIn = el('button', { text: '+' }) as HTMLButtonElement;
    zoomOut.addEventListener('click', () => this.viewer?.setZoom(this.viewer.zoom / 1.4));
    zoomIn.addEventListener('click', () => this.viewer?.setZoom(this.viewer.zoom * 1.4));

    this.timeLabel = el('span', { class: 'time muted', text: `0:00:00.0 / ${formatTime(this.recording!.durationSec)}` });
    bar.append(
      this.playBtn, stopBtn,
      el('span', { class: 'muted small', text: '速度' }), this.rateSelect,
      this.loopBtn, this.filterBtn,
      el('div', { class: 'spacer' }),
      zoomOut, zoomIn, this.timeLabel,
    );
    return bar;
  }

  private buildAnnotationForm(): HTMLElement {
    const card = el('div', { class: 'stack' });
    card.append(el('h2', { text: '标注' }));
    const hint = el('div', { class: 'muted small', text: '在语谱图上按住鼠标框选时间×频段；Shift+拖拽只选时间区间并循环播放。快捷键：空格 播放/暂停，←/→ ±2s，Del 删除选中。' });
    const bandLabel = el('div', { class: 'small muted' });
    const speciesInput = el('input', { placeholder: '物种（拉丁名或中文名）' }) as HTMLInputElement;
    const typeSelect = el('select') as HTMLSelectElement;
    for (const t of VOCAL_TYPES) typeSelect.append(el('option', { value: t, text: t }));
    const notesInput = el('input', { placeholder: '备注（可选）' }) as HTMLInputElement;
    const saveBtn = el('button', { class: 'primary', text: '保存标注' }) as HTMLButtonElement;

    const refreshBandLabel = () => {
      const b = this.selectedBand ?? this.selectedDetection;
      bandLabel.textContent = b
        ? `区间 ${formatTime(b.startSec)}–${formatTime(b.endSec)}，频段 ${Math.round(b.lowHz)}–${Math.round(b.highHz)} Hz`
        : '尚未框选区间';
    };
    refreshBandLabel();

    saveBtn.addEventListener('click', async () => {
      const b = this.selectedBand ?? this.selectedDetection;
      if (!b || !this.recording) {
        alert('请先在语谱图上框选一个鸣声区间。');
        return;
      }
      const species = speciesInput.value.trim();
      if (!species) {
        alert('请填写物种名称。');
        speciesInput.focus();
        return;
      }
      const annotation: Annotation = {
        id: uid(),
        recordingId: this.recording.id,
        projectId: this.projectId,
        startSec: b.startSec,
        endSec: b.endSec,
        lowHz: b.lowHz,
        highHz: b.highHz,
        species,
        vocalizationType: typeSelect.value,
        notes: notesInput.value || undefined,
        detectionId: this.selectedDetection?.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await putAnnotation(annotation);
      this.annotations = await listAnnotations(this.recording.id);
      this.viewer?.setData({ annotations: this.annotations });
      speciesInput.value = '';
      notesInput.value = '';
      this.selectedBand = null;
      this.viewer?.setPendingBand(null);
      refreshBandLabel();
      this.renderDetectionList();
    });

    // Manual weather marking on the current selection.
    const weatherRow = el('div', { class: 'row' });
    const markWind = el('button', { text: '标为风噪段' }) as HTMLButtonElement;
    const markRain = el('button', { text: '标为雨噪段' }) as HTMLButtonElement;
    markWind.addEventListener('click', () => this.markWeather('wind', bandLabel));
    markRain.addEventListener('click', () => this.markWeather('rain', bandLabel));
    weatherRow.append(markWind, markRain);

    card.append(hint, bandLabel, speciesInput, typeSelect, notesInput, saveBtn, weatherRow);
    this._refreshBandLabel = refreshBandLabel;
    return card;
  }

  private _refreshBandLabel: () => void = () => {};

  private async markWeather(kind: 'wind' | 'rain', label: HTMLElement): Promise<void> {
    const b = this.selectedBand ?? this.selectedDetection;
    if (!b || !this.recording) return;
    const seg: WeatherSegment = {
      id: uid(),
      recordingId: this.recording.id,
      kind,
      startSec: b.startSec,
      endSec: b.endSec,
      severity: 1,
      source: 'manual',
      createdAt: Date.now(),
    };
    await putWeather([seg]);
    this.weather = await listWeather(this.recording.id);
    this.viewer?.setData({ weather: this.weather });
    label.textContent = `已标记${kind === 'wind' ? '风' : '雨'}噪段 ${formatTime(seg.startSec)}–${formatTime(seg.endSec)}`;
  }

  private buildDetectionList(): HTMLElement {
    const card = el('div', { class: 'stack', style: 'min-height:0;flex:1' });
    card.append(el('h2', { text: `检出片段（${this.detections.length}）` }));
    this.listEl = el('div', { style: 'overflow:auto;flex:1' });
    card.append(this.listEl);
    this.renderDetectionList();
    return card;
  }

  private renderDetectionList(): void {
    if (!this.listEl || !this.recording) return;
    clear(this.listEl);
    const annotatedDetIds = new Set(this.annotations.map((a) => a.detectionId).filter(Boolean));
    if (!this.detections.length) {
      this.listEl.append(el('div', { class: 'muted small', text: '无检出片段。' }));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '#' }),
      el('th', { text: '时间' }),
      el('th', { text: '频段' }),
      el('th', { text: '置信' }),
      el('th', { text: '' }),
    )));
    const tbody = el('tbody');
    this.detections.forEach((d, idx) => {
      const tr = el('tr', { class: 'detection-row' });
      if (this.selectedDetection?.id === d.id) tr.classList.add('selected');
      tr.addEventListener('click', () => this.selectDetection(d));
      const play = el('button', { text: '▶' }) as HTMLButtonElement;
      play.title = '播放该片段';
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playDetection(d);
      });
      const del = el('button', { class: 'danger', text: '✕' }) as HTMLButtonElement;
      del.title = '删除该检出';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteDetection(d.id);
        this.detections = this.detections.filter((x) => x.id !== d.id);
        if (this.selectedDetection?.id === d.id) {
          this.selectedDetection = null;
          this._refreshBandLabel();
        }
        this.viewer?.setData({ detections: this.detections });
        this.renderDetectionList();
      });
      tr.append(
        el('td', { class: 'small muted', text: String(idx + 1) }),
        el('td', { class: 'small', text: `${formatTime(d.startSec)}` }),
        el('td', { class: 'small muted', text: `${Math.round(d.lowHz / 100) / 10}–${Math.round(d.highHz / 100) / 10}k` }),
        el('td', {}, el('span', { class: `pill ${d.confidence}`, text: d.confidence })),
        el('td', {}, el('div', { class: 'row' },
          play, del,
          annotatedDetIds.has(d.id) ? el('span', { class: 'pill high', text: '已标注' }) : el('span'),
        )),
      );
      tbody.append(tr);
    });
    table.append(tbody);
    this.listEl.append(table);
  }

  private handleBandSelect(band: BandSelection): void {
    this.selectedBand = band;
    this.selectedDetection = null;
    this.viewer?.setPendingBand(band);
    this._refreshBandLabel();
    if (this.filterBtn?.classList.contains('active')) {
      this.player.setBandpass(true, band.lowHz, band.highHz);
    }
  }

  private selectDetection(d: Detection): void {
    this.selectedDetection = d;
    this.selectedBand = null;
    this.viewer?.setPendingBand(null);
    this.viewer?.scrollToSec(d.startSec);
    this._refreshBandLabel();
    this.renderDetectionList();
  }

  private playDetection(d: Detection): void {
    this.selectDetection(d);
    this.player.setLoop({ startSec: d.startSec, endSec: d.endSec });
    this.player.setBandpass(this.filterBtn?.classList.contains('active') ?? false, d.lowHz, d.highHz);
    this.viewer?.scrollToSec(d.startSec);
    void this.player.play(d.startSec);
    if (this.playBtn) this.playBtn.textContent = '暂停';
  }

  private seek(sec: number): void {
    if (!this.recording) return;
    this.player.seek(clamp(sec, 0, this.recording.durationSec));
    this.viewer?.setPlayhead(this.player.currentTime);
  }

  private togglePlay(): void {
    if (this.player.isPlaying) {
      this.player.pause();
      if (this.playBtn) this.playBtn.textContent = '播放';
    } else {
      void this.player.play();
      if (this.playBtn) this.playBtn.textContent = '暂停';
    }
  }

  private onKey = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      this.togglePlay();
    } else if (ev.code === 'ArrowLeft') {
      this.seek(this.player.currentTime - 2);
    } else if (ev.code === 'ArrowRight') {
      this.seek(this.player.currentTime + 2);
    } else if (ev.code === 'Delete' && this.selectedDetection) {
      void deleteDetection(this.selectedDetection.id).then(async () => {
        if (!this.recording) return;
        this.detections = await listDetections(this.recording.id);
        this.selectedDetection = null;
        this.viewer?.setData({ detections: this.detections });
        this.renderDetectionList();
      });
    }
  };

  private dispose(): void {
    this.player.stop();
    this.viewer?.dispose();
    window.removeEventListener('keydown', this.onKey);
    if (this.headTimer) clearInterval(this.headTimer);
    clear(this.host);
  }
}
