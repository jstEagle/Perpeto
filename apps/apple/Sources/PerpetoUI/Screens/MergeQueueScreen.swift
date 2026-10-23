import PerpetoKit
import SwiftUI

/// Merge queue: a picker over the project's queues, the freeze, what is in
/// flight, throughput, the entries in merge order with lane and status, and a
/// settings sheet. Hubs without configurable queues get the plain entry list.
struct MergeQueueScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var settings: MergeQueueSettings?
    @State private var loaded = false
    @State private var selected: String?
    @State private var view: MergeQueueView?
    @State private var editing = false
    @State private var moreMetrics = false
    @State private var showRecent = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Merge queue", subtitle: "Changes merge after CI passes on the exact candidate commit. Lanes order the work; a freeze holds publication.") {
                    if let view, !(view.frozen?.isManual ?? false) {
                        Button("Freeze") { Task { await setFrozen(true) } }.buttonStyle(.perpetoSecondary)
                    }
                    if settings != nil { Button("Settings") { editing = true }.buttonStyle(.perpetoSecondary) }
                }
                if let settings {
                    if settings.queues.isEmpty {
                        EmptyState("No merge queues yet", message: "Name a queue for each target branch with its strategy, checks and lanes. Workflows then use it by name.", systemImage: "arrow.triangle.branch") {
                            Button("Set up a merge queue") { editing = true }.buttonStyle(.perpetoPrimary)
                        }
                        .card()
                    } else {
                        if settings.queues.count > 1 {
                            PillPicker(settings.queues.map { (value: Optional($0.id), title: $0.name, count: $0.open > 0 ? Optional($0.open) : nil) }, selection: $selected)
                        }
                        if let view { queue(view) }
                    }
                    repoNote(settings)
                } else if loaded {
                    legacy
                }
            }
            .screenPadding()
        }
        .task(id: "\(project.id)|\(state.mergeQueue.hashValue)|\(state.events.first?.seq ?? 0)") { await load() }
        .onChange(of: selected) { _, _ in Task { await loadView() } }
        .sheet(isPresented: $editing) {
            if let settings {
                MergeQueueSettingsSheet(settings: settings) { config in
                    let saved = try await store.saveMergeQueues(projectId: project.id, config: config, baseVersion: settings.version)
                    self.settings = saved
                    await loadView()
                }
            }
        }
    }

    private func load() async {
        settings = await store.mergeQueues(projectId: project.id)
        loaded = true
        if selected == nil || !(settings?.queues.contains { $0.id == selected } ?? false) { selected = settings?.queues.first?.id }
        await loadView()
    }
    private func loadView() async {
        guard let selected else { view = nil; return }
        view = await store.mergeQueueView(id: selected)
    }
    private func setFrozen(_ frozen: Bool) async {
        guard let selected else { return }
        if let updated = await store.setMergeQueueFrozen(id: selected, frozen: frozen, reason: frozen ? "Frozen by the owner." : nil) { view = updated }
        settings = await store.mergeQueues(projectId: project.id)
    }

    @ViewBuilder
    private func queue(_ view: MergeQueueView) -> some View {
        if let frozen = view.frozen {
            HStack(alignment: .center, spacing: PerpetoSpacing.x(6)) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                    Text("Frozen: \(frozen.reason)").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                    Text(freezeText(frozen)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
                Spacer(minLength: 0)
                if frozen.isManual { Button("Unfreeze") { Task { await setFrozen(false) } }.buttonStyle(.perpetoPrimary) }
            }
            .card()
        }
        now(view)
        throughput(view)
        order(view)
        if !view.recent.isEmpty {
            Disclosure("Recent outcomes (\(view.recent.count))", isExpanded: $showRecent) {
                RowList(view.recent) { entry in
                    HStack(alignment: .top) {
                        RowText(Format.prNumber(entry.prUrl),
                                meta: entry.status == .rejected ? "\(MergeQueueCause.label(entry.cause))\(entry.reason.map { ": \($0)" } ?? "")" : "In queue \(MergeQueueText.duration(ms: entry.waitedMs))")
                        Spacer(minLength: PerpetoSpacing.x(2))
                        StatusLabel(entry.status.label.0, tone: entry.status.label.1)
                    }
                }
            }
            .card()
        }
    }

    private func now(_ view: MergeQueueView) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    if !view.attempts.isEmpty { LiveDot() }
                    Text(view.summary).font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
                    if view.frozen == nil, let eta = view.entries.first(where: { $0.etaAt != nil })?.etaAt, let date = HubCoding.parseDate(eta) {
                        Text("· next merge about \(date.formatted(date: .omitted, time: .shortened))").font(PerpetoType.text(PerpetoType.text24)).foregroundStyle(PerpetoColor.muted)
                    }
                }
                HStack(spacing: 5) {
                    Mono(view.branches.joined(separator: ", "))
                    Text("· \(view.strategyText)\(view.config.map { $0.requiredChecks.isEmpty ? "" : " · requires \($0.requiredChecks.joined(separator: ", "))" } ?? "")")
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
            if !view.attempts.isEmpty {
                RowList(view.attempts) { attempt in
                    HStack(alignment: .top) {
                        RowText(attempt.label(strategy: view.strategy), meta: attempt.entryIds.compactMap { id in view.entries.first { $0.id == id } }.map { Format.prNumber($0.prUrl) }.joined(separator: ", "))
                        Spacer(minLength: PerpetoSpacing.x(2))
                        if attempt.jobStatus == "running" || attempt.jobStatus == "queued" || attempt.jobStatus == "leased" { StatusLabel("Running", tone: .running) }
                        else if let status = attempt.jobStatus { StatusLabel(status.capitalized, tone: status == "passed" ? .success : status == "failed" ? .error : .neutral) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func throughput(_ view: MergeQueueView) -> some View {
        let m = view.metrics
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            SectionTitle("Throughput") { Text(MetricsWindow(rawValue: view.window)?.title ?? view.window).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
            FigureStrip([
                Figure("Merged per hour", value: String(format: m.throughputPerHour < 1 && m.throughputPerHour > 0 ? "%.2f" : "%.1f", m.throughputPerHour), detail: "\(m.merged) merges"),
                Figure("Median time in queue", value: MergeQueueText.duration(ms: m.medianTimeInQueueMs)),
                Figure("Failure rate", value: m.failureRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—", detail: m.rejected > 0 ? "\(m.rejected) rejections" : nil),
            ])
            Disclosure("More metrics", isExpanded: $moreMetrics) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                    TrendBars(m.hourly.map { Double($0.merged + $0.rejected) }, start: "\(m.hourly.count) h ago", unit: "merges")
                        .frame(height: 72)
                    metricRow("Batch success", m.batches.total > 0 ? "\(Int(((m.batches.successRate ?? 0) * 100).rounded()))% of \(m.batches.total)" : "—")
                    metricRow("Flaky retries", "\(m.flakyRetries)")
                    metricRow("Attempt time", MergeQueueText.duration(ms: view.eta.attemptMs))
                    ForEach(m.failuresByReason, id: \.cause) { reason in
                        metricRow(MergeQueueCause.label(reason.cause), "\(reason.count) · \(Int((reason.rate * 100).rounded()))%")
                    }
                }
            }
        }
        .card()
    }

    private func metricRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            Spacer()
            Text(value).font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
        }
    }

    @ViewBuilder
    private func order(_ view: MergeQueueView) -> some View {
        if view.entries.isEmpty {
            EmptyState("The queue is empty", message: "Pull requests join after their workflow’s gates pass.", systemImage: "arrow.triangle.branch").card()
        } else {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                SectionTitle("In order") { Text("\(view.entries.count) open").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                RowList(view.entries) { entry in
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                        Text("\(entry.position)").font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.muted).frame(width: 20, alignment: .leading)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Pull request \(Format.prNumber(entry.prUrl))").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                            HStack(spacing: 5) {
                                if let branch = entry.headBranch { Mono(branch) }
                                if let lane = entry.lane { Text("· \(lane)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                                if let eta = entry.etaAt.flatMap(HubCoding.parseDate) {
                                    Text("· about \(eta.formatted(date: .omitted, time: .shortened))").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                }
                            }
                            if let reason = entry.deliveryError ?? entry.reason {
                                Text(reason).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: PerpetoSpacing.x(2))
                        StatusLabel(entry.status.label.0, tone: entry.status.label.1)
                        if entry.status != .merging {
                            Menu {
                                ForEach((view.config?.lanes ?? []).filter { $0.name != entry.lane }, id: \.name) { lane in
                                    Button("Move to \(lane.name)") { Task { await command(entry, .lane(lane.name)) } }
                                }
                                Button("Send to the back") { Task { await command(entry, .requeue) } }
                                Button("Eject") { Task { await command(entry, .eject(reason: nil)) } }
                            } label: {
                                Image(systemName: "ellipsis").foregroundStyle(PerpetoColor.inkSoft).frame(width: 28, height: 20)
                            }
                            .menuStyle(.button).buttonStyle(.plain).fixedSize()
                            .accessibilityLabel("Actions for pull request \(Format.prNumber(entry.prUrl))")
                        }
                    }
                }
            }
            .card()
        }
    }

    private func command(_ entry: QueueEntryView, _ command: MergeEntryCommand) async {
        await store.mergeEntryCommand(entryId: entry.id, projectId: project.id, command)
        await loadView()
    }

    private func freezeText(_ frozen: MergeQueueFreeze) -> String {
        var parts: [String] = []
        if let since = frozen.since.flatMap(HubCoding.parseDate) { parts.append("Since \(since.formatted(date: .omitted, time: .shortened))") }
        if let until = frozen.until.flatMap(HubCoding.parseDate) { parts.append("until \(until.formatted(date: .abbreviated, time: .shortened))") }
        else if frozen.isManual { parts.append("until someone unfreezes it") }
        return parts.joined(separator: ", ") + ". Tested changes wait; nothing merges until it lifts."
    }

    private func repoNote(_ settings: MergeQueueSettings) -> some View {
        Group {
            if settings.repo.applied {
                Text("Settings version \(settings.version), with \(settings.repo.path) from \(Format.shortSha(settings.repo.revision ?? "")) applied on top.")
            } else if settings.repo.found {
                Text("\(settings.repo.path) is not applied: \(settings.repo.error ?? settings.repo.errors?.first.map { "\($0.path) \($0.message)" } ?? "it has problems").")
                    .foregroundStyle(PerpetoColor.error)
            } else {
                Text("Settings version \(settings.version). A committed \(settings.repo.path) would override them per queue.")
            }
        }
        .font(PerpetoFont.caption)
        .foregroundStyle(PerpetoColor.muted)
    }

    /// Hubs from before configurable queues.
    private var legacy: some View {
        Group {
            if state.mergeQueue.isEmpty {
                EmptyState("The queue is empty", message: "Pull requests join the queue when they pass review and CI.", systemImage: "arrow.triangle.branch").card()
            } else {
                RowList(state.mergeQueue) { entry in
                    HStack(alignment: .top) {
                        RowText(Format.prNumber(entry.prUrl), meta: entry.reason ?? "\(Format.shortSha(entry.headSha)) into \(entry.baseBranch)")
                        Spacer(minLength: PerpetoSpacing.x(2))
                        StatusLabel(entry.status.label.0, tone: entry.status.label.1)
                    }
                }
                .card()
            }
        }
    }
}

/// The settings the Apple app edits: strategy, sizes, gates and retries per
/// queue, checked with the hub's rules as you type. Lanes and freeze windows
/// are shown; edit them on the web or in the repository file.
struct MergeQueueSettingsSheet: View {
    var settings: MergeQueueSettings
    var save: (MergeQueueConfig) async throws -> Void
    @State private var config = MergeQueueConfig(queues: [])
    @State private var index = 0
    @State private var failure: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    private var problems: [ConfigProblem] { config.queues.enumerated().flatMap { $0.element.problems(at: $0.offset) } }
    private func problem(_ field: String) -> String? { problems.first { $0.path == "$.queues[\(index)].\(field)" }?.message }

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            Text("Merge queue settings").font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
            Text("Version \(settings.version). A committed \(settings.repo.path) overrides these per queue and field.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            if config.queues.count > 1 {
                PillPicker(config.queues.enumerated().map { (value: $0.offset, title: $0.element.name, count: Optional<Int>.none) }, selection: $index)
            }
            if config.queues.indices.contains(index) {
                ScrollView { form($config.queues[index]) }.frame(minHeight: 360)
            }
            if let failure { Text(failure).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.error) }
            HStack {
                if !problems.isEmpty { Text(problems.count == 1 ? "1 problem to fix" : "\(problems.count) problems to fix").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.error) }
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.perpetoGhost).keyboardShortcut(.cancelAction)
                Button("Save settings") {
                    saving = true
                    Task {
                        do { try await save(config); dismiss() } catch { failure = "Saving failed. \((error as? LocalizedError)?.errorDescription ?? "Check the hub connection.")" }
                        saving = false
                    }
                }
                .buttonStyle(.perpetoPrimary).keyboardShortcut(.defaultAction).disabled(saving || !problems.isEmpty)
            }
        }
        .padding(PerpetoSpacing.x(8))
        .frame(minWidth: 520, idealWidth: 600, minHeight: 560)
        .background(PerpetoColor.surface)
        .presentationCornerRadius(PerpetoRadius.sheet)
        .onAppear { config = settings.config }
    }

    private func form(_ queue: Binding<QueueConfig>) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            field("Strategy", problem: problem("strategy")) {
                PillPicker(QueueConfig.Strategy.allCases.map { ($0, $0 == .serial ? "One at a time" : $0 == .batch ? "Batches" : "Speculative") }, selection: queue.strategy)
            }
            if queue.wrappedValue.strategy == .batch { number("Largest batch", queue.maxBatchSize, problem: problem("maxBatchSize")) }
            if queue.wrappedValue.strategy == .speculative { number("Depth", queue.depth, problem: problem("depth")) }
            optionalNumber("Most in flight", queue.maxInFlight, problem: problem("maxInFlight"))
            field("Required checks", problem: nil) {
                TextField("test, lint", text: Binding(get: { queue.wrappedValue.requiredChecks.joined(separator: ", ") },
                                                     set: { queue.wrappedValue.requiredChecks = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }))
                    .textFieldStyle(.plain).perpetoField()
            }
            number("Approving reviews", queue.requiredApprovals, problem: problem("requiredApprovals"))
            number("Flaky retries", queue.flakyRetries, problem: problem("flakyRetries"))
            optionalNumber("Eject after (minutes)", queue.ejectAfterMinutes, problem: problem("ejectAfterMinutes"))
            Toggle("Split a failed batch to find the culprit", isOn: queue.bisectOnBatchFailure)
            Toggle("Rebase automatically after a conflict", isOn: queue.autoRebaseOnConflict)
            if let publication = problem("publication") { Text(publication).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.error) }
            if !queue.wrappedValue.lanes.isEmpty || !queue.wrappedValue.freeze.windows.isEmpty {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                    Text("Lanes and freeze windows").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                    ForEach(queue.wrappedValue.lanes, id: \.name) { lane in Text("\(lane.name), priority \(lane.priority)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                    ForEach(queue.wrappedValue.freeze.windows, id: \.self) { window in Text(window.summary).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                    Text("Edit these on the web or in the repository file.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
        }
        .toggleStyle(.switch)
    }

    private func field<Content: View>(_ title: String, problem: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            Text(title).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
            content()
            if let problem { Text(problem).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.error) }
        }
    }
    private func number(_ title: String, _ value: Binding<Int>, problem: String?) -> some View {
        field(title, problem: problem) {
            TextField(title, value: value, format: .number).textFieldStyle(.plain).perpetoField()
        }
    }
    private func optionalNumber(_ title: String, _ value: Binding<Int?>, problem: String?) -> some View {
        field(title, problem: problem) {
            TextField("None", text: Binding(get: { value.wrappedValue.map(String.init) ?? "" }, set: { value.wrappedValue = Int($0.trimmingCharacters(in: .whitespaces)) }))
                .textFieldStyle(.plain).perpetoField()
        }
    }
}
