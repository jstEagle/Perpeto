/**
 * Pure reducer over a T3 orchestration v2 thread: one snapshot projection
 * followed by `{sequence, event}` items from `orchestration.subscribeThread`.
 * Every entity event carries the whole entity (not a delta), so the latest
 * payload replaces the previous one. Shapes: packages/contracts/src/orchestrationV2.ts.
 */
export const ACTIVE_RUN_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const ACTIVE_WORK_STATUSES = new Set(['pending', 'running', 'waiting']);
const HOLDING_BACKGROUND_KINDS = new Set(['subagent', 'monitor', 'background_task']);
const REQUEST_ITEM_TYPES = new Set(['approval_request', 'user_input_request']);

const COLLECTIONS = {
  'run.created': 'runs',
  'run.updated': 'runs',
  'provider-turn.updated': 'providerTurns',
  'turn-item.updated': 'turnItems',
  'subagent.updated': 'subagents',
  'runtime-request.updated': 'runtimeRequests',
  'provider-thread.updated': 'providerThreads',
};

export class ThreadTracker {
  /** @param {string} threadId */
  constructor(threadId) {
    this.threadId = threadId;
    this.thread = null;
    this.lastSequence = undefined;
    this.synchronized = false;
    this.runs = new Map();
    this.providerTurns = new Map();
    this.turnItems = new Map();
    this.subagents = new Map();
    this.runtimeRequests = new Map();
    this.providerThreads = new Map();
  }

  /** @returns {Array<{ collection: string, value: any }>} changed entities */
  applySnapshot(projection, snapshotSequence) {
    const changes = [];
    if (projection?.thread) this.thread = projection.thread;
    for (const collection of Object.values(COLLECTIONS)) {
      for (const value of Array.isArray(projection?.[collection]) ? projection[collection] : []) {
        if (value?.id === undefined) continue;
        this[collection].set(value.id, value);
        changes.push({ collection, value });
      }
    }
    if (Number.isSafeInteger(snapshotSequence)) this.lastSequence = Math.max(this.lastSequence ?? 0, snapshotSequence);
    return changes;
  }

  applyEvent(sequence, event) {
    if (Number.isSafeInteger(sequence)) {
      if (this.lastSequence !== undefined && sequence <= this.lastSequence) return [];
      this.lastSequence = sequence;
    }
    if (event?.type === 'thread.created' && event.payload) { this.thread = { ...this.thread, ...event.payload }; return []; }
    const collection = COLLECTIONS[event?.type];
    const value = event?.payload;
    if (!collection || value?.id === undefined) return [];
    this[collection].set(value.id, value);
    return [{ collection, value }];
  }

  /** Apply one chunk of subscription items. */
  applyItems(items) {
    const changes = [];
    for (const item of items) {
      if (item?.kind === 'snapshot') changes.push(...this.applySnapshot(item.projection, item.snapshotSequence));
      else if (item?.kind === 'synchronized') this.synchronized = true;
      else if (item?.kind === 'event') changes.push(...this.applyEvent(item.sequence, item.event));
    }
    return changes;
  }

  orderedRuns() { return [...this.runs.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)); }
  latestRun() { return this.orderedRuns().at(-1) ?? null; }
  activeRuns() { return this.orderedRuns().filter(run => ACTIVE_RUN_STATUSES.has(run.status)); }

  pendingRequests() {
    const pending = new Map();
    for (const request of this.runtimeRequests.values()) {
      if (request.status === 'pending') pending.set(request.id, { id: request.id, kind: request.kind });
    }
    for (const item of this.turnItems.values()) {
      if (!REQUEST_ITEM_TYPES.has(item.type) || !ACTIVE_WORK_STATUSES.has(item.status)) continue;
      const id = item.requestId ?? item.id;
      const known = this.runtimeRequests.get(id);
      if (known && known.status !== 'pending') continue;
      pending.set(id, {
        id, kind: item.type === 'user_input_request' ? 'user_input' : (item.requestKind ?? 'approval'),
        prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
        questions: Array.isArray(item.questions) ? item.questions.map(question => ({ id: question.id, header: question.header, question: question.question })) : undefined,
      });
    }
    return [...pending.values()];
  }

  /** True when no run, request, subagent or holding background task is active. */
  isIdle() {
    if (this.runs.size === 0) return false;
    if (this.activeRuns().length > 0) return false;
    if (this.pendingRequests().length > 0) return false;
    for (const subagent of this.subagents.values()) if (ACTIVE_WORK_STATUSES.has(subagent.status)) return false;
    for (const providerThread of this.providerThreads.values()) {
      const tasks = Array.isArray(providerThread.pendingBackgroundTasks) ? providerThread.pendingBackgroundTasks : [];
      if (tasks.some(task => HOLDING_BACKGROUND_KINDS.has(task.kind))) return false;
    }
    return true;
  }

  /** Assistant text for a run, in arrival order, joined by blank lines. */
  assistantText(runId) {
    return [...this.turnItems.values()]
      .filter(item => item.type === 'assistant_message' && item.runId === runId && typeof item.text === 'string' && item.text.trim())
      .map(item => item.text.trim())
      .join('\n\n');
  }

  lastAssistantText(runId) {
    return [...this.turnItems.values()].findLast(item => item.type === 'assistant_message' && item.runId === runId && typeof item.text === 'string' && item.text.trim())?.text.trim() ?? '';
  }

  allAssistantText() {
    return [...this.turnItems.values()].filter(item => item.type === 'assistant_message' && typeof item.text === 'string').map(item => item.text).join('\n');
  }

  failures(runId) {
    return [...this.turnItems.values()]
      .filter(item => item.type === 'error' && (runId === undefined || item.runId === runId) && item.failure)
      .map(item => item.failure);
  }
}
