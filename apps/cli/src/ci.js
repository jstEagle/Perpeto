import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { PIPELINE_FILE, parsePipelineConfig, expandPipeline } from '@perpeto/delivery';
import { owner, request } from './api.js';

const exec = promisify(execFile);
const ACTIVE = new Set(['queued', 'running']);
const ACTIVE_JOB = new Set(['queued', 'leased', 'running']);
const duration = ms => !Number.isFinite(ms) ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;

/** The project a CI command targets: --project by id or name, else the only project on the hub. */
async function project(hub, wanted) {
  const { projects } = await request(hub.url, '/projects', hub);
  const match = wanted ? projects.filter(item => item.id === wanted || item.name === wanted) : projects;
  if (match.length === 1) return match[0];
  throw new Error(wanted ? `No single project matches "${wanted}".` : 'Several projects exist; choose one with --project <id or name>.');
}

/** A full commit SHA for --rev: given as one, or resolved by Git in the current directory. */
async function revision(value, cwd) {
  if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try { return (await exec('git', ['rev-parse', '--verify', '--quiet', `${value}^{commit}`], { cwd })).stdout.trim(); }
  catch { throw new Error(`Git cannot resolve "${value}" here; pass a full commit SHA with --rev.`); }
}

/** `perpeto ci validate|run|status|logs`. Output goes through `print`; returns the exit code. */
export async function ci(action, dir, positionals, flags, { print = console.log, cwd = process.cwd(), fetchImpl = fetch, pollMs = 1000 } = {}) {
  if (action === 'validate') {
    // Local and offline: the same validation the hub applies to .perpeto/ci.json.
    const file = resolve(cwd, flags.file ?? PIPELINE_FILE);
    let text;
    try { text = await readFile(file, 'utf8'); } catch { print(`Cannot read ${file}.`); return 1; }
    const { config, errors } = parsePipelineConfig(text);
    if (errors.length) { for (const error of errors) print(`${error.path}: ${error.message}`); print(`${errors.length} problem${errors.length === 1 ? '' : 's'} in ${file}.`); return 1; }
    for (const name of Object.keys(config.pipelines)) {
      const { jobs, triggers } = expandPipeline(config, name);
      print(`${name}: ${jobs.length} job${jobs.length === 1 ? '' : 's'} (${jobs.map(job => job.key).join(', ')}); triggers ${triggers.map(item => item.on).join(', ')}`);
    }
    print(`${file} is valid.`);
    return 0;
  }
  const hub = { ...(await owner(dir)), fetchImpl };
  if (action === 'run') {
    const target = await project(hub, flags.project);
    const body = { projectId: target.id, pipeline: positionals[0], idempotencyKey: randomUUID(), ...(flags.ref ? { ref: flags.ref } : {}),
      ...(flags.rev ? { revision: await revision(flags.rev, cwd) } : {}) };
    const run = await request(hub.url, '/pipeline-runs', { ...hub, body });
    print(`Started ${run.id}: ${run.pipeline} at ${run.revision.slice(0, 12)}, ${run.jobs.length} jobs.`);
    return 0;
  }
  if (action === 'status') {
    const target = flags.project ? await project(hub, flags.project) : null;
    const { runs } = await request(hub.url, `/pipeline-runs?limit=20${target ? `&projectId=${encodeURIComponent(target.id)}` : ''}`, hub);
    if (!runs.length) { print('No pipeline runs yet.'); return 0; }
    for (const run of runs) {
      print(`${run.id}  ${run.status.padEnd(9)} ${run.pipeline}  ${run.revision.slice(0, 12)}  ${run.trigger.kind}  ${duration(run.durationMs)}`.trimEnd());
      if (ACTIVE.has(run.status) || run.status === 'failed') {
        for (const job of run.jobs.filter(item => item.status !== 'passed')) print(`    ${job.status.padEnd(9)} ${job.key}${job.jobId ? `  ${job.jobId}` : ''}`);
      }
    }
    return 0;
  }
  if (action === 'logs') {
    const jobId = positionals[0];
    let cursor = 0;
    for (;;) {
      const page = await request(hub.url, `/jobs/${encodeURIComponent(jobId)}/log?after=${cursor}&limit=500`, hub);
      for (const chunk of page.chunks) print(chunk.chunk.replace(/\n$/, ''));
      cursor = page.nextCursor;
      if (page.hasMore) continue;
      if (!flags.follow) { if (page.truncated) print('[log truncated by the hub]'); return 0; }
      const job = await request(hub.url, `/jobs/${encodeURIComponent(jobId)}`, hub);
      if (!ACTIVE_JOB.has(job.status)) { print(`[job ${job.status}]`); return job.status === 'passed' ? 0 : 1; }
      await sleep(pollMs);
    }
  }
  throw new Error('Use perpeto ci run, status, logs or validate.');
}
