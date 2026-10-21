import { readFileSync } from 'node:fs';
import { fail } from './util.js';

const descriptions = Object.freeze({
  build: 'Plan and build features with bounded review, CI and a serial merge queue.',
  improve: 'Continuously propose measurable improvements against unfinished goals, metrics and prior outcomes.',
  bugfix: 'Triage a bug, reproduce it in a failing test, fix it, review, run CI and merge.',
  docs: 'Write and verify documentation, review accuracy and links, then merge.',
  'security-audit': 'Audit for vulnerabilities, verify findings, fix confirmed issues, review, run CI and merge.',
  'dependency-upgrade': 'Plan scoped dependency upgrades, apply migrations, review compatibility, run CI and merge.',
});

/** Stable metadata for clients and the architect. Each read returns an independent value. */
export function listTemplates() {
  return Object.entries(descriptions).map(([id, description]) => ({ id, description }));
}

/** Editable graph with no shared mutable template state. */
export function getTemplate(id) {
  if (!Object.hasOwn(descriptions, id)) fail('UNKNOWN_TEMPLATE', `Unknown workflow template ${String(id)}.`);
  return JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url), 'utf8'));
}
