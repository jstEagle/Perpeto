import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import { Async, Button, Disclosure, Empty, Mono, PageHeader, Panel, Stat } from '../components/ui';
import { IconStorage, IconAlert } from '../components/icons';
import { StatusLabel } from '../components/status';
import type { Tone } from '../components/status';
import { duration, relative } from '../lib/format';
import {
  attentionText,
  cleanupTotals,
  formatBytes,
  freePercent,
  KIND_LABEL,
  kindRows,
  previewedIds,
  STATE_LABEL,
} from '../api/storage';
import type { FleetStorage, MachineStorage, MachineStorageSummary, StorageCleanup, StorageItem, StorageState } from '../api/storage';

const STATE_TONE: Record<StorageState, Tone> = { ok: 'quiet', low: 'attention', critical: 'failed' };
const isStorageEvent = (e: { type: string }) => e.type.startsWith('storage.');

export function StoragePage() {
  const fleet = useResource((api) => api.storage(), [], isStorageEvent);
  return (
    <div className="page">
      <PageHeader
        title="Storage"
        description="Disk across your machines, what Perpeto can safely reclaim, and what needs a person. Perpeto removes only its own finished work, never uncommitted or unpushed changes."
      />
      <Async resource={fleet} what="storage">
        {(f) =>
          f === null ? (
            <section className="card">
              <Empty title="This hub doesn’t track storage yet" icon={<IconStorage />}>
                Update the hub and nodes to a version with the storage janitor, and add a storage section to each node’s config.
              </Empty>
            </section>
          ) : f.machines.length === 0 ? (
            <section className="card">
              <Empty title="No machines report storage yet" icon={<IconStorage />}>
                Machines report their disk after their first scan, a minute or so after the node starts.
              </Empty>
            </section>
          ) : (
            <FleetView fleet={f} />
          )
        }
      </Async>
    </div>
  );
}

function FleetView({ fleet }: { fleet: FleetStorage }) {
  const search = useSearch({ from: '/storage' });
  const navigate = useNavigate({ from: '/storage' });
  const fallback = fleet.machines.find((m) => m.state === 'critical') ?? fleet.machines.find((m) => m.state === 'low') ?? fleet.machines[0];
  const selected = fleet.machines.find((m) => m.machineId === search.machine) ?? fallback;
  const select = (id: string) => void navigate({ search: { machine: id }, replace: true });
  const { totals } = fleet;
  const kinds = kindRows(totals.reclaimableByKind);

  return (
    <>
      {fleet.alerts.length > 0 && (
        <section className="card storage-alerts" aria-label="Disk alerts">
          <ul className="rows">
            {fleet.alerts.map((a) => (
              <li key={a.machineId}>
                <StatusLabel tone={a.severity === 'critical' ? 'failed' : 'attention'}>{a.severity === 'critical' ? 'Critically full' : 'Low on space'}</StatusLabel>
                <span className="row-main">
                  <span className="row-title">{a.name}</span>
                  <span className="row-meta row-meta-wrap">{a.evidence}</span>
                </span>
                <Button size="sm" variant={a.machineId === selected?.machineId ? 'ghost' : 'secondary'} onClick={() => select(a.machineId)}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <dl className="metrics">
          <Stat label="Free across machines" value={formatBytes(totals.freeBytes)} detail={`of ${formatBytes(totals.totalBytes)}`} />
          <Stat label="Safe to reclaim" value={formatBytes(totals.reclaimableBytes)} />
          <Stat label="Needs a person" value={totals.attentionCount} detail={totals.advisoryBytes ? `${formatBytes(totals.advisoryBytes)} in shared caches` : undefined} />
        </dl>
      </section>

      <div className="cols">
        <Panel title="Machines">
          <ul className="rows storage-machines">
            {fleet.machines.map((m) => (
              <MachineRow key={m.machineId} machine={m} selected={m.machineId === selected?.machineId} onSelect={() => select(m.machineId)} />
            ))}
          </ul>
        </Panel>
        <Panel title="Reclaimable by kind">
          {kinds.length === 0 ? (
            <p className="muted">Nothing to reclaim right now.</p>
          ) : (
            <table className="table">
              <caption className="visually-hidden">Bytes the janitor can reclaim, by kind, across machines</caption>
              <tbody>
                {kinds.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.label}</td>
                    <td className="num">{formatBytes(k.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="storage-policy muted">
            {policyText(fleet)}
          </p>
        </Panel>
      </div>

      {selected && <MachineDetail key={selected.machineId} summary={selected} />}
    </>
  );
}

function policyText(fleet: FleetStorage): string {
  const p = fleet.policy;
  const parts = [
    p.finishedWorkspaceTtlHours !== undefined ? `Finished work is kept ${p.finishedWorkspaceTtlHours} h` : null,
    p.idleArtifactTtlHours !== undefined ? `build output is stripped after ${p.idleArtifactTtlHours} h idle` : null,
    p.cleanupForeignWorktrees ? 'merged T3 worktrees are cleaned too' : 'T3 worktrees are only listed',
  ].filter(Boolean);
  return `${parts.join(', ')}.${p.autoClean ? ' Safe items are cleaned automatically.' : ''}`;
}

function MachineRow({ machine: m, selected, onSelect }: { machine: MachineStorageSummary; selected: boolean; onSelect(): void }) {
  const disk = m.storage?.disk;
  const free = freePercent(disk);
  const used = disk ? disk.totalBytes - disk.freeBytes : 0;
  return (
    <li className={`storage-machine ${selected ? 'is-selected' : ''}`}>
      <button type="button" className="storage-machine-button" onClick={onSelect} aria-pressed={selected}>
        <span className="storage-machine-head">
          <span className="row-title">{m.name}</span>
          <StatusLabel tone={STATE_TONE[m.state]}>{m.online ? STATE_LABEL[m.state] : 'Offline'}</StatusLabel>
        </span>
        {disk ? (
          <>
            <span className={`storage-bar ${m.state === 'critical' ? 'is-critical' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={disk.totalBytes} aria-valuenow={used} aria-label={`${m.name} disk used`}>
              <span style={{ width: `${Math.min(100, (used / disk.totalBytes) * 100)}%` }} />
            </span>
            <span className="row-meta">
              {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)} · {free !== null ? `${free < 10 ? free.toFixed(1) : Math.round(free)}%` : '—'}
              {m.storage && m.storage.reclaimableBytes > 0 ? ` · ${formatBytes(m.storage.reclaimableBytes)} reclaimable` : ''}
              {m.storage?.attentionCount ? ` · ${m.storage.attentionCount} to review` : ''}
            </span>
          </>
        ) : (
          <span className="row-meta">No scan reported yet.</span>
        )}
      </button>
    </li>
  );
}

function MachineDetail({ summary }: { summary: MachineStorageSummary }) {
  const detail = useResource((api) => api.machineStorage(summary.machineId), [summary.machineId], isStorageEvent);
  return (
    <Async resource={detail} what={`${summary.name} storage`}>
      {(d) => <MachineInventory machine={d} onChanged={detail.reload} />}
    </Async>
  );
}

function MachineInventory({ machine: d, onChanged }: { machine: MachineStorage; onChanged(): void }) {
  const inv = d.inventory;
  if (!inv) {
    return (
      <Panel title={d.name}>
        <p className="muted">No inventory yet. It arrives with the machine’s next scan.</p>
      </Panel>
    );
  }
  const attention = inv.items.filter((i) => i.attention);
  const reclaimable = inv.items.filter((i) => i.reclaimable);
  const advisory = inv.items.filter((i) => i.advisory);
  const kept = inv.items.filter((i) => !i.reclaimable && !i.attention && !i.advisory && !i.parentId);
  return (
    <>
      <h2 className="storage-machine-title">
        {d.name}
        <span className="muted">
          {' '}
          · scanned {relative(inv.scannedAt)}
          {inv.aggressive ? ' · aggressive retention' : ''}
        </span>
      </h2>
      <CleanupPanel machine={d} reclaimable={reclaimable} onChanged={onChanged} />
      <div className="cols cols-even">
        <Panel title="Needs a person" actions={attention.length ? `${attention.length}` : undefined}>
          {attention.length === 0 ? (
            <p className="muted">Nothing here. Uncommitted or unpushed work shows up here instead of being deleted.</p>
          ) : (
            <ul className="rows">
              {attention.map((i) => (
                <li key={i.id}>
                  <IconAlert />
                  <span className="row-main">
                    <span className="row-title" title={i.path}>
                      {i.gitState?.branch ?? i.path}
                    </span>
                    <span className="row-meta row-meta-wrap">
                      {attentionText(i)} · <Mono>{i.path}</Mono>
                    </span>
                  </span>
                  <span className="row-end tabular">{formatBytes(i.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Your call">
          {advisory.length === 0 && inv.processes.length === 0 ? (
            <p className="muted">No shared caches or stale processes reported.</p>
          ) : (
            <ul className="rows">
              {advisory.map((i) => (
                <li key={i.id}>
                  <span className="row-main">
                    <span className="row-title">{i.name ?? i.path}</span>
                    <span className="row-meta row-meta-wrap">{i.hint ? <Mono>{i.hint}</Mono> : i.reason}</span>
                  </span>
                  <span className="row-end tabular">
                    {i.approximate ? 'at least ' : ''}
                    {formatBytes(i.bytes)}
                  </span>
                </li>
              ))}
              {inv.processes.map((p) => (
                <li key={`${p.kind}-${p.pid ?? p.udid}`}>
                  <span className="row-main">
                    <span className="row-title">
                      {p.kind === 'simulator' ? `${p.name} simulator` : `${p.name} dev server`}
                      {p.elapsedSec ? <span className="muted"> · {duration(p.elapsedSec)}</span> : null}
                    </span>
                    <span className="row-meta row-meta-wrap">
                      {p.cwdMissing ? 'Its folder was deleted. ' : ''}
                      {p.hint ? <Mono>{p.hint}</Mono> : p.reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="storage-policy muted">Perpeto reports these and never clears them itself.</p>
        </Panel>
      </div>
      {kept.length > 0 && (
        <Panel>
          <Disclosure summary={`Kept · ${kept.length} ${kept.length === 1 ? 'item' : 'items'}, ${formatBytes(kept.reduce((s, i) => s + i.bytes, 0))}`}>
            <ItemTable items={kept} />
          </Disclosure>
        </Panel>
      )}
    </>
  );
}

function ItemTable({ items }: { items: StorageItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Storage items</caption>
        <thead>
          <tr>
            <th scope="col">Folder</th>
            <th scope="col" className="hide-sm">
              Why
            </th>
            <th scope="col" className="num">
              Size
            </th>
          </tr>
        </thead>
        <tbody>
          {[...items]
            .sort((a, b) => b.bytes - a.bytes)
            .map((i) => (
              <tr key={i.id}>
                <td>
                  <span className="cell-title storage-path" title={i.path}>
                    {i.path}
                  </span>
                  <span className="cell-sub">{[KIND_LABEL[i.kind], i.gitState?.branch, i.lastModifiedAt ? `active ${relative(i.lastModifiedAt)}` : null].filter(Boolean).join(' · ')}</span>
                </td>
                <td className="hide-sm muted">{i.reason}</td>
                <td className="num">{formatBytes(i.bytes)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

type Phase = { step: 'idle' } | { step: 'previewing' | 'cleaning'; cleanup?: StorageCleanup } | { step: 'previewed' | 'cleaned'; cleanup: StorageCleanup };

/**
 * Preview first: a dry run on the machine lists exactly what would go. "Clean
 * up" then runs the same items; the machine re-checks each one before it
 * deletes, so anything that changed since the preview is skipped.
 */
function CleanupPanel({ machine, reclaimable, onChanged }: { machine: MachineStorage; reclaimable: StorageItem[]; onChanged(): void }) {
  const { api } = useHub();
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (mode: 'dry-run' | 'execute', itemIds?: string[]) => {
    setError(null);
    setPhase({ step: mode === 'dry-run' ? 'previewing' : 'cleaning' });
    try {
      let cleanup = await api.requestStorageCleanup(machine.machineId, { mode, ...(itemIds ? { itemIds } : {}) });
      for (let i = 0; i < 120 && cleanup.status !== 'completed'; i++) {
        if (!alive.current) return;
        setPhase({ step: mode === 'dry-run' ? 'previewing' : 'cleaning', cleanup });
        await new Promise((resolve) => setTimeout(resolve, 700));
        cleanup = await api.storageCleanup(machine.machineId, cleanup.id);
      }
      if (!alive.current) return;
      if (cleanup.status !== 'completed') throw new Error(`${machine.name} has not reported back yet. It runs the cleanup on its next heartbeat; check again in a minute.`);
      setPhase({ step: mode === 'dry-run' ? 'previewed' : 'cleaned', cleanup });
      if (mode === 'execute') onChanged();
    } catch (e) {
      if (!alive.current) return;
      setPhase({ step: 'idle' });
      setError(`The cleanup didn’t finish. ${(e as Error).message}`);
    }
  };
  const total = reclaimable.filter((i) => !(i.parentId && reclaimable.some((p) => p.id === i.parentId && p.action === 'delete'))).reduce((s, i) => s + i.bytes, 0);
  const busy = phase.step === 'previewing' || phase.step === 'cleaning';
  const waiting = busy && phase.cleanup ? (phase.cleanup.status === 'pending' ? `Waiting for ${machine.name} to pick it up…` : `${machine.name} is working on it…`) : 'Sending to the machine…';

  return (
    <Panel title="Clean up" actions={busy ? waiting : undefined}>
      {phase.step === 'previewed' ? (
        <Preview cleanup={phase.cleanup} />
      ) : phase.step === 'cleaned' ? (
        <Result cleanup={phase.cleanup} />
      ) : (
        <p className="storage-lead">
          {reclaimable.length === 0 ? (
            <span className="muted">Nothing on {machine.name} is safe to remove right now.</span>
          ) : (
            <>
              <span className="cell-title">{formatBytes(total)}</span> on {machine.name} is safe to remove: {reclaimable.length} {reclaimable.length === 1 ? 'item' : 'items'} of finished, merged or pushed work and git-ignored build output.
            </>
          )}
        </p>
      )}
      <div className="row storage-actions">
        {phase.step === 'previewed' ? (
          <>
            <Button variant="primary" disabled={previewedIds(phase.cleanup).length === 0} onClick={() => void run('execute', previewedIds(phase.cleanup))}>
              Clean up {formatBytes(cleanupTotals(phase.cleanup).bytes)}
            </Button>
            <Button variant="ghost" onClick={() => setPhase({ step: 'idle' })}>
              Cancel
            </Button>
          </>
        ) : phase.step === 'cleaned' ? (
          <Button onClick={() => setPhase({ step: 'idle' })}>Done</Button>
        ) : (
          <Button variant="primary" busy={busy} disabled={reclaimable.length === 0} onClick={() => void run('dry-run', reclaimable.map((i) => i.id))}>
            {phase.step === 'previewing' ? 'Previewing…' : phase.step === 'cleaning' ? 'Cleaning…' : 'Preview cleanup'}
          </Button>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}

function Preview({ cleanup }: { cleanup: StorageCleanup }) {
  const t = cleanupTotals(cleanup);
  const actions = (cleanup.result?.actions ?? []).filter((a) => a.status === 'would-delete' || a.status === 'would-strip');
  const others = (cleanup.result?.actions ?? []).filter((a) => a.status !== 'would-delete' && a.status !== 'would-strip');
  return (
    <div className="stack-sm">
      <p className="storage-lead">
        Nothing is deleted yet. This would free <span className="cell-title">{formatBytes(t.bytes)}</span> across {t.done} {t.done === 1 ? 'item' : 'items'}
        {others.length ? `, and leave ${others.length} alone` : ''}.
      </p>
      <ul className="rows storage-preview">
        {actions.map((a) => (
          <li key={a.itemId}>
            <span className="row-main">
              <span className="row-title storage-path" title={a.path}>
                {a.path ?? a.itemId}
              </span>
              <span className="row-meta">{a.status === 'would-strip' ? 'Remove build output' : 'Remove folder'}</span>
            </span>
            <span className="row-end tabular">{formatBytes(a.bytes)}</span>
          </li>
        ))}
        {others.map((a) => (
          <li key={a.itemId}>
            <span className="row-main">
              <span className="row-title storage-path muted" title={a.path}>
                {a.path ?? a.itemId}
              </span>
              <span className="row-meta row-meta-wrap">Kept: {a.reason ?? a.status}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Result({ cleanup }: { cleanup: StorageCleanup }) {
  const t = cleanupTotals(cleanup);
  const problems = (cleanup.result?.actions ?? []).filter((a) => a.status === 'needs-attention' || a.status === 'failed' || a.status === 'skipped');
  return (
    <div className="stack-sm">
      <p className="storage-lead">
        Freed <span className="cell-title">{formatBytes(t.bytes)}</span> · {t.done} removed
        {t.skipped ? ` · ${t.skipped} skipped` : ''}
        {t.attention ? ` · ${t.attention} changed since the preview and kept` : ''}
        {t.failed ? ` · ${t.failed} failed` : ''}
      </p>
      {problems.length > 0 && (
        <ul className="rows">
          {problems.map((a) => (
            <li key={a.itemId}>
              {a.status === 'failed' ? <StatusLabel tone="failed">Failed</StatusLabel> : <StatusLabel tone="attention">Kept</StatusLabel>}
              <span className="row-main">
                <span className="row-title storage-path">{a.path ?? a.itemId}</span>
                <span className="row-meta row-meta-wrap">{a.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
