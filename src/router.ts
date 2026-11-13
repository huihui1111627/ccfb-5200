export type Route =
  | { name: 'projects' }
  | { name: 'import'; projectId: string }
  | { name: 'detect'; projectId: string }
  | { name: 'annotate'; projectId: string; recordingId?: string }
  | { name: 'export'; projectId: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  const projectId = rest[0] ?? '';
  switch (name) {
    case 'import':
      return { name: 'import', projectId };
    case 'detect':
      return { name: 'detect', projectId };
    case 'annotate':
      return { name: 'annotate', projectId, recordingId: rest[1] || undefined };
    case 'export':
      return { name: 'export', projectId };
    case 'projects':
    default:
      return { name: 'projects' };
  }
}

export function buildHash(route: Route): string {
  switch (route.name) {
    case 'projects':
      return '#/projects';
    case 'import':
      return `#/import/${route.projectId}`;
    case 'detect':
      return `#/detect/${route.projectId}`;
    case 'annotate':
      return `#/annotate/${route.projectId}${route.recordingId ? `/${route.recordingId}` : ''}`;
    case 'export':
      return `#/export/${route.projectId}`;
  }
}

export function navigate(route: Route): void {
  location.hash = buildHash(route);
}
