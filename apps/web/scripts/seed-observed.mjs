// Seeds observe-only data into a running hub: two machines that watch their operator's own T3 Code (read-only) and
// report sessions, per-turn token usage and subscription windows, exactly as observe-only nodes do over
// POST /nodes/observations. Nothing calls a model or a real T3. Used by the web and Apple seed scripts, or alone:
//
//   node apps/web/scripts/seed-observed.mjs <hubUrl> <owner.secret> [--hold]
//
// --hold keeps both machines observing (a status batch every 20 s) until interrupted.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOUR = 3600000;

async function call(hubUrl, token, method, path, body) {
  const response = await fetch(`${hubUrl}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data?.error?.code}: ${data?.error?.message}`);
  return data;
}

const window = (id, kind, label, usedPercent, resetInMins, windowMins) => ({ id, kind, label, usedPercent, resetsAt: new Date(Date.now() + resetInMins * 60000).toISOString(), windowMins });
const claude = (session, weekly, sessionReset, weeklyReset) => ({ instanceId: 'claudeAgent', driver: 'claudeAgent', displayName: 'Claude', plan: 'Claude Max Subscription', status: 'ready',
  usage: { checkedAt: new Date().toISOString(), windows: [window('five_hour', 'session', 'Session', session, sessionReset, 300), window('seven_day', 'weekly', 'Weekly', weekly, weeklyReset, 10080)] } });
const codex = (weekly, weeklyReset) => ({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', plan: 'ChatGPT Pro Subscription', status: 'ready',
  usage: { checkedAt: new Date().toISOString(), windows: [window('primary', 'weekly', 'Weekly', weekly, weeklyReset, 10080)] } });

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const session = (threadId, title, project, provider, model, status, minutesAgo, extra = {}) => ({ threadId, title, project: { name: project, path: project.toLowerCase().replace(/\s+/g, '-') },
  provider, providerInstanceId: provider, model, status, createdAt: ago(minutesAgo + 40), lastActivityAt: ago(minutesAgo), turns: extra.turns ?? 3, ...extra });

const fleets = [
  { name: 'Justus MacBook', providers: [claude(62, 41, 95, 3 * 1440), codex(28, 4 * 1440)], sessions: [
    session('mb-hub', 'Hub: sessions summary endpoint', 'Perpeto', 'claudeAgent', 'claude-opus-5-5', 'running', 1, { branch: 'feature/sessions-summary', turns: 7 }),
    session('mb-hub-tests', 'Write hub route tests', 'Perpeto', 'claudeAgent', 'claude-sonnet-5-5', 'running', 2, { parentThreadId: 'mb-hub', turns: 4 }),
    session('mb-hub-docs', 'Update architecture contract', 'Perpeto', 'claudeAgent', 'claude-sonnet-5-5', 'idle', 9, { parentThreadId: 'mb-hub', turns: 2 }),
    session('mb-web', 'Sessions screen layout', 'Perpeto', 'codex', 'gpt-6.1-sol', 'waiting', 4, { branch: 'feature/sessions-screen', turns: 5 }),
    session('mb-site', 'Landing page copy pass', 'Lumin Site', 'claudeAgent', 'claude-opus-5-5', 'idle', 55, { turns: 3 }),
    session('mb-bug', 'Fix flaky upload retry', 'Lumin App', 'codex', 'gpt-6.1-sol', 'error', 130, { branch: 'fix/upload-retry', turns: 2 }),
  ] },
  { name: 'Mac mini', providers: [claude(18, 33, 240, 3 * 1440)], sessions: [
    session('mm-sync', 'Nightly data sync job', 'Lumin App', 'claudeAgent', 'claude-sonnet-5-5', 'running', 0, { branch: 'chore/nightly-sync', turns: 11 }),
    session('mm-review', 'Review dependency upgrades', 'Lumin App', 'claudeAgent', 'claude-haiku-5-5', 'idle', 22, { turns: 1 }),
    session('mm-notes', 'Summarise meeting notes', 'Personal', 'claudeAgent', 'claude-sonnet-5-5', 'idle', 300, { turns: 2 }),
  ] },
];

/** Hourly usage for each session over the last day, tapering with age; one provider turn per record. */
function usageFor(fleet) {
  const records = [];
  for (const item of fleet.sessions) {
    const span = Math.min(24, item.turns * 2);
    for (let hour = 0; hour < span; hour++) {
      const weight = item.status === 'running' ? 1.6 : item.status === 'error' ? 0.4 : 1;
      const at = new Date(Date.now() - hour * HOUR - 5 * 60000).toISOString();
      records.push({ providerTurnId: `${item.threadId}:turn:${hour}`, threadId: item.threadId, providerInstanceId: item.providerInstanceId, provider: item.provider, model: item.model,
        inputTokens: Math.round((900 + 400 * Math.sin(hour)) * weight), outputTokens: Math.round((4200 + 1800 * Math.cos(hour / 2)) * weight),
        cacheReadTokens: Math.round(160000 * weight), cacheWriteTokens: Math.round(9000 * weight), reasoningTokens: Math.round(800 * weight), at });
    }
  }
  return records;
}

/** Enroll the observing machines and post their observations. Returns `ping()` to keep them observing. */
export async function seedObserved({ hubUrl, owner }) {
  const machines = [];
  for (const fleet of fleets) {
    const { code } = await call(hubUrl, owner, 'POST', '/machines/enrollment-codes', {});
    const enrolled = await call(hubUrl, '', 'POST', '/nodes/enroll', { code, name: fleet.name, os: 'darwin', arch: 'arm64', version: '0.1.0', labels: ['observe'], providers: [] });
    const api = (method, path, body) => call(hubUrl, enrolled.token, method, path, body);
    const heartbeat = () => api('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: [], labels: ['observe'] });
    const observe = body => api('POST', '/nodes/observations', { batchId: crypto.randomUUID(), source: { connected: true, serverVersion: '0.1.1-nightly' }, sessions: [], ...body });
    await heartbeat();
    const usage = usageFor(fleet);
    await observe({ resync: { id: crypto.randomUUID(), final: true }, sessions: fleet.sessions, providers: fleet.providers, usage: usage.slice(0, 1000) });
    for (let start = 1000; start < usage.length; start += 1000) await observe({ usage: usage.slice(start, start + 1000) });
    machines.push({ ...fleet, id: enrolled.machineId, heartbeat, observe });
  }
  const summary = await call(hubUrl, owner, 'GET', '/sessions/summary?window=24h');
  console.log(`observed: ${summary.machines.filter(machine => machine.observing).map(machine => `${machine.name} ${machine.running} running/${machine.waiting} waiting`).join(', ')}; `
    + `${summary.totals.sessionsActive} sessions active, ${summary.tokens.byProvider.map(item => `${item.provider} ${item.input + item.output} tokens`).join(', ')}`);
  return { machines, async ping() { for (const machine of machines) { await machine.heartbeat().catch(() => undefined); await machine.observe({}).catch(() => undefined); } } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [hubUrl, secretPath, ...flags] = process.argv.slice(2);
  if (!hubUrl || !secretPath) { console.error('Usage: node apps/web/scripts/seed-observed.mjs <hubUrl> <owner.secret> [--hold]'); process.exit(2); }
  const seeded = await seedObserved({ hubUrl, owner: (await readFile(secretPath, 'utf8')).trim() });
  if (flags.includes('--hold')) { console.log('observing; Ctrl-C to stop'); for (;;) { await sleep(20000); await seeded.ping(); } }
}
