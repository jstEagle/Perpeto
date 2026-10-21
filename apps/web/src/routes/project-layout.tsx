import { Link, Outlet, useParams, useRouterState } from '@tanstack/react-router';
import { useResource } from '../app/hub-context';
import { Async, Mono } from '../components/ui';
import { repoName, tokens } from '../lib/format';

const SECTIONS = [
  { to: '/projects/$projectId', label: 'Overview', match: (rest: string) => rest === '' },
  { to: '/projects/$projectId/workflows', label: 'Workflows', match: (rest: string) => rest.startsWith('/workflows') },
  { to: '/projects/$projectId/runs', label: 'Runs', match: (rest: string) => rest.startsWith('/runs') },
  { to: '/projects/$projectId/work', label: 'Work', match: (rest: string) => rest.startsWith('/work') && !rest.startsWith('/workflows') },
  { to: '/projects/$projectId/messages', label: 'Messages', match: (rest: string) => rest.startsWith('/messages') },
  { to: '/projects/$projectId/merge-queue', label: 'Merge queue', match: (rest: string) => rest.startsWith('/merge-queue') },
] as const;

export function ProjectLayout() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const rest = pathname.replace(`/projects/${projectId}`, '').replace(/\/$/, '');
  const project = useResource((api) => api.getProject(projectId), [projectId], (e) => e.subject.kind === 'project' && e.subject.id === projectId);
  const overview = useResource(
    (api) => api.overview(projectId),
    [projectId],
    (e) => e.projectId === projectId && (e.type.startsWith('assignment') || e.type.startsWith('run') || e.type === 'usage.recorded'),
  );

  return (
    <div className="project-layout">
      <aside className="project-side" aria-label="Project">
        <Async resource={project} what="project">
          {(p) => (
            <div className="project-ident">
              <Link to="/projects/$projectId" params={{ projectId }} className="project-name" activeOptions={{ exact: true }} activeProps={{}}>
                {p.name}
              </Link>
              <Mono title={p.repo.url}>{repoName(p.repo.url)}</Mono>
            </div>
          )}
        </Async>
        <nav className="side-nav" aria-label="Project sections">
          {SECTIONS.map((s) => (
            <Link key={s.to} to={s.to} params={{ projectId }} className="side-link" activeOptions={{ exact: s.label === 'Overview' }} data-current={s.match(rest) || undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        <dl className="side-counts" aria-label="Project activity" aria-live="polite">
          <div>
            <dt>Agents working</dt>
            <dd>{overview.data ? overview.data.activeAgents : '—'}</dd>
          </div>
          <div>
            <dt>Queued work</dt>
            <dd>{overview.data ? overview.data.queuedWork : '—'}</dd>
          </div>
          <div>
            <dt>Tokens today</dt>
            <dd>{overview.data ? tokens(overview.data.tokensToday) : '—'}</dd>
          </div>
        </dl>
      </aside>
      <div className="project-main">
        <Outlet />
      </div>
    </div>
  );
}
