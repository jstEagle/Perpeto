import { requireValue, object } from './errors.js';

export const RUN_SETTINGS = ['keepOpen', 'source', 'schedule', 'budget'];

/** Durable source requests, manual input batches and usage delivery intents share the hub transaction boundary. */
export class Intake {
  constructor(hub) { this.hub = hub; this.store = hub.store; }
  state(run) { return this.store.get('engine-state', run.id)?.state ?? this.hub.engine.runState?.(run.id); }
  view(run) {
    const state = this.state(run);
    return { ...run, ...Object.fromEntries(RUN_SETTINGS.filter(key => state?.[key] !== undefined).map(key => [key, state[key]])),
      ...(state?.intake ? { intake: state.intake, budgetUsage: state.budgetUsage } : {}), ...(run.intakeHeld ? { keepOpen: run.keepOpen } : {}) };
  }
  settings(value) {
    object(value, 'run settings');
    const settings = Object.fromEntries(RUN_SETTINGS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    if (settings.keepOpen !== undefined) requireValue(typeof settings.keepOpen === 'boolean', 'keepOpen must be a boolean.');
    if (settings.source !== undefined) requireValue(['goals', 'schedule', 'manual'].includes(settings.source), 'Invalid run source.');
    if (settings.budget !== undefined) {
      object(settings.budget, 'budget');
      requireValue(Object.entries(settings.budget).every(([key, n]) => ['maxTokensPerDay', 'maxActiveItems', 'maxItemsPerDay'].includes(key) && Number.isSafeInteger(n) && n > 0), 'Budget limits must be positive safe integers.');
    }
    return settings;
  }
  request(run, value) {
    this.store.put('intake-request', { id: value.requestId, runId: run.id, projectId: run.projectId, ...value });
  }
  async hold(run) {
    const state = this.state(run);
    if (state?.keepOpen || run.intakeHeld || !Object.keys(state?.budget ?? {}).length) return;
    const pending = this.store.forRun('intake-request', run.id, false).filter(request => !request.source).reduce((sum, request) => sum + request.items.length, 0);
    const active = Object.values(state.workItems).filter(item => !['done', 'failed'].includes(item.status) && item.waiting?.kind !== 'children').length;
    if (!state.intake?.paused && pending <= Math.min((state.budget.maxActiveItems ?? Infinity) - active,
      (state.budget.maxItemsPerDay ?? Infinity) - (state.budgetUsage?.items ?? 0))) return;
    await this.hub.engineEvent(run, { type: 'run.configured', data: { keepOpen: true } });
    run.keepOpen = false; run.intakeHeld = true; this.store.put('run', run);
  }
  async release() {
    for (const run of this.store.list('run', value => value.intakeHeld)) {
      if (this.store.forRun('intake-request', run.id, false).some(request => !request.source)) continue;
      if (['running', 'paused'].includes(run.status)) await this.hub.engineEvent(run, { type: 'run.configured', data: { keepOpen: run.keepOpen } });
      delete run.intakeHeld; this.store.put('run', run);
    }
  }
  context(project) {
    const goals = this.hub.goalProgress(project);
    const runs = this.store.list('run', value => value.projectId === project.id);
    const outcomes = runs.flatMap(run => this.hub.workItems(run.id)).filter(item => ['done', 'failed'].includes(item.status)).slice(-20)
      .map(({ id, title, status }) => ({ id, title, status }));
    const usage = this.hub.usage(new URLSearchParams({ projectId: project.id, groupBy: 'day' })).totals;
    return JSON.stringify({ goals, docs: project.docs ?? [], metrics: { usage }, previousOutcomes: outcomes });
  }
  sourceItems(run, request) {
    const project = this.store.need('project', run.projectId);
    const context = this.context(project);
    if (request.source === 'goals') {
      const links = this.store.forProject('goal-link', project.id);
      const reserved = this.store.list('intake-request').flatMap(value => value.delivery?.data.items ?? value.items ?? []).map(item => item.goalId);
      return this.hub.goalProgress(project).filter(goal => !reserved.includes(goal.id) && goal.status === 'active' && !(goal.total > 0 && goal.done === goal.total) &&
        !links.some(link => link.goalId === goal.id && ['running', 'paused'].includes(this.store.get('run', link.runId)?.status) &&
          !['done', 'failed'].includes(this.hub.workItem(link.id).status)))
        .slice(0, request.limit).map(goal => ({ title: goal.title.slice(0, 200), goalId: goal.id, nodeId: request.nodeId, body: `Goals and evidence:\n${context}`.slice(0, 20000) }));
    }
    return [{ title: 'Scheduled improvement pass', nodeId: request.nodeId, body: `Audit goals, metrics and previous outcomes. Avoid duplicate work; propose no items when nothing is justified.\n${context}`.slice(0, 20000) }].slice(0, request.limit);
  }
  async settle(at) {
    // Heartbeats and renewals usually have no intake work and need no extra write transactions.
    if (this.store.has('usage-intent')) await this.store.transaction(() => this.usage());
    if (!this.store.has('intake-request')) return;
    await this.store.transaction(() => this.prepare(at));
    await this.store.transaction(() => this.drain());
  }
  async usage() {
    const days = new Map();
    for (const intent of this.store.list('usage-intent')) {
      const run = this.store.get('run', intent.runId);
      if (run) {
        const day = days.get(run.id) ?? this.state(run)?.budgetUsage?.day ?? '';
        // A delayed prior-day record remains in the ledger; it must not consume today's allowance.
        if (intent.at.slice(0, 10) >= day) {
          await this.hub.engineEvent(run, { id: `usage:${intent.id}`, at: intent.at, type: 'usage.recorded', data: intent.data });
          days.set(run.id, intent.at.slice(0, 10));
        }
      }
      this.store.remove('usage-intent', intent.id);
    }
  }
  async tick(at) {
    await this.usage();
    const minute = at.slice(0, 16);
    for (const run of this.store.list('run', value => value.status === 'running')) {
      // New runs persist settings on their hub row; older runs are read once to recover keepOpen.
      if (run.keepOpen === undefined) { run.keepOpen = this.view(run).keepOpen ?? false; this.store.put('run', run); }
      if ((run.keepOpen || run.budget || run.intakeHeld) && (!run.lastTickMinute || run.lastTickMinute < minute)) {
        await this.hub.engineEvent(run, { id: `tick:${run.id}:${minute}`, at, type: 'input.tick', data: {} });
        run.lastTickMinute = minute; this.store.put('run', run);
      }
    }
  }
  prepare(at = new Date().toISOString()) {
    for (const request of this.store.list('intake-request')) {
      const run = this.store.get('run', request.runId);
      if (!run || ['stopped', 'completed', 'failed'].includes(run.status)) { this.store.remove('intake-request', request.id); continue; }
      if (run.status !== 'running') continue;
      const state = this.state(run);
      if (request.source && !Object.values(state?.intake?.requests ?? {}).some(value => value.requestId === request.requestId)) {
        this.store.remove('intake-request', request.id); continue;
      }
      if (request.delivery || state?.intake?.paused) continue;
      const items = request.items ?? this.sourceItems(run, request);
      const active = Object.values(state?.workItems ?? {}).filter(item => !['done', 'failed'].includes(item.status) && item.waiting?.kind !== 'children').length;
      const limit = Math.max(0, Math.min(100, (state?.budget?.maxActiveItems ?? Infinity) - active,
        (state?.budget?.maxItemsPerDay ?? Infinity) - (state?.budgetUsage?.items ?? 0)));
      const batch = items.slice(0, limit);
      if (items.length && !batch.length) continue;
      request.delivery = { id: `intake:${request.id}:${request.offset ?? 0}:${request.attempt ?? 0}`, at, type: 'input', data: {
        items: batch, ...(request.requestId ? { requestId: request.requestId } : {}),
        hubIntake: { id: request.id, count: batch.length, offset: request.offset ?? 0 },
      } };
      this.store.put('intake-request', request);
    }
  }
  delivered({ id, count, offset }) {
    const request = this.store.get('intake-request', id);
    if (!request || (request.offset ?? 0) !== offset) return;
    if (!request.source && count < request.items.length) {
      delete request.delivery;
      this.store.put('intake-request', { ...request, items: request.items.slice(count), offset: offset + count });
    } else this.store.remove('intake-request', id);
  }
  async drain() {
    for (const request of this.store.list('intake-request')) {
      const run = this.store.get('run', request.runId);
      if (!run || ['stopped', 'completed', 'failed'].includes(run.status)) { this.store.remove('intake-request', request.id); continue; }
      if (run.status !== 'running') continue;
      if (!request.delivery) continue;
      const state = this.state(run);
      if (request.source && !Object.values(state?.intake?.requests ?? {}).some(value => value.requestId === request.requestId)) {
        this.store.remove('intake-request', request.id); continue;
      }
      await this.hub.engineEvent(run, request.delivery);
      // Rejected batches have no delivered effect. Keep their contents for a fresh attempt after budget.available.
      const remaining = this.store.get('intake-request', request.id);
      if (remaining?.delivery) {
        delete remaining.delivery; remaining.attempt = (remaining.attempt ?? 0) + 1;
        this.store.put('intake-request', remaining);
      }
    }
    await this.release();
  }
}
