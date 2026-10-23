import Foundation

/// Demo merge queues for the primary project, matching the web demo: a batched
/// `main` queue with lanes (its batch size overridden by the committed
/// repository file) and a manually frozen `release` queue. Commands change
/// this state locally.
public struct DemoMergeQueues: Sendable {
    public private(set) var settings: MergeQueueSettings
    private var views: [String: MergeQueueView]
    private let now: Date

    public init(projectId: String = DemoFixtures.primaryProjectId, now: Date) {
        self.now = now
        let iso = { (minutesAgo: Double) in HubDate.iso(now.addingTimeInterval(-minutesAgo * 60)) }
        let lanes = [QueueLane(name: "hotfix", priority: 100, labels: ["hotfix"], branches: ["hotfix/*"]), QueueLane(name: "normal", priority: 50),
                     QueueLane(name: "dependencies", priority: 10, labels: ["dependencies"], branches: ["deps/*", "dependabot/**"])]
        let hubMain = QueueConfig(name: "main", strategy: .batch, maxBatchSize: 4, requiredChecks: ["test", "lint"], lanes: lanes, defaultLane: "normal",
                                  freeze: .init(windows: [FreezeWindow(cron: "0 17 * * 5", durationMinutes: 3840, reason: "Weekend freeze")]),
                                  maxInFlight: 8, flakyRetries: 1, ejectAfterMinutes: 240, requiredApprovals: 1)
        let release = QueueConfig(name: "release", branches: ["release/*"], requiredChecks: ["test"], method: "merge", autoRebaseOnConflict: false, requiredApprovals: 2)
        var main = hubMain
        main.maxBatchSize = 3
        let pr = { (n: Int) in "https://github.com/lumin/perpeto/pull/\(n)" }
        func entry(_ n: Int, _ status: MergeEntry.Status, lane: String?, ago: Double, branch: String, attempt: String? = nil, base: String = "main") -> QueueEntryView {
            QueueEntryView(id: "mq_demo_\(n)", prUrl: pr(n), headSha: String(repeating: String(n % 10), count: 40), baseBranch: base, status: status, position: 0,
                           priority: lanes.first { $0.name == lane }?.priority ?? 0, lane: lane, headBranch: branch, enqueuedAt: iso(ago), waitedMs: ago * 60000,
                           etaAt: nil, finishedAt: nil, attemptId: attempt, reason: nil, cause: nil, retries: nil, deliveryError: nil)
        }
        func done(_ n: Int, _ status: MergeEntry.Status, ago: Double, waited: Double, cause: String? = nil, reason: String? = nil) -> QueueEntryView {
            var value = entry(n, status, lane: "normal", ago: ago + waited, branch: "perpeto/run-7q4m2x/change-\(n)")
            value.finishedAt = iso(ago); value.waitedMs = waited * 60000; value.cause = cause; value.reason = reason
            return value
        }
        let head = QueueAttemptView(id: "mq_attempt_demo_1", head: true, phase: "testing", entryIds: ["mq_demo_251", "mq_demo_247", "mq_demo_248"], size: 3,
                                    startedAt: iso(14), jobStatus: "running", revision: String(repeating: "c2d83e4", count: 6).prefix(40).description)
        let hourly = (0..<24).map { i in QueueMetrics.Hour(start: iso(Double(24 - i) * 60), merged: [0, 0, 1, 0, 0, 0, 0, 2, 3, 2, 1, 3, 2, 4, 2, 1, 2, 3, 1, 0, 2, 1, 1, 2][i], rejected: [8, 12, 17, 20].contains(i) ? 1 : 0) }
        let attemptMs = 22.0 * 60000
        var mainEntries = [
            entry(251, .testing, lane: "hotfix", ago: 19, branch: "hotfix/login-redirect", attempt: head.id),
            entry(247, .testing, lane: "normal", ago: 41, branch: "perpeto/run-7q4m2x/merge-queue-lanes", attempt: head.id),
            entry(248, .testing, lane: "normal", ago: 36, branch: "perpeto/run-7q4m2x/freeze-windows", attempt: head.id),
            entry(249, .queued, lane: "normal", ago: 27, branch: "perpeto/run-7q4m2x/queue-metrics"),
            entry(253, .queued, lane: "normal", ago: 9, branch: "perpeto/run-8f2k4t/cli-queue-command"),
            entry(244, .queued, lane: "dependencies", ago: 118, branch: "deps/vite-8.3"),
            entry(246, .queued, lane: "dependencies", ago: 92, branch: "dependabot/npm/react-19.3"),
        ]
        let remaining = attemptMs - 14 * 60000
        for index in mainEntries.indices {
            mainEntries[index].position = index + 1
            let rounds = mainEntries[index].status == .queued ? Double((index - 3) / 3 + 1) : 0
            mainEntries[index].etaAt = HubDate.iso(now.addingTimeInterval((remaining + rounds * attemptMs) / 1000))
        }
        let mainView = MergeQueueView(
            id: "mqn_demo_main", kind: "project", projectId: projectId, name: "main", source: "merged", config: main, branches: ["main"], strategy: "batch", frozen: nil,
            entries: mainEntries, attempts: [head],
            recent: [done(243, .merged, ago: 26, waited: 34), done(242, .merged, ago: 26, waited: 41),
                     done(239, .rejected, ago: 70, waited: 240, cause: "timeout", reason: "Waited longer than 240 minutes; ejected."),
                     done(241, .merged, ago: 95, waited: 29), done(238, .rejected, ago: 130, waited: 52, cause: "ci", reason: "Speculative CI failed after 2 runs.")],
            eta: .init(attemptMs: attemptMs, samples: 12),
            metrics: QueueMetrics(windowMs: 86_400_000, merged: 31, rejected: 4, throughputPerHour: 1.29, medianTimeInQueueMs: 38 * 60000, failureRate: 0.114,
                                  failuresByReason: [.init(cause: "ci", count: 2, rate: 0.057), .init(cause: "timeout", count: 1, rate: 0.029), .init(cause: "conflict", count: 1, rate: 0.029)],
                                  batches: .init(total: 11, succeeded: 9, successRate: 0.818), flakyRetries: 3, hourly: hourly),
            window: "24h")
        var releaseEntry = entry(250, .queued, lane: nil, ago: 33, branch: "perpeto/backport-login-fix", base: "release/2026.10")
        releaseEntry.position = 1
        let releaseView = MergeQueueView(
            id: "mqn_demo_release", kind: "project", projectId: projectId, name: "release", source: "hub", config: release, branches: ["release/*"], strategy: "serial",
            frozen: MergeQueueFreeze(reason: "Release 2026.10 is being cut", since: iso(40), by: "owner"), entries: [releaseEntry], attempts: [],
            recent: [done(236, .merged, ago: 360, waited: 52)], eta: .init(attemptMs: 31 * 60000, samples: 4),
            metrics: QueueMetrics(windowMs: 86_400_000, merged: 1, rejected: 0, throughputPerHour: 0.04, medianTimeInQueueMs: 52 * 60000, failureRate: 0,
                                  failuresByReason: [], batches: .init(total: 0, succeeded: 0, successRate: nil), flakyRetries: 0,
                                  hourly: (0..<24).map { i in .init(start: iso(Double(24 - i) * 60), merged: i == 17 ? 1 : 0, rejected: 0) }),
            window: "24h")
        views = [mainView.id: mainView, releaseView.id: releaseView]
        let summary = { (view: MergeQueueView) in
            MergeQueueSummary(id: view.id, kind: "project", name: view.name, projectId: projectId, branches: view.branches, strategy: view.strategy, source: view.source, frozen: view.frozen,
                              counts: .init(queued: view.entries.filter { $0.status == .queued }.count, testing: view.entries.filter { $0.status == .testing }.count, merging: 0))
        }
        settings = MergeQueueSettings(projectId: projectId, version: 3, updatedAt: iso(120), config: MergeQueueConfig(queues: [hubMain, release]),
                                      repo: .init(path: ".perpeto/merge-queue.json", found: true, revision: "b852fc9a41d0", error: nil, errors: nil, applied: true),
                                      effective: MergeQueueConfig(queues: [main, release]), queues: [summary(mainView), summary(releaseView)])
    }

    public func view(_ id: String) throws -> MergeQueueView {
        guard let view = views[id] else { throw HubError.http(status: 404, code: "NOT_FOUND", message: "Merge queue not found.") }
        return view
    }

    public mutating func setFrozen(_ id: String, frozen: Bool, reason: String?) throws -> MergeQueueView {
        var view = try self.view(id)
        view.frozen = frozen ? MergeQueueFreeze(reason: reason ?? "Frozen by the owner.", since: HubDate.iso(now), by: "owner") : nil
        views[id] = view
        if let index = settings.queues.firstIndex(where: { $0.id == id }) { settings.queues[index].frozen = view.frozen }
        return view
    }

    public mutating func save(_ config: MergeQueueConfig, baseVersion: Int) throws -> MergeQueueSettings {
        guard baseVersion == settings.version else { throw HubError.conflict(code: "VERSION_CONFLICT", message: "Merge queue settings changed (now version \(settings.version)); reload and apply your change again.") }
        if let problem = config.queues.enumerated().flatMap({ $0.element.problems(at: $0.offset) }).first {
            throw HubError.http(status: 400, code: "INVALID_MERGE_QUEUE_CONFIG", message: "Merge queue configuration is invalid: \(problem.path) \(problem.message)")
        }
        settings.config = config
        settings.effective = config
        settings.version += 1
        for queue in config.queues {
            for (id, view) in views where view.name == queue.name { views[id]?.config = queue; views[id]?.strategy = queue.strategy.rawValue }
        }
        return settings
    }

    public mutating func command(_ entryId: String, _ command: MergeEntryCommand) throws -> MergeEntry {
        guard let (id, view) = views.first(where: { $0.value.entries.contains { $0.id == entryId } }), var item = view.entries.first(where: { $0.id == entryId }) else {
            throw HubError.conflict(code: "CONFLICT", message: "Merge entry is already terminal.")
        }
        var next = view
        switch command {
        case .lane(let name):
            guard let lane = view.config?.lanes.first(where: { $0.name == name }) else { throw HubError.http(status: 400, code: "INVALID_INPUT", message: "Unknown lane for this queue.") }
            item.lane = lane.name; item.priority = lane.priority
            next.entries = next.entries.map { $0.id == entryId ? item : $0 }
        case .requeue:
            item.status = .queued; item.attemptId = nil; item.enqueuedAt = HubDate.iso(now); item.waitedMs = 0
            next.entries = next.entries.filter { $0.id != entryId } + [item]
        case .eject(let reason):
            item.status = .rejected; item.cause = "manual"; item.reason = reason ?? "Ejected by the owner."; item.finishedAt = HubDate.iso(now)
            next.entries = next.entries.filter { $0.id != entryId }
            next.recent.insert(item, at: 0)
        }
        if item.status != .testing, let attempt = next.attempts.firstIndex(where: { $0.entryIds.contains(entryId) }) {
            let members = next.attempts[attempt].entryIds
            next.attempts.remove(at: attempt)
            next.entries = next.entries.map { members.contains($0.id) && $0.id != entryId ? { var other = $0; other.status = .queued; other.attemptId = nil; return other }($0) : $0 }
        }
        // Waiting order: in flight first, then by lane priority.
        let flight = next.entries.filter { $0.status != .queued }
        let waiting = next.entries.filter { $0.status == .queued }.sorted { $0.priority > $1.priority }
        next.entries = (flight + waiting).enumerated().map { index, value in var value = value; value.position = index + 1; return value }
        views[id] = next
        return MergeEntry(id: item.id, projectId: view.projectId, prUrl: item.prUrl, headSha: item.headSha, baseBranch: item.baseBranch, status: item.status, reason: item.reason)
    }
}

/// ISO 8601 with milliseconds, as the hub writes it.
public enum HubDate {
    public static func iso(_ date: Date) -> String { date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
}
