import { el, clear, formatBytes, formatClock, formatTime } from '../util';
import { listRecordings, deleteRecording, putRecording } from '../db';
import { App } from '../app';
import { navigate } from '../router';
import { GroundTruth, Recording } from '../types';
import { importRecording, previewFile, readGroundTruth } from '../services/import-service';
import { synthesizeInBrowser } from '../services/synth-browser';

interface QueuedFile {
  file: File;
  preview?: Awaited<ReturnType<typeof previewFile>>;
  error?: string;
  groundTruth?: GroundTruth;
  status: 'queued' | 'previewing' | 'ready' | 'error' | 'imported';
}

export class ImportPage {
  private queue: QueuedFile[] = [];
  private listEl?: HTMLElement;

  constructor(
    private host: HTMLElement,
    private app: App,
    private projectId: string,
  ) {}

  async mount(): Promise<void> {
    this.host.append(el('h1', { text: '录音导入' }));

    // ---- Synthetic generator ----------------------------------------------
    const synthCard = el('div', { class: 'card stack' });
    const durInput = el('input', { type: 'number', min: '30', max: '28800', value: '600', style: 'width:110px' }) as HTMLInputElement;
    const cpmInput = el('input', { type: 'number', min: '1', max: '20', value: '3', style: 'width:80px' }) as HTMLInputElement;
    const genBtn = el('button', { class: 'primary', text: '生成并导入合成测试录音' }) as HTMLButtonElement;
    const synthStatus = el('div', { class: 'muted small' });
    synthCard.append(
      el('h2', { text: '合成测试录音（含已知埋点）' }),
      el('div', { class: 'row' },
        el('label', { class: 'small muted', text: '时长(秒)' }), durInput,
        el('label', { class: 'small muted', text: '鸣声/分钟' }), cpmInput,
        genBtn,
      ),
      el('div', { class: 'muted small', text: '确定性种子生成，内含已知时间点的 FM 扫频/颤鸣、风噪段与雨噪段；埋点写入录音记录，用于核对 0.5 秒检出误差。' }),
      synthStatus,
    );
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      synthStatus.textContent = '正在合成…';
      try {
        const durationSec = Math.max(30, Math.min(28800, Number(durInput.value) || 600));
        const callsPerMinute = Math.max(1, Math.min(20, Number(cpmInput.value) || 3));
        const { file, groundTruth } = await synthesizeInBrowser({
          durationSec,
          callsPerMinute,
          seed: 20260412,
        });
        synthStatus.textContent = `合成完成：${file.name}，${groundTruth.calls.length} 个埋点鸣声，开始导入…`;
        const preview = await previewFile(file);
        const rec = await importRecording(this.projectId, file, preview, groundTruth);
        synthStatus.textContent = `已导入 ${rec.fileName}，可前往「检测」页运行自动检出。`;
        this.refreshRecordingList();
      } catch (err) {
        synthStatus.textContent = `合成失败：${err instanceof Error ? err.message : String(err)}`;
      } finally {
        genBtn.disabled = false;
      }
    });
    this.host.append(synthCard);

    // ---- File drop zone -----------------------------------------------------
    const dropCard = el('div', { class: 'card stack' });
    const zone = el('div', { class: 'dropzone' }) as HTMLDivElement;
    zone.append(
      el('div', { style: 'font-size:15px;margin-bottom:6px', text: '拖拽 WAV / FLAC 到这里，或点击选择文件（可多选、可重复导入）' }),
      el('div', { class: 'small', text: '支持 8 小时长文件；仅读取头部与流式分块，不会一次性载入内存' }),
    );
    const fileInput = el('input', { type: 'file', accept: '.wav,.flac', multiple: true, style: 'display:none' }) as HTMLInputElement;
    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer) await this.enqueue(Array.from(e.dataTransfer.files));
    });
    fileInput.addEventListener('change', async () => {
      if (fileInput.files) await this.enqueue(Array.from(fileInput.files));
      fileInput.value = '';
    });
    dropCard.append(el('h2', { text: '批量导入野外录音' }), zone, fileInput);

    // Sidecar ground truth selection.
    const gtInput = el('input', { type: 'file', accept: '.json', style: 'display:none' }) as HTMLInputElement;
    let pendingGtTarget: QueuedFile | null = null;
    gtInput.addEventListener('change', async () => {
      if (gtInput.files && pendingGtTarget) {
        try {
          pendingGtTarget.groundTruth = await readGroundTruth(gtInput.files[0]);
          pendingGtTarget.status = 'ready';
          this.renderQueue();
        } catch (err) {
          pendingGtTarget.error = err instanceof Error ? err.message : String(err);
          pendingGtTarget.status = 'error';
          this.renderQueue();
        }
      }
      gtInput.value = '';
      pendingGtTarget = null;
    });

    this.queueEl = el('div', { class: 'stack' });
    const importAllBtn = el('button', { class: 'primary', text: '全部导入' }) as HTMLButtonElement;
    importAllBtn.addEventListener('click', async () => {
      importAllBtn.disabled = true;
      for (const item of this.queue) {
        if (item.status !== 'ready') continue;
        item.status = 'imported';
        await importRecording(this.projectId, item.file, item.preview!, item.groundTruth);
        this.renderQueue();
      }
      importAllBtn.disabled = false;
      this.refreshRecordingList();
    });
    dropCard.append(this.queueEl, el('div', {}, importAllBtn), gtInput);
    this.host.append(dropCard);

    this.listEl = el('div', { class: 'card' });
    this.host.append(this.listEl);
    this.refreshRecordingList();

    // Expose handler closure for sidecar button wiring.
    this.onPickGroundTruth = (target) => {
      pendingGtTarget = target;
      gtInput.click();
    };
  }

  private queueEl?: HTMLElement;
  private onPickGroundTruth: (q: QueuedFile) => void = () => {};

  private async enqueue(files: File[]): Promise<void> {
    for (const file of files) {
      if (!/\.(wav|flac)$/i.test(file.name)) continue;
      const item: QueuedFile = { file, status: 'previewing' };
      this.queue.push(item);
      this.renderQueue();
      try {
        item.preview = await previewFile(file);
        item.status = 'ready';
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
        item.status = 'error';
      }
      this.renderQueue();
    }
  }

  private renderQueue(): void {
    if (!this.queueEl) return;
    clear(this.queueEl);
    const pending = this.queue.filter((q) => q.status !== 'imported');
    if (!pending.length) return;
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '文件' }), el('th', { text: '格式' }),
      el('th', { class: 'num', text: '时长' }), el('th', { class: 'num', text: '大小' }),
      el('th', { text: '点位 / 时间' }), el('th', { text: '状态' }), el('th', { text: '' }),
    )));
    const tbody = el('tbody');
    for (const q of pending) {
      const p = q.preview;
      const remove = el('button', { class: 'danger', text: '移除' }) as HTMLButtonElement;
      remove.addEventListener('click', () => {
        this.queue = this.queue.filter((x) => x !== q);
        this.renderQueue();
      });
      const gtBtn = el('button', { text: q.groundTruth ? `埋点 ${q.groundTruth.calls.length} 个` : '关联埋点 JSON' }) as HTMLButtonElement;
      gtBtn.addEventListener('click', () => this.onPickGroundTruth(q));
      tbody.append(el('tr', {},
        el('td', { text: q.file.name }),
        el('td', { text: p?.format ?? '—' }),
        el('td', { class: 'num', text: p ? formatTime(p.durationSec) : '—' }),
        el('td', { class: 'num', text: formatBytes(q.file.size) }),
        el('td', { class: 'small', text: p ? `${p.meta.site ?? '未识别'} · ${p.meta.recordedAt ? formatClock(p.meta.recordedAt) : '未识别'}` : '—' }),
        el('td', {},
          q.status === 'error'
            ? el('span', { class: 'error-banner', style: 'display:inline-block;padding:2px 8px', text: q.error ?? '解析失败' })
            : el('span', { class: `pill status-${q.status === 'ready' ? 'analyzed' : 'analyzing'}`, text: q.status === 'previewing' ? '解析中' : q.status === 'ready' ? '待导入' : q.status }),
        ),
        el('td', {}, el('div', { class: 'row' }, gtBtn, remove)),
      ));
    }
    table.append(tbody);
    this.queueEl.append(table);
  }

  private async refreshRecordingList(): Promise<void> {
    if (!this.listEl) return;
    clear(this.listEl);
    const recs = await listRecordings(this.projectId);
    this.listEl.append(el('h2', { text: `已导入录音（${recs.length}）` }));
    if (!recs.length) {
      this.listEl.append(el('div', { class: 'muted', text: '暂无录音。' }));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { text: '文件' }), el('th', { text: '点位' }),
      el('th', { class: 'num', text: '时长' }), el('th', { class: 'num', text: '大小' }),
      el('th', { text: '录制开始' }), el('th', { text: '状态' }), el('th', { text: '操作' }),
    )));
    const tbody = el('tbody');
    for (const r of recs) {
      const del = el('button', { class: 'danger', text: '删除' }) as HTMLButtonElement;
      del.addEventListener('click', async () => {
        if (!confirm(`删除录音 ${r.fileName} 及其全部分析结果？`)) return;
        await deleteRecording(r.id);
        this.refreshRecordingList();
      });
      const edit = el('button', { text: '编辑点位' }) as HTMLButtonElement;
      edit.addEventListener('click', async () => {
        const site = prompt('点位编号', r.meta.site ?? '');
        if (site === null) return;
        r.meta.site = site || undefined;
        r.meta.tags['manual:site'] = site;
        r.meta.tagSources['manual:site'] = 'manual';
        await putRecording(r);
        this.refreshRecordingList();
      });
      tbody.append(el('tr', {},
        el('td', { text: r.fileName }),
        el('td', { text: r.meta.site ?? '—' }),
        el('td', { class: 'num', text: formatTime(r.durationSec) }),
        el('td', { class: 'num', text: formatBytes(r.size) }),
        el('td', { text: r.meta.recordedAt ? formatClock(r.meta.recordedAt) : '—' }),
        el('td', {}, el('span', { class: `pill status-${r.status}`, text: statusLabel(r) })),
        el('td', {}, el('div', { class: 'row' }, edit, del)),
      ));
    }
    table.append(tbody);
    this.listEl.append(table);
    const goDetect = el('button', { class: 'primary', text: '前往自动检测 →' }) as HTMLButtonElement;
    goDetect.addEventListener('click', () => navigate({ name: 'detect', projectId: this.projectId }));
    this.listEl.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('div', { class: 'spacer' }), goDetect));
  }
}

function statusLabel(r: Recording): string {
  switch (r.status) {
    case 'imported': return '待分析';
    case 'analyzing': return '分析中';
    case 'analyzed': return '已分析';
    case 'error': return `错误：${r.analyzeError ?? ''}`;
  }
}
