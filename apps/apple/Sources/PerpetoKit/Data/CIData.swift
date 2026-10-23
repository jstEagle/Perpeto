import Foundation

/// Reads and acts on CI pipeline runs: the hub, or demo fixtures.
public protocol CIDataSource: Sendable {
    func overview(projectId: String) async throws -> CIOverview
    func run(_ id: String) async throws -> PipelineRun
    func logPage(jobId: String, after: Int?) async throws -> JobLogPage
    func cancel(runId: String) async throws -> PipelineRun
    func retry(runId: String, job: String?) async throws -> PipelineRun
}

public enum CIData {
    /// The hub's CI routes when the store reads a hub, else demo fixtures.
    public static func source(for factory: FactoryDataSource) -> CIDataSource {
        if let hub = factory as? HubDataSource { return HubCIData(client: hub.client) }
        return DemoCIData()
    }
}

public struct HubCIData: CIDataSource {
    public let client: HubClient
    public init(client: HubClient) { self.client = client }

    public func overview(projectId: String) async throws -> CIOverview {
        async let runs = client.pipelineRuns(projectId: projectId)
        // Runners and flaky history are secondary; their failure leaves runs readable.
        async let runners = (try? client.runners()) ?? RunnersResponse(runners: [], pools: [])
        async let flaky = (try? client.flakyJobs(projectId: projectId)) ?? []
        return try await CIOverview(runs: runs, runners: runners, flaky: flaky)
    }
    public func run(_ id: String) async throws -> PipelineRun { try await client.pipelineRun(id) }
    public func logPage(jobId: String, after: Int?) async throws -> JobLogPage { try await client.jobLogPage(jobId, after: after) }
    public func cancel(runId: String) async throws -> PipelineRun { try await client.cancelPipelineRun(runId) }
    public func retry(runId: String, job: String?) async throws -> PipelineRun { try await client.retryPipelineRun(runId, job: job) }
}

/// In-memory CI fixtures. Actions apply locally.
public actor DemoCIData: CIDataSource {
    private var runs: [PipelineRun]
    private let runners: RunnersResponse
    private let flaky: [FlakyJob]

    public init(now: Date = Date()) {
        runs = DemoCI.runs(now: now)
        runners = DemoCI.runners
        flaky = DemoCI.flaky(now: now)
    }

    public func overview(projectId: String) async throws -> CIOverview {
        CIOverview(runs: runs, runners: runners, flaky: flaky)
    }

    public func run(_ id: String) async throws -> PipelineRun {
        guard let run = runs.first(where: { $0.id == id }) else { throw HubError.http(status: 404, code: "NOT_FOUND", message: "Pipeline run not found.") }
        return run
    }

    public func logPage(jobId: String, after: Int?) async throws -> JobLogPage {
        let lines = DemoCI.log(jobId: jobId)
        let chunks = lines.enumerated().map { JobLogPage.Chunk(seq: $0.offset + 1, chunk: $0.element) }.filter { $0.seq > (after ?? 0) }
        return JobLogPage(jobId: jobId, chunks: chunks, nextCursor: chunks.last?.seq ?? after, bytes: lines.joined().utf8.count)
    }

    public func cancel(runId: String) async throws -> PipelineRun {
        try update(runId) { run in
            run.status = .cancelled
            for index in run.jobs.indices where run.jobs[index].status.isActive { run.jobs[index].status = .cancelled }
        }
    }

    public func retry(runId: String, job: String?) async throws -> PipelineRun {
        try update(runId) { run in
            run.status = .running
            for index in run.jobs.indices where (job == nil || run.jobs[index].key == job) && [.failed, .error, .cancelled].contains(run.jobs[index].status) {
                run.jobs[index].status = .queued
                run.jobs[index].attempt += 1
            }
        }
    }

    private func update(_ id: String, _ change: (inout PipelineRun) -> Void) throws -> PipelineRun {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { throw HubError.http(status: 404, code: "NOT_FOUND", message: "Pipeline run not found.") }
        change(&runs[index])
        return runs[index]
    }
}

/// Demo pipeline runs: a running DAG with a matrix, a passed run with a
/// flaky retry and a failure.
public enum DemoCI {
    static let sha1 = "4f1c2a9b8e7d6c5b4a39281706f5e4d3c2b1a090"
    static let sha2 = "9a8b7c6d5e4f30211234567890abcdef12345678"
    static let sha3 = "c0ffee1234567890abcdef1234567890abcdef12"

    public static func runs(now: Date) -> [PipelineRun] {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        func matrix(_ name: String, node: String, os: String, status: PipelineRunJob.Status, start: Double?, minutes: Double?, attempt: Int = 1,
                    flaky: Bool = false, hit: Bool = true) -> PipelineRunJob {
            let key = "\(name) (node=\(node), os=\(os))"
            return PipelineRunJob(key: key, name: name, matrix: ["node": node, "os": os], needs: ["lint"], runsOn: .init(pool: "default", os: os),
                                  status: status, jobId: "job_\(name)_\(node)_\(os)", machineId: os == "darwin" ? "mch_mini" : "mch_box", attempt: attempt,
                                  maxAttempts: 2, startedAt: start.map(ago), durationMs: minutes.map { $0 * 60_000 }, queueWaitMs: 4_000, flaky: flaky,
                                  cache: [.init(key: "node-modules-\(node)-\(os)", hit: hit)])
        }
        let live = PipelineRun(
            id: "plr_live", projectId: "prj_demo", pipeline: "default", revision: sha1, ref: "perpeto/wi_42",
            trigger: .init(kind: .pullRequest, workItemId: "wi_42"), status: .running, configSource: "repo", jobs: [
                PipelineRunJob(key: "lint", name: "lint", status: .passed, jobId: "job_lint_live", machineId: "mch_box", startedAt: ago(6), durationMs: 48_000, queueWaitMs: 1_200,
                               cache: [.init(key: "node-modules-lint", hit: true)]),
                matrix("test", node: "22", os: "linux", status: .passed, start: 5, minutes: 2.4),
                matrix("test", node: "24", os: "linux", status: .running, start: 4, minutes: nil),
                matrix("test", node: "24", os: "darwin", status: .running, start: 3, minutes: nil, hit: false),
                PipelineRunJob(key: "package", name: "package", needs: ["test (node=22, os=linux)", "test (node=24, os=linux)", "test (node=24, os=darwin)"], status: .waiting),
            ], createdAt: ago(6.2), startedAt: ago(6))
        let passed = PipelineRun(
            id: "plr_passed", projectId: "prj_demo", pipeline: "default", revision: sha2, trigger: .init(kind: .mergeQueue), status: .passed, configSource: "repo", jobs: [
                PipelineRunJob(key: "lint", name: "lint", status: .passed, jobId: "job_lint_2", startedAt: ago(62), durationMs: 51_000),
                matrix("test", node: "22", os: "linux", status: .passed, start: 61, minutes: 2.6, attempt: 2, flaky: true),
                matrix("test", node: "24", os: "linux", status: .passed, start: 61, minutes: 2.5),
                PipelineRunJob(key: "package", name: "package", needs: ["test (node=22, os=linux)", "test (node=24, os=linux)"], status: .passed, jobId: "job_pkg_2",
                               startedAt: ago(56), durationMs: 70_000, artifacts: [.init(id: "art_1", name: "dist", path: "dist/app.tgz", size: 2_400_000)]),
            ], createdAt: ago(63), startedAt: ago(62), finishedAt: ago(55), durationMs: 7 * 60_000)
        let failed = PipelineRun(
            id: "plr_failed", projectId: "prj_demo", pipeline: "nightly", revision: sha3, trigger: .init(kind: .schedule), status: .failed, configSource: "repo", jobs: [
                PipelineRunJob(key: "lint", name: "lint", status: .passed, jobId: "job_lint_3", startedAt: ago(300), durationMs: 50_000),
                PipelineRunJob(key: "e2e", name: "e2e", needs: ["lint"], status: .failed, jobId: "job_e2e_3", attempt: 2, maxAttempts: 2, startedAt: ago(298), durationMs: 9 * 60_000),
                PipelineRunJob(key: "publish", name: "publish", needs: ["e2e"], status: .skipped),
            ], createdAt: ago(301), startedAt: ago(300), finishedAt: ago(289), durationMs: 11 * 60_000, reason: "e2e failed")
        return [live, passed, failed]
    }

    public static let runners = RunnersResponse(runners: [
        Runner(machineId: "mch_box", name: "build-box", os: "linux", status: .online, labels: ["docker"], pools: [.init(name: "default", maxJobs: 4, busy: 1)],
               maxJobs: 4, busy: 1, mode: "ci", cache: .init(sizeBytes: 3_800_000_000, maxBytes: 10_737_418_240, entries: 12), utilisation: 0.42),
        Runner(machineId: "mch_mini", name: "mac-mini", os: "darwin", status: .online, labels: ["xcode"], pools: [.init(name: "default", maxJobs: 2, busy: 1)],
               maxJobs: 2, busy: 1, mode: "both", cache: .init(sizeBytes: 1_200_000_000, maxBytes: 5_368_709_120, entries: 5), utilisation: 0.31),
        Runner(machineId: "mch_air", name: "laptop", os: "darwin", status: .online, labels: [], pools: [], maxJobs: 0, busy: 0, mode: "agents"),
    ], pools: [.init(name: "default", machines: 2, slots: 6, busy: 2, queued: 0)])

    public static func flaky(now: Date) -> [FlakyJob] {
        [FlakyJob(id: "fl_1", pipeline: "default", job: "test", occurrences: 3, lastRevision: sha2, lastSeenAt: now.addingTimeInterval(-3600))]
    }

    public static func log(jobId: String) -> [String] {
        ["$ npm ci\n", "added 143 packages in 2s\n", "$ npm test\n", "# tests 214\n", "# pass 214\n",
         jobId.contains("e2e") ? "not ok 3 - checkout flow\n# fail 1\n" : "# fail 0\n"]
    }
}
