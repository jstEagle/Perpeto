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
    func startRun(workflowId: String, settings: RunSettings) async throws -> Run { try await demo.startRun(workflowId: workflowId, settings: settings) }
    func decide(workItemId: String, _ decision: HubClient.Decision, decisionId: String?) async throws { try await demo.decide(workItemId: workItemId, decision, decisionId: decisionId) }
    func sendMessage(projectId: String, channelId: String, body: String, to recipient: MessageRecipient, parentId: String?) async throws -> Message {
        try await demo.sendMessage(projectId: projectId, channelId: channelId, body: body, to: recipient, parentId: parentId)
    }
    func updateRun(runId: String, settings: RunSettings) async throws -> Run { try await demo.updateRun(runId: runId, settings: settings) }
    func templates() async throws -> [WorkflowTemplate] { try await demo.templates() }
    func createWorkflow(projectId: String, from template: WorkflowTemplate) async throws -> Workflow { try await demo.createWorkflow(projectId: projectId, from: template) }
    func ackMessage(projectId: String, channelId: String, messageId: String) async throws -> Message { try await demo.ackMessage(projectId: projectId, channelId: channelId, messageId: messageId) }
    func markRead(projectId: String, channelId: String, messageId: String) async throws -> UnreadState { try await demo.markRead(projectId: projectId, channelId: channelId, messageId: messageId) }
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

@Suite("Controlled messaging")
struct MessagingTests {
    static let v2 = """
    { "id": "m2", "projectId": "p", "channelId": "run-r", "senderRoleId": "planner", "recipientRoleId": "builder", "body": "Split it.",
      "createdAt": "2026-10-21T09:00:00Z", "threadId": "m1", "parentId": "m1", "senderKind": "agent", "senderAssignmentId": "asg_1",
      "unplanned": true, "receipt": { "state": "delivered", "deliveredAt": "2026-10-21T09:00:20Z", "deliveredVia": "steer", "deliveredTo": "asg_2",
      "ackedAt": null, "ackNote": null } }
    """

    @Test func decodesThreadsReceiptsAndOldMessages() throws {
        let m = try HubCoding.decoder().decode(Message.self, from: Data(Self.v2.utf8))
        #expect(m.threadId == "m1")
        #expect(!m.isRoot)
        #expect(m.unplanned)
        #expect(m.receipt?.state == .delivered)
        #expect(m.receipt?.deliveredVia == .steer)
        let old = try HubCoding.decoder().decode(Message.self, from: Data("""
        { "id": "m9", "projectId": "p", "channelId": "c", "senderRoleId": "owner", "recipientRoleId": null, "body": "Hi", "createdAt": "2026-10-21T09:00:00Z" }
        """.utf8))
        #expect(old.threadId == "m9")
        #expect(old.isRoot)
        #expect(old.receipt == nil)
    }

    @Test func repliesAckAndReadCursorUseTheContract() async throws {
        let stub = StubTransport { request in
            let path = request.url!.path()
            if path.hasSuffix("/ack") { return (200, #"{"message":"# + MessagingTests.v2 + #","changed":true}"#) }
            if path.hasSuffix("/unread") { return (200, #"{"roleId":"owner","messages":[],"unreadCount":3,"lastReadMessageId":"m1"}"#) }
            if path.hasSuffix("/read-cursor") { return (200, #"{"roleId":"owner","lastReadMessageId":"m2","unreadCount":0}"#) }
            return (200, #"{"message":"# + MessagingTests.v2 + #","duplicate":false}"#)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: "t", transport: stub)
        _ = try await client.sendMessage(projectId: "p", channelId: "run-r", senderRoleId: "owner", to: .parentSender, parentId: "m1", body: "Thanks")
        _ = try await client.sendMessage(projectId: "p", channelId: "run-r", senderRoleId: "owner", to: .everyone, parentId: "m1", body: "All of you")
        let reply = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
        #expect(reply["parentId"] as? String == "m1")
        #expect(reply.keys.contains("recipientRoleId") == false, "a reply without a recipient answers the parent's sender")
        let everyone = try JSONSerialization.jsonObject(with: stub.requests[1].httpBody!) as! [String: Any]
        #expect(everyone["recipientRoleId"] is NSNull, "an explicit null addresses the channel")
        _ = try await client.ackMessage(projectId: "p", channelId: "run-r", messageId: "m2", roleId: "owner")
        #expect(stub.requests[2].url?.path() == "/api/v1/messaging/projects/p/channels/run-r/messages/m2/ack")
        #expect(try await client.unread(projectId: "p", channelId: "run-r", roleId: "owner").unreadCount == 3)
        #expect(stub.requests[3].url?.query()?.contains("roleId=owner") == true)
        #expect(try await client.markRead(projectId: "p", channelId: "run-r", messageId: "m2", roleId: "owner").unreadCount == 0)
    }

    @MainActor @Test func ownerAcksAndReadsInTheDemo() async throws {
        let store = FactoryStore(source: DemoDataSource(stageDelay: .zero))
        await store.refresh()
        let project = DemoFixtures.primaryProjectId
        let channel = "run-\(DemoFixtures.liveRunId)"
        #expect(store.state(project).unread[channel] == 1)
        let question = try #require(store.state(project).messages[channel]?.first { $0.recipientRoleId == "owner" })
        await store.acknowledge(question)
        #expect(store.state(project).messages[channel]?.first { $0.id == question.id }?.receipt?.state == .acked)
        await store.markRead(projectId: project, channelId: channel)
        #expect(store.state(project).unread[channel] == 0)
        await store.send(projectId: project, channelId: channel, body: "Looking now.", to: .parentSender, parentId: question.id)
        let reply = try #require(store.state(project).messages[channel]?.last)
        #expect(reply.threadId == question.threadId)
        #expect(reply.recipientRoleId == question.senderRoleId)
    }
}


@Suite("Continuous runs and budgets")
struct ContinuousRunTests {
    static let run = """
    { "id": "run_1", "projectId": "p", "workflowId": "w", "workflowVersion": 2, "status": "running", "startedAt": "2026-10-21T08:00:00Z",
      "keepOpen": true, "source": "schedule", "schedule": "0 9 * * 1-5", "budget": { "maxTokensPerDay": 2000000, "maxActiveItems": 3 },
      "intake": { "paused": true, "requests": {}, "lastTicks": {}, "reason": { "limit": "maxTokensPerDay", "used": 2040000, "maximum": 2000000, "requested": 1, "day": "2026-10-21" } },
      "budgetUsage": { "day": "2026-10-21", "tokens": 2040000, "items": 2 } }
    """

    @Test func runDecodesSettingsIntakeAndUsage() throws {
        let run = try HubCoding.decoder().decode(Run.self, from: Data(Self.run.utf8))
        #expect(run.settings.keepOpen)
        #expect(run.settings.source == .schedule)
        #expect(run.settings.budget?.maxActiveItems == 3)
        #expect(run.isBudgetHeld)
        #expect(run.intake?.reason?.limit == .maxTokensPerDay)
        #expect(run.budgetUsage?.tokens == 2_040_000)
        let done = try HubCoding.decoder().decode(Run.self, from: Data("""
        { "id": "r", "projectId": "p", "workflowId": "w", "workflowVersion": 1, "status": "completed", "startedAt": "2026-10-21T08:00:00Z",
          "stoppedAt": "2026-10-21T09:30:00Z", "completedAt": "2026-10-21T09:30:00Z" }
        """.utf8))
        #expect(done.completedAt != nil)
        #expect(!done.settings.keepOpen)
        #expect(!done.isBudgetHeld)
    }

    @Test func startAndPatchSendTheContract() async throws {
        let stub = StubTransport { request in
            request.url!.path().hasSuffix("/workflow-templates")
                ? (200, #"{"templates":[{"id":"security-audit","description":"Audit for vulnerabilities."}]}"#)
                : (200, ContinuousRunTests.run)
        }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: "t", transport: stub)
        let settings = RunSettings(keepOpen: true, source: .schedule, schedule: "30 7 * * *", budget: RunBudget(maxTokensPerDay: 1_000_000))
        _ = try await client.startRun(workflowId: "w", settings: settings)
        let start = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
        let input = try #require(start["input"] as? [String: Any])
        #expect(input["keepOpen"] as? Bool == true)
        #expect(input["schedule"] as? String == "30 7 * * *")
        #expect((input["budget"] as? [String: Any])?["maxTokensPerDay"] as? Int == 1_000_000)
        _ = try await client.updateRun(runId: "run_1", settings: RunSettings(keepOpen: false, source: .goals))
        #expect(stub.requests[1].httpMethod == "PATCH")
        let patch = try JSONSerialization.jsonObject(with: stub.requests[1].httpBody!) as! [String: Any]
        #expect((patch["budget"] as? [String: Any])?.isEmpty == true, "an empty budget removes the limits")
        #expect(patch["schedule"] == nil)
        let templates = try await client.templates()
        #expect(templates.first?.name == "Security audit")
        #expect(templates.first?.purpose == .securityAudit)
    }

    @Test func scheduleRulesRoundTrip() {
        for cron in ["15 * * * *", "0 9 * * *", "30 7 * * 1-5", "0 18 * * 5"] {
            #expect(ScheduleRule(cron: cron).cron == cron)
        }
        #expect(ScheduleRule(cron: "0 9 * * 1-5").summary == "weekdays at 09:00 UTC")
        let odd = ScheduleRule(cron: "*/10 8-17 * * *")
        #expect(odd.custom != nil)
        #expect(odd.cron == "*/10 8-17 * * *")
    }

    @MainActor @Test func raisingTheBudgetReleasesTheHoldInTheDemo() async throws {
        let store = FactoryStore(source: DemoDataSource(stageDelay: .zero))
        await store.refresh()
        let project = DemoFixtures.primaryProjectId
        let held = try #require(store.state(project).runs.first { $0.id == DemoFixtures.improveRunId })
        #expect(held.isBudgetHeld)
        var settings = held.settings
        settings.budget?.maxTokensPerDay = 5_000_000
        await store.updateRun(held, settings: settings)
        let after = try #require(store.state(project).runs.first { $0.id == DemoFixtures.improveRunId })
        #expect(!after.isBudgetHeld)
        #expect(after.settings.budget?.maxTokensPerDay == 5_000_000)
        #expect(store.factory.usage.byRole.map(\.key).contains("reviewer"))
    }
}
