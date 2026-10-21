import Foundation

// Workflow graph v1 from docs/architecture/README.md.

public struct WorkflowGraph: Codable, Hashable, Sendable {
    public static let schemaV1 = "perpeto.workflow/1"

    public var schema: String
    public var nodes: [GraphNode]
    public var edges: [GraphEdge]

    public init(schema: String = WorkflowGraph.schemaV1, nodes: [GraphNode], edges: [GraphEdge]) {
        self.schema = schema
        self.nodes = nodes
        self.edges = edges
    }

    public func node(_ id: String) -> GraphNode? { nodes.first { $0.id == id } }
}

public enum NodeType: String, LenientEnum {
    case input, planner, agent, review, ci
    case mergeQueue = "merge-queue"
    case loop, human, output
    case unknown
    public static var unknownCase: Self { .unknown }

    public var title: String {
        switch self {
        case .input: "Input"
        case .planner: "Planner"
        case .agent: "Agent"
        case .review: "Review"
        case .ci: "CI"
        case .mergeQueue: "Merge queue"
        case .loop: "Loop"
        case .human: "Human"
        case .output: "Output"
        case .unknown: "Unknown"
        }
    }

    /// Agent roles that run through a harness and can delegate or message.
    public var isAgentRole: Bool { self == .planner || self == .agent || self == .review }

    /// Gates have `pass` and `fail` output ports.
    public var isGate: Bool { self == .review || self == .ci || self == .human }

    /// Gates and the merge queue route work by `pass` and `fail`.
    public var hasPassFail: Bool { isGate || self == .mergeQueue }

    public var acceptsFlowInput: Bool { self != .input }

    public var outputPorts: [GraphPort] {
        switch self {
        case .output, .unknown: []
        case _ where hasPassFail: [.pass, .fail]
        default: [.out]
        }
    }

    public static var palette: [NodeType] { [.input, .planner, .agent, .review, .ci, .mergeQueue, .loop, .human, .output] }
}

/// Typed ports. `out`/`pass`/`fail` emit work items on `flow` edges;
/// `role` is the attachment point for `delegates` and `messages` edges.
public enum GraphPort: String, Codable, Hashable, Sendable {
    case `in`, out, pass, fail, role
}

public struct GraphNode: Codable, Hashable, Identifiable, Sendable {
    public struct Position: Codable, Hashable, Sendable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public var id: String
    public var type: NodeType
    public var label: String
    public var position: Position
    public var config: JSONValue

    public init(id: String, type: NodeType, label: String, position: Position, config: JSONValue = [:]) {
        self.id = id
        self.type = type
        self.label = label
        self.position = position
        self.config = config
    }

    public var harness: Harness? {
        guard let provider = config["harness"]?["provider"]?.stringValue,
              let model = config["harness"]?["model"]?.stringValue else { return nil }
        return Harness(provider: provider, model: model)
    }

    public var concurrency: Int? { config["concurrency"]?.intValue }
}

public struct GraphEdge: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, LenientEnum {
        case flow, delegates, messages, unknown
        public static var unknownCase: Self { .unknown }
    }

    public struct Endpoint: Codable, Hashable, Sendable {
        public var node: String
        public var port: String?
        public init(node: String, port: String? = nil) {
            self.node = node
            self.port = port
        }
    }

    public var id: String
    public var from: Endpoint
    public var to: Endpoint
    public var kind: Kind

    public init(id: String, from: Endpoint, to: Endpoint, kind: Kind) {
        self.id = id
        self.from = from
        self.to = to
        self.kind = kind
    }
}

// MARK: - Validation

public struct ValidationIssue: Codable, Hashable, Sendable, Identifiable {
    public enum Severity: String, LenientEnum {
        case error, warning, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var code: String
    public var message: String
    public var severity: Severity
    public var nodeId: String?
    public var edgeId: String?

    public var id: String { [code, nodeId ?? "", edgeId ?? "", message].joined(separator: "|") }

    public init(code: String, message: String, severity: Severity, nodeId: String? = nil, edgeId: String? = nil) {
        self.code = code
        self.message = message
        self.severity = severity
        self.nodeId = nodeId
        self.edgeId = edgeId
    }

    enum CodingKeys: String, CodingKey { case code, message, severity, nodeId, edgeId }

    /// The hub lists errors and warnings separately and omits `severity`;
    /// `ValidationResult` fills it in from the list an issue came from.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decodeIfPresent(String.self, forKey: .code) ?? "INVALID"
        message = try c.decode(String.self, forKey: .message)
        severity = try c.decodeIfPresent(Severity.self, forKey: .severity) ?? .error
        nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
        edgeId = try c.decodeIfPresent(String.self, forKey: .edgeId)
    }
}

/// Result of `POST /workflows/:id/validate`: `{ valid, errors, warnings }`.
/// This is a 200 even when the graph is invalid.
public struct ValidationResult: Codable, Hashable, Sendable {
    public var valid: Bool
    public var issues: [ValidationIssue]

    public init(valid: Bool, issues: [ValidationIssue]) {
        self.valid = valid
        self.issues = issues
    }

    enum CodingKeys: String, CodingKey { case valid, errors, warnings }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let errors = (try c.decodeIfPresent([ValidationIssue].self, forKey: .errors) ?? []).map { issue in
            var issue = issue
            issue.severity = .error
            return issue
        }
        let warnings = (try c.decodeIfPresent([ValidationIssue].self, forKey: .warnings) ?? []).map { issue in
            var issue = issue
            issue.severity = .warning
            return issue
        }
        issues = errors + warnings
        valid = try c.decodeIfPresent(Bool.self, forKey: .valid) ?? errors.isEmpty
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(valid, forKey: .valid)
        try c.encode(issues.filter { $0.severity == .error }, forKey: .errors)
        try c.encode(issues.filter { $0.severity != .error }, forKey: .warnings)
    }

    public var errorCount: Int { issues.filter { $0.severity == .error }.count }
    public var warningCount: Int { issues.filter { $0.severity == .warning }.count }
}

/// Client-side structural checks so the editor can explain problems while
/// drawing. The hub's workflow package remains the authority on save.
public enum WorkflowValidator {
    public static func validate(_ graph: WorkflowGraph) -> ValidationResult {
        var issues: [ValidationIssue] = []
        let nodesById = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        if graph.schema != WorkflowGraph.schemaV1 {
            issues.append(.init(code: "SCHEMA", message: "Graph schema must be \(WorkflowGraph.schemaV1).", severity: .error))
        }
        if !graph.nodes.contains(where: { $0.type == .input }) {
            issues.append(.init(code: "NO_INPUT", message: "Add an input node so work has a source.", severity: .error))
        }
        if !graph.nodes.contains(where: { $0.type == .output }) {
            issues.append(.init(code: "NO_OUTPUT", message: "Add an output node so finished work has an end.", severity: .error))
        }
        if Set(graph.nodes.map(\.id)).count != graph.nodes.count {
            issues.append(.init(code: "DUPLICATE_NODE", message: "Node IDs must be unique.", severity: .error))
        }

        for edge in graph.edges {
            guard let from = nodesById[edge.from.node], let to = nodesById[edge.to.node] else {
                issues.append(.init(code: "DANGLING_EDGE", message: "Edge connects a node that does not exist.", severity: .error, edgeId: edge.id))
                continue
            }
            switch edge.kind {
            case .flow:
                let port = edge.from.port.flatMap(GraphPort.init(rawValue:)) ?? (from.type == .mergeQueue ? .pass : .out)
                if !from.type.outputPorts.contains(port) {
                    let expected = from.type.outputPorts.map(\.rawValue).joined(separator: " or ")
                    issues.append(.init(
                        code: "BAD_PORT",
                        message: from.type.outputPorts.isEmpty
                            ? "\(from.label) is terminal and cannot send work."
                            : "\(from.label) sends work from \(expected), not \(port.rawValue).",
                        severity: .error, nodeId: from.id, edgeId: edge.id))
                }
                if !to.type.acceptsFlowInput {
                    issues.append(.init(code: "INPUT_HAS_INBOUND", message: "\(to.label) is a source and cannot receive work.", severity: .error, nodeId: to.id, edgeId: edge.id))
                }
            case .delegates, .messages:
                if !from.type.isAgentRole || !to.type.isAgentRole {
                    let verb = edge.kind == .delegates ? "Delegation" : "Messaging"
                    issues.append(.init(code: "ROLE_EDGE", message: "\(verb) connects agent roles only (planner, agent, review).", severity: .error, edgeId: edge.id))
                }
                if edge.kind == .delegates, from.id == to.id {
                    issues.append(.init(code: "SELF_DELEGATION", message: "\(from.label) cannot delegate to itself.", severity: .error, nodeId: from.id, edgeId: edge.id))
                }
            case .unknown:
                issues.append(.init(code: "EDGE_KIND", message: "Edge kind is not one of flow, delegates or messages.", severity: .error, edgeId: edge.id))
            }
        }

        // Mirrors packages/workflow: agents reached only by delegation need no
        // flow, a merge queue's fail port is optional, and a human gate that is
        // an escalation target may leave fail unwired (fail ends the item).
        let delegateOnly = Set(graph.nodes.filter { node in
            graph.edges.contains { $0.kind == .delegates && $0.to.node == node.id }
                && !graph.edges.contains { $0.kind == .flow && ($0.to.node == node.id || $0.from.node == node.id) }
        }.map(\.id))
        let escalationTargets = Set(graph.nodes.flatMap { node in
            ["onExhausted", "onBlocked"].compactMap { node.config[$0]?.stringValue }
        })
        for node in graph.nodes where !delegateOnly.contains(node.id) {
            let outgoing = graph.edges.filter { $0.kind == .flow && $0.from.node == node.id }
            for port in node.type.outputPorts where !outgoing.contains(where: { ($0.from.port ?? (node.type == .mergeQueue ? "pass" : "out")) == port.rawValue }) {
                if port == .fail, node.type == .mergeQueue || (node.type == .human && escalationTargets.contains(node.id)) { continue }
                issues.append(.init(code: "UNCONNECTED_PORT", message: "\(node.label) has no edge from its \(port.rawValue) port.", severity: port == .fail ? .warning : .error, nodeId: node.id))
            }
            for key in Self.missingConfig(node) {
                issues.append(.init(code: "MISSING_CONFIG", message: "\(node.label) needs \(Self.configTitle[key] ?? key).", severity: .error, nodeId: node.id))
            }
            if node.type.isAgentRole, node.harness == nil {
                issues.append(.init(code: "NO_HARNESS", message: "\(node.label) needs a harness provider and model.", severity: .error, nodeId: node.id))
            }
            if node.type == .agent, let c = node.concurrency, c < 1 {
                issues.append(.init(code: "CONCURRENCY", message: "\(node.label) concurrency must be at least 1.", severity: .error, nodeId: node.id))
            }
            if node.type == .loop, (node.config["maxIterations"]?.intValue ?? 0) < 1 {
                issues.append(.init(code: "LOOP_LIMIT", message: "\(node.label) needs maxIterations of at least 1.", severity: .error, nodeId: node.id))
            }
            if node.type == .ci, (node.config["steps"]?.arrayValue ?? []).isEmpty {
                issues.append(.init(code: "CI_STEPS", message: "\(node.label) has no steps to run.", severity: .error, nodeId: node.id))
            }
        }

        issues.append(contentsOf: unreachable(graph))
        issues.append(contentsOf: cyclesWithoutLoop(graph))
        return ValidationResult(valid: !issues.contains { $0.severity == .error }, issues: issues)
    }

    /// Required config from packages/workflow `NODE_CONFIG`. Harness, loop
    /// limits and CI steps have their own, more specific checks.
    static func missingConfig(_ node: GraphNode) -> [String] {
        let c = node.config
        func text(_ key: String) -> Bool { !(c[key]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        func oneOf(_ key: String, _ options: [String]) -> Bool { c[key]?.stringValue.map(options.contains) ?? false }
        switch node.type {
        case .input: return oneOf("source", ["manual", "goals", "issues"]) ? [] : ["source"]
        case .planner, .agent, .review, .human: return text("prompt") ? [] : ["prompt"]
        case .mergeQueue:
            return (oneOf("strategy", ["serial", "batch"]) ? [] : ["strategy"]) + (oneOf("method", ["squash", "merge", "rebase"]) ? [] : ["method"])
        case .loop: return oneOf("until", ["review-pass", "ci-pass", "manual"]) ? [] : ["until"]
        case .ci, .output, .unknown: return []
        }
    }

    static let configTitle = ["source": "a work source", "prompt": "a prompt", "strategy": "a merge strategy", "method": "a merge method", "until": "a repeat condition"]

    static func unreachable(_ graph: WorkflowGraph) -> [ValidationIssue] {
        var seen = Set(graph.nodes.filter { $0.type == .input }.map(\.id))
        var frontier = Array(seen)
        while let id = frontier.popLast() {
            // Flow, delegation and escalation links (onExhausted, onBlocked) all reach a node.
            var next = graph.edges.filter { ($0.kind == .flow || $0.kind == .delegates) && $0.from.node == id }.map(\.to.node)
            if let node = graph.node(id) { next += ["onExhausted", "onBlocked"].compactMap { node.config[$0]?.stringValue } }
            for target in next where !seen.contains(target) {
                seen.insert(target)
                frontier.append(target)
            }
        }
        return graph.nodes.filter { !seen.contains($0.id) && $0.type != .input }.map {
            .init(code: "UNREACHABLE", message: "\($0.label) is not reachable from an input.", severity: .warning, nodeId: $0.id)
        }
    }

    /// A flow cycle must pass through a loop node, which bounds iterations.
    static func cyclesWithoutLoop(_ graph: WorkflowGraph) -> [ValidationIssue] {
        let loopIds = Set(graph.nodes.filter { $0.type == .loop }.map(\.id))
        let flow = graph.edges.filter { $0.kind == .flow && !loopIds.contains($0.from.node) && !loopIds.contains($0.to.node) }
        var adjacency: [String: [String]] = [:]
        for edge in flow { adjacency[edge.from.node, default: []].append(edge.to.node) }
        var state: [String: Int] = [:]  // 1 visiting, 2 done
        var offending = Set<String>()
        func visit(_ id: String) {
            state[id] = 1
            for next in adjacency[id] ?? [] {
                if state[next] == 1 { offending.insert(next) }
                else if state[next] == nil { visit(next) }
            }
            state[id] = 2
        }
        for node in graph.nodes where state[node.id] == nil { visit(node.id) }
        return offending.sorted().map {
            .init(code: "UNBOUNDED_CYCLE", message: "Work can cycle through \(graph.node($0)?.label ?? $0) without a loop limit.", severity: .error, nodeId: $0)
        }
    }
}
