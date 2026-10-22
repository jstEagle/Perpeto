import type { ReactNode } from 'react';
import type { AccountStatus, AssignmentStatus, JobStatus, MachineStatus, MergeStatus, RunStatus, WorkItemStatus, WorkflowStatus } from '../api/types';
import { IconAlert, IconApproval, IconBlocked, IconCheckCircle, IconCircle, IconClock, IconNext, IconPause, IconStop, IconXCircle } from './icons';

/**
 * Perpeto Mono status: an icon plus a word, told by shape and weight, not
 * hue. Orange is only the live dot; red only failure.
 *
 * - live: work happening now (orange dot)
 * - attention: a person should look (filled circle)
 * - approval: a person must decide (filled triangle)
 * - blocked: waiting on something else
 * - quiet: accepted, idle, not reached
 * - paused / stopped: stopped by a person
 * - done: checks passed, completed, merged
 * - waiting: leased or cooling, will move on its own
 * - next: starts on its own shortly (the subscription pacing picks next)
 * - failed: name the operation and the recovery
 */
export type Tone = 'live' | 'attention' | 'approval' | 'blocked' | 'quiet' | 'paused' | 'stopped' | 'done' | 'waiting' | 'next' | 'failed';

/** The orange live dot. Static; it never pulses. */
export function LiveDot({ label = 'Live', className }: { label?: string; className?: string }) {
  return <span className={`dot ${className ?? ''}`} role="img" aria-label={label} />;
}

export function StatusIcon({ tone }: { tone: Tone }) {
  switch (tone) {
    case 'live':
      return <span className="dot" aria-hidden="true" />;
    case 'attention':
      return <IconAlert size={16} />;
    case 'approval':
      return <IconApproval size={16} />;
    case 'blocked':
      return <IconBlocked size={16} />;
    case 'paused':
      return <IconPause size={16} />;
    case 'stopped':
      return <IconStop size={16} />;
    case 'done':
      return <IconCheckCircle size={16} />;
    case 'waiting':
      return <IconClock size={16} />;
    case 'next':
      return <IconNext size={16} />;
    case 'failed':
      return <IconXCircle size={16} />;
    default:
      return <IconCircle size={16} />;
  }
}

/** Inline status: 16 px icon, 8 px gap, 13 px word. */
export function StatusLabel({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`status status-${tone}`} title={title}>
      <StatusIcon tone={tone} />
      <span>{children}</span>
    </span>
  );
}

/** Header form: a white pill for live objects, a quiet grey one for versions and counts. */
export function StatusChip({ tone, children, quiet }: { tone?: Tone; children: ReactNode; quiet?: boolean }) {
  return (
    <span className={`chip ${quiet ? 'chip-quiet' : ''} ${tone ? `status-${tone}` : ''}`}>
      {tone && <StatusIcon tone={tone} />}
      {children}
    </span>
  );
}

const RUN: Record<RunStatus, [Tone, string]> = {
  running: ['live', 'Running'],
  paused: ['paused', 'Paused'],
  stopped: ['stopped', 'Stopped'],
  completed: ['done', 'Completed'],
  failed: ['failed', 'Failed'],
};
const WORK: Record<WorkItemStatus, [Tone, string]> = {
  queued: ['quiet', 'Queued'],
  active: ['live', 'Active'],
  blocked: ['blocked', 'Blocked'],
  done: ['done', 'Done'],
  failed: ['failed', 'Failed'],
};
const ASSIGNMENT: Record<AssignmentStatus, [Tone, string]> = {
  queued: ['quiet', 'Queued'],
  leased: ['waiting', 'Leased'],
  running: ['live', 'Running'],
  succeeded: ['done', 'Succeeded'],
  failed: ['failed', 'Failed'],
  cancelled: ['stopped', 'Cancelled'],
};
const JOB: Record<JobStatus, [Tone, string]> = {
  queued: ['quiet', 'Queued'],
  leased: ['waiting', 'Leased'],
  running: ['live', 'Running'],
  passed: ['done', 'Passed'],
  failed: ['failed', 'Failed'],
  cancelled: ['stopped', 'Cancelled'],
  error: ['failed', 'Error'],
};
const MERGE: Record<MergeStatus, [Tone, string]> = {
  queued: ['quiet', 'Queued'],
  testing: ['live', 'Testing'],
  merging: ['live', 'Merging'],
  merged: ['done', 'Merged'],
  rejected: ['failed', 'Rejected'],
};
const MACHINE: Record<MachineStatus, [Tone, string]> = {
  online: ['done', 'Online'],
  offline: ['attention', 'Offline'],
  draining: ['paused', 'Draining'],
};
const ACCOUNT: Record<AccountStatus, [Tone, string]> = {
  active: ['done', 'Active'],
  cooling: ['waiting', 'Cooling down'],
  disabled: ['stopped', 'Disabled'],
  invalid: ['failed', 'Invalid'],
};
const WORKFLOW: Record<WorkflowStatus, [Tone, string]> = {
  draft: ['quiet', 'Draft'],
  active: ['done', 'Active'],
  paused: ['paused', 'Paused'],
};

function make<T extends string>(map: Record<T, [Tone, string]>) {
  return function Status({ status, title }: { status: T; title?: string }) {
    const [tone, label] = map[status] ?? ['quiet', status];
    return (
      <StatusLabel tone={tone} title={title}>
        {label}
      </StatusLabel>
    );
  };
}

export const runTone = (status: RunStatus) => RUN[status]?.[0] ?? 'quiet';
export const RunStatusLabel = make(RUN);
export const WorkStatusLabel = make(WORK);
export const AssignmentStatusLabel = make(ASSIGNMENT);
export const JobStatusLabel = make(JOB);
export const MergeStatusLabel = make(MERGE);
export const MachineStatusLabel = make(MACHINE);
export const AccountStatusLabel = make(ACCOUNT);
export const WorkflowStatusLabel = make(WORKFLOW);
