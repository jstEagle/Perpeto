import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HubProvider } from '../app/hub-context';
import { DemoHub } from '../api/demo';
import { DEMO_IDS } from '../api/fixtures';
import { observeMachines } from '../api/observe-fixtures';
import { MachinesPage } from './machines';

// The brand SVGs load as raw imports from the design-tokens package, which a
// git worktree resolves outside Vite's allowed root; the loader isn't under test.
vi.mock('../brand/logo', () => ({ SpindleLoader: ({ label }: { label?: string }) => <span>{label}</span> }));

const NOW = Date.now();

beforeAll(() => {
  // jsdom has no modal dialogs; open and close them as attributes.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void };
  if (!proto.showModal)
    Object.assign(proto, {
      showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
      close(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
});
afterEach(cleanup);

function show(hub: DemoHub) {
  render(
    <HubProvider initial={hub}>
      <MachinesPage />
    </HubProvider>,
  );
}

const row = async (name: string) => within(await screen.findByRole('listitem', { name }));

describe('Fleet', () => {
  it('shows the two demo Macs with health, slots and why the mini is not taking work', async () => {
    show(new DemoHub(NOW));
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet' })).toBeTruthy();
    const mini = await row('studio-mini');
    expect(mini.getByText('Overloaded')).toBeTruthy();
    expect(mini.getByText('Load 13.0 per core (limit 1.5)')).toBeTruthy();
    expect(mini.getByText('2,700 processes (limit 2,000)')).toBeTruthy();
    expect(mini.getByText('4 running · limit 0')).toBeTruthy();
    expect(mini.getByText('13.0 per core')).toBeTruthy();
    const mbp = await row('justus-mbp');
    expect(mbp.getByText('Online')).toBeTruthy();
    expect(mbp.getByText('2 of 4')).toBeTruthy();
    expect(mbp.getByText('AC')).toBeTruthy();
    expect(mbp.queryByRole('list', { name: /Why/ })).toBeNull();
    // Two machines need no filter.
    expect(screen.queryByRole('radiogroup', { name: 'Show machines' })).toBeNull();
    const stats = screen.getByRole('region', { name: 'Fleet capacity' });
    expect(within(stats).getByText('Accepting work').closest('.metric')?.textContent).toContain('1of 2');
  });

  it('cordons and uncordons through updateMachine', async () => {
    const hub = new DemoHub(NOW);
    const update = vi.spyOn(hub, 'updateMachine');
    show(hub);
    fireEvent.click((await row('justus-mbp')).getByRole('button', { name: 'Cordon' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(DEMO_IDS.linux, { cordoned: true }));
    const mbp = await row('justus-mbp');
    expect(await mbp.findByText('Cordoned by the owner')).toBeTruthy();
    expect(mbp.getByText('Cordoned')).toBeTruthy();
    fireEvent.click(mbp.getByRole('button', { name: 'Uncordon' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(DEMO_IDS.linux, { cordoned: false, drain: false }));
    expect(await (await row('justus-mbp')).findByText('Online')).toBeTruthy();
  });

  it('drains after a confirmation', async () => {
    const hub = new DemoHub(NOW);
    const update = vi.spyOn(hub, 'updateMachine');
    show(hub);
    fireEvent.click((await row('justus-mbp')).getByRole('button', { name: 'Drain' }));
    expect(update).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Drain justus-mbp?' });
    expect(within(dialog).getByText(/2 agents and 0 jobs already running finish first/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drain machine' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(DEMO_IDS.linux, { drain: true }));
    expect(await (await row('justus-mbp')).findByText('Draining: 2 agents finishing')).toBeTruthy();
  });

  it('reads well with 50 machines: filter and the ones that need a look first', async () => {
    show(new DemoHub(NOW, 'full', { fleetSize: 50 }));
    const list = await screen.findByRole('list', { name: '50 machines' });
    const rows = within(list).getAllByRole('listitem').filter((li) => li.classList.contains('fleet-row'));
    expect(rows).toHaveLength(50);
    expect(within(rows[0]).getByText('Offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Not accepting/ }));
    const not = await screen.findByRole('list', { name: /machines?$/ });
    const notRows = within(not).getAllByRole('listitem').filter((li) => li.classList.contains('fleet-row'));
    expect(notRows.length).toBeGreaterThan(5);
    expect(notRows.length).toBeLessThan(50);
    for (const r of notRows) expect(r.querySelector('.fleet-reasons')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Name' }));
    fireEvent.click(screen.getByRole('radio', { name: /^All/ }));
    const all = within(await screen.findByRole('list', { name: '50 machines' }))
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('fleet-row'))
      .map((li) => li.getAttribute('aria-label'));
    expect(all[0]).toBe('agent-box-01');
  });

  it('falls back to drain only on an older hub without placement', async () => {
    const hub = new DemoHub(NOW, 'observe');
    const drain = vi.spyOn(hub, 'drainMachine');
    const update = vi.spyOn(hub, 'updateMachine');
    show(hub);
    const [first] = observeMachines(NOW);
    const r = await row(first.name);
    expect(r.getByText('Online')).toBeTruthy();
    expect(r.queryByRole('button', { name: 'Cordon' })).toBeNull();
    fireEvent.click(r.getByRole('button', { name: 'Drain' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Drain machine' }));
    await waitFor(() => expect(drain).toHaveBeenCalledWith(first.id));
    expect(update).not.toHaveBeenCalled();
  });
});
