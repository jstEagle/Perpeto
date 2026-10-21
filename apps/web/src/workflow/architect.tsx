import { useEffect, useId, useRef, useState } from 'react';
import { useHub } from '../app/hub-context';
import type { HubEvent, Workflow } from '../api/types';
import { Button } from '../components/ui';
import { StatusLabel } from '../components/status';
import { SpindleLoader } from '../brand/logo';
import { IconCheck } from '../components/icons';
import { clock } from '../lib/format';
import { providerLabel } from './registry';

const SUGGESTIONS = [
  'Plan from the goals, build in parallel, review every change with a second model, run CI on my Mac, then merge.',
  'Keep it cheap: small model for builders, no subagents, one reviewer.',
  'Nothing merges without my approval.',
];

const CHANGE_SUGGESTIONS = ['Review is the bottleneck. Add review capacity without lowering quality.', 'Add my approval before the merge queue.', 'Use Codex for review so changes get a second model family.'];

/** The default way to get a workflow: describe it, an agent drafts it. */
export function ArchitectPrompt({
  projectId,
  base,
  onStarted,
  title = 'Describe how this project should be built',
  compact,
}: {
  projectId: string;
  base?: Workflow;
  onStarted(assignmentId: string): void;
  title?: string;
  compact?: boolean;
}) {
  const { api } = useHub();
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestions = base ? CHANGE_SUGGESTIONS : SUGGESTIONS;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) {
      setError('Describe what you want first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const assignment = await api.requestDraft(projectId, { prompt: prompt.trim(), ...(base ? { baseWorkflowId: base.id } : {}) });
      setPrompt('');
      onStarted(assignment.id);
    } catch (err) {
      setError(`The architect was not started. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="prompt-box" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <label id={`${id}-title`} htmlFor={`${id}-prompt`} className={compact ? 'label' : 'prompt-title'}>
        {title}
      </label>
      <textarea
        id={`${id}-prompt`}
        className="input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={base ? 'What should change, and why?' : 'Who does the work, how it gets checked, and when it can merge.'}
        rows={compact ? 3 : 5}
        aria-describedby={`${id}-hint`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <p id={`${id}-hint`} className="field-hint">
        A workflow architect agent drafts the graph from your project’s docs, goals, machines and providers. Nothing runs until you activate it.
      </p>
      <div className="prompt-suggestions" aria-label="Examples">
        {suggestions.map((s) => (
          <button key={s} type="button" className="suggestion" onClick={() => setPrompt(s)}>
            {s}
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <Button variant="primary" type="submit" busy={busy}>
          {base ? 'Ask for changes' : 'Draft workflow'}
        </Button>
        <span className="note">⌘ Enter to send</span>
      </div>
    </form>
  );
}

interface Step {
  seq: number;
  at: string;
  state: string;
  summary: string;
}

/**
 * Follows the architect's assignment through its events. Calls onDone with
 * the drafted workflow once the hub reports success.
 */
export function ArchitectProgress({ assignmentId, projectId, onDone, onDismiss }: { assignmentId: string; projectId: string; onDone(workflowId: string, version: number): void; onDismiss?(): void }) {
  const { api, onEvent } = useHub();
  const [steps, setSteps] = useState<Step[]>([]);
  const [harness, setHarness] = useState<{ provider?: string; model?: string; machineId?: string }>({});
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    const take = (event: HubEvent) => {
      if (event.subject.kind !== 'assignment' || event.subject.id !== assignmentId) return;
      const data = event.data as Record<string, unknown>;
      setSteps((prev) => (prev.some((s) => s.seq === event.seq) ? prev : [...prev, { seq: event.seq, at: event.at, state: String(data.state ?? ''), summary: String(data.summary ?? data.state ?? 'Update') }].sort((a, b) => a.seq - b.seq)));
      setHarness((h) => ({ provider: (data.provider as string) ?? h.provider, model: (data.model as string) ?? h.model, machineId: (data.machineId as string) ?? h.machineId }));
      if (data.state === 'succeeded' && !done.current) {
        done.current = true;
        if (typeof data.workflowId === 'string') onDoneRef.current(data.workflowId, Number(data.version ?? 1));
        else
          void api.listWorkflows(projectId).then((list) => {
            const wf = list.find((w) => w.authoredBy?.assignmentId === assignmentId);
            if (wf && !cancelled) onDoneRef.current(wf.id, wf.version);
          });
      }
    };
    void api.events(0, 500).then((events) => !cancelled && events.forEach(take));
    const off = onEvent(take);
    return () => {
      cancelled = true;
      off();
    };
  }, [api, onEvent, assignmentId, projectId]);

  const last = steps.at(-1);
  const failed = last?.state === 'failed';
  const succeeded = last?.state === 'succeeded';
  const machines = useMachineName(harness.machineId);

  return (
    <section className="panel" aria-labelledby={`arch-${assignmentId}`} aria-live="polite">
      <div className="panel-header">
        <h2 id={`arch-${assignmentId}`}>Workflow architect</h2>
        <div className="panel-actions">
          {failed ? <StatusLabel tone="error">Failed</StatusLabel> : succeeded ? <StatusLabel tone="success">Draft ready</StatusLabel> : <StatusLabel tone="accent">Working</StatusLabel>}
          {onDismiss && (failed || succeeded) && (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
      <div className="panel-body stack-sm">
        <p className="note">
          {harness.provider ? `${providerLabel(harness.provider)} · ` : ''}
          {harness.model && <code className="mono">{harness.model}</code>}
          {machines ? ` · ${machines}` : ''} · <code className="mono">{assignmentId}</code>
        </p>
        {steps.length === 0 ? (
          <div className="row muted">
            <SpindleLoader size={16} label="Waiting for the architect" /> Waiting for the first update
          </div>
        ) : (
          <ol className="progress-steps">
            {steps.map((s, i) => {
              const current = i === steps.length - 1 && !succeeded && !failed;
              return (
                <li key={s.seq} className={current ? 'step-current' : s.state === 'failed' ? 'diff-removed' : 'step-done'}>
                  {current ? <SpindleLoader size={14} label="In progress" /> : <IconCheck />}
                  <span>{s.summary}</span>
                  <time dateTime={s.at}>{clock(s.at)}</time>
                </li>
              );
            })}
          </ol>
        )}
        {failed && <p className="form-error">The architect could not produce a valid workflow. Read its last update above, then ask again with more detail or start from a template.</p>}
      </div>
    </section>
  );
}

function useMachineName(id?: string) {
  const { api } = useHub();
  const [name, setName] = useState<string>();
  useEffect(() => {
    if (!id) return;
    void api
      .listMachines()
      .then((list) => setName(list.find((m) => m.id === id)?.name ?? id))
      .catch(() => setName(id));
  }, [api, id]);
  return name;
}
