import Foundation

// Storage janitor (`GET /storage`, `GET /machines/:id/storage`, cleanups).
// The contract is new, so decoding is tolerant like pacing: optional fields
// stay optional, malformed entries are dropped, numbers may arrive as
// integers, decimals or strings, and unknown enum values decode to a
// neutral case. The hub only ever names items by id; deletion happens on the
// machine, against paths it found itself.

public enum StorageState: String, LenientEnum {
    case ok, low, critical
    public static var unknownCase: Self { .ok }

    public var label: String {
        switch self {
        case .ok: "Healthy"
        case .low: "Low on space"
        case .critical: "Critically full"
        }
    }

    /// Worst first.
    public var severity: Int {
        switch self {
        case .ok: 0
        case .low: 1
        case .critical: 2
        }
    }
}

public enum StorageKind: String, LenientEnum {
    case perpetoWorkspace = "perpeto-workspace"
    case ciWorkspace = "ci-workspace"
    case ciCache = "ci-cache"
    case perpetoWorktree = "perpeto-worktree"
    case t3Worktree = "t3-worktree"
    case buildArtifact = "build-artifact"
    case globalCache = "global-cache"
    case other
    public static var unknownCase: Self { .other }

    public var label: String {
        switch self {
        case .perpetoWorkspace: "Assignment workspaces"
        case .ciWorkspace: "CI workspaces"
        case .ciCache: "CI caches"
        case .perpetoWorktree: "Perpeto worktrees"
        case .t3Worktree: "T3 worktrees"
        case .buildArtifact: "Build artifacts"
        case .globalCache: "Global caches"
        case .other: "Other"
        }
    }

    public var systemImage: String {
        switch self {
        case .perpetoWorkspace: "folder"
        case .ciWorkspace: "checkmark.seal"
        case .ciCache: "archivebox"
        case .perpetoWorktree, .t3Worktree: "arrow.triangle.branch"
        case .buildArtifact: "shippingbox"
        case .globalCache: "internaldrive"
        case .other: "doc"
        }
    }

    /// Display order for "reclaimable by kind".
    public var order: Int { StorageKind.allCases.firstIndex(of: self) ?? 99 }
}

public struct StorageDisk: Codable, Hashable, Sendable {
    public var totalBytes: Double
    public var freeBytes: Double

    public init(totalBytes: Double, freeBytes: Double) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
    }

    public var usedBytes: Double { max(0, totalBytes - freeBytes) }
    /// 0...1, free share of the disk.
    public var freeFraction: Double { totalBytes > 0 ? min(1, max(0, freeBytes / totalBytes)) : 1 }
    public var usedFraction: Double { 1 - freeFraction }

    enum CodingKeys: String, CodingKey { case totalBytes, freeBytes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let total = c.lenientNumber(.totalBytes), total > 0 else {
            throw DecodingError.keyNotFound(CodingKeys.totalBytes, .init(codingPath: decoder.codingPath, debugDescription: "A disk needs totalBytes."))
        }
        totalBytes = total
        freeBytes = min(total, max(0, c.lenientNumber(.freeBytes) ?? 0))
    }
}

/// Bytes per kind, decoded from a `{ kind: bytes }` object. Unknown kinds fold into `.other`.
public struct StorageByKind: Codable, Hashable, Sendable {
    public var bytes: [StorageKind: Double]

    public init(_ bytes: [StorageKind: Double] = [:]) { self.bytes = bytes }

    public init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode([String: JSONValue].self)) ?? [:]
        var result: [StorageKind: Double] = [:]
        for (key, value) in raw {
            let number: Double?
            switch value {
            case .number(let n): number = n
            case .string(let s): number = Double(s)
            default: number = nil
            }
            guard let number, number.isFinite, number > 0 else { continue }
            result[StorageKind(rawValue: key) ?? .other, default: 0] += number
        }
        bytes = result
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(Dictionary(uniqueKeysWithValues: bytes.map { ($0.key.rawValue, $0.value) }))
    }

    /// Largest first, then by kind order.
    public var sorted: [(kind: StorageKind, bytes: Double)] {
        bytes.map { (kind: $0.key, bytes: $0.value) }.sorted { $0.bytes == $1.bytes ? $0.kind.order < $1.kind.order : $0.bytes > $1.bytes }
    }

    public var total: Double { bytes.values.reduce(0, +) }

    public static func + (a: StorageByKind, b: StorageByKind) -> StorageByKind {
        StorageByKind(a.bytes.merging(b.bytes, uniquingKeysWith: +))
    }
}

public struct StorageTopItem: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var kind: StorageKind
    public var path: String
    public var bytes: Double
    public var reclaimable: Bool
    public var attention: Bool

    public init(id: String, kind: StorageKind, path: String, bytes: Double, reclaimable: Bool, attention: Bool = false) {
        self.id = id
        self.kind = kind
        self.path = path
        self.bytes = bytes
        self.reclaimable = reclaimable
        self.attention = attention
    }

    enum CodingKeys: String, CodingKey { case id, kind, path, bytes, reclaimable, attention }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: decoder.codingPath, debugDescription: "A storage item needs an id."))
        }
        self.id = id
        kind = (try? c.decodeIfPresent(StorageKind.self, forKey: .kind)) ?? .other
        path = c.lenientString(.path) ?? ""
        bytes = max(0, c.lenientNumber(.bytes) ?? 0)
        reclaimable = ((try? c.decodeIfPresent(Bool.self, forKey: .reclaimable)) ?? nil) ?? false
        attention = ((try? c.decodeIfPresent(Bool.self, forKey: .attention)) ?? nil) ?? false
    }
}

/// The compact summary a node sends with each heartbeat.
public struct StorageSummary: Codable, Hashable, Sendable {
    public var scannedAt: Date?
    public var state: StorageState
    public var disk: StorageDisk?
    public var truncated: Bool
    public var reclaimableBytes: Double
    public var reclaimableByKind: StorageByKind
    public var advisoryBytes: Double
    public var attentionCount: Int
    public var staleProcesses: Int
    public var items: Int
    public var top: [StorageTopItem]

    public init(scannedAt: Date?, state: StorageState, disk: StorageDisk?, truncated: Bool = false, reclaimableBytes: Double, reclaimableByKind: StorageByKind,
                advisoryBytes: Double = 0, attentionCount: Int = 0, staleProcesses: Int = 0, items: Int = 0, top: [StorageTopItem] = []) {
        self.scannedAt = scannedAt
        self.state = state
        self.disk = disk
        self.truncated = truncated
        self.reclaimableBytes = reclaimableBytes
        self.reclaimableByKind = reclaimableByKind
        self.advisoryBytes = advisoryBytes
        self.attentionCount = attentionCount
        self.staleProcesses = staleProcesses
        self.items = items
        self.top = top
    }

    enum CodingKeys: String, CodingKey { case scannedAt, state, disk, truncated, reclaimableBytes, reclaimableByKind, advisoryBytes, attentionCount, staleProcesses, items, top }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scannedAt = c.lenientDate(.scannedAt)
        state = (try? c.decodeIfPresent(StorageState.self, forKey: .state)) ?? .ok
        disk = (try? c.decodeIfPresent(StorageDisk.self, forKey: .disk)) ?? nil
        truncated = ((try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? nil) ?? false
        reclaimableBytes = max(0, c.lenientNumber(.reclaimableBytes) ?? 0)
        reclaimableByKind = ((try? c.decodeIfPresent(StorageByKind.self, forKey: .reclaimableByKind)) ?? nil) ?? StorageByKind()
        advisoryBytes = max(0, c.lenientNumber(.advisoryBytes) ?? 0)
        attentionCount = c.lenientCount(.attentionCount)
        staleProcesses = c.lenientCount(.staleProcesses)
        items = c.lenientCount(.items)
        top = c.lossy(StorageTopItem.self, .top)
    }
}

public struct StorageCleanupBrief: Codable, Hashable, Sendable {
    public var id: String
    public var mode: StorageCleanup.Mode
    public var status: StorageCleanup.Status
    public var source: String?
    public var freedBytes: Double?
    public var at: Date?

    public init(id: String, mode: StorageCleanup.Mode, status: StorageCleanup.Status, source: String? = nil, freedBytes: Double? = nil, at: Date? = nil) {
        self.id = id
        self.mode = mode
        self.status = status
        self.source = source
        self.freedBytes = freedBytes
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case id, mode, status, source, freedBytes, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: decoder.codingPath, debugDescription: "A cleanup needs an id."))
        }
        self.id = id
        mode = (try? c.decodeIfPresent(StorageCleanup.Mode.self, forKey: .mode)) ?? .dryRun
        status = (try? c.decodeIfPresent(StorageCleanup.Status.self, forKey: .status)) ?? .pending
        source = c.lenientString(.source)
        freedBytes = c.lenientNumber(.freedBytes)
        at = c.lenientDate(.at)
    }
}

/// One machine in `GET /storage`.
public struct StorageMachine: Codable, Hashable, Sendable, Identifiable {
    public var machineId: String
    public var name: String
    public var status: String?
    public var online: Bool
    public var state: StorageState
    public var storage: StorageSummary?
    public var lastCleanup: StorageCleanupBrief?

    public var id: String { machineId }

    public init(machineId: String, name: String, status: String? = "online", online: Bool = true, state: StorageState, storage: StorageSummary?, lastCleanup: StorageCleanupBrief? = nil) {
        self.machineId = machineId
        self.name = name
        self.status = status
        self.online = online
        self.state = state
        self.storage = storage
        self.lastCleanup = lastCleanup
    }

    enum CodingKeys: String, CodingKey { case machineId, name, status, online, state, storage, lastCleanup }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.machineId) else {
            throw DecodingError.keyNotFound(CodingKeys.machineId, .init(codingPath: decoder.codingPath, debugDescription: "A storage machine needs machineId."))
        }
        machineId = id
        name = c.lenientString(.name) ?? id
        status = c.lenientString(.status)
        online = ((try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? nil) ?? false
        storage = (try? c.decodeIfPresent(StorageSummary.self, forKey: .storage)) ?? nil
        state = (try? c.decodeIfPresent(StorageState.self, forKey: .state)) ?? storage?.state ?? .ok
        lastCleanup = (try? c.decodeIfPresent(StorageCleanupBrief.self, forKey: .lastCleanup)) ?? nil
    }
}

public struct StorageTotals: Codable, Hashable, Sendable {
    public var totalBytes: Double
    public var freeBytes: Double
    public var reclaimableBytes: Double
    public var advisoryBytes: Double
    public var attentionCount: Int
    public var reclaimableByKind: StorageByKind

    public init(totalBytes: Double = 0, freeBytes: Double = 0, reclaimableBytes: Double = 0, advisoryBytes: Double = 0, attentionCount: Int = 0, reclaimableByKind: StorageByKind = StorageByKind()) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.reclaimableBytes = reclaimableBytes
        self.advisoryBytes = advisoryBytes
        self.attentionCount = attentionCount
        self.reclaimableByKind = reclaimableByKind
    }

    enum CodingKeys: String, CodingKey { case totalBytes, freeBytes, reclaimableBytes, advisoryBytes, attentionCount, reclaimableByKind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalBytes = max(0, c.lenientNumber(.totalBytes) ?? 0)
        freeBytes = max(0, c.lenientNumber(.freeBytes) ?? 0)
        reclaimableBytes = max(0, c.lenientNumber(.reclaimableBytes) ?? 0)
        advisoryBytes = max(0, c.lenientNumber(.advisoryBytes) ?? 0)
        attentionCount = c.lenientCount(.attentionCount)
        reclaimableByKind = ((try? c.decodeIfPresent(StorageByKind.self, forKey: .reclaimableByKind)) ?? nil) ?? StorageByKind()
    }

    /// Totals from the machines, for hubs that omit them.
    public init(machines: [StorageMachine]) {
        self.init()
        for summary in machines.compactMap(\.storage) {
            totalBytes += summary.disk?.totalBytes ?? 0
            freeBytes += summary.disk?.freeBytes ?? 0
            reclaimableBytes += summary.reclaimableBytes
            advisoryBytes += summary.advisoryBytes
            attentionCount += summary.attentionCount
            reclaimableByKind = reclaimableByKind + summary.reclaimableByKind
        }
    }
}

public struct StorageAlert: Codable, Hashable, Sendable, Identifiable {
    public var machineId: String
    public var name: String
    public var state: StorageState
    public var severity: String
    public var evidence: String
    public var freePercent: Double?

    public var id: String { machineId }

    public init(machineId: String, name: String, state: StorageState, severity: String, evidence: String, freePercent: Double? = nil) {
        self.machineId = machineId
        self.name = name
        self.state = state
        self.severity = severity
        self.evidence = evidence
        self.freePercent = freePercent
    }

    enum CodingKeys: String, CodingKey { case machineId, name, state, severity, evidence, freePercent }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.machineId) else {
            throw DecodingError.keyNotFound(CodingKeys.machineId, .init(codingPath: decoder.codingPath, debugDescription: "An alert needs machineId."))
        }
        machineId = id
        name = c.lenientString(.name) ?? id
        state = (try? c.decodeIfPresent(StorageState.self, forKey: .state)) ?? .low
        severity = c.lenientString(.severity) ?? (state == .critical ? "critical" : "warning")
        evidence = c.lenientString(.evidence) ?? ""
        freePercent = c.lenientNumber(.freePercent)
    }
}

/// `GET /storage`: every machine's disk and reclaimable space, totals and alerts.
public struct FleetStorage: Codable, Hashable, Sendable {
    public var machines: [StorageMachine]
    public var totals: StorageTotals
    public var alerts: [StorageAlert]

    public init(machines: [StorageMachine], totals: StorageTotals? = nil, alerts: [StorageAlert] = []) {
        self.machines = machines
        self.totals = totals ?? StorageTotals(machines: machines)
        self.alerts = alerts
    }

    enum CodingKeys: String, CodingKey { case machines, totals, alerts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machines = c.lossy(StorageMachine.self, .machines)
        totals = ((try? c.decodeIfPresent(StorageTotals.self, forKey: .totals)) ?? nil) ?? StorageTotals(machines: machines)
        alerts = c.lossy(StorageAlert.self, .alerts)
    }

    /// Worst disk first, then by name.
    public var byUrgency: [StorageMachine] {
        machines.sorted { $0.state.severity == $1.state.severity ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : $0.state.severity > $1.state.severity }
    }
}

public struct StorageGitState: Codable, Hashable, Sendable {
    public var branch: String?
    public var dirty: Bool
    public var unpushedCommits: Int
    public var merged: Bool?

    public init(branch: String? = nil, dirty: Bool = false, unpushedCommits: Int = 0, merged: Bool? = nil) {
        self.branch = branch
        self.dirty = dirty
        self.unpushedCommits = unpushedCommits
        self.merged = merged
    }

    enum CodingKeys: String, CodingKey { case branch, dirty, unpushedCommits, merged }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = c.lenientString(.branch)
        dirty = ((try? c.decodeIfPresent(Bool.self, forKey: .dirty)) ?? nil) ?? false
        unpushedCommits = c.lenientCount(.unpushedCommits)
        merged = (try? c.decodeIfPresent(Bool.self, forKey: .merged)) ?? nil
    }
}

public struct StorageOwner: Codable, Hashable, Sendable {
    public var runId: String?
    public var assignmentId: String?
    public var jobId: String?
    public var threadId: String?
    public var workItemId: String?

    public init(runId: String? = nil, assignmentId: String? = nil, jobId: String? = nil, threadId: String? = nil, workItemId: String? = nil) {
        self.runId = runId
        self.assignmentId = assignmentId
        self.jobId = jobId
        self.threadId = threadId
        self.workItemId = workItemId
    }

    public var isEmpty: Bool { [runId, assignmentId, jobId, threadId, workItemId].allSatisfy { $0 == nil } }
}

public struct StorageItem: Codable, Hashable, Sendable, Identifiable {
    public enum Action: String, LenientEnum {
        case delete, strip, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var kind: StorageKind
    public var path: String
    public var bytes: Double
    public var approximate: Bool
    public var lastModifiedAt: Date?
    public var owner: StorageOwner
    public var gitState: StorageGitState?
    public var reclaimable: Bool
    public var action: Action?
    public var reason: String
    public var attention: Bool
    public var advisory: Bool
    public var parentId: String?
    public var hint: String?
    public var name: String?
    public var repo: String?
    public var ownedBy: String?

    public init(id: String, kind: StorageKind, path: String, bytes: Double, approximate: Bool = false, lastModifiedAt: Date? = nil, owner: StorageOwner = StorageOwner(),
                gitState: StorageGitState? = nil, reclaimable: Bool, action: Action? = nil, reason: String, attention: Bool = false, advisory: Bool = false,
                parentId: String? = nil, hint: String? = nil, name: String? = nil, repo: String? = nil, ownedBy: String? = nil) {
        self.id = id
        self.kind = kind
        self.path = path
        self.bytes = bytes
        self.approximate = approximate
        self.lastModifiedAt = lastModifiedAt
        self.owner = owner
        self.gitState = gitState
        self.reclaimable = reclaimable
        self.action = action
        self.reason = reason
        self.attention = attention
        self.advisory = advisory
        self.parentId = parentId
        self.hint = hint
        self.name = name
        self.repo = repo
        self.ownedBy = ownedBy
    }

    enum CodingKeys: String, CodingKey { case id, kind, path, bytes, approximate, lastModifiedAt, owner, gitState, reclaimable, action, reason, attention, advisory, parentId, hint, name, repo, ownedBy }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.id), let path = c.lenientString(.path) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: decoder.codingPath, debugDescription: "A storage item needs an id and a path."))
        }
        self.id = id
        self.path = path
        kind = (try? c.decodeIfPresent(StorageKind.self, forKey: .kind)) ?? .other
        bytes = max(0, c.lenientNumber(.bytes) ?? 0)
        approximate = ((try? c.decodeIfPresent(Bool.self, forKey: .approximate)) ?? nil) ?? false
        lastModifiedAt = c.lenientDate(.lastModifiedAt)
        owner = ((try? c.decodeIfPresent(StorageOwner.self, forKey: .owner)) ?? nil) ?? StorageOwner()
        gitState = (try? c.decodeIfPresent(StorageGitState.self, forKey: .gitState)) ?? nil
        reclaimable = ((try? c.decodeIfPresent(Bool.self, forKey: .reclaimable)) ?? nil) ?? false
        action = (try? c.decodeIfPresent(Action.self, forKey: .action)) ?? nil
        reason = c.lenientString(.reason) ?? ""
        attention = ((try? c.decodeIfPresent(Bool.self, forKey: .attention)) ?? nil) ?? false
        advisory = ((try? c.decodeIfPresent(Bool.self, forKey: .advisory)) ?? nil) ?? false
        parentId = c.lenientString(.parentId)
        hint = c.lenientString(.hint)
        name = c.lenientString(.name)
        repo = c.lenientString(.repo)
        ownedBy = c.lenientString(.ownedBy)
    }

    /// The short name to show: the item's own name, or the last path component.
    public var title: String {
        if let name { return name }
        return path.split(separator: "/").last.map(String.init) ?? path
    }
}

public struct StorageProcess: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, LenientEnum {
        case devServer = "dev-server", simulator, other
        public static var unknownCase: Self { .other }
    }

    public var kind: Kind
    public var name: String
    public var pid: Int?
    public var udid: String?
    public var elapsedSec: Double?
    public var cwd: String?
    public var cwdMissing: Bool
    public var reason: String
    public var hint: String?

    public var id: String { pid.map { "pid-\($0)" } ?? udid.map { "sim-\($0)" } ?? "\(kind.rawValue)-\(name)" }

    public init(kind: Kind, name: String, pid: Int? = nil, udid: String? = nil, elapsedSec: Double? = nil, cwd: String? = nil, cwdMissing: Bool = false, reason: String, hint: String? = nil) {
        self.kind = kind
        self.name = name
        self.pid = pid
        self.udid = udid
        self.elapsedSec = elapsedSec
        self.cwd = cwd
        self.cwdMissing = cwdMissing
        self.reason = reason
        self.hint = hint
    }

    enum CodingKeys: String, CodingKey { case kind, name, pid, udid, elapsedSec, cwd, cwdMissing, reason, hint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .other
        name = c.lenientString(.name) ?? kind.rawValue
        pid = c.lenientNumber(.pid).map { Int($0) }
        udid = c.lenientString(.udid)
        elapsedSec = c.lenientNumber(.elapsedSec)
        cwd = c.lenientString(.cwd)
        cwdMissing = ((try? c.decodeIfPresent(Bool.self, forKey: .cwdMissing)) ?? nil) ?? false
        reason = c.lenientString(.reason) ?? ""
        hint = c.lenientString(.hint)
    }
}

public struct StorageInventory: Codable, Hashable, Sendable {
    public var scannedAt: Date?
    public var truncated: Bool
    public var disk: StorageDisk?
    public var state: StorageState
    public var aggressive: Bool
    public var items: [StorageItem]
    public var processes: [StorageProcess]

    public init(scannedAt: Date?, truncated: Bool = false, disk: StorageDisk?, state: StorageState, aggressive: Bool = false, items: [StorageItem], processes: [StorageProcess] = []) {
        self.scannedAt = scannedAt
        self.truncated = truncated
        self.disk = disk
        self.state = state
        self.aggressive = aggressive
        self.items = items
        self.processes = processes
    }

    enum CodingKeys: String, CodingKey { case scannedAt, truncated, disk, state, aggressive, items, processes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scannedAt = c.lenientDate(.scannedAt)
        truncated = ((try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? nil) ?? false
        disk = (try? c.decodeIfPresent(StorageDisk.self, forKey: .disk)) ?? nil
        state = (try? c.decodeIfPresent(StorageState.self, forKey: .state)) ?? .ok
        aggressive = ((try? c.decodeIfPresent(Bool.self, forKey: .aggressive)) ?? nil) ?? false
        items = c.lossy(StorageItem.self, .items)
        processes = c.lossy(StorageProcess.self, .processes)
    }

    /// Kept work that a person should look at: dirty or unpushed.
    public var needsAttention: [StorageItem] { items.filter(\.attention).sorted { $0.bytes > $1.bytes } }
    /// What a cleanup would remove, without artifacts already inside a deleted folder.
    public var reclaimable: [StorageItem] {
        let deleted = Set(items.filter { $0.reclaimable && $0.action == .delete }.map(\.id))
        return items.filter { $0.reclaimable && !($0.parentId.map(deleted.contains) ?? false) }.sorted { $0.bytes > $1.bytes }
    }
    /// Shared caches the janitor never deletes; it shows the command instead.
    public var advisory: [StorageItem] { items.filter(\.advisory).sorted { $0.bytes > $1.bytes } }
    /// Kept, not reclaimable and not needing attention: in use, recent or foreign.
    public var kept: [StorageItem] { items.filter { !$0.reclaimable && !$0.attention && !$0.advisory && $0.parentId == nil }.sorted { $0.bytes > $1.bytes } }
    public var reclaimableBytes: Double { reclaimable.reduce(0) { $0 + $1.bytes } }
}

/// `GET /machines/:id/storage`.
public struct MachineStorage: Codable, Hashable, Sendable {
    public var machineId: String
    public var name: String
    public var online: Bool
    public var state: StorageState
    public var storage: StorageSummary?
    public var inventory: StorageInventory?
    public var scanRequestedAt: Date?
    public var cleanups: [StorageCleanup]

    public init(machineId: String, name: String, online: Bool = true, state: StorageState, storage: StorageSummary?, inventory: StorageInventory?,
                scanRequestedAt: Date? = nil, cleanups: [StorageCleanup] = []) {
        self.machineId = machineId
        self.name = name
        self.online = online
        self.state = state
        self.storage = storage
        self.inventory = inventory
        self.scanRequestedAt = scanRequestedAt
        self.cleanups = cleanups
    }

    enum CodingKeys: String, CodingKey { case machineId, name, online, state, storage, inventory, scanRequestedAt, cleanups }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.machineId) else {
            throw DecodingError.keyNotFound(CodingKeys.machineId, .init(codingPath: decoder.codingPath, debugDescription: "Machine storage needs machineId."))
        }
        machineId = id
        name = c.lenientString(.name) ?? id
        online = ((try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? nil) ?? false
        storage = (try? c.decodeIfPresent(StorageSummary.self, forKey: .storage)) ?? nil
        inventory = (try? c.decodeIfPresent(StorageInventory.self, forKey: .inventory)) ?? nil
        state = (try? c.decodeIfPresent(StorageState.self, forKey: .state)) ?? storage?.state ?? .ok
        scanRequestedAt = c.lenientDate(.scanRequestedAt)
        cleanups = c.lossy(StorageCleanup.self, .cleanups)
    }
}

public struct StorageCleanupAction: Codable, Hashable, Sendable, Identifiable {
    public enum Status: String, LenientEnum {
        case deleted, stripped
        case wouldDelete = "would-delete", wouldStrip = "would-strip"
        case skipped
        case needsAttention = "needs-attention"
        case failed
        public static var unknownCase: Self { .skipped }

        public var label: String {
            switch self {
            case .deleted: "Deleted"
            case .stripped: "Stripped"
            case .wouldDelete: "Would delete"
            case .wouldStrip: "Would strip"
            case .skipped: "Skipped"
            case .needsAttention: "Needs attention"
            case .failed: "Failed"
            }
        }

        /// Bytes counted toward what the cleanup frees (or would free).
        public var frees: Bool { [.deleted, .stripped, .wouldDelete, .wouldStrip].contains(self) }
    }

    public var itemId: String
    public var kind: StorageKind?
    public var path: String?
    public var action: StorageItem.Action?
    public var bytes: Double
    public var status: Status
    public var reason: String?

    public var id: String { itemId }

    public init(itemId: String, kind: StorageKind? = nil, path: String? = nil, action: StorageItem.Action? = nil, bytes: Double, status: Status, reason: String? = nil) {
        self.itemId = itemId
        self.kind = kind
        self.path = path
        self.action = action
        self.bytes = bytes
        self.status = status
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case itemId, kind, path, action, bytes, status, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.itemId) else {
            throw DecodingError.keyNotFound(CodingKeys.itemId, .init(codingPath: decoder.codingPath, debugDescription: "An action needs itemId."))
        }
        itemId = id
        kind = (try? c.decodeIfPresent(StorageKind.self, forKey: .kind)) ?? nil
        path = c.lenientString(.path)
        action = (try? c.decodeIfPresent(StorageItem.Action.self, forKey: .action)) ?? nil
        bytes = max(0, c.lenientNumber(.bytes) ?? 0)
        status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .skipped
        reason = c.lenientString(.reason)
    }
}

public struct StorageCleanupResult: Codable, Hashable, Sendable {
    public var dryRun: Bool
    public var freedBytes: Double
    public var actions: [StorageCleanupAction]

    public init(dryRun: Bool, freedBytes: Double, actions: [StorageCleanupAction]) {
        self.dryRun = dryRun
        self.freedBytes = freedBytes
        self.actions = actions
    }

    enum CodingKeys: String, CodingKey { case dryRun, freedBytes, actions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dryRun = ((try? c.decodeIfPresent(Bool.self, forKey: .dryRun)) ?? nil) ?? false
        actions = c.lossy(StorageCleanupAction.self, .actions)
        freedBytes = max(0, c.lenientNumber(.freedBytes) ?? actions.filter(\.status.frees).reduce(0) { $0 + $1.bytes })
    }

    /// Items the cleanup removes (or would remove).
    public var freeing: [StorageCleanupAction] { actions.filter(\.status.frees) }
    /// Items it left alone, with the reason.
    public var held: [StorageCleanupAction] { actions.filter { !$0.status.frees } }
}

public struct StorageCleanup: Codable, Hashable, Sendable, Identifiable {
    public enum Mode: String, LenientEnum {
        case dryRun = "dry-run", execute
        public static var unknownCase: Self { .dryRun }
    }

    public enum Status: String, LenientEnum {
        case pending, running, completed
        public static var unknownCase: Self { .pending }
    }

    public var id: String
    public var machineId: String
    public var mode: Mode
    public var source: String?
    public var status: Status
    public var itemIds: [String]?
    public var requestedAt: Date?
    public var completedAt: Date?
    public var result: StorageCleanupResult?

    public init(id: String, machineId: String, mode: Mode, source: String? = "owner", status: Status, itemIds: [String]? = nil, requestedAt: Date? = nil,
                completedAt: Date? = nil, result: StorageCleanupResult? = nil) {
        self.id = id
        self.machineId = machineId
        self.mode = mode
        self.source = source
        self.status = status
        self.itemIds = itemIds
        self.requestedAt = requestedAt
        self.completedAt = completedAt
        self.result = result
    }

    enum CodingKeys: String, CodingKey { case id, machineId, mode, source, status, itemIds, requestedAt, completedAt, result }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenientString(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: decoder.codingPath, debugDescription: "A cleanup needs an id."))
        }
        self.id = id
        machineId = c.lenientString(.machineId) ?? ""
        mode = (try? c.decodeIfPresent(Mode.self, forKey: .mode)) ?? .dryRun
        source = c.lenientString(.source)
        status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .pending
        itemIds = (try? c.decodeIfPresent([String].self, forKey: .itemIds)) ?? nil
        requestedAt = c.lenientDate(.requestedAt)
        completedAt = c.lenientDate(.completedAt)
        result = (try? c.decodeIfPresent(StorageCleanupResult.self, forKey: .result)) ?? nil
    }

    public var isDone: Bool { status == .completed }
}

/// `POST /machines/:id/storage/cleanup`.
public struct StorageCleanupRequest: Encodable, Sendable, Hashable {
    public var mode: StorageCleanup.Mode
    public var itemIds: [String]?

    public init(mode: StorageCleanup.Mode, itemIds: [String]? = nil) {
        self.mode = mode
        self.itemIds = itemIds
    }

    enum CodingKeys: String, CodingKey { case mode, itemIds }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mode.rawValue, forKey: .mode)
        if let itemIds, !itemIds.isEmpty { try c.encode(itemIds, forKey: .itemIds) }
    }
}

/// Byte sizes and sentences for the storage screens.
public enum StorageText {
    /// Decimal units like the Finder: "29.4 GB", "812 MB", "4 KB".
    public static func bytes(_ value: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var amount = max(0, value)
        var index = 0
        while amount >= 1000 && index < units.count - 1 {
            amount /= 1000
            index += 1
        }
        if index == 0 { return "\(Int(amount)) B" }
        let text = amount >= 100 ? String(Int(amount.rounded())) : String(format: "%.1f", amount).replacingOccurrences(of: ".0", with: "")
        return "\(text) \(units[index])"
    }

    public static func percent(_ fraction: Double) -> String {
        let value = fraction * 100
        return value > 0 && value < 10 ? String(format: "%.1f%%", value).replacingOccurrences(of: ".0%", with: "%") : "\(Int(value.rounded()))%"
    }

    /// "4% free of 1 TB" for a disk.
    public static func free(_ disk: StorageDisk) -> String {
        "\(bytes(disk.freeBytes)) free of \(bytes(disk.totalBytes))"
    }

    /// One line on what the state means for the machine.
    public static func consequence(_ state: StorageState) -> String? {
        switch state {
        case .ok: nil
        case .low: "Aggressive retention is on."
        case .critical: "New agent work is paused on this machine."
        }
    }

    /// The headline for the fleet: the worst machine, or the space a cleanup would free.
    public static func headline(_ fleet: FleetStorage) -> (lead: String, detail: String) {
        let reclaim = fleet.totals.reclaimableBytes
        let detail = reclaim > 0 ? "\(bytes(reclaim)) can be reclaimed across \(fleet.machines.count == 1 ? "1 machine" : "\(fleet.machines.count) machines")" : "Nothing to reclaim right now"
        if let worst = fleet.byUrgency.first, worst.state != .ok {
            let free = worst.storage?.disk.map { " at \(percent($0.freeFraction)) free" } ?? ""
            return ("\(worst.name) is \(worst.state == .critical ? "critically full" : "low on space")\(free)", detail)
        }
        return ("Every disk has room", detail)
    }

    /// Why a kept item is kept, or what it is.
    public static func gitLine(_ git: StorageGitState) -> String {
        var parts: [String] = []
        if let branch = git.branch { parts.append(branch) }
        if git.dirty { parts.append("uncommitted changes") }
        if git.unpushedCommits > 0 { parts.append(git.unpushedCommits == 1 ? "1 unpushed commit" : "\(git.unpushedCommits) unpushed commits") }
        if git.merged == true { parts.append("merged") }
        return parts.joined(separator: " · ")
    }

    public static func elapsed(_ seconds: Double) -> String {
        let hours = seconds / 3600
        if hours >= 48 { return "\(Int(hours / 24)) days" }
        if hours >= 1 { return "\(Int(hours)) h" }
        return "\(max(1, Int(seconds / 60))) min"
    }
}
