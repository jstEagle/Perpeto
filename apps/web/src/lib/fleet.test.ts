import { describe, expect, it } from 'vitest';
import { applyMachinePatch, fleetMachines, fleetPlacement, generateFleet } from '../api/fleet-fixtures';
import { observeMachines } from '../api/observe-fixtures';
import type { Machine } from '../api/types';
import { bytes, diskCell, filterFleet, fleetSummary, healthLine, isHeld, loadCell, memoryCell, placementOf, powerCell, slotsSub, slotsText, sortFleet } from './fleet';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const AT = new Date(NOW).toISOString();

describe('demo fleet', () => {
  const [mini, mbp] = fleetMachines(NOW);

  it('stops placing on the overloaded Mac mini and says why', () => {
    const p = placementOf(mini);
    expect(p.status).toBe('overloaded');
    expect(p.accepting).toBe(false);
    expect(p.loadPerCore).toBeCloseTo(13.04, 2);
    expect(p.effective).toEqual({ agents: 0, jobs: 0 });
    expect(p.held).toEqual({ agents: 4, jobs: 1 });
    expect(p.reasons.map((r) => r.message)).toEqual(expect.arrayContaining(['Load 13.0 per core (limit 1.5)', '2,700 processes (limit 2,000)']));
    expect(slotsText(p)).toBe('4 running · limit 0');
    expect(slotsSub(p)).toBe('1 of 0 jobs · 6 configured');
  });

  it('keeps the MacBook Pro on AC accepting work', () => {
    const p = placementOf(mbp);
    expect(p).toMatchObject({ status: 'online', accepting: true, effective: { agents: 4, jobs: 1 }, held: { agents: 2, jobs: 0 } });
    expect(p.reasons).toEqual([]);
    expect(slotsText(p)).toBe('2 of 4');
    expect(powerCell(mbp)).toMatchObject({ value: 'AC', sub: '100%' });
  });

  it('formats health for the row and for narrow screens', () => {
    expect(loadCell(mini)).toMatchObject({ value: '13.0 per core', sub: '130 · 118 · 97', strong: true });
    expect(memoryCell(mini)).toMatchObject({ value: '2.4 GB free', sub: 'of 32 GB · high', strong: true });
    expect(diskCell(mbp)).toMatchObject({ value: '684 GB free', sub: 'of 2 TB', strong: false });
    expect(healthLine(mbp)).toBe('Load 0.4 per core · 20 GB memory free · 684 GB disk free · AC');
    expect(bytes(4.1e9)).toBe('4.1 GB');
  });

  it('summarises accepting machines and effective slots', () => {
    expect(fleetSummary([mini, mbp])).toMatchObject({ total: 2, accepting: 1, held: 6, effective: 4, configured: 10, overloaded: 1, cordoned: 0, offline: 0 });
  });
});

describe('schedule changes', () => {
  const mbp = fleetMachines(NOW)[1];

  it('cordons, drains and uncordons', () => {
    const cordoned = applyMachinePatch(mbp, { cordoned: true }, AT);
    expect(placementOf(cordoned)).toMatchObject({ status: 'cordoned', accepting: false });
    expect(placementOf(cordoned).reasons[0].message).toBe('Cordoned by the owner');
    expect(isHeld(cordoned)).toBe(true);

    const draining = applyMachinePatch(mbp, { drain: true }, AT);
    expect(placementOf(draining).status).toBe('draining');
    expect(draining.status).toBe('draining');
    expect(placementOf(draining).reasons[0].message).toBe('Draining: 2 agents finishing');
    const drained = applyMachinePatch({ ...mbp, running: { agents: 0, jobs: 0 } }, { drain: true }, AT);
    expect(placementOf(drained).status).toBe('drained');

    const back = applyMachinePatch(draining, { cordoned: false, drain: false }, AT);
    expect(placementOf(back)).toMatchObject({ status: 'online', accepting: true });
    expect(back.status).toBe('online');
    expect(isHeld(back)).toBe(false);
  });

  it('applies slot overrides and refuses bad ones', () => {
    const capped = applyMachinePatch(mbp, { maxAgents: 2 }, AT);
    expect(placementOf(capped)).toMatchObject({ configured: { agents: 2, jobs: 1 }, effective: { agents: 2, jobs: 1 } });
    expect(placementOf(capped).reasons.map((r) => r.code)).toEqual(['full']);
    expect(placementOf(applyMachinePatch(capped, { maxAgents: null }, AT)).configured.agents).toBe(4);
    expect(() => applyMachinePatch(mbp, {}, AT)).toThrow(/at least one/);
    expect(() => applyMachinePatch(mbp, { weight: 11 }, AT)).toThrow(/between 0 and 10/);
    expect(() => applyMachinePatch(mbp, { maxJobs: 1.5 }, AT)).toThrow(/whole number/);
  });

  it('blocks battery work unless the owner allows it', () => {
    const onBattery: Machine = { ...mbp, health: { ...mbp.health!, power: { source: 'battery', percent: 42 } } };
    const p = fleetPlacement(onBattery);
    expect(p.accepting).toBe(false);
    expect(p.reasons.map((r) => r.message)).toContain('On battery (42%); battery work is off');
    expect(placementOf(applyMachinePatch(onBattery, { allowOnBattery: true }, AT)).accepting).toBe(true);
  });
});

describe('older hubs', () => {
  it('derives placement from status, capacity and running counts', () => {
    const [mac] = observeMachines(NOW);
    const legacy: Machine = { ...mac, capacity: { maxAgents: 4, maxJobs: 1 }, running: { agents: 4, jobs: 0 } };
    expect(placementOf(legacy)).toMatchObject({ status: 'online', accepting: true, effective: { agents: 4, jobs: 1 }, held: { agents: 4, jobs: 0 } });
    expect(placementOf(legacy).reasons[0]).toMatchObject({ code: 'full', message: 'All 4 agent slots in use' });
    expect(placementOf({ ...legacy, status: 'offline' })).toMatchObject({ status: 'offline', accepting: false, effective: { agents: 0, jobs: 0 } });
    expect(placementOf({ ...legacy, status: 'draining' }).status).toBe('draining');
    expect(placementOf({ ...legacy, status: 'draining', running: { agents: 0, jobs: 0 } }).status).toBe('drained');
    expect(loadCell(legacy)).toMatchObject({ value: '—' });
  });
});

describe('a 50-machine fleet', () => {
  const fleet = generateFleet(50, NOW);

  it('is stable and mixes every state', () => {
    expect(fleet).toHaveLength(50);
    expect(new Set(fleet.map((m) => m.name)).size).toBe(50);
    expect(generateFleet(50, NOW).map((m) => m.name)).toEqual(fleet.map((m) => m.name));
    const statuses = new Set(fleet.map((m) => placementOf(m).status));
    for (const s of ['online', 'limited', 'overloaded', 'cordoned', 'draining', 'drained', 'offline']) expect(statuses).toContain(s);
    expect(fleet.some((m) => !m.placement && !m.health)).toBe(true);
  });

  it('filters and sorts the machines that need a look first', () => {
    const not = filterFleet(fleet, 'not-accepting');
    const yes = filterFleet(fleet, 'accepting');
    expect(not.length + yes.length).toBe(50);
    expect(not.every((m) => !placementOf(m).accepting)).toBe(true);
    const sorted = sortFleet(fleet, 'attention');
    expect(sorted.slice(0, not.length).every((m) => !placementOf(m).accepting)).toBe(true);
    expect(placementOf(sorted[0]).status).toBe('offline');
    expect(sorted.slice(0, not.length).every((m) => placementOf(m).reasons.length > 0)).toBe(true);
    const byName = sortFleet(fleet, 'name').map((m) => m.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  });
});
