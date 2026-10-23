import Foundation

/// Project merge queues: `GET/PUT /projects/:id/merge-queues`, `GET /merge-queues/:id`.
/// Times stay ISO strings; the screens format them.

public struct QueueLane: Codable, Hashable, Sendable {
    public var name: String
    public var priority: Int
    public var labels: [String]
    public var branches: [String]
    public init(name: String, priority: Int, labels: [String] = [], branches: [String] = []) {
        self.name = name; self.priority = priority; self.labels = labels; self.branches = branches
    }
}

/// A weekly cron window with a duration, or a fixed date range.
public struct FreezeWindow: Codable, Hashable, Sendable {
    public var cron: String?
    public var durationMinutes: Int?
    public var start: String?
    public var end: String?
    public var reason: String?
    public init(cron: String? = nil, durationMinutes: Int? = nil, start: String? = nil, end: String? = nil, reason: String? = nil) {
        self.cron = cron; self.durationMinutes = durationMinutes; self.start = start; self.end = end; self.reason = reason
    }
    public var summary: String {
        if let cron, let durationMinutes { return "\(cron) UTC for \(MergeQueueText.minutes(durationMinutes))" }
        return "\(start ?? "?") to \(end ?? "?")"
    }
}

public struct QueueConfig: Codable, Hashable, Sendable, Identifiable {
    public enum Strategy: String, Codable, Sendable, CaseIterable { case serial, batch, speculative }
    public var id: String { name }
    public var name: String
    public var branches: [String]
    public var strategy: Strategy
    public var maxBatchSize: Int
    public var depth: Int
    public var requiredChecks: [String]
    public var method: String
    public var publication: String
    public var lanes: [QueueLane]
    public var defaultLane: String?
    public var freeze: Freeze
    public var maxInFlight: Int?
    public var flakyRetries: Int
    public var bisectOnBatchFailure: Bool
    public var autoRebaseOnConflict: Bool
    public var ejectAfterMinutes: Int?
    public var requiredApprovals: Int

    public struct Freeze: Codable, Hashable, Sendable {
        public var windows: [FreezeWindow]
        public init(windows: [FreezeWindow] = []) { self.windows = windows }
    }

    public init(name: String, branches: [String]? = nil, strategy: Strategy = .serial, maxBatchSize: Int = 8, depth: Int = 3, requiredChecks: [String] = [],
                method: String = "squash", publication: String = "fast-forward-push", lanes: [QueueLane] = [], defaultLane: String? = nil,
                freeze: Freeze = Freeze(), maxInFlight: Int? = nil, flakyRetries: Int = 0, bisectOnBatchFailure: Bool = true,
                autoRebaseOnConflict: Bool = true, ejectAfterMinutes: Int? = nil, requiredApprovals: Int = 0) {
        self.name = name; self.branches = branches ?? [name]; self.strategy = strategy; self.maxBatchSize = maxBatchSize; self.depth = depth
        self.requiredChecks = requiredChecks; self.method = method; self.publication = publication; self.lanes = lanes; self.defaultLane = defaultLane
        self.freeze = freeze; self.maxInFlight = maxInFlight; self.flakyRetries = flakyRetries; self.bisectOnBatchFailure = bisectOnBatchFailure
        self.autoRebaseOnConflict = autoRebaseOnConflict; self.ejectAfterMinutes = ejectAfterMinutes; self.requiredApprovals = requiredApprovals
    }

    public var strategyText: String {
        switch strategy {
        case .serial: "One at a time"
        case .batch: "Batches of up to \(maxBatchSize)"
        case .speculative: "Speculative, \(depth) deep"
        }
    }

    /// The hub's rules for the fields the Apple editor changes, by JSON path, so problems show under their field.
    public func problems(at index: Int) -> [ConfigProblem] {
        var found: [ConfigProblem] = []
        let path = "$.queues[\(index)]"
        func check(_ ok: Bool, _ field: String, _ message: String) { if !ok { found.append(ConfigProblem(path: "\(path).\(field)", message: message)) } }
        check(name.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", options: .regularExpression) != nil, "name", "must be 1 to 64 letters, digits, \".\", \"_\" or \"-\".")
        check((1...100).contains(maxBatchSize), "maxBatchSize", "must be an integer from 1 to 100.")
        check((1...20).contains(depth), "depth", "must be an integer from 1 to 20.")
        check(maxInFlight.map { (1...1000).contains($0) } ?? true, "maxInFlight", "must be empty or an integer from 1 to 1000.")
        check((0...5).contains(flakyRetries), "flakyRetries", "must be an integer from 0 to 5.")
        check(ejectAfterMinutes.map { (1...80640).contains($0) } ?? true, "ejectAfterMinutes", "must be empty or an integer from 1 to 80640.")
        check((0...10).contains(requiredApprovals), "requiredApprovals", "must be an integer from 0 to 10.")
        check(publication != "github-merge-queue" || strategy == .serial, "publication", "github-merge-queue publication requires strategy serial; GitHub orders the merges itself.")
        return found
    }
}

public struct ConfigProblem: Codable, Hashable, Sendable {
    public var path: String
    public var message: String
    public init(path: String, message: String) { self.path = path; self.message = message }
}

public struct MergeQueueConfig: Codable, Hashable, Sendable {
    public var version: Int
    public var queues: [QueueConfig]
    public init(version: Int = 1, queues: [QueueConfig]) { self.version = version; self.queues = queues }
}

public struct MergeQueueFreeze: Codable, Hashable, Sendable {
    public var kind: String?
    public var reason: String
    public var since: String?
    public var until: String?
    public var by: String?
    public init(kind: String? = "manual", reason: String, since: String? = nil, until: String? = nil, by: String? = nil) {
        self.kind = kind; self.reason = reason; self.since = since; self.until = until; self.by = by
    }
    public var isManual: Bool { kind != "window" }
}

public struct MergeQueueSummary: Codable, Hashable, Sendable, Identifiable {
    public struct Counts: Codable, Hashable, Sendable { public var queued: Int; public var testing: Int; public var merging: Int }
    public var id: String
    public var kind: String
    public var name: String
    public var projectId: String
    public var branches: [String]
    public var strategy: String
    public var source: String
    public var frozen: MergeQueueFreeze?
    public var counts: Counts
    public var open: Int { counts.queued + counts.testing + counts.merging }
}

public struct MergeQueueSettings: Codable, Hashable, Sendable {
    public struct Repo: Codable, Hashable, Sendable {
        public var path: String
        public var found: Bool
        public var revision: String?
        public var error: String?
        public var errors: [ConfigProblem]?
        public var applied: Bool
    }
    public var projectId: String
    public var version: Int
    public var updatedAt: String?
    /// The hub's own document before the repository file applies.
    public var config: MergeQueueConfig
    public var repo: Repo
    public var effective: MergeQueueConfig
    public var queues: [MergeQueueSummary]
}

public struct QueueEntryView: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var prUrl: String
    public var headSha: String
    public var baseBranch: String
    public var status: MergeEntry.Status
    public var position: Int
    public var priority: Int
    public var lane: String?
    public var headBranch: String?
    public var enqueuedAt: String?
    public var waitedMs: Double?
    public var etaAt: String?
    public var finishedAt: String?
    public var attemptId: String?
    public var reason: String?
    public var cause: String?
    public var retries: Int?
    public var deliveryError: String?
}

public struct QueueAttemptView: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var head: Bool
    public var phase: String
    public var entryIds: [String]
    public var size: Int
    public var startedAt: String?
    public var jobStatus: String?
    public var revision: String?
    public var retries: Int?
    public var reason: String?

    public func label(strategy: String) -> String {
        let what = !head ? "Speculative, on the change ahead" : size > 1 ? "Batch of \(size)" : strategy == "speculative" ? "Head of the queue" : "Next to merge"
        let state: String = switch phase {
        case "preparing": "preparing the candidate"
        case "testing": jobStatus == "passed" ? "CI passed" : (jobStatus == "failed" || jobStatus == "error") ? "CI failed" : "CI running"
        case "merging": "publishing"
        case "blocked": "waits for the head"
        default: phase
        }
        return "\(what) · \(state)\(retries.map { $0 > 0 ? ", retry \($0)" : "" } ?? "")"
    }
}

public struct QueueMetrics: Codable, Hashable, Sendable {
    public struct Reason: Codable, Hashable, Sendable { public var cause: String; public var count: Int; public var rate: Double }
    public struct Batches: Codable, Hashable, Sendable { public var total: Int; public var succeeded: Int; public var successRate: Double? }
    public struct Hour: Codable, Hashable, Sendable { public var start: String; public var merged: Int; public var rejected: Int }
    public var windowMs: Double
    public var merged: Int
    public var rejected: Int
    public var throughputPerHour: Double
    public var medianTimeInQueueMs: Double?
    public var failureRate: Double?
    public var failuresByReason: [Reason]
    public var batches: Batches
    public var flakyRetries: Int
    public var hourly: [Hour]
}

public struct MergeQueueView: Codable, Hashable, Sendable, Identifiable {
    public struct ETA: Codable, Hashable, Sendable { public var attemptMs: Double?; public var samples: Int }
    public var id: String
    public var kind: String
    public var projectId: String
    public var name: String
    public var source: String
    public var config: QueueConfig?
    public var branches: [String]
    public var strategy: String
    public var frozen: MergeQueueFreeze?
    public var entries: [QueueEntryView]
    public var attempts: [QueueAttemptView]
    public var recent: [QueueEntryView]
    public var eta: ETA
    public var metrics: QueueMetrics
    public var window: String

    public var strategyText: String { config?.strategyText ?? (strategy == "batch" ? "Batches" : strategy == "speculative" ? "Speculative" : "One at a time") }
    public var summary: String {
        let flight = entries.filter { $0.status == .testing || $0.status == .merging }.count
        let waiting = entries.filter { $0.status == .queued }.count
        let parts = [flight > 0 ? "\(flight) in flight" : nil, waiting > 0 ? "\(waiting) waiting" : nil].compactMap { $0 }
        return parts.isEmpty ? "Nothing queued" : parts.joined(separator: " · ")
    }
}

public enum MergeEntryCommand: Sendable, Hashable {
    case lane(String)
    case requeue
    case eject(reason: String?)
    public var action: String {
        switch self { case .lane: "priority"; case .requeue: "requeue"; case .eject: "eject" }
    }
}

public enum MergeQueueCause {
    public static func label(_ cause: String?) -> String {
        switch cause {
        case "ci": "CI failed"
        case "conflict": "Merge conflict"
        case "head-changed": "Head changed"
        case "timeout": "Timed out"
        case "manual": "Ejected"
        case "approvals": "Missing approvals"
        default: "Other"
        }
    }
}

public enum MergeQueueText {
    public static func minutes(_ minutes: Int) -> String {
        minutes < 60 ? "\(minutes) min" : minutes % 60 == 0 ? "\(minutes / 60) h" : String(format: "%.1f h", Double(minutes) / 60)
    }
    public static func duration(ms: Double?) -> String {
        guard let ms else { return "—" }
        let seconds = ms / 1000
        if seconds < 60 { return "\(Int(seconds.rounded())) s" }
        if seconds < 3600 { return "\(Int((seconds / 60).rounded())) min" }
        return String(format: "%.1f h", seconds / 3600).replacingOccurrences(of: ".0 h", with: " h")
    }
}
