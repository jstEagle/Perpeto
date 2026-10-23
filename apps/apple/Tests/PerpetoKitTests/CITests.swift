import Foundation
import Testing
@testable import PerpetoKit

@Suite("CI pipelines")
struct CITests {
    let runJSON = #"""
    {"id":"plr_1","projectId":"prj_1","pipeline":"default","revision":"4f1c2a9b8e7d6c5b4a39281706f5e4d3c2b1a090","ref":"feature",
     "trigger":{"kind":"pull-request","workItemId":"wi_1"},"status":"running","configSource":"repo","configHash":"abc",
     "createdAt":"2026-10-23T10:00:00.000Z","startedAt":"2026-10-23T10:00:01Z",
     "jobs":[
      {"key":"lint","name":"lint","needs":[],"runsOn":{"pool":"default","labels":[]},"status":"passed","jobId":"job_1","attempt":1,"maxAttempts":1,
       "attempts":[{"jobId":"job_1","status":"passed","queuedAt":"2026-10-23T10:00:00Z"}],"durationMs":48000,"cache":[{"key":"nm-1","hit":true}]},
      {"key":"test (node=22, os=linux)","name":"test","matrix":{"node":22,"os":"linux"},"needs":["lint"],"runsOn":{"pool":"default","os":"linux","labels":["docker"]},
       "status":"teleporting","attempt":2,"maxAttempts":2,"attempts":[],"flaky":true,"artifacts":[{"id":"art_1","name":"cov","path":"coverage/lcov.info","size":2048}]},
      {"key":"package","name":"package","needs":["test (node=22, os=linux)","missing"],"runsOn":{"pool":"default","labels":[]},"status":"waiting","attempt":1,"maxAttempts":1,"attempts":[]}
     ]}
    """#

    @Test func decodesContractWithUnknownStatuses() throws {
        let run = try HubCoding.decoder().decode(PipelineRun.self, from: Data(runJSON.utf8))
        #expect(run.status == .running)
        #expect(run.trigger.kind == .pullRequest)
        #expect(run.jobs.count == 3)
        #expect(run.jobs[1].status == .unknown)
        #expect(run.jobs[1].matrix == ["node": "22", "os": "linux"])
        #expect(run.jobs[1].matrixLabel == "node 22 · os linux")
        #expect(run.jobs[1].flaky)
        #expect(run.jobs[1].artifacts.first?.size == 2048)
        #expect(run.jobs[0].cache == [.init(key: "nm-1", hit: true)])
        #expect(run.jobs[0].elapsed() == 48)

        let odd = #"{"id":"plr_2","status":"vanished","trigger":{"kind":"carrier-pigeon"},"jobs":[{"nokey":true},{"key":"a","status":"passed"}]}"#
        let lenient = try HubCoding.decoder().decode(PipelineRun.self, from: Data(odd.utf8))
        #expect(lenient.status == .unknown)
        #expect(lenient.trigger.kind == .unknown)
        #expect(lenient.jobs.map(\.key) == ["a"])
    }

    @Test func decodesRunnersFlakyAndLogPage() throws {
        let runners = try HubCoding.decoder().decode(RunnersResponse.self, from: Data(#"""
        {"runners":[{"machineId":"mch_1","name":"box","os":"linux","status":"online","labels":["docker"],"pools":[{"name":"default","maxJobs":2,"busy":1}],
          "maxJobs":2,"busy":1,"mode":"ci","cache":{"sizeBytes":1024,"maxBytes":4096,"entries":3},"utilisation":0.5},
          {"machineId":"mch_2","status":"hibernating"}],
         "pools":[{"name":"default","machines":1,"slots":2,"busy":1,"queued":4}]}
        """#.utf8))
        #expect(runners.runners.count == 2)
        #expect(runners.runners[1].status == .unknown)
        #expect(runners.runners[0].cache?.entries == 3)
        #expect(runners.pools.first?.queued == 4)

        let page = try HubCoding.decoder().decode(JobLogPage.self, from: Data(#"""
        {"jobId":"job_1","chunks":[{"seq":7,"id":"log_1","jobId":"job_1","chunk":"ok\n","at":"2026-10-23T10:00:00Z"}],"nextCursor":7,"hasMore":false,"truncated":true,"bytes":3}
        """#.utf8))
        #expect(page.chunks.first?.seq == 7)
        #expect(page.truncated)
    }

    @Test func clientPathsAndBodies() async throws {
        let stub = StubTransport { request in
            let path = request.url?.path() ?? ""
            if path.hasSuffix("/pipeline-runs") { return (200, #"{"runs":[{"id":"plr_1","status":"passed","jobs":[]}]}"#) }
            if path.contains("/log") { return (200, #"{"jobId":"job_1","chunks":[],"nextCursor":3,"hasMore":false,"truncated":false}"#) }
            if path.hasSuffix("/ci/flaky") { return (200, #"{"flaky":[{"id":"f","pipeline":"default","job":"test","occurrences":2}]}"#) }
            return (200, #"{"id":"plr_1","status":"running","jobs":[]}"#)
        }
        let client = try HubClient(baseURL: URL(string: "http://127.0.0.1:4320")!, token: "secret-owner-token-123", transport: stub)
        #expect(try await client.pipelineRuns(projectId: "prj_1", limit: 20).count == 1)
        _ = try await client.jobLogPage("job_1", after: 3)
        _ = try await client.retryPipelineRun("plr_1", job: "lint", idempotencyKey: "k1")
        #expect(try await client.flakyJobs(projectId: "prj_1").first?.occurrences == 2)
        #expect(stub.requests[0].url?.absoluteString == "http://127.0.0.1:4320/api/v1/pipeline-runs?limit=20&projectId=prj_1")
        #expect(stub.requests[1].url?.absoluteString == "http://127.0.0.1:4320/api/v1/jobs/job_1/log?after=3&limit=500")
        #expect(stub.requests[2].httpMethod == "POST")
        #expect(stub.requests[2].url?.path() == "/api/v1/pipeline-runs/plr_1/retry")
        let body = try #require(stub.requests[2].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        #expect(body == ["job": "lint", "idempotencyKey": "k1"])
    }

    @Test func layoutGroupsJobsByDependencyDepth() throws {
        let run = try HubCoding.decoder().decode(PipelineRun.self, from: Data(runJSON.utf8))
        #expect(PipelineLayout.columns(run.jobs).map { $0.map(\.key) } == [["lint"], ["test (node=22, os=linux)"], ["package"]])
        let cycle = [PipelineRunJob(key: "a", name: "a", needs: ["b"], status: .waiting), PipelineRunJob(key: "b", name: "b", needs: ["a"], status: .waiting)]
        #expect(PipelineLayout.columns(cycle).flatMap { $0 }.count == 2)
        #expect(PipelineLayout.columns([]).isEmpty)
    }

    @Test func logBufferFollowsCursorAndIgnoresReplays() {
        var buffer = LogBuffer(maxCharacters: 10)
        buffer.append(JobLogPage(jobId: "j", chunks: [.init(seq: 1, chunk: "ab"), .init(seq: 2, chunk: "cd")], nextCursor: 2))
        #expect(buffer.text == "abcd")
        #expect(buffer.cursor == 2)
        buffer.append(JobLogPage(jobId: "j", chunks: [.init(seq: 2, chunk: "cd"), .init(seq: 3, chunk: "ef")], nextCursor: 3))
        #expect(buffer.text == "abcdef")
        buffer.append(JobLogPage(jobId: "j", chunks: [], nextCursor: 3))
        #expect(buffer.cursor == 3)
        buffer.append(JobLogPage(jobId: "j", chunks: [.init(seq: 4, chunk: "ghijkl")], nextCursor: 4))
        #expect(buffer.text == "cdefghijkl")
        #expect(buffer.truncated)
    }

    @Test func formatsBytesAndDemoActions() async throws {
        #expect(ByteFormat.string(512) == "512 B")
        #expect(ByteFormat.string(1536) == "1.5 KB")
        #expect(ByteFormat.string(10_737_418_240) == "10 GB")
        let demo = DemoCIData()
        let overview = try await demo.overview(projectId: "any")
        #expect(overview.runs.first?.status == .running)
        let cancelled = try await demo.cancel(runId: "plr_live")
        #expect(cancelled.status == .cancelled)
        #expect(!cancelled.jobs.contains { $0.status.isActive })
        let retried = try await demo.retry(runId: "plr_failed", job: "e2e")
        #expect(retried.jobs.first { $0.key == "e2e" }?.status == .queued)
        let log = try await demo.logPage(jobId: "job_e2e_3", after: 4)
        #expect(log.chunks.map(\.seq) == [5, 6])
    }
}
