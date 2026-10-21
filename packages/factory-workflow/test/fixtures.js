import { readFileSync } from 'node:fs';
import { step } from '../src/engine.js';

export const template = name => JSON.parse(readFileSync(new URL(`../templates/${name}.json`, import.meta.url), 'utf8'));
export const sha = n => n.toString(16).padStart(40, '0');
export const repo = { url: 'file:///srv/git/app.git', defaultBranch: 'main' };
export const code = expected => error => error.code === expected;

/** Drives the pure engine with sequential event ids and a one-minute clock. */
export class Driver {
  constructor(apply = (state, event) => step(state, event)) {
    this.applyFn = apply;
    this.state = null;
    this.events = [];
    this.effects = [];
    this.minute = 0;
    /** Hub-style event log: engine emit-event effects stamped with the time of the event that caused them. */
    this.log = [];
  }

  /** Append a hub-originated event, such as a lease, to the log. */
  hub(type, data, at = this.event('noop').at) {
    this.log.push({ seq: this.log.length + 1, at, type, data });
  }

  event(type, data = {}) {
    this.minute += 1;
    return { id: `evt_${this.events.length + 1}`, type, at: new Date(Date.UTC(2026, 9, 21, 9, this.minute)).toISOString(), data };
  }

  apply(type, data) {
    const event = this.event(type, data);
    const result = this.applyFn(this.state, event);
    this.state = result.state;
    this.events.push(event);
    this.effects.push(...result.effects);
    for (const effect of result.effects) {
      if (effect.type === 'emit-event') this.log.push({ seq: this.log.length + 1, at: event.at, type: effect.event.type, data: effect.event.data });
    }
    this.last = result;
    return result;
  }

  start({ graph = template('build'), inputs = [{ title: 'Add login', body: 'Email and password sign-in.' }], ...rest } = {}) {
    return this.apply('run.started', {
      runId: 'run_test1', projectId: 'prj_1', workflowId: 'wf_1', workflowVersion: 1, graph, repo, inputs, ...rest,
    });
  }

  open(nodeId) {
    return Object.values(this.state.assignments).filter(a => a.nodeId === nodeId && ['queued', 'leased', 'running'].includes(a.status));
  }

  complete(nodeId, result, index = 0) {
    const assignment = this.open(nodeId)[index];
    if (!assignment) throw new Error(`No open assignment at ${nodeId}`);
    return this.apply('assignment.completed', { assignmentId: assignment.id, result: { summary: 'done', ...result } });
  }

  openJob() { return Object.values(this.state.jobs).find(job => job.status === 'queued'); }
  openMerge() { return Object.values(this.state.merges).find(entry => entry.status === 'queued'); }
  items(filter = () => true) { return Object.values(this.state.workItems).filter(filter); }
  emitted(type) { return this.effects.filter(effect => effect.type === 'emit-event' && effect.event.type === type).map(effect => effect.event); }
  effectTypes(result = this.last) { return result.effects.map(effect => effect.type === 'emit-event' ? effect.event.type : effect.type); }
}
