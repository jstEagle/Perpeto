/**
 * Sidebar sections and which one a route belongs to. Pure, so the rule
 * "exactly one current item per route" is testable without a browser.
 */
export type NavKey = 'overview' | 'workflows' | 'runs' | 'work' | 'messages' | 'merge' | 'machines' | 'accounts' | 'usage';

export interface NavEntry {
  key: NavKey;
  to: string;
  label: string;
}

export const projectNavEntries = (projectId: string): NavEntry[] => {
  const base = `/projects/${projectId}`;
  return [
    { key: 'overview', to: base, label: 'Overview' },
    { key: 'workflows', to: `${base}/workflows`, label: 'Workflows' },
    { key: 'runs', to: `${base}/runs`, label: 'Runs' },
    { key: 'work', to: `${base}/work`, label: 'Work' },
    { key: 'messages', to: `${base}/messages`, label: 'Messages' },
    { key: 'merge', to: `${base}/merge-queue`, label: 'Merge queue' },
  ];
};

export const FACTORY_NAV_ENTRIES: NavEntry[] = [
  { key: 'machines', to: '/machines', label: 'Machines' },
  { key: 'accounts', to: '/accounts', label: 'Accounts' },
  { key: 'usage', to: '/usage', label: 'Usage' },
];

/** The one section a path belongs to, or null (all projects, settings, not found). */
export function activeNav(pathname: string): NavKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const project = /^\/projects\/[^/]+(\/.*)?$/.exec(path);
  if (project) {
    const rest = project[1] ?? '';
    if (rest === '') return 'overview';
    const section = rest.split('/')[1];
    return ({ workflows: 'workflows', runs: 'runs', work: 'work', messages: 'messages', 'merge-queue': 'merge' } as Record<string, NavKey>)[section] ?? null;
  }
  const factory = path.split('/')[1];
  return factory === 'machines' || factory === 'accounts' || factory === 'usage' ? factory : null;
}
