import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Lockup, Spindle } from '../brand/logo';
import { useHub, useResource } from './hub-context';
import { LiveDot } from '../components/status';
import {
  IconAccounts,
  IconClose,
  IconMachines,
  IconMenu,
  IconMerge,
  IconMessages,
  IconMore,
  IconOverview,
  IconPerson,
  IconRuns,
  IconSelector,
  IconSettings,
  IconUsage,
  IconWork,
  IconWorkflow,
} from '../components/icons';

type NavItem = { key: string; to: string; label: string; icon: ComponentType<{ size?: number }>; match(path: string): boolean };

const projectNav = (projectId: string): NavItem[] => {
  const base = `/projects/${projectId}`;
  const rest = (p: string) => (p.startsWith(base) ? p.slice(base.length).replace(/\/$/, '') : null);
  return [
    { key: 'overview', to: base, label: 'Overview', icon: IconOverview, match: (p) => rest(p) === '' },
    { key: 'workflows', to: `${base}/workflows`, label: 'Workflows', icon: IconWorkflow, match: (p) => !!rest(p)?.startsWith('/workflows') },
    { key: 'runs', to: `${base}/runs`, label: 'Runs', icon: IconRuns, match: (p) => !!rest(p)?.startsWith('/runs') },
    { key: 'work', to: `${base}/work`, label: 'Work', icon: IconWork, match: (p) => rest(p) === '/work' },
    { key: 'messages', to: `${base}/messages`, label: 'Messages', icon: IconMessages, match: (p) => !!rest(p)?.startsWith('/messages') },
    { key: 'merge', to: `${base}/merge-queue`, label: 'Merge queue', icon: IconMerge, match: (p) => !!rest(p)?.startsWith('/merge-queue') },
  ];
};

const FACTORY_NAV: NavItem[] = [
  { key: 'machines', to: '/machines', label: 'Machines', icon: IconMachines, match: (p) => p.startsWith('/machines') },
  { key: 'accounts', to: '/accounts', label: 'Accounts', icon: IconAccounts, match: (p) => p.startsWith('/accounts') },
  { key: 'usage', to: '/usage', label: 'Usage', icon: IconUsage, match: (p) => p.startsWith('/usage') },
];

const LAST_PROJECT = 'perpeto.lastProject';

/** The project in the URL, or the last one visited, so the navigation stays put on factory pages. */
function useCurrentProject(pathname: string): string | null {
  const fromPath = /^\/projects\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const [last, setLast] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_PROJECT);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!fromPath || fromPath === last) return;
    setLast(fromPath);
    try {
      localStorage.setItem(LAST_PROJECT, fromPath);
    } catch {
      /* storage unavailable */
    }
  }, [fromPath, last]);
  return fromPath ?? last;
}

function NavLink({ item, pathname, end, onNavigate }: { item: NavItem; pathname: string; end?: React.ReactNode; onNavigate?: () => void }) {
  const current = item.match(pathname);
  const Icon = item.icon;
  return (
    // Paths come from the route table above; the cast only satisfies the typed router.
    <Link to={item.to as '/'} className="nav-link" aria-current={current ? 'page' : undefined} onClick={onNavigate}>
      <Icon size={18} />
      <span>{item.label}</span>
      {end}
    </Link>
  );
}

function ProjectSwitcher({ projectId, onNavigate }: { projectId: string | null; onNavigate?: () => void }) {
  const project = useResource((api) => (projectId ? api.getProject(projectId) : Promise.resolve(null)), [projectId]);
  const p = project.data;
  const owner = p ? (/github\.com\/([^/]+)/.exec(p.repo.url)?.[1] ?? p.repo.defaultBranch) : '';
  return (
    <Link to="/" className="switcher" onClick={onNavigate} aria-label={p ? `Project ${p.name}. Switch project` : 'All projects'}>
      <span className="switcher-tile" aria-hidden="true">
        {p ? p.name.slice(0, 1).toLowerCase() : <IconOverview size={16} />}
      </span>
      <span className="switcher-text">
        <span className="switcher-name">{p?.name ?? 'All projects'}</span>
        <span className="switcher-sub">{p ? owner : 'Choose a project'}</span>
      </span>
      <IconSelector size={16} />
    </Link>
  );
}

/** Live dot on Runs while a run is running; open entries beside Merge queue. */
function useProjectSignals(projectId: string | null) {
  const runs = useResource((api) => (projectId ? api.listRuns(projectId) : Promise.resolve([])), [projectId], (e) => !!projectId && e.projectId === projectId && e.type.startsWith('run'));
  const queue = useResource(
    (api) => (projectId ? api.mergeQueue(projectId) : Promise.resolve([])),
    [projectId],
    (e) => !!projectId && e.projectId === projectId && e.subject.kind === 'merge-entry',
  );
  return {
    live: !!runs.data?.some((r) => r.status === 'running'),
    queue: queue.data?.filter((e) => e.status === 'queued' || e.status === 'testing' || e.status === 'merging').length ?? 0,
  };
}

function Navigation({ pathname, projectId, onNavigate }: { pathname: string; projectId: string | null; onNavigate?: () => void }) {
  const signals = useProjectSignals(projectId);
  return (
    <>
      <ProjectSwitcher projectId={projectId} onNavigate={onNavigate} />
      {projectId && (
        <nav className="nav" aria-label="Project">
          {projectNav(projectId).map((item) => (
            <NavLink
              key={item.key}
              item={item}
              pathname={pathname}
              onNavigate={onNavigate}
              end={item.key === 'runs' && signals.live ? <LiveDot label="A run is live" /> : item.key === 'merge' && signals.queue > 0 ? <span className="count">{signals.queue}</span> : undefined}
            />
          ))}
        </nav>
      )}
      <nav className="nav" aria-label="Factory">
        <h2 className="nav-title">Factory</h2>
        {FACTORY_NAV.map((item) => (
          <NavLink key={item.key} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </nav>
    </>
  );
}

function AccountRow({ onNavigate }: { onNavigate?: () => void }) {
  const { api, stream, settings } = useHub();
  const host = settings ? new URL(settings.baseUrl).host : '';
  const state = stream === 'live' ? 'Live' : stream === 'polling' ? 'Polling' : stream === 'reconnecting' ? 'Reconnecting' : stream === 'closed' ? 'Disconnected' : 'Connecting';
  return (
    <Link to="/settings" className="sidebar-foot" onClick={onNavigate} aria-label="Settings">
      <span className="avatar" aria-hidden="true">
        <IconPerson size={16} />
      </span>
      <span className="row-main">
        <span className="row-title">Owner</span>
        <span className="row-meta">
          {api.mode === 'demo' ? (
            'Demo data'
          ) : (
            <>
              {state} · <span className="mono">{host}</span>
            </>
          )}
        </span>
      </span>
      <IconSettings size={18} />
    </Link>
  );
}

/** The floating tab bar on narrow screens mirrors the iOS tabs. */
function TabBar({ pathname, projectId, onMore }: { pathname: string; projectId: string | null; onMore(): void }) {
  const items = projectId ? projectNav(projectId).filter((i) => ['overview', 'runs', 'work', 'messages'].includes(i.key)) : FACTORY_NAV;
  return (
    <nav className="tabbar" aria-label="Sections">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link key={item.key} to={item.to as '/'} aria-current={item.match(pathname) ? 'page' : undefined}>
            <Icon size={22} />
            {item.label}
          </Link>
        );
      })}
      <button type="button" onClick={onMore}>
        <IconMore size={22} />
        More
      </button>
    </nav>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projectId = useCurrentProject(pathname);
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Navigation">
        <Link to="/" className="brand" aria-label="perpeto, all projects">
          <Lockup height={34} />
        </Link>
        <Navigation pathname={pathname} projectId={projectId} />
        <AccountRow />
      </aside>
      <div className="topbar">
        <Link to="/" className="topbar-mark" aria-label="perpeto, all projects">
          <Spindle size={24} />
        </Link>
        <button type="button" className="btn btn-secondary btn-sm btn-icon" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(true)}>
          <IconMenu size={18} />
        </button>
      </div>
      {menu && (
        <div className="menu-scrim" onClick={() => setMenu(false)}>
          <div className="menu-sheet" role="dialog" aria-modal="true" aria-label="Navigation" onClick={(e) => e.stopPropagation()}>
            <div className="menu-head">
              <Lockup height={30} />
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close menu" onClick={() => setMenu(false)}>
                <IconClose size={18} />
              </button>
            </div>
            <Navigation pathname={pathname} projectId={projectId} onNavigate={() => setMenu(false)} />
            <AccountRow onNavigate={() => setMenu(false)} />
          </div>
        </div>
      )}
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <TabBar pathname={pathname} projectId={projectId} onMore={() => setMenu(true)} />
    </div>
  );
}
