import type { Goal, GoalInput, Project } from './types';

type RawGoal = string | (Partial<Goal> & { title?: string });

/** Goals from any hub: objects with progress, or plain strings from older hubs. */
export function decodeGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawGoal[]).flatMap((g, i): Goal[] => {
    if (typeof g === 'string') return [{ id: `legacy-${i}`, title: g, status: 'active', workItemIds: [], done: 0, total: 0, legacy: true }];
    if (!g || typeof g.title !== 'string') return [];
    const status = g.status === 'done' || g.status === 'dropped' ? g.status : 'active';
    return [
      {
        id: typeof g.id === 'string' ? g.id : `goal-${i}`,
        title: g.title,
        status,
        workItemIds: Array.isArray(g.workItemIds) ? g.workItemIds : [],
        done: typeof g.done === 'number' ? g.done : 0,
        total: typeof g.total === 'number' ? g.total : 0,
      },
    ];
  });
}

export function decodeProject<T extends { goals?: unknown }>(project: T): T & Pick<Project, 'goals'> {
  return { ...project, goals: decodeGoals(project.goals) };
}

/**
 * Edited goal titles, one per line, as the hub accepts them. A line that
 * matches an existing goal keeps its id and status, so progress links stay;
 * a new line is sent as a string and the hub gives it an id. Projects whose
 * goals arrived as strings are saved as strings.
 */
export function encodeGoals(lines: string[], existing: Goal[]): GoalInput[] {
  const legacy = existing.some((g) => g.legacy);
  return lines.map((title) => {
    const match = existing.find((g) => g.title === title);
    return match && !legacy ? { id: match.id, title, status: match.status } : title;
  });
}
