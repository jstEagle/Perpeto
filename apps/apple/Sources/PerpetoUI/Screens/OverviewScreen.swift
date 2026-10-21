import Charts
import PerpetoKit
import SwiftUI

struct OverviewScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    var project: Project
    var state: ProjectState

    private var liveRun: Run? { state.runs.first { $0.status == .running } ?? state.runs.first { $0.status == .paused } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                header
                FigureStrip([
                    Figure("Active agents", value: "\(state.activeAgents)", detail: "across \(Format.plural(Set(state.assignments.filter(\.isWorking).compactMap(\.machineId)).count, "machine"))"),
                    Figure("Queued work", value: "\(state.queuedWork)", detail: "\(state.workItems.filter { $0.status == .active }.count) items active"),
                    Figure("Tokens today", value: Format.tokens(state.usage.today), detail: Format.tokens(state.usage.total) + " in 14 days"),
                    Figure("Items done per day", value: state.metrics.map { String(format: "%.1f", $0.run.velocity.itemsDonePerDay) } ?? "—", detail: state.metrics.map { "WIP \($0.run.wip)" } ?? "No run measured yet"),
                    Figure("Cycle time p90", value: state.metrics.map { Format.duration($0.run.cycleTimeSec.p90) } ?? "—", detail: state.metrics.map { "avg " + Format.duration($0.run.cycleTimeSec.avg) } ?? " "),
                ])
                HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                        bottleneckPanel
                        agentsPanel
                    }
                    .frame(maxWidth: .infinity)
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                        velocityPanel
                        usagePanel
                    }
                    .frame(width: 360)
                }
                activityPanel
            }
            .padding(PerpetoSpacing.x(6))
            .frame(maxWidth: 1240, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            Text(project.name)
                .font(PerpetoFont.display())
                .displayTracking()
                .foregroundStyle(PerpetoColor.ink)
            HStack(spacing: PerpetoSpacing.x(3)) {
                Mono(Format.repoName(project.repo.url))
                Tag(project.repo.defaultBranch, systemImage: "arrow.triangle.branch")
                if let run = liveRun {
                    StatusLabel(run.status.label)
                    Mono(run.id)
                }
            }
            if !project.goals.isEmpty {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                    ForEach(project.goals, id: \.self) { goal in
                        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
                            Rectangle().fill(PerpetoColor.accent).frame(width: 6, height: 2).offset(y: -3)
                            Text(goal).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var bottleneckPanel: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Top bottleneck", detail: state.metrics?.window.map { "measured over \($0)" })
            if let top = state.metrics?.topBottleneck, let run = liveRun {
                let label = state.workflows.first { $0.id == run.workflowId }?.graph.node(top.nodeId)?.label ?? top.nodeId
                HStack(alignment: .top, spacing: PerpetoSpacing.x(3)) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(top.severity.tone.color)
                        .font(.system(size: 16))
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                        HStack(spacing: PerpetoSpacing.x(2)) {
                            Text("\(label): \(top.reason.title.lowercased())")
                                .font(PerpetoFont.title(PerpetoType.size16))
                                .foregroundStyle(PerpetoColor.ink)
                            StatusLabel(top.severity.title, tone: top.severity.tone)
                        }
                        Text(top.evidence).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                        if let others = state.metrics?.bottlenecks.filter({ $0 != top }), !others.isEmpty {
                            Text("Also: " + others.map { $0.reason.title.lowercased() + " at " + (state.workflows.first { $0.id == run.workflowId }?.graph.node($0.nodeId)?.label ?? $0.nodeId) }.joined(separator: "; ") + ".")
                                .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        }
                    }
                }
                HStack(spacing: PerpetoSpacing.x(2)) {
                    if let draft = state.pendingDraft(of: run.workflowId) {
                        Button("Review proposal, version \(draft.version)") {
                            navigator.selectedWorkflowId = run.workflowId
                            navigator.route = .project(project.id, .workflows)
                        }
                        .buttonStyle(.perpetoPrimary)
                    }
                    Button("Open live map") {
                        navigator.selectedRunId = run.id
                        navigator.route = .project(project.id, .runs)
                    }
                    .buttonStyle(.perpetoSecondary)
                }
            } else {
                Text(liveRun == nil ? "No run is active. Start a run from Workflows to measure flow." : "No bottleneck measured. Work is moving at the expected rate.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel()
    }

    private var agentsPanel: some View {
        let working = state.assignments.filter(\.isWorking)
        return VStack(alignment: .leading, spacing: 0) {
            SectionTitle("Active agents", detail: Format.plural(working.count, "agent") + " working")
                .padding(.bottom, PerpetoSpacing.x(3))
            if working.isEmpty {
                Text("No agents are working on this project.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
            ForEach(Array(working.enumerated()), id: \.element.id) { index, assignment in
                if index > 0 { Rule() }
                AgentRow(assignment: assignment, item: state.workItems.first { $0.id == assignment.workItemId }, machine: store.machine(assignment.machineId))
                    .padding(.vertical, PerpetoSpacing.x(2.5))
            }
        }
        .panel()
    }

    private var velocityPanel: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Velocity", detail: "items done per day")
            if let metrics = state.metrics {
                VelocityChart(trend: metrics.run.velocity.trend)
                    .frame(height: 120)
                HStack {
                    Figure("Per day", value: String(format: "%.1f", metrics.run.velocity.itemsDonePerDay))
                    Figure("Tokens per item", value: Format.tokens(Int(metrics.run.tokensPerItem)))
                }
            } else {
                Text("Velocity appears once a run finishes its first item.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
        }
        .panel()
    }

    private var usagePanel: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Token usage", detail: "last 14 days")
            TokenDayChart(groups: state.usage.byDay, compact: true)
                .frame(height: 120)
        }
        .panel()
    }

    private var activityPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle("Recent activity")
                .padding(.bottom, PerpetoSpacing.x(3))
            if state.events.isEmpty {
                Text("Nothing has happened in this project yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
            ForEach(Array(state.events.prefix(6).enumerated()), id: \.element.id) { index, event in
                if index > 0 { Rule() }
                EventRow(event: event, graph: state.workflows.first?.graph)
                    .padding(.vertical, PerpetoSpacing.x(2))
            }
        }
        .panel()
    }
}

struct AgentRow: View {
    var assignment: Assignment
    var item: WorkItem?
    var machine: Machine?

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(assignment.role).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Mono(assignment.harness.model)
            }
            .frame(width: 140, alignment: .leading)
            Text(item?.title ?? assignment.workItemId)
                .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(machine?.name ?? "Unassigned").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                .frame(width: 110, alignment: .leading)
            StatusLabel(assignment.status.label)
                .frame(width: 80, alignment: .leading)
        }
    }
}

/// One line of the interaction feed. Times and IDs are monospace.
struct EventRow: View {
    var event: HubEvent
    var graph: WorkflowGraph?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
            Text(Format.clock(event.at)).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.muted)
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(event.isUnplanned ? PerpetoColor.error : PerpetoColor.muted).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text(route).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                    if event.isUnplanned { StatusLabel("Unplanned", tone: .error) }
                    if let result = event.data["result"]?.stringValue {
                        StatusLabel(result == "pass" ? "Passed" : "Failed", tone: result == "pass" ? .success : .error)
                    }
                }
                Text(event.data["summary"]?.stringValue ?? event.type)
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
    }

    private func label(_ id: String?) -> String? { id.map { graph?.node($0)?.label ?? $0 } }

    private var route: String {
        let from = event.data["fromRole"]?.stringValue ?? label(event.data["fromNode"]?.stringValue)
        let to = event.data["toRole"]?.stringValue ?? label(event.data["toNode"]?.stringValue)
        switch event.interaction {
        case .agentMessaged: return "\(from ?? "?") messaged \(to ?? "?")"
        case .agentDelegated: return "\(from ?? "?") delegated to \(to ?? "?")"
        case .workitemMoved: return "\(label(event.data["fromNode"]?.stringValue) ?? "?") → \(label(event.data["toNode"]?.stringValue) ?? "?")"
        case .gateResult: return "\(label(event.data["nodeId"]?.stringValue) ?? "Gate") result"
        case .assignmentState: return "\(label(event.data["nodeId"]?.stringValue) ?? "Assignment") \(event.data["state"]?.stringValue ?? "")"
        case .unknown: return event.type
        }
    }

    private var icon: String {
        switch event.interaction {
        case .agentMessaged: "bubble.left"
        case .agentDelegated: "arrow.turn.down.right"
        case .workitemMoved: "arrow.right"
        case .gateResult: "checkmark.seal"
        case .assignmentState: "person.crop.square"
        case .unknown: "circle"
        }
    }
}

struct VelocityChart: View {
    var trend: [Double]

    var body: some View {
        Chart {
            ForEach(Array(trend.enumerated()), id: \.offset) { index, value in
                BarMark(x: .value("Day", dayLabel(index)), y: .value("Items", value), width: .ratio(0.55))
                    .foregroundStyle(index == trend.count - 1 ? PerpetoColor.accent : PerpetoColor.ink)
                    .cornerRadius(2)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(PerpetoColor.border)
                AxisValueLabel().font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .chartXAxis {
            AxisMarks { _ in AxisValueLabel().font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
        }
        .accessibilityLabel("Items done per day over the last \(trend.count) days")
    }

    private func dayLabel(_ index: Int) -> String {
        let offset = trend.count - 1 - index
        return offset == 0 ? "Today" : Date().addingTimeInterval(Double(-offset) * 86400).formatted(.dateTime.weekday(.abbreviated))
    }
}
