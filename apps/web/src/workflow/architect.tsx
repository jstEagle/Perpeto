import { useEffect, useId, useRef, useState } from 'react';
import { useHub } from '../app/hub-context';
import type { Assignment, HubEvent, Workflow } from '../api/types';
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
  key: string;
  at?: string;
  text: string;
  failed?: boolean;
}

const STATE_TEXT: Record<string, string> = {
  queued: 'Queued for a machine with the architect harness',
  leased: 'Leased',
  running: 'Drafting the graph',
  succeeded: 'Draft saved',
  failed: 'Attempt failed',
  cancelled: 'Cancelled',
};

const issueText = (e: string | { message: string }) => (typeof e === 'string' ? e : e.message);

/**
 * Follows the architect through GET /assignments/:id, refreshed on its
 * events. An invalid draft fails that attempt and names a retry
 * assignment; the panel follows the chain until a draft is saved or the
 * hub stops retrying. Calls onDone with the drafted workflow and version.
 */
export function ArchitectProgress({ assignmentId, projectId, onDone, onDismiss }: { assignmentId: string; projectId?: string; onDone(workflowId: string, version: number): void; onDismiss?(): void }) {
  const { api, onEvent } = useHub();
  const [chain, setChain] = useState<Assignment[]>([]);
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    let current = assignmentId;
    const ids = new Set([assignmentId]);
    const seen = new Set<number>();
    const take = (event: HubEvent) => {
      if (event.subject.kind !== 'assignment' || !ids.has(event.subject.id) || seen.has(event.seq)) return false;
      seen.add(event.seq);
      setEvents((prev) => [...prev, event].sort((x, y) => x.seq - y.seq));
      return true;
    };
    const refresh = async () => {
      try {
        const list: Assignment[] = [];
        let next: string | undefined = assignmentId;
        while (next && !cancelled) {
          const a = await api.getAssignment(next);
          list.push(a);
          ids.add(a.id);
          current = a.id;
          next = a.status === 'failed' ? a.retryAssignmentId : undefined;
        }
        if (cancelled) return;
        setChain(list);
        setError(null);
        const last = list.at(-1);
        if (last?.status === 'succeeded' && last.draftWorkflowId && !done.current) {
          done.current = true;
          onDoneRef.current(last.draftWorkflowId, last.draftVersion ?? 1);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    // Events from before this panel opened: the project's newest page, oldest first.
    void api
      .eventPage({ projectId, limit: 200 })
      .then((page) => !cancelled && [...page.events].reverse().forEach(take))
      .catch(() => undefined);
    void refresh();
    const off = onEvent((event) => {
      if (take(event) || (event.subject.kind === 'assignment' && event.subject.id === current)) void refresh();
    });
    // Lease expiry and requeues are applied by hub maintenance; poll as a fallback while work is open.
    const timer = setInterval(() => !done.current && void refresh(), 5000);
    return () => {
      cancelled = true;
      off();
      clearInterval(timer);
    };
  }, [api, onEvent, assignmentId, projectId]);

  const last = chain.at(-1);
  const succeeded = last?.status === 'succeeded';
  const failed = !!last && (last.status === 'cancelled' || (last.status === 'failed' && !last.retryAssignmentId));
  const machine = useMachineName(last?.machineId);

  const steps: Step[] = [];
  for (const [i, a] of chain.entries()) {
    const mine = events.filter((e) => e.subject.id === a.id);
    for (const e of mine) {
      const d = e.data as { state?: string; summary?: string; errors?: (string | { message: string })[] };
      if (e.type === 'workflow.architect.invalid') {
        steps.push({ key: String(e.seq), at: e.at, failed: true, text: `Attempt ${i + 1} returned an invalid graph: ${(d.errors ?? []).slice(0, 2).map(issueText).join('; ')}` });
        continue;
      }
      if (e.type !== 'assignment.state') continue;
      if (d.state === 'failed' && a.architectErrors?.length) continue;
      steps.push({ key: String(e.seq), at: e.at, failed: d.state === 'failed', text: d.summary ?? `${STATE_TEXT[String(d.state)] ?? d.state}${chain.length > 1 ? `, attempt ${i + 1}` : ''}` });
    }
    if (!mine.length) steps.push({ key: a.id, text: `${STATE_TEXT[a.status] ?? a.status}${chain.length > 1 ? `, attempt ${i + 1}` : ''}`, failed: a.status === 'failed' });
    if (a.status === 'failed' && a.architectErrors?.length && !mine.some((e) => e.type === 'workflow.architect.invalid'))
      steps.push({ key: `${a.id}:invalid`, failed: true, text: `Attempt ${i + 1} returned an invalid graph: ${a.architectErrors.slice(0, 2).map(issueText).join('; ')}` });
  }
  if (succeeded && last?.draftVersion) steps.push({ key: 'saved', text: `Saved as draft version ${last.draftVersion}. Nothing runs until you activate it.` });

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
          {last ? (
            <>
              {providerLabel(last.harness.provider)} · <code className="mono">{last.harness.model}</code>
              {machine ? ` · ${machine}` : ' · waiting for a machine'}
              {chain.length > 1 ? ` · attempt ${chain.length} of 3` : ''} · <code className="mono">{last.id}</code>
            </>
          ) : (
            <code className="mono">{assignmentId}</code>
          )}
        </p>
        {steps.length === 0 ? (
          <div className="row muted" role="status">
            <SpindleLoader size={16} label="Waiting for the architect" /> Waiting for the first update
          </div>
        ) : (
          <ol className="progress-steps">
            {steps.map((s, i) => {
              const current = i === steps.length - 1 && !succeeded && !failed;
              return (
                <li key={s.key} className={current ? 'step-current' : s.failed ? 'diff-removed' : 'step-done'}>
                  {current ? <SpindleLoader size={14} label="In progress" /> : <IconCheck />}
                  <span>{s.text}</span>
                  {s.at && <time dateTime={s.at}>{clock(s.at)}</time>}
                </li>
              );
            })}
          </ol>
        )}
        {error && <p className="form-error" role="alert">Progress could not be read. {error}</p>}
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
