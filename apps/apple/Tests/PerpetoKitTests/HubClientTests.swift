import Foundation
import Testing
@testable import PerpetoKit

/// Records requests and replays canned responses.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    var responder: (URLRequest) -> (Int, String)
    var streamLines: [String] = []

    init(_ responder: @escaping (URLRequest) -> (Int, String)) { self.responder = responder }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let (status, body) = responder(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        requests.append(request)
        let lines = streamLines
        return (AsyncThrowingStream { c in
            lines.forEach { c.yield($0) }
            c.finish()
        }, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@Suite("Hub client")
struct HubClientTests {
    let token = "secret-owner-token-123"

    @Test func listsUnderApiV1WithBearer() async throws {
        let stub = StubTransport { _ in (200, #"{"projects":[]}"#) }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com/factory/")!, token: token, transport: stub)
        _ = try await client.projects()
        let request = try #require(stub.requests.first)
        #expect(request.url?.absoluteString == "https://hub.example.com/factory/api/v1/projects")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        #expect(request.httpMethod == "GET")
    }

    @Test func healthIsUnauthenticated() async throws {
        let stub = StubTransport { _ in (200, #"{"status":"ok","version":"0.3.0"}"#) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let health = try await client.health()
        #expect(health.version == "0.3.0")
        #expect(stub.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func queryAndEscaping() async throws {
        let stub = StubTransport { _ in (200, #"{"groupBy":"day","groups":[],"totals":{}}"#) }
        let client = try HubClient(baseURL: URL(string: "http://127.0.0.1:4320")!, token: token, transport: stub)
        _ = try await client.usage(projectId: "prj a/b", groupBy: .day)
        _ = try? await client.runMetrics(runId: "run_1", window: .week)
        #expect(stub.requests[0].url?.absoluteString == "http://127.0.0.1:4320/api/v1/usage?groupBy=day&projectId=prj%20a/b")
        // A slash inside a path segment must not create a new segment.
        _ = try? await client.run("a/b")
        #expect(stub.requests[1].url?.absoluteString == "http://127.0.0.1:4320/api/v1/runs/run_1/metrics?window=7d")
        #expect(stub.requests[2].url?.path().contains("a%2Fb") == true)
    }

    @Test func mutationsCarryIdempotencyKey() async throws {
        let stub = StubTransport { request in
            (200, #"{ "id": "wf_1", "projectId": "p", "name": "B", "purpose": "build", "version": 5, "status": "active", "graph": { "schema": "perpeto.workflow/1", "nodes": [], "edges": [] } }"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let workflow = try await client.activate(workflowId: "wf_1", version: 5, idempotencyKey: "key-1")
        #expect(workflow.version == 5)
        let request = try #require(stub.requests.first)
        #expect(request.url?.path() == "/api/v1/workflows/wf_1/activate")
        #expect(request.httpMethod == "POST")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        #expect(body["version"] as? Int == 5)
        #expect(body["idempotencyKey"] as? String == "key-1")
    }

    @Test func patchProjectAndJobLog() async throws {
        let stub = StubTransport { request in
            request.url!.path().hasSuffix("/log")
                ? (200, #"{"jobId":"job_1","chunks":[{"id":1,"jobId":"job_1","chunk":"step Test: ","at":"2026-10-21T09:00:00Z"},{"id":2,"jobId":"job_1","chunk":"ok\n","at":"2026-10-21T09:00:01Z"}]}"#)
                : (200, #"{ "id": "prj_1", "name": "renamed", "repo": { "url": "u", "defaultBranch": "main" }, "docs": [], "goals": ["g"], "createdAt": "2026-10-21T09:00:00Z", "updatedAt": "2026-10-21T09:00:00Z" }"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let project = try await client.updateProject("prj_1", .init(goals: ["g"]))
        #expect(project.goals.map(\.title) == ["g"])
        #expect(stub.requests[0].httpMethod == "PATCH")
        let body = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
        #expect(body["goals"] as? [String] == ["g"])
        #expect(body["name"] == nil)
        #expect(try await client.jobLog("job_1") == "step Test: ok\n")
    }

    @Test func draftRequestBody() async throws {
        let stub = StubTransport { _ in (202, HubShapes.architectAssignment) }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let result = try await client.requestDraft(projectId: "prj_1", prompt: "Build it carefully", baseWorkflowId: nil)
        #expect(result.id == "asg_7")
        #expect(result.runId == nil)
        let request = try #require(stub.requests.first)
        #expect(request.url?.path() == "/api/v1/projects/prj_1/workflows/drafts")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        #expect(body["prompt"] as? String == "Build it carefully")
        #expect(body["idempotencyKey"] is String)
    }

    @Test func errorEnvelopeMapsToHubError() async throws {
        let stub = StubTransport { request in
            request.url!.path().hasSuffix("/runs/run_1/pause")
                ? (409, #"{"error":{"code":"lease_lost","message":"A newer lease owns this work."}}"#)
                : (401, #"{"error":{"code":"UNAUTHORIZED","message":"no"}}"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        await #expect(throws: HubError.conflict(code: "lease_lost", message: "A newer lease owns this work.")) {
            try await client.control(runId: "run_1", .pause)
        }
        do {
            _ = try await client.machines()
            Issue.record("Expected unauthorized")
        } catch let error as HubError {
            #expect(error == .unauthorized)
            #expect(error.errorDescription?.contains(token) == false)
        }
    }

    @Test func rejectsRemotePlainHTTP() {
        #expect(throws: HubError.insecureRemote) { try HubClient(baseURL: URL(string: "http://hub.example.com")!, token: token) }
        #expect(throws: HubError.invalidURL) { try HubClient(baseURL: URL(string: "ftp://hub.example.com")!, token: token) }
    }

    @Test func eventStreamDecodesSSE() async throws {
        let stub = StubTransport { _ in (200, "") }
        stub.streamLines = [
            ": keepalive",
            "id: 7",
            "event: event",
            #"data: {"seq":7,"at":"2026-10-21T10:00:00Z","type":"workitem.moved","subject":{"kind":"workItem","id":"wi_1"},"#,
            #"data: "data":{"sourceNodeId":"build","targetNodeId":"review","edgeId":"e4","kind":"flow","unplanned":false}}"#,
            "",
        ]
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        var received: [HubEvent] = []
        for try await event in client.eventStream(after: 6) {
            received.append(event)
            break
        }
        #expect(received.first?.seq == 7)
        #expect(received.first?.edgeId == "e4")
        let request = try #require(stub.requests.first)
        #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(request.url?.query() == "after=6")
    }
}

/// Response bodies as the hub in apps/hub returns them.
enum HubShapes {
    static let architectAssignment = #"""
    { "id": "asg_7", "projectId": "prj_1", "nodeId": "workflow-architect", "role": "workflow-architect", "prompt": "Build it carefully",
      "harness": { "provider": "claudeAgent", "model": "claude-opus-5-5" },
      "policy": { "maxSubagents": 0, "allowedSubagentProviders": [], "canMessage": [] }, "requirements": {},
      "repo": { "url": "/tmp/repo.git", "defaultBranch": "main" }, "status": "queued", "attempt": 1,
      "architectRequestId": "arq_1", "architectAttempt": 1, "createdAt": "2026-10-21T09:00:00.000Z" }
    """#
}

@Suite("Hub routes and shapes")
struct HubRouteTests {
    let token = "secret-owner-token-123"

    @Test func projectRunsAndAssignment() async throws {
        let stub = StubTransport { request in
            request.url!.path().hasPrefix("/api/v1/assignments/")
                ? (200, HubShapes.architectAssignment.replacingOccurrences(of: #""status": "queued""#, with: #""status": "succeeded", "draftWorkflowId": "wf_1", "draftVersion": 2"#))
                : (200, #"{"runs":[{"id":"run_1","projectId":"prj_1","workflowId":"wf_1","workflowVersion":1,"status":"running","startedAt":"2026-10-21T09:00:00.000Z"}]}"#)
        }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let runs = try await client.runs(projectId: "prj_1", status: .running)
        #expect(runs.map(\.id) == ["run_1"])
        #expect(stub.requests[0].url?.absoluteString == "http://localhost:4320/api/v1/projects/prj_1/runs?status=running")
        let assignment = try await client.assignment("asg_7")
        #expect(assignment.draftWorkflowId == "wf_1")
        #expect(assignment.draftVersion == 2)
    }

    @Test func saveSendsOnlyMergeableFields() async throws {
        let stub = StubTransport { _ in
            (200, #"{ "id": "wf_1", "projectId": "p", "name": "B", "purpose": "build", "version": 6, "status": "draft", "parentVersion": 5, "authoredBy": {"kind":"user"}, "graph": { "schema": "perpeto.workflow/1", "nodes": [], "edges": [] } }"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let workflow = Workflow(id: "wf_1", projectId: "p", name: "B", purpose: .build, version: 5, graph: .init(nodes: [], edges: []), status: .active)
        let saved = try await client.saveWorkflow(workflow)
        #expect(saved.version == 6)
        let body = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
        #expect(Set(body.keys) == ["name", "graph", "purpose", "idempotencyKey"])
    }

    @Test func decisionsAndInputsReturnAccepted() async throws {
        let stub = StubTransport { _ in (202, #"{"accepted":true}"#) }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        try await client.decide(workItemId: "wi_1", .fail, decisionId: "hd_1", note: "Needs tests")
        try await client.addInputs(runId: "run_1", items: ["Add dark mode"])
        let decision = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
        #expect(decision["decision"] as? String == "fail")
        #expect(decision["decisionId"] as? String == "hd_1")
        let inputs = try JSONSerialization.jsonObject(with: stub.requests[1].httpBody!) as! [String: Any]
        #expect((inputs["items"] as? [[String: Any]])?.first?["title"] as? String == "Add dark mode")
    }

    @Test func eventsPageAndKeyedLists() async throws {
        let stub = StubTransport { request in
            request.url!.path().hasSuffix("/events")
                ? (200, #"{"events":[{"seq":3,"at":"2026-10-21T09:00:00.000Z","type":"run.started","projectId":"p","runId":"r","subject":{"kind":"run","id":"r"},"data":{}}],"nextCursor":3}"#)
                : (200, #"{"entries":[]}"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let page = try await client.events(after: 2, limit: 5000)
        #expect(page.nextCursor == 3)
        #expect(stub.requests[0].url?.query()?.contains("limit=1000") == true)
        #expect(try await client.mergeQueue(projectId: "p").isEmpty)
        // A list under the wrong key is a decoding error, not an empty list.
        await #expect(throws: HubError.decoding("projects list")) { _ = try await client.projects() }
    }
}

@Suite("Server-sent events parser")
struct SSEParserTests {
    @Test func multilineDataCommentsAndRetry() {
        var parser = ServerSentEventParser()
        let lines = [": hi", "retry: 3000", "id: 12", "data: one", "data:two", "", "data: three"]
        let events = lines.compactMap { parser.feed($0) } + [parser.finish()].compactMap { $0 }
        #expect(events.count == 2)
        #expect(events[0] == ServerSentEvent(id: "12", event: nil, data: "one\ntwo", retry: 3000))
        // id persists across events per the spec.
        #expect(events[1].id == "12")
        #expect(events[1].data == "three")
    }

    @Test func blankLineWithoutDataDispatchesNothing() {
        var parser = ServerSentEventParser()
        #expect(parser.feed("event: ping") == nil)
        #expect(parser.feed("") == nil)
    }
}

@Suite("Settings")
struct SettingsTests {
    @Test func tokenLivesInKeychainNotDefaults() throws {
        let suite = "perpeto.tests.\(UUID().uuidString)"
        let store = KeychainTokenStore(service: "app.perpeto.tests.\(UUID().uuidString)", account: "owner-token")
        let settings = HubSettings(defaultsSuite: suite, tokens: store)
        settings.setHubURL(" https://hub.example.com ")
        #expect(settings.hubURL?.absoluteString == "https://hub.example.com")
        guard store.write("tok-abc") else {
            // Keychain unavailable in this environment (for example a locked CI keychain).
            return
        }
        defer { store.delete() }
        #expect(store.read() == "tok-abc")
        let defaults = UserDefaults(suiteName: suite)!
        #expect(!defaults.dictionaryRepresentation().values.contains { "\($0)".contains("tok-abc") })
        #expect(try settings.makeClient() != nil)
        defaults.removePersistentDomain(forName: suite)
    }

    @Test func noClientWithoutToken() throws {
        let settings = HubSettings(defaultsSuite: "perpeto.tests.\(UUID().uuidString)", tokens: KeychainTokenStore(service: "app.perpeto.tests.none.\(UUID().uuidString)"))
        settings.setHubURL("https://hub.example.com")
        #expect(try settings.makeClient() == nil)
    }
}

@Suite("Live event handling")
struct LiveEventTests {
    static func event(_ seq: Int, _ type: String, runId: String? = DemoFixtures.liveRunId) -> HubEvent {
        HubEvent(seq: seq, at: Date(), type: type, projectId: DemoFixtures.primaryProjectId, runId: runId, subject: .init(kind: "assignment", id: "asg"), data: [:])
    }

    @MainActor @Test func housekeepingIsIgnoredAndBurstsAreDebounced() async throws {
        let source = CountingSource()
        let store = FactoryStore(source: source)
        store.eventDebounce = .milliseconds(50)
        await store.refresh()
        let before = await source.runLoads
        store.apply(Self.event(9001, "assignment.renewed"))
        store.apply(Self.event(9002, "machine.heartbeat", runId: nil))
        #expect(!store.state(DemoFixtures.primaryProjectId).events.contains { $0.seq >= 9001 })
        for seq in 9003...9010 { store.apply(Self.event(seq, "workitem.moved")) }
        try await Task.sleep(for: .milliseconds(300))
        #expect(await source.runLoads == before + 1)
        #expect(store.state(DemoFixtures.primaryProjectId).events.first?.seq == 9010)
    }

    @MainActor @Test func windowChangeRefetchesMetrics() async throws {
        let store = FactoryStore(source: DemoDataSource(stageDelay: .zero))
        await store.refresh()
        let day = store.state(DemoFixtures.primaryProjectId).runMetrics[DemoFixtures.liveRunId]
        await store.setMetricsWindow(.week)
        let week = store.state(DemoFixtures.primaryProjectId).runMetrics[DemoFixtures.liveRunId]
        #expect(week?.window == .week)
        #expect(week?.run.velocity.trend.count == 7)
        #expect(day?.run.velocity.trend.count == 24)
    }
}

/// Demo data that counts run reloads.
actor CountingSource: FactoryDataSource {
    let demo = DemoDataSource(stageDelay: .zero)
    var runLoads = 0
    nonisolated var isDemo: Bool { false }
    func loadFactory() async throws -> FactoryState { try await demo.loadFactory() }
    func loadProject(_ projectId: String, window: MetricsWindow) async throws -> ProjectState { try await demo.loadProject(projectId, window: window) }
    func loadRun(_ runId: String, window: MetricsWindow) async throws -> RunSnapshot {
        runLoads += 1
        return try await demo.loadRun(runId, window: window)
    }
    nonisolated func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) -> AsyncThrowingStream<DraftProgress, Error> { demo.requestDraft(projectId: projectId, prompt: prompt, baseWorkflowId: baseWorkflowId) }
    func activate(workflowId: String, version: Int) async throws -> Workflow { try await demo.activate(workflowId: workflowId, version: version) }
    func save(_ workflow: Workflow) async throws -> Workflow { try await demo.save(workflow) }
    func validate(_ workflow: Workflow) async throws -> ValidationResult { try await demo.validate(workflow) }
    func control(runId: String, _ action: HubClient.RunControl) async throws -> Run { try await demo.control(runId: runId, action) }
    func startRun(workflowId: String) async throws -> Run { try await demo.startRun(workflowId: workflowId) }
    func decide(workItemId: String, _ decision: HubClient.Decision, decisionId: String?) async throws { try await demo.decide(workItemId: workItemId, decision, decisionId: decisionId) }
    func sendMessage(projectId: String, channelId: String, body: String) async throws -> Message { try await demo.sendMessage(projectId: projectId, channelId: channelId, body: body) }
    func enrollmentCode() async throws -> EnrollmentCode { try await demo.enrollmentCode() }
    func drain(machineId: String) async throws -> Machine { try await demo.drain(machineId: machineId) }
    nonisolated func events(after: Int?) -> AsyncThrowingStream<HubEvent, Error> { AsyncThrowingStream { _ in } }
}

@Suite("Human decisions")
struct DecisionTests {
    @Test func workItemCarriesDecisionId() throws {
        let item = try HubCoding.decoder().decode(WorkItem.self, from: Data("""
        { "id": "wi_1", "runId": "run_1", "projectId": "p", "title": "Release", "nodeId": "approve", "status": "blocked",
          "iteration": 0, "decisionId": "hd_9", "waiting": { "kind": "human", "decisionId": "hd_9" } }
        """.utf8))
        #expect(item.decisionId == "hd_9")
    }

    @Test func staleDecisionIsAConflict() async throws {
        let stub = StubTransport { _ in (409, #"{"error":{"code":"STALE_DECISION","message":"This decision answers an earlier wait; the work item now waits for another decision."}}"#) }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: "t", transport: stub)
        await #expect(throws: HubError.conflict(code: "STALE_DECISION", message: "This decision answers an earlier wait; the work item now waits for another decision.")) {
            try await client.decide(workItemId: "wi_1", .pass, decisionId: "hd_old")
        }
    }

    @MainActor @Test func storeExplainsAStaleDecision() async throws {
        let demo = DemoDataSource(stageDelay: .zero)
        let store = FactoryStore(source: demo)
        await store.refresh()
        let project = DemoFixtures.primaryProjectId
        var item = try #require(store.state(project).workItems.first)
        // The demo item waits with no decisionId; a stale one must still be refused when it has one.
        try await demo.setDecisionId("hd_new", workItemId: item.id)
        item.decisionId = "hd_old"
        await store.decide(projectId: project, item: item, .pass)
        #expect(store.lastError?.contains("now waits for a different decision") == true)
        item.decisionId = "hd_new"
        await store.decide(projectId: project, item: item, .pass)
        #expect(store.lastError == nil)
    }
}
