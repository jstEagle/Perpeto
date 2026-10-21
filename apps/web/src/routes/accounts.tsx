import { useResource } from '../app/hub-context';
import { Async, Empty, PageHeader } from '../components/ui';
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
            <div className="panel">
              <Empty title="No accounts reported.">Machines report their harness accounts with each heartbeat.</Empty>
            </div>
          ) : (
            <>
              <div className="panel panel-flush table-wrap">
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
                            <span className="mono muted">{a.id}</span>
                          </td>
                          <td>{providerLabel(a.provider)}</td>
                          <td className="hide-sm">{name(a.machineId)}</td>
                          <td>
                            <div className="cell-stack">
                              <AccountStatusLabel status={a.status} />
                              {a.status === 'cooling' && a.cooldownUntil && <span className="note">Until {clock(a.cooldownUntil)}, {relative(a.cooldownUntil)}</span>}
                              {a.status === 'invalid' && <span className="note">Sign in again on {name(a.machineId)}.</span>}
                            </div>
                          </td>
                          <td className="hide-sm muted">{relative(a.lastUsedAt)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <dl className="kv legend-kv">
                <dt>Cooling down</dt>
                <dd>The harness reported a rate limit. The account is skipped until the time shown.</dd>
                <dt>Invalid</dt>
                <dd>The machine could not authenticate with this account.</dd>
                <dt>Disabled</dt>
                <dd>Turned off on the machine.</dd>
              </dl>
            </>
          )
        }
      </Async>
    </div>
  );
}
