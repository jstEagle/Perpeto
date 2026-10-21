import { useState } from 'react';
import { useHub, useResource } from '../app/hub-context';
import type { EnrollmentCode, Machine } from '../api/types';
import { Async, Button, Dialog, Empty, Meter, PageHeader, Stat } from '../components/ui';
import { MachineStatusLabel } from '../components/status';
import { IconCopy, IconMachines, IconPlus } from '../components/icons';
import { providerLabel } from '../workflow/registry';
import { relative } from '../lib/format';

export function MachinesPage() {
  const machines = useResource((api) => api.listMachines(), [], (e) => e.subject.kind === 'machine' || e.type === 'assignment.state');
  const [enrolling, setEnrolling] = useState(false);
  const [draining, setDraining] = useState<Machine | null>(null);

  return (
    <div className="page">
      <PageHeader
        title="Machines"
        description="Machines enrolled in this factory. Each runs a node that leases agent work and CI jobs from the hub."
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
            <>
              <section className="card" aria-label="Capacity">
                <dl className="metrics">
                  <Stat label="Machines online" value={list.filter((m) => m.status === 'online').length} unit={`of ${list.length}`} />
                  <Stat label="Agent slots in use" value={sum(list, (m) => m.running.agents)} unit={`of ${sum(list, (m) => m.capacity.maxAgents)}`} />
                  <Stat label="Job slots in use" value={sum(list, (m) => m.running.jobs)} unit={`of ${sum(list, (m) => m.capacity.maxJobs)}`} />
                </dl>
              </section>
              <section className="card">
                <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Machines</caption>
                  <thead>
                    <tr>
                      <th scope="col">Machine</th>
                      <th scope="col">Status</th>
                      <th scope="col">Agents</th>
                      <th scope="col" className="hide-sm">Jobs</th>
                      <th scope="col" className="hide-sm">Providers</th>
                      <th scope="col" className="hide-sm">Heartbeat</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span className="project-cell">
                            <span className="tile tile-sm" aria-hidden="true">
                              <IconMachines />
                            </span>
                            <span>
                              <span className="cell-title mono">{m.name}</span>
                              <span className="cell-sub">
                                {m.os} {m.arch} · v{m.version}
                                {m.labels.length ? ` · ${m.labels.join(', ')}` : ''}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <MachineStatusLabel status={m.status} />
                        </td>
                        <td>
                          <span className="meter-cell">
                            <span className="tabular">
                              {m.running.agents} of {m.capacity.maxAgents}
                            </span>
                            <Meter value={m.running.agents} max={m.capacity.maxAgents} label={`${m.name} agents`} />
                          </span>
                        </td>
                        <td className="hide-sm">
                          <span className="meter-cell">
                            <span className="tabular">
                              {m.running.jobs} of {m.capacity.maxJobs}
                            </span>
                            <Meter value={m.running.jobs} max={m.capacity.maxJobs} label={`${m.name} jobs`} />
                          </span>
                        </td>
                        <td className="hide-sm">{m.providers.map(providerLabel).join(', ')}</td>
                        <td className="hide-sm muted">{relative(m.lastHeartbeatAt)}</td>
                        <td className="num">
                          {m.status === 'online' && (
                            <Button size="sm" variant="ghost" onClick={() => setDraining(m)}>
                              Drain
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </section>
            </>
          )
        }
      </Async>
      <EnrollDialog open={enrolling} onClose={() => setEnrolling(false)} />
      <DrainDialog machine={draining} onClose={() => setDraining(null)} onDone={machines.reload} />
    </div>
  );
}

function sum(list: Machine[], fn: (m: Machine) => number) {
  return list.reduce((s, m) => s + fn(m), 0);
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
      await api.drainMachine(machine.id);
      onDone();
      onClose();
    } catch (err) {
      setError(`${machine.name} was not drained. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
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
      <p className="muted">The machine stops leasing new work. Agents and jobs already running on it continue until they finish.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
