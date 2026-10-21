import PerpetoKit
import SwiftUI

/// Project overview: what is live, what needs a person, the goals, then
/// recent runs and the merge queue. Three numbers up front; the rest behind
/// "More metrics".
struct OverviewScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    var project: Project
    var state: ProjectState

    @State private var moreMetrics = false
    @State private var moreIssues = false
    @State private var showDocs = false
    @Environment(\.compactLayout) private var compact

    private var liveRun: Run? { state.runs.first { $0.status == .running } ?? state.runs.first { $0.status == .paused } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                header.padding(.bottom, PerpetoSpacing.x(compact ? 0 : 4))
                liveCard
                AdaptiveColumns {
                    attentionCard
                    goalsCard
                } side: {
                    runsCard
                    mergeCard
                }
            }
            .screenPadding()
        }
    }

    // MARK: Header

    private var header: some View {
        ScreenHeader(project.name, meta: {
            HStack(spacing: 6) {
                Mono(Format.repoName(project.repo.url), color: PerpetoColor.inkSoft, size: compact ? PerpetoType.text13 : PerpetoType.text14)
                Text("on")
                Mono(project.repo.defaultBranch, color: PerpetoColor.inkSoft, size: compact ? PerpetoType.text13 : PerpetoType.text14)
            }
        }) {
            if !compact {
                Menu {
                    Button("Refresh") { Task { await store.refresh() } }
                    Button("Open workflows") { navigator.route = .project(project.id, .workflows) }
                    Button("All runs") { navigator.selectedRunId = nil; navigator.route = .project(project.id, .runs) }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold)).foregroundStyle(PerpetoColor.inkSoft)
                        .frame(width: PerpetoControl.height, height: PerpetoControl.height).contentShape(Circle())
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("More actions")
            }
            primaryAction.fullWidthButtons(compact)
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        if let run = liveRun {
            Button { openRun(run) } label: { Label("Open live map", systemImage: "arrow.right").labelStyle(TrailingIconLabelStyle()) }
                .buttonStyle(.perpetoPrimary)
        } else if state.workflows.isEmpty {
            Button("Draft a workflow") { navigator.route = .project(project.id, .workflows) }.buttonStyle(.perpetoPrimary)
        } else {
            Button("Open workflows") { navigator.route = .project(project.id, .workflows) }.buttonStyle(.perpetoPrimary)
        }
    }

    private func openRun(_ run: Run) {
        navigator.selectedRunId = run.id
        navigator.route = .project(project.id, .runs)
    }

    // MARK: Live

    private var liveCard: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
            let lead = VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                HStack(spacing: PerpetoSpacing.x(3)) {
                    if let run = liveRun, run.status == .running { LiveDot() } else { StatusIcon(liveRun == nil ? .neutral : .paused) }
                    Text(liveTitle).font(PerpetoType.text(PerpetoType.text16, weight: .medium)).foregroundStyle(PerpetoColor.ink)
                }
                if let run = liveRun {
                    RunMeta(run: run).padding(.leading, PerpetoSpacing.x(6))
                } else {
                    Text("Start a run from Workflows to see work move.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
            if compact {
                lead
                FigureStrip(headline)
            } else {
                HStack(alignment: .top, spacing: PerpetoSpacing.x(8)) {
                    lead.frame(maxWidth: .infinity, alignment: .leading)
                    FigureStrip(headline).frame(maxWidth: 560)
                }
            }
            if let run = liveRun, !(run.settings.budget?.isEmpty ?? true) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    Text("Budget today").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                    BudgetLine(run: run)
                }
                .frame(maxWidth: compact ? .infinity : 560, alignment: .leading)
            }
            Disclosure("More metrics", isExpanded: $moreMetrics) {
                FigureStrip(more)
            }
        }
        .card()
    }

    private var liveTitle: String {
        guard let run = liveRun else { return "No run is live" }
        let name = state.workflows.first { $0.id == run.workflowId }?.name ?? "Workflow"
        return run.status == .running ? "\(name) run is live" : "\(name) run is paused"
    }

    private var headline: [Figure] {
        [
            Figure("Agents working", value: "\(state.activeAgents)"),
            Figure("Queued work", value: "\(state.queuedWork)"),
            Figure("Tokens today", value: Format.tokens(state.usage.today)),
        ]
    }

    private var more: [Figure] {
        let m = state.metrics?.run
        return [
            Figure("Items done per day", value: m.map { String(format: "%.1f", $0.velocity.itemsDonePerDay) } ?? "n/a", size: PerpetoType.text20),
            Figure("Cycle time, p90", value: Format.duration(m?.cycleTimeSec.p90), size: PerpetoType.text20),
            Figure("Tokens per item", value: Format.tokens(m?.tokensPerItem), size: PerpetoType.text20),
        ]
    }

    // MARK: Attention

    private struct Issue: Identifiable {
        var id: String
        var title: String
        var detail: String
        var tone: StatusTone
        var draft: Workflow?
        var nodeId: String?
        var workItem: WorkItem?
        var runId: String?
    }

    private var issues: [Issue] {
        var result: [Issue] = []
        let graph = liveRun.flatMap { run in state.version(run.workflowVersion, of: run.workflowId)?.graph ?? state.workflows.first { $0.id == run.workflowId }?.graph }
        for b in (state.metrics?.bottlenecks ?? []).sorted(by: { $0.severity.rank > $1.severity.rank }) where b.severity != .info {
            let label = graph?.node(b.nodeId)?.label ?? b.nodeId
            let draft = liveRun.flatMap { state.pendingDraft(of: $0.workflowId) }
            result.append(Issue(id: b.id, title: b.reason.headline(label),
                                detail: b.evidence + (result.isEmpty ? (draft.map { " Workflow v\($0.version) proposes a change." } ?? "") : ""),
                                tone: .warning, draft: result.isEmpty ? draft : nil, nodeId: b.nodeId))
        }
        for run in state.runs where run.isBudgetHeld {
            let name = state.workflows.first { $0.id == run.workflowId }?.name ?? "Workflow"
            result.append(Issue(id: "budget-\(run.id)", title: "\(name) run: \(BudgetHold.title(run).lowercased())", detail: BudgetHold.detail(run), tone: .paused, runId: run.id))
        }
        for item in state.workItems where item.status == .blocked && item.decisionId != nil {
            result.append(Issue(id: item.id, title: "Approval needed: \(item.title)", detail: "A person decides before this work continues.", tone: .approval, workItem: item))
        }
        for workflow in state.workflows {
            if let draft = state.pendingDraft(of: workflow.id), !result.contains(where: { $0.draft?.version == draft.version }) {
                result.append(Issue(id: "draft-\(workflow.id)", title: "Workflow v\(draft.version) is ready to review",
                                    detail: draft.rationale ?? "A new draft of \(workflow.name) waits for activation.", tone: .warning, draft: draft))
            }
        }
        return result
    }

    private var attentionCard: some View {
        let all = issues
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            SectionTitle("Needs attention", detail: all.isEmpty ? nil : "\(all.count) open")
            if let first = all.first {
                issue(first)
                if all.count > 1 {
                    Disclosure(Format.plural(all.count - 1, "more issue"), isExpanded: $moreIssues) {
                        VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                            ForEach(all.dropFirst()) { issue($0) }
                        }
                    }
                    .padding(.leading, PerpetoSpacing.x(9))
                }
            } else {
                HStack(spacing: PerpetoSpacing.x(3)) {
                    StatusIcon(.success)
                    Text("Nothing needs you. Work is moving at the expected rate.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
            }
        }
        .card()
    }

    private func issue(_ issue: Issue) -> some View {
        HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
            StatusIcon(issue.tone, size: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                Text(issue.title).font(PerpetoType.text(PerpetoType.text16, weight: .medium)).foregroundStyle(PerpetoColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(issue.detail).perpetoBody(PerpetoType.text14, color: PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: PerpetoSpacing.x(2)) {
                    if let draft = issue.draft {
                        Button("Review proposal") {
                            navigator.selectedWorkflowId = draft.id
                            navigator.route = .project(project.id, .workflows)
                        }
                        .buttonStyle(.perpetoSecondary)
                    }
                    if let runId = issue.runId, let run = state.runs.first(where: { $0.id == runId }) {
                        Button("Open run") { openRun(run) }.buttonStyle(.perpetoSecondary)
                    }
                    if issue.workItem != nil {
                        Button("Open work") { navigator.route = .project(project.id, .work) }.buttonStyle(.perpetoSecondary)
                    }
                    if let node = issue.nodeId, let run = liveRun {
                        Button("Show on map") {
                            navigator.selectedNodeId = node
                            openRun(run)
                        }
                        .buttonStyle(.perpetoGhost)
                    }
                }
                .padding(.top, PerpetoSpacing.x(3))
            }
        }
    }

    // MARK: Goals

    private var goalsCard: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Goals")
            if project.goals.isEmpty {
                Text("Add goals so the planner knows what to aim for.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    .padding(.top, PerpetoSpacing.x(3))
            } else {
                RowList(project.goals.filter { $0.status != .dropped }) { goal in
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(4)) {
                            Text(goal.title).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: PerpetoSpacing.x(2))
                            if goal.status == .done {
                                StatusLabel("Done", tone: .success)
                            } else {
                                Text(goal.total > 0 ? "\(goal.done) of \(goal.total)" : "No work yet")
                                    .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                            }
                        }
                        Meter(goal.status == .done ? 1 : goal.progress ?? 0)
                            .accessibilityLabel("Progress on \(goal.title)")
                    }
                }
            }
            if !project.docs.isEmpty {
                Disclosure("Docs and requirements · \(project.docs.count)", isExpanded: $showDocs) {
                    RowList(project.docs) { doc in
                        HStack {
                            RowText(doc.title, meta: doc.kind.rawValue.capitalized)
                            Spacer()
                            if let path = doc.path ?? doc.url { Mono(path) }
                        }
                    }
                }
                .padding(.top, PerpetoSpacing.x(3))
            }
        }
        .card()
    }

    // MARK: Side

    private var runsCard: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Runs") {
                if !state.runs.isEmpty {
                    CardLink("All") { navigator.selectedRunId = nil; navigator.route = .project(project.id, .runs) }
                }
            }
            if state.runs.isEmpty {
                Text("No runs yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            } else {
                RowList(Array(state.runs.prefix(3))) { run in
                    Button { openRun(run) } label: {
                        HStack {
                            RowText(run.id, meta: "v\(run.workflowVersion) · \(Format.relative(run.startedAt))", mono: true)
                            Spacer(minLength: PerpetoSpacing.x(2))
                            StatusLabel(run.status.label)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .card()
    }

    private var mergeCard: some View {
        let queue = state.mergeQueue
        let rows: [(String, StatusTone, Int)] = [
            ("Testing", .running, queue.filter { $0.status == .testing || $0.status == .merging }.count),
            ("Queued", .neutral, queue.filter { $0.status == .queued }.count),
            ("Merged", .success, queue.filter { $0.status == .merged }.count),
            ("Rejected", .dismissed, queue.filter { $0.status == .rejected }.count),
        ].filter { $0.2 > 0 }
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Merge queue") { CardLink("Open") { navigator.route = .project(project.id, .mergeQueue) } }
            if rows.isEmpty {
                Text("The queue is empty.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            } else {
                RowList(rows.map { IdentifiedText(text: $0.0, tone: $0.1, count: $0.2) }) { row in
                    HStack {
                        StatusLabel(row.text, tone: row.tone ?? .neutral)
                        Spacer()
                        Text("\(row.count ?? 0)").font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                    }
                }
            }
        }
        .card()
    }
}

/// Plain text with an identity, for simple lists.
struct IdentifiedText: Identifiable {
    var text: String
    var tone: StatusTone?
    var count: Int?
    var id: String { text }
}

/// "run_7q4m2x · Workflow v3 · Started 3 days ago"
struct RunMeta: View {
    var run: Run
    var body: some View {
        HStack(spacing: 5) {
            Mono(run.id, color: PerpetoColor.muted)
            Text("· Workflow v\(run.workflowVersion) · \(Self.times(run))")
                .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
        }
    }

    /// "Started 3 days ago", "Completed 2 h ago" or "Stopped 5 d ago".
    static func times(_ run: Run) -> String {
        if let done = run.completedAt { return "Completed \(Format.relative(done)), took \(Format.duration(done.timeIntervalSince(run.startedAt)))" }
        if let stopped = run.stoppedAt { return "\(run.status == .failed ? "Failed" : "Stopped") \(Format.relative(stopped))" }
        return "Started \(Format.relative(run.startedAt))"
    }
}

/// A trailing arrow for actions that open something: "Open live map →".
struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            configuration.title
            configuration.icon.font(.system(size: 13, weight: .semibold))
        }
    }
}
