import Foundation

// "Observing runs" metrics from docs/architecture.md, returned by
// GET /runs/:id/metrics and GET /projects/:id/metrics.

public struct Percentiles: Codable, Hashable, Sendable {
    public var avg: Double
    public var p90: Double
    public init(avg: Double, p90: Double) {
        self.avg = avg
        self.p90 = p90
    }
}

public struct NodeMetrics: Codable, Hashable, Identifiable, Sendable {
    public var nodeId: String
    public var queued: Int
    public var active: Int
    public var done: Int
    public var failed: Int
    public var concurrency: Int
    /// active ÷ concurrency
    public var utilization: Double
    public var waitSec: Percentiles
    public var serviceSec: Percentiles
    public var throughputPerHour: Double
    public var failureRate: Double
    public var tokens: Int

    public var id: String { nodeId }

    public init(
        nodeId: String, queued: Int, active: Int, done: Int, failed: Int, concurrency: Int, utilization: Double,
        waitSec: Percentiles, serviceSec: Percentiles, throughputPerHour: Double, failureRate: Double, tokens: Int
    ) {
        self.nodeId = nodeId
        self.queued = queued
        self.active = active
        self.done = done
        self.failed = failed
        self.concurrency = concurrency
        self.utilization = utilization
        self.waitSec = waitSec
        self.serviceSec = serviceSec
        self.throughputPerHour = throughputPerHour
        self.failureRate = failureRate
        self.tokens = tokens
    }
}

public struct EdgeMetrics: Codable, Hashable, Identifiable, Sendable {
    public var edgeId: String
    public var kind: GraphEdge.Kind
    public var count: Int
    public var unplanned: Bool

    public var id: String { edgeId }

    public init(edgeId: String, kind: GraphEdge.Kind, count: Int, unplanned: Bool) {
        self.edgeId = edgeId
        self.kind = kind
        self.count = count
        self.unplanned = unplanned
    }
}

public struct RunMetrics: Codable, Hashable, Sendable {
    public struct Velocity: Codable, Hashable, Sendable {
        public var itemsDonePerDay: Double
        public var trend: [Double]
        public init(itemsDonePerDay: Double, trend: [Double]) {
            self.itemsDonePerDay = itemsDonePerDay
            self.trend = trend
        }
    }

    public struct MachineLoad: Codable, Hashable, Identifiable, Sendable {
        public var machineId: String
        public var activeAgents: Int
        public var nodes: [String]
        public var id: String { machineId }
        public init(machineId: String, activeAgents: Int, nodes: [String]) {
            self.machineId = machineId
            self.activeAgents = activeAgents
            self.nodes = nodes
        }
    }

    public var velocity: Velocity
    public var cycleTimeSec: Percentiles
    public var wip: Int
    public var tokensPerItem: Double
    public var activeAgents: Int
    public var machines: [MachineLoad]

    public init(velocity: Velocity, cycleTimeSec: Percentiles, wip: Int, tokensPerItem: Double, activeAgents: Int, machines: [MachineLoad]) {
        self.velocity = velocity
        self.cycleTimeSec = cycleTimeSec
        self.wip = wip
        self.tokensPerItem = tokensPerItem
        self.activeAgents = activeAgents
        self.machines = machines
    }
}

public struct Bottleneck: Codable, Hashable, Identifiable, Sendable {
    public enum Reason: String, LenientEnum {
        case saturated
        case queueGrowing = "queue-growing"
        case highFailure = "high-failure"
        case waitingOnHuman = "waiting-on-human"
        case noCapacity = "no-capacity"
        case reworkLoop = "rework-loop"
        case unknown
        public static var unknownCase: Self { .unknown }

        public var title: String {
            switch self {
            case .saturated: "Saturated"
            case .queueGrowing: "Queue growing"
            case .highFailure: "High failure rate"
            case .waitingOnHuman: "Waiting on a person"
            case .noCapacity: "No machine can run this"
            case .reworkLoop: "Rework loop"
            case .unknown: "Bottleneck"
            }
        }
    }

    public enum Severity: String, LenientEnum {
        case info, warning, critical, unknown
        public static var unknownCase: Self { .unknown }

        var rank: Int {
            switch self {
            case .critical: 3
            case .warning: 2
            case .info: 1
            case .unknown: 0
            }
        }
    }

    public var nodeId: String
    public var reason: Reason
    /// The measured numbers behind the finding.
    public var evidence: String
    public var severity: Severity

    public var id: String { nodeId + ":" + reason.rawValue }

    public init(nodeId: String, reason: Reason, evidence: String, severity: Severity) {
        self.nodeId = nodeId
        self.reason = reason
        self.evidence = evidence
        self.severity = severity
    }
}

/// Body of the metrics routes. The contract lists the member types but not
/// the envelope; the client reads `{ window, nodes, edges, run, bottlenecks }`
/// and accepts `summary` as an alias for `run`.
public struct MetricsSnapshot: Codable, Hashable, Sendable {
    public var window: String?
    public var nodes: [NodeMetrics]
    public var edges: [EdgeMetrics]
    public var run: RunMetrics
    public var bottlenecks: [Bottleneck]

    public init(window: String? = nil, nodes: [NodeMetrics], edges: [EdgeMetrics], run: RunMetrics, bottlenecks: [Bottleneck]) {
        self.window = window
        self.nodes = nodes
        self.edges = edges
        self.run = run
        self.bottlenecks = bottlenecks
    }

    enum CodingKeys: String, CodingKey { case window, nodes, edges, run, summary, bottlenecks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = try c.decodeIfPresent(String.self, forKey: .window)
        nodes = try c.decodeIfPresent([NodeMetrics].self, forKey: .nodes) ?? []
        edges = try c.decodeIfPresent([EdgeMetrics].self, forKey: .edges) ?? []
        run = try c.decodeIfPresent(RunMetrics.self, forKey: .run) ?? c.decode(RunMetrics.self, forKey: .summary)
        bottlenecks = try c.decodeIfPresent([Bottleneck].self, forKey: .bottlenecks) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(window, forKey: .window)
        try c.encode(nodes, forKey: .nodes)
        try c.encode(edges, forKey: .edges)
        try c.encode(run, forKey: .run)
        try c.encode(bottlenecks, forKey: .bottlenecks)
    }

    public func node(_ id: String) -> NodeMetrics? { nodes.first { $0.nodeId == id } }
    public func edge(_ id: String) -> EdgeMetrics? { edges.first { $0.edgeId == id } }
    public func bottlenecks(for nodeId: String) -> [Bottleneck] { bottlenecks.filter { $0.nodeId == nodeId } }

    /// Most severe bottleneck, used on the project overview.
    public var topBottleneck: Bottleneck? {
        bottlenecks.max { $0.severity.rank < $1.severity.rank }
    }
}

public enum MetricsWindow: String, CaseIterable, Sendable, Identifiable {
    case hour = "1h", day = "24h", week = "7d"
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .hour: "Last hour"
        case .day: "Last 24 hours"
        case .week: "Last 7 days"
        }
    }
}
