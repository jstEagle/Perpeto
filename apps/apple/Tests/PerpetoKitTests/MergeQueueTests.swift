import Foundation
import Testing
@testable import PerpetoKit

@Suite("Merge queues")
struct MergeQueueTests {
    let token = "secret-owner-token-123"

    /// The shape `GET /merge-queues/:id` returns, including fields the app ignores.
    static let view = #"""
    {"id":"mqn_1","kind":"project","projectId":"prj_1","name":"main","source":"merged",
     "config":{"name":"main","branches":["main"],"strategy":"batch","maxBatchSize":3,"depth":3,"requiredChecks":["test"],"method":"squash","publication":"fast-forward-push",
       "lanes":[{"name":"hotfix","priority":100,"labels":[],"branches":["hotfix/*"]}],"defaultLane":"hotfix","freeze":{"windows":[{"cron":"0 17 * * 5","durationMinutes":3840}]},
       "maxInFlight":null,"flakyRetries":1,"bisectOnBatchFailure":true,"autoRebaseOnConflict":true,"ejectAfterMinutes":null,"requiredApprovals":0},
     "branches":["main"],"strategy":"batch","frozen":{"kind":"window","reason":"Weekend","since":"2026-10-23T17:00:00.000Z","until":"2026-10-26T09:00:00.000Z"},
     "entries":[{"id":"mq_1","prUrl":"local:hotfix/a","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseBranch":"main","status":"testing","priority":100,"lane":"hotfix",
       "headBranch":"hotfix/a","enqueuedAt":"2026-10-23T16:00:00.000Z","waitedMs":60000,"attemptId":"mq_a","phase":"testing","jobId":"job_mq_a","position":1,"deliveryQueueId":"dq_1"}],
     "attempts":[{"id":"mq_a","head":true,"phase":"testing","entryIds":["mq_1"],"size":1,"startedAt":"2026-10-23T16:01:00.000Z","jobId":"job_mq_a","jobStatus":"queued","deliveryQueueId":"dq_1"}],
     "testing":["mq_1"],"recent":[],"eta":{"attemptMs":null,"samples":0},
     "metrics":{"windowMs":86400000,"merged":0,"rejected":0,"throughputPerHour":0,"medianTimeInQueueMs":null,"failureRate":null,"failuresByReason":[],
       "batches":{"total":0,"succeeded":0,"successRate":null},"flakyRetries":0,"hourly":[{"start":"2026-10-23T15:00:00.000Z","merged":0,"rejected":0}]},
     "window":"24h","deliveryQueues":[{"id":"dq_1","lastError":null}],"generatedAt":"2026-10-23T17:30:00.000Z"}
    """#

    @Test func decodesTheHubViewAndCallsTheRoutes() async throws {
        let stub = StubTransport { request in
            switch (request.httpMethod, request.url?.path() ?? "") {
            case ("GET", let path) where path.hasSuffix("/merge-queues/mqn_1"): (200, Self.view)
            case ("POST", let path) where path.hasSuffix("/merge-queues/mqn_1/freeze"): (200, Self.view)
            case ("POST", let path) where path.hasSuffix("/merge-entries/mq_1/priority"):
                (200, #"{"id":"mq_1","projectId":"prj_1","prUrl":"local:hotfix/a","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseBranch":"main","status":"queued","lane":"hotfix"}"#)
            case ("GET", let path) where path.hasSuffix("/projects/old/merge-queues"): (404, #"{"error":{"code":"NOT_FOUND","message":"Route not found."}}"#)
            default: (500, "{}")
            }
        }
        let client = try HubClient(baseURL: URL(string: "http://127.0.0.1:4320")!, token: token, transport: stub)
        let view = try await client.mergeQueueView(id: "mqn_1", window: .week)
        #expect(stub.requests[0].url?.query() == "window=7d")
        #expect(view.entries.first?.lane == "hotfix")
        #expect(view.frozen?.isManual == false)
        #expect(view.config?.strategyText == "Batches of up to 3")
        #expect(view.attempts.first?.label(strategy: view.strategy) == "Next to merge · CI running")
        #expect(view.summary == "1 in flight")
        _ = try await client.setMergeQueueFrozen(id: "mqn_1", frozen: true, reason: "Incident")
        let body = try #require(stub.requests[1].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(body["reason"] as? String == "Incident")
        #expect(body["idempotencyKey"] is String)
        _ = try await client.mergeEntryCommand(entryId: "mq_1", .lane("hotfix"))
        let command = try #require(stub.requests[2].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(command["lane"] as? String == "hotfix")
        // A hub from before configurable queues reports no settings rather than failing.
        #expect(try await client.mergeQueues(projectId: "old") == nil)
    }

    @Test func settingsProblemsUseTheHubPaths() {
        var queue = QueueConfig(name: "main", strategy: .batch)
        #expect(queue.problems(at: 0).isEmpty)
        queue.flakyRetries = 9
        queue.publication = "github-merge-queue"
        queue.maxInFlight = 0
        #expect(Set(queue.problems(at: 2).map(\.path)) == ["$.queues[2].flakyRetries", "$.queues[2].publication", "$.queues[2].maxInFlight"])
    }

    @Test func demoQueuesFreezeReorderAndSave() async throws {
        let demo = DemoDataSource(scenario: .full, now: { Date(timeIntervalSince1970: 1_792_000_000) }, stageDelay: .zero)
        let settings = try #require(try await demo.mergeQueues(projectId: DemoFixtures.primaryProjectId))
        #expect(settings.queues.map(\.name) == ["main", "release"])
        #expect(settings.repo.applied)
        let main = try await demo.mergeQueueView(id: settings.queues[0].id, window: .day)
        #expect(main.entries.map(\.position) == Array(1...7))
        let deps = try #require(main.entries.last)
        _ = try await demo.mergeEntryCommand(entryId: deps.id, .lane("hotfix"))
        let moved = try await demo.mergeQueueView(id: main.id, window: .day)
        #expect(moved.entries.first { $0.status == .queued }?.id == deps.id)
        _ = try await demo.mergeEntryCommand(entryId: moved.entries[0].id, .eject(reason: nil))
        let ejected = try await demo.mergeQueueView(id: main.id, window: .day)
        #expect(ejected.attempts.isEmpty)
        #expect(ejected.recent.first?.cause == "manual")
        let release = try await demo.setMergeQueueFrozen(id: settings.queues[1].id, frozen: false, reason: nil)
        #expect(release.frozen == nil)
        var config = settings.config
        config.queues[0].flakyRetries = 2
        let saved = try await demo.saveMergeQueues(projectId: DemoFixtures.primaryProjectId, config: config, baseVersion: settings.version)
        #expect(saved.version == settings.version + 1)
        await #expect(throws: HubError.self) { try await demo.saveMergeQueues(projectId: DemoFixtures.primaryProjectId, config: config, baseVersion: settings.version) }
        config.queues[0].flakyRetries = 9
        await #expect(throws: HubError.self) { try await demo.saveMergeQueues(projectId: DemoFixtures.primaryProjectId, config: config, baseVersion: saved.version) }
    }
}
