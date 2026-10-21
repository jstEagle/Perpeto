import { createHash, randomBytes } from 'node:crypto';
import { fail, nonblank, requireValue } from './errors.js';

export const GOAL_STATUSES = ['active', 'done', 'dropped'];
/** A string goal's id derives from its title, so goals stored as strings keep stable ids when read or edited. */
const derivedId = title => `goal_${createHash('sha256').update(title).digest('hex').slice(0, 12)}`;

/** Goals as objects `{id, title, status}`. Older projects stored plain strings; those read as active goals. */
export function readGoals(goals = []) {
  const seen = new Set();
  return goals.map(goal => {
    const value = typeof goal === 'string' ? { id: derivedId(goal), title: goal, status: 'active' } : { id: goal.id, title: goal.title, status: goal.status ?? 'active' };
    for (let index = 2; seen.has(value.id); index++) value.id = `${derivedId(value.title)}_${index}`;
    seen.add(value.id);
    return value;
  });
}

/** Validate and normalize goals from a request: strings or `{id?, title, status?}`; new goals get a random id. */
export function writeGoals(input) {
  requireValue(Array.isArray(input) && input.length <= 100, 'goals must be an array of at most 100 goals.');
  const goals = input.map(goal => {
    if (typeof goal === 'string') return { id: derivedId(nonblank(goal, 'goal', 500)), title: goal, status: 'active' };
    requireValue(goal && typeof goal === 'object' && !Array.isArray(goal) && Object.keys(goal).every(key => ['id', 'title', 'status'].includes(key)), 'A goal is a string or {id?, title, status?}.');
    nonblank(goal.title, 'goal title', 500);
    if (goal.id !== undefined) requireValue(typeof goal.id === 'string' && /^goal_[A-Za-z0-9_-]{1,64}$/.test(goal.id), 'Invalid goal id.');
    if (goal.status !== undefined) requireValue(GOAL_STATUSES.includes(goal.status), 'Goal status must be active, done or dropped.');
    return { id: goal.id ?? `goal_${randomBytes(6).toString('hex')}`, title: goal.title, status: goal.status ?? 'active' };
  });
  if (new Set(goals.map(goal => goal.id)).size !== goals.length) fail(400, 'INVALID_INPUT', 'Goal ids must be unique.');
  return goals;
}

/** Owner initials: first letters of the first and last words. */
export const initialsOf = name => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length ? [words[0], ...(words.length > 1 ? [words.at(-1)] : [])].map(word => [...word][0]).join('').toUpperCase() : null;
};
