/**
 * Structured results some roles must return (docs/architecture/README.md, AssignmentResult):
 * reviews `verdict`, planners `items`, the workflow architect `graph` + `rationale`.
 * Agents write them as a fenced JSON block in their final message.
 */
const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;
export const MAX_PLANNED_ITEMS = 1000; // @perpeto/workflow engine limit
const MAX_ARCHITECT_TEXT = 1_000_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** @returns {'review'|'planner'|'architect'|'work'} */
export function outputKind(assignment) {
  if (assignment?.architectRequestId || assignment?.role === 'workflow-architect' || assignment?.nodeId === 'workflow-architect') return 'architect';
  if (assignment?.nodeType === 'review') return 'review';
  if (assignment?.nodeType === 'planner') return 'planner';
  return 'work';
}

/** Answer-format instructions appended to the prompt for structured roles. */
export function outputInstructions(kind) {
  if (kind === 'review') return 'End your final message with exactly one fenced json block: {"verdict": "pass" | "fail", "summary": "…"}. Use "fail" with actionable feedback in summary when the work needs changes. If you could not complete the review, say so and omit the block.';
  if (kind === 'planner') return 'End your final message with exactly one fenced json block: {"items": [{"title": "…", "body": "…"}]}. Use an empty items list when the work item is already small enough to build as one pull request.';
  return null; // The architect prompt carries its own answer format.
}

function blocks(text) {
  return typeof text === 'string' ? [...text.matchAll(FENCE)].map(match => match[1]).reverse() : [];
}
function lastBlock(text, accept) {
  for (const candidate of blocks(text)) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (accept(value)) return value;
  }
  return undefined;
}
const prose = text => text.replace(FENCE, '').trim();

/**
 * @returns {{ fields: object, summary?: string, error?: string }} `summary` overrides
 * the default summary; `error` turns a successful turn into a failure to retry.
 */
export function parseRoleResult(kind, text) {
  const body = typeof text === 'string' ? text : '';
  if (kind === 'review') {
    const block = lastBlock(body, value => isObject(value) && typeof value.verdict === 'string' && /^(pass|fail)$/i.test(value.verdict.trim()));
    const verdict = block?.verdict.trim().toLowerCase()
      ?? /\bverdict\b["'*\s]*[:=]\s*["'*]*\s*(pass|fail)\b/i.exec(body)?.[1]?.toLowerCase();
    // No verdict leaves the result without one; the engine treats that as an error to retry.
    if (!verdict) return { fields: {} };
    const feedback = [block?.summary, block?.feedback].find(value => nonblank(value, 100000));
    return { fields: { verdict }, summary: feedback?.trim() || prose(body) || `Review verdict: ${verdict}.` };
  }
  if (kind === 'planner') {
    const block = lastBlock(body, value => isObject(value) && Array.isArray(value.items));
    if (!block) return { fields: {}, error: 'The planner reply had no fenced json block with an items list.' };
    if (block.items.length > MAX_PLANNED_ITEMS) return { fields: {}, error: `The planner listed more than ${MAX_PLANNED_ITEMS} items.` };
    const items = [];
    for (const item of block.items) {
      if (!isObject(item) || !nonblank(item.title, 200) || (item.body !== undefined && (typeof item.body !== 'string' || item.body.length > 20000))) {
        return { fields: {}, error: 'Each planned item needs a title of at most 200 characters and an optional body of at most 20000 characters.' };
      }
      items.push({ title: item.title.trim(), ...(item.body?.trim() ? { body: item.body.trim() } : {}) });
    }
    return { fields: { items }, summary: prose(body) || `Planned ${items.length} work items.` };
  }
  if (kind === 'architect') {
    const block = lastBlock(body, value => isObject(value) && isObject(value.graph) && nonblank(value.rationale, 65536));
    if (block) return { fields: { graph: block.graph, rationale: block.rationale.trim() }, summary: block.rationale.trim() };
    // Let the hub's parser report what is wrong (or accept a bare graph with prose).
    return { fields: {}, summary: body.slice(0, MAX_ARCHITECT_TEXT), unclipped: true };
  }
  return { fields: {} };
}
