import PerpetoKit
import SwiftUI

extension PipelineRun.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .running: ("Running", .running)
        case .passed: ("Passed", .success)
        case .failed: ("Failed", .error)
        case .cancelled: ("Cancelled", .stopped)
        case .error: ("Error", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension PipelineRunJob.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .waiting: ("Waiting", .blocked)
        case .queued: ("Queued", .neutral)
        case .leased, .running: ("Running", .running)
        case .passed: ("Passed", .success)
        case .failed: ("Failed", .error)
        case .cancelled: ("Cancelled", .stopped)
        case .error: ("Error", .error)
        case .skipped: ("Skipped", .dismissed)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension PipelineRun.Trigger.Kind {
    var title: String {
        switch self {
        case .manual: "Manual"
        case .mergeQueue: "Merge queue"
        case .pullRequest: "Pull request"
        case .schedule: "Schedule"
        case .workflow: "Workflow"
        case .unknown: "Other"
        }
    }
}

/// CI: pipeline runs for the project, the runner fleet and flaky jobs. A run
/// opens as its jobs in dependency order with a live log.
struct CIScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    var project: Project
    @State private var overview: CIOverview = .empty
    @State private var loaded = false
    @State private var error: String?

    private var selectedRunId: String? {
        get { navigator.selectedPipelineRunId }
        nonmutating set { navigator.selectedPipelineRunId = newValue }
    }

    private var data: CIDataSource { CIData.source(for: store.source) }

    var body: some View {
        Group {
            if let selectedRunId {
                PipelineRunDetail(data: data, runId: selectedRunId, machines: store.machineNames) { self.selectedRunId = nil }
            } else {
                list
            }
        }
        .task(id: project.id) { await poll() }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("CI", subtitle: "Pipelines from .perpeto/ci.json, run on your machines at exact revisions.")
                if let error { ErrorBanner(error) { self.error = nil } }
                runsCard
                AdaptiveColumns {
                    runnersCard
                } side: {
                    flakyCard
                }
            }
            .screenPadding()
        }
    }

    @ViewBuilder private var runsCard: some View {
        if overview.runs.isEmpty {
            EmptyState(loaded ? "No pipeline runs yet" : "Loading pipeline runs",
                       message: "Runs start from pull requests, the merge queue, schedules or perpeto ci run.", systemImage: "checkmark.seal").card()
        } else {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                SectionTitle("Pipeline runs", detail: Format.plural(overview.runs.count, "run"))
                RowList(overview.runs) { run in
                    Button { selectedRunId = run.id } label: { runRow(run) }.buttonStyle(.plain)
                }
            }
            .card()
        }
    }

    private func runRow(_ run: PipelineRun) -> some View {
        HStack(alignment: .center, spacing: PerpetoSpacing.x(4)) {
            VStack(alignment: .leading, spacing: 3) {
                Text(run.pipeline).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                HStack(spacing: 5) {
                    Mono(Format.shortSha(run.revision))
                    Text("·").foregroundStyle(PerpetoColor.muted)
                    Text(run.trigger.kind.title).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    if let ref = run.ref {
                        Text("·").foregroundStyle(PerpetoColor.muted)
                        Mono(ref)
                    }
                }
            }
            Spacer(minLength: PerpetoSpacing.x(2))
            Text(CIFormat.jobProgress(run.jobs)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
            Text(CIFormat.duration(run.elapsed())).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                .frame(minWidth: 52, alignment: .trailing)
            StatusLabel(run.status.label).frame(minWidth: 96, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(PerpetoColor.faint)
        }
        .contentShape(Rectangle())
    }

    private var runnersCard: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            SectionTitle("Runners", detail: poolSummary)
            if overview.runners.runners.isEmpty {
                Text("No machine reports runner slots yet.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .padding(.vertical, PerpetoSpacing.x(3))
            } else {
                RowList(overview.runners.runners) { runner in
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                        IconTile(runner.os == "darwin" ? "laptopcomputer" : "server.rack")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(runner.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                            Text(CIFormat.runnerMeta(runner)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
                        }
                        Spacer(minLength: PerpetoSpacing.x(2))
                        StatusLabel(CIFormat.runnerState(runner))
                    }
                }
            }
        }
        .card()
    }

    private var poolSummary: String? {
        let pools = overview.runners.pools
        guard !pools.isEmpty else { return nil }
        return pools.map { "\($0.name) \($0.busy)/\($0.slots) busy, \($0.queued) queued" }.joined(separator: " · ")
    }

    private var flakyCard: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            SectionTitle("Flaky jobs")
            if overview.flaky.isEmpty {
                Text("No job has both failed and passed at the same revision.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .padding(.vertical, PerpetoSpacing.x(3))
            } else {
                RowList(overview.flaky) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(item.pipeline) · \(item.job)").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                        HStack(spacing: 5) {
                            Text("Flipped \(Format.plural(item.occurrences, "time"))").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                            if let revision = item.lastRevision {
                                Text("· last at").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                Mono(Format.shortSha(revision))
                            }
                        }
                    }
                }
            }
        }
        .card()
    }

    private func poll() async {
        while !Task.isCancelled {
            do {
                overview = try await data.overview(projectId: project.id)
                error = nil
            } catch {
                self.error = (error as? HubError)?.errorDescription ?? "Loading CI failed. It will retry."
            }
            loaded = true
            let active = overview.runs.contains { $0.status.isActive }
            try? await Task.sleep(for: active ? .seconds(2) : .seconds(10))
        }
    }
}

/// One pipeline run: its jobs as columns by dependency depth, and the log of
/// the selected job, followed while it runs.
struct PipelineRunDetail: View {
    var data: CIDataSource
    var runId: String
    var machines: [String: String]
    var back: () -> Void
    @State private var run: PipelineRun?
    @State private var selectedKey: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader(run?.pipeline ?? "Pipeline run", back: ("CI", back), status: run?.status.label) {
                    Text(meta)
                } trailing: {
                    if let run {
                        if run.status.isActive {
                            Button("Cancel run") { act { try await data.cancel(runId: run.id) } }.buttonStyle(.perpetoSecondary).disabled(busy)
                        } else if run.jobs.contains(where: { [.failed, .error, .cancelled].contains($0.status) }) {
                            Button("Retry failed jobs") { act { try await data.retry(runId: run.id, job: nil) } }.buttonStyle(.perpetoPrimary).disabled(busy)
                        }
                    }
                }
                if let error { ErrorBanner(error) { self.error = nil } }
                if let run {
                    graph(run)
                    if let job = run.jobs.first(where: { $0.key == selectedKey }) ?? run.jobs.first(where: { $0.status.isActive && $0.jobId != nil }) ?? run.jobs.first {
                        JobPanel(data: data, run: run, job: job, machine: job.machineId.flatMap { machines[$0] }) {
                            act { try await data.retry(runId: run.id, job: job.key) }
                        }
                        .id(job.key + (job.jobId ?? ""))
                    }
                } else {
                    EmptyState("Loading the run", message: "Reading its jobs from the hub.", systemImage: "checkmark.seal").card()
                }
            }
            .screenPadding()
        }
        .task(id: runId) { await poll() }
    }

    private var meta: String {
        guard let run else { return "" }
        var parts = [Format.shortSha(run.revision), run.trigger.kind.title]
        if let ref = run.ref { parts.append(ref) }
        parts.append(CIFormat.duration(run.elapsed()))
        if let reason = run.reason { parts.append(reason) }
        return parts.joined(separator: " · ")
    }

    private func graph(_ run: PipelineRun) -> some View {
        let columns = PipelineLayout.columns(run.jobs)
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Jobs", detail: CIFormat.jobProgress(run.jobs))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: PerpetoSpacing.x(6)) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                        HStack(alignment: .center, spacing: PerpetoSpacing.x(6)) {
                            if index > 0 {
                                Image(systemName: "arrow.right").font(.system(size: 11)).foregroundStyle(PerpetoColor.faint)
                            }
                            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                                ForEach(column) { job in jobCard(job) }
                            }
                        }
                    }
                }
                .padding(.vertical, PerpetoSpacing.x(1))
            }
        }
        .card()
    }

    private func jobCard(_ job: PipelineRunJob) -> some View {
        let selected = job.key == selectedKey
        return Button { selectedKey = job.key } label: {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text(job.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    Spacer(minLength: PerpetoSpacing.x(2))
                    StatusIcon(job.status.label.1)
                }
                if let matrix = job.matrixLabel { Text(matrix).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1) }
                Text(CIFormat.jobMeta(job)).font(PerpetoFont.small.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
            .padding(PerpetoSpacing.x(3))
            .frame(width: 220, alignment: .leading)
            .background(selected ? PerpetoColor.surfaceSubtle : PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous)
                .strokeBorder(selected ? PerpetoColor.controlBorder : PerpetoColor.border, lineWidth: PerpetoStroke.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(job.key), \(job.status.label.0)")
    }

    private func act(_ action: @escaping @Sendable () async throws -> PipelineRun) {
        busy = true
        Task {
            do { run = try await action() } catch { self.error = (error as? HubError)?.errorDescription ?? "The hub refused that action." }
            busy = false
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            do {
                run = try await data.run(runId)
                error = nil
            } catch {
                self.error = (error as? HubError)?.errorDescription ?? "Loading the run failed. It will retry."
            }
            try? await Task.sleep(for: run?.status.isActive == true ? .seconds(2) : .seconds(15))
        }
    }
}

/// A job's facts and its log. The log follows `after=` while the job runs.
struct JobPanel: View {
    var data: CIDataSource
    var run: PipelineRun
    var job: PipelineRunJob
    var machine: String?
    var retry: () -> Void
    @State private var log = LogBuffer()

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            SectionTitle(job.key) {
                if [.failed, .error, .cancelled].contains(job.status) && !run.status.isActive {
                    Button("Retry job", action: retry).buttonStyle(.perpetoGhost).controlSize(.small)
                }
            }
            FigureStrip([
                Figure("Duration", value: CIFormat.duration(job.elapsed())),
                Figure("Queue wait", value: CIFormat.duration(job.queueWaitMs.map { $0 / 1000 })),
                Figure("Attempt", value: "\(job.attempt) of \(job.maxAttempts)", detail: job.flaky ? "Flaky: passed after failing" : nil),
            ])
            facts
            logView
        }
        .card()
        .task(id: job.jobId) { await follow() }
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            fact("Status") { StatusLabel(job.status.label) }
            fact("Runner") { Text([machine ?? job.machineId, job.runsOn.pool.map { "pool \($0)" } ?? "any pool", job.runsOn.os].compactMap { $0 }.joined(separator: " · ")) }
            if !job.needs.isEmpty { fact("Needs") { Text(job.needs.joined(separator: ", ")) } }
            ForEach(job.cache, id: \.key) { cache in
                fact("Cache") { HStack(spacing: 5) { Mono(cache.key); Text(cache.hit ? "hit" : "miss, saved after success") } }
            }
            ForEach(job.artifacts) { artifact in
                fact("Artifact") { HStack(spacing: 5) { Text(artifact.name); Mono(artifact.path); Text(ByteFormat.string(artifact.size)) } }
            }
        }
    }

    private func fact<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(4)) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 84, alignment: .leading)
            value().font(PerpetoFont.caption).foregroundStyle(PerpetoColor.inkSoft)
        }
    }

    @ViewBuilder private var logView: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            HStack(spacing: PerpetoSpacing.x(2)) {
                Text("Log").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                if job.status.isActive && job.jobId != nil { LiveDot() }
                Spacer()
                if log.truncated { Text("Earlier output was trimmed").font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted) }
            }
            ScrollView {
                Text(log.text.isEmpty ? (job.jobId == nil ? "This job has not started." : "No output yet.") : log.text)
                    .font(PerpetoFont.mono(PerpetoType.text12))
                    .foregroundStyle(log.text.isEmpty ? PerpetoColor.muted : PerpetoColor.inkSoft)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(PerpetoSpacing.x(3))
            }
            .defaultScrollAnchor(.bottom)
            .frame(minHeight: 160, maxHeight: 360)
            .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
        }
    }

    private func follow() async {
        guard let jobId = job.jobId else { return }
        log = LogBuffer()
        while !Task.isCancelled {
            if let page = try? await data.logPage(jobId: jobId, after: log.cursor) {
                log.append(page)
                if page.hasMore { continue }
            }
            guard job.status.isActive else { return }
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

/// Display text for CI rows.
public enum CIFormat {
    public static func duration(_ seconds: TimeInterval?) -> String {
        guard let seconds else { return "—" }
        if seconds < 60 { return "\(Int(seconds.rounded())) s" }
        let minutes = Int(seconds) / 60
        if minutes < 60 { return "\(minutes) min \(Int(seconds) % 60) s" }
        return "\(minutes / 60) h \(minutes % 60) min"
    }

    public static func jobProgress(_ jobs: [PipelineRunJob]) -> String {
        "\(jobs.filter { $0.status == .passed }.count) of \(jobs.count) passed"
    }

    static func jobMeta(_ job: PipelineRunJob) -> String {
        var parts = [duration(job.elapsed())]
        if job.attempt > 1 { parts.append("attempt \(job.attempt)") }
        if let cache = job.cache.first { parts.append(cache.hit ? "cache hit" : "cache miss") }
        if job.flaky { parts.append("flaky") }
        return parts.joined(separator: " · ")
    }

    static func runnerMeta(_ runner: Runner) -> String {
        var parts: [String] = []
        if runner.maxJobs == 0 { parts.append("Agents only") } else {
            parts.append("\(runner.busy) of \(runner.maxJobs) slots busy")
            if !runner.pools.isEmpty { parts.append(runner.pools.map(\.name).joined(separator: ", ")) }
        }
        if let cache = runner.cache { parts.append("cache \(ByteFormat.string(cache.sizeBytes)) of \(ByteFormat.string(cache.maxBytes))") }
        if let utilisation = runner.utilisation { parts.append("\(Int((utilisation * 100).rounded()))% used today") }
        return parts.joined(separator: " · ")
    }

    static func runnerState(_ runner: Runner) -> (String, StatusTone) {
        if runner.status != .online { return runner.status == .draining ? ("Draining", .paused) : ("Offline", .neutral) }
        if runner.maxJobs == 0 { return ("No CI", .neutral) }
        return runner.busy > 0 ? ("Busy", .running) : ("Idle", .ok)
    }
}
