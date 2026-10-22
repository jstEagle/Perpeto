import Foundation

// Observed T3 Code sessions (`GET /sessions`, `GET /sessions/summary`).
// Each machine's node watches the owner's own T3 Code app read-only and the
// hub aggregates. The contract is new, so decoding is tolerant: only the id
// is required, numbers may arrive as strings, unknown statuses decode to
// `unknown` and malformed entries are dropped.

/// Token counts as T3 reports them for a session or a group.
public struct SessionTokens: Codable, Hashable, Sendable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    public var reasoning: Int

    public init(input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, reasoning: Int = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.reasoning = reasoning
    }

    /// Input plus output, the figure shown everywhere; cache is counted separately, as on Usage.
    public var total: Int { input + output }

    public static let zero = SessionTokens()

    enum CodingKeys: String, CodingKey { case input, output, cacheRead, cacheWrite, reasoning }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = c.lenientCount(.input)
        output = c.lenientCount(.output)
        cacheRead = c.lenientCount(.cacheRead)
        cacheWrite = c.lenientCount(.cacheWrite)
        reasoning = c.lenientCount(.reasoning)
    }
}

public struct ObservedSession: Codable, Hashable, Sendable, Identifiable {
    public enum Status: String, LenientEnum {
        case running, waiting, idle, error, unknown
        public static var unknownCase: Self { .unknown }

        /// Needs a person first, then work happening, then failures, then quiet ones.
        public var order: Int {
            switch self {
            case .waiting: 0
            case .running: 1
            case .error: 2
            case .idle: 3
            case .unknown: 4
            }
        }
    }

    public struct ProjectRef: Codable, Hashable, Sendable {
        public var name: String
        public var path: String?
        public init(name: String, path: String? = nil) {
            self.name = name
            self.path = path
        }

        enum CodingKeys: String, CodingKey { case name, path }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let path = c.lenientString(.path)
            guard let name = c.lenientString(.name) ?? path.map({ ($0 as NSString).lastPathComponent }) else {
                throw DecodingError.keyNotFound(CodingKeys.name, .init(codingPath: decoder.codingPath, debugDescription: "A project needs a name or path."))
            }
            self.name = name
            self.path = path
        }
    }

    public var id: String
    public var machineId: String
    public var machineName: String
    public var threadId: String
    public var title: String?
    public var project: ProjectRef?
    public var branch: String?
    public var provider: String
    public var providerInstanceId: String?
    public var model: String?
    public var status: Status
    public var parentThreadId: String?
    public var childCount: Int
    public var createdAt: Date?
    public var lastActivityAt: Date?
    public var turns: Int
    public var tokens: SessionTokens

    public init(id: String, machineId: String, machineName: String, threadId: String? = nil, title: String? = nil, project: ProjectRef? = nil, branch: String? = nil,
                provider: String, providerInstanceId: String? = nil, model: String? = nil, status: Status, parentThreadId: String? = nil, childCount: Int = 0,
                createdAt: Date? = nil, lastActivityAt: Date? = nil, turns: Int = 0, tokens: SessionTokens = .zero) {
        self.id = id
        self.machineId = machineId
        self.machineName = machineName
        self.threadId = threadId ?? id
        self.title = title
        self.project = project
        self.branch = branch
        self.provider = provider
        self.providerInstanceId = providerInstanceId
        self.model = model
        self.status = status
        self.parentThreadId = parentThreadId
        self.childCount = childCount
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt
        self.turns = turns
        self.tokens = tokens
    }

    enum CodingKeys: String, CodingKey {
        case id, machineId, machineName, threadId, title, project, branch, provider, providerInstanceId, model, status, parentThreadId, childCount,
             createdAt, lastActivityAt, turns, tokens
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: decoder.codingPath, debugDescription: "A session needs an id."))
        }
        self.id = id
        machineId = c.lenientString(.machineId) ?? ""
        machineName = c.lenientString(.machineName) ?? machineId
        threadId = c.lenientString(.threadId) ?? id
        title = c.lenientString(.title)
        project = (try? c.decodeIfPresent(ProjectRef.self, forKey: .project)) ?? nil
        branch = c.lenientString(.branch)
        provider = c.lenientString(.provider) ?? ""
        providerInstanceId = c.lenientString(.providerInstanceId)
        model = c.lenientString(.model)
        status = ((try? c.decodeIfPresent(Status.self, forKey: .status)) ?? nil) ?? .unknown
        parentThreadId = c.lenientString(.parentThreadId)
        childCount = c.lenientCount(.childCount)
        createdAt = c.lenientDate(.createdAt)
        lastActivityAt = c.lenientDate(.lastActivityAt) ?? createdAt
        turns = c.lenientCount(.turns)
        tokens = ((try? c.decodeIfPresent(SessionTokens.self, forKey: .tokens)) ?? nil) ?? .zero
    }
}

/// `GET /sessions`: one page, newest activity first.
public struct SessionPage: Decodable, Hashable, Sendable {
    public var sessions: [ObservedSession]
    public var nextCursor: String?

    public init(sessions: [ObservedSession], nextCursor: String? = nil) {
        self.sessions = sessions
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey { case sessions, nextCursor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = c.lossy(ObservedSession.self, .sessions)
        // Cursors may be opaque strings or sequence numbers.
        nextCursor = c.lenientString(.nextCursor) ?? c.lenientNumber(.nextCursor).map { String(Int($0)) }
    }
}

/// The time span a summary covers.
public enum SessionWindow: String, CaseIterable, Hashable, Sendable, Identifiable {
    case hour = "1h", day = "24h", week = "7d"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .hour: "1 h"
        case .day: "24 h"
        case .week: "7 d"
        }
    }

    /// "the last hour", for labels.
    public var phrase: String {
        switch self {
        case .hour: "the last hour"
        case .day: "the last 24 hours"
        case .week: "the last 7 days"
        }
    }

    public var seconds: TimeInterval {
        switch self {
        case .hour: 3600
        case .day: 86400
        case .week: 7 * 86400
        }
    }
}

/// One machine as the session summary reports it.
public struct ObservedMachine: Codable, Hashable, Sendable, Identifiable {
    public var machineId: String
    public var name: String
    public var online: Bool
    public var observing: Bool
    public var lastObservedAt: Date?
    public var running: Int
    public var waiting: Int
    public var idle: Int
    public var id: String { machineId }

    public init(machineId: String, name: String, online: Bool, observing: Bool, lastObservedAt: Date? = nil, running: Int = 0, waiting: Int = 0, idle: Int = 0) {
        self.machineId = machineId
        self.name = name
        self.online = online
        self.observing = observing
        self.lastObservedAt = lastObservedAt
        self.running = running
        self.waiting = waiting
        self.idle = idle
    }

    enum CodingKeys: String, CodingKey { case machineId, id, name, online, observing, lastObservedAt, running, waiting, idle }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.machineId) ?? c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.machineId, .init(codingPath: decoder.codingPath, debugDescription: "A machine needs machineId."))
        }
        machineId = id
        name = c.lenientString(.name) ?? id
        online = ((try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? nil) ?? false
        observing = ((try? c.decodeIfPresent(Bool.self, forKey: .observing)) ?? nil) ?? false
        lastObservedAt = c.lenientDate(.lastObservedAt)
        running = c.lenientCount(.running)
        waiting = c.lenientCount(.waiting)
        idle = c.lenientCount(.idle)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(machineId, forKey: .machineId)
        try c.encode(name, forKey: .name)
        try c.encode(online, forKey: .online)
        try c.encode(observing, forKey: .observing)
        try c.encodeIfPresent(lastObservedAt, forKey: .lastObservedAt)
        try c.encode(running, forKey: .running)
        try c.encode(waiting, forKey: .waiting)
        try c.encode(idle, forKey: .idle)
    }
}

/// Tokens for one provider, model or machine. The key is whichever of
/// `provider`, `model`, `machineId` or `key` the entry carries.
public struct TokenGroup: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    public var id: String { key }
    public var total: Int { input + output }

    public init(key: String, input: Int, output: Int, cacheRead: Int = 0, cacheWrite: Int = 0) {
        self.key = key
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    enum CodingKeys: String, CodingKey { case key, provider, model, machineId, input, output, cacheRead, cacheWrite }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let key = c.lenientString(.provider) ?? c.lenientString(.model) ?? c.lenientString(.machineId) ?? c.lenientString(.key) else {
            throw DecodingError.keyNotFound(CodingKeys.key, .init(codingPath: decoder.codingPath, debugDescription: "A token group needs a key."))
        }
        self.key = key
        input = c.lenientCount(.input)
        output = c.lenientCount(.output)
        cacheRead = c.lenientCount(.cacheRead)
        cacheWrite = c.lenientCount(.cacheWrite)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(input, forKey: .input)
        try c.encode(output, forKey: .output)
        try c.encode(cacheRead, forKey: .cacheRead)
        try c.encode(cacheWrite, forKey: .cacheWrite)
    }
}

/// One bucket of the token series.
public struct TokenPoint: Codable, Hashable, Sendable {
    public var at: Date
    public var input: Int
    public var output: Int
    public var total: Int { input + output }

    public init(at: Date, input: Int, output: Int) {
        self.at = at
        self.input = input
        self.output = output
    }

    enum CodingKeys: String, CodingKey { case at, input, output }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Date.self, forKey: .at)
        input = c.lenientCount(.input)
        output = c.lenientCount(.output)
    }
}

/// `GET /sessions/summary?window=…`.
public struct SessionSummary: Decodable, Hashable, Sendable {
    public struct Totals: Decodable, Hashable, Sendable {
        public var running: Int
        public var waiting: Int
        public var sessionsActive: Int
        public init(running: Int, waiting: Int, sessionsActive: Int) {
            self.running = running
            self.waiting = waiting
            self.sessionsActive = sessionsActive
        }

        enum CodingKeys: String, CodingKey { case running, waiting, sessionsActive }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            running = c.lenientCount(.running)
            waiting = c.lenientCount(.waiting)
            sessionsActive = c.lenientCount(.sessionsActive)
        }
    }

    public struct Tokens: Decodable, Hashable, Sendable {
        public var byProvider: [TokenGroup]
        public var byModel: [TokenGroup]
        public var byMachine: [TokenGroup]
        /// Oldest first.
        public var series: [TokenPoint]

        public init(byProvider: [TokenGroup] = [], byModel: [TokenGroup] = [], byMachine: [TokenGroup] = [], series: [TokenPoint] = []) {
            self.byProvider = byProvider
            self.byModel = byModel
            self.byMachine = byMachine
            self.series = series
        }

        enum CodingKeys: String, CodingKey { case byProvider, byModel, byMachine, series }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            byProvider = c.lossy(TokenGroup.self, .byProvider)
            byModel = c.lossy(TokenGroup.self, .byModel)
            byMachine = c.lossy(TokenGroup.self, .byMachine)
            series = c.lossy(TokenPoint.self, .series).sorted { $0.at < $1.at }
        }

        /// Input plus output across every provider.
        public var total: Int {
            let fromGroups = byProvider.reduce(0) { $0 + $1.total }
            return fromGroups > 0 ? fromGroups : series.reduce(0) { $0 + $1.total }
        }

        public var input: Int { byProvider.reduce(0) { $0 + $1.input } }
        public var output: Int { byProvider.reduce(0) { $0 + $1.output } }
        public var cacheRead: Int { byProvider.reduce(0) { $0 + $1.cacheRead } }
    }

    public var machines: [ObservedMachine]
    public var totals: Totals
    public var tokens: Tokens

    public init(machines: [ObservedMachine], totals: Totals, tokens: Tokens) {
        self.machines = machines
        self.totals = totals
        self.tokens = tokens
    }

    enum CodingKeys: String, CodingKey { case machines, totals, tokens, summary }

    /// Accepts the bare object or a `{ "summary": … }` envelope.
    public init(from decoder: Decoder) throws {
        let outer = try decoder.container(keyedBy: CodingKeys.self)
        let c = outer.contains(.summary) ? try outer.nestedContainer(keyedBy: CodingKeys.self, forKey: .summary) : outer
        machines = c.lossy(ObservedMachine.self, .machines)
        let totals = (try? c.decodeIfPresent(Totals.self, forKey: .totals)) ?? nil
        tokens = ((try? c.decodeIfPresent(Tokens.self, forKey: .tokens)) ?? nil) ?? Tokens()
        // A hub that omits totals still has per-machine counts.
        self.totals = totals ?? Totals(running: machines.reduce(0) { $0 + $1.running }, waiting: machines.reduce(0) { $0 + $1.waiting },
                                       sessionsActive: machines.reduce(0) { $0 + $1.running + $1.waiting })
    }
}

/// Everything the observe screens read: the session list and a summary per
/// window. Nil in `FactoryState` when the hub has no sessions route yet.
public struct ObservedSessions: Hashable, Sendable {
    public var sessions: [ObservedSession]
    public var summaries: [SessionWindow: SessionSummary]

    public init(sessions: [ObservedSession], summaries: [SessionWindow: SessionSummary]) {
        self.sessions = sessions
        self.summaries = summaries
    }

    public func summary(_ window: SessionWindow) -> SessionSummary? { summaries[window] }

    /// Machines from the summary, else from the sessions themselves.
    public var machines: [ObservedMachine] {
        if let listed = (summaries[.hour] ?? summaries[.day] ?? summaries[.week])?.machines, !listed.isEmpty { return listed }
        var seen: [String: ObservedMachine] = [:]
        var order: [String] = []
        for s in sessions {
            if seen[s.machineId] == nil {
                order.append(s.machineId)
                seen[s.machineId] = ObservedMachine(machineId: s.machineId, name: s.machineName, online: true, observing: true, lastObservedAt: s.lastActivityAt)
            }
            switch s.status {
            case .running: seen[s.machineId]?.running += 1
            case .waiting: seen[s.machineId]?.waiting += 1
            case .idle: seen[s.machineId]?.idle += 1
            default: break
            }
        }
        return order.compactMap { seen[$0] }
    }

    public var running: Int { summaries[.hour]?.totals.running ?? sessions.filter { $0.status == .running }.count }
    public var waiting: Int { summaries[.hour]?.totals.waiting ?? sessions.filter { $0.status == .waiting }.count }
}
