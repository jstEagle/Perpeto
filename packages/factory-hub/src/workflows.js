import { randomUUID } from 'node:crypto';
import { nonblank, integer, requireValue } from './errors.js';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** Immutable graph versions plus a mutable head/active pointer, all in the hub DB. */
export class Workflows {
  constructor(hub) { this.hub = hub; this.store = hub.store; }
  versions(workflowId) {
    this.store.need('workflow', workflowId);
    return this.store.list('workflow-version', record => record.workflowId === workflowId).map(record => record.value).sort((a, b) => a.version - b.version);
  }
  version(workflowId, version) { return this.store.need('workflow-version', `${workflowId}:${integer(version, 'version', 1)}`).value; }
  save(value) {
    const previous = this.store.get('workflow', value.id);
    const versions = previous ? this.versions(value.id) : [];
    const version = (versions.at(-1)?.version ?? 0) + 1;
    const workflow = { ...value, version, status: 'draft', ...(previous?.activeVersion ? { activeVersion: previous.activeVersion } : {}) };
    this.store.put('workflow-version', { id: `${value.id}:${version}`, workflowId: value.id, value: workflow });
    this.store.put('workflow', workflow);
    this.hub.emit('workflow.version.saved', 'workflow', workflow, { version, authoredBy: workflow.authoredBy });
    return workflow;
  }
  activate(workflow, version) {
    const value = this.version(workflow.id, version);
    // Activation changes the pointer, never an immutable version record or a live run.
    const current = { ...value, status: 'active', activeVersion: version };
    this.store.put('workflow', current); this.hub.emit('workflow.activated', 'workflow', current, { version }); return current;
  }
  async requestDraft(project, body) {
    nonblank(body.prompt, 'prompt', 65536);
    let base = null;
    if (body.baseWorkflowId !== undefined) {
      base = this.store.need('workflow', nonblank(body.baseWorkflowId, 'baseWorkflowId', 200));
      requireValue(base.projectId === project.id, 'Base workflow belongs to another project.');
      if (base.activeVersion) base = this.version(base.id, base.activeVersion);
    }
    const request = { id: id('wfd'), projectId: project.id, workflowId: base?.id ?? id('wf'), prompt: body.prompt,
      baseVersion: base?.version ?? null, baseGraph: base?.graph ?? null, attempt: 1, status: 'pending', errors: [] };
    this.store.put('architect-request', request);
    return this.enqueueArchitect(request);
  }
  async enqueueArchitect(request) {
    const project = this.store.need('project', request.projectId);
    const machines = this.store.list('machine'); const workflows = this.store.list('workflow', value => value.projectId === project.id);
    const prompt = await this.hub.engine.buildArchitectPrompt({ prompt: request.prompt, project, machines, providers: [...new Set(machines.flatMap(machine => machine.providers))], workflows,
      baseGraph: request.baseGraph, validationErrors: request.errors, attempt: request.attempt });
    nonblank(prompt, 'architect prompt', 1048576);
    const assignment = { id: id('asg'), projectId: project.id, nodeId: 'workflow-architect', role: 'workflow-architect', prompt,
      harness: this.hub.config.architectHarness, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] },
      requirements: { providers: [this.hub.config.architectHarness.provider] }, status: 'queued', attempt: 1,
      architectRequestId: request.id, architectAttempt: request.attempt };
    request.assignmentId = assignment.id;
    this.store.put('architect-request', request); this.store.put('assignment', assignment);
    this.hub.emit('assignment.state', 'assignment', assignment, { state: 'queued', nodeId: assignment.nodeId, role: assignment.role });
    return assignment;
  }
  async completed(assignment, result) {
    const request = this.store.need('architect-request', assignment.architectRequestId);
    requireValue(request.status === 'pending' && request.assignmentId === assignment.id, 'Architect request is not pending this assignment.');
    let parsed; let errors = [];
    try { parsed = await this.hub.engine.parseArchitectResult(result); }
    catch { errors = ['Architect result could not be parsed. Return a graph and rationale.']; }
    if (!errors.length) {
      if (result.outcome !== 'success') errors = ['Architect assignment did not succeed.'];
      else {
        const validation = await this.hub.engine.validate(parsed?.graph);
        if (!validation.valid) errors = validation.errors?.length ? validation.errors : ['Workflow graph is invalid.'];
        else if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim() || parsed.rationale.length > 65536) errors = ['Architect result must include a nonblank rationale of at most 65536 characters.'];
      }
    }
    if (errors.length) {
      request.errors = errors; assignment.status = 'failed'; assignment.result.outcome = 'failure';
      assignment.architectErrors = errors;
      if (request.attempt < 3) {
        request.attempt++;
        const next = await this.enqueueArchitect(request); assignment.retryAssignmentId = next.id;
      } else { request.status = 'failed'; this.store.put('architect-request', request); }
      this.store.put('assignment', assignment);
      this.hub.emit('workflow.architect.invalid', 'assignment', assignment, { errors, architectAttempt: assignment.architectAttempt });
      return;
    }
    const base = this.store.get('workflow', request.workflowId);
    const workflow = this.save({ id: request.workflowId, projectId: request.projectId, name: base?.name ?? 'Proposed workflow', purpose: base?.purpose ?? 'custom', graph: parsed.graph,
      authoredBy: { kind: 'agent', assignmentId: assignment.id, prompt: request.prompt }, rationale: parsed.rationale,
      ...(request.baseVersion ? { parentVersion: request.baseVersion } : {}) });
    request.status = 'completed'; request.version = workflow.version;
    assignment.draftWorkflowId = workflow.id; assignment.draftVersion = workflow.version;
    this.store.put('architect-request', request); this.store.put('assignment', assignment);
  }
  async diff(workflowId, query) {
    const workflow = this.store.need('workflow', workflowId);
    const from = this.version(workflowId, Number(query.get('from') ?? workflow.activeVersion ?? 1));
    const to = this.version(workflowId, Number(query.get('to') ?? workflow.version));
    return this.hub.engine.diffGraphs(from.graph, to.graph);
  }
}
