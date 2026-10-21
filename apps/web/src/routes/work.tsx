import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { WorkItem, WorkflowGraph } from '../api/types';
import { Async, btn, Empty, PageHeader } from '../components/ui';
import { IconWork } from '../components/icons';
import { WorkBoard } from '../run/board';

/** Work items across the project's running and paused runs. */
export function WorkPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/work' });
  const { api } = useHub();
  const runs = useResource((a) => a.listRuns(projectId), [projectId], (e) => e.projectId === projectId && e.type.startsWith('run'));
  const live = (runs.data ?? []).filter((r) => r.status === 'running' || r.status === 'paused');
  const key = live.map((r) => r.id).join(',');
  const items = useResource(
    async (a) => (await Promise.all(live.map((r) => a.listWorkItems(r.id)))).flat(),
    [key],
    (e) => e.projectId === projectId && (e.type.startsWith('workitem') || e.type === 'gate.result'),
  );
  const [graphs, setGraphs] = useState<Record<string, WorkflowGraph>>({});
  useEffect(() => {
    for (const r of live)
      void api.listVersions(r.workflowId).then((vs) => {
        const g = vs.find((v) => v.version === r.workflowVersion)?.graph;
        if (g) setGraphs((prev) => ({ ...prev, [r.id]: g }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  // Nodes are looked up per item's run; merge graphs so labels resolve.
  const merged: WorkflowGraph = { schema: 'perpeto.workflow/1', nodes: Object.values(graphs).flatMap((g) => g.nodes), edges: [] };

  return (
    <div className="page">
      <PageHeader title="Work" description="Every work item in this project’s running and paused runs." />
      <Async resource={runs} what="runs">
        {() =>
          live.length === 0 ? (
            <section className="card">
              <Empty title="No run is in progress" icon={<IconWork />} action={<Link to="/projects/$projectId/runs" params={{ projectId }} className={btn('primary')}>View runs</Link>}>
                Work items appear here while a run is running or paused.
              </Empty>
            </section>
          ) : (
            <Async resource={items} what="work items">
              {(list: WorkItem[]) => <WorkBoard items={list} graph={merged} runLabel={live.length > 1 ? (i) => i.runId : undefined} onStale={items.reload} />}
            </Async>
          )
        }
      </Async>
    </div>
  );
}
