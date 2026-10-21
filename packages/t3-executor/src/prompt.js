const MAX_PROMPT_CHARS = 200_000;

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = value => Array.isArray(value) ? value : [];

/** Project and work-item context an assignment may carry (fields are optional). */
export function assignmentContext(assignment) {
  const context = assignment?.context && typeof assignment.context === 'object' ? assignment.context : {};
  return {
    project: context.project ?? assignment?.project ?? null,
    workItem: context.workItem ?? assignment?.workItem ?? null,
    repo: assignment?.repo ?? context.repo ?? context.project?.repo ?? assignment?.project?.repo ?? null,
    notes: text(context.notes),
  };
}

function docLine(doc) {
  const title = text(doc?.title) ?? text(doc?.id) ?? 'Document';
  const where = text(doc?.path) ?? text(doc?.url);
  const kind = text(doc?.kind);
  return `- ${title}${kind ? ` (${kind})` : ''}${where ? `: ${where}` : ''}`;
}

/** How a work role's branch reaches the merge queue: a forge pull request, or a published `local:<branch>`. */
const FINISH = {
  forge: 'When you finish, reply with a short summary of what you did, the branch you used and any pull request URL.',
  local: 'This repository has no forge, so there is no pull request to open or register: the factory publishes your branch and the merge queue takes it from there. ' +
    'When you finish, reply with a short summary of what you did and the branch you used.',
};

/**
 * The prompt sent as the thread's first message: the assignment prompt first,
 * then the factory context the agent needs to act without the hub. Only work roles
 * get the closing summary request; structured roles answer in their own format.
 * @param {object} assignment
 * @param {{ extra?: string[], kind?: 'work'|'review'|'planner'|'architect', delivery?: 'forge'|'local' }} [options]
 */
export function buildPrompt(assignment, { extra = [], kind = 'work', delivery = 'forge' } = {}) {
  const prompt = text(assignment?.prompt);
  if (!prompt) throw new TypeError('Assignment prompt is required.');
  const { project, workItem, notes } = assignmentContext(assignment);
  const policy = assignment.policy ?? {};
  const lines = [];
  if (text(assignment.role)) lines.push(`Role: ${assignment.role.trim()}`);
  if (project) {
    if (text(project.name)) lines.push(`Project: ${project.name.trim()}`);
    const goals = list(project.goals).map(text).filter(Boolean);
    if (goals.length) lines.push('Project goals:', ...goals.map(goal => `- ${goal}`));
    const docs = list(project.docs);
    if (docs.length) lines.push('Project documents (read the ones relevant to this task):', ...docs.map(docLine));
  }
  if (workItem && (text(workItem.title) || text(workItem.body))) {
    lines.push(`Work item: ${text(workItem.title) ?? workItem.id ?? ''}`.trimEnd());
    if (text(workItem.body)) lines.push(workItem.body.trim());
  }
  if (notes) lines.push(notes);
  if (Number.isSafeInteger(policy.maxSubagents)) {
    const providers = list(policy.allowedSubagentProviders).filter(item => typeof item === 'string');
    lines.push(policy.maxSubagents > 0 && providers.length
      ? `Subagents: you may create at most ${policy.maxSubagents}, using only these providers: ${providers.join(', ')}.`
      : 'Subagents: do not create subagents or delegate tasks; requests to do so are refused.');
  }
  for (const line of extra) if (text(line)) lines.push(line.trim());
  if (kind === 'work') lines.push(FINISH[delivery] ?? FINISH.forge);
  const full = `${prompt}\n\n---\nFactory context\n${lines.join('\n')}`;
  return full.length > MAX_PROMPT_CHARS ? full.slice(0, MAX_PROMPT_CHARS) : full;
}
