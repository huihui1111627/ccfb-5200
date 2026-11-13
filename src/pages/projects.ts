import { el, clear, uid, formatBytes, formatClock } from '../util';
import {
  deleteProject,
  listProjects,
  listRecordings,
  putProject,
  storageEstimate,
} from '../db';
import { Project } from '../types';
import { App } from '../app';
import { navigate } from '../router';

export class ProjectsPage {
  constructor(
    private host: HTMLElement,
    private app: App,
  ) {}

  async mount(): Promise<void> {
    const [projects, recordings, estimate] = await Promise.all([
      listProjects(),
      listRecordings(),
      storageEstimate(),
    ]);

    this.host.append(el('h1', { text: '调查项目' }));
    const createCard = el('div', { class: 'card stack' });
    const nameInput = el('input', { placeholder: '新项目名称，如：2026 春季点调-南岭', style: 'max-width:360px' }) as HTMLInputElement;
    const createBtn = el('button', { class: 'primary', text: '新建项目' }) as HTMLButtonElement;
    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const project: Project = { id: uid(), name, createdAt: Date.now() };
      await putProject(project);
      navigate({ name: 'import', projectId: project.id });
    });
    createCard.append(
      el('div', { class: 'row' }, nameInput, createBtn),
      estimate
        ? el('div', { class: 'muted small', text: `IndexedDB 已用 ${formatBytes(estimate.usage)} / 配额 ${formatBytes(estimate.quota)}（浏览器持久化存储，八小时录音可直接导入）` })
        : el('div', { class: 'muted small', text: '录音与分析结果存于浏览器 IndexedDB，不上传服务器' }),
    );
    this.host.append(createCard);

    if (!projects.length) {
      this.host.append(el('div', { class: 'card muted', text: '还没有项目，先在上方新建一个。' }));
      return;
    }

    const card = el('div', { class: 'card' });
    const table = el('table');
    table.append(
      el('thead', {}, el('tr', {},
        el('th', { text: '项目名称' }),
        el('th', { class: 'num', text: '录音数' }),
        el('th', { class: 'num', text: '总时长' }),
        el('th', { text: '创建时间' }),
        el('th', { text: '操作' }),
      )),
    );
    const tbody = el('tbody');
    for (const p of projects) {
      const recs = recordings.filter((r) => r.projectId === p.id);
      const totalSec = recs.reduce((s, r) => s + r.durationSec, 0);
      const open = el('button', { text: '打开' }) as HTMLButtonElement;
      open.addEventListener('click', () => navigate({ name: 'import', projectId: p.id }));
      const del = el('button', { class: 'danger', text: '删除' }) as HTMLButtonElement;
      del.addEventListener('click', async () => {
        if (!confirm(`删除项目「${p.name}」及其全部录音和标注？此操作不可恢复。`)) return;
        await deleteProject(p.id);
        this.mount();
      });
      tbody.append(el('tr', {},
        el('td', { text: p.name }),
        el('td', { class: 'num', text: String(recs.length) }),
        el('td', { class: 'num', text: formatDuration(totalSec) }),
        el('td', { text: formatClock(p.createdAt) }),
        el('td', {}, el('div', { class: 'row' }, open, del)),
      ));
    }
    table.append(tbody);
    card.append(table);
    this.host.append(card);
    clear; // mark import used intentionally in other pages
  }
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
