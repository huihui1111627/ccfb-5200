import { parseHash, Route } from './router';
import { ProjectsPage } from './pages/projects';
import { ImportPage } from './pages/import';
import { DetectPage } from './pages/detect';
import { AnnotatePage } from './pages/annotate';
import { ExportPage } from './pages/export';
import { el, clear } from './util';
import { requestPersistence } from './db';

const NAV: Array<{ key: Route['name']; label: string; needsProject: boolean }> = [
  { key: 'projects', label: '项目', needsProject: false },
  { key: 'import', label: '导入', needsProject: true },
  { key: 'detect', label: '检测', needsProject: true },
  { key: 'annotate', label: '标注', needsProject: true },
  { key: 'export', label: '导出', needsProject: true },
];

export class App {
  private host: HTMLElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private currentProjectId?: string;

  constructor(host: HTMLElement) {
    this.host = host;
    this.nav = el('nav', { class: 'topnav' });
    this.content = el('main', { class: 'content' });
    this.host.append(this.nav, this.content);
    window.addEventListener('hashchange', () => this.render());
  }

  setProject(projectId: string | undefined): void {
    this.currentProjectId = projectId;
    this.render();
  }

  async render(): Promise<void> {
    const route = parseHash(location.hash || '#/projects');
    if (route.name !== 'projects' && 'projectId' in route) {
      this.currentProjectId = route.projectId;
    }
    this.renderNav(route);
    clear(this.content);
    try {
      switch (route.name) {
        case 'projects':
          new ProjectsPage(this.content, this).mount();
          break;
        case 'import':
          new ImportPage(this.content, this, route.projectId).mount();
          break;
        case 'detect':
          new DetectPage(this.content, this, route.projectId).mount();
          break;
        case 'annotate':
          new AnnotatePage(this.content, this, route.projectId, route.recordingId).mount();
          break;
        case 'export':
          new ExportPage(this.content, this, route.projectId).mount();
          break;
      }
    } catch (err) {
      this.content.append(
        el('div', { class: 'error-banner', text: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  private renderNav(route: Route): void {
    clear(this.nav);
    this.nav.append(el('div', { class: 'brand', text: '🐦 鸟鸣筛查台' }));
    for (const item of NAV) {
      const disabled = item.needsProject && !this.currentProjectId;
      const active = route.name === item.key;
      const link = el('a', {
        class: `navlink ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`,
        text: item.label,
      });
      if (!disabled) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (item.key === 'projects') location.hash = '#/projects';
          else if (this.currentProjectId) location.hash = `#/${item.key}/${this.currentProjectId}`;
        });
      }
      this.nav.append(link);
    }
    if (this.currentProjectId) {
      this.nav.append(el('span', { class: 'nav-project', text: `项目 ${this.currentProjectId.slice(0, 8)}` }));
    }
  }
}

export function bootstrap(): void {
  const host = document.getElementById('app');
  if (!host) throw new Error('#app root missing');
  const app = new App(host);
  void requestPersistence();
  void app.render();
}
