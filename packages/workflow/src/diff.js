import { canonicalJson, isPlainObject } from './util.js';

const index = list => new Map((Array.isArray(list) ? list : [])
  .filter(item => isPlainObject(item) && typeof item.id === 'string').map(item => [item.id, item]));

/** Leaf-level differences between two values. Arrays and positions compare as whole values. */
function changes(before, after, path, out) {
  if (canonicalJson(before) === canonicalJson(after)) return out;
  if (isPlainObject(before) && isPlainObject(after) && path !== 'position') {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      changes(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push({ path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  return out;
}

function compare(before, after, describe) {
  const added = [], removed = [], changed = [];
  for (const [id, item] of after) if (!before.has(id)) added.push(item);
  for (const [id, item] of before) if (!after.has(id)) removed.push(item);
  for (const [id, item] of after) {
    if (!before.has(id)) continue;
    const list = changes(before.get(id), item, '', []);
    if (list.length) changed.push({ ...describe(item), changes: list, layoutOnly: list.every(change => change.path === 'position') });
  }
  return { added, removed, changed };
}

/**
 * Describe how graph `b` differs from graph `a`, matching nodes and edges by id. `a` may be null when there is
 * no active version. Config changes are listed per leaf path, for example `config.harness.model`.
 * @returns {{ identical: boolean, schemaChanged: boolean, nodes: Section, edges: Section,
 *   summary: { nodesAdded: number, nodesRemoved: number, nodesChanged: number, edgesAdded: number, edgesRemoved: number, edgesChanged: number } }}
 */
export function diffGraphs(a, b) {
  const nodes = compare(index(a?.nodes), index(b?.nodes), node => ({ id: node.id, type: node.type, label: node.label }));
  const edges = compare(index(a?.edges), index(b?.edges), edge => ({ id: edge.id, kind: edge.kind }));
  const schemaChanged = (a?.schema ?? null) !== (b?.schema ?? null);
  const summary = {
    nodesAdded: nodes.added.length, nodesRemoved: nodes.removed.length, nodesChanged: nodes.changed.length,
    edgesAdded: edges.added.length, edgesRemoved: edges.removed.length, edgesChanged: edges.changed.length,
  };
  return { identical: !schemaChanged && Object.values(summary).every(count => count === 0), schemaChanged, nodes, edges, summary };
}
