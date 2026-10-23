import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeMergeQueueConfig } from '@perpeto/delivery';
import { owner, request } from './api.js';

const minutes = ms => ms === null || ms === undefined ? 'n/a' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
const percent = value => value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;

/** Lines describing one queue's live state, shortest first: name, counts, freeze, metrics, then each open entry. */
export function describeQueue(view) {
  const lines = [];
  const counts = ['queued', 'testing', 'merging'].map(status => `${view.entries.filter(entry => entry.status === status).length} ${status}`).join(', ');
  lines.push(`${view.name} [${view.id}] ${view.strategy}, ${view.branches.join(' ')}: ${counts}${view.frozen ? `. FROZEN: ${view.frozen.reason}` : ''}`);
  const m = view.metrics;
  lines.push(`  ${m.throughputPerHour}/h merged, median ${minutes(m.medianTimeInQueueMs)} in queue, failure ${percent(m.failureRate)}${m.failuresByReason.length ? ` (${m.failuresByReason.map(item => `${item.cause} ${item.count}`).join(', ')})` : ''}, batches ${percent(m.batches.successRate)}`);
  for (const entry of view.entries) {
    const eta = entry.etaAt ? `, eta ${entry.etaAt.slice(11, 16)}Z` : '';
    lines.push(`  ${String(entry.position).padStart(2)}. ${entry.prUrl} ${entry.status}${entry.lane ? ` [${entry.lane}]` : ''}${eta}${entry.reason ? `: ${entry.reason}` : ''}`);
  }
  return lines;
}

/** perpeto queue [project]: every queue of a project, or of all projects. */
export async function listQueues(dir, projectId, { print, fetchImpl }) {
  const { url, token, pins } = await owner(dir);
  const get = path => request(url, path, { token, pins, fetchImpl });
  const projects = projectId ? [await get(`/projects/${encodeURIComponent(projectId)}`)] : (await get('/projects')).projects;
  for (const project of projects) {
    const list = await get(`/projects/${encodeURIComponent(project.id)}/merge-queues`);
    print(`${project.name} (settings v${list.version}${list.repo.applied ? `, ${list.repo.path} applied` : list.repo.found ? `, ${list.repo.path} NOT applied` : ''})`);
    if (!list.queues.length) print('  No merge queues yet.');
    for (const queue of list.queues) for (const line of describeQueue(await get(`/merge-queues/${encodeURIComponent(queue.id)}`))) print(`  ${line}`);
  }
}

export async function freezeQueue(dir, queueId, frozen, reason, { print, fetchImpl }) {
  const { url, token, pins } = await owner(dir);
  const view = await request(url, `/merge-queues/${encodeURIComponent(queueId)}/${frozen ? 'freeze' : 'unfreeze'}`, { token, pins, fetchImpl,
    body: { ...(reason ? { reason } : {}), idempotencyKey: randomUUID() } });
  print(frozen ? `Frozen ${view.name}: ${view.frozen?.reason ?? 'frozen'}. Tested changes wait; nothing publishes until unfrozen.` : `Unfrozen ${view.name}.`);
}

/** perpeto queue config validate <file>: the same validation the hub runs, with JSON paths. Exit 1 when invalid. */
export async function validateConfig(file, { print }) {
  let input;
  try { input = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { print(error.code === 'ENOENT' ? `No such file: ${file}` : `Not valid JSON: ${file}`); return 1; }
  const result = normalizeMergeQueueConfig(input);
  if (!result.ok) {
    for (const error of result.errors) print(`${error.path} ${error.message}`);
    print(`${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}.`);
    return 1;
  }
  print(`Valid: ${result.config.queues.length} queue${result.config.queues.length === 1 ? '' : 's'}${result.config.queues.length ? ` (${result.config.queues.map(queue => `${queue.name}: ${queue.strategy} on ${queue.branches.join(', ')}`).join('; ')})` : ''}.`);
  return 0;
}
