import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { Shell } from './shell';
import { NotFound } from '../routes/not-found';
import { Loading } from '../components/ui';

// Each screen loads on first visit, so the graph library and the editor stay
// out of the first download. NotFound stays in the main chunk.
const HomePage = lazyRouteComponent(() => import('../routes/home'), 'HomePage');
const ProjectsPage = lazyRouteComponent(() => import('../routes/projects'), 'ProjectsPage');
const SessionsPage = lazyRouteComponent(() => import('../routes/sessions'), 'SessionsPage');
const ProjectLayout = lazyRouteComponent(() => import('../routes/project-layout'), 'ProjectLayout');
const OverviewPage = lazyRouteComponent(() => import('../routes/overview'), 'OverviewPage');
const WorkflowsPage = lazyRouteComponent(() => import('../routes/workflows'), 'WorkflowsPage');
const WorkflowPage = lazyRouteComponent(() => import('../routes/workflow'), 'WorkflowPage');
const EditorPage = lazyRouteComponent(() => import('../routes/editor'), 'EditorPage');
const RunsPage = lazyRouteComponent(() => import('../routes/runs'), 'RunsPage');
const RunPage = lazyRouteComponent(() => import('../routes/run'), 'RunPage');
const WorkPage = lazyRouteComponent(() => import('../routes/work'), 'WorkPage');
const MessagesPage = lazyRouteComponent(() => import('../routes/messages'), 'MessagesPage');
const MergeQueuePage = lazyRouteComponent(() => import('../routes/merge-queue'), 'MergeQueuePage');
const CiPage = lazyRouteComponent(() => import('../routes/ci'), 'CiPage');
const CiRunPage = lazyRouteComponent(() => import('../routes/ci-run'), 'CiRunPage');
const MachinesPage = lazyRouteComponent(() => import('../routes/machines'), 'MachinesPage');
const AccountsPage = lazyRouteComponent(() => import('../routes/accounts'), 'AccountsPage');
const PacingPage = lazyRouteComponent(() => import('../routes/pacing'), 'PacingPage');
const StoragePage = lazyRouteComponent(() => import('../routes/storage'), 'StoragePage');
const UsagePage = lazyRouteComponent(() => import('../routes/usage'), 'UsagePage');
const SettingsPage = lazyRouteComponent(() => import('../routes/settings'), 'SettingsPage');

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });

// Home: the factory in observe-only mode (no projects), else the project list.
const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });
const projects = createRoute({ getParentRoute: () => root, path: '/projects', component: ProjectsPage });
const project = createRoute({ getParentRoute: () => root, path: '/projects/$projectId', component: ProjectLayout });
const overview = createRoute({ getParentRoute: () => project, path: '/', component: OverviewPage });
const workflows = createRoute({ getParentRoute: () => project, path: '/workflows', component: WorkflowsPage });
const workflow = createRoute({
  getParentRoute: () => project,
  path: '/workflows/$workflowId',
  component: WorkflowPage,
  validateSearch: (search: Record<string, unknown>): { version?: number; follow?: string } => ({
    version: search.version ? Number(search.version) : undefined,
    follow: typeof search.follow === 'string' ? search.follow : undefined,
  }),
});
const editor = createRoute({ getParentRoute: () => project, path: '/workflows/$workflowId/edit', component: EditorPage });
const runs = createRoute({ getParentRoute: () => project, path: '/runs', component: RunsPage });
const run = createRoute({
  getParentRoute: () => project,
  path: '/runs/$runId',
  component: RunPage,
  // `node` selects a step and brings it into view ("Show on map" from the overview).
  validateSearch: (search: Record<string, unknown>): { node?: string } => ({ node: typeof search.node === 'string' ? search.node : undefined }),
});
const work = createRoute({ getParentRoute: () => project, path: '/work', component: WorkPage });
const messages = createRoute({
  getParentRoute: () => project,
  path: '/messages',
  component: MessagesPage,
  validateSearch: (search: Record<string, unknown>): { channel?: string } => ({ channel: typeof search.channel === 'string' ? search.channel : undefined }),
});
const mergeQueue = createRoute({ getParentRoute: () => project, path: '/merge-queue', component: MergeQueuePage });
const ci = createRoute({ getParentRoute: () => project, path: '/ci', component: CiPage });
const ciRun = createRoute({ getParentRoute: () => project, path: '/ci/$runId', component: CiRunPage });
const sessions = createRoute({ getParentRoute: () => root, path: '/sessions', component: SessionsPage });
const machines = createRoute({ getParentRoute: () => root, path: '/machines', component: MachinesPage });
const accounts = createRoute({ getParentRoute: () => root, path: '/accounts', component: AccountsPage });
const pacing = createRoute({ getParentRoute: () => root, path: '/pacing', component: PacingPage });
const storage = createRoute({
  getParentRoute: () => root,
  path: '/storage',
  component: StoragePage,
  validateSearch: (search: Record<string, unknown>): { machine?: string } => ({ machine: typeof search.machine === 'string' ? search.machine : undefined }),
});
const usage = createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage });
const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });

const tree = root.addChildren([
  home,
  projects,
  project.addChildren([overview, workflows, workflow, editor, runs, run, work, messages, mergeQueue, ci, ciRun]),
  sessions,
  machines,
  accounts,
  pacing,
  usage,
  storage,
  settings,
]);

export const router = createRouter({
  routeTree: tree,
  defaultPreload: 'intent',
  // Shown only if a screen's code takes longer than a moment to arrive.
  defaultPendingMs: 400,
  defaultPendingComponent: () => <Loading label="Loading this screen" />,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
