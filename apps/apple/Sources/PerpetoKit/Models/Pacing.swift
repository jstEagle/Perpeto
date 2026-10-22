import Foundation

// Subscription usage and pacing (`GET /accounts` usage, `GET /pacing`).
// The contract is new and may still shift, so decoding is tolerant:
// optional fields stay optional, malformed entries are dropped, numbers may
// arrive as integers, decimals or strings, and unknown enum values decode to
// a neutral case.

/// A string-keyed container helper for lenient numbers and dates.
extension KeyedDecodingContainer {
    func lenientNumber(_ key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value.isFinite ? value : nil }
        if let text = try? decodeIfPresent(String.self, forKey: key), let value = Double(text.trimmingCharacters(in: .whitespaces)), value.isFinite { return value }
        return nil
    }

    func lenientCount(_ key: Key) -> Int { max(0, Int((lenientNumber(key) ?? 0).rounded())) }

    func lenientDate(_ key: Key) -> Date? { (try? decodeIfPresent(Date.self, forKey: key)) ?? nil }

    func lenientString(_ key: Key) -> String? {
        guard let value = (try? decodeIfPresent(String.self, forKey: key)) ?? nil, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    func lossy<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        ((try? decodeIfPresent(Lossy<T>.self, forKey: key)) ?? nil)?.elements ?? []
    }
}

public enum UsageWindowKind: String, LenientEnum {
    case session, weekly, monthly, other
    public static var unknownCase: Self { .other }

    public var defaultLabel: String {
        switch self {
        case .session: "Session"
        case .weekly: "Weekly"
        case .monthly: "Monthly"
        case .other: "Limit"
        }
    }

    /// Session first, then weekly, monthly and the rest.
    public var order: Int {
        switch self {
        case .session: 0
        case .weekly: 1
        case .monthly: 2
        case .other: 3
        }
    }
}

/// One subscription limit window as the harness reports it. `usedPercent` is 0 to 100.
public struct UsageWindow: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var kind: UsageWindowKind
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var windowMins: Double?

    public init(id: String, kind: UsageWindowKind, label: String, usedPercent: Double, resetsAt: Date? = nil, windowMins: Double? = nil) {
        self.id = id
        self.kind = kind
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.windowMins = windowMins
    }

    enum CodingKeys: String, CodingKey { case id, kind, label, usedPercent, resetsAt, windowMins }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let used = c.lenientNumber(.usedPercent) else {
            throw DecodingError.keyNotFound(CodingKeys.usedPercent, .init(codingPath: decoder.codingPath, debugDescription: "A usage window needs usedPercent."))
        }
        kind = (try? c.decodeIfPresent(UsageWindowKind.self, forKey: .kind)) ?? .other
        id = c.lenientString(.id) ?? kind.rawValue
        label = c.lenientString(.label) ?? kind.defaultLabel
        usedPercent = max(0, used)
        resetsAt = c.lenientDate(.resetsAt)
        windowMins = c.lenientNumber(.windowMins)
    }
}

public struct AccountUsage: Codable, Hashable, Sendable {
    public var checkedAt: Date?
    public var windows: [UsageWindow]

    public init(checkedAt: Date? = nil, windows: [UsageWindow]) {
        self.checkedAt = checkedAt
        self.windows = windows
    }

    enum CodingKeys: String, CodingKey { case checkedAt, windows }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checkedAt = c.lenientDate(.checkedAt)
        windows = c.lossy(UsageWindow.self, .windows)
    }
}

/// `PATCH /accounts/:id`. An empty plan is sent as null, which clears it.
public struct AccountPatch: Encodable, Sendable, Hashable {
    public var label: String?
    public var plan: String?
    public init(label: String? = nil, plan: String? = nil) {
        self.label = label
        self.plan = plan
    }

    enum CodingKeys: String, CodingKey { case label, plan }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(label, forKey: .label)
        if let plan { if plan.isEmpty { try c.encodeNil(forKey: .plan) } else { try c.encode(plan, forKey: .plan) } }
    }
}

public struct Pacing: Codable, Hashable, Sendable {
    public enum Strategy: String, LenientEnum {
        case rotation, parallel, unknown
        public static var unknownCase: Self { .unknown }
    }

    /// `enforce`: the hub scales agents. `advise`: Perpeto only observes and
    /// the numbers are suggestions. Absent means enforce (hubs before
    /// observe-only mode); an unknown value is treated as advice, so no
    /// controls are offered for something the hub may not do.
    public enum Mode: String, LenientEnum {
        case enforce, advise, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var mode: Mode = .enforce
    /// True when nothing is enforced: show advice, hide the settings.
    public var isAdvisory: Bool { mode != .enforce }
    public var enabled: Bool
    public var strategy: Strategy
    public var targetUsePercent: Int
    /// Only when the hub reports them. With `minAgents` set, a nil maximum means no cap.
    public var minAgents: Int?
    public var maxAgents: Int?
    public var updatedAt: Date?
    public var providers: [PacingProvider]
    public var accounts: [PacingAccount]
    public var timeline: [PacingSegment]

    public init(mode: Mode = .enforce, enabled: Bool, strategy: Strategy, targetUsePercent: Int, minAgents: Int? = nil, maxAgents: Int? = nil, updatedAt: Date? = nil,
                providers: [PacingProvider], accounts: [PacingAccount], timeline: [PacingSegment]) {
        self.mode = mode
        self.enabled = enabled
        self.strategy = strategy
        self.targetUsePercent = targetUsePercent
        self.minAgents = minAgents
        self.maxAgents = maxAgents
        self.updatedAt = updatedAt
        self.providers = providers
        self.accounts = accounts
        self.timeline = timeline
    }

    enum CodingKeys: String, CodingKey { case mode, enabled, strategy, targetUsePercent, minAgents, maxAgents, updatedAt, providers, accounts, timeline, pacing }

    /// Accepts the bare object or a `{ "pacing": … }` envelope.
    public init(from decoder: Decoder) throws {
        let outer = try decoder.container(keyedBy: CodingKeys.self)
        let c = outer.contains(.pacing) ? try outer.nestedContainer(keyedBy: CodingKeys.self, forKey: .pacing) : outer
        mode = c.lenientString(.mode).map { Mode(rawValue: $0) ?? .unknown } ?? .enforce
        enabled = ((try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? nil) ?? false
        strategy = ((try? c.decodeIfPresent(Strategy.self, forKey: .strategy)) ?? nil) ?? .unknown
        targetUsePercent = c.lenientNumber(.targetUsePercent).map { min(100, max(1, Int($0.rounded()))) } ?? 95
        minAgents = c.lenientNumber(.minAgents).map { _ in c.lenientCount(.minAgents) }
        maxAgents = c.lenientNumber(.maxAgents).map { _ in c.lenientCount(.maxAgents) }
        updatedAt = c.lenientDate(.updatedAt)
        providers = c.lossy(PacingProvider.self, .providers)
        accounts = c.lossy(PacingAccount.self, .accounts)
        timeline = c.lossy(PacingSegment.self, .timeline)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mode, forKey: .mode)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(strategy, forKey: .strategy)
        try c.encode(targetUsePercent, forKey: .targetUsePercent)
        try c.encodeIfPresent(minAgents, forKey: .minAgents)
        try c.encodeIfPresent(maxAgents, forKey: .maxAgents)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try c.encode(providers, forKey: .providers)
        try c.encode(accounts, forKey: .accounts)
        try c.encode(timeline, forKey: .timeline)
    }
}

public struct PacingProvider: Codable, Hashable, Sendable, Identifiable {
    public enum Limit: String, LenientEnum {
        case weekly, session, slots, work, none, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var provider: String
    public var targetAgents: Int
    public var runningAgents: Int
    public var slots: Int
    public var readyWork: Int
    public var limitedBy: Limit
    public var starved: Bool
    public var id: String { provider }

    public init(provider: String, targetAgents: Int, runningAgents: Int, slots: Int, readyWork: Int, limitedBy: Limit, starved: Bool) {
        self.provider = provider
        self.targetAgents = targetAgents
        self.runningAgents = runningAgents
        self.slots = slots
        self.readyWork = readyWork
        self.limitedBy = limitedBy
        self.starved = starved
    }

    enum CodingKeys: String, CodingKey { case provider, targetAgents, runningAgents, slots, readyWork, limitedBy, starved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        targetAgents = c.lenientCount(.targetAgents)
        runningAgents = c.lenientCount(.runningAgents)
        slots = c.lenientCount(.slots)
        readyWork = c.lenientCount(.readyWork)
        limitedBy = ((try? c.decodeIfPresent(Limit.self, forKey: .limitedBy)) ?? nil) ?? .unknown
        starved = ((try? c.decodeIfPresent(Bool.self, forKey: .starved)) ?? nil) ?? false
    }
}

public struct PacingWindow: Codable, Hashable, Sendable, Identifiable {
    public enum OnTrack: String, LenientEnum {
        case under, on, over, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var kind: UsageWindowKind
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var projectedPercentAtReset: Double
    public var onTrack: OnTrack

    public init(id: String, kind: UsageWindowKind, label: String, usedPercent: Double, resetsAt: Date? = nil, projectedPercentAtReset: Double, onTrack: OnTrack) {
        self.id = id
        self.kind = kind
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.projectedPercentAtReset = projectedPercentAtReset
        self.onTrack = onTrack
    }

    enum CodingKeys: String, CodingKey { case projectedPercentAtReset, onTrack }

    public init(from decoder: Decoder) throws {
        let base = try UsageWindow(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = base.id
        kind = base.kind
        label = base.label
        usedPercent = base.usedPercent
        resetsAt = base.resetsAt
        projectedPercentAtReset = max(0, c.lenientNumber(.projectedPercentAtReset) ?? base.usedPercent)
        onTrack = ((try? c.decodeIfPresent(OnTrack.self, forKey: .onTrack)) ?? nil) ?? .unknown
    }

    public func encode(to encoder: Encoder) throws {
        try UsageWindow(id: id, kind: kind, label: label, usedPercent: usedPercent, resetsAt: resetsAt).encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(projectedPercentAtReset, forKey: .projectedPercentAtReset)
        try c.encode(onTrack, forKey: .onTrack)
    }
}

public struct PacingAccount: Codable, Hashable, Sendable, Identifiable {
    public enum State: String, LenientEnum {
        case burning, next, resting, cooling, exhausted, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var accountId: String
    public var machineId: String
    public var provider: String
    public var label: String
    public var plan: String?
    public var state: State
    public var targetAgents: Int
    public var runningAgents: Int
    /// Percent of the binding window one agent uses per hour.
    public var burnPerAgentHour: Double?
    public var windows: [PacingWindow]
    /// Minutes this subscription is forecast to sit unused before its reset.
    public var idleForecastMins: Double
    /// Advice mode: about how many more agents could run and still land at
    /// the target by the reset. Nil when the hub does not say.
    public var headroomAgents: Int?
    public var id: String { accountId }

    public init(accountId: String, machineId: String, provider: String, label: String, plan: String? = nil, state: State, targetAgents: Int, runningAgents: Int,
                burnPerAgentHour: Double? = nil, windows: [PacingWindow], idleForecastMins: Double = 0, headroomAgents: Int? = nil) {
        self.headroomAgents = headroomAgents
        self.accountId = accountId
        self.machineId = machineId
        self.provider = provider
        self.label = label
        self.plan = plan
        self.state = state
        self.targetAgents = targetAgents
        self.runningAgents = runningAgents
        self.burnPerAgentHour = burnPerAgentHour
        self.windows = windows
        self.idleForecastMins = idleForecastMins
    }

    enum CodingKeys: String, CodingKey { case accountId, id, machineId, provider, label, plan, state, targetAgents, runningAgents, burnPerAgentHour, windows, idleForecastMins, headroomAgents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.accountId) ?? c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.accountId, .init(codingPath: decoder.codingPath, debugDescription: "A paced account needs accountId."))
        }
        accountId = id
        machineId = c.lenientString(.machineId) ?? ""
        provider = c.lenientString(.provider) ?? ""
        label = c.lenientString(.label) ?? id
        plan = c.lenientString(.plan)
        state = ((try? c.decodeIfPresent(State.self, forKey: .state)) ?? nil) ?? .unknown
        targetAgents = c.lenientCount(.targetAgents)
        runningAgents = c.lenientCount(.runningAgents)
        burnPerAgentHour = c.lenientNumber(.burnPerAgentHour)
        windows = c.lossy(PacingWindow.self, .windows)
        idleForecastMins = max(0, c.lenientNumber(.idleForecastMins) ?? 0)
        headroomAgents = c.lenientNumber(.headroomAgents).map { _ in c.lenientCount(.headroomAgents) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accountId, forKey: .accountId)
        try c.encode(machineId, forKey: .machineId)
        try c.encode(provider, forKey: .provider)
        try c.encode(label, forKey: .label)
        try c.encodeIfPresent(plan, forKey: .plan)
        try c.encode(state, forKey: .state)
        try c.encode(targetAgents, forKey: .targetAgents)
        try c.encode(runningAgents, forKey: .runningAgents)
        try c.encodeIfPresent(burnPerAgentHour, forKey: .burnPerAgentHour)
        try c.encode(windows, forKey: .windows)
        try c.encode(idleForecastMins, forKey: .idleForecastMins)
        try c.encodeIfPresent(headroomAgents, forKey: .headroomAgents)
    }
}

public struct PacingSegment: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Sendable { case burn, rest }

    public var accountId: String
    public var from: Date
    public var to: Date
    public var phase: Phase

    public init(accountId: String, from: Date, to: Date, phase: Phase) {
        self.accountId = accountId
        self.from = from
        self.to = to
        self.phase = phase
    }

    enum CodingKeys: String, CodingKey { case accountId, from, to, phase }

    /// Unknown phases and empty or reversed spans fail, so `Lossy` drops them.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        from = try c.decode(Date.self, forKey: .from)
        to = try c.decode(Date.self, forKey: .to)
        phase = try c.decode(Phase.self, forKey: .phase)
        guard to > from else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "A segment must end after it starts."))
        }
    }
}

/// `PUT /pacing/settings`. Only the fields set are sent; `removeMaxAgents` sends a null maximum.
public struct PacingSettings: Encodable, Hashable, Sendable {
    public var enabled: Bool?
    public var strategy: Pacing.Strategy?
    public var targetUsePercent: Int?
    public var minAgents: Int?
    public var maxAgents: Int?
    public var removeMaxAgents = false

    public init(enabled: Bool? = nil, strategy: Pacing.Strategy? = nil, targetUsePercent: Int? = nil, minAgents: Int? = nil, maxAgents: Int? = nil, removeMaxAgents: Bool = false) {
        self.enabled = enabled
        self.strategy = strategy
        self.targetUsePercent = targetUsePercent
        self.minAgents = minAgents
        self.maxAgents = maxAgents
        self.removeMaxAgents = removeMaxAgents
    }

    enum CodingKeys: String, CodingKey { case enabled, strategy, targetUsePercent, minAgents, maxAgents }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        try c.encodeIfPresent(strategy, forKey: .strategy)
        try c.encodeIfPresent(targetUsePercent, forKey: .targetUsePercent)
        try c.encodeIfPresent(minAgents, forKey: .minAgents)
        if removeMaxAgents { try c.encodeNil(forKey: .maxAgents) } else { try c.encodeIfPresent(maxAgents, forKey: .maxAgents) }
    }

    /// Applies these settings over current ones, as the demo hub does.
    public func applied(to pacing: Pacing) -> Pacing {
        var copy = pacing
        if let enabled { copy.enabled = enabled }
        if let strategy { copy.strategy = strategy }
        if let targetUsePercent { copy.targetUsePercent = targetUsePercent }
        if let minAgents { copy.minAgents = minAgents }
        if let maxAgents { copy.maxAgents = maxAgents }
        if removeMaxAgents { copy.maxAgents = nil }
        return copy
    }
}
