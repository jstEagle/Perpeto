import { useResource } from '../app/hub-context';
import { Async, Disclosure, Empty, PageHeader } from '../components/ui';
import { IconAccounts } from '../components/icons';
import { AccountStatusLabel } from '../components/status';
import { providerLabel } from '../workflow/registry';
import { clock, relative } from '../lib/format';

export function AccountsPage() {
  const accounts = useResource((api) => api.listAccounts(), [], (e) => e.subject.kind === 'account' || e.subject.kind === 'machine');
  const machines = useResource((api) => api.listMachines(), []);
  const name = (id: string) => machines.data?.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader title="Accounts" description="Harness subscriptions available on each machine. Credentials stay on the machine that owns them; the hub sees only labels and status." />
      <Async resource={accounts} what="accounts">
        {(list) =>
          list.length === 0 ? (
            <section className="card">
              <Empty title="No accounts reported" icon={<IconAccounts />}>
                Machines report their harness accounts with each heartbeat.
              </Empty>
            </section>
          ) : (
            <>
              <section className="card">
                <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Accounts by machine</caption>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Provider</th>
                      <th scope="col" className="hide-sm">Machine</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="hide-sm">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list]
                      .sort((a, b) => name(a.machineId).localeCompare(name(b.machineId)) || a.provider.localeCompare(b.provider))
                      .map((a) => (
                        <tr key={a.id}>
                          <td>
                            <span className="cell-title">{a.label}</span>
                            <span className="cell-sub mono">{a.id}</span>
                          </td>
                          <td>{providerLabel(a.provider)}</td>
                          <td className="hide-sm mono">{name(a.machineId)}</td>
                          <td>
                            <AccountStatusLabel status={a.status} />
                            {a.status === 'cooling' && a.cooldownUntil && (
                              <span className="cell-sub">
                                Until {clock(a.cooldownUntil)}, {relative(a.cooldownUntil)}
                              </span>
                            )}
                            {a.status === 'invalid' && <span className="cell-sub">Sign in again on {name(a.machineId)}.</span>}
                          </td>
                          <td className="hide-sm muted">{relative(a.lastUsedAt)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                </div>
                <div className="card-foot">
                  <Disclosure summary="What the statuses mean">
                    <dl className="kv">
                      <dt>Cooling down</dt>
                      <dd>The harness reported a rate limit. The account is skipped until the time shown.</dd>
                      <dt>Invalid</dt>
                      <dd>The machine could not authenticate with this account.</dd>
                      <dt>Disabled</dt>
                      <dd>Turned off on the machine.</dd>
                    </dl>
                  </Disclosure>
                </div>
              </section>
            </>
          )
        }
      </Async>
    </div>
  );
}
