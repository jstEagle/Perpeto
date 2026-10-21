import { describe, expect, it } from 'vitest';
import { decodeGoals, encodeGoals } from './goals';

describe('goals', () => {
  it('reads goal objects with progress and legacy strings', () => {
    const goals = decodeGoals([{ id: 'goal_a', title: 'Ship the hub', status: 'active', workItemIds: ['wi_1', 'wi_2'], done: 1, total: 2 }, 'Old string goal', { title: 'Done one', status: 'done' }, 42]);
    expect(goals.map((g) => [g.title, g.status, g.done, g.total])).toEqual([
      ['Ship the hub', 'active', 1, 2],
      ['Old string goal', 'active', 0, 0],
      ['Done one', 'done', 0, 0],
    ]);
    expect(goals[1].legacy).toBe(true);
    expect(decodeGoals(undefined)).toEqual([]);
  });

  it('keeps ids and status of goals that are still listed and adds new ones as strings', () => {
    const existing = decodeGoals([
      { id: 'goal_a', title: 'Ship the hub', status: 'done', workItemIds: [], done: 2, total: 2 },
      { id: 'goal_b', title: 'Scale out', status: 'active', workItemIds: [], done: 0, total: 0 },
    ]);
    expect(encodeGoals(['Ship the hub', 'Write the docs'], existing)).toEqual([{ id: 'goal_a', title: 'Ship the hub', status: 'done' }, 'Write the docs']);
    // A project whose goals came as strings is saved as strings, which every hub accepts.
    expect(encodeGoals(['Old string goal', 'New'], decodeGoals(['Old string goal']))).toEqual(['Old string goal', 'New']);
  });
});
