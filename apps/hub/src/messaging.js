import { createHash, timingSafeEqual } from 'node:crypto';
import { fail, requireValue, nonblank, object, integer } from './errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const PREFIX = 'pa1_';
const MAC_LENGTH = 43;
/** The role id people use in clients. Agents may always message it, and replies to a person are always planned. */
export const OWNER_ROLE_ID = 'owner';
const active = value => ['leased', 'running'].includes(value?.status);
const runChannel = runId => `run-${runId}`;

/**
 * Controlled agent messaging. Each leased run assignment gets a credential bound to its role and run channel, derived
 * from the hub credential key, so it is never stored and ends when the assignment does. Agent sends are checked against
 * the assignment's `policy.canMessage` (derived from `messages` edges): under the workflow's `messagingPolicy` of
 * `flag` (default) an unplanned send is stored and marked, under `enforce` it is refused. Agents are rate limited per
 * role; the owner is not.
 */
export class HubMessaging {
  constructor(hub) { this.hub = hub; this.store = hub.store; }
  get messaging() { return this.hub.messaging; }

  /** Workflow fields that govern messaging, validated. Returns only the fields present. */
  static fields(value) {
    const fields = {};
    if (value.messagingPolicy !== undefined) {
      requireValue(['enforce', 'flag'].includes(value.messagingPolicy), 'messagingPolicy must be enforce or flag.');
      fields.messagingPolicy = value.messagingPolicy;
    }
    if (value.messageRateLimits !== undefined) {
      object(value.messageRateLimits, 'messageRateLimits');
      requireValue(Object.keys(value.messageRateLimits).length <= 200, 'messageRateLimits has too many roles.');
      for (const [role, limit] of Object.entries(value.messageRateLimits)) { nonblank(role, 'messageRateLimits role', 200); integer(limit, `messageRateLimits.${role}`, 1, 10000); }
      fields.messageRateLimits = { ...value.messageRateLimits };
    }
    return fields;
  }

  agentToken(assignment) {
    const payload = Buffer.from(`${assignment.id}\n${assignment.attempt}`).toString('base64url');
    return `${PREFIX}${payload}${this.hub.credentials.derive(`agent-messaging:${payload}`)}`;
  }
  /** The messaging credential a leased run assignment carries. Project-scoped work has none. */
  credential(assignment) {
    if (!assignment.runId) return null;
    return { token: this.agentToken(assignment), projectId: assignment.projectId, channelId: runChannel(assignment.runId), roleId: assignment.role };
  }
  isAgentToken(token) { return typeof token === 'string' && token.startsWith(PREFIX); }
  authenticate(token) {
    const payload = token.slice(PREFIX.length, -MAC_LENGTH); const mac = Buffer.from(token.slice(-MAC_LENGTH));
    const expected = Buffer.from(this.hub.credentials.derive(`agent-messaging:${payload}`));
    const [assignmentId, attempt] = Buffer.from(payload, 'base64url').toString('utf8').split('\n');
    const assignment = payload && mac.length === expected.length && timingSafeEqual(mac, expected) ? this.store.get('assignment', assignmentId) : null;
    if (!assignment?.runId || !active(assignment) || String(assignment.attempt) !== attempt || Date.parse(assignment.leaseExpiresAt) <= this.hub.clock()) {
      fail(401, 'UNAUTHORIZED', 'This agent messaging credential is not valid for a running assignment.');
    }
    return { kind: 'agent', assignment, scope: hash(token) };
  }

  /** Live assignments of a role in a run: the candidates for its inbox. */
  #live(runId, role) { return this.store.byStatus('assignment', ['leased', 'running'], value => value.runId === runId && value.role === role).map(value => value.id); }
  /** Undelivered messages for this assignment's role, claimed for it. Rides on leases and renewals. */
  inbox(assignment) {
    if (!assignment.runId || !assignment.role) return [];
    return this.messaging.claimPending({ projectId: assignment.projectId, channelId: runChannel(assignment.runId), roleId: assignment.role,
      assignmentId: assignment.id, activeAssignmentIds: this.#live(assignment.runId, assignment.role) });
  }
  /** The executor put messages in front of the agent (`prompt` at launch or `steer` into a running turn). */
  delivered(assignment, data) {
    requireValue(Boolean(assignment.runId), 'Deliveries require a run.');
    requireValue(Array.isArray(data.messageIds) && data.messageIds.length <= 500, 'messageIds must be an array.');
    requireValue(['prompt', 'steer'].includes(data.via), 'via must be prompt or steer.');
    const messages = this.messaging.markDelivered({ projectId: assignment.projectId, channelId: runChannel(assignment.runId), roleId: assignment.role,
      messageIds: data.messageIds, via: data.via, assignmentId: assignment.id });
    for (const message of messages) this.#receiptEvent('message.delivered', assignment.runId, message, { via: data.via, assignmentId: assignment.id, ...(data.threadRef ? { threadRef: nonblank(data.threadRef, 'threadRef', 500) } : {}) });
    return messages.map(message => message.id);
  }
  #receiptEvent(type, runId, message, data) {
    const run = runId ? this.store.get('run', runId) : null;
    this.hub.store.event(type, { kind: 'message', id: message.id }, { messageId: message.id, threadId: message.threadId, senderRoleId: message.senderRoleId,
      recipientRoleId: message.recipientRoleId, ...data }, { projectId: message.projectId, ...(run?.projectId === message.projectId ? { runId: run.id } : {}) });
  }

  /**
   * One send, from the owner or an agent. Agents always send as their assignment's role in their run channel. A reply
   * aimed at a role whose live assignment wrote the parent is offered to that assignment first.
   */
  send({ projectId, channelId, auth, body }) {
    object(body, 'body');
    const agent = auth.kind === 'agent' ? auth.assignment : null;
    if (agent && body.senderRoleId !== undefined && body.senderRoleId !== agent.role) fail(403, 'FORBIDDEN', 'Agents send as their own role.');
    const senderRoleId = agent ? agent.role : body.senderRoleId;
    const parentId = body.parentId ?? null;
    const parent = parentId === null ? null : this.messaging.getMessage({ projectId, channelId, messageId: nonblank(parentId, 'parentId', 200) });
    let recipientRoleId = body.recipientRoleId;
    if (recipientRoleId === undefined && parent) recipientRoleId = parent.senderRoleId === senderRoleId ? parent.recipientRoleId : parent.senderRoleId;
    recipientRoleId ??= null;
    const runId = channelId.startsWith('run-') ? channelId.slice(4) : null;
    const run = runId ? this.store.get('run', runId) : null;
    let unplanned = false;
    if (agent) {
      const planned = recipientRoleId !== null && ((agent.policy?.canMessage ?? []).includes(recipientRoleId) || recipientRoleId === OWNER_ROLE_ID ||
        (parent?.senderKind === 'owner' && parent.senderRoleId === recipientRoleId));
      const workflow = this.store.need('run-workflow', agent.runId).workflow;
      if (!planned) {
        if ((workflow.messagingPolicy ?? 'flag') === 'enforce') {
          fail(403, 'MESSAGE_NOT_ALLOWED', recipientRoleId === null ? 'This workflow does not let agents message the whole channel.'
            : `This workflow has no messages edge from ${agent.role} to ${recipientRoleId}.`);
        }
        unplanned = true;
      }
      const limit = workflow.messageRateLimits?.[agent.role] ?? workflow.messageRateLimits?.['*'] ?? this.hub.config.messageRatePerMinute;
      const recent = this.messaging.countSentSince({ projectId, channelId, senderRoleId: agent.role, since: new Date(this.hub.clock() - 60000).toISOString() });
      if (recent >= limit) fail(429, 'RATE_LIMITED', `Role ${agent.role} may send ${limit} messages a minute.`);
    }
    // A reply to a live assignment's message goes back to that assignment, not any agent holding the role.
    const target = parent?.senderAssignmentId && parent.senderRoleId === recipientRoleId ? this.store.get('assignment', parent.senderAssignmentId) : null;
    const result = this.messaging.send({ projectId, channelId, senderRoleId, recipientRoleId, body: body.body, idempotencyKey: body.idempotencyKey,
      parentId, senderKind: agent ? 'agent' : 'owner', senderAssignmentId: agent?.id ?? null,
      targetAssignmentId: active(target) ? target.id : null, unplanned });
    if (run?.projectId === projectId) this.hub.messageInteraction(run.id, result.message);
    return result;
  }

  ack({ projectId, channelId, messageId, auth, body }) {
    const roleId = auth.kind === 'agent' ? auth.assignment.role : body.roleId ?? OWNER_ROLE_ID;
    if (auth.kind === 'agent' && body.roleId !== undefined && body.roleId !== roleId) fail(403, 'FORBIDDEN', 'Agents acknowledge as their own role.');
    const result = this.messaging.ack({ projectId, channelId, messageId, roleId: nonblank(roleId, 'roleId', 200), note: body.note ?? null });
    if (result.changed) {
      this.#receiptEvent('message.acked', channelId.startsWith('run-') ? channelId.slice(4) : null, result.message,
        { ...(result.message.receipt.ackNote ? { note: result.message.receipt.ackNote } : {}), ...(auth.kind === 'agent' ? { assignmentId: auth.assignment.id } : { by: 'owner' }) });
    }
    return result;
  }

  /** `/messaging/projects/:projectId[/channels[/:channelId/(messages[/:messageId[/ack]]|unread|read-cursor)]]` */
  route(method, segments, body, query, auth) {
    const [collection, projectId, channels, channelId, resource, messageId, action] = segments;
    if (collection !== 'projects' || !projectId) fail(404, 'NOT_FOUND', 'Messaging route not found.');
    if (auth.kind === 'agent') {
      // Agents reach their own run channel and nothing else.
      const assignment = auth.assignment;
      if (channels !== 'channels' || projectId !== assignment.projectId || channelId !== runChannel(assignment.runId)) fail(403, 'FORBIDDEN', 'Agent credentials reach only their run channel.');
    }
    const roleFor = requested => {
      if (auth.kind !== 'agent') return nonblank(requested ?? undefined, 'roleId', 200);
      if (requested !== undefined && requested !== null && requested !== auth.assignment.role) fail(403, 'FORBIDDEN', 'Agents read their own role.');
      return auth.assignment.role;
    };
    if (segments.length === 2 && method === 'PUT') return this.messaging.createProject({ id: projectId, name: body.name });
    if (channels === 'channels' && segments.length === 3) {
      if (method === 'GET') return { channels: this.messaging.listChannels({ projectId }) };
      if (method === 'POST') return this.messaging.createChannel({ projectId, id: body.id, name: body.name });
    }
    if (channels !== 'channels' || !channelId) fail(404, 'NOT_FOUND', 'Messaging route not found.');
    if (resource === 'messages' && segments.length === 5) {
      if (method === 'POST') return this.send({ projectId, channelId, auth, body });
      if (method === 'GET') {
        return this.messaging.readMessages({ projectId, channelId, recipientRoleId: query.get('recipientRoleId'), threadId: query.get('threadId'),
          after: query.get('after'), before: query.get('before'), latest: query.get('latest') === 'true', limit: query.has('limit') ? Number(query.get('limit')) : 100 });
      }
    }
    if (resource === 'messages' && messageId && segments.length === 6 && method === 'GET') return this.messaging.getMessage({ projectId, channelId, messageId });
    if (resource === 'messages' && messageId && action === 'ack' && segments.length === 7 && method === 'POST') return this.ack({ projectId, channelId, messageId, auth, body });
    if (resource === 'unread' && segments.length === 5 && method === 'GET') {
      return this.messaging.unread({ projectId, channelId, roleId: roleFor(query.get('roleId')), limit: query.has('limit') ? Number(query.get('limit')) : 100 });
    }
    if (resource === 'read-cursor' && segments.length === 5 && method === 'POST') {
      return this.messaging.markRead({ projectId, channelId, roleId: roleFor(body.roleId), messageId: nonblank(body.messageId, 'messageId', 200) });
    }
    fail(404, 'NOT_FOUND', 'Messaging route not found.');
  }
}
