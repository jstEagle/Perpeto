import Foundation
import Testing
@testable import PerpetoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try HubCoding.decoder().decode(T.self, from: Data(json.utf8))
}

private let pacingJSON = """
{ "enabled": true, "strategy": "rotation", "targetUsePercent": 95, "updatedAt": "2026-10-22T11:59:00Z",
  "providers": [
    { "provider": "claudeAgent", "targetAgents": 3, "runningAgents": 3, "slots": 8, "readyWork": 9, "limitedBy": "session", "starved": false },
    { "provider": "codex", "targetAgents": 2.0, "runningAgents": "1", "slots": 8, "readyWork": 0, "limitedBy": "quota-v2", "starved": true },
    { "targetAgents": 1 }
  ],
  "accounts": [
    { "accountId": "acct_1", "machineId": "mch_1", "provider": "claudeAgent", "label": "Claude · build", "plan": "Max 20x", "state": "burning",
      "targetAgents": 3, "runningAgents": 3, "burnPerAgentHour": 31.5, "idleForecastMins": 0,
      "windows": [
        { "id": "weekly", "kind": "weekly", "label": "Weekly", "usedPercent": 62, "resetsAt": "2026-10-25T10:00:00Z", "projectedPercentAtReset": 95, "onTrack": "on" },
        { "id": "session", "kind": "session", "label": "Session", "usedPercent": 55.5, "resetsAt": "2026-10-22T16:25:00.000Z", "projectedPercentAtReset": 95, "onTrack": "on" },
        { "id": "broken", "kind": "session" }
      ] },
    { "accountId": "acct_2", "provider": "claudeAgent", "state": "hibernating", "windows": [{ "kind": "fortnightly", "usedPercent": 10, "onTrack": "maybe" }] },
    { "label": "no id, dropped" }
  ],
  "timeline": [
    { "accountId": "acct_1", "from": "2026-10-22T11:25:00Z", "to": "2026-10-22T12:25:00Z", "phase": "burn" },
    { "accountId": "acct_1", "from": "2026-10-22T12:25:00Z", "to": "2026-10-22T16:25:00Z", "phase": "rest" },
    { "accountId": "acct_2", "from": "2026-10-22T12:25:00Z", "to": "2026-10-22T13:25:00Z", "phase": "burn" },
    { "accountId": "acct_2", "from": "2026-10-22T13:25:00Z", "to": "2026-10-22T12:25:00Z", "phase": "burn" },
    { "accountId": "acct_2", "from": "2026-10-22T13:25:00Z", "to": "2026-10-22T14:00:00Z", "phase": "idle" }
  ] }
"""

private let now = HubCoding.parseDate("2026-10-22T12:00:00Z")!

@Suite("Subscription pacing decoding")
struct PacingDecodingTests {
    @Test func readsTheContract() throws {
        let p = try decode(Pacing.self, pacingJSON)
        #expect(p.enabled)
        #expect(p.strategy == .rotation)
        #expect(p.targetUsePercent == 95)
        #expect(p.minAgents == nil)
        #expect(p.providers.count == 2)
        #expect(p.providers[1].limitedBy == .unknown)
        #expect(p.providers[1].targetAgents == 2)
        #expect(p.providers[1].runningAgents == 1)
        #expect(p.providers[1].starved)
        #expect(p.accounts.count == 2)
        let build = p.accounts[0]
        #expect(build.state == .burning)
        #expect(build.burnPerAgentHour == 31.5)
        #expect(build.windows.map(\.id) == ["weekly", "session"])
        #expect(build.windows[1].usedPercent == 55.5)
        #expect(build.windows[1].resetsAt == HubCoding.parseDate("2026-10-22T16:25:00Z"))
        let spare = p.accounts[1]
        #expect(spare.state == .unknown)
        #expect(spare.label == "acct_2")
        #expect(spare.windows.first?.kind == .other)
        #expect(spare.windows.first?.label == "Limit")
        #expect(spare.windows.first?.projectedPercentAtReset == 10)
        #expect(spare.windows.first?.onTrack == .unknown)
        // Reversed spans and unknown phases are dropped.
        #expect(p.timeline.count == 3)
    }

    @Test func toleratesEnvelopesAndGaps() throws {
        let wrapped = try decode(Pacing.self, #"{ "pacing": { "enabled": true, "strategy": "zigzag", "targetUsePercent": "90", "minAgents": 1, "maxAgents": 12 } }"#)
        #expect(wrapped.enabled)
        #expect(wrapped.strategy == .unknown)
        #expect(wrapped.targetUsePercent == 90)
        #expect(wrapped.minAgents == 1)
        #expect(wrapped.maxAgents == 12)
        #expect(wrapped.accounts.isEmpty && wrapped.timeline.isEmpty)
        let empty = try decode(Pacing.self, "{}")
        #expect(!empty.enabled)
        #expect(empty.targetUsePercent == 95)
        #expect(try decode(Pacing.self, #"{ "targetUsePercent": 400 }"#).targetUsePercent == 100)
    }

    @Test func roundTripsThroughItsEncoding() throws {
        let p = try decode(Pacing.self, pacingJSON)
        let again = try HubCoding.decoder().decode(Pacing.self, from: try HubCoding.encoder().encode(p))
        #expect(again == p)
    }

    @Test func accountPlanAndUsage() throws {
        let account = try decode(Account.self, """
        { "id": "acct_1", "machineId": "mch_1", "provider": "claudeAgent", "label": "Claude · build", "status": "active", "plan": "Max 20x",
          "usage": { "checkedAt": "2026-10-22T11:59:20Z", "windows": [
            { "id": "session", "kind": "session", "label": "Session", "usedPercent": 55, "resetsAt": "2026-10-22T16:25:00Z", "windowMins": 300 },
            { "kind": "weekly" }, "junk" ] } }
        """)
        #expect(account.plan == "Max 20x")
        #expect(account.usage?.checkedAt != nil)
        #expect(account.usage?.windows.count == 1)
        #expect(account.usage?.windows.first?.windowMins == 300)

        // A malformed usage block or an empty plan never fails the account.
        let older = try decode(Account.self, #"{ "id": "a", "machineId": "m", "provider": "codex", "label": "x", "status": "active", "plan": "", "usage": "n/a" }"#)
        #expect(older.plan == nil)
        #expect(older.usage == nil)
    }

    @Test func settingsSendOnlyWhatChanged() throws {
        let body = String(decoding: try HubCoding.encoder().encode(PacingSettings(strategy: .parallel)), as: UTF8.self)
        #expect(body == #"{"strategy":"parallel"}"#)
        let patch = String(decoding: try HubCoding.encoder().encode(AccountPatch(plan: "Pro")), as: UTF8.self)
        #expect(patch == #"{"plan":"Pro"}"#)
        let cleared = String(decoding: try HubCoding.encoder().encode(AccountPatch(plan: "")), as: UTF8.self)
        #expect(cleared == #"{"plan":null}"#)
        let uncapped = String(decoding: try HubCoding.encoder().encode(PacingSettings(minAgents: 2, removeMaxAgents: true)), as: UTF8.self)
        #expect(uncapped == #"{"maxAgents":null,"minAgents":2}"#)
    }
}

@Suite("Subscription pacing presentation")
struct PacingPresentationTests {
    @Test func spans() {
        #expect(PacingText.span(20) == "under a minute")
        #expect(PacingText.span(38 * 60) == "38 min")
        #expect(PacingText.span(134 * 60) == "2 h 14 m")
        #expect(PacingText.span(3 * 3600) == "3 h")
        #expect(PacingText.span(76 * 3600) == "3 d 4 h")
        #expect(PacingText.resetsIn(now.addingTimeInterval(134 * 60), now: now) == "resets in 2 h 14 m")
        #expect(PacingText.resetsIn(now.addingTimeInterval(-60), now: now) == "reset due")
        #expect(PacingText.resetsIn(nil, now: now) == nil)
    }

    @Test func headline() throws {
        let p = try decode(Pacing.self, pacingJSON)
        #expect(PacingText.headline(p).lead == "4 agents running")
        #expect(PacingText.headline(p).detail == "on track to use 95% of every subscription by its reset")
        var under = p
        under.accounts[1].windows[0].onTrack = .under
        #expect(PacingText.headline(under).detail == "1 of 2 subscriptions on track for 95% by their reset")
        var over = p
        over.accounts[0].windows[1].onTrack = .over
        #expect(PacingText.headline(over).detail == "1 subscription will run out before its reset")
        var off = p
        off.enabled = false
        #expect(PacingText.headline(off).detail.hasPrefix("pacing is off"))
    }

    @Test func limitsAndTracks() throws {
        let p = try decode(Pacing.self, pacingJSON)
        #expect(PacingText.limitedBy(p.providers[0]) == "Paced by session limits")
        var slots = p.providers[0]
        slots.limitedBy = .slots
        slots.starved = true
        #expect(PacingText.limitedBy(slots) == "Not enough ready work, capped by machine slots")
        var account = p.accounts[0]
        account.windows[0].onTrack = .under
        #expect(PacingText.track(account) == .on)
        account.windows[1].onTrack = .under
        #expect(PacingText.track(account) == .under)
    }

    @Test func metersMergeProjectionsSessionFirst() throws {
        let p = try decode(Pacing.self, pacingJSON)
        let account = Account(id: "acct_1", machineId: "mch_1", provider: "claudeAgent", label: "x", status: .active,
                              usage: AccountUsage(windows: [UsageWindow(id: "weekly", kind: .weekly, label: "Weekly", usedPercent: 61),
                                                            UsageWindow(id: "session", kind: .session, label: "Session", usedPercent: 54)]))
        let meters = MeterWindow.merge(account, p.accounts[0])
        #expect(meters.map(\.id) == ["session", "weekly"])
        #expect(meters.map(\.usedPercent) == [54, 61])
        #expect(meters.map(\.projectedPercentAtReset) == [95, 95])
        #expect(PacingText.projection(meters[0]) == "95% at reset")
        // Windows only pacing knows about still show.
        let bare = Account(id: "acct_1", machineId: "m", provider: "claudeAgent", label: "x", status: .active)
        #expect(MeterWindow.merge(bare, p.accounts[0]).map(\.id) == ["session", "weekly"])
    }

    @Test func timelineLayout() throws {
        let p = try decode(Pacing.self, pacingJSON)
        let layout = PacingTimelineLayout(p, now: now, hoursAhead: 10, hoursBefore: 1)
        #expect(abs(layout.now - 60.0 / 660) < 0.0001)
        let lanes = layout.groups[0].lanes
        #expect(lanes.map(\.id) == ["acct_1", "acct_2"])
        let burn = lanes[1].segments[0]
        #expect(abs(burn.start - 85.0 / 660) < 0.0001)
        #expect(abs(burn.end - 145.0 / 660) < 0.0001)
        #expect(layout.ticks.allSatisfy { $0.at >= 0 && $0.at <= 0.97 })
    }
}

@Suite("Subscription pacing through the hub and demo")
struct PacingSourceTests {
    let token = "secret-owner-token-123"

    @Test func readsPacingAndTreatsMissingRouteAsUnpaced() async throws {
        let stub = StubTransport { request in
            request.url?.path() == "/api/v1/pacing" ? (200, pacingJSON) : (404, #"{"error":{"code":"NOT_FOUND","message":"No route."}}"#)
        }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let pacing = try await client.pacing()
        #expect(pacing?.accounts.count == 2)

        let missing = StubTransport { _ in (404, #"{"error":{"code":"NOT_FOUND","message":"No route."}}"#) }
        let older = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: missing)
        #expect(try await older.pacing() == nil)
    }

    @Test func putsSettingsWithIdempotencyKeyAndReadsBack() async throws {
        let stub = StubTransport { request in request.httpMethod == "PUT" ? (200, #"{"ok":true}"#) : (200, pacingJSON) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let pacing = try await client.updatePacing(PacingSettings(targetUsePercent: 90), idempotencyKey: "key-1")
        let put = stub.requests[0]
        #expect(put.httpMethod == "PUT")
        #expect(put.url?.path() == "/api/v1/pacing/settings")
        #expect(put.value(forHTTPHeaderField: "Idempotency-Key") == "key-1")
        let body = try JSONSerialization.jsonObject(with: put.httpBody ?? Data()) as? [String: Any]
        #expect(body?["targetUsePercent"] as? Int == 90)
        #expect(body?["idempotencyKey"] as? String == "key-1")
        // A bare acknowledgement is followed by a read of the new state.
        #expect(stub.requests[1].url?.path() == "/api/v1/pacing")
        #expect(pacing.providers.count == 2)
    }

    @Test func patchesAccountsBareOrWrapped() async throws {
        let account = #"{ "id": "acct 1", "machineId": "m", "provider": "codex", "label": "ChatGPT · build", "status": "active", "plan": "Pro" }"#
        for body in [account, #"{ "account": \#(account) }"#] {
            let stub = StubTransport { _ in (200, body) }
            let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
            let updated = try await client.updateAccount(id: "acct 1", AccountPatch(label: "ChatGPT · build", plan: "Pro"))
            #expect(updated.plan == "Pro")
            #expect(stub.requests[0].httpMethod == "PATCH")
            #expect(stub.requests[0].url?.absoluteString == "http://localhost:4320/api/v1/accounts/acct%201")
            #expect(stub.requests[0].value(forHTTPHeaderField: "Idempotency-Key") != nil)
        }
    }

    @Test func demoRotatesFiveClaudeSubscriptions() async throws {
        let demo = DemoDataSource(now: { now }, stageDelay: .zero)
        let factory = try await demo.loadFactory()
        let pacing = try #require(factory.pacing)
        let claude = pacing.accounts.filter { $0.provider == "claudeAgent" }
        #expect(claude.count == 5)
        #expect(claude.filter { $0.state == .burning }.count == 1)
        #expect(claude.filter { $0.state == .next }.count == 1)
        #expect(pacing.accounts.filter { $0.provider == "codex" }.count == 2)
        #expect(factory.accounts.allSatisfy { $0.usage?.windows.count == 2 && $0.plan != nil })
        // Each Claude turn starts as the one before it ends.
        let ids = Set(claude.map(\.accountId))
        let burns = pacing.timeline.filter { $0.phase == .burn && ids.contains($0.accountId) }.sorted { $0.from < $1.from }
        for (a, b) in zip(burns, burns.dropFirst()) { #expect(a.to == b.from) }
        #expect(PacingText.headline(pacing).lead == "5 agents running")
    }

    @Test func demoAppliesSettingsAndEdits() async throws {
        let demo = DemoDataSource(now: { now }, stageDelay: .zero)
        let parallel = try await demo.updatePacing(PacingSettings(strategy: .parallel, targetUsePercent: 90))
        #expect(parallel.strategy == .parallel)
        #expect(parallel.targetUsePercent == 90)
        #expect(parallel.accounts.allSatisfy { $0.state == .burning })
        let off = try await demo.updatePacing(PacingSettings(enabled: false))
        #expect(off.timeline.isEmpty)
        await #expect(throws: HubError.self) { try await demo.updatePacing(PacingSettings(targetUsePercent: 20)) }
        let renamed = try await demo.updateAccount(id: "acct_c1", AccountPatch(label: "Claude · main", plan: "Max 5x"))
        #expect(renamed.label == "Claude · main")
        let pacing = try #require(try await demo.loadFactory().pacing)
        #expect(pacing.accounts.first { $0.accountId == "acct_c1" }?.label == "Claude · main")
    }

    @Test func olderSourcesRefusePacingWrites() async throws {
        // Older sources still conform and refuse pacing writes with a clear error.
        let source = CountingSource()
        await #expect(throws: HubError.self) { try await source.updatePacing(PacingSettings(enabled: false)) }
    }
}
