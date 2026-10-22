import { useEffect, useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Account, Pacing, PacingAccount } from '../api/types';
import { Async, Button, Dialog, Disclosure, Empty, Field, PageHeader, Panel } from '../components/ui';
import { IconAccounts, IconChevronRight, IconEdit } from '../components/icons';
import { StatusLabel } from '../components/status';
import { PacingStateLabel, UsageMeter } from '../components/pacing';
import { planSuggestions, providerLabel } from '../workflow/registry';
import { clock, plural, relative } from '../lib/format';
import { meterWindows, span } from '../lib/pacing';

const refreshOn = (e: { type: string; subject: { kind: string } }) => e.subject.kind === 'account' || e.subject.kind === 'machine' || e.type.startsWith('pacing.');

export function AccountsPage() {
  const accounts = useResource((api) => api.listAccounts(), [], refreshOn);
  const pacing = useResource((api) => api.pacing().catch(() => null), [], (e) => e.type.startsWith('pacing.') || e.subject.kind === 'account');
  const machines = useResource((api) => api.listMachines(), []);
  const [editing, setEditing] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const name = (id: string) => machines.data?.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader
        title="Accounts"
        description="The Claude and Codex subscriptions signed in on your machines, and how much of each limit is used. Credentials stay on the machine that owns them."
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add subscription
          </Button>
        }
      />
      <Async resource={accounts} what="subscriptions">
        {(list) =>
          list.length === 0 ? (
            <section className="card">
              <Empty
                title="No subscriptions yet"
                icon={<IconAccounts />}
                action={
                  <Button variant="primary" size="lg" onClick={() => setAdding(true)}>
                    How to add one
                  </Button>
                }
              >
                Machines report the Claude and Codex logins in their account pool with each heartbeat.
              </Empty>
            </section>
          ) : (
            <>
              {groupByProvider(list, pacing.data ?? undefined).map(([provider, subs], index) => (
                <Panel
                  key={provider}
                  title={providerLabel(provider)}
                  actions={
                    pacing.data && index === 0 ? (
                      <Link to="/pacing" className="card-link">
                        {pacing.data.enabled ? `Paced in ${pacing.data.strategy === 'parallel' ? 'parallel' : 'rotation'}` : 'Pacing is off'}
                        <IconChevronRight />
                      </Link>
                    ) : (
                      plural(subs.length, 'subscription')
                    )
                  }
                >
                  <ul className="rows subs">
                    {subs.map((a) => (
                      <SubscriptionRow key={a.id} account={a} machine={name(a.machineId)} pacing={pacing.data ?? undefined} onEdit={() => setEditing(a)} />
                    ))}
                  </ul>
                </Panel>
              ))}
              <Disclosure summary="What the states mean">
                <dl className="kv">
                  <dt>Burning</dt>
                  <dd>Agents are using this subscription now, at the pace that uses its limit by the reset.</dd>
                  <dt>Up next</dt>
                  <dd>Takes over when the one burning now finishes its turn.</dd>
                  <dt>Resting</dt>
                  <dd>Used for this window; it waits for its limit to reset.</dd>
                  <dt>Cooling down</dt>
                  <dd>The harness reported a rate limit. Perpeto skips it until the time shown.</dd>
                  <dt>Used up</dt>
                  <dd>Nothing left until the reset. Pacing aims to reach this exactly as the window ends.</dd>
                </dl>
              </Disclosure>
            </>
          )
        }
      </Async>
      <EditSubscription account={editing} onClose={() => setEditing(null)} onSaved={accounts.reload} />
      <AddSubscription open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

const PROVIDER_ORDER = ['claudeAgent', 'codex'];
/** Providers in a fixed order; within each, the rotation order: burning, up next, then by next turn. */
function groupByProvider(list: Account[], pacing?: Pacing): [string, Account[]][] {
  const groups = new Map<string, Account[]>();
  for (const a of list) groups.set(a.provider, [...(groups.get(a.provider) ?? []), a]);
  const rank = (p: string) => (PROVIDER_ORDER.includes(p) ? PROVIDER_ORDER.indexOf(p) : PROVIDER_ORDER.length);
  const now = Date.now();
  const turn = (a: Account) => {
    const state = pacing?.accounts.find((p) => p.accountId === a.id)?.state;
    if (state === 'burning') return -2;
    if (state === 'next') return -1;
    const next = pacing?.timeline.filter((s) => s.accountId === a.id && s.phase === 'burn' && Date.parse(s.to) > now).map((s) => Date.parse(s.from));
    return next?.length ? Math.min(...next) : Number.POSITIVE_INFINITY;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([p, subs]) => [p, subs.sort((x, y) => turn(x) - turn(y) || x.label.localeCompare(y.label))]);
}

/** A line under the state word: agents now, or when its next turn starts. */
function stateDetail(paced: PacingAccount | undefined, pacing: Pacing | undefined, now: number): string | null {
  if (!paced || !pacing) return null;
  if (paced.state === 'burning') return plural(paced.runningAgents, 'agent');
  const next = pacing.timeline
    .filter((s) => s.accountId === paced.accountId && s.phase === 'burn' && Date.parse(s.from) > now)
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))[0];
  return next ? `Turn in ${span(Date.parse(next.from) - now)}` : null;
}

function SubscriptionRow({ account: a, machine, pacing, onEdit }: { account: Account; machine: string; pacing?: Pacing; onEdit(): void }) {
  const now = Date.now();
  const paced = pacing?.accounts.find((p) => p.accountId === a.id);
  const windows = meterWindows(a, paced).slice(0, 2);
  const detail = stateDetail(paced, pacing, now);
  return (
    <li className="sub">
      <div className="sub-id">
        <span className="cell-title">{a.label}</span>
        <span className="cell-sub">
          {a.plan ?? paced?.plan ?? 'Plan not set'} · <code className="mono">{machine}</code>
        </span>
      </div>
      <div className="sub-meters">
        {windows.length ? windows.map((w) => <UsageMeter key={w.id} window={w} now={now} />) : <p className="muted sub-none">No limits reported yet. They appear after the machine’s next usage check.</p>}
      </div>
      <div className="sub-state">
        {a.status === 'invalid' ? (
          <>
            <StatusLabel tone="failed">Sign-in needed</StatusLabel>
            <span className="cell-sub">Sign in again on {machine}.</span>
          </>
        ) : a.status === 'disabled' ? (
          <StatusLabel tone="stopped">Disabled</StatusLabel>
        ) : a.status === 'cooling' && (!paced || paced.state === 'cooling') ? (
          <>
            <StatusLabel tone="waiting">Cooling down</StatusLabel>
            {a.cooldownUntil && <span className="cell-sub">Until {clock(a.cooldownUntil)}</span>}
          </>
        ) : paced ? (
          <>
            <PacingStateLabel state={paced.state} />
            {detail && <span className="cell-sub">{detail}</span>}
          </>
        ) : (
          <>
            <StatusLabel tone="done">Ready</StatusLabel>
            <span className="cell-sub">Used {relative(a.lastUsedAt)}</span>
          </>
        )}
      </div>
      <Button variant="ghost" size="sm" icon onClick={onEdit} aria-label={`Edit ${a.label}`} title="Edit label and plan">
        <IconEdit size={16} />
      </Button>
    </li>
  );
}

function EditSubscription({ account, onClose, onSaved }: { account: Account | null; onClose(): void; onSaved(): void }) {
  const { api } = useHub();
  const [label, setLabel] = useState('');
  const [plan, setPlan] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!account) return;
    setLabel(account.label);
    setPlan(account.plan ?? '');
    setError(null);
  }, [account]);
  const save = async () => {
    if (!account) return;
    if (!label.trim()) return setError('Give the subscription a label, such as “Claude · build”.');
    setBusy(true);
    try {
      const patch = { ...(label.trim() !== account.label ? { label: label.trim() } : {}), ...(plan.trim() !== (account.plan ?? '') ? { plan: plan.trim() || null } : {}) };
      if (Object.keys(patch).length) await api.updateAccount(account.id, patch);
      onSaved();
      onClose();
    } catch (e) {
      setError(`Saving failed. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!account}
      onClose={onClose}
      title="Edit subscription"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Label" htmlFor={`${id}-label`} error={error} hint="Shown everywhere this subscription appears.">
          <input id={`${id}-label`} className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-label-error` : undefined} />
        </Field>
        <Field label="Plan" htmlFor={`${id}-plan`} hint="Pacing reads the limits the harness reports; the plan is for you.">
          <input id={`${id}-plan`} className="input" value={plan} placeholder={account?.provider === 'codex' ? 'Pro' : 'Max 20x'} list={`${id}-plans`} onChange={(e) => setPlan(e.target.value)} />
          <datalist id={`${id}-plans`}>
            {planSuggestions(account?.provider ?? '').map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function AddSubscription({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a subscription"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="stack-sm reading">
        <p>A subscription is a Claude or Codex login in the account pool of the machine that runs its agents. The login never leaves that machine; its heartbeat reports the label, plan and limits, and it appears here on its own.</p>
        <p>
          The <code className="mono">perpeto</code> command line can’t enrol a login yet. Until it can, a login is added to a machine’s pool with <code className="mono">importAccount</code> from{' '}
          <code className="mono">@perpeto/accounts</code>, as described in <code className="mono">packages/accounts/README.md</code>.
        </p>
      </div>
    </Dialog>
  );
}
