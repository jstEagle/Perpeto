import type {
  Account,
  Assignment,
  AssignmentStatus,
  Channel,
  HubEvent,
  Job,
  Machine,
  MergeEntry,
  Message,
  MetricsSnapshot,
  NodeMetrics,
  Project,
  Run,
  UsageRecord,
  WorkItem,
  WorkItemStatus,
  Workflow,
  WorkflowGraph,
} from './types';
import { COL, ROW, buildTemplate, improveTemplate } from '../workflow/templates';

/**
 * Demo factory used when no hub is configured. The story: the Perpeto build
 * run's single reviewer is saturated, rework through the review loop is
 * rising, and two machines share the agents. Numbers are internally
 * consistent so the run map, panels and tables agree.
 */

export interface DemoState {
  projects: Project[];
  /** All versions of every workflow, oldest first. */
  versions: Workflow[];
  runs: Run[];
  workItems: WorkItem[];
  assignments: Assignment[];
  machines: Machine[];
  accounts: Account[];
  jobs: Job[];
  jobLogs: Record<string, string>;
  mergeQueue: MergeEntry[];
  usage: UsageRecord[];
  events: HubEvent[];
  channels: Record<string, Channel[]>;
  messages: Message[];
  metrics: Record<string, MetricsSnapshot>;
  seq: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function iso(t: number) {
  return new Date(t).toISOString();
}

/** Small deterministic PRNG so screenshots are stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha(r: () => number) {
  let out = '';
  for (let i = 0; i < 40; i++) out += Math.floor(r() * 16).toString(16);
  return out;
}

export const DEMO_IDS = {
  perpeto: 'prj_perpeto',
  cooler: 'prj_cooler',
  notes: 'prj_fieldnotes',
  build: 'wf_k3build',
  improve: 'wf_m8improve',
  coolerBuild: 'wf_c2build',
  run: 'run_7q4m2x',
  runOld: 'run_5d1h8a',
  coolerRun: 'run_2v9k6p',
  studio: 'mch_studio',
  linux: 'mch_linux',
} as const;

function perpetoBuildV3(): WorkflowGraph {
  const g = buildTemplate();
  const builder = g.nodes.find((n) => n.id === 'builder')!;
  builder.config = { ...builder.config, concurrency: 6 };
  return g;
}

/** The draft an agent proposed after review became the bottleneck. */
function perpetoBuildV4(): WorkflowGraph {
  const g = perpetoBuildV3();
  for (const n of g.nodes) if (n.position.y === ROW) n.position = { ...n.position, x: n.position.x + COL };
  g.nodes.push({
    id: 'checks',
    type: 'ci',
    label: 'Fast checks',
    position: { x: 0, y: ROW },
    config: { steps: [{ name: 'Typecheck', run: 'npm run typecheck' }, { name: 'Lint', run: 'npm run lint' }], requirements: {} },
  });
  const reviewer = g.nodes.find((n) => n.id === 'reviewer')!;
  reviewer.config = { ...reviewer.config, concurrency: 3 };
  g.edges = g.edges.filter((e) => e.id !== 'e-builder-out-reviewer');
  g.edges.push(
    { id: 'e-builder-out-checks', from: { node: 'builder' }, to: { node: 'checks' }, kind: 'flow' },
    { id: 'e-checks-pass-reviewer', from: { node: 'checks', port: 'pass' }, to: { node: 'reviewer' }, kind: 'flow' },
    { id: 'e-checks-fail-loop', from: { node: 'checks', port: 'fail' }, to: { node: 'loop' }, kind: 'flow' },
  );
  return g;
}

export function createDemoState(now = Date.now()): DemoState {
  const r = rng(20261021);
  const ago = (ms: number) => iso(now - ms);

  const projects: Project[] = [
    {
      id: DEMO_IDS.perpeto,
      name: 'perpeto',
      repo: { url: 'https://github.com/lumin-products/perpeto', defaultBranch: 'main' },
      docs: [
        { id: 'doc_vision', title: 'Vision', path: 'docs/product/vision.md', kind: 'vision' },
        { id: 'doc_arch', title: 'Architecture contract', path: 'docs/architecture/README.md', kind: 'spec' },
        { id: 'doc_brand', title: 'Brand direction', path: 'brand/README.md', kind: 'requirements' },
        { id: 'doc_dod', title: 'Definition of done', path: 'docs/product/definition-of-done.md', kind: 'requirements' },
      ],
      goals: ['Ship Hub API v1 with leases and an event log', 'Run 100 concurrent agents across 5 machines', 'Web and native clients follow the Workshop system'],
      createdAt: ago(12 * DAY),
      updatedAt: ago(2 * HOUR),
    },
    {
      id: DEMO_IDS.cooler,
      name: 'cooler',
      repo: { url: 'https://github.com/lumin-products/cooler', defaultBranch: 'main' },
      docs: [{ id: 'doc_cooler_req', title: 'Messaging requirements', path: 'docs/requirements.md', kind: 'requirements' }],
      goals: ['Durable channels with cursor reads', 'Review requests route to the right role'],
      createdAt: ago(30 * DAY),
      updatedAt: ago(26 * HOUR),
    },
    {
      id: DEMO_IDS.notes,
      name: 'field-notes',
      repo: { url: 'https://github.com/lumin-products/field-notes', defaultBranch: 'main' },
      docs: [],
      goals: [],
      createdAt: ago(1 * DAY),
      updatedAt: ago(1 * DAY),
    },
  ];

  const buildV1 = buildTemplate();
  const versions: Workflow[] = [
    {
      id: DEMO_IDS.build,
      projectId: DEMO_IDS.perpeto,
      name: 'Build',
      purpose: 'build',
      version: 1,
      graph: buildV1,
      status: 'paused',
      authoredBy: { kind: 'agent', assignmentId: 'asg_arch01', prompt: 'Build features from the architecture contract. Every change gets an agent review and CI on my Mac before it merges.' },
      rationale:
        'A planner splits the contract into work items. Four builders work in parallel on Claude. A Codex reviewer gives an independent second opinion, and failed reviews or CI return through a loop capped at 3 iterations. CI runs on darwin because that is the only machine with the iOS toolchain.',
      createdAt: ago(9 * DAY),
    },
    {
      id: DEMO_IDS.build,
      projectId: DEMO_IDS.perpeto,
      name: 'Build',
      purpose: 'build',
      version: 2,
      parentVersion: 1,
      graph: (() => {
        const g = buildTemplate();
        g.nodes.find((n) => n.id === 'ci')!.config = { steps: [{ name: 'Install', run: 'npm ci' }, { name: 'Test', run: 'npm test' }, { name: 'Build', run: 'npm run build' }], requirements: {} };
        return g;
      })(),
      status: 'paused',
      authoredBy: { kind: 'user' },
      rationale: 'Let CI run on any machine.',
      createdAt: ago(6 * DAY),
    },
    {
      id: DEMO_IDS.build,
      projectId: DEMO_IDS.perpeto,
      name: 'Build',
      purpose: 'build',
      version: 3,
      parentVersion: 2,
      graph: perpetoBuildV3(),
      status: 'active',
      authoredBy: { kind: 'agent', assignmentId: 'asg_arch02', prompt: 'Builders are idle while work waits. Use more of the Linux box.' },
      rationale:
        'Builder concurrency rises from 4 to 6. build-linux has 8 agent slots and was running 2. Review stays at 1 so review quality is unchanged; watch the reviewer queue.',
      createdAt: ago(3 * DAY + 2 * HOUR),
    },
    {
      id: DEMO_IDS.build,
      projectId: DEMO_IDS.perpeto,
      name: 'Build',
      purpose: 'build',
      version: 4,
      parentVersion: 3,
      graph: perpetoBuildV4(),
      status: 'draft',
      authoredBy: {
        kind: 'agent',
        assignmentId: 'asg_arch03',
        prompt: 'Review is the bottleneck. Propose a change that clears the queue without lowering review quality.',
      },
      rationale:
        'The reviewer is at 100% utilization with 7 items waiting and a p90 wait of 48 min. 5 of the last 12 reviews returned work, 4 of them for type or lint errors a machine can catch. This draft adds a Fast checks gate before review so those return in about 2 min instead of after a 31 min wait, and raises reviewer concurrency from 1 to 3. Expected: reviewer utilization near 0.6 and fewer review loop iterations. The run keeps using version 3 until you activate this.',
      createdAt: ago(40 * MIN),
    },
    {
      id: DEMO_IDS.improve,
      projectId: DEMO_IDS.perpeto,
      name: 'Improve',
      purpose: 'improve',
      version: 1,
      graph: improveTemplate(),
      status: 'active',
      authoredBy: { kind: 'agent', assignmentId: 'asg_arch04', prompt: 'Weekly, audit against the goals and make small, safe improvements.' },
      rationale: 'An auditor proposes at most 6 small items per pass. Improvers cannot spawn subagents, which keeps cost predictable. CI must pass before review results count.',
      createdAt: ago(8 * DAY),
    },
    {
      id: DEMO_IDS.coolerBuild,
      projectId: DEMO_IDS.cooler,
      name: 'Build',
      purpose: 'build',
      version: 1,
      graph: buildTemplate(),
      status: 'active',
      authoredBy: { kind: 'agent', assignmentId: 'asg_arch05', prompt: 'Build the messaging requirements with review and CI.' },
      rationale: 'Default build shape. The project is small, so builder concurrency stays at 4.',
      createdAt: ago(20 * DAY),
    },
  ];

  const runs: Run[] = [
    { id: DEMO_IDS.run, projectId: DEMO_IDS.perpeto, workflowId: DEMO_IDS.build, workflowVersion: 3, status: 'running', startedAt: ago(3 * DAY) },
    { id: DEMO_IDS.runOld, projectId: DEMO_IDS.perpeto, workflowId: DEMO_IDS.build, workflowVersion: 2, status: 'stopped', startedAt: ago(6 * DAY), stoppedAt: ago(3 * DAY + 3 * HOUR) },
    { id: 'run_3c8w1n', projectId: DEMO_IDS.perpeto, workflowId: DEMO_IDS.improve, workflowVersion: 1, status: 'completed', startedAt: ago(7 * DAY), stoppedAt: ago(6 * DAY + 5 * HOUR) },
    { id: DEMO_IDS.coolerRun, projectId: DEMO_IDS.cooler, workflowId: DEMO_IDS.coolerBuild, workflowVersion: 1, status: 'paused', startedAt: ago(2 * DAY) },
  ];

  // Work items for the live run.
  type Seed = [title: string, nodeId: string, status: WorkItemStatus, iteration: number];
  const seeds: Seed[] = [
    ['Hub: idempotent project writes', 'done', 'done', 1],
    ['Hub: lease expiry returns work to the queue', 'done', 'done', 2],
    ['Node: heartbeat every 10 s', 'done', 'done', 1],
    ['Web: projects list', 'done', 'done', 1],
    ['Workflow: loop iteration limits', 'done', 'done', 2],
    ['CLI: perpeto status', 'done', 'done', 1],
    ['Accounts: cooldown on rate limit', 'done', 'done', 1],
    ['Delivery: revision-bound CI evidence', 'done', 'done', 2],
    ['Hub: event log pagination', 'done', 'done', 1],
    ['Web: settings screen', 'done', 'done', 1],
    ['Node: enrollment code exchange', 'done', 'done', 1],
    ['Workflow: template loader', 'done', 'done', 1],
    ['Messaging: run channels', 'done', 'done', 3],
    ['Usage ledger: group by day', 'done', 'done', 1],
    ['Hub: metrics endpoint', 'reviewer', 'active', 2],
    ['Hub: SSE event stream', 'reviewer', 'queued', 1],
    ['Node: job runner worktrees', 'reviewer', 'queued', 2],
    ['Web: workflow inspector', 'reviewer', 'queued', 1],
    ['Accounts: invalid credential detection', 'reviewer', 'queued', 1],
    ['Delivery: merge queue batching', 'reviewer', 'queued', 3],
    ['Hub: usage by machine', 'reviewer', 'queued', 1],
    ['Workflow: delegates edge policy', 'reviewer', 'queued', 2],
    ['Node: drain mode', 'builder', 'active', 1],
    ['Web: live run map', 'builder', 'active', 1],
    ['T3 executor: subagent limits', 'builder', 'active', 2],
    ['Hub: bottleneck detection', 'builder', 'active', 1],
    ['CLI: install script', 'builder', 'queued', 1],
    ['Docs: machine setup guide', 'builder', 'queued', 1],
    ['Workflow: version history', 'ci', 'active', 1],
    ['Hub: workflow activation', 'merge', 'queued', 1],
    ['Accounts: provider terms check', 'loop', 'failed', 3],
  ];
  const workItems: WorkItem[] = seeds.map(([title, nodeId, status, iteration], i) => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36);
    const hasPr = ['reviewer', 'ci', 'merge', 'done'].includes(nodeId) || status === 'failed';
    const n = 212 + i;
    return {
      id: `wi_${(1000 + i * 37).toString(36)}${i}`,
      runId: DEMO_IDS.run,
      title,
      body: `Acceptance criteria from docs/architecture/README.md for "${title}".`,
      nodeId,
      status,
      iteration,
      branch: nodeId === 'builder' && status === 'queued' ? undefined : `factory/${slug}`,
      prUrl: hasPr ? `https://github.com/lumin-products/perpeto/pull/${n}` : undefined,
      headSha: hasPr ? sha(r) : undefined,
    };
  });

  const wiAt = (title: string) => workItems.find((w) => w.title === title)!;

  // Assignments for the live run.
  const assignments: Assignment[] = [];
  let asgN = 0;
  const assign = (wi: WorkItem, nodeId: string, status: AssignmentStatus, machineId: string | undefined, provider: string, model: string, attempt = 1, result?: Assignment['result']) => {
    const node = perpetoBuildV3().nodes.find((n) => n.id === nodeId)!;
    assignments.push({
      id: `asg_${(4096 + asgN * 131).toString(36)}`,
      runId: DEMO_IDS.run,
      workItemId: wi.id,
      nodeId,
      role: node.label.toLowerCase(),
      prompt: String(node.config.prompt ?? ''),
      harness: { provider, model },
      policy: {
        maxSubagents: nodeId === 'builder' ? 2 : 0,
        allowedSubagentProviders: nodeId === 'builder' ? ['claudeAgent', 'codex'] : [],
        maxTurns: 80,
        canMessage: nodeId === 'builder' ? ['reviewer'] : nodeId === 'reviewer' ? ['builder'] : [],
      },
      requirements: {},
      status,
      machineId,
      leaseExpiresAt: status === 'running' || status === 'leased' ? iso(now + 45_000) : undefined,
      attempt,
      result,
    });
    asgN++;
  };
  assign(wiAt('Hub: metrics endpoint'), 'reviewer', 'running', DEMO_IDS.studio, 'codex', 'gpt-5.5-codex', 1);
  assign(wiAt('Node: drain mode'), 'builder', 'running', DEMO_IDS.linux, 'claudeAgent', 'claude-sonnet-5-5');
  assign(wiAt('Web: live run map'), 'builder', 'running', DEMO_IDS.linux, 'claudeAgent', 'claude-sonnet-5-5');
  assign(wiAt('T3 executor: subagent limits'), 'builder', 'running', DEMO_IDS.studio, 'claudeAgent', 'claude-sonnet-5-5', 2);
  assign(wiAt('Hub: bottleneck detection'), 'builder', 'running', DEMO_IDS.linux, 'claudeAgent', 'claude-sonnet-5-5');
  assign(wiAt('CLI: install script'), 'builder', 'queued', undefined, 'claudeAgent', 'claude-sonnet-5-5');
  assign(wiAt('Docs: machine setup guide'), 'builder', 'queued', undefined, 'claudeAgent', 'claude-sonnet-5-5');
  for (const title of ['Hub: SSE event stream', 'Node: job runner worktrees', 'Web: workflow inspector', 'Accounts: invalid credential detection', 'Delivery: merge queue batching', 'Hub: usage by machine', 'Workflow: delegates edge policy'])
    assign(wiAt(title), 'reviewer', 'queued', undefined, 'codex', 'gpt-5.5-codex');
  for (const wi of workItems.filter((w) => w.status === 'done').slice(0, 8)) {
    const builderMachine = r() > 0.5 ? DEMO_IDS.linux : DEMO_IDS.studio;
    assign(wi, 'builder', 'succeeded', builderMachine, 'claudeAgent', 'claude-sonnet-5-5', 1, { outcome: 'success', summary: 'Opened pull request with tests.', branch: wi.branch, prUrl: wi.prUrl, headSha: wi.headSha });
    assign(wi, 'reviewer', 'succeeded', DEMO_IDS.studio, 'codex', 'gpt-5.5-codex', 1, { outcome: 'success', summary: 'Meets acceptance criteria.', prUrl: wi.prUrl, headSha: wi.headSha });
  }
  assign(wiAt('Accounts: provider terms check'), 'reviewer', 'failed', DEMO_IDS.studio, 'codex', 'gpt-5.5-codex', 3, {
    outcome: 'failure',
    summary: 'Returned a third time: scope still includes rotating consumer subscriptions. Loop limit of 3 reached.',
  });

  const machines: Machine[] = [
    {
      id: DEMO_IDS.studio,
      name: 'studio-mac',
      os: 'darwin',
      arch: 'arm64',
      labels: ['macos', 'xcode', 'ci'],
      providers: ['claudeAgent', 'codex'],
      capacity: { maxAgents: 6, maxJobs: 2 },
      running: { agents: 2, jobs: 1 },
      status: 'online',
      lastHeartbeatAt: ago(4_000),
      version: '0.1.0',
    },
    {
      id: DEMO_IDS.linux,
      name: 'build-linux',
      os: 'linux',
      arch: 'x64',
      labels: ['linux', 'docker', 'ci'],
      providers: ['claudeAgent', 'codex'],
      capacity: { maxAgents: 8, maxJobs: 4 },
      running: { agents: 3, jobs: 0 },
      status: 'online',
      lastHeartbeatAt: ago(7_000),
      version: '0.1.0',
    },
  ];

  const accounts: Account[] = [
    { id: 'acct_s1', machineId: DEMO_IDS.studio, provider: 'claudeAgent', label: 'Claude Max · personal', status: 'active', lastUsedAt: ago(20_000) },
    { id: 'acct_s2', machineId: DEMO_IDS.studio, provider: 'claudeAgent', label: 'Claude Team · lumin', status: 'cooling', cooldownUntil: iso(now + 38 * MIN), lastUsedAt: ago(22 * MIN) },
    { id: 'acct_s3', machineId: DEMO_IDS.studio, provider: 'codex', label: 'ChatGPT Pro', status: 'active', lastUsedAt: ago(9_000) },
    { id: 'acct_l1', machineId: DEMO_IDS.linux, provider: 'claudeAgent', label: 'Claude Max · build', status: 'active', lastUsedAt: ago(3_000) },
    { id: 'acct_l2', machineId: DEMO_IDS.linux, provider: 'codex', label: 'ChatGPT Plus', status: 'invalid', lastUsedAt: ago(2 * DAY) },
    { id: 'acct_l3', machineId: DEMO_IDS.linux, provider: 'codex', label: 'ChatGPT Pro · build', status: 'disabled', lastUsedAt: ago(9 * DAY) },
  ];

  const ciItem = wiAt('Workflow: version history');
  const mergeItem = wiAt('Hub: workflow activation');
  const jobs: Job[] = [
    {
      id: 'job_9tq2',
      projectId: DEMO_IDS.perpeto,
      runId: DEMO_IDS.run,
      workItemId: ciItem.id,
      repo: 'https://github.com/lumin-products/perpeto',
      revision: ciItem.headSha!,
      steps: [{ name: 'Install', run: 'npm ci' }, { name: 'Test', run: 'npm test' }, { name: 'Build', run: 'npm run build' }],
      requirements: { os: 'darwin' },
      status: 'running',
      machineId: DEMO_IDS.studio,
      attempt: 1,
      artifacts: [],
      configHash: sha(r).slice(0, 12),
    },
    {
      id: 'job_9tm7',
      projectId: DEMO_IDS.perpeto,
      runId: DEMO_IDS.run,
      workItemId: mergeItem.id,
      repo: 'https://github.com/lumin-products/perpeto',
      revision: mergeItem.headSha!,
      steps: [{ name: 'Test', run: 'npm test' }],
      requirements: {},
      status: 'passed',
      machineId: DEMO_IDS.linux,
      attempt: 1,
      artifacts: [{ name: 'test-report.xml', path: 'artifacts/test-report.xml' }],
      configHash: sha(r).slice(0, 12),
    },
  ];
  const jobLogs: Record<string, string> = {
    job_9tq2: [
      `$ git checkout ${ciItem.headSha}`,
      '$ npm ci',
      'added 412 packages in 9.8s',
      '$ npm test',
      '✔ workflow versions are immutable (4.1ms)',
      '✔ activate makes a draft active (6.0ms)',
      '… running',
    ].join('\n'),
    job_9tm7: ['$ npm test', 'tests 148', 'pass 148', 'fail 0'].join('\n'),
  };

  const done = workItems.filter((w) => w.status === 'done');
  const mergeQueue: MergeEntry[] = [
    { id: 'mq_01', projectId: DEMO_IDS.perpeto, prUrl: done[12].prUrl!, headSha: done[12].headSha!, baseBranch: 'main', status: 'merged' },
    { id: 'mq_02', projectId: DEMO_IDS.perpeto, prUrl: done[13].prUrl!, headSha: done[13].headSha!, baseBranch: 'main', status: 'merged' },
    { id: 'mq_03', projectId: DEMO_IDS.perpeto, prUrl: 'https://github.com/lumin-products/perpeto/pull/209', headSha: sha(r), baseBranch: 'main', status: 'rejected', reason: 'CI failed at this revision: 2 of 148 tests failed. Returned to the review loop.' },
    { id: 'mq_04', projectId: DEMO_IDS.perpeto, prUrl: mergeItem.prUrl!, headSha: mergeItem.headSha!, baseBranch: 'main', status: 'testing', jobId: 'job_9tm7' },
  ];

  // Usage: 14 days across providers, models and machines.
  const usage: UsageRecord[] = [];
  const mix = [
    { provider: 'claudeAgent', model: 'claude-sonnet-5-5', weight: 1, machine: DEMO_IDS.linux, project: DEMO_IDS.perpeto },
    { provider: 'claudeAgent', model: 'claude-sonnet-5-5', weight: 0.45, machine: DEMO_IDS.studio, project: DEMO_IDS.perpeto },
    { provider: 'claudeAgent', model: 'claude-opus-5-5', weight: 0.22, machine: DEMO_IDS.studio, project: DEMO_IDS.perpeto },
    { provider: 'codex', model: 'gpt-5.5-codex', weight: 0.5, machine: DEMO_IDS.studio, project: DEMO_IDS.perpeto },
    { provider: 'claudeAgent', model: 'claude-sonnet-5-5', weight: 0.3, machine: DEMO_IDS.linux, project: DEMO_IDS.cooler },
    { provider: 'codex', model: 'gpt-5.5-codex', weight: 0.12, machine: DEMO_IDS.linux, project: DEMO_IDS.cooler },
  ];
  let usageN = 0;
  for (let d = 13; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setUTCHours(10, 0, 0, 0);
    const ramp = d > 9 ? 0.35 : d > 3 ? 0.8 : 1;
    for (const m of mix) {
      if (m.project === DEMO_IDS.cooler && d < 2) continue;
      const base = 1_400_000 * m.weight * ramp * (0.75 + r() * 0.5);
      const at = d === 0 ? Math.min(now - 5 * MIN, dayStart.getTime()) : dayStart.getTime();
      usage.push({
        id: `use_${usageN++}`,
        projectId: m.project,
        runId: m.project === DEMO_IDS.perpeto && d <= 3 ? DEMO_IDS.run : undefined,
        machineId: m.machine,
        provider: m.provider,
        model: m.model,
        inputTokens: Math.round(base * 0.62),
        outputTokens: Math.round(base * 0.09),
        cacheReadTokens: Math.round(base * 1.9),
        cacheWriteTokens: Math.round(base * 0.21),
        at: iso(at),
      });
    }
  }

  // Interaction history for the live run, newest last.
  const events: HubEvent[] = [];
  let seq = 4800;
  const push = (msAgo: number, type: string, subject: HubEvent['subject'], data: Record<string, unknown>, runId: string | undefined = DEMO_IDS.run) => {
    events.push({ seq: ++seq, at: ago(msAgo), type, projectId: DEMO_IDS.perpeto, runId, subject, data });
  };
  const story: [number, string, Record<string, unknown>][] = [
    [96, 'workitem.moved', { fromNode: 'planner', toNode: 'loop', edgeId: 'e-planner-out-loop', summary: 'Planner created 6 work items' }],
    [90, 'agent.delegated', { fromNode: 'planner', toNode: 'builder', edgeId: 'd-planner-builder', summary: 'Planner assigned "Hub: bottleneck detection" to Builder' }],
    [84, 'assignment.state', { nodeId: 'builder', state: 'running', machineId: DEMO_IDS.linux, summary: 'Builder started on build-linux' }],
    [77, 'gate.result', { nodeId: 'reviewer', result: 'fail', fromNode: 'reviewer', toNode: 'loop', edgeId: 'e-reviewer-fail-loop', summary: 'Review returned "Node: job runner worktrees": type errors in runner.js' }],
    [71, 'workitem.moved', { fromNode: 'reviewer', toNode: 'loop', edgeId: 'e-reviewer-fail-loop', summary: '"Node: job runner worktrees" back to Builder, iteration 2' }],
    [64, 'agent.messaged', { fromNode: 'builder', toNode: 'reviewer', edgeId: 'm-builder-reviewer', summary: 'Builder asked Reviewer whether lease renewal needs its own test' }],
    [58, 'agent.messaged', { fromNode: 'reviewer', toNode: 'planner', unplanned: true, summary: 'Reviewer asked Planner to split "Delivery: merge queue batching". No messages edge connects these roles.' }],
    [51, 'gate.result', { nodeId: 'ci', result: 'pass', fromNode: 'ci', toNode: 'merge', edgeId: 'e-ci-pass-merge', summary: 'CI passed at 4f1c9e2 on build-linux' }],
    [44, 'agent.delegated', { fromNode: 'builder', toNode: 'builder', summary: 'Builder spawned 1 subagent (codex) for test fixtures, 1 of 2 allowed' }],
    [37, 'gate.result', { nodeId: 'reviewer', result: 'fail', fromNode: 'reviewer', toNode: 'loop', edgeId: 'e-reviewer-fail-loop', summary: 'Review returned "Delivery: merge queue batching": lint errors' }],
    [31, 'workitem.moved', { fromNode: 'builder', toNode: 'reviewer', edgeId: 'e-builder-out-reviewer', summary: '"Hub: usage by machine" waiting for review, 7 in queue' }],
    [24, 'assignment.state', { nodeId: 'reviewer', state: 'running', machineId: DEMO_IDS.studio, summary: 'Reviewer started "Hub: metrics endpoint" on studio-mac' }],
    [18, 'agent.messaged', { fromNode: 'reviewer', toNode: 'planner', unplanned: true, summary: 'Reviewer asked Planner for acceptance criteria on "Hub: SSE event stream"' }],
    [12, 'agent.messaged', { fromNode: 'builder', toNode: 'reviewer', edgeId: 'm-builder-reviewer', summary: 'Builder flagged "Web: live run map" needs design review' }],
    [7, 'assignment.state', { nodeId: 'ci', state: 'running', machineId: DEMO_IDS.studio, summary: 'CI job started for "Workflow: version history" on studio-mac' }],
    [3, 'workitem.moved', { fromNode: 'merge', toNode: 'done', edgeId: 'e-merge-out-done', summary: '"Usage ledger: group by day" merged into main' }],
  ];
  for (const [mins, type, data] of story) push(mins * MIN, type, { kind: type.split('.')[0] === 'workitem' ? 'work_item' : type.split('.')[0], id: `ev_${mins}` }, data);
  push(40 * MIN, 'workflow.draft', { kind: 'workflow', id: DEMO_IDS.build }, { version: 4, summary: 'Agent proposed Build version 4: Fast checks before review' }, undefined);

  const channels: Record<string, Channel[]> = {
    [DEMO_IDS.perpeto]: [
      { id: 'general', name: 'General' },
      { id: `run-${DEMO_IDS.run}`, name: `Run ${DEMO_IDS.run}` },
      { id: 'review', name: 'Review' },
    ],
    [DEMO_IDS.cooler]: [
      { id: 'general', name: 'General' },
      { id: `run-${DEMO_IDS.coolerRun}`, name: `Run ${DEMO_IDS.coolerRun}` },
    ],
    [DEMO_IDS.notes]: [],
  };
  const messages: Message[] = [];
  let msgN = 0;
  const say = (projectId: string, channelId: string, minsAgo: number, sender: string, body: string, recipient: string | null = null) => {
    messages.push({ id: `msg_${msgN++}`, projectId, channelId, senderRoleId: sender, recipientRoleId: recipient, body, createdAt: ago(minsAgo * MIN) });
  };
  const runCh = `run-${DEMO_IDS.run}`;
  say(DEMO_IDS.perpeto, runCh, 180, 'planner', 'Created 6 work items from docs/architecture/README.md "Observing runs". Each has acceptance criteria in its body.');
  say(DEMO_IDS.perpeto, runCh, 64, 'builder-2', 'Does lease renewal need its own test, or is the expiry test enough?', 'reviewer');
  say(DEMO_IDS.perpeto, runCh, 61, 'reviewer', 'Its own test. Renewal after expiry must return 409 lease_lost.', 'builder-2');
  say(DEMO_IDS.perpeto, runCh, 58, 'reviewer', 'Please split "Delivery: merge queue batching". It mixes batching and rejection reasons.', 'planner');
  say(DEMO_IDS.perpeto, runCh, 37, 'reviewer', 'Returned "Delivery: merge queue batching": 3 lint errors in queue.js. Iteration 3 of 3.');
  say(DEMO_IDS.perpeto, runCh, 18, 'reviewer', 'What are the acceptance criteria for the SSE stream? Reconnect behaviour is not specified.', 'planner');
  say(DEMO_IDS.perpeto, runCh, 12, 'builder-1', 'The live run map is ready for a design look before review. Screenshots are on the PR.', 'reviewer');
  say(DEMO_IDS.perpeto, 'general', 300, 'owner', 'Keep the reviewer on Codex so every change gets a second model family.');
  say(DEMO_IDS.perpeto, 'general', 41, 'architect', 'Proposed Build version 4: Fast checks before review, reviewer concurrency 3. Draft only; nothing changes until it is activated.');
  say(DEMO_IDS.perpeto, 'review', 90, 'reviewer', 'Rubric for this run: correctness, tests, scope. Lint and type errors count as correctness.');
  say(DEMO_IDS.cooler, 'general', 2900, 'owner', 'Paused while we decide whether Perpeto reuses Cooler for messaging.');

  // Metrics for the live run.
  const nm = (m: Partial<NodeMetrics> & { nodeId: string }): NodeMetrics => ({
    queued: 0,
    active: 0,
    done: 0,
    failed: 0,
    concurrency: 0,
    utilization: 0,
    waitSec: { avg: 0, p90: 0 },
    serviceSec: { avg: 0, p90: 0 },
    throughputPerHour: 0,
    failureRate: 0,
    tokens: 0,
    ...m,
  });
  const runMetrics: MetricsSnapshot = {
    window: '24h',
    nodes: [
      nm({ nodeId: 'input', done: 31, throughputPerHour: 1.3 }),
      nm({ nodeId: 'planner', done: 31, concurrency: 1, waitSec: { avg: 40, p90: 95 }, serviceSec: { avg: 260, p90: 410 }, throughputPerHour: 1.3, tokens: 1_240_000 }),
      nm({ nodeId: 'loop', done: 46, failed: 1, throughputPerHour: 1.9 }),
      nm({ nodeId: 'builder', queued: 2, active: 4, done: 40, concurrency: 6, utilization: 0.67, waitSec: { avg: 260, p90: 540 }, serviceSec: { avg: 2_820, p90: 4_900 }, throughputPerHour: 1.7, failureRate: 0.03, tokens: 9_860_000 }),
      nm({ nodeId: 'reviewer', queued: 7, active: 1, done: 34, failed: 12, concurrency: 1, utilization: 1, waitSec: { avg: 1_860, p90: 2_880 }, serviceSec: { avg: 840, p90: 1_320 }, throughputPerHour: 1.4, failureRate: 0.42, tokens: 2_310_000 }),
      nm({ nodeId: 'ci', active: 1, done: 20, failed: 3, concurrency: 2, utilization: 0.5, waitSec: { avg: 50, p90: 120 }, serviceSec: { avg: 310, p90: 460 }, throughputPerHour: 0.9, failureRate: 0.15 }),
      nm({ nodeId: 'merge', queued: 1, done: 14, concurrency: 1, waitSec: { avg: 380, p90: 900 }, serviceSec: { avg: 95, p90: 180 }, throughputPerHour: 0.6 }),
      nm({ nodeId: 'done', done: 14, throughputPerHour: 0.6 }),
    ],
    edges: [
      { edgeId: 'e-input-out-planner', kind: 'flow', count: 31, unplanned: false },
      { edgeId: 'e-planner-out-loop', kind: 'flow', count: 31, unplanned: false },
      { edgeId: 'e-loop-out-builder', kind: 'flow', count: 46, unplanned: false },
      { edgeId: 'e-builder-out-reviewer', kind: 'flow', count: 40, unplanned: false },
      { edgeId: 'e-reviewer-pass-ci', kind: 'flow', count: 22, unplanned: false },
      { edgeId: 'e-reviewer-fail-loop', kind: 'flow', count: 12, unplanned: false },
      { edgeId: 'e-ci-pass-merge', kind: 'flow', count: 17, unplanned: false },
      { edgeId: 'e-ci-fail-loop', kind: 'flow', count: 3, unplanned: false },
      { edgeId: 'e-merge-out-done', kind: 'flow', count: 14, unplanned: false },
      { edgeId: 'd-planner-builder', kind: 'delegates', count: 31, unplanned: false },
      { edgeId: 'm-builder-reviewer', kind: 'messages', count: 57, unplanned: false },
      { edgeId: 'u-reviewer-planner', kind: 'messages', count: 3, unplanned: true, from: 'reviewer', to: 'planner' },
    ],
    run: {
      velocity: { itemsDonePerDay: 4.7, trend: [3, 4, 6, 5, 6, 4, 4] },
      cycleTimeSec: { avg: 23_000, p90: 40_300 },
      wip: 16,
      tokensPerItem: 182_000,
      activeAgents: 5,
      machines: [
        { machineId: DEMO_IDS.studio, activeAgents: 2, nodes: ['reviewer', 'builder', 'ci'] },
        { machineId: DEMO_IDS.linux, activeAgents: 3, nodes: ['builder'] },
      ],
    },
    bottlenecks: [
      { nodeId: 'reviewer', reason: 'saturated', severity: 'critical', evidence: 'Utilization 1.00 at concurrency 1. Queue grew from 3 to 7 in 2 h. p90 wait 48 min.' },
      { nodeId: 'loop', reason: 'rework-loop', severity: 'warning', evidence: '1.9 iterations per item against a 7-day average of 1.2. 12 of 34 reviews returned work in 24 h.' },
    ],
  };

  const coolerMetrics: MetricsSnapshot = {
    window: '24h',
    nodes: [
      nm({ nodeId: 'builder', queued: 3, concurrency: 4, done: 6, throughputPerHour: 0 }),
      nm({ nodeId: 'reviewer', queued: 1, concurrency: 1, done: 5, throughputPerHour: 0 }),
      nm({ nodeId: 'done', done: 4 }),
    ],
    edges: [],
    run: { velocity: { itemsDonePerDay: 0, trend: [2, 3, 1, 0, 0, 0, 0] }, cycleTimeSec: { avg: 31_000, p90: 52_000 }, wip: 4, tokensPerItem: 240_000, activeAgents: 0, machines: [] },
    bottlenecks: [{ nodeId: 'builder', reason: 'waiting-on-human', severity: 'info', evidence: 'Run paused by owner 2 days ago. 4 items wait.' }],
  };

  // Ensure every node in the graph appears in node metrics.
  for (const n of perpetoBuildV3().nodes) if (!runMetrics.nodes.some((m) => m.nodeId === n.id)) runMetrics.nodes.push(nm({ nodeId: n.id }));

  return {
    projects,
    versions,
    runs,
    workItems,
    assignments,
    machines,
    accounts,
    jobs,
    jobLogs,
    mergeQueue,
    usage,
    events,
    channels,
    messages,
    metrics: { [DEMO_IDS.run]: runMetrics, [DEMO_IDS.coolerRun]: coolerMetrics },
    seq,
  };
}
