import Foundation
import Testing
@testable import PerpetoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try HubCoding.decoder().decode(T.self, from: Data(json.utf8))
}

private let now = HubCoding.parseDate("2026-10-23T12:00:00Z")!

private let fleetMachineJSON = """
{ "id": "mch_mini", "name": "studio-mini", "os": "darwin", "arch": "arm64", "version": "0.5.0",
  "labels": ["mac", "studio"], "reportedLabels": ["mac"], "providers": ["claudeAgent", "codex"],
  "capacity": { "maxAgents": 8, "maxJobs": 2 }, "running": { "agents": 4, "jobs": 0 },
  "status": "online", "lastHeartbeatAt": "2026-10-23T11:59:55Z",
  "health": { "reportedAt": "2026-10-23T11:59:55Z", "cpus": 10, "load": [130, 118.4, 96],
    "memory": { "totalBytes": 34359738368, "freeBytes": "4939212390", "pressure": "warn" },
    "processes": 2712, "power": { "source": "ac" }, "thermal": "toasty", "uptimeSec": 1036800, "nodeVersion": "24.4.0",
    "runtime": { "reachable": true }, "disk": { "totalBytes": 1000000000000, "freeBytes": 212000000000 }, "storage": { "state": "ok" } },
  "schedule": { "cordoned": false, "drain": false, "weight": 1, "maxAgents": null, "allowOnBattery": null, "updatedAt": "2026-10-20T12:00:00Z" },
  "placement": { "status": "overloaded", "accepting": false,
    "configured": { "agents": 8, "jobs": 2 }, "effective": { "agents": 0, "jobs": 0 }, "held": { "agents": 4, "jobs": 0 },
    "loadPerCore": 13.0, "weight": 1,
    "reasons": [
      { "code": "too-many-processes", "message": "2,712 processes (limit 2,000)", "effect": "blocks" },
      { "code": "overloaded", "message": "Load 13.0 per core (limit 1.5)", "effect": "blocks" },
      { "code": "busy", "message": "Mostly busy", "effect": "slows-down" },
      { "effect": "info" }
    ] } }
"""

private func legacy(_ name: String, status: Machine.Status = .online, agents: Int = 0, max: Int = 4) -> Machine {
    Machine(id: "mch_\(name)", name: name, os: "linux", arch: "x64", labels: [], providers: ["codex"], capacity: .init(maxAgents: max, maxJobs: 0),
            running: .init(agents: agents, jobs: 0), status: status, lastHeartbeatAt: now, version: "0.4.0")
}

@Suite("Fleet decoding")
struct FleetDecodingTests {
    @Test func readsTheContract() throws {
        let m = try decode(Machine.self, fleetMachineJSON)
        #expect(m.reportedLabels == ["mac"])
        let h = try #require(m.health)
        #expect(h.cpus == 10)
        #expect(h.load == [130, 118.4, 96])
        #expect(h.memory?.freeBytes == 4_939_212_390)
        #expect(h.memory?.pressure == .warn)
        #expect(h.processes == 2_712)
        #expect(h.power?.source == .ac)
        #expect(h.thermal == .unknown, "an unknown thermal state decodes to unknown")
        #expect(h.storage?.state == .ok)
        let s = try #require(m.schedule)
        #expect(!s.cordoned && !s.drain && s.weight == 1 && s.maxAgents == nil)
        let p = try #require(m.placement)
        #expect(p.status == .overloaded)
        #expect(!p.accepting)
        #expect(p.configured == .init(agents: 8, jobs: 2))
        #expect(p.effective == .init(agents: 0, jobs: 0))
        #expect(p.held == .init(agents: 4, jobs: 0))
        #expect(p.loadPerCore == 13)
        // An unknown effect is a note; a reason with neither message nor code is dropped.
        #expect(p.reasons.map(\.code) == ["too-many-processes", "overloaded", "busy"])
        #expect(p.reasons[2].effect == .info)
    }

    @Test func olderHubsOmitFleetFields() throws {
        let m = try decode(Machine.self, """
        { "id": "mch_1", "name": "studio", "status": "online", "capacity": { "maxAgents": 6, "maxJobs": 2 }, "running": { "agents": 3, "jobs": 0 } }
        """)
        #expect(m.health == nil && m.schedule == nil && m.placement == nil && m.revokedAt == nil)
        #expect(FleetText.status(m) == .online)
        #expect(FleetText.accepting(m))
        #expect(FleetText.agentsLine(m) == "3 of 6 agents")
        #expect(FleetText.jobsLine(m) == "0 of 2 CI jobs")
        #expect(FleetText.health(m).isEmpty)
        #expect(FleetText.actions(m) == [.cordon, .drain])
    }

    @Test func malformedFleetFieldsDoNotFailTheMachine() throws {
        let m = try decode(Machine.self, """
        { "id": "mch_1", "name": "odd", "status": "rebooting", "health": "soon", "schedule": [1],
          "placement": { "status": "hibernating", "reasons": "none", "held": { "agents": "2" } }, "revokedAt": 7 }
        """)
        #expect(m.status == .unknown)
        #expect(m.health == nil && m.schedule == nil && m.revokedAt == nil)
        let p = try #require(m.placement)
        #expect(p.status == .unknown)
        #expect(!p.accepting)
        #expect(p.held.agents == 2)
        #expect(p.reasons.isEmpty)
        // An unknown placement status falls back to the legacy fields.
        #expect(FleetText.status(m) == .online)
    }

    @Test func machineListSurvivesMixedHubs() throws {
        let list = try decode(MachineList.self, #"{ "machines": [\#(fleetMachineJSON), { "id": "mch_2", "name": "old", "status": "offline" }] }"#)
        #expect(list.machines.count == 2)
        #expect(FleetText.status(list.machines[1]) == .offline)
    }
}

private struct MachineList: Decodable { var machines: [Machine] }

@Suite("Fleet presentation")
struct FleetPresentationTests {
    @Test func slotsAndHealthRead() throws {
        let m = try decode(Machine.self, fleetMachineJSON)
        #expect(FleetText.status(m) == .overloaded)
        #expect(FleetText.statusLabel(.overloaded) == "Overloaded")
        #expect(FleetText.agentsLine(m) == "4 of 0 agents · 8 configured")
        #expect(FleetText.jobsLine(m) == "0 of 0 CI jobs · 2 configured")
        let facts = FleetText.health(m)
        #expect(facts.map(\.label) == ["Load", "Memory", "Disk", "Power", "Processes"])
        #expect(facts[0].value == "13.0 per core")
        #expect(facts[0].detail == "130 · 118 · 96 on 10 cores")
        #expect(facts[0].concern)
        #expect(facts[1].value == "4.6 GB free of 32 GB")
        #expect(facts[1].detail == "pressure elevated")
        #expect(!facts[1].concern, "the hub didn't name memory as a reason")
        #expect(facts[2].value == "212 GB free of 1 TB")
        #expect(facts[3].value == "AC")
        #expect(facts[4].value == "2,712")
        #expect(facts[4].concern)
        #expect(FleetText.reasons(m).map(\.message) == ["2,712 processes (limit 2,000)", "Load 13.0 per core (limit 1.5)", "Mostly busy"])
    }

    @Test func numbers() {
        #expect(FleetText.bytes(4.6 * 1_073_741_824, binary: true) == "4.6 GB")
        #expect(FleetText.bytes(1_000_000_000_000) == "1 TB")
        #expect(FleetText.bytes(38_000_000_000) == "38 GB")
        #expect(FleetText.bytes(512) == "512 B")
        #expect(FleetText.count(2_700) == "2,700")
        #expect(FleetText.loadAverage(9.64) == "9.6")
    }

    @Test func actionsFollowTheSchedule() throws {
        var m = legacy("a")
        #expect(FleetText.actions(m) == [.cordon, .drain])
        m.schedule = MachineSchedule(cordoned: true)
        #expect(FleetText.status(m) == .cordoned)
        #expect(FleetText.actions(m) == [.uncordon])
        #expect(FleetText.title(.uncordon, for: m) == "Uncordon")
        m.schedule = MachineSchedule(drain: true)
        m.running.agents = 2
        #expect(FleetText.status(m) == .draining)
        #expect(FleetText.title(.uncordon, for: m) == "Stop draining")
        m.revokedAt = now
        #expect(FleetText.actions(m).isEmpty)
        #expect(FleetAction.drain.needsConfirmation && !FleetAction.cordon.needsConfirmation)
    }

    @Test func patchesMatchTheContract() throws {
        func body(_ patch: MachinePatch) throws -> [String: Bool] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Bool]
        }
        #expect(try body(.cordon) == ["cordoned": true])
        #expect(try body(.uncordon) == ["cordoned": false, "drain": false])
        #expect(try body(.drain) == ["drain": true])
    }

    @Test func twoMachineDemoFleet() {
        let fleet = DemoFleet.machines(now: now)
        #expect(fleet.map(\.name) == ["studio-mini", "justus-mbp"])
        let mini = fleet[0], mbp = fleet[1]
        #expect(FleetText.status(mini) == .overloaded)
        #expect(!FleetText.accepting(mini))
        #expect(FleetText.reasons(mini).map(\.code) == ["overloaded", "too-many-processes"])
        #expect(FleetText.reasons(mini).first?.message == "Load 13.0 per core (limit 1.5)")
        #expect(FleetText.reasons(mini).last?.message == "2,700 processes (limit 2,000)")
        #expect(FleetText.status(mbp) == .online)
        #expect(FleetText.accepting(mbp))
        #expect(FleetText.agentsLine(mbp) == "1 of 4 agents")
        #expect(FleetText.health(mbp).first { $0.label == "Power" }?.value == "AC")
        #expect(FleetText.health(mbp).first { $0.label == "Memory" }?.detail == nil, "normal pressure goes unsaid")

        let summary = FleetSummary(fleet)
        #expect(summary.total == 2 && summary.accepting == 1)
        #expect(summary.agentsHeld == 5 && summary.agentsEffective == 4 && summary.agentsConfigured == 12)
        #expect(summary.overloaded == 1 && summary.cordoned == 0 && summary.offline == 0)
        #expect(summary.attention == "1 overloaded")
        #expect(FleetPresentation.rows(fleet).map(\.name) == ["studio-mini", "justus-mbp"], "not accepting first")
        #expect(FleetPresentation.rows(fleet, filter: .accepting).map(\.name) == ["justus-mbp"])
        #expect(FleetPresentation.counts(fleet) == [.all: 2, .accepting: 1, .notAccepting: 1])
    }

    @Test func fiftyMachines() {
        let fleet = DemoFleet.generated(count: 50, now: now)
        #expect(fleet.count == 50)
        #expect(Set(fleet.map(\.id)).count == 50)
        let statuses = Set(fleet.map(FleetText.status))
        #expect(statuses.isSuperset(of: [.online, .limited, .overloaded, .cordoned, .offline]))
        #expect(statuses.contains(.draining) || statuses.contains(.drained))

        let summary = FleetSummary(fleet)
        let counts = FleetPresentation.counts(fleet)
        #expect(counts[.all] == 50)
        #expect(counts[.accepting]! + counts[.notAccepting]! == 50)
        #expect(summary.accepting == counts[.accepting])
        #expect(summary.offline == 5)
        #expect(summary.overloaded > 0 && summary.cordoned > 0)
        #expect(summary.agentsEffective < summary.agentsConfigured)
        #expect(summary.attention?.contains("5 offline") == true)

        let rows = FleetPresentation.rows(fleet)
        #expect(rows.count == 50)
        let firstAccepting = rows.firstIndex(where: FleetText.accepting)!
        #expect(rows[..<firstAccepting].allSatisfy { !FleetText.accepting($0) })
        #expect(rows[firstAccepting...].allSatisfy(FleetText.accepting))
        #expect(FleetText.status(rows[0]) == .offline, "offline machines lead")
        let ranks = rows[..<firstAccepting].map { FleetText.attentionRank(FleetText.status($0)) }
        #expect(ranks == ranks.sorted())
        #expect(FleetPresentation.rows(fleet, filter: .notAccepting).count == counts[.notAccepting])
        #expect(FleetPresentation.rows(fleet, filter: .accepting).allSatisfy(FleetText.accepting))
    }

    @Test func legacyOrderingWithoutPlacement() {
        let fleet = [legacy("b"), legacy("a", status: .offline), legacy("c", status: .draining, agents: 1)]
        #expect(FleetPresentation.rows(fleet).map(\.name) == ["a", "c", "b"])
        #expect(FleetSummary(fleet).cordoned == 1)
        #expect(FleetSummary(fleet).offline == 1)
    }
}

@Suite("Fleet actions")
struct FleetActionTests {
    let token = "secret-owner-token-123"

    @Test func patchesTheMachine() async throws {
        let stub = StubTransport { _ in (200, fleetMachineJSON) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let machine = try await client.updateMachine(id: "mch mini", .uncordon)
        #expect(machine.placement?.status == .overloaded)
        let request = try #require(stub.requests.first)
        #expect(request.httpMethod == "PATCH")
        #expect(request.url?.absoluteString == "http://localhost:4320/api/v1/machines/mch%20mini")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        #expect(body["cordoned"] as? Bool == false)
        #expect(body["drain"] as? Bool == false)
        #expect(body["weight"] == nil)
        let key = try #require(body["idempotencyKey"] as? String)
        #expect(UUID(uuidString: key) != nil)
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == key)
        // A `machine` envelope works too.
        let wrapped = StubTransport { _ in (200, #"{ "machine": \#(fleetMachineJSON) }"#) }
        let other = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: wrapped)
        #expect(try await other.updateMachine(id: "mch_mini", .drain).name == "studio-mini")
    }

    @MainActor @Test func demoCordonsDrainsAndUncordons() async throws {
        let store = FactoryStore(source: DemoDataSource(scenario: .fleet, stageDelay: .zero))
        await store.refresh()
        let mbp = try #require(store.factory.machines.first { $0.name == "justus-mbp" })
        #expect(FleetText.accepting(mbp))

        await store.apply(.cordon, to: mbp)
        var now = try #require(store.machine(mbp.id))
        #expect(FleetText.status(now) == .cordoned)
        #expect(!FleetText.accepting(now))
        #expect(FleetText.reasons(now).first?.message == "Cordoned by the owner")
        #expect(FleetText.actions(now) == [.uncordon])

        await store.apply(.uncordon, to: now)
        now = try #require(store.machine(mbp.id))
        #expect(FleetText.status(now) == .online)
        #expect(FleetText.accepting(now))

        await store.apply(.drain, to: now)
        now = try #require(store.machine(mbp.id))
        #expect(FleetText.status(now) == .draining, "its one agent finishes first")
        #expect(now.schedule?.drain == true)
        #expect(FleetSummary(store.factory.machines).accepting == 0)
        #expect(store.lastError == nil)
    }

    @Test func fullDemoMachinesCarryHealth() async throws {
        let factory = try await DemoDataSource(scenario: .full, stageDelay: .zero).loadFactory()
        #expect(factory.machines.allSatisfy { $0.health != nil && $0.placement != nil })
        #expect(factory.machines.allSatisfy(FleetText.accepting))
    }
}
