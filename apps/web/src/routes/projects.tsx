import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Project } from '../api/types';
import { Async, Button, Dialog, Empty, Field, Mono, PageHeader } from '../components/ui';
import { RunStatusLabel } from '../components/status';
import { IconChevronRight, IconPlus } from '../components/icons';
import { plural, relative, repoName, tokens } from '../lib/format';

export function ProjectsPage() {
  const projects = useResource((api) => api.listProjects(), [], (e) => e.subject.kind === 'project');
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        description="Each project is a repository with its docs, goals and the workflows that build it."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus /> Create project
          </Button>
        }
      />
      <Async resource={projects} what="projects">
        {(list) =>
          list.length === 0 ? (
            <div className="panel">
              <Empty title="No projects yet." action={<Button variant="primary" onClick={() => setCreating(true)}>Create project</Button>}>
                Add a repository to start planning work.
              </Empty>
            </div>
          ) : (
            <div className="table-wrap panel panel-flush">
              <table className="table table-rows-link">
                <caption className="visually-hidden">Projects</caption>
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" className="hide-sm">Goals</th>
                    <th scope="col">Activity</th>
                    <th scope="col" className="num hide-sm">Tokens today</th>
                    <th scope="col" className="hide-sm">Updated</th>
                    <th scope="col" className="col-chevron"><span className="visually-hidden">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <ProjectRow key={p.id} project={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const overview = useResource((api) => api.overview(project.id), [project.id], (e) => e.projectId === project.id && e.type.startsWith('assignment'));
  const runs = useResource((api) => api.listRuns(project.id), [project.id], (e) => e.projectId === project.id && e.type.startsWith('run'));
  const latest = runs.data?.[0];
  const agents = overview.data?.activeAgents;
  return (
    <tr>
      <td>
        <Link to="/projects/$projectId" params={{ projectId: project.id }} className="row-link">
          <span className="cell-title">{project.name}</span>
        </Link>
        <Mono>{repoName(project.repo.url)}</Mono>
      </td>
      <td className="hide-sm">
        {project.goals.length ? (
          <>
            <span className="cell-line">{project.goals[0]}</span>
            {project.goals.length > 1 && <span className="muted"> and {project.goals.length - 1} more</span>}
          </>
        ) : (
          <span className="muted">No goals yet</span>
        )}
      </td>
      <td>
        <div className="cell-stack">
          {latest ? <RunStatusLabel status={latest.status} /> : <span className="muted">No runs</span>}
          {agents !== undefined && agents > 0 && <span className="muted">{plural(agents, 'agent')} working</span>}
        </div>
      </td>
      <td className="num hide-sm">{overview.data ? tokens(overview.data.tokensToday) : '—'}</td>
      <td className="hide-sm muted">{relative(project.updatedAt)}</td>
      <td className="col-chevron" aria-hidden="true">
        <IconChevronRight />
      </td>
    </tr>
  );
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [goals, setGoals] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const nameError = touched && !name.trim() ? 'Enter a project name.' : null;
  const urlError = touched && !/^(https?:\/\/|git@|file:\/\/|\/)/.test(url.trim()) ? 'Enter a repository URL or local path.' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!name.trim() || !/^(https?:\/\/|git@|file:\/\/|\/)/.test(url.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        repo: { url: url.trim(), defaultBranch: branch.trim() || 'main' },
        goals: goals.split('\n').map((g) => g.trim()).filter(Boolean),
      });
      onClose();
      await navigate({ to: '/projects/$projectId/workflows', params: { projectId: project.id } });
    } catch (err) {
      setError(`Project was not created. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create project"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-project" busy={busy}>
            Create project
          </Button>
        </>
      }
    >
      <form id="create-project" className="form" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="p-name" error={nameError}>
          <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-invalid={!!nameError} />
        </Field>
        <Field label="Repository" htmlFor="p-url" error={urlError} hint="HTTPS or SSH URL, or a local path on the hub machine.">
          <input id="p-url" className="input mono-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo" autoComplete="off" spellCheck={false} aria-invalid={!!urlError} />
        </Field>
        <Field label="Default branch" htmlFor="p-branch">
          <input id="p-branch" className="input mono-input" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Goals" htmlFor="p-goals" hint="One per line. Agents plan work against these.">
          <textarea id="p-goals" className="input" rows={4} value={goals} onChange={(e) => setGoals(e.target.value)} />
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
