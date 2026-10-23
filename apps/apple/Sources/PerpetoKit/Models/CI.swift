import Foundation

// CI pipelines (Hub API v1: /pipeline-runs, /jobs/:id/log, /runners, /ci/flaky).
// Decoding is lenient: unknown statuses map to `.unknown`, missing arrays to
// empty, so a newer hub never breaks the screen.

/// One run of a named pipeline at an exact revision, fanned out as a DAG of jobs.
public struct PipelineRun: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case queued, running, passed, failed, cancelled, error, unknown
        public static var unknownCase: Self { .unknown }
        /// Still able to change: poll it.
        public var isActive: Bool { self == .queued || self == .running }
    }

    public struct Trigger: Codable, Hashable, Sendable {
        public enum Kind: String, LenientEnum {
            case manual
            case mergeQueue = "merge-queue"
            case pullRequest = "pull-request"
            case schedule, workflow, unknown
            public static var unknownCase: Self { .unknown }
        }
        public var kind: Kind
        public var runId: String?
        public var workItemId: String?
        public var jobId: String?
        public init(kind: Kind, runId: String? = nil, workItemId: String? = nil, jobId: String? = nil) {
            self.kind = kind
            self.runId = runId
            self.workItemId = workItemId
            self.jobId = jobId
        }
    }

    public var id: String
    public var projectId: String
    public var pipeline: String
    public var revision: String
    public var ref: String?
    public var trigger: Trigger
    public var status: Status
    public var configSource: String?
    public var configHash: String?
    public var jobs: [PipelineRunJob]
    public var createdAt: Date?
    public var startedAt: Date?
    public var finishedAt: Date?
    public var durationMs: Double?
    public var reason: String?

    public init(id: String, projectId: String, pipeline: String, revision: String, ref: String? = nil, trigger: Trigger, status: Status,
                configSource: String? = nil, configHash: String? = nil, jobs: [PipelineRunJob], createdAt: Date? = nil, startedAt: Date? = nil,
                finishedAt: Date? = nil, durationMs: Double? = nil, reason: String? = nil) {
        self.id = id
        self.projectId = projectId
        self.pipeline = pipeline
        self.revision = revision
        self.ref = ref
        self.trigger = trigger
        self.status = status
        self.configSource = configSource
        self.configHash = configHash
        self.jobs = jobs
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.durationMs = durationMs
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case id, projectId, pipeline, revision, ref, trigger, status, configSource, configHash, jobs, createdAt, startedAt, finishedAt, durationMs, reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        pipeline = try c.decodeIfPresent(String.self, forKey: .pipeline) ?? ""
        revision = try c.decodeIfPresent(String.self, forKey: .revision) ?? ""
        ref = try? c.decodeIfPresent(String.self, forKey: .ref)
        trigger = (try? c.decodeIfPresent(Trigger.self, forKey: .trigger)) ?? Trigger(kind: .unknown)
        status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .unknown
        configSource = try? c.decodeIfPresent(String.self, forKey: .configSource)
        configHash = try? c.decodeIfPresent(String.self, forKey: .configHash)
        jobs = (try? c.decodeIfPresent(Lossy<PipelineRunJob>.self, forKey: .jobs))?.elements ?? []
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        startedAt = try? c.decodeIfPresent(Date.self, forKey: .startedAt)
        finishedAt = try? c.decodeIfPresent(Date.self, forKey: .finishedAt)
        durationMs = try? c.decodeIfPresent(Double.self, forKey: .durationMs)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }

    /// Elapsed time: the hub's duration when finished, else time since start.
    public func elapsed(now: Date = Date()) -> TimeInterval? {
        if let durationMs { return durationMs / 1000 }
        guard let startedAt else { return nil }
        return max(0, (finishedAt ?? now).timeIntervalSince(startedAt))
    }
}

public struct PipelineRunJob: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case waiting, queued, leased, running, passed, failed, cancelled, error, skipped, unknown
        public static var unknownCase: Self { .unknown }
        public var isActive: Bool { [.waiting, .queued, .leased, .running].contains(self) }
    }

    public struct RunsOn: Codable, Hashable, Sendable {
        /// Nil: the job takes a slot in any pool.
        public var pool: String?
        public var os: String?
        public var labels: [String]
        public init(pool: String? = nil, os: String? = nil, labels: [String] = []) {
            self.pool = pool
            self.os = os
            self.labels = labels
        }
        enum CodingKeys: String, CodingKey { case pool, os, labels }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pool = try? c.decodeIfPresent(String.self, forKey: .pool)
            os = try? c.decodeIfPresent(String.self, forKey: .os)
            labels = (try? c.decodeIfPresent([String].self, forKey: .labels)) ?? []
        }
    }

    public struct Attempt: Codable, Hashable, Sendable {
        public var jobId: String
        public var status: Status
        public var machineId: String?
        public var queuedAt: Date?
        public var startedAt: Date?
        public var finishedAt: Date?
        public init(jobId: String, status: Status, machineId: String? = nil, queuedAt: Date? = nil, startedAt: Date? = nil, finishedAt: Date? = nil) {
            self.jobId = jobId
            self.status = status
            self.machineId = machineId
            self.queuedAt = queuedAt
            self.startedAt = startedAt
            self.finishedAt = finishedAt
        }
    }

    public struct Cache: Codable, Hashable, Sendable {
        public var key: String
        public var hit: Bool
        public init(key: String, hit: Bool) {
            self.key = key
            self.hit = hit
        }
    }

    public struct Artifact: Codable, Hashable, Identifiable, Sendable {
        public var id: String
        public var name: String
        public var path: String
        public var size: Int
        public init(id: String, name: String, path: String, size: Int) {
            self.id = id
            self.name = name
            self.path = path
            self.size = size
        }
    }

    public var key: String
    public var name: String
    public var matrix: [String: String]?
    public var needs: [String]
    public var runsOn: RunsOn
    public var status: Status
    public var jobId: String?
    public var machineId: String?
    public var attempt: Int
    public var maxAttempts: Int
    public var attempts: [Attempt]
    public var queuedAt: Date?
    public var startedAt: Date?
    public var finishedAt: Date?
    public var durationMs: Double?
    public var queueWaitMs: Double?
    public var flaky: Bool
    public var cache: [Cache]
    public var artifacts: [Artifact]

    public var id: String { key }

    public init(key: String, name: String, matrix: [String: String]? = nil, needs: [String] = [], runsOn: RunsOn = RunsOn(), status: Status,
                jobId: String? = nil, machineId: String? = nil, attempt: Int = 1, maxAttempts: Int = 1, attempts: [Attempt] = [],
                queuedAt: Date? = nil, startedAt: Date? = nil, finishedAt: Date? = nil, durationMs: Double? = nil, queueWaitMs: Double? = nil,
                flaky: Bool = false, cache: [Cache] = [], artifacts: [Artifact] = []) {
        self.key = key
        self.name = name
        self.matrix = matrix
        self.needs = needs
        self.runsOn = runsOn
        self.status = status
        self.jobId = jobId
        self.machineId = machineId
        self.attempt = attempt
        self.maxAttempts = maxAttempts
        self.attempts = attempts
        self.queuedAt = queuedAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.durationMs = durationMs
        self.queueWaitMs = queueWaitMs
        self.flaky = flaky
        self.cache = cache
        self.artifacts = artifacts
    }

    enum CodingKeys: String, CodingKey {
        case key, name, matrix, needs, runsOn, status, jobId, machineId, attempt, maxAttempts, attempts, queuedAt, startedAt, finishedAt, durationMs, queueWaitMs, flaky, cache, artifacts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? key
        // Matrix values may be numbers or booleans in ci.json; show them as text.
        if let values = try? c.decodeIfPresent([String: JSONValue].self, forKey: .matrix) {
            matrix = values.mapValues { value in
                switch value {
                case .string(let s): s
                case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
                case .bool(let b): String(b)
                default: ""
                }
            }
        } else {
            matrix = nil
        }
        needs = (try? c.decodeIfPresent([String].self, forKey: .needs)) ?? []
        runsOn = (try? c.decodeIfPresent(RunsOn.self, forKey: .runsOn)) ?? RunsOn()
        status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .unknown
        jobId = try? c.decodeIfPresent(String.self, forKey: .jobId)
        machineId = try? c.decodeIfPresent(String.self, forKey: .machineId)
        attempt = (try? c.decodeIfPresent(Int.self, forKey: .attempt)) ?? 1
        maxAttempts = (try? c.decodeIfPresent(Int.self, forKey: .maxAttempts)) ?? 1
        attempts = (try? c.decodeIfPresent(Lossy<Attempt>.self, forKey: .attempts))?.elements ?? []
        queuedAt = try? c.decodeIfPresent(Date.self, forKey: .queuedAt)
        startedAt = try? c.decodeIfPresent(Date.self, forKey: .startedAt)
        finishedAt = try? c.decodeIfPresent(Date.self, forKey: .finishedAt)
        durationMs = try? c.decodeIfPresent(Double.self, forKey: .durationMs)
        queueWaitMs = try? c.decodeIfPresent(Double.self, forKey: .queueWaitMs)
        flaky = (try? c.decodeIfPresent(Bool.self, forKey: .flaky)) ?? false
        cache = (try? c.decodeIfPresent(Lossy<Cache>.self, forKey: .cache))?.elements ?? []
        artifacts = (try? c.decodeIfPresent(Lossy<Artifact>.self, forKey: .artifacts))?.elements ?? []
    }

    /// "node 22 · os linux", sorted by key.
    public var matrixLabel: String? {
        guard let matrix, !matrix.isEmpty else { return nil }
        return matrix.keys.sorted().map { "\($0) \(matrix[$0] ?? "")" }.joined(separator: " · ")
    }

    public func elapsed(now: Date = Date()) -> TimeInterval? {
        if let durationMs { return durationMs / 1000 }
        guard let startedAt else { return nil }
        return max(0, (finishedAt ?? now).timeIntervalSince(startedAt))
    }
}

/// A page of a job's CI log, after a cursor.
public struct JobLogPage: Codable, Hashable, Sendable {
    public struct Chunk: Codable, Hashable, Sendable {
        public var seq: Int
        public var chunk: String
        public var at: Date?
        public init(seq: Int, chunk: String, at: Date? = nil) {
            self.seq = seq
            self.chunk = chunk
            self.at = at
        }
    }
    public var jobId: String
    public var chunks: [Chunk]
    public var nextCursor: Int?
    public var hasMore: Bool
    public var truncated: Bool
    public var bytes: Int?

    public init(jobId: String, chunks: [Chunk], nextCursor: Int? = nil, hasMore: Bool = false, truncated: Bool = false, bytes: Int? = nil) {
        self.jobId = jobId
        self.chunks = chunks
        self.nextCursor = nextCursor
        self.hasMore = hasMore
        self.truncated = truncated
        self.bytes = bytes
    }

    enum CodingKeys: String, CodingKey { case jobId, chunks, nextCursor, hasMore, truncated, bytes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = (try? c.decodeIfPresent(String.self, forKey: .jobId)) ?? ""
        chunks = (try? c.decodeIfPresent(Lossy<Chunk>.self, forKey: .chunks))?.elements ?? []
        nextCursor = try? c.decodeIfPresent(Int.self, forKey: .nextCursor)
        hasMore = (try? c.decodeIfPresent(Bool.self, forKey: .hasMore)) ?? false
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        bytes = try? c.decodeIfPresent(Int.self, forKey: .bytes)
    }
}

/// Log text accumulated from pages, following the hub's cursor. Chunks at or
/// before the cursor (a replayed page) are ignored.
public struct LogBuffer: Hashable, Sendable {
    public private(set) var text = ""
    public private(set) var cursor: Int?
    public private(set) var truncated = false
    /// Display cap; older text is dropped from the front.
    public var maxCharacters: Int

    public init(maxCharacters: Int = 400_000) { self.maxCharacters = maxCharacters }

    public mutating func append(_ page: JobLogPage) {
        for chunk in page.chunks.sorted(by: { $0.seq < $1.seq }) where chunk.seq > (cursor ?? Int.min) {
            text += chunk.chunk
            cursor = chunk.seq
        }
        if let next = page.nextCursor { cursor = max(cursor ?? next, next) }
        truncated = truncated || page.truncated
        if text.count > maxCharacters {
            text = String(text.suffix(maxCharacters))
            truncated = true
        }
    }
}

public struct RunnerPool: Codable, Hashable, Sendable {
    public var name: String
    public var maxJobs: Int
    public var busy: Int
    public init(name: String, maxJobs: Int, busy: Int) {
        self.name = name
        self.maxJobs = maxJobs
        self.busy = busy
    }
}

public struct Runner: Codable, Hashable, Identifiable, Sendable {
    public struct CacheStats: Codable, Hashable, Sendable {
        public var sizeBytes: Int
        public var maxBytes: Int
        public var entries: Int
        public init(sizeBytes: Int, maxBytes: Int, entries: Int) {
            self.sizeBytes = sizeBytes
            self.maxBytes = maxBytes
            self.entries = entries
        }
    }
    public var machineId: String
    public var name: String
    public var os: String?
    public var status: Machine.Status
    public var labels: [String]
    public var pools: [RunnerPool]
    public var maxJobs: Int
    public var busy: Int
    public var mode: String?
    public var cache: CacheStats?
    public var utilisation: Double?

    public var id: String { machineId }

    public init(machineId: String, name: String, os: String? = nil, status: Machine.Status, labels: [String] = [], pools: [RunnerPool] = [],
                maxJobs: Int, busy: Int, mode: String? = nil, cache: CacheStats? = nil, utilisation: Double? = nil) {
        self.machineId = machineId
        self.name = name
        self.os = os
        self.status = status
        self.labels = labels
        self.pools = pools
        self.maxJobs = maxJobs
        self.busy = busy
        self.mode = mode
        self.cache = cache
        self.utilisation = utilisation
    }

    enum CodingKeys: String, CodingKey { case machineId, name, os, status, labels, pools, maxJobs, busy, mode, cache, utilisation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machineId = try c.decode(String.self, forKey: .machineId)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? machineId
        os = try? c.decodeIfPresent(String.self, forKey: .os)
        status = (try? c.decodeIfPresent(Machine.Status.self, forKey: .status)) ?? .unknown
        labels = (try? c.decodeIfPresent([String].self, forKey: .labels)) ?? []
        pools = (try? c.decodeIfPresent(Lossy<RunnerPool>.self, forKey: .pools))?.elements ?? []
        maxJobs = (try? c.decodeIfPresent(Int.self, forKey: .maxJobs)) ?? 0
        busy = (try? c.decodeIfPresent(Int.self, forKey: .busy)) ?? 0
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        cache = try? c.decodeIfPresent(CacheStats.self, forKey: .cache)
        utilisation = try? c.decodeIfPresent(Double.self, forKey: .utilisation)
    }
}

public struct RunnerPoolSummary: Codable, Hashable, Identifiable, Sendable {
    public var name: String
    public var machines: Int
    public var slots: Int
    public var busy: Int
    public var queued: Int
    public var id: String { name }
    public init(name: String, machines: Int, slots: Int, busy: Int, queued: Int) {
        self.name = name
        self.machines = machines
        self.slots = slots
        self.busy = busy
        self.queued = queued
    }
}

public struct RunnersResponse: Codable, Hashable, Sendable {
    public var runners: [Runner]
    public var pools: [RunnerPoolSummary]
    public init(runners: [Runner], pools: [RunnerPoolSummary]) {
        self.runners = runners
        self.pools = pools
    }
    enum CodingKeys: String, CodingKey { case runners, pools }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runners = (try? c.decodeIfPresent(Lossy<Runner>.self, forKey: .runners))?.elements ?? []
        pools = (try? c.decodeIfPresent(Lossy<RunnerPoolSummary>.self, forKey: .pools))?.elements ?? []
    }
}

public struct FlakyJob: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var pipeline: String
    public var job: String
    public var occurrences: Int
    public var lastRevision: String?
    public var lastSeenAt: Date?
    public init(id: String, pipeline: String, job: String, occurrences: Int, lastRevision: String? = nil, lastSeenAt: Date? = nil) {
        self.id = id
        self.pipeline = pipeline
        self.job = job
        self.occurrences = occurrences
        self.lastRevision = lastRevision
        self.lastSeenAt = lastSeenAt
    }
}

/// Everything the CI screen shows at once.
public struct CIOverview: Hashable, Sendable {
    public var runs: [PipelineRun]
    public var runners: RunnersResponse
    public var flaky: [FlakyJob]
    public init(runs: [PipelineRun], runners: RunnersResponse, flaky: [FlakyJob]) {
        self.runs = runs
        self.runners = runners
        self.flaky = flaky
    }
    public static let empty = CIOverview(runs: [], runners: RunnersResponse(runners: [], pools: []), flaky: [])
}

/// Jobs grouped into columns by dependency depth: a job sits one column after
/// the deepest job it needs. Unknown needs are ignored and cycles cannot hang.
public enum PipelineLayout {
    public static func depths(_ jobs: [PipelineRunJob]) -> [String: Int] {
        let byKey = Dictionary(jobs.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var memo: [String: Int] = [:]
        func depth(_ key: String, _ visiting: Set<String>) -> Int {
            if let known = memo[key] { return known }
            guard let job = byKey[key], !visiting.contains(key) else { return 0 }
            let parents = job.needs.filter { byKey[$0] != nil }
            let value = parents.isEmpty ? 0 : (parents.map { depth($0, visiting.union([key])) }.max() ?? 0) + 1
            memo[key] = value
            return value
        }
        for job in jobs { _ = depth(job.key, []) }
        return memo
    }

    /// Columns in dependency order; each keeps the hub's job order.
    public static func columns(_ jobs: [PipelineRunJob]) -> [[PipelineRunJob]] {
        let depths = depths(jobs)
        let count = (depths.values.max() ?? -1) + 1
        var columns = Array(repeating: [PipelineRunJob](), count: count)
        for job in jobs { columns[depths[job.key] ?? 0].append(job) }
        return columns
    }
}

/// Byte sizes: "512 B", "3.4 MB", "1.2 GB".
public enum ByteFormat {
    public static func string(_ bytes: Int) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        if unit == 0 { return "\(bytes) B" }
        let text = String(format: value >= 100 ? "%.0f" : "%.1f", value)
        return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + " " + units[unit]
    }
}
