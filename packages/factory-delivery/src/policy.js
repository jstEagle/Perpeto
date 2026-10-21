import { createHash } from 'node:crypto';
import { requireValue, string } from './common.js';

const slug = text => text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const line = value => String(value).replace(/[\r\n]+/g, ' ').trim();

/** Stable, git-safe names; the digest prevents collisions after sanitization/truncation. */
export function branchName({ workItem, runId = workItem.runId }) {
  string(workItem.id, 'work item id'); string(runId, 'run id'); string(workItem.title, 'title');
  const digest = createHash('sha256').update(JSON.stringify([runId, workItem.id])).digest('hex').slice(0, 12);
  return `perpeto/${slug(runId).slice(0, 32) || 'run'}/${slug(workItem.title).slice(0, 60) || 'work'}-${digest}`;
}

function link(url) {
  const parsed = new URL(url);
  requireValue(['https:', 'http:', 't3-thread:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'Links must use HTTP(S) or t3-thread without credentials.');
  return parsed.href.replaceAll('(', '%28').replaceAll(')', '%29');
}

/** Render a human-reviewable PR. Evidence is linked, never described as passing by default. */
export function pullRequestPolicy({ workItem, run, evidence = [] }) {
  string(workItem.id, 'work item id'); string(workItem.title, 'title'); string(run.id, 'run id');
  const reference = (label, item) => item.url ? `[${line(label)}](${link(item.url)})` : line(label);
  return {
    branch: branchName({ workItem, runId: run.id }),
    title: `${line(workItem.title)} (${line(workItem.id)})`,
    body: [
      `Work item: ${reference(workItem.id, workItem)}`,
      `Run: ${reference(run.id, run)}`, '', workItem.body ?? '', '', 'Evidence', '',
      ...(evidence.length ? evidence.map(item => `- ${reference(item.label ?? item.id ?? 'Evidence', item)}`) : ['No verification evidence supplied.']),
    ].join('\n'),
  };
}
