import { el, clear, formatTime } from '../util';
import { Annotation, Detection, Recording } from '../types';
import {
  listAnnotations,
  listDetections,
  listRecordings,
  listWeather,
} from '../db';
import { App } from '../app';
import {
  buildCsv,
  buildRavenTable,
  downloadTextFile,
  mergeExportRows,
} from '../export';

export class ExportPage {
  private includeUnannotated = true;
  private onlyClearWeather = false;
  private selectedIds = new Set<string>();

  constructor(
    private host: HTMLElement,
    private app: App,
    private projectId: string,
  ) {}

  async mount(): Promise<void> {
    const recs = await listRecordings(this.projectId);
    this.host.append(el('h1', { text: '标注导出' }));
    if (!recs.length) {
      this.host.append(el('div', { class: 'card muted', text: '暂无录音。' }));
      return;
    }
    if (!this.selectedIds.size) recs.forEach((r) => this.selectedIds.add(r.id));

    // ---- Recording picker ---------------------------------------------------
    const pickCard = el('div', { class: 'card stack' });
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '' }), el('th', { text: '文件' }),
      el('th', { class: 'num', text: '时长' }),
      el('th', { class: 'num', text: '检出' }),
      el('th', { class: 'num', text: '标注' }),
      el('th', { class: 'num', text: '天气段' }),
    )));
    const tbody = el('tbody');
    for (const r of recs) {
      const [dets, anns, weather] = await Promise.all([
        listDetections(r.id), listAnnotations(r.id), listWeather(r.id),
      ]);
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = this.selectedIds.has(r.id);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedIds.add(r.id);
        else this.selectedIds.delete(r.id);
      });
      tbody.append(el('tr', {},
        el('td', {}, cb),
        el('td', { text: r.fileName }),
        el('td', { class: 'num', text: formatTime(r.durationSec) }),
        el('td', { class: 'num', text: String(dets.length) }),
        el('td', { class: 'num', text: String(anns.length) }),
        el('td', { class: 'num', text: String(weather.length) }),
      ));
    }
    table.append(tbody);
    pickCard.append(table);
    this.host.append(pickCard);

    // ---- Options + actions --------------------------------------------------
    const optCard = el('div', { class: 'card stack' });
    const cbUn = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cbUn.checked = this.includeUnannotated;
    cbUn.addEventListener('change', () => (this.includeUnannotated = cbUn.checked));
    const cbWeather = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cbWeather.checked = this.onlyClearWeather;
    cbWeather.addEventListener('change', () => (this.onlyClearWeather = cbWeather.checked));
    optCard.append(
      el('div', { class: 'row' },
        cbUn, el('label', { text: '包含尚未人工标注的自动检出片段（物种列留空）' }),
      ),
      el('div', { class: 'row' },
        cbWeather, el('label', { text: '排除风/雨天气段内的片段' }),
      ),
      el('div', { class: 'muted small', text: 'CSV 含绝对时间、点位与录音机字段；Raven 表为 Raven Pro 1.6 兼容的制表符选择表。' }),
    );

    const csvBtn = el('button', { class: 'primary', text: '导出 CSV' }) as HTMLButtonElement;
    const ravenBtn = el('button', { class: 'primary', text: '导出 Raven 选择表' }) as HTMLButtonElement;
    csvBtn.addEventListener('click', () => this.exportCsv(recs));
    ravenBtn.addEventListener('click', () => this.exportRaven(recs));
    optCard.append(el('div', { class: 'row' }, csvBtn, ravenBtn));

    // Ground truth export for synthetic test recordings.
    const gtRecs = recs.filter((r) => r.groundTruth);
    if (gtRecs.length) {
      const gtBtn = el('button', { text: '导出合成埋点 Ground Truth (JSON)' }) as HTMLButtonElement;
      gtBtn.addEventListener('click', () => {
        const payload = Object.fromEntries(gtRecs.map((r) => [r.fileName, r.groundTruth]));
        downloadTextFile(JSON.stringify(payload, null, 2), 'ground-truth.json', 'application/json');
      });
      optCard.append(gtBtn);
    }
    this.host.append(optCard);

    // Preview table.
    const previewCard = el('div', { class: 'card' });
    previewCard.append(el('h2', { text: '导出预览（前 50 行）' }));
    const preview = el('div');
    previewCard.append(preview);
    this.previewEl = preview;
    this.host.append(previewCard);
    void this.renderPreview(recs);
  }

  private previewEl?: HTMLElement;

  private async collect(recs: Recording[]): Promise<{
    rows: ReturnType<typeof mergeExportRows>;
    recMap: Map<string, Recording>;
    weatherByRec: Map<string, Array<{ startSec: number; endSec: number }>>;
  }> {
    const chosen = recs.filter((r) => this.selectedIds.has(r.id));
    const recMap = new Map(chosen.map((r) => [r.id, r]));
    const weatherByRec = new Map<string, Array<{ startSec: number; endSec: number }>>();
    let allAnns: Annotation[] = [];
    let allDets: Detection[] = [];
    for (const r of chosen) {
      const [anns, dets, weather] = await Promise.all([
        listAnnotations(r.id), listDetections(r.id), listWeather(r.id),
      ]);
      allAnns = allAnns.concat(anns);
      allDets = allDets.concat(dets);
      weatherByRec.set(r.id, weather.map((w) => ({ startSec: w.startSec, endSec: w.endSec })));
    }
    let rows = mergeExportRows(allAnns, allDets);
    if (!this.includeUnannotated) rows = rows.filter((x) => x.annotation);
    if (this.onlyClearWeather) {
      rows = rows.filter((x) => {
        const id = x.annotation?.recordingId ?? x.detection?.recordingId ?? '';
        const start = x.annotation?.startSec ?? x.detection?.startSec ?? 0;
        const end = x.annotation?.endSec ?? x.detection?.endSec ?? 0;
        const segs = weatherByRec.get(id) ?? [];
        return !segs.some((s) => end >= s.startSec && start <= s.endSec);
      });
    }
    return { rows, recMap, weatherByRec };
  }

  private async exportCsv(recs: Recording[]): Promise<void> {
    const { rows, recMap } = await this.collect(recs);
    if (!rows.length) return alert('没有可导出的行。');
    const csv = buildCsv(rows, recMap);
    downloadTextFile(csv, `bird-screening-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
    this.renderPreview(recs);
  }

  private async exportRaven(recs: Recording[]): Promise<void> {
    const { rows, recMap } = await this.collect(recs);
    if (!rows.length) return alert('没有可导出的行。');
    const txt = buildRavenTable(rows, recMap);
    downloadTextFile(txt, `raven-selections-${new Date().toISOString().slice(0, 10)}.txt`, 'text/plain');
    this.renderPreview(recs);
  }

  private async renderPreview(recs: Recording[]): Promise<void> {
    if (!this.previewEl) return;
    clear(this.previewEl);
    const { rows, recMap } = await this.collect(recs);
    if (!rows.length) {
      this.previewEl.append(el('div', { class: 'muted', text: '无数据。' }));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '录音' }), el('th', { text: '类型' }),
      el('th', { class: 'num', text: '起(s)' }), el('th', { class: 'num', text: '止(s)' }),
      el('th', { class: 'num', text: '低Hz' }), el('th', { class: 'num', text: '高Hz' }),
      el('th', { text: '物种' }), el('th', { text: '置信' }),
    )));
    const tbody = el('tbody');
    for (const row of rows.slice(0, 50)) {
      const a = row.annotation;
      const d = row.detection;
      const recId = a?.recordingId ?? d?.recordingId ?? '';
      tbody.append(el('tr', {},
        el('td', { class: 'small', text: recMap.get(recId)?.fileName ?? recId }),
        el('td', { text: a ? '人工' : '自动' }),
        el('td', { class: 'num', text: (a?.startSec ?? d?.startSec ?? 0).toFixed(3) }),
        el('td', { class: 'num', text: (a?.endSec ?? d?.endSec ?? 0).toFixed(3) }),
        el('td', { class: 'num', text: String(Math.round(a?.lowHz ?? d?.lowHz ?? 0)) }),
        el('td', { class: 'num', text: String(Math.round(a?.highHz ?? d?.highHz ?? 0)) }),
        el('td', { text: a?.species ?? '' }),
        el('td', { text: d?.confidence ?? '' }),
      ));
    }
    table.append(tbody);
    this.previewEl.append(table, el('div', { class: 'muted small', style: 'margin-top:8px', text: `共 ${rows.length} 行，预览前 50 行。` }));
  }
}
