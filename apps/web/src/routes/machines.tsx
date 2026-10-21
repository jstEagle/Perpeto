import { useState } from 'react';
import { useHub, useResource } from '../app/hub-context';
import type { EnrollmentCode, Machine } from '../api/types';
import { Async, Button, Dialog, Empty, Meter, Mono, PageHeader, Stat } from '../components/ui';
import { MachineStatusLabel } from '../components/status';
import { IconCopy, IconPlus } from '../components/icons';
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
            <div className="panel">
              <Empty title="No machines enrolled." action={<Button variant="primary" onClick={() => setEnrolling(true)}>Enroll machine</Button>}>
                Enroll a machine so agents and CI jobs have somewhere to run.
              </Empty>
            </div>
          ) : (
            <>
              <dl className="stats">
                <Stat label="Online" value={`${list.filter((m) => m.status === 'online').length} of ${list.length}`} />
                <Stat label="Agent slots in use" value={`${sum(list, (m) => m.running.agents)} of ${sum(list, (m) => m.capacity.maxAgents)}`} />
                <Stat label="Job slots in use" value={`${sum(list, (m) => m.running.jobs)} of ${sum(list, (m) => m.capacity.maxJobs)}`} />
                <Stat label="Draining" value={list.filter((m) => m.status === 'draining').length} />
              </dl>
              <div className="panel panel-flush table-wrap">
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
                          <span className="cell-title">{m.name}</span>
                          <Mono>
                            {m.os}/{m.arch} · v{m.version}
                          </Mono>
                          <div className="tags hide-sm" style={{ marginTop: 4 }}>
                            {m.labels.map((l) => (
                              <span key={l} className="tag">
                                {l}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <MachineStatusLabel status={m.status} />
                        </td>
                        <td>
                          <span className="meter-cell">
                            <Meter value={m.running.agents} max={m.capacity.maxAgents} label={`${m.name} agents`} />
                            {m.running.agents} of {m.capacity.maxAgents}
                          </span>
                        </td>
                        <td className="hide-sm">
                          <span className="meter-cell">
                            <Meter value={m.running.jobs} max={m.capacity.maxJobs} label={`${m.name} jobs`} />
                            {m.running.jobs} of {m.capacity.maxJobs}
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
          <p>Enter this code when you enroll the node on the new machine. It works once{code.expiresAt ? ` and expires ${relative(code.expiresAt)}` : ''}.</p>
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
          <p>A one-time code lets a machine exchange it for its own node token. The machine then appears here and starts leasing work it can run.</p>
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
      <p>The machine stops leasing new work. Agents and jobs already running on it continue until they finish.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
