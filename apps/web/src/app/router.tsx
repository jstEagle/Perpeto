import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './shell';
import { ProjectsPage } from '../routes/projects';
import { ProjectLayout } from '../routes/project-layout';
import { OverviewPage } from '../routes/overview';
import { WorkflowsPage } from '../routes/workflows';
import { WorkflowPage } from '../routes/workflow';
import { EditorPage } from '../routes/editor';
import { RunsPage } from '../routes/runs';
import { RunPage } from '../routes/run';
import { WorkPage } from '../routes/work';
import { MessagesPage } from '../routes/messages';
import { MergeQueuePage } from '../routes/merge-queue';
import { MachinesPage } from '../routes/machines';
import { AccountsPage } from '../routes/accounts';
import { UsagePage } from '../routes/usage';
import { SettingsPage } from '../routes/settings';
import { NotFound } from '../routes/not-found';

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const projects = createRoute({ getParentRoute: () => root, path: '/', component: ProjectsPage });
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
const run = createRoute({ getParentRoute: () => project, path: '/runs/$runId', component: RunPage });
const work = createRoute({ getParentRoute: () => project, path: '/work', component: WorkPage });
const messages = createRoute({
  getParentRoute: () => project,
  path: '/messages',
  component: MessagesPage,
  validateSearch: (search: Record<string, unknown>): { channel?: string } => ({ channel: typeof search.channel === 'string' ? search.channel : undefined }),
});
const mergeQueue = createRoute({ getParentRoute: () => project, path: '/merge-queue', component: MergeQueuePage });
const machines = createRoute({ getParentRoute: () => root, path: '/machines', component: MachinesPage });
const accounts = createRoute({ getParentRoute: () => root, path: '/accounts', component: AccountsPage });
const usage = createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage });
const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });

const tree = root.addChildren([
  projects,
  project.addChildren([overview, workflows, workflow, editor, runs, run, work, messages, mergeQueue]),
  machines,
  accounts,
  usage,
  settings,
]);

export const router = createRouter({ routeTree: tree, defaultPreload: false, scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
