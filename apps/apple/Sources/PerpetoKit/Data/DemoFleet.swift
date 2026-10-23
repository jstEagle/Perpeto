import Foundation

/// Demo machine health and placement, mirroring the hub's rules closely
/// enough to read true. The two-machine fleet: a Mac mini buried under load
/// (load 130 on 10 cores, 2,700 processes) and a MacBook Pro on AC running
/// one of four agents. `generated(count:now:)` builds a large fleet with
/// every status for tests and layout checks.
public enum DemoFleet {
    /// The fleet takes over the full demo's two machine IDs, so its runs,
    /// jobs and subscriptions resolve to these names.
    public static let miniId = DemoFixtures.studioId
    public static let laptopId = DemoFixtures.linuxId

    static let gib = 1_073_741_824.0
    static let gb = 1_000_000_000.0

    /// Default limits, as the hub's placement uses them.
    static let loadLimit = 1.5
    static let processLimit = 2_000

    public static func machines(now: Date) -> [Machine] {
        let mini = Machine(
            id: miniId, name: "studio-mini", os: "darwin", arch: "arm64", labels: ["mac", "studio", "xcode"], providers: ["claudeAgent", "codex"],
            capacity: .init(maxAgents: 8, maxJobs: 2), running: .init(agents: 4, jobs: 0), status: .online,
            lastHeartbeatAt: now.addingTimeInterval(-5), version: "0.5.0",
            health: MachineHealth(reportedAt: now.addingTimeInterval(-5), cpus: 10, load: [130, 118, 96],
                                  memory: .init(totalBytes: 32 * gib, freeBytes: 4.6 * gib, pressure: .normal), processes: 2_700,
                                  power: .init(source: .ac), thermal: .fair, uptimeSec: 86_400 * 12, nodeVersion: "24.4.0",
                                  runtime: .init(reachable: true), disk: .init(totalBytes: 1_000 * gb, freeBytes: 212 * gb), storage: .init(state: .ok)),
            schedule: MachineSchedule(updatedAt: now.addingTimeInterval(-86_400 * 3)))
        let laptop = Machine(
            id: laptopId, name: "justus-mbp", os: "darwin", arch: "arm64", labels: ["mac", "this-mac"], providers: ["claudeAgent", "codex"],
            capacity: .init(maxAgents: 4, maxJobs: 0), running: .init(agents: 1, jobs: 0), status: .online,
            lastHeartbeatAt: now.addingTimeInterval(-3), version: "0.5.0",
            health: MachineHealth(reportedAt: now.addingTimeInterval(-3), cpus: 14, load: [3.4, 2.9, 2.6],
                                  memory: .init(totalBytes: 48 * gib, freeBytes: 21.5 * gib, pressure: .normal), processes: 712,
                                  power: .init(source: .ac, percent: 100, charging: false), thermal: .nominal, uptimeSec: 86_400 * 2, nodeVersion: "24.4.0",
                                  runtime: .init(reachable: true), disk: .init(totalBytes: 2_000 * gb, freeBytes: 846 * gb), storage: .init(state: .ok)),
            schedule: MachineSchedule(allowOnBattery: false, updatedAt: now.addingTimeInterval(-86_400)))
        return [mini, laptop].map { placed($0, now: now) }
    }

    /// A fleet of `count` machines with every status represented. Deterministic.
    public static func generated(count: Int, now: Date) -> [Machine] {
        (0..<count).map { i in
            let n = i + 1
            let linux = n % 3 == 0
            let cpus = [8, 10, 12, 16][n % 4]
            let maxAgents = 2 + n % 5
            let maxJobs = linux ? 2 : 0
            var perCore = 0.3 + Double(n % 6) * 0.1
            var pressure = MachineHealth.Memory.Pressure.normal
            var power = MachineHealth.Power(source: .ac)
            var storage = MachineHealth.Storage.State.ok
            var processes = 400 + n * 13
            var schedule = MachineSchedule(updatedAt: now.addingTimeInterval(-3600))
            var status = Machine.Status.online
            var heartbeat = now.addingTimeInterval(-Double(2 + n % 9))
            if n % 9 == 4 { perCore = 2.4 }
            if n % 17 == 8 { processes = 2_400 }
            if n % 11 == 3 { schedule.cordoned = true }
            if n % 13 == 7 { schedule.drain = true; status = .draining }
            if n % 10 == 0 { status = .offline; heartbeat = now.addingTimeInterval(-60 * Double(12 + n)) }
            if n % 8 == 5 { pressure = .warn }
            if n % 12 == 2 { power = .init(source: .battery, percent: Double(30 + n), charging: false) }
            if n % 19 == 9 { storage = .low }
            let running = min(n % 4, maxAgents)
            let machine = Machine(
                id: String(format: "mch_gen%02d", n), name: String(format: "%@-%02d", linux ? "build-linux" : "mac", n),
                os: linux ? "linux" : "darwin", arch: linux ? "x64" : "arm64", labels: linux ? ["linux", "ci"] : ["mac"], providers: ["claudeAgent", "codex"],
                capacity: .init(maxAgents: maxAgents, maxJobs: maxJobs), running: .init(agents: running, jobs: linux ? n % 2 : 0),
                status: status, lastHeartbeatAt: heartbeat, version: "0.5.0",
                health: MachineHealth(reportedAt: heartbeat, cpus: cpus, load: [perCore * Double(cpus), perCore * Double(cpus) * 0.9, perCore * Double(cpus) * 0.8],
                                      memory: .init(totalBytes: Double(16 + 16 * (n % 3)) * gib, freeBytes: Double(2 + n % 7) * gib, pressure: pressure),
                                      processes: processes, power: power, thermal: .nominal, runtime: .init(reachable: true),
                                      disk: .init(totalBytes: 1_000 * gb, freeBytes: storage == .low ? 38 * gb : Double(120 + n * 7) * gb), storage: .init(state: storage)),
                schedule: schedule)
            return placed(machine, now: now)
        }
    }

    /// Adds plausible, healthy telemetry to machines that have none, then places them.
    public static func equip(_ machines: [Machine], now: Date) -> [Machine] {
        machines.map { machine in
            var m = machine
            if m.health == nil {
                let cpus = m.os == "linux" ? 16 : 12
                let perCore = 0.25 + 0.15 * Double(m.running.agents + m.running.jobs)
                m.health = MachineHealth(reportedAt: m.lastHeartbeatAt, cpus: cpus, load: [perCore * Double(cpus), perCore * Double(cpus) * 0.9, perCore * Double(cpus) * 0.85],
                                         memory: .init(totalBytes: (m.os == "linux" ? 64 : 36) * gib, freeBytes: (m.os == "linux" ? 31 : 12) * gib, pressure: .normal),
                                         processes: m.os == "linux" ? 310 : 640, power: .init(source: .ac), thermal: .nominal, runtime: .init(reachable: true),
                                         disk: .init(totalBytes: 1_000 * gb, freeBytes: (m.os == "linux" ? 540 : 260) * gb), storage: .init(state: .ok))
            }
            if m.schedule == nil { m.schedule = MachineSchedule() }
            return placed(m, now: now)
        }
    }

    static func placed(_ machine: Machine, now: Date) -> Machine {
        var m = machine
        m.placement = place(machine, now: now)
        return m
    }

    /// The hub's verdict for a machine, from its heartbeat, health and schedule.
    public static func place(_ m: Machine, now: Date) -> MachinePlacement {
        typealias Reason = MachinePlacement.Reason
        let schedule = m.schedule ?? MachineSchedule()
        let configured = MachinePlacement.Slots(agents: schedule.maxAgents ?? m.capacity.maxAgents, jobs: schedule.maxJobs ?? m.capacity.maxJobs)
        let held = MachinePlacement.Slots(agents: m.running.agents, jobs: m.running.jobs)
        var effective = configured
        var reasons: [Reason] = []
        let h = m.health
        let perCore = h.flatMap { h in h.load?.first.flatMap { load in h.cpus.map { load / Double($0) } } }
        let offline = m.revokedAt != nil || m.status == .offline
        if m.revokedAt != nil {
            reasons.append(Reason(code: "revoked", message: "Enrollment revoked", effect: .blocks))
        } else if m.status == .offline {
            let mins = max(1, Int(now.timeIntervalSince(m.lastHeartbeatAt) / 60))
            reasons.append(Reason(code: "offline", message: "No heartbeat for \(mins) min", effect: .blocks))
        }
        if schedule.cordoned { reasons.append(Reason(code: "cordoned", message: "Cordoned by the owner", effect: .blocks)) }
        if schedule.drain { reasons.append(Reason(code: "draining", message: "Draining: running work finishes, nothing new starts", effect: .blocks)) }
        if !offline, let h {
            if let perCore, perCore > loadLimit {
                reasons.append(Reason(code: "overloaded", message: String(format: "Load %.1f per core (limit %.1f)", perCore, loadLimit), effect: .blocks))
            }
            if let processes = h.processes, processes > processLimit {
                reasons.append(Reason(code: "too-many-processes", message: "\(FleetText.count(processes)) processes (limit \(FleetText.count(processLimit)))", effect: .blocks))
            }
            switch h.memory?.pressure {
            case .critical: reasons.append(Reason(code: "memory-pressure", message: "Memory pressure is critical", effect: .blocks))
            case .warn:
                effective.agents = configured.agents / 2
                reasons.append(Reason(code: "memory-pressure", message: "Memory pressure is elevated, so half the agent slots", effect: .reduces))
            default: break
            }
            switch h.storage?.state {
            case .critical: reasons.append(Reason(code: "low-disk", message: "Disk almost full (\(FleetText.bytes(h.disk?.freeBytes ?? 0)) free)", effect: .blocks))
            case .low:
                effective.agents = min(effective.agents, max(1, configured.agents / 2))
                reasons.append(Reason(code: "low-disk", message: "Disk running low (\(FleetText.bytes(h.disk?.freeBytes ?? 0)) free)", effect: .reduces))
            default: break
            }
            if h.power?.source == .battery && schedule.allowOnBattery != true {
                effective.agents = 0
                reasons.append(Reason(code: "on-battery", message: "On battery\(h.power?.percent.map { " (\(Int($0))%)" } ?? ""), agents wait for AC", effect: .blocksAgents))
            }
            if h.thermal == .serious || h.thermal == .critical {
                reasons.append(Reason(code: "thermal", message: "Thermal state \(h.thermal!.rawValue)", effect: .blocks))
            }
            if h.runtime?.reachable == false {
                effective.agents = 0
                reasons.append(Reason(code: "runtime-unreachable", message: "The agent runtime isn't answering", effect: .blocksAgents))
            }
        }
        let blocked = reasons.contains { $0.effect == .blocks }
        if blocked { effective = .init(agents: 0, jobs: 0) }
        if !blocked && effective.agents > 0 && held.agents >= effective.agents {
            reasons.append(Reason(code: "full", message: "All \(FleetText.plural(effective.agents, "agent slot")) in use", effect: .info))
        }
        let status: MachinePlacement.Status
        let health = Set(["overloaded", "too-many-processes", "memory-pressure", "low-disk", "thermal"])
        if offline { status = .offline }
        else if schedule.drain { status = held.agents + held.jobs > 0 ? .draining : .drained }
        else if schedule.cordoned { status = .cordoned }
        else if reasons.contains(where: { $0.effect == .blocks && health.contains($0.code) }) { status = .overloaded }
        else if reasons.contains(where: { $0.effect != .info }) { status = .limited }
        else { status = .online }
        let accepting = (status == .online || status == .limited) && (effective.agents > 0 || effective.jobs > 0)
        return MachinePlacement(status: status, accepting: accepting, configured: configured, effective: effective, held: held,
                                loadPerCore: perCore, weight: schedule.weight, reasons: reasons)
    }

    /// Applies a schedule change the way the hub does, returning the placed machine.
    public static func apply(_ patch: MachinePatch, to machine: Machine, now: Date) throws -> Machine {
        guard machine.revokedAt == nil else {
            throw HubError.http(status: 409, code: "REVOKED", message: "That machine's enrollment was revoked.")
        }
        if let weight = patch.weight, !(0...10).contains(weight) {
            throw HubError.http(status: 400, code: "INVALID_INPUT", message: "Weight must be between 0 and 10.")
        }
        var m = machine
        var schedule = m.schedule ?? MachineSchedule()
        if let cordoned = patch.cordoned { schedule.cordoned = cordoned }
        if let drain = patch.drain { schedule.drain = drain }
        if let weight = patch.weight { schedule.weight = weight }
        if let maxAgents = patch.maxAgents { schedule.maxAgents = maxAgents }
        if let maxJobs = patch.maxJobs { schedule.maxJobs = maxJobs }
        if let allow = patch.allowOnBattery { schedule.allowOnBattery = allow }
        schedule.updatedAt = now
        m.schedule = schedule
        if m.status != .offline { m.status = schedule.drain ? .draining : .online }
        return placed(m, now: now)
    }
}
