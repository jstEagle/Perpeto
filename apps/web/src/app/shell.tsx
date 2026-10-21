import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Lockup } from '../brand/logo';
import { useHub } from './hub-context';
import { StatusLabel } from '../components/status';
import { IconSettings } from '../components/icons';

const FACTORY_NAV = [
  { to: '/', label: 'Projects', exact: false, match: (p: string) => p === '/' || p.startsWith('/projects') },
  { to: '/machines', label: 'Machines', match: (p: string) => p.startsWith('/machines') },
  { to: '/accounts', label: 'Accounts', match: (p: string) => p.startsWith('/accounts') },
  { to: '/usage', label: 'Usage', match: (p: string) => p.startsWith('/usage') },
] as const;

function ConnectionIndicator() {
  const { api, stream, settings } = useHub();
  if (api.mode === 'demo')
    return (
      <Link to="/settings" className="connection connection-demo" title="No hub is configured. Showing built-in example data.">
        <span className="connection-mark" aria-hidden="true" />
        Demo data
      </Link>
    );
  const host = settings ? new URL(settings.baseUrl).host : '';
  const tone = stream === 'live' ? 'success' : stream === 'polling' ? 'info' : stream === 'closed' ? 'neutral' : 'warning';
  const label = stream === 'live' ? 'Live' : stream === 'polling' ? 'Polling' : stream === 'reconnecting' ? 'Reconnecting' : stream === 'closed' ? 'Disconnected' : 'Connecting';
  return (
    <Link to="/settings" className="connection" title={`Hub at ${host}`}>
      <StatusLabel tone={tone}>{label}</StatusLabel>
      <span className="connection-host mono">{host}</span>
    </Link>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand-link" aria-label="perpeto, projects" activeOptions={{ exact: true }}>
          <Lockup height={20} />
        </Link>
        <nav className="topnav" aria-label="Factory">
          {FACTORY_NAV.map((item) => (
            <Link key={item.to} to={item.to} className={`topnav-link ${item.match(pathname) ? 'is-current' : ''}`} activeOptions={{ exact: true }}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-end">
          <ConnectionIndicator />
          <Link to="/settings" className="icon-btn" aria-label="Settings">
            <IconSettings />
          </Link>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
