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

/**
 * The prompt sent as the thread's first message: the assignment prompt first,
 * then the factory context the agent needs to act without the hub.
 */
export function buildPrompt(assignment) {
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
  lines.push('When you finish, reply with a short summary of what you changed, the branch you used and any pull request URL.');
  const full = `${prompt}\n\n---\nFactory context\n${lines.join('\n')}`;
  return full.length > MAX_PROMPT_CHARS ? full.slice(0, MAX_PROMPT_CHARS) : full;
}
