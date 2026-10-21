import type { AccountStatus, AssignmentStatus, JobStatus, MachineStatus, MergeStatus, RunStatus, WorkItemStatus, WorkflowStatus } from '../api/types';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info';

/** Explicit status label: a shape plus a word, never colour alone. */
export function StatusLabel({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`status status-${tone}`} title={title}>
      <span className="status-mark" aria-hidden="true" />
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
