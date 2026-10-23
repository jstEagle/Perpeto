import Foundation

/// Which machines the Fleet screen lists.
public enum FleetFilter: String, CaseIterable, Sendable, Hashable, Identifiable {
    case all, accepting, notAccepting

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "All"
        case .accepting: "Accepting"
        case .notAccepting: "Not accepting"
        }
    }
}

/// What the owner can do to one machine from the Fleet screen.
public enum FleetAction: String, CaseIterable, Sendable, Hashable, Identifiable {
    case cordon, uncordon, drain

    public var id: String { rawValue }

    public var patch: MachinePatch {
        switch self {
        case .cordon: .cordon
        case .uncordon: .uncordon
        case .drain: .drain
        }
    }

    /// Drain keeps the machine out of rotation until someone undoes it, so it asks first.
    public var needsConfirmation: Bool { self == .drain }
}

/// Running work against the slots a machine has right now.
public struct FleetSlots: Hashable, Sendable {
    public var held: MachinePlacement.Slots
    public var effective: MachinePlacement.Slots
    public var configured: MachinePlacement.Slots
}

/// One line of health: "Load" · "13.0 per core" · "130 · 118 · 96 on 10 cores".
public struct FleetFact: Hashable, Sendable, Identifiable {
    public var label: String
    public var value: String
    public var detail: String?
    /// True when this fact is why the machine is held back; shown in ink.
    public var concern: Bool
    public var id: String { label }

    public init(_ label: String, value: String, detail: String? = nil, concern: Bool = false) {
        self.label = label
        self.value = value
        self.detail = detail
        self.concern = concern
    }
}

/// Words and numbers for the Fleet screen, kept here so they are tested
/// alongside decoding. Every function falls back to the legacy fields when
/// an older hub sends no health, schedule or placement.
public enum FleetText {
    /// Default per-core load limit, used only when the hub sends no verdict.
    public static let loadLimit = 1.5

    public static func status(_ machine: Machine) -> MachinePlacement.Status {
        if let status = machine.placement?.status, status != .unknown { return status }
        if machine.revokedAt != nil || machine.status == .offline { return .offline }
        if machine.schedule?.drain == true || machine.status == .draining {
            return machine.running.agents + machine.running.jobs > 0 ? .draining : .drained
        }
        if machine.schedule?.cordoned == true { return .cordoned }
        return .online
    }

    public static func statusLabel(_ status: MachinePlacement.Status) -> String {
        switch status {
        case .online: "Online"
        case .limited: "Limited"
        case .overloaded: "Overloaded"
        case .cordoned: "Cordoned"
        case .draining: "Draining"
        case .drained: "Drained"
        case .offline: "Offline"
        case .unknown: "Unknown"
        }
    }

    /// Whether the hub will place new work here.
    public static func accepting(_ machine: Machine) -> Bool {
        if let placement = machine.placement { return placement.accepting }
        let status = status(machine)
        return status == .online || status == .limited
    }

    /// Lower ranks need a look first: offline, overloaded, limited, then the owner's holds, then healthy.
    public static func attentionRank(_ status: MachinePlacement.Status) -> Int {
        switch status {
        case .offline: 0
        case .overloaded: 1
        case .limited: 2
        case .draining: 3
        case .cordoned: 4
        case .drained: 5
        case .unknown: 6
        case .online: 7
        }
    }

    public static func slots(_ machine: Machine) -> FleetSlots {
        if let p = machine.placement { return FleetSlots(held: p.held, effective: p.effective, configured: p.configured) }
        let configured = MachinePlacement.Slots(agents: machine.schedule?.maxAgents ?? machine.capacity.maxAgents, jobs: machine.schedule?.maxJobs ?? machine.capacity.maxJobs)
        let held = MachinePlacement.Slots(agents: machine.running.agents, jobs: machine.running.jobs)
        return FleetSlots(held: held, effective: accepting(machine) ? configured : .init(agents: 0, jobs: 0), configured: configured)
    }

    /// "1 of 4 agents", or "4 of 0 agents · 8 configured" when the hub holds slots back.
    /// Nil when the machine runs no agents and has no agent slots.
    public static func agentsLine(_ machine: Machine) -> String? {
        let s = slots(machine)
        return line(held: s.held.agents, effective: s.effective.agents, configured: s.configured.agents, noun: "agent")
    }

    /// "0 of 2 CI jobs", or nil when the machine takes no CI jobs.
    public static func jobsLine(_ machine: Machine) -> String? {
        let s = slots(machine)
        return line(held: s.held.jobs, effective: s.effective.jobs, configured: s.configured.jobs, noun: "CI job")
    }

    static func line(held: Int, effective: Int, configured: Int, noun: String) -> String? {
        guard held > 0 || configured > 0 || effective > 0 else { return nil }
        let base = "\(held) of \(plural(effective, noun))"
        return effective == configured ? base : base + " · \(configured) configured"
    }

    public static func loadPerCore(_ machine: Machine) -> Double? {
        if let value = machine.placement?.loadPerCore { return value }
        guard let load = machine.health?.load?.first, let cpus = machine.health?.cpus, cpus > 0 else { return nil }
        return load / Double(cpus)
    }

    /// Health in a few lines, the ones holding the machine back marked as concerns.
    public static func health(_ machine: Machine) -> [FleetFact] {
        guard let h = machine.health else { return [] }
        let codes = Set(machine.placement?.reasons.map(\.code) ?? [])
        let judged = machine.placement != nil
        var facts: [FleetFact] = []
        if let perCore = loadPerCore(machine) {
            let averages = h.load.map { $0.prefix(3).map(loadAverage).joined(separator: " · ") }
            let cores = h.cpus.map { plural($0, "core") }
            let detail = [averages, cores].compactMap { $0 }.joined(separator: " on ")
            facts.append(FleetFact("Load", value: String(format: "%.1f per core", perCore), detail: detail.isEmpty ? nil : detail,
                                   concern: judged ? codes.contains("overloaded") : perCore > loadLimit))
        }
        if let memory = h.memory, memory.totalBytes > 0 {
            let pressure: String? = switch memory.pressure {
            case .warn: "pressure elevated"
            case .critical: "pressure critical"
            default: nil
            }
            facts.append(FleetFact("Memory", value: "\(bytes(memory.freeBytes, binary: true)) free of \(bytes(memory.totalBytes, binary: true))", detail: pressure,
                                   concern: judged ? codes.contains("memory-pressure") : memory.pressure == .critical))
        }
        if let disk = h.disk, disk.totalBytes > 0 {
            let state: String? = switch h.storage?.state {
            case .low: "running low"
            case .critical: "almost full"
            default: nil
            }
            facts.append(FleetFact("Disk", value: "\(bytes(disk.freeBytes)) free of \(bytes(disk.totalBytes))", detail: state,
                                   concern: judged ? codes.contains("low-disk") : h.storage?.state == .critical))
        }
        if let power = h.power, power.source != .unknown {
            let value = power.source == .ac ? "AC" : "Battery"
            var detail = power.percent.map { "\(Int($0.rounded()))%" }
            if power.charging == true { detail = [detail, "charging"].compactMap { $0 }.joined(separator: ", ") }
            facts.append(FleetFact("Power", value: value, detail: detail, concern: codes.contains("on-battery")))
        }
        if let processes = h.processes {
            facts.append(FleetFact("Processes", value: count(processes), concern: codes.contains("too-many-processes")))
        }
        if let thermal = h.thermal, thermal == .serious || thermal == .critical || codes.contains("thermal") {
            facts.append(FleetFact("Thermal", value: thermal == .critical ? "Critical" : thermal == .serious ? "Serious" : thermal.rawValue.capitalized, concern: true))
        }
        if h.runtime?.reachable == false {
            facts.append(FleetFact("Runtime", value: "Unreachable", detail: "agents can't start", concern: true))
        }
        return facts
    }

    /// Why the machine isn't taking (all) work: blocking reasons first, notes last.
    public static func reasons(_ machine: Machine) -> [MachinePlacement.Reason] {
        var seen = Set<String>()
        let unique = (machine.placement?.reasons ?? []).filter { seen.insert($0.id).inserted }
        func rank(_ effect: MachinePlacement.Reason.Effect) -> Int {
            switch effect {
            case .blocks: 0
            case .blocksAgents, .blocksJobs: 1
            case .reduces: 2
            case .info: 3
            }
        }
        return unique.enumerated().sorted { (rank($0.element.effect), $0.offset) < (rank($1.element.effect), $1.offset) }.map(\.element)
    }

    /// Cordon and Drain for a machine taking work; Uncordon once it is held.
    public static func actions(_ machine: Machine) -> [FleetAction] {
        guard machine.revokedAt == nil else { return [] }
        let held = machine.schedule?.cordoned == true || machine.schedule?.drain == true || [.cordoned, .draining, .drained].contains(status(machine))
        return held ? [.uncordon] : [.cordon, .drain]
    }

    public static func title(_ action: FleetAction, for machine: Machine) -> String {
        switch action {
        case .cordon: "Cordon"
        case .drain: "Drain"
        case .uncordon:
            machine.schedule?.drain == true || [.draining, .drained].contains(status(machine)) ? "Stop draining" : "Uncordon"
        }
    }

    public static func platform(_ machine: Machine) -> String {
        let os = ["darwin": "macOS", "linux": "Linux", "windows": "Windows"][machine.os] ?? machine.os
        return [os, machine.arch].filter { !$0.isEmpty }.joined(separator: " ")
    }

    // MARK: Numbers

    static func plural(_ count: Int, _ word: String) -> String { "\(count) \(count == 1 ? word : word + "s")" }

    /// "130", "9.6": whole numbers from 10 up, one decimal below.
    static func loadAverage(_ value: Double) -> String {
        value >= 10 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }

    /// "2,700".
    public static func count(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }

    /// "6.2 GB", "120 GB", "1 TB". Memory counts in binary units, as macOS shows it; disks in decimal.
    public static func bytes(_ value: Double, binary: Bool = false) -> String {
        let step = binary ? 1024.0 : 1000.0
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var v = max(value, 0)
        var unit = 0
        while v >= step && unit < units.count - 1 {
            v /= step
            unit += 1
        }
        var text = v < 10 && unit > 0 ? String(format: "%.1f", v) : String(format: "%.0f", v)
        if text.hasSuffix(".0") { text.removeLast(2) }
        return "\(text) \(units[unit])"
    }
}

/// The fleet at a glance: what takes work, slots in use, and what needs a look.
public struct FleetSummary: Hashable, Sendable {
    public var total: Int
    public var accepting: Int
    public var agentsHeld: Int
    public var agentsEffective: Int
    public var agentsConfigured: Int
    public var jobsHeld: Int
    public var jobsEffective: Int
    public var jobsConfigured: Int
    public var overloaded: Int
    public var limited: Int
    /// Cordoned, draining or drained: held by the owner.
    public var cordoned: Int
    public var offline: Int

    public init(_ machines: [Machine]) {
        let slots = machines.map(FleetText.slots)
        let statuses = machines.map(FleetText.status)
        total = machines.count
        accepting = machines.filter(FleetText.accepting).count
        agentsHeld = slots.reduce(0) { $0 + $1.held.agents }
        agentsEffective = slots.reduce(0) { $0 + $1.effective.agents }
        agentsConfigured = slots.reduce(0) { $0 + $1.configured.agents }
        jobsHeld = slots.reduce(0) { $0 + $1.held.jobs }
        jobsEffective = slots.reduce(0) { $0 + $1.effective.jobs }
        jobsConfigured = slots.reduce(0) { $0 + $1.configured.jobs }
        overloaded = statuses.filter { $0 == .overloaded }.count
        limited = statuses.filter { $0 == .limited }.count
        cordoned = statuses.filter { [.cordoned, .draining, .drained].contains($0) }.count
        offline = statuses.filter { $0 == .offline }.count
    }

    /// "1 overloaded · 2 cordoned · 1 offline", zeros left out; nil when nothing needs a look.
    public var attention: String? {
        let parts = [
            overloaded > 0 ? "\(overloaded) overloaded" : nil,
            limited > 0 ? "\(limited) limited" : nil,
            cordoned > 0 ? "\(cordoned) cordoned or draining" : nil,
            offline > 0 ? "\(offline) offline" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Filtering and ordering for the Fleet list, at any fleet size.
public enum FleetPresentation {
    /// Machines that pass `filter`: not accepting first, the most urgent of
    /// those first, then by name.
    public static func rows(_ machines: [Machine], filter: FleetFilter = .all) -> [Machine] {
        machines
            .filter { machine in
                switch filter {
                case .all: true
                case .accepting: FleetText.accepting(machine)
                case .notAccepting: !FleetText.accepting(machine)
                }
            }
            .map { (machine: $0, accepting: FleetText.accepting($0), rank: FleetText.attentionRank(FleetText.status($0))) }
            .sorted { a, b in
                if a.accepting != b.accepting { return !a.accepting }
                if a.rank != b.rank { return a.rank < b.rank }
                return a.machine.name.localizedStandardCompare(b.machine.name) == .orderedAscending
            }
            .map(\.machine)
    }

    /// How many machines each filter shows.
    public static func counts(_ machines: [Machine]) -> [FleetFilter: Int] {
        let accepting = machines.filter(FleetText.accepting).count
        return [.all: machines.count, .accepting: accepting, .notAccepting: machines.count - accepting]
    }
}
