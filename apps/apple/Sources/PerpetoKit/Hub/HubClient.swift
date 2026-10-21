import Foundation

/// Sends requests. Injected so tests can verify paths and headers without a network.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HubError.transport("Not an HTTP response") }
        return (data, http)
    }

    /// Yields lines including empty ones; `AsyncBytes.lines` drops blank
    /// lines, which delimit server-sent events.
    public func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw HubError.transport("Not an HTTP response") }
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                var buffer: [UInt8] = []
                do {
                    for try await byte in bytes {
                        if byte == 0x0A {
                            if buffer.last == 0x0D { buffer.removeLast() }
                            continuation.yield(String(decoding: buffer, as: UTF8.self))
                            buffer.removeAll(keepingCapacity: true)
                        } else {
                            buffer.append(byte)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(String(decoding: buffer, as: UTF8.self)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (lines, http)
    }
}

/// Async client for Hub API v1 (docs/architecture/README.md "Hub API v1").
///
/// The owner token is held in memory only for the life of the client and is
/// sent solely in the `Authorization` header. It is never logged or included
/// in errors.
public final class HubClient: Sendable {
    public let baseURL: URL
    private let token: String
    private let transport: HTTPTransport

    public init(baseURL: URL, token: String, transport: HTTPTransport = URLSessionTransport()) throws {
        guard let scheme = baseURL.scheme?.lowercased(), scheme == "http" || scheme == "https", baseURL.host != nil else {
            throw HubError.invalidURL
        }
        if scheme == "http", !["localhost", "127.0.0.1", "::1", "[::1]"].contains(baseURL.host ?? "") {
            throw HubError.insecureRemote
        }
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    // MARK: Projects

    public func health() async throws -> HubHealth { try await get("/health", authenticated: false) }
    public func overview() async throws -> FactoryOverview { try await get("/overview") }
    public func projects() async throws -> [Project] { try await list("/projects") }
    public func project(_ id: String) async throws -> Project { try await get("/projects/\(escape(id))") }

    public struct NewProject: Encodable, Sendable {
        public var name: String
        public var repo: Project.Repo
        public var docs: [DocRef]
        public var goals: [String]
        public init(name: String, repo: Project.Repo, docs: [DocRef] = [], goals: [String] = []) {
            self.name = name
            self.repo = repo
            self.docs = docs
            self.goals = goals
        }
    }

    public func createProject(_ project: NewProject, idempotencyKey: String = UUID().uuidString) async throws -> Project {
        try await send("POST", "/projects", body: project, idempotencyKey: idempotencyKey)
    }

    public struct ProjectPatch: Encodable, Sendable {
        public var name: String?
        public var repo: Project.Repo?
        public var docs: [DocRef]?
        public var goals: [String]?
        public init(name: String? = nil, repo: Project.Repo? = nil, docs: [DocRef]? = nil, goals: [String]? = nil) {
            self.name = name
            self.repo = repo
            self.docs = docs
            self.goals = goals
        }
    }

    public func updateProject(_ id: String, _ patch: ProjectPatch, idempotencyKey: String = UUID().uuidString) async throws -> Project {
        try await send("PATCH", "/projects/\(escape(id))", body: patch, idempotencyKey: idempotencyKey)
    }

    // MARK: Workflows

    public func workflows(projectId: String) async throws -> [Workflow] { try await list("/projects/\(escape(projectId))/workflows") }
    public func workflow(_ id: String) async throws -> Workflow { try await get("/workflows/\(escape(id))") }
    public func versions(workflowId: String) async throws -> [Workflow] { try await list("/workflows/\(escape(workflowId))/versions") }

    /// PUT validates and bumps `version`.
    public func saveWorkflow(_ workflow: Workflow, idempotencyKey: String = UUID().uuidString) async throws -> Workflow {
        try await send("PUT", "/workflows/\(escape(workflow.id))", body: workflow, idempotencyKey: idempotencyKey)
    }

    public func validate(workflowId: String, graph: WorkflowGraph) async throws -> ValidationResult {
        struct Body: Encodable { var graph: WorkflowGraph }
        return try await send("POST", "/workflows/\(escape(workflowId))/validate", body: Body(graph: graph), idempotencyKey: nil)
    }

    /// Asks the workflow architect for a draft. Returns the assignment to follow.
    public func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?, idempotencyKey: String = UUID().uuidString) async throws -> DraftRequestResult {
        struct Body: Encodable {
            var prompt: String
            var baseWorkflowId: String?
        }
        return try await send("POST", "/projects/\(escape(projectId))/workflows/drafts", body: Body(prompt: prompt, baseWorkflowId: baseWorkflowId), idempotencyKey: idempotencyKey)
    }

    public func activate(workflowId: String, version: Int, idempotencyKey: String = UUID().uuidString) async throws -> Workflow {
        struct Body: Encodable { var version: Int }
        return try await send("POST", "/workflows/\(escape(workflowId))/activate", body: Body(version: version), idempotencyKey: idempotencyKey)
    }

    // MARK: Runs

    public func startRun(workflowId: String, idempotencyKey: String = UUID().uuidString) async throws -> Run {
        try await send("POST", "/workflows/\(escape(workflowId))/runs", body: EmptyBody(), idempotencyKey: idempotencyKey)
    }

    public func run(_ id: String) async throws -> Run { try await get("/runs/\(escape(id))") }

    public enum RunControl: String, Sendable { case pause, resume, stop }

    public func control(runId: String, _ action: RunControl, idempotencyKey: String = UUID().uuidString) async throws -> Run {
        try await send("POST", "/runs/\(escape(runId))/\(action.rawValue)", body: EmptyBody(), idempotencyKey: idempotencyKey)
    }

    public func addInputs(runId: String, items: [String], idempotencyKey: String = UUID().uuidString) async throws -> [WorkItem] {
        struct Item: Encodable { var title: String }
        struct Body: Encodable { var items: [Item] }
        let data = try await raw("POST", "/runs/\(escape(runId))/inputs", body: Body(items: items.map(Item.init)), idempotencyKey: idempotencyKey)
        return try decode(ListEnvelope<WorkItem>.self, from: data).items
    }

    public func workItems(runId: String) async throws -> [WorkItem] { try await list("/runs/\(escape(runId))/work-items") }
    public func assignments(runId: String) async throws -> [Assignment] { try await list("/runs/\(escape(runId))/assignments") }
    public func runMetrics(runId: String, window: MetricsWindow) async throws -> MetricsSnapshot {
        try await get("/runs/\(escape(runId))/metrics", query: ["window": window.rawValue])
    }
    public func projectMetrics(projectId: String, window: MetricsWindow) async throws -> MetricsSnapshot {
        try await get("/projects/\(escape(projectId))/metrics", query: ["window": window.rawValue])
    }

    public enum Decision: String, Encodable, Sendable { case pass, fail }

    public func decide(workItemId: String, _ decision: Decision, note: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> WorkItem {
        struct Body: Encodable {
            var decision: Decision
            var note: String?
        }
        return try await send("POST", "/work-items/\(escape(workItemId))/decision", body: Body(decision: decision, note: note), idempotencyKey: idempotencyKey)
    }

    // MARK: Factory

    public func machines() async throws -> [Machine] { try await list("/machines") }
    public func accounts() async throws -> [Account] { try await list("/accounts") }

    public func createEnrollmentCode(idempotencyKey: String = UUID().uuidString) async throws -> EnrollmentCode {
        try await send("POST", "/machines/enrollment-codes", body: EmptyBody(), idempotencyKey: idempotencyKey)
    }

    public func drain(machineId: String, idempotencyKey: String = UUID().uuidString) async throws -> Machine {
        try await send("POST", "/machines/\(escape(machineId))/drain", body: EmptyBody(), idempotencyKey: idempotencyKey)
    }

    public func jobs() async throws -> [Job] { try await list("/jobs") }
    public func job(_ id: String) async throws -> Job { try await get("/jobs/\(escape(id))") }

    /// Raw CI log text for a job.
    public func jobLog(_ id: String) async throws -> String {
        var request = try makeRequest("GET", "/jobs/\(escape(id))/log")
        request.setValue("text/plain, application/json", forHTTPHeaderField: "Accept")
        return String(decoding: try await perform(request), as: UTF8.self)
    }
    public func mergeQueue(projectId: String) async throws -> [MergeEntry] { try await list("/projects/\(escape(projectId))/merge-queue") }

    public func usage(projectId: String? = nil, runId: String? = nil, groupBy: UsageGrouping) async throws -> [UsageGroup] {
        var query = ["groupBy": groupBy.rawValue]
        query["projectId"] = projectId
        query["runId"] = runId
        return try await list("/usage", query: query)
    }

    // MARK: Events

    public func events(after: Int?, limit: Int = 200) async throws -> [HubEvent] {
        var query = ["limit": String(limit)]
        if let after { query["after"] = String(after) }
        return try await list("/events", query: query)
    }

    /// Live hub events from `GET /events` with `Accept: text/event-stream`.
    /// Reconnects from the last delivered `seq` until the task is cancelled.
    public func eventStream(after: Int?) -> AsyncThrowingStream<HubEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = after
                var backoff: UInt64 = 1_000_000_000
                while !Task.isCancelled {
                    do {
                        var query: [String: String] = [:]
                        if let cursor { query["after"] = String(cursor) }
                        var request = try makeRequest("GET", "/events", query: query)
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        request.timeoutInterval = 300
                        let (lines, response) = try await transport.stream(request)
                        try check(response, data: Data())
                        backoff = 1_000_000_000
                        var parser = ServerSentEventParser()
                        for try await line in lines {
                            guard let sse = parser.feed(line) else { continue }
                            let event = try decode(HubEvent.self, from: Data(sse.data.utf8))
                            cursor = event.seq
                            continuation.yield(event)
                        }
                    } catch HubError.unauthorized {
                        continuation.finish(throwing: HubError.unauthorized)
                        return
                    } catch {
                        if Task.isCancelled { break }
                    }
                    try? await Task.sleep(nanoseconds: backoff)
                    backoff = min(backoff * 2, 30_000_000_000)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Messaging

    public func channels(projectId: String) async throws -> [Channel] {
        try await list("/messaging/projects/\(escape(projectId))/channels")
    }

    public func messages(projectId: String, channelId: String, latest: Bool = true, before: String? = nil, after: String? = nil, limit: Int = 100) async throws -> MessagePage {
        var query = ["limit": String(limit)]
        if let before { query["before"] = before } else if let after { query["after"] = after } else if latest { query["latest"] = "true" }
        return try await get("/messaging/projects/\(escape(projectId))/channels/\(escape(channelId))/messages", query: query)
    }

    public func sendMessage(projectId: String, channelId: String, senderRoleId: String, recipientRoleId: String?, body: String, idempotencyKey: String = UUID().uuidString) async throws -> Message {
        struct Body: Encodable {
            var senderRoleId: String
            var recipientRoleId: String?
            var body: String
        }
        let data = try await raw("POST", "/messaging/projects/\(escape(projectId))/channels/\(escape(channelId))/messages",
                                 body: Body(senderRoleId: senderRoleId, recipientRoleId: recipientRoleId, body: body), idempotencyKey: idempotencyKey)
        struct Wrapped: Decodable { var message: Message }
        if let wrapped = try? HubCoding.decoder().decode(Wrapped.self, from: data) { return wrapped.message }
        return try decode(Message.self, from: data)
    }

    // MARK: Plumbing

    struct EmptyBody: Encodable {}

    /// Merges the contract's `idempotencyKey` into the JSON body.
    struct Keyed<Body: Encodable>: Encodable {
        var body: Body
        var idempotencyKey: String?

        func encode(to encoder: Encoder) throws {
            try body.encode(to: encoder)
            if let idempotencyKey {
                var container = encoder.container(keyedBy: Key.self)
                try container.encode(idempotencyKey, forKey: .idempotencyKey)
            }
        }

        enum Key: String, CodingKey { case idempotencyKey }
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? component
    }

    func makeRequest(_ method: String, _ path: String, query: [String: String] = [:], authenticated: Bool = true) throws -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let basePath = components?.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        components?.percentEncodedPath = "/" + [basePath, "api/v1"].filter { !$0.isEmpty }.joined(separator: "/") + path
        if !query.isEmpty {
            components?.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components?.url else { throw HubError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:], authenticated: Bool = true) async throws -> T {
        let request = try makeRequest("GET", path, query: query, authenticated: authenticated)
        return try decode(T.self, from: try await perform(request))
    }

    private func list<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> [T] {
        let request = try makeRequest("GET", path, query: query)
        return try decode(ListEnvelope<T>.self, from: try await perform(request)).items
    }

    private func send<B: Encodable, T: Decodable>(_ method: String, _ path: String, body: B, idempotencyKey: String?) async throws -> T {
        try decode(T.self, from: try await raw(method, path, body: body, idempotencyKey: idempotencyKey))
    }

    private func raw<B: Encodable>(_ method: String, _ path: String, body: B, idempotencyKey: String?) async throws -> Data {
        var request = try makeRequest(method, path)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try HubCoding.encoder().encode(Keyed(body: body, idempotencyKey: idempotencyKey))
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as HubError {
            throw error
        } catch {
            throw HubError.transport(String(describing: type(of: error)))
        }
        try check(response, data: data)
        return data
    }

    private func check(_ response: HTTPURLResponse, data: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        switch response.statusCode {
        case 401, 403: throw HubError.unauthorized
        case 409: throw HubError.conflict(code: envelope?.error.code, message: envelope?.error.message)
        default: throw HubError.http(status: response.statusCode, code: envelope?.error.code, message: envelope?.error.message)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try HubCoding.decoder().decode(T.self, from: data)
        } catch {
            throw HubError.decoding(String(describing: T.self))
        }
    }
}
