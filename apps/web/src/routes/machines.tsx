import { useEffect, useMemo, useState } from 'react';
import { useHub, useResource } from '../app/hub-context';
import type { EnrollmentCode, Machine, MachinePatch } from '../api/types';
import { Async, Button, Dialog, Empty, Meter, PageHeader, Segmented, Stat } from '../components/ui';
import { LiveDot, PlacementStatusLabel } from '../components/status';
import { IconBlocked, IconCircle, IconCopy, IconMachines, IconMinus, IconPlus } from '../components/icons';
import { plural, relative } from '../lib/format';
import {
  canSchedule,
  diskCell,
  filterFleet,
  fleetSummary,
  healthLine,
  isHeld,
  loadCell,
  memoryCell,
  osLabel,
  placementOf,
  powerCell,
  slotsSub,
  slotsText,
  sortFleet,
} from '../lib/fleet';
import type { FleetFilter, FleetSort, FleetSummary, HealthCell } from '../lib/fleet';

/** Above this many machines the list gets a filter and a sort. */
const MANY = 6;

/** The Fleet screen at /machines: health, effective capacity and why the hub isn't placing work. */
export function MachinesPage() {
  const machines = useResource((api) => api.listMachines(), [], (e) => e.subject.kind === 'machine' || e.type === 'assignment.state');
  const [enrolling, setEnrolling] = useState(false);
  const [draining, setDraining] = useState<Machine | null>(null);

  return (
    <div className="page">
      <PageHeader
        title="Fleet"
        description="How each machine is holding up, and whether the hub is placing agents and CI jobs on it."
        actions={
          <Button variant="primary" onClick={() => setEnrolling(true)}>
            <IconPlus /> Enroll machine
          </Button>
        }
      />
      <Async resource={machines} what="machines">
        {(list) =>
          list.length === 0 ? (
            <section className="card">
              <Empty title="No machines enrolled" icon={<IconMachines />} action={<Button variant="primary" onClick={() => setEnrolling(true)}>Enroll machine</Button>}>
                Enroll a machine so agents and CI jobs have somewhere to run.
              </Empty>
            </section>
          ) : (
            <Fleet list={list} onDrain={setDraining} onChanged={machines.reload} />
          )
        }
      </Async>
      <EnrollDialog open={enrolling} onClose={() => setEnrolling(false)} />
      <DrainDialog machine={draining} onClose={() => setDraining(null)} onDone={machines.reload} />
    </div>
  );
}

export const FleetPage = MachinesPage;

function Fleet({ list: served, onDrain, onChanged }: { list: Machine[]; onDrain(m: Machine): void; onChanged(): void }) {
  const { api } = useHub();
  // The hub's answer to a change shows at once; the next load replaces it.
  const [updated, setUpdated] = useState<Record<string, Machine>>({});
  useEffect(() => setUpdated({}), [served]);
  const list = useMemo(() => served.map((m) => updated[m.id] ?? m), [served, updated]);
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [sort, setSort] = useState<FleetSort>('attention');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = fleetSummary(list);
  const many = list.length > MANY;
  const shown = sortFleet(many ? filterFleet(list, filter) : list, many ? sort : 'attention');
  const notAccepting = list.length - summary.accepting;

  async function change(m: Machine, patch: MachinePatch, verb: string) {
    setBusy(m.id);
    setError(null);
    try {
      const next = await api.updateMachine(m.id, patch);
      setUpdated((u) => ({ ...u, [m.id]: next }));
      onChanged();
    } catch (err) {
      setError(`${m.name} was not ${verb}. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="card" aria-label="Fleet capacity">
        <dl className="metrics">
          <Stat label="Accepting work" value={summary.accepting} unit={`of ${summary.total}`} detail={summary.offline ? `${summary.offline} offline` : undefined} />
          <Stat label="Agent slots in use" value={summary.held} unit={`of ${summary.effective}`} detail={slotsDetail(summary)} />
          <Stat label="Overloaded" value={summary.overloaded} detail={`${summary.cordoned} cordoned or draining`} />
        </dl>
      </section>
      {many && (
        <div className="toolbar">
          <Segmented<FleetFilter>
            label="Show machines"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: list.length },
              { value: 'accepting', label: 'Accepting', count: summary.accepting },
              { value: 'not-accepting', label: 'Not accepting', count: notAccepting },
            ]}
          />
          <Segmented<FleetSort>
            label="Sort machines"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'attention', label: 'Needs a look first' },
              { value: 'name', label: 'Name' },
            ]}
          />
        </div>
      )}
      <section className="card" aria-label="Machines">
        {error && (
          <p className="form-error fleet-error" role="alert">
            {error}
          </p>
        )}
        <div className="fleet-scroll">
          <div className="fleet-row fleet-head" aria-hidden="true">
            <span>Machine</span>
            <span>Status</span>
            <span>Agents</span>
            <span>Load</span>
            <span>Memory</span>
            <span>Disk</span>
            <span>Power</span>
            <span />
          </div>
          {shown.length === 0 ? (
            <p className="fleet-none muted">{filter === 'accepting' ? 'No machine is accepting work right now.' : 'Every machine is accepting work.'}</p>
          ) : (
            <ul className="fleet-list" aria-label={plural(shown.length, 'machine')}>
              {shown.map((m) => (
                <FleetRow
                  key={m.id}
                  machine={m}
                  busy={busy === m.id}
                  onCordon={() => change(m, { cordoned: true }, 'cordoned')}
                  onUncordon={() => change(m, { cordoned: false, drain: false }, 'uncordoned')}
                  onDrain={() => onDrain(m)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

function FleetRow({ machine: m, busy, onCordon, onUncordon, onDrain }: { machine: Machine; busy: boolean; onCordon(): void; onUncordon(): void; onDrain(): void }) {
  const p = placementOf(m);
  const running = p.held.agents + p.held.jobs > 0;
  const schedulable = canSchedule(m);
  const held = isHeld(m);
  const line = healthLine(m);
  return (
    <li className="fleet-row" aria-label={m.name}>
      <div className="fleet-machine">
        <span className="tile tile-sm" aria-hidden="true">
          <IconMachines />
        </span>
        <span className="fleet-name">
          <span className="cell-title mono">{m.name}</span>
          <span className="cell-sub">
            {osLabel(m.os)} · v{m.version}
          </span>
          {line && <span className="cell-sub only-mobile">{line}</span>}
        </span>
      </div>
      <div className="fleet-status">
        <PlacementStatusLabel status={p.status} />
        <span className="cell-sub">{p.status === 'offline' ? `Seen ${relative(m.lastHeartbeatAt)}` : relative(m.lastHeartbeatAt)}</span>
      </div>
      <div className="fleet-slots">
        <span className="fleet-slots-head tabular">
          {running && <LiveDot label={`${m.name} is running work`} />}
          {slotsText(p)}
        </span>
        <Meter value={p.held.agents} max={Math.max(p.effective.agents, p.held.agents)} label={`${m.name} agent slots`} />
        <span className="cell-sub">{slotsSub(p)}</span>
      </div>
      <Health cell={loadCell(m)} />
      <Health cell={memoryCell(m)} />
      <Health cell={diskCell(m)} />
      <Health cell={powerCell(m)} />
      <div className="fleet-actions">
        {m.revokedAt ? null : held && schedulable ? (
          <Button size="sm" variant="secondary" onClick={onUncordon} busy={busy}>
            Uncordon
          </Button>
        ) : (
          <>
            {schedulable && (
              <Button size="sm" variant="ghost" onClick={onCordon} busy={busy}>
                Cordon
              </Button>
            )}
            {!held && (
              <Button size="sm" variant="ghost" onClick={onDrain} disabled={busy}>
                Drain
              </Button>
            )}
          </>
        )}
      </div>
      {p.reasons.length > 0 && (
        <ul className="fleet-reasons" aria-label={`Why ${m.name} ${p.accepting ? 'is limited' : 'is not taking work'}`}>
          {p.reasons.map((r) => (
            <li key={r.code + r.message} className={`fleet-reason fleet-reason-${r.effect === 'info' ? 'info' : r.effect === 'reduces' ? 'reduces' : 'blocks'}`}>
              {r.effect === 'info' ? <IconCircle size={16} /> : r.effect === 'reduces' ? <IconMinus size={16} /> : <IconBlocked size={16} />}
              {r.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Configured slots when health cut them, and agents still running past a machine's limit. */
function slotsDetail(s: FleetSummary): string | undefined {
  const parts = [s.configured !== s.effective ? `${s.configured} configured` : '', s.over ? `${s.over} over limit` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function Health({ cell }: { cell: HealthCell }) {
  return (
    <div className={`fleet-health hide-sm ${cell.strong ? 'fleet-health-strong' : ''}`} title={cell.title}>
      <span className="tabular">{cell.value}</span>
      {cell.sub && <span className="cell-sub">{cell.sub}</span>}
    </div>
  );
}

function EnrollDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api } = useHub();
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.createEnrollmentCode());
    } catch (err) {
      setError(`No code was created. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setCode(null);
    setCopied(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Enroll a machine"
      footer={
        code ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} busy={busy}>
              Create enrollment code
            </Button>
          </>
        )
      }
    >
      {code ? (
        <div className="stack-sm">
          <p className="muted">Enter this code when you enroll the node on the new machine. It works once{code.expiresAt ? ` and expires ${relative(code.expiresAt)}` : ''}.</p>
          <div className="code-once">
            <code>{code.code}</code>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(code.code).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              <IconCopy /> {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="note">This code is shown only now. Create a new one if it expires.</p>
        </div>
      ) : (
        <div className="stack-sm">
          <p className="muted">A one-time code lets a machine exchange it for its own node token. The machine then appears here and starts leasing work it can run.</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function DrainDialog({ machine, onClose, onDone }: { machine: Machine | null; onClose(): void; onDone(): void }) {
  const { api } = useHub();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function drain() {
    if (!machine) return;
    setBusy(true);
    setError(null);
    try {
      // Newer hubs drain through the schedule; older ones only have the drain route.
      if (canSchedule(machine)) await api.updateMachine(machine.id, { drain: true });
      else await api.drainMachine(machine.id);
      onDone();
      onClose();
    } catch (err) {
      setError(`${machine.name} was not drained. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  const held = machine ? placementOf(machine).held : { agents: 0, jobs: 0 };
  const running = held.agents + held.jobs > 0;
  return (
    <Dialog
      open={!!machine}
      onClose={onClose}
      title={`Drain ${machine?.name ?? ''}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={drain} busy={busy}>
            Drain machine
          </Button>
        </>
      }
    >
      <p className="muted">
        The hub stops placing new work on it.{' '}
        {running ? `The ${plural(held.agents, 'agent')} and ${plural(held.jobs, 'job')} already running finish first, then it shows as drained.` : 'Nothing is running on it, so it drains at once.'}
        {machine && canSchedule(machine) ? ' Uncordon it to bring it back.' : ''}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
