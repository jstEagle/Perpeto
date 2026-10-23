import Foundation

// Fleet: machine health, the owner's schedule and the hub's placement
// verdict (`GET /machines`, `PATCH /machines/:id`). Older hubs omit all
// three, so every field is optional or defaulted, malformed values are
// dropped, numbers may arrive as strings, and unknown enum values decode to
// a neutral case instead of failing the machine list.

extension KeyedDecodingContainer {
    func lenientBool(_ key: Key) -> Bool? { (try? decodeIfPresent(Bool.self, forKey: key)) ?? nil }

    func lenientInt(_ key: Key) -> Int? { lenientNumber(key).map { max(0, Int($0.rounded())) } }

    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
}

/// What a machine's node last reported about itself.
public struct MachineHealth: Codable, Hashable, Sendable {
    public struct Memory: Codable, Hashable, Sendable {
        public enum Pressure: String, LenientEnum {
            case normal, warn, critical, unknown
            public static var unknownCase: Self { .unknown }
        }
        public var totalBytes: Double
        public var freeBytes: Double
        public var pressure: Pressure?

        public init(totalBytes: Double, freeBytes: Double, pressure: Pressure? = nil) {
            self.totalBytes = totalBytes
            self.freeBytes = freeBytes
            self.pressure = pressure
        }

        enum CodingKeys: String, CodingKey { case totalBytes, freeBytes, pressure }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalBytes = c.lenientNumber(.totalBytes) ?? 0
            freeBytes = c.lenientNumber(.freeBytes) ?? 0
            pressure = c.lenient(Pressure.self, .pressure)
        }
    }

    public struct Power: Codable, Hashable, Sendable {
        public enum Source: String, LenientEnum {
            case ac, battery, unknown
            public static var unknownCase: Self { .unknown }
        }
        public var source: Source
        public var percent: Double?
        public var charging: Bool?

        public init(source: Source, percent: Double? = nil, charging: Bool? = nil) {
            self.source = source
            self.percent = percent
            self.charging = charging
        }

        enum CodingKeys: String, CodingKey { case source, percent, charging }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            source = c.lenient(Source.self, .source) ?? .unknown
            percent = c.lenientNumber(.percent)
            charging = c.lenientBool(.charging)
        }
    }

    public enum Thermal: String, LenientEnum {
        case nominal, fair, serious, critical, unknown
        public static var unknownCase: Self { .unknown }
    }

    public struct Runtime: Codable, Hashable, Sendable {
        public var reachable: Bool?
        public init(reachable: Bool?) { self.reachable = reachable }
        enum CodingKeys: String, CodingKey { case reachable }
        public init(from decoder: Decoder) throws {
            reachable = try decoder.container(keyedBy: CodingKeys.self).lenientBool(.reachable)
        }
    }

    public struct Disk: Codable, Hashable, Sendable {
        public var totalBytes: Double
        public var freeBytes: Double
        public init(totalBytes: Double, freeBytes: Double) {
            self.totalBytes = totalBytes
            self.freeBytes = freeBytes
        }
        enum CodingKeys: String, CodingKey { case totalBytes, freeBytes }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalBytes = c.lenientNumber(.totalBytes) ?? 0
            freeBytes = c.lenientNumber(.freeBytes) ?? 0
        }
    }

    public struct Storage: Codable, Hashable, Sendable {
        public enum State: String, LenientEnum {
            case ok, low, critical, unknown
            public static var unknownCase: Self { .unknown }
        }
        public var state: State
        public init(state: State) { self.state = state }
        enum CodingKeys: String, CodingKey { case state }
        public init(from decoder: Decoder) throws {
            state = try decoder.container(keyedBy: CodingKeys.self).lenient(State.self, .state) ?? .unknown
        }
    }

    public var reportedAt: Date?
    public var cpus: Int?
    /// 1, 5 and 15 minute load averages.
    public var load: [Double]?
    public var memory: Memory?
    public var processes: Int?
    public var power: Power?
    public var thermal: Thermal?
    public var uptimeSec: Double?
    public var nodeVersion: String?
    public var runtime: Runtime?
    public var disk: Disk?
    public var storage: Storage?

    public init(reportedAt: Date? = nil, cpus: Int? = nil, load: [Double]? = nil, memory: Memory? = nil, processes: Int? = nil, power: Power? = nil,
                thermal: Thermal? = nil, uptimeSec: Double? = nil, nodeVersion: String? = nil, runtime: Runtime? = nil, disk: Disk? = nil, storage: Storage? = nil) {
        self.reportedAt = reportedAt
        self.cpus = cpus
        self.load = load
        self.memory = memory
        self.processes = processes
        self.power = power
        self.thermal = thermal
        self.uptimeSec = uptimeSec
        self.nodeVersion = nodeVersion
        self.runtime = runtime
        self.disk = disk
        self.storage = storage
    }

    enum CodingKeys: String, CodingKey { case reportedAt, cpus, load, memory, processes, power, thermal, uptimeSec, nodeVersion, runtime, disk, storage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reportedAt = c.lenientDate(.reportedAt)
        cpus = c.lenientInt(.cpus).flatMap { $0 > 0 ? $0 : nil }
        let load = c.lenient([Double?].self, .load)?.compactMap { $0 }.filter(\.isFinite)
        self.load = load?.isEmpty == false ? load : nil
        memory = c.lenient(Memory.self, .memory)
        processes = c.lenientInt(.processes)
        power = c.lenient(Power.self, .power)
        thermal = c.lenient(Thermal.self, .thermal)
        uptimeSec = c.lenientNumber(.uptimeSec)
        nodeVersion = c.lenientString(.nodeVersion)
        runtime = c.lenient(Runtime.self, .runtime)
        disk = c.lenient(Disk.self, .disk)
        storage = c.lenient(Storage.self, .storage)
    }
}

/// What the owner set for a machine.
public struct MachineSchedule: Codable, Hashable, Sendable {
    public var cordoned: Bool
    public var drain: Bool
    public var weight: Double
    public var maxAgents: Int?
    public var maxJobs: Int?
    public var labels: [String]?
    public var allowOnBattery: Bool?
    public var updatedAt: Date?

    public init(cordoned: Bool = false, drain: Bool = false, weight: Double = 1, maxAgents: Int? = nil, maxJobs: Int? = nil, labels: [String]? = nil,
                allowOnBattery: Bool? = nil, updatedAt: Date? = nil) {
        self.cordoned = cordoned
        self.drain = drain
        self.weight = weight
        self.maxAgents = maxAgents
        self.maxJobs = maxJobs
        self.labels = labels
        self.allowOnBattery = allowOnBattery
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey { case cordoned, drain, weight, maxAgents, maxJobs, labels, allowOnBattery, updatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cordoned = c.lenientBool(.cordoned) ?? false
        drain = c.lenientBool(.drain) ?? false
        weight = c.lenientNumber(.weight) ?? 1
        maxAgents = c.lenientInt(.maxAgents)
        maxJobs = c.lenientInt(.maxJobs)
        labels = c.lenient([String].self, .labels)
        allowOnBattery = c.lenientBool(.allowOnBattery)
        updatedAt = c.lenientDate(.updatedAt)
    }
}

/// The hub's verdict on whether a machine takes new work, and why not.
public struct MachinePlacement: Codable, Hashable, Sendable {
    public enum Status: String, LenientEnum {
        case online, limited, overloaded, cordoned, draining, drained, offline, unknown
        public static var unknownCase: Self { .unknown }
    }

    public struct Slots: Codable, Hashable, Sendable {
        public var agents: Int
        public var jobs: Int
        public init(agents: Int, jobs: Int) {
            self.agents = agents
            self.jobs = jobs
        }
        enum CodingKeys: String, CodingKey { case agents, jobs }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            agents = c.lenientCount(.agents)
            jobs = c.lenientCount(.jobs)
        }
    }

    public struct Reason: Codable, Hashable, Sendable, Identifiable {
        public enum Effect: String, LenientEnum {
            case blocks, blocksAgents = "blocks-agents", blocksJobs = "blocks-jobs", reduces, info
            public static var unknownCase: Self { .info }
        }
        public var code: String
        public var message: String
        public var effect: Effect
        public var id: String { code + "\u{1F}" + message }

        public init(code: String, message: String, effect: Effect) {
            self.code = code
            self.message = message
            self.effect = effect
        }

        enum CodingKeys: String, CodingKey { case code, message, effect }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let code = c.lenientString(.code)
            guard let message = c.lenientString(.message) ?? code else {
                throw DecodingError.keyNotFound(CodingKeys.message, .init(codingPath: decoder.codingPath, debugDescription: "A reason needs a message or a code."))
            }
            self.code = code ?? "unknown"
            self.message = message
            effect = c.lenient(Effect.self, .effect) ?? .info
        }
    }

    public var status: Status
    public var accepting: Bool
    public var configured: Slots
    public var effective: Slots
    public var held: Slots
    public var loadPerCore: Double?
    public var weight: Double
    public var reasons: [Reason]

    public init(status: Status, accepting: Bool, configured: Slots, effective: Slots, held: Slots, loadPerCore: Double? = nil, weight: Double = 1, reasons: [Reason] = []) {
        self.status = status
        self.accepting = accepting
        self.configured = configured
        self.effective = effective
        self.held = held
        self.loadPerCore = loadPerCore
        self.weight = weight
        self.reasons = reasons
    }

    enum CodingKeys: String, CodingKey { case status, accepting, configured, effective, held, loadPerCore, weight, reasons }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(Status.self, .status) ?? .unknown
        let zero = Slots(agents: 0, jobs: 0)
        configured = c.lenient(Slots.self, .configured) ?? zero
        effective = c.lenient(Slots.self, .effective) ?? configured
        held = c.lenient(Slots.self, .held) ?? zero
        accepting = c.lenientBool(.accepting) ?? (status == .online || status == .limited)
        loadPerCore = c.lenientNumber(.loadPerCore)
        weight = c.lenientNumber(.weight) ?? 1
        reasons = c.lossy(Reason.self, .reasons)
    }
}

/// Body of `PATCH /machines/:id`. Unset fields are left out, so the hub
/// keeps their current value.
public struct MachinePatch: Encodable, Hashable, Sendable {
    public var cordoned: Bool?
    public var drain: Bool?
    public var weight: Double?
    public var maxAgents: Int?
    public var maxJobs: Int?
    public var allowOnBattery: Bool?

    public init(cordoned: Bool? = nil, drain: Bool? = nil, weight: Double? = nil, maxAgents: Int? = nil, maxJobs: Int? = nil, allowOnBattery: Bool? = nil) {
        self.cordoned = cordoned
        self.drain = drain
        self.weight = weight
        self.maxAgents = maxAgents
        self.maxJobs = maxJobs
        self.allowOnBattery = allowOnBattery
    }

    public static let cordon = MachinePatch(cordoned: true)
    /// Uncordoning also stops a drain.
    public static let uncordon = MachinePatch(cordoned: false, drain: false)
    public static let drain = MachinePatch(drain: true)
}
