import { useParams } from '@tanstack/react-router';
import { useResource } from '../app/hub-context';
import { Async, Empty, Mono, PageHeader } from '../components/ui';
import { JobStatusLabel, MergeStatusLabel } from '../components/status';
import { prNumber, shortSha } from '../lib/format';

export function MergeQueuePage() {
  const { projectId } = useParams({ from: '/projects/$projectId/merge-queue' });
  const queue = useResource((api) => api.mergeQueue(projectId), [projectId], (e) => e.subject.kind === 'merge' || e.subject.kind === 'job');
  const jobs = useResource((api) => api.listJobs({ projectId }), [projectId], (e) => e.subject.kind === 'job');

  return (
    <div className="page">
      <PageHeader title="Merge queue" description="Changes merge into the base branch after CI passes at the exact head commit. Rejected entries say why." />
      <Async resource={queue} what="the merge queue">
        {(entries) =>
          entries.length === 0 ? (
            <div className="panel">
              <Empty title="The merge queue is empty.">Pull requests join the queue after they pass review and CI.</Empty>
            </div>
          ) : (
            <div className="panel panel-flush table-wrap">
              <table className="table">
                <caption className="visually-hidden">Merge queue entries</caption>
                <thead>
                  <tr>
                    <th scope="col">Pull request</th>
                    <th scope="col">Head</th>
                    <th scope="col" className="hide-sm">Base</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="hide-sm">CI job</th>
                  </tr>
                </thead>
                <tbody>
                  {[...entries].reverse().map((e) => {
                    const job = jobs.data?.find((j) => j.id === e.jobId);
                    return (
                      <tr key={e.id}>
                        <td>
                          <a className="link" href={e.prUrl} target="_blank" rel="noreferrer">
                            {prNumber(e.prUrl)}
                          </a>
                          {e.reason && <p className="note queue-reason">{e.reason}</p>}
                        </td>
                        <td>
                          <Mono title={e.headSha}>{shortSha(e.headSha)}</Mono>
                        </td>
                        <td className="hide-sm">
                          <Mono>{e.baseBranch}</Mono>
                        </td>
                        <td>
                          <MergeStatusLabel status={e.status} />
                        </td>
                        <td className="hide-sm">
                          {job ? (
                            <span className="row" style={{ gap: 8 }}>
                              <Mono>{job.id}</Mono>
                              <JobStatusLabel status={job.status} />
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </div>
  );
}
