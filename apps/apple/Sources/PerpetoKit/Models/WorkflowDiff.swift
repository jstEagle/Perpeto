import Foundation

/// Graph difference between two workflow versions, for reviewing an
/// architect's draft against the active version.
///
/// `GET /workflows/:id/diff` exists in the contract but its body is not yet
/// specified, so the client computes the same comparison locally from
/// `GET /workflows/:id/versions`.
public struct WorkflowDiff: Hashable, Sendable {
    public enum Change: String, Hashable, Sendable {
        case added, removed, changed, unchanged
    }

    public var fromVersion: Int?
    public var toVersion: Int
    public var nodes: [String: Change]
    public var edges: [String: Change]
    /// Removed nodes and edges, kept so the diff view can draw them as ghosts.
    public var removedNodes: [GraphNode]
    public var removedEdges: [GraphEdge]

    public init(from base: Workflow?, to proposed: Workflow) {
        fromVersion = base?.version
        toVersion = proposed.version
        let old = Dictionary((base?.graph.nodes ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let new = Dictionary(proposed.graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var nodes: [String: Change] = [:]
        for (id, node) in new {
            if let previous = old[id] {
                // Moving a node is layout, not a behavioral change.
                nodes[id] = (previous.type == node.type && previous.label == node.label && previous.config == node.config) ? .unchanged : .changed
            } else {
                nodes[id] = .added
            }
        }
        removedNodes = old.values.filter { new[$0.id] == nil }.sorted { $0.id < $1.id }
        for node in removedNodes { nodes[node.id] = .removed }
        self.nodes = nodes

        func signature(_ e: GraphEdge) -> String {
            "\(e.kind.rawValue):\(e.from.node).\(e.from.port ?? "out")>\(e.to.node).\(e.to.port ?? "in")"
        }
        let oldEdges = Set((base?.graph.edges ?? []).map(signature))
        let newEdges = Set(proposed.graph.edges.map(signature))
        var edges: [String: Change] = [:]
        for edge in proposed.graph.edges { edges[edge.id] = oldEdges.contains(signature(edge)) ? .unchanged : .added }
        removedEdges = (base?.graph.edges ?? []).filter { !newEdges.contains(signature($0)) }
        for edge in removedEdges { edges["removed:" + edge.id] = .removed }
        self.edges = edges
    }

    public func count(_ change: Change) -> Int {
        nodes.values.filter { $0 == change }.count
    }

    public func edgeCount(_ change: Change) -> Int {
        edges.values.filter { $0 == change }.count
    }

    public var isEmpty: Bool {
        !nodes.values.contains { $0 != .unchanged } && !edges.values.contains { $0 != .unchanged }
    }
}
