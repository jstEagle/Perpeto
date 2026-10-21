import { randomUUID } from 'node:crypto';
import { requireValue, sha, stableHash, string } from './common.js';

/** @typedef {{name: string, run: string, timeoutSec?: number}} JobStep */
/** @typedef {{os?: 'darwin'|'linux'|'windows', labels?: string[], providers?: string[]}} MachineRequirements */
/** @typedef {{steps: JobStep[], requirements?: MachineRequirements}} CIConfig */

/** Copy and validate the ci node's public configuration. */
export function normalizeCI(config) {
  requireValue(config && Array.isArray(config.steps) && config.steps.length > 0, 'CI requires at least one step.');
  const names = new Set();
  const steps = config.steps.map(step => {
    requireValue(step && typeof step === 'object', 'Each CI step must be an object.');
    requireValue(Object.keys(step).every(key => ['name', 'run', 'timeoutSec'].includes(key)), 'Unknown CI step field.');
    string(step.name, 'step name'); string(step.run, 'step command');
    requireValue(!names.has(step.name), 'CI step names must be unique.');
    names.add(step.name);
    if (step.timeoutSec !== undefined) requireValue(Number.isSafeInteger(step.timeoutSec) && step.timeoutSec > 0, 'timeoutSec must be a positive integer.');
    return { name: step.name, run: step.run, ...(step.timeoutSec === undefined ? {} : { timeoutSec: step.timeoutSec }) };
  });
  const requirements = structuredClone(config.requirements ?? {});
  requireValue(Object.keys(requirements).every(key => ['os', 'labels', 'providers'].includes(key)), 'Unknown machine requirement.');
  if (requirements.os !== undefined) requireValue(['darwin', 'linux', 'windows'].includes(requirements.os), 'Unknown operating system.');
  for (const field of ['labels', 'providers']) {
    if (requirements[field] !== undefined) {
      requireValue(Array.isArray(requirements[field]), `${field} must be an array.`);
      requirements[field].forEach(value => string(value, field));
      requirements[field] = [...new Set(requirements[field])].sort();
    }
  }
  return { steps, requirements };
}

/** Build the architecture Job from a ci config and work item. No execution or secrets. */
/** @returns {import('./types.js').Job} */
export function buildJob({ config, workItem, projectId, repo, id = `job_${randomUUID()}` }) {
  const normalized = normalizeCI(config);
  string(id, 'job id'); string(projectId, 'projectId');
  requireValue(repo && typeof repo === 'object' && typeof repo.url === 'string', 'repo.url is required.');
  string(repo.url, 'repo.url');
  sha(workItem?.headSha);
  if (workItem.id !== undefined) string(workItem.id, 'workItem.id');
  if (workItem.runId !== undefined) string(workItem.runId, 'workItem.runId');
  return {
    id, projectId, ...(workItem.runId ? { runId: workItem.runId } : {}),
    ...(workItem.id ? { workItemId: workItem.id } : {}), repo: structuredClone(repo),
    revision: workItem.headSha, ...normalized, status: 'queued', attempt: 0, artifacts: [],
    configHash: stableHash(normalized),
  };
}

/** Current means identity only. A current failure is still a failure. */
export function isEvidenceCurrent(entry, job) {
  return Boolean(entry && job && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.revision) &&
    /^[a-f0-9]{64}$/.test(job.configHash) && entry.revision === job.revision && entry.configHash === job.configHash);
}

/** A whole-job pass proves its named steps. Extra checks must carry their own exact identity. */
export function checksPass(job, requiredChecks = []) {
  if (!job || job.status !== 'passed') return false;
  return requiredChecks.every(name => {
    const checks = job.checks?.filter(check => check.name === name) ?? [];
    if (checks.length) return checks.every(check => check.status === 'passed' && isEvidenceCurrent(check, job));
    return job.steps.some(step => step.name === name);
  });
}
