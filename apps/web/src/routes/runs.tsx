import { Link, useParams } from '@tanstack/react-router';
import { useResource } from '../app/hub-context';
import { Async, btn, Empty, PageHeader } from '../components/ui';
import { RunStatusLabel } from '../components/status';
import { IconRuns } from '../components/icons';
import { dateTime, duration, relative } from '../lib/format';

export function RunsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/runs' });
  const runs = useResource((api) => api.listRuns(projectId), [projectId], (e) => e.projectId === projectId && e.type.startsWith('run'));
  const workflows = useResource((api) => api.listWorkflows(projectId), [projectId]);
  const name = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader title="Runs" description="Each run executes one workflow version. A run can be left unattended; pause or stop it at any time." />
      <Async resource={runs} what="runs">
        {(list) =>
          list.length === 0 ? (
            <section className="card">
              <Empty title="No runs yet" icon={<IconRuns />} action={<Link to="/projects/$projectId/workflows" params={{ projectId }} className={btn('primary')}>Open workflows</Link>}>
                Activate a workflow version, then start a run from it.
              </Empty>
            </section>
          ) : (
            <section className="card">
              <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Workflow</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="hide-sm">Started</th>
                    <th scope="col" className="num hide-sm">Duration</th>

                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const end = r.stoppedAt ? new Date(r.stoppedAt).getTime() : Date.now();
                    return (
                      <tr key={r.id}>
                        <td>
                          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="cell-title mono">
                            {r.id}
                          </Link>
                        </td>
                        <td>
                          {name(r.workflowId)} <span className="muted">v{r.workflowVersion}</span>
                        </td>
                        <td>
                          <RunStatusLabel status={r.status} />
                        </td>
                        <td className="hide-sm" title={dateTime(r.startedAt)}>
                          {relative(r.startedAt)}
                        </td>
                        <td className="num hide-sm">{duration((end - new Date(r.startedAt).getTime()) / 1000)}</td>

                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </section>
          )
        }
      </Async>
    </div>
  );
}
