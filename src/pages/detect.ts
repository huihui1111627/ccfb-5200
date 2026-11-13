import { el, clear, formatTime } from '../util';
import {
  DEFAULT_DETECTION_SETTINGS,
  DetectionSettings,
  Recording,
} from '../types';
import { listDetections, listRecordings, listWeather, putRecording } from '../db';
import { App } from '../app';
import { navigate } from '../router';
import { AnalysisClient } from '../services/analysis-client';

export class DetectPage {
  private client = new AnalysisClient();
  private settings: DetectionSettings = { ...DEFAULT_DETECTION_SETTINGS };
  private progressEl?: HTMLElement;
  private running = false;

  constructor(
    private host: HTMLElement,
    private app: App,
    private projectId: string,
  ) {}

  async mount(): Promise<void> {
    this.host.append(el('h1', { text: '自动鸣声检测' }));
    const recs = await listRecordings(this.projectId);
    if (!recs.length) {
      this.host.append(el('div', { class: 'card muted', text: '请先在「导入」页添加录音。' }));
      return;
    }

    // ---- Settings card ------------------------------------------------------
    const settingsCard = el('div', { class: 'card' });
    settingsCard.append(el('h2', { text: '检测参数' }));
    const fields: Array<{ key: keyof DetectionSettings; label: string; step: string; hint: string }> = [
      { key: 'snrDb', label: '信噪比门限 (dB)', step: '0.5', hint: '越高越严格，误报更少但弱鸣声易漏' },
      { key: 'minEventSec', label: '最短事件 (s)', step: '0.01', hint: '短于此长度的片段被丢弃' },
      { key: 'maxGapSec', label: '最大桥接间隔 (s)', step: '0.01', hint: '间隔内的同一鸣声片段会被合并' },
      { key: 'minDutyCycle', label: '最小占空比', step: '0.01', hint: '事件内有效帧比例下限' },
      { key: 'fluxGate', label: '通量门限分位', step: '0.01', hint: '起音瞬态判定，0.85 适用于多数野外录音' },
      { key: 'windDbOverFloor', label: '风噪抬升 (dB)', step: '0.5', hint: '低频持续高于地板多少判为风' },
      { key: 'rainDbOverFloor', label: '雨噪抬升 (dB)', step: '0.5', hint: '宽带持续高于地板多少判为雨' },
      { key: 'weatherMinSec', label: '天气段最短 (s)', step: '1', hint: '短于此长度的天气标记被丢弃' },
    ];
    const inputs = new Map<keyof DetectionSettings, HTMLInputElement>();
    const grid = el('div', { class: 'grid cols-3' });
    for (const f of fields) {
      const input = el('input', { type: 'number', step: f.step, value: String(this.settings[f.key]) }) as HTMLInputElement;
      inputs.set(f.key, input);
      grid.append(el('div', { class: 'stack' },
        el('label', { class: 'small muted', text: f.label }),
        input,
        el('div', { class: 'small muted', style: 'font-size:11px', text: f.hint }),
      ));
    }
    settingsCard.append(grid);
    const resetBtn = el('button', { text: '恢复默认' }) as HTMLButtonElement;
    resetBtn.addEventListener('click', () => {
      this.settings = { ...DEFAULT_DETECTION_SETTINGS };
      for (const f of fields) inputs.get(f.key)!.value = String(this.settings[f.key]);
    });
    settingsCard.append(el('div', { class: 'row', style: 'margin-top:10px' }, resetBtn));
    this.host.append(settingsCard);

    // ---- Run controls -------------------------------------------------------
    const runCard = el('div', { class: 'card stack' });
    const runAllBtn = el('button', { class: 'primary', text: '批量分析全部录音' }) as HTMLButtonElement;
    const rerunBtn = el('button', { text: '仅重新检测（复用语谱图）' }) as HTMLButtonElement;
    this.progressEl = el('div', { class: 'stack' });
    runCard.append(el('div', { class: 'row' }, runAllBtn, rerunBtn), this.progressEl);
    this.host.append(runCard);

    const collectSettings = (): DetectionSettings => {
      const next = { ...this.settings };
      for (const f of fields) {
        const v = Number(inputs.get(f.key)!.value);
        if (Number.isFinite(v)) (next as Record<string, number>)[f.key] = v;
      }
      this.settings = next;
      return next;
    };

    runAllBtn.addEventListener('click', () =>
      this.runAll(collectSettings(), false, runAllBtn, rerunBtn));
    rerunBtn.addEventListener('click', () =>
      this.runAll(collectSettings(), true, runAllBtn, rerunBtn));

    // ---- Recording status table --------------------------------------------
    await this.renderTable(recs);
  }

  private async runAll(
    settings: DetectionSettings,
    detectOnly: boolean,
    ...buttons: HTMLButtonElement[]
  ): Promise<void> {
    if (this.running) return;
    // Always read fresh from IDB: recordings may have been imported after
    // this page was mounted, so a cached list would silently skip them.
    const recs = (await listRecordings(this.projectId)).filter(
      (r) => !detectOnly || r.status === 'analyzed',
    );
    this.running = true;
    buttons.forEach((b) => (b.disabled = true));
    for (const rec of recs) {
      this.renderProgress(rec, { kind: 'status', message: '排队中…' }, 0, recs.length);
      try {
        await putRecording({ ...rec, status: 'analyzing' });
        await this.client.analyze(rec, { settings, detectOnly }, (p) => {
          if (p.kind === 'chunk') this.renderProgress(rec, p, p.index, p.total);
          else this.renderProgress(rec, p, undefined, undefined);
        });
        await putRecording({ ...rec, status: 'analyzed', analyzeError: undefined });
      } catch (err) {
        await putRecording({
          ...rec,
          status: 'error',
          analyzeError: err instanceof Error ? err.message : String(err),
        });
        this.renderProgress(rec, { kind: 'error', message: err instanceof Error ? err.message : String(err) }, undefined, undefined);
      }
    }
    this.running = false;
    buttons.forEach((b) => (b.disabled = false));
    const refreshed = await listRecordings(this.projectId);
    this.renderTable(refreshed);
  }

  private renderProgress(rec: Recording, p: { kind: string; message?: string }, index?: number, total?: number): void {
    if (!this.progressEl) return;
    let row = this.progressEl.querySelector<HTMLElement>(`[data-rec="${rec.id}"]`);
    if (!row) {
      row = el('div', { 'data-rec': rec.id, class: 'stack' });
      this.progressEl.append(row);
    }
    clear(row);
    const pct = index !== undefined && total ? Math.round((index / total) * 100) : 0;
    row.append(
      el('div', { class: 'row', style: 'gap:8px' },
        el('strong', { style: 'min-width:220px', text: rec.fileName }),
        el('span', { class: 'small muted', text: p.message ?? p.kind }),
      ),
      el('div', { class: 'progress' }, el('div', { style: `width:${pct}%` })),
    );
  }

  private async renderTable(recs: Recording[]): Promise<void> {
    const existing = this.host.querySelector('.rec-table-card');
    existing?.remove();
    const card = el('div', { class: 'card rec-table-card' });
    card.append(el('h2', { text: '分析结果' }));
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '文件' }),
      el('th', { class: 'num', text: '时长' }),
      el('th', { text: '状态' }),
      el('th', { class: 'num', text: '检出片段' }),
      el('th', { class: 'num', text: '风/雨段' }),
      el('th', { class: 'num', text: '埋点核对' }),
      el('th', { text: '操作' }),
    )));
    const tbody = el('tbody');
    for (const r of recs) {
      const [dets, weather] = await Promise.all([
        listDetections(r.id),
        listWeather(r.id),
      ]);
      const gtBadge = r.groundTruth
        ? await this.groundTruthBadge(r)
        : el('span', { class: 'muted small', text: '—' });
      const open = el('button', { text: '打开语谱图' }) as HTMLButtonElement;
      open.disabled = r.status !== 'analyzed';
      open.addEventListener('click', () =>
        navigate({ name: 'annotate', projectId: this.projectId, recordingId: r.id }));
      tbody.append(el('tr', {},
        el('td', { text: r.fileName }),
        el('td', { class: 'num', text: formatTime(r.durationSec) }),
        el('td', {}, el('span', { class: `pill status-${r.status}`, text: r.status })),
        el('td', { class: 'num', text: String(dets.length) }),
        el('td', { class: 'num', text: `${weather.filter((w) => w.kind === 'wind').length}/${weather.filter((w) => w.kind === 'rain').length}` }),
        el('td', {}, gtBadge),
        el('td', {}, open),
      ));
    }
    table.append(tbody);
    card.append(table);
    this.host.append(card);
  }

  /** Compare detections against embedded synthetic ground truth. */
  private async groundTruthBadge(r: Recording): Promise<HTMLElement> {
    if (!r.groundTruth) return el('span', { text: '' });
    const dets = await listDetections(r.id);
    let matched = 0;
    let maxErr = 0;
    for (const gt of r.groundTruth.calls) {
      const hit = dets.find((d) =>
        d.endSec >= gt.startSec && d.startSec <= gt.endSec);
      if (hit) {
        matched++;
        maxErr = Math.max(maxErr, Math.abs(hit.startSec - gt.startSec));
      }
    }
    const recall = matched / r.groundTruth.calls.length;
    const ok = maxErr <= 0.5 && recall >= 0.9;
    return el('span', {
      class: `pill ${ok ? 'high' : 'low'}`,
      text: `${matched}/${r.groundTruth.calls.length} 最大误差 ${maxErr.toFixed(3)}s`,
    });
  }
}
