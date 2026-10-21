import Foundation

// "Observing runs" metrics from docs/architecture/README.md, returned by
// GET /runs/:id/metrics and GET /projects/:id/metrics.

/// Both values are null when nothing has finished in the window.
public struct Percentiles: Codable, Hashable, Sendable {
    public var avg: Double?
    public var p90: Double?
    public init(avg: Double?, p90: Double?) {
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
    /// Null for nodes without a concurrency limit, such as inputs and outputs.
    public var concurrency: Int?
    /// active ÷ concurrency; null when concurrency is.
    public var utilization: Double?
    public var waitSec: Percentiles
    public var serviceSec: Percentiles
    public var throughputPerHour: Double
    /// Null until something finished at this node.
    public var failureRate: Double?
    public var tokens: Int
    public var retries: Int
    public var escalations: Int

    public var id: String { nodeId }

    public init(
        nodeId: String, queued: Int, active: Int, done: Int, failed: Int, concurrency: Int?, utilization: Double?,
        waitSec: Percentiles, serviceSec: Percentiles, throughputPerHour: Double, failureRate: Double?, tokens: Int,
        retries: Int = 0, escalations: Int = 0
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
        self.retries = retries
        self.escalations = escalations
    }

    enum CodingKeys: String, CodingKey {
        case nodeId, queued, active, done, failed, concurrency, utilization, waitSec, serviceSec, throughputPerHour, failureRate, tokens, retries, escalations
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nodeId = try c.decode(String.self, forKey: .nodeId)
        queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
        active = try c.decodeIfPresent(Int.self, forKey: .active) ?? 0
        done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        concurrency = try c.decodeIfPresent(Int.self, forKey: .concurrency)
        utilization = try c.decodeIfPresent(Double.self, forKey: .utilization)
        waitSec = try c.decodeIfPresent(Percentiles.self, forKey: .waitSec) ?? Percentiles(avg: nil, p90: nil)
        serviceSec = try c.decodeIfPresent(Percentiles.self, forKey: .serviceSec) ?? Percentiles(avg: nil, p90: nil)
        throughputPerHour = try c.decodeIfPresent(Double.self, forKey: .throughputPerHour) ?? 0
        failureRate = try c.decodeIfPresent(Double.self, forKey: .failureRate)
        tokens = try c.decodeIfPresent(Int.self, forKey: .tokens) ?? 0
        retries = try c.decodeIfPresent(Int.self, forKey: .retries) ?? 0
        escalations = try c.decodeIfPresent(Int.self, forKey: .escalations) ?? 0
    }
}

/// Planned edges carry their graph `edgeId`. Unplanned interactions use
/// `unplanned:<kind>:<from>-><to>` with `from` and `to` node IDs alongside;
/// the hub writes `?` for an endpoint it could not attribute.
public struct EdgeMetrics: Codable, Hashable, Identifiable, Sendable {
    public var edgeId: String
    public var kind: GraphEdge.Kind
    public var count: Int
    public var unplanned: Bool
    public var from: String?
    public var to: String?

    public var id: String { edgeId }

    public init(edgeId: String, kind: GraphEdge.Kind, count: Int, unplanned: Bool, from: String? = nil, to: String? = nil) {
        self.edgeId = edgeId
        self.kind = kind
        self.count = count
        self.unplanned = unplanned
        self.from = from
        self.to = to
    }

    /// An unplanned edge between two known nodes.
    public static func unplanned(_ kind: GraphEdge.Kind, from: String, to: String, count: Int) -> EdgeMetrics {
        EdgeMetrics(edgeId: "unplanned:\(kind.rawValue):\(from)->\(to)", kind: kind, count: count, unplanned: true, from: from, to: to)
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
    /// Null until an item finished.
    public var tokensPerItem: Double?
    public var activeAgents: Int
    public var retries: Int
    public var escalations: Int
    public var waitingOnHuman: Int
    public var machines: [MachineLoad]

    public init(
        velocity: Velocity, cycleTimeSec: Percentiles, wip: Int, tokensPerItem: Double?, activeAgents: Int, machines: [MachineLoad],
        retries: Int = 0, escalations: Int = 0, waitingOnHuman: Int = 0
    ) {
        self.velocity = velocity
        self.cycleTimeSec = cycleTimeSec
        self.wip = wip
        self.tokensPerItem = tokensPerItem
        self.activeAgents = activeAgents
        self.machines = machines
        self.retries = retries
        self.escalations = escalations
        self.waitingOnHuman = waitingOnHuman
    }

    enum CodingKeys: String, CodingKey { case velocity, cycleTimeSec, wip, tokensPerItem, activeAgents, retries, escalations, waitingOnHuman, machines }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        velocity = try c.decodeIfPresent(Velocity.self, forKey: .velocity) ?? Velocity(itemsDonePerDay: 0, trend: [])
        cycleTimeSec = try c.decodeIfPresent(Percentiles.self, forKey: .cycleTimeSec) ?? Percentiles(avg: nil, p90: nil)
        wip = try c.decodeIfPresent(Int.self, forKey: .wip) ?? 0
        tokensPerItem = try c.decodeIfPresent(Double.self, forKey: .tokensPerItem)
        activeAgents = try c.decodeIfPresent(Int.self, forKey: .activeAgents) ?? 0
        retries = try c.decodeIfPresent(Int.self, forKey: .retries) ?? 0
        escalations = try c.decodeIfPresent(Int.self, forKey: .escalations) ?? 0
        waitingOnHuman = try c.decodeIfPresent(Int.self, forKey: .waitingOnHuman) ?? 0
        machines = try c.decodeIfPresent([MachineLoad].self, forKey: .machines) ?? []
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

        public var rank: Int {
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
    /// Set on project metrics, which combine runs.
    public var runId: String?

    public var id: String { (runId.map { $0 + ":" } ?? "") + nodeId + ":" + reason.rawValue }

    public init(nodeId: String, reason: Reason, evidence: String, severity: Severity, runId: String? = nil) {
        self.nodeId = nodeId
        self.reason = reason
        self.evidence = evidence
        self.severity = severity
        self.runId = runId
    }
}

/// Body of `GET /runs/:id/metrics` and `GET /projects/:id/metrics`:
/// `{ nodes, edges, run, bottlenecks }`, plus `runs` for project metrics.
/// The response does not echo the window, so the client records the one it asked for.
public struct MetricsSnapshot: Codable, Hashable, Sendable {
    public var window: MetricsWindow?
    public var nodes: [NodeMetrics]
    public var edges: [EdgeMetrics]
    public var run: RunMetrics
    public var bottlenecks: [Bottleneck]
    /// Project metrics only: the runs that were combined.
    public var runs: [String]?

    public init(window: MetricsWindow? = nil, nodes: [NodeMetrics], edges: [EdgeMetrics], run: RunMetrics, bottlenecks: [Bottleneck], runs: [String]? = nil) {
        self.window = window
        self.nodes = nodes
        self.edges = edges
        self.run = run
        self.bottlenecks = bottlenecks
        self.runs = runs
    }

    enum CodingKeys: String, CodingKey { case nodes, edges, run, bottlenecks, runs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = nil
        nodes = try c.decodeIfPresent([NodeMetrics].self, forKey: .nodes) ?? []
        edges = try c.decodeIfPresent([EdgeMetrics].self, forKey: .edges) ?? []
        run = try c.decode(RunMetrics.self, forKey: .run)
        bottlenecks = try c.decodeIfPresent([Bottleneck].self, forKey: .bottlenecks) ?? []
        runs = try c.decodeIfPresent([String].self, forKey: .runs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(nodes, forKey: .nodes)
        try c.encode(edges, forKey: .edges)
        try c.encode(run, forKey: .run)
        try c.encode(bottlenecks, forKey: .bottlenecks)
        try c.encodeIfPresent(runs, forKey: .runs)
    }

    public func node(_ id: String) -> NodeMetrics? { nodes.first { $0.nodeId == id } }
    public func edge(_ id: String) -> EdgeMetrics? { edges.first { $0.edgeId == id } }
    public func bottlenecks(for nodeId: String) -> [Bottleneck] { bottlenecks.filter { $0.nodeId == nodeId } }

    /// Most severe bottleneck, used on the project overview.
    public var topBottleneck: Bottleneck? {
        bottlenecks.max { $0.severity.rank < $1.severity.rank }
    }
}

public enum MetricsWindow: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
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
