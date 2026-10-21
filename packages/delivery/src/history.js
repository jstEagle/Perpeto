import { isDeepStrictEqual } from 'node:util';

/** Compact inverse edits: recover an earlier snapshot from the current state. */
export function inverseEdits(before, after, path = [], edits = []) {
  if (isDeepStrictEqual(before, after)) return edits;
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) edits.push({ path: [...path, key], value: before[key] });
      else inverseEdits(before[key], after[key], [...path, key], edits);
    }
    if (Array.isArray(before)) {
      if (before.length !== after.length) edits.push({ path: [...path, 'length'], value: before.length });
    } else {
      for (const key of Object.keys(after)) if (!Object.hasOwn(before, key)) edits.push({ path: [...path, key] });
    }
  } else edits.push({ path, value: before });
  return edits;
}

export function undoEdits(state, edits) {
  for (const edit of edits) {
    const parent = edit.path.slice(0, -1).reduce((value, key) => value[key], state);
    const key = edit.path.at(-1);
    if (Object.hasOwn(edit, 'value')) Object.defineProperty(parent, key, { value: structuredClone(edit.value),
      ...(key === 'length' && Array.isArray(parent) ? {} : { configurable: true, enumerable: true, writable: true }) });
    else delete parent[key];
  }
  return state;
}
