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
        let stub = StubTransport { _ in (200, #"{"ok":true,"version":"0.3.0"}"#) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let health = try await client.health()
        #expect(health.version == "0.3.0")
        #expect(stub.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func queryAndEscaping() async throws {
        let stub = StubTransport { _ in (200, "[]") }
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

    @Test func draftRequestBody() async throws {
        let stub = StubTransport { _ in (202, #"{"assignmentId":"asg_7"}"#) }
        let client = try HubClient(baseURL: URL(string: "https://hub.example.com")!, token: token, transport: stub)
        let result = try await client.requestDraft(projectId: "prj_1", prompt: "Build it carefully", baseWorkflowId: nil)
        #expect(result.followAssignmentId == "asg_7")
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
            #"data: "data":{"fromNode":"build","toNode":"review","edgeId":"e4"}}"#,
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
