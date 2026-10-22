import Foundation
import Testing
@testable import PerpetoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try HubCoding.decoder().decode(T.self, from: Data(json.utf8))
}

private let now = HubCoding.parseDate("2026-10-22T12:00:00Z")!

@Suite("Observed sessions decoding")
struct SessionDecodingTests {
    @Test func readsAPage() throws {
        let page = try decode(SessionPage.self, """
        { "sessions": [
            { "id": "ses_1", "machineId": "mch_a", "machineName": "justus-macbook-pro", "threadId": "thr_1", "title": "Observe-only view",
              "project": { "name": "perpeto", "path": "/Users/j/Perpeto" }, "branch": "feat/observe", "provider": "claudeAgent",
              "providerInstanceId": "claude-default", "model": "claude-opus-5-5", "status": "running", "childCount": 2,
              "createdAt": "2026-10-22T11:18:00Z", "lastActivityAt": "2026-10-22T11:59:40.120Z", "turns": 31,
              "tokens": { "input": 184000, "output": "46000", "cacheRead": 3120000, "cacheWrite": 0, "reasoning": 1200 } },
            { "id": "ses_2", "machineId": "mch_a", "threadId": "thr_2", "parentThreadId": "thr_1", "provider": "claudeAgent", "status": "compacting",
              "project": { "path": "/Users/j/lumin-web" }, "createdAt": "not a date" },
            { "title": "no id, dropped" },
            "garbage"
          ], "nextCursor": 42 }
        """)
        #expect(page.sessions.count == 2)
        #expect(page.nextCursor == "42")
        let first = page.sessions[0]
        #expect(first.status == .running)
        #expect(first.project?.name == "perpeto")
        #expect(first.tokens.output == 46000)
        #expect(first.tokens.total == 230_000)
        #expect(first.childCount == 2)
        #expect(first.lastActivityAt == HubCoding.parseDate("2026-10-22T11:59:40.120Z"))
        let child = page.sessions[1]
        #expect(child.status == .unknown)
        #expect(child.machineName == "mch_a")
        #expect(child.title == nil)
        #expect(child.project?.name == "lumin-web")
        #expect(child.createdAt == nil)
        #expect(child.tokens == .zero)
    }

    @Test func readsASummary() throws {
        let summary = try decode(SessionSummary.self, """
        { "machines": [
            { "machineId": "mch_a", "name": "justus-macbook-pro", "online": true, "observing": true, "lastObservedAt": "2026-10-22T11:59:55Z", "running": 3, "waiting": 1, "idle": 4 },
            { "machineId": "mch_b", "name": "mac-mini", "online": true, "observing": false, "running": "1" },
            { "name": "no id" }
          ],
          "totals": { "running": 4, "waiting": 1, "sessionsActive": 5 },
          "tokens": {
            "byProvider": [{ "provider": "claudeAgent", "input": 700, "output": 100, "cacheRead": 5000, "cacheWrite": 10 }, { "provider": "codex", "input": 200, "output": 50 }],
            "byModel": [{ "model": "claude-opus-5-5", "input": 400, "output": 60 }, { "input": 1 }],
            "byMachine": [{ "machineId": "mch_a", "input": 600, "output": 90 }],
            "series": [{ "at": "2026-10-22T11:00:00Z", "input": 50, "output": 5 }, { "at": "2026-10-22T10:00:00Z", "input": 40, "output": 4 }, { "input": 1 }]
          } }
        """)
        #expect(summary.machines.map(\.name) == ["justus-macbook-pro", "mac-mini"])
        #expect(summary.machines[1].running == 1)
        #expect(!summary.machines[1].observing)
        #expect(summary.machines[1].lastObservedAt == nil)
        #expect(summary.totals.running == 4)
        #expect(summary.tokens.byProvider.map(\.key) == ["claudeAgent", "codex"])
        #expect(summary.tokens.byModel.map(\.key) == ["claude-opus-5-5"])
        #expect(summary.tokens.byMachine.first?.key == "mch_a")
        #expect(summary.tokens.total == 1050)
        #expect(summary.tokens.cacheRead == 5000)
        // Oldest first, malformed points dropped.
        #expect(summary.tokens.series.map(\.input) == [40, 50])
    }

    @Test func summaryWithoutTotalsCountsMachines() throws {
        let summary = try decode(SessionSummary.self, """
        { "summary": { "machines": [{ "machineId": "a", "running": 2, "waiting": 1 }, { "machineId": "b", "running": 1 }] } }
        """)
        #expect(summary.totals.running == 3)
        #expect(summary.totals.waiting == 1)
        #expect(summary.tokens.series.isEmpty)
    }
}

@Suite("Observe mode contract additions")
struct ObserveContractTests {
    @Test func accountSource() throws {
        let observed = try decode(Account.self, """
        { "id": "acct_1", "machineId": "mch_a", "provider": "claudeAgent", "label": "Claude Max", "status": "active", "source": "observed", "plan": "Max 20x" }
        """)
        #expect(observed.isObserved)
        let pooled = try decode(Account.self, """
        { "id": "acct_2", "machineId": "mch_a", "provider": "codex", "label": "Codex", "status": "active" }
        """)
        #expect(!pooled.isObserved)
        #expect(pooled.source == nil)
        // Observed subscriptions may omit the pool status and label.
        let bare = try decode(Account.self, #"{ "id": "acct_3", "provider": "codex", "source": "observed" }"#)
        #expect(bare.status == .active)
        #expect(bare.label == "acct_3")
    }

    @Test func pacingModeAndHeadroom() throws {
        let advise = try decode(Pacing.self, """
        { "mode": "advise", "enabled": false, "targetUsePercent": 95,
          "accounts": [{ "accountId": "a", "provider": "claudeAgent", "headroomAgents": 3, "windows": [] }, { "accountId": "b", "provider": "codex", "headroomAgents": "2.4" }, { "accountId": "c" }] }
        """)
        #expect(advise.mode == .advise)
        #expect(advise.isAdvisory)
        #expect(advise.accounts.map(\.headroomAgents) == [3, 2, nil])
        let legacy = try decode(Pacing.self, #"{ "enabled": true, "strategy": "rotation" }"#)
        #expect(legacy.mode == .enforce)
        #expect(!legacy.isAdvisory)
        let future = try decode(Pacing.self, #"{ "mode": "suggest-only" }"#)
        #expect(future.mode == .unknown)
        #expect(future.isAdvisory)
    }
}

@Suite("Observe presentation")
struct ObservePresentationTests {
    @Test func modelNames() {
        #expect(ModelName.display("claude-opus-5-5") == "Claude Opus 5.5")
        #expect(ModelName.display("claude-sonnet-4-5-20250929") == "Claude Sonnet 4.5")
        #expect(ModelName.display("claude-haiku-5-5") == "Claude Haiku 5.5")
        #expect(ModelName.display("gpt-5.5-codex") == "GPT-5.5 Codex")
        #expect(ModelName.display("gpt-5.5") == "GPT-5.5")
        #expect(ModelName.display("grok-5") == "grok-5")
        #expect(ModelName.display("auto") == "auto")
    }

    @Test func adviceHeadline() {
        let pacing = DemoObserve.pacing(now: now)
        let advice = PacingText.advice(pacing, sessionsRunning: 4)
        #expect(advice.text == "4 sessions running · Claude on track for 82% by reset, Codex for 61% · room for about 5 more agents")
        // Without the session summary, running agents are counted; without headroom, no room clause.
        var quiet = pacing
        quiet.accounts = quiet.accounts.map { var a = $0; a.headroomAgents = nil; return a }
        #expect(PacingText.advice(quiet, sessionsRunning: nil).text == "4 agents running · Claude on track for 82% by reset, Codex for 61%")
        var full = pacing
        full.accounts = full.accounts.map { var a = $0; a.headroomAgents = 0; return a }
        full.accounts[0].windows[1].onTrack = .over
        #expect(PacingText.advice(full, sessionsRunning: 1).text == "1 session running · Claude runs out before reset, Codex on track for 61% by reset · no room for more agents")
        #expect(PacingText.headroom(1) == "Room for about 1 more agent")
        #expect(PacingText.headroom(nil) == nil)
    }

    @Test func sessionTimes() {
        let running = ObservedSession(id: "a", machineId: "m", machineName: "m", provider: "codex", status: .running,
                                      createdAt: now.addingTimeInterval(-42 * 60), lastActivityAt: now)
        #expect(SessionText.time(running, now: now) == "for 42 min")
        let waiting = ObservedSession(id: "b", machineId: "m", machineName: "m", provider: "codex", status: .waiting,
                                      createdAt: now.addingTimeInterval(-7200), lastActivityAt: now.addingTimeInterval(-180))
        #expect(SessionText.time(waiting, now: now) == "waiting 3 min")
        let idle = ObservedSession(id: "c", machineId: "m", machineName: "m", provider: "codex", status: .idle,
                                   lastActivityAt: now.addingTimeInterval(-3 * 3600))
        #expect(SessionText.time(idle, now: now) == "active 3 h ago")
        #expect(SessionText.ago(2 * 86400) == "2 d")
        #expect(SessionText.title(idle) == "Untitled session")
        #expect(SessionText.statusLabel(.waiting) == "Waiting for you")
    }

    @Test func treeNestsSubagentsAndOrdersByUrgency() {
        let list = DemoObserve.sessions(now: now)
        let tree = SessionTree.build(list)
        #expect(tree.count == 10)
        #expect(tree.first?.session.status == .waiting)
        let parent = tree.first { $0.session.id == "ses_obs01" }
        #expect(parent?.children.map(\.id) == ["ses_obs01a", "ses_obs01b", "ses_obs01c"])
        #expect(parent?.subagents == 3)
        #expect(parent?.matches(.idle) == true)
        #expect(Array(tree.map(\.session.status.order)) == tree.map(\.session.status.order).sorted())
        let counts = SessionTree.counts(list)
        #expect(counts[.running] == 4)
        #expect(counts[.waiting] == 1)
        #expect(counts[.error] == 1)
        // A child whose parent is not listed stands on its own.
        let orphan = ObservedSession(id: "x", machineId: "m", machineName: "m", provider: "codex", status: .idle, parentThreadId: "thr_missing")
        #expect(SessionTree.build([orphan]).count == 1)
    }

    @Test func demoScenarioHasNoProjectsAndAdvisesOnly() async throws {
        let source = DemoDataSource(scenario: .observe)
        let factory = try await source.loadFactory()
        #expect(factory.projects.isEmpty)
        #expect(factory.machines.map(\.name) == ["justus-macbook-pro", "mac-mini"])
        #expect(factory.accounts.allSatisfy { $0.isObserved })
        #expect(factory.pacing?.isAdvisory == true)
        #expect(factory.sessions?.running == 4)
        #expect(factory.sessions?.summary(.day)?.tokens.series.count == 24)
        let full = try await DemoDataSource(scenario: .full).loadFactory()
        #expect(!full.projects.isEmpty)
        #expect(full.sessions?.sessions.isEmpty == false)
        #expect(full.pacing?.isAdvisory == false)
    }
}

@Suite("Observed sessions client")
struct SessionClientTests {
    @Test func followsCursorsAndSendsTheWindow() async throws {
        let stub = StubTransport { request in
            let url = request.url!.absoluteString
            if url.contains("/sessions/summary") { return (200, #"{ "machines": [], "totals": { "running": 0, "waiting": 0, "sessionsActive": 0 }, "tokens": {} }"#) }
            if url.contains("cursor=c2") { return (200, #"{ "sessions": [{ "id": "s2", "provider": "codex", "status": "idle" }] }"#) }
            return (200, #"{ "sessions": [{ "id": "s1", "provider": "codex", "status": "running" }], "nextCursor": "c2" }"#)
        }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: "t", transport: stub)
        let all = try await client.allSessions(pageSize: 1)
        #expect(all?.map(\.id) == ["s1", "s2"])
        #expect(stub.requests[0].url?.absoluteString == "http://localhost:4320/api/v1/sessions?limit=1")
        #expect(stub.requests[1].url?.absoluteString == "http://localhost:4320/api/v1/sessions?cursor=c2&limit=1")
        _ = try await client.sessionSummary(window: .hour)
        #expect(stub.requests.last?.url?.absoluteString == "http://localhost:4320/api/v1/sessions/summary?window=1h")
    }

    @Test func missingRoutesMeanNotObservingYet() async throws {
        let stub = StubTransport { _ in (404, #"{ "error": { "code": "NOT_FOUND", "message": "No route." } }"#) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: "t", transport: stub)
        #expect(try await client.allSessions() == nil)
        #expect(try await client.sessionSummary(window: .day) == nil)
        // The data source asks for the list and three summaries at once.
        let concurrent = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: "t", transport: NotFoundTransport())
        #expect(await HubDataSource(client: concurrent).loadSessions() == nil)
    }
}

/// Answers 404 to everything; safe to call from concurrent requests.
private struct NotFoundTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(#"{ "error": { "code": "NOT_FOUND", "message": "No route." } }"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
    func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        (AsyncThrowingStream { $0.finish() }, HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
}
