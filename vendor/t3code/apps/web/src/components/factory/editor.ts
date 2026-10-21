import type { Definition, Factory, FactoryNode, FactoryEdge, HarnessKind } from "../../../../../../../packages/factory-definition/src/storage";
import editorConfig from "./editor.config.json";
export type { Definition, Factory, FactoryNode, FactoryEdge, HarnessKind };
export { editorConfig };
export const harnesses: ReadonlyArray<{ id: HarnessKind; label: string }> = [
  { id: "codex", label: "Codex" }, { id: "claudeAgent", label: "Claude Code" },
  { id: "cursor", label: "Cursor" }, { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" }, { id: "antigravity", label: "Antigravity" },
  { id: "pi", label: "Pi" }, { id: "muse", label: "Muse" }, { id: "acpRegistry", label: "ACP registry" },
];
export const edgeLabels = { "delegates-to": "Delegation", workflow: "Workflow", context: "Context" };
export const nodeLabels = { agent: "Agent", context: "Context", check: "Check", "merge-queue": "Merge queue" };
export function createFactoryNode(type: FactoryNode["type"], id: string, index: number): FactoryNode {
  const base = { id, label: nodeLabels[type], position: { x: 48 + (index % 3) * 288, y: 48 + Math.floor(index / 3) * 168 } };
  switch (type) {
    case "agent": return { ...base, type, ...editorConfig.defaultAgent, harness: editorConfig.defaultAgent.harness as HarnessKind };
    case "context": return { ...base, type, references: [...editorConfig.defaultContext] };
    case "check": return { ...base, type, command: [...editorConfig.defaultCheck] };
    case "merge-queue": return { ...base, type, requireChecks: true, requireReview: true, maxConcurrent: 1 };
  }
}
export function removeFactoryNode(definition: Definition, id: string): Definition {
  return { ...definition, nodes: definition.nodes.filter((node) => node.id !== id), edges: definition.edges.filter((edge) => edge.source !== id && edge.target !== id) };
}
export function connectionError(definition: Definition, source: string, target: string, type: FactoryEdge["type"]): string | null {
  const from = definition.nodes.find((node) => node.id === source);
  const to = definition.nodes.find((node) => node.id === target);
  if (!from || !to) return "Choose two existing nodes.";
  if (source === target) return "Connect different nodes.";
  if (definition.edges.some((edge) => edge.source === source && edge.target === target && edge.type === type)) return "This connection already exists.";
  if (type === "context" && (from.type !== "context" || to.type === "context")) return "Context connections start at context and end at another node type.";
  if (type === "delegates-to") {
    if (from.type !== "agent" || to.type !== "agent") return "Delegation connects two agents.";
    const pending = [target]; const visited = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === source) return "Delegation cannot form a cycle.";
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(...definition.edges.filter((edge) => edge.type === type && edge.source === next).map((edge) => edge.target));
    }
  }
  return null;
}
export function factoryPayload(definition: Definition): Definition {
  return { name: definition.name, nodes: definition.nodes, edges: definition.edges };
}
