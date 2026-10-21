import Foundation

// Response bodies whose exact envelope the contract leaves open. Each decoder
// is deliberately tolerant and documented in docs/handoffs/apple-app.md.

/// `GET /overview`: counts for dashboards.
public struct FactoryOverview: Codable, Hashable, Sendable {
    public var activeAgents: Int
    public var queuedWork: Int
    public var tokensToday: Int
    public var machinesOnline: Int

    public init(activeAgents: Int, queuedWork: Int, tokensToday: Int, machinesOnline: Int) {
        self.activeAgents = activeAgents
        self.queuedWork = queuedWork
        self.tokensToday = tokensToday
        self.machinesOnline = machinesOnline
    }

    enum CodingKeys: String, CodingKey { case activeAgents, queuedWork, tokensToday, machinesOnline }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activeAgents = try c.decodeIfPresent(Int.self, forKey: .activeAgents) ?? 0
        queuedWork = try c.decodeIfPresent(Int.self, forKey: .queuedWork) ?? 0
        tokensToday = try c.decodeIfPresent(Int.self, forKey: .tokensToday) ?? 0
        machinesOnline = try c.decodeIfPresent(Int.self, forKey: .machinesOnline) ?? 0
    }
}

public enum UsageGrouping: String, CaseIterable, Sendable, Identifiable {
    case provider, model, machine, day
    public var id: String { rawValue }
}

/// One row of `GET /usage?groupBy=`.
public struct UsageGroup: Codable, Hashable, Identifiable, Sendable {
    public var key: String
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    /// The hub reports 0 when providers gave no cost.
    public var costUsd: Double?
    /// Usage records in the group.
    public var records: Int?

    public var id: String { key }
    public var totalTokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens }

    public init(key: String, inputTokens: Int, outputTokens: Int, cacheReadTokens: Int, cacheWriteTokens: Int, costUsd: Double? = nil) {
        self.key = key
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
    }

    /// Aggregates raw records client-side, matching the hub's grouping keys.
    public static func group(_ records: [UsageRecord], by grouping: UsageGrouping, calendar: Calendar = .utc) -> [UsageGroup] {
        let dayFormat = Date.ISO8601FormatStyle().year().month().day()
        let buckets = Dictionary(grouping: records) { record -> String in
            switch grouping {
            case .provider: record.provider
            case .model: record.model
            case .machine: record.machineId
            case .day: calendar.startOfDay(for: record.at).formatted(dayFormat)
            }
        }
        return buckets.map { key, rows in
            UsageGroup(
                key: key,
                inputTokens: rows.reduce(0) { $0 + $1.inputTokens },
                outputTokens: rows.reduce(0) { $0 + $1.outputTokens },
                cacheReadTokens: rows.reduce(0) { $0 + $1.cacheReadTokens },
                cacheWriteTokens: rows.reduce(0) { $0 + $1.cacheWriteTokens },
                costUsd: rows.contains { $0.costUsd != nil } ? rows.reduce(0) { $0 + ($1.costUsd ?? 0) } : nil
            )
        }.sorted { $0.key < $1.key }
    }
}

extension Calendar {
    public static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
}

/// `POST /machines/enrollment-codes`
public struct EnrollmentCode: Codable, Hashable, Sendable {
    public var code: String
    public var expiresAt: Date?
    public init(code: String, expiresAt: Date? = nil) {
        self.code = code
        self.expiresAt = expiresAt
    }
}

/// `GET /health`: `{ status: "ok", version }`
public struct HubHealth: Codable, Hashable, Sendable {
    public var status: String?
    public var version: String?
}

/// `{ accepted: true }`, returned by decisions and run inputs.
public struct Accepted: Codable, Hashable, Sendable {
    public var accepted: Bool
}

/// `GET /events`: one page in ascending `seq` order. `nextCursor` is the last
/// returned `seq`, or the requested `after` when the page is empty.
public struct EventPage: Codable, Hashable, Sendable {
    public var events: [HubEvent]
    public var nextCursor: Int?
}

/// `GET /jobs/:id/log`
public struct JobLog: Codable, Hashable, Sendable {
    public struct Chunk: Codable, Hashable, Sendable {
        public var chunk: String
        public var at: Date?
    }
    public var jobId: String
    public var chunks: [Chunk]
    public var text: String { chunks.map(\.chunk).joined() }
}

// MARK: - Messaging (@perpeto/messaging model, served under /api/v1/messaging)

public struct Channel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var projectId: String
    public var channelId: String
    public var senderRoleId: String
    public var recipientRoleId: String?
    public var body: String
    public var createdAt: Date

    public init(id: String, projectId: String, channelId: String, senderRoleId: String, recipientRoleId: String? = nil, body: String, createdAt: Date) {
        self.id = id
        self.projectId = projectId
        self.channelId = channelId
        self.senderRoleId = senderRoleId
        self.recipientRoleId = recipientRoleId
        self.body = body
        self.createdAt = createdAt
    }
}

public struct MessagePage: Codable, Hashable, Sendable {
    public var messages: [Message]
    public var previousCursor: String?
    public var nextCursor: String?
    public var hasMore: Bool

    public init(messages: [Message], previousCursor: String? = nil, nextCursor: String? = nil, hasMore: Bool = false) {
        self.messages = messages
        self.previousCursor = previousCursor
        self.nextCursor = nextCursor
        self.hasMore = hasMore
    }
}

/// Hub list responses hold one array named after the resource, for example
/// `{ "projects": [...] }` or `{ "groups": [...], "totals": {...} }`.
struct KeyedList<Element: Decodable>: Decodable {
    static var keyInfo: CodingUserInfoKey { CodingUserInfoKey(rawValue: "perpeto.listKey")! }

    var items: [Element]

    struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        guard let key = decoder.userInfo[Self.keyInfo] as? String else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No list key configured."))
        }
        items = try decoder.container(keyedBy: AnyKey.self).decode([Element].self, forKey: AnyKey(stringValue: key))
    }
}
