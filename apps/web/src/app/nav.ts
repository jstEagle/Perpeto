/**
 * Sidebar sections and which one a route belongs to. Pure, so the rule
 * "exactly one current item per route" is testable without a browser.
 */
export type NavKey = 'home' | 'sessions' | 'overview' | 'workflows' | 'runs' | 'work' | 'messages' | 'merge' | 'ci' | 'machines' | 'accounts' | 'pacing' | 'usage';

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
    { key: 'ci', to: `${base}/ci`, label: 'CI' },
  ];
};

/** Observe-only mode (no projects): the factory home takes the place of the project navigation. */
export const HOME_NAV_ENTRY: NavEntry = { key: 'home', to: '/', label: 'Home' };

export const FACTORY_NAV_ENTRIES: NavEntry[] = [
  { key: 'sessions', to: '/sessions', label: 'Sessions' },
  { key: 'machines', to: '/machines', label: 'Machines' },
  { key: 'accounts', to: '/accounts', label: 'Accounts' },
  { key: 'pacing', to: '/pacing', label: 'Pacing' },
  { key: 'usage', to: '/usage', label: 'Usage' },
];

/**
 * The one section a path belongs to, or null (settings, not found). `/` is
 * Home; it only appears in the navigation in observe-only mode, where it is
 * the factory home rather than the project list.
 */
export function activeNav(pathname: string): NavKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'home';
  const project = /^\/projects\/[^/]+(\/.*)?$/.exec(path);
  if (project) {
    const rest = project[1] ?? '';
    if (rest === '') return 'overview';
    const section = rest.split('/')[1];
    return ({ workflows: 'workflows', runs: 'runs', work: 'work', messages: 'messages', 'merge-queue': 'merge', ci: 'ci' } as Record<string, NavKey>)[section] ?? null;
  }
  const factory = path.split('/')[1];
  return factory === 'sessions' || factory === 'machines' || factory === 'accounts' || factory === 'pacing' || factory === 'usage' ? (factory as NavKey) : null;
}
