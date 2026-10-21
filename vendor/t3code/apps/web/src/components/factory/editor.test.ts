import { describe, expect, it } from "vite-plus/test";
import { connectionError, createFactoryNode, factoryPayload, removeFactoryNode, type Definition, type Factory } from "./editor";
const definition = (): Definition => ({ name: "Delivery", nodes: [createFactoryNode("agent", "lead", 0), createFactoryNode("agent", "worker", 1), createFactoryNode("context", "docs", 2)], edges: [] });
describe("factory graph authoring", () => {
  it("creates the four supported typed nodes with serializable defaults", () => {
    for (const type of ["agent", "context", "check", "merge-queue"] as const) expect(createFactoryNode(type, type, 0).type).toBe(type);
    expect(createFactoryNode("merge-queue", "merge", 0)).toMatchObject({ requireChecks: true, requireReview: true, maxConcurrent: 1 });
  });
  it("rejects delegation cycles and invalid context/delegation endpoints", () => {
    const graph = definition(); graph.edges.push({ id: "edge", type: "delegates-to", source: "lead", target: "worker" });
    expect(connectionError(graph, "worker", "lead", "delegates-to")).toContain("cycle");
    expect(connectionError(graph, "lead", "docs", "context")).toContain("Context");
    expect(connectionError(graph, "docs", "worker", "delegates-to")).toContain("agents");
    expect(connectionError(graph, "docs", "worker", "context")).toBeNull();
    expect(connectionError(graph, "worker", "lead", "workflow")).toBeNull();
  });
  it("removes incident edges with a node without mutating the original draft", () => {
    const graph = definition(); graph.edges.push({ id: "edge", type: "workflow", source: "lead", target: "worker" });
    const result = removeFactoryNode(graph, "lead");
    expect(result.nodes).toHaveLength(2); expect(result.edges).toHaveLength(0); expect(graph.nodes).toHaveLength(3); expect(graph.edges).toHaveLength(1);
  });
  it("strips server metadata before CAS updates without stripping graph configuration", () => {
    const graph = definition(); const saved = { ...graph, id: "factory", projectId: "project", version: 7, createdAt: "now", updatedAt: "now" } satisfies Factory;
    expect(factoryPayload(saved)).toEqual(graph); expect(Object.keys(factoryPayload(saved))).toEqual(["name", "nodes", "edges"]);
  });
});
