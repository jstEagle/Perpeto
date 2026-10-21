/**
 * Structured results some roles must return (docs/architecture/README.md, AssignmentResult):
 * reviews `verdict`, planners `items` (with optional `touches`), the workflow architect `graph` + `rationale`
 * (plus optional `templateId` and `additionalWorkflows`). Agents write them as a fenced JSON block in their
 * final message. Rebase steps report nothing structured: the executor derives their evidence from Git.
 */
const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;
export const MAX_PLANNED_ITEMS = 1000; // @perpeto/workflow engine limit
const MAX_ARCHITECT_TEXT = 1_000_000;
const MAX_TOUCHES = 100; // @perpeto/workflow engine limits for declared scopes
const MAX_TOUCH_CHARS = 4096;
const MAX_ADDITIONAL_WORKFLOWS = 3;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** @returns {'review'|'planner'|'architect'|'rebase'|'work'} */
export function outputKind(assignment) {
  if (assignment?.architectRequestId || assignment?.role === 'workflow-architect' || assignment?.nodeId === 'workflow-architect') return 'architect';
  if (assignment?.step === 'rebase') return 'rebase';
  if (assignment?.nodeType === 'review') return 'review';
  if (assignment?.nodeType === 'planner') return 'planner';
  return 'work';
}

/** Answer-format instructions appended to the prompt for structured roles. */
export function outputInstructions(kind) {
  if (kind === 'review') return 'End your final message with exactly one fenced json block: {"verdict": "pass" | "fail", "summary": "…"}. Use "fail" with actionable feedback in summary when the work needs changes. If you could not complete the review, say so and omit the block.';
  if (kind === 'planner') return 'End your final message with exactly one fenced json block: {"items": [{"title": "…", "body": "…", "touches": ["src/module", "package.json"]}], "summary": "…"}. ' +
    'touches lists the repository-relative files or module directories each item will edit (at most 100, no absolute paths or ".."); overlapping items are built one after another. ' +
    'Use an empty items list when the work item is already small enough to build as one pull request, and put its contract and acceptance criteria in summary.';
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
 * Normalise declared touches to the engine's form: distinct repository-relative paths without `.` segments,
 * empty parts or glob syntax. A glob widens to the directory it starts in (`src/lib/*.js` -> `src/lib`, `*.md` -> `.`),
 * so a declared scope never shrinks. Returns `undefined` for no declaration, or `{ error }`.
 */
export function normalizeTouches(touches) {
  if (touches === undefined || touches === null) return undefined;
  const invalid = { error: `touches must be a list of at most ${MAX_TOUCHES} repository-relative file or directory paths, without absolute paths, backslashes or "..".` };
  if (!Array.isArray(touches)) return invalid;
  const scopes = new Set();
  for (const path of touches) {
    if (!nonblank(path, MAX_TOUCH_CHARS)) return invalid;
    const value = path.trim();
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return invalid;
    const parts = value.split('/').filter(part => part && part !== '.');
    if (parts.includes('..')) return invalid;
    const glob = parts.findIndex(part => /[*?[\]]/.test(part));
    scopes.add((glob === -1 ? parts : parts.slice(0, glob)).join('/') || '.');
  }
  if (scopes.size > MAX_TOUCHES) return invalid;
  return scopes.size ? [...scopes] : undefined;
}

/** Optional architect fields, validated in shape only; the hub's parser checks template ids and graphs. */
function architectExtras(block) {
  const extras = {};
  if (block.templateId !== undefined) {
    if (!nonblank(block.templateId, 200)) return null;
    extras.templateId = block.templateId.trim();
  }
  if (block.additionalWorkflows !== undefined) {
    const list = block.additionalWorkflows;
    if (!Array.isArray(list) || list.length > MAX_ADDITIONAL_WORKFLOWS) return null;
    const workflows = [];
    for (const proposal of list) {
      if (!isObject(proposal) || !nonblank(proposal.name, 200) || !isObject(proposal.graph) || !nonblank(proposal.rationale, 65536)) return null;
      if (proposal.templateId !== undefined && !nonblank(proposal.templateId, 200)) return null;
      workflows.push({ name: proposal.name.trim(), rationale: proposal.rationale.trim(), graph: proposal.graph, ...(proposal.templateId !== undefined ? { templateId: proposal.templateId.trim() } : {}) });
    }
    extras.additionalWorkflows = workflows;
  }
  return extras;
}

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
      const touches = normalizeTouches(item.touches);
      if (touches?.error) return { fields: {}, error: `Planned item "${item.title.trim().slice(0, 80)}": ${touches.error}` };
      items.push({ title: item.title.trim(), ...(item.body?.trim() ? { body: item.body.trim() } : {}), ...(touches ? { touches } : {}) });
    }
    // The summary reaches later roles as the item's plan, so prefer the block's over narration.
    const summary = nonblank(block.summary, 20000) ? block.summary.trim() : prose(body);
    return { fields: { items }, summary: summary || `Planned ${items.length} work items.` };
  }
  if (kind === 'architect') {
    const block = lastBlock(body, value => isObject(value) && isObject(value.graph) && nonblank(value.rationale, 65536));
    const extras = block && architectExtras(block);
    if (extras) return { fields: { graph: block.graph, rationale: block.rationale.trim(), ...extras }, summary: block.rationale.trim() };
    // Let the hub's parser report what is wrong (or accept a bare graph with prose).
    return { fields: {}, summary: body.slice(0, MAX_ARCHITECT_TEXT), unclipped: true };
  }
  return { fields: {} };
}
