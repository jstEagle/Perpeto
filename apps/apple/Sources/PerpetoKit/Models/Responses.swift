import Foundation

// Response bodies whose exact envelope the contract leaves open. Each decoder
// is deliberately tolerant and documented in docs/handoffs/apple-app.md.

/// The hub owner's display name and initials, from `GET /owner`, `/session` and `/overview`.
public struct OwnerProfile: Codable, Hashable, Sendable {
    public var name: String?
    public var initials: String?
    public init(name: String?, initials: String?) {
        self.name = name
        self.initials = initials
    }
}

/// `GET /overview`: counts for dashboards, and the owner.
public struct FactoryOverview: Codable, Hashable, Sendable {
    public var owner: OwnerProfile?
    /// Active and paused runs with their settings, intake and budget use.
    public var runs: [Run]?
    public var activeAgents: Int
    public var queuedWork: Int
    public var tokensToday: Int
    public var machinesOnline: Int

    public init(activeAgents: Int, queuedWork: Int, tokensToday: Int, machinesOnline: Int, owner: OwnerProfile? = nil) {
        self.owner = owner
        self.activeAgents = activeAgents
        self.queuedWork = queuedWork
        self.tokensToday = tokensToday
        self.machinesOnline = machinesOnline
    }

    enum CodingKeys: String, CodingKey { case owner, runs, activeAgents, queuedWork, tokensToday, machinesOnline }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        owner = try? c.decodeIfPresent(OwnerProfile.self, forKey: .owner)
        runs = (try? c.decodeIfPresent(Lossy<Run>.self, forKey: .runs))?.elements
        activeAgents = try c.decodeIfPresent(Int.self, forKey: .activeAgents) ?? 0
        queuedWork = try c.decodeIfPresent(Int.self, forKey: .queuedWork) ?? 0
        tokensToday = try c.decodeIfPresent(Int.self, forKey: .tokensToday) ?? 0
        machinesOnline = try c.decodeIfPresent(Int.self, forKey: .machinesOnline) ?? 0
    }
}

public enum UsageGrouping: String, CaseIterable, Sendable, Identifiable {
    case provider, model, machine, day, role
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
            case .role: record.role ?? "unknown"
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

/// Delivery evidence for an addressed message. States only move forward:
/// stored, then delivered (in the first prompt, steered into a running turn,
/// or read), then acknowledged. None proves a model understood or complied.
public struct Receipt: Codable, Hashable, Sendable {
    public enum State: String, LenientEnum {
        case stored, delivered, acked, unknown
        public static var unknownCase: Self { .unknown }
    }

    public enum Via: String, LenientEnum {
        case prompt, steer, read, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var state: State
    public var deliveredAt: Date?
    public var deliveredVia: Via?
    public var deliveredTo: String?
    public var ackedAt: Date?
    public var ackNote: String?

    public init(state: State, deliveredAt: Date? = nil, deliveredVia: Via? = nil, deliveredTo: String? = nil, ackedAt: Date? = nil, ackNote: String? = nil) {
        self.state = state
        self.deliveredAt = deliveredAt
        self.deliveredVia = deliveredVia
        self.deliveredTo = deliveredTo
        self.ackedAt = ackedAt
        self.ackNote = ackNote
    }
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public enum SenderKind: String, LenientEnum {
        case owner, agent, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var projectId: String
    public var channelId: String
    public var senderRoleId: String
    /// Nil addresses the whole channel.
    public var recipientRoleId: String?
    public var body: String
    public var createdAt: Date
    /// The root message's id; a root is its own thread.
    public var threadId: String
    public var parentId: String?
    public var senderKind: SenderKind?
    public var senderAssignmentId: String?
    /// An agent send outside the run's messages edges, stored under the flag policy.
    public var unplanned: Bool
    /// Addressed messages only.
    public var receipt: Receipt?

    public init(
        id: String, projectId: String, channelId: String, senderRoleId: String, recipientRoleId: String? = nil, body: String, createdAt: Date,
        threadId: String? = nil, parentId: String? = nil, senderKind: SenderKind? = nil, senderAssignmentId: String? = nil,
        unplanned: Bool = false, receipt: Receipt? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.channelId = channelId
        self.senderRoleId = senderRoleId
        self.recipientRoleId = recipientRoleId
        self.body = body
        self.createdAt = createdAt
        self.threadId = threadId ?? id
        self.parentId = parentId
        self.senderKind = senderKind
        self.senderAssignmentId = senderAssignmentId
        self.unplanned = unplanned
        self.receipt = receipt
    }

    enum CodingKeys: String, CodingKey {
        case id, projectId, channelId, senderRoleId, recipientRoleId, body, createdAt, threadId, parentId, senderKind, senderAssignmentId, unplanned, receipt
    }

    /// Hubs before messaging v2 send none of the thread or receipt fields.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id, projectId: try c.decode(String.self, forKey: .projectId), channelId: try c.decode(String.self, forKey: .channelId),
            senderRoleId: try c.decode(String.self, forKey: .senderRoleId), recipientRoleId: try c.decodeIfPresent(String.self, forKey: .recipientRoleId),
            body: try c.decode(String.self, forKey: .body), createdAt: try c.decode(Date.self, forKey: .createdAt),
            threadId: try c.decodeIfPresent(String.self, forKey: .threadId), parentId: try c.decodeIfPresent(String.self, forKey: .parentId),
            senderKind: try c.decodeIfPresent(SenderKind.self, forKey: .senderKind),
            senderAssignmentId: try c.decodeIfPresent(String.self, forKey: .senderAssignmentId),
            unplanned: try c.decodeIfPresent(Bool.self, forKey: .unplanned) ?? false,
            receipt: try? c.decodeIfPresent(Receipt.self, forKey: .receipt))
    }

    public var isRoot: Bool { parentId == nil }
}

/// `GET …/unread?roleId=`: messages addressed to the role or the channel,
/// not sent by it, after its read cursor.
public struct UnreadState: Codable, Hashable, Sendable {
    public var roleId: String
    public var messages: [Message]
    public var unreadCount: Int
    public var lastReadMessageId: String?

    public init(roleId: String, messages: [Message] = [], unreadCount: Int, lastReadMessageId: String? = nil) {
        self.roleId = roleId
        self.messages = messages
        self.unreadCount = unreadCount
        self.lastReadMessageId = lastReadMessageId
    }

    enum CodingKeys: String, CodingKey { case roleId, messages, unreadCount, lastReadMessageId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        roleId = try c.decode(String.self, forKey: .roleId)
        messages = try c.decodeIfPresent([Message].self, forKey: .messages) ?? []
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? messages.count
        lastReadMessageId = try c.decodeIfPresent(String.self, forKey: .lastReadMessageId)
    }
}

/// Who a message goes to. A reply with `.parentSender` answers whoever sent
/// the parent; `.everyone` addresses the whole channel.
public enum MessageRecipient: Hashable, Sendable {
    case role(String)
    case everyone
    case parentSender
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
