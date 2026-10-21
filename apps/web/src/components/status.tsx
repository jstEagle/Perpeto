import type { AccountStatus, AssignmentStatus, JobStatus, MachineStatus, MergeStatus, RunStatus, WorkItemStatus, WorkflowStatus } from '../api/types';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info' | 'approval';

/**
 * Status shapes from the design system: open circle (planned), half-filled
 * circle (running), circle with bar (blocked), circle with cross (failed),
 * circle with check (verified), triangle with mark (approval needed).
 * Leased work uses a ringed dot.
 */
export function StatusIcon({ tone }: { tone: Tone }) {
  return (
    <svg className={`status-icon status-icon-${tone}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {tone === 'approval' ? (
        <path d="M8 1.9 14.6 13.75H1.4z M8 6.25v3.5 M8 11.1v1.15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      ) : (
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
      {tone === 'accent' && <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />}
      {tone === 'info' && <circle cx="8" cy="8" r="2.5" fill="currentColor" />}
      {tone === 'warning' && <path d="M4.75 8h6.5" stroke="currentColor" strokeWidth="1.5" />}
      {tone === 'error' && <path d="m5.75 5.75 4.5 4.5m0-4.5-4.5 4.5" stroke="currentColor" strokeWidth="1.5" />}
      {tone === 'success' && <path d="m5.25 8.25 1.9 1.9 3.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

/** Explicit status label: a shape plus a word, never colour alone. */
export function StatusLabel({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`status status-${tone}`} title={title}>
      <StatusIcon tone={tone} />
      {children}
    </span>
  );
}

const RUN: Record<RunStatus, [Tone, string]> = {
  running: ['accent', 'Running'],
  paused: ['warning', 'Paused'],
  stopped: ['neutral', 'Stopped'],
  completed: ['success', 'Completed'],
  failed: ['error', 'Failed'],
};
const WORK: Record<WorkItemStatus, [Tone, string]> = {
  queued: ['neutral', 'Queued'],
  active: ['accent', 'Active'],
  blocked: ['warning', 'Blocked'],
  done: ['success', 'Done'],
  failed: ['error', 'Failed'],
};
const ASSIGNMENT: Record<AssignmentStatus, [Tone, string]> = {
  queued: ['neutral', 'Queued'],
  leased: ['info', 'Leased'],
  running: ['accent', 'Running'],
  succeeded: ['success', 'Succeeded'],
  failed: ['error', 'Failed'],
  cancelled: ['neutral', 'Cancelled'],
};
const JOB: Record<JobStatus, [Tone, string]> = {
  queued: ['neutral', 'Queued'],
  leased: ['info', 'Leased'],
  running: ['accent', 'Running'],
  passed: ['success', 'Passed'],
  failed: ['error', 'Failed'],
  cancelled: ['neutral', 'Cancelled'],
  error: ['error', 'Error'],
};
const MERGE: Record<MergeStatus, [Tone, string]> = {
  queued: ['neutral', 'Queued'],
  testing: ['accent', 'Testing'],
  merging: ['accent', 'Merging'],
  merged: ['success', 'Merged'],
  rejected: ['error', 'Rejected'],
};
const MACHINE: Record<MachineStatus, [Tone, string]> = {
  online: ['success', 'Online'],
  offline: ['error', 'Offline'],
  draining: ['warning', 'Draining'],
};
const ACCOUNT: Record<AccountStatus, [Tone, string]> = {
  active: ['success', 'Active'],
  cooling: ['warning', 'Cooling down'],
  disabled: ['neutral', 'Disabled'],
  invalid: ['error', 'Invalid'],
};
const WORKFLOW: Record<WorkflowStatus, [Tone, string]> = {
  draft: ['info', 'Draft'],
  active: ['success', 'Active'],
  paused: ['neutral', 'Paused'],
};

function make<T extends string>(map: Record<T, [Tone, string]>) {
  return function Status({ status, title }: { status: T; title?: string }) {
    const [tone, label] = map[status] ?? ['neutral', status];
    return <StatusLabel tone={tone} title={title}>{label}</StatusLabel>;
  };
}

export const RunStatusLabel = make(RUN);
export const WorkStatusLabel = make(WORK);
export const AssignmentStatusLabel = make(ASSIGNMENT);
export const JobStatusLabel = make(JOB);
export const MergeStatusLabel = make(MERGE);
export const MachineStatusLabel = make(MACHINE);
export const AccountStatusLabel = make(ACCOUNT);
export const WorkflowStatusLabel = make(WORKFLOW);
