import Charts
import PerpetoKit
import SwiftUI

/// Runs, and the approved graph as the live map of the selected run.
struct RunsScreen: View {
    var store: FactoryStore
    @Bindable var navigator: Navigator
    var project: Project
    var state: ProjectState

    @State private var selection: GraphSelection?
    @State private var window: MetricsWindow = .day
    @State private var confirmStop = false

    private var run: Run? {
        state.runs.first { $0.id == navigator.selectedRunId } ?? state.runs.first { $0.status == .running } ?? state.runs.first
    }

    var body: some View {
        Group {
            if let run {
                RunDetail(store: store, project: project, state: state, run: run, selection: $selection, window: $window, confirmStop: $confirmStop,
                          runPicker: AnyView(runPicker(current: run)))
            } else {
                EmptyState("No runs yet", message: "Activate a workflow, then start a run to see work move through it.") {
                    Button("Open workflows") { navigator.route = .project(project.id, .workflows) }.buttonStyle(.perpetoPrimary)
                }
            }
        }
        .onChange(of: navigator.selectedRunId) { _, _ in selection = nil }
        .onChange(of: navigator.selectedNodeId, initial: true) { _, id in
            if let id { selection = .node(id) }
        }
    }

    private func runPicker(current: Run) -> some View {
        Menu {
            ForEach(state.runs) { r in
                Button {
                    navigator.selectedRunId = r.id
                } label: {
                    Text("\(workflowName(r)) v\(r.workflowVersion), \(r.status.label.0.lowercased()), started \(Format.relative(r.startedAt))")
                }
            }
        } label: {
            Label("\(Format.plural(state.runs.count, "run"))", systemImage: "list.bullet")
        }
        .fixedSize()
        .help("Choose a run")
    }

    private func workflowName(_ run: Run) -> String {
        state.workflows.first { $0.id == run.workflowId }?.name ?? run.workflowId
    }
}

struct RunDetail: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    var run: Run
    @Binding var selection: GraphSelection?
    @Binding var window: MetricsWindow
    @Binding var confirmStop: Bool
    var runPicker: AnyView

    private var workflow: Workflow? {
        state.version(run.workflowVersion, of: run.workflowId) ?? state.workflows.first { $0.id == run.workflowId }
    }

    private var metrics: MetricsSnapshot? { state.runMetrics[run.id] }
    private var runEvents: [HubEvent] { state.events.filter { $0.runId == run.id } }
    private var runItems: [WorkItem] { state.workItems.filter { $0.runId == run.id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, PerpetoSpacing.x(5))
                .padding(.vertical, PerpetoSpacing.x(4))
            HStack(alignment: .top, spacing: 0) {
                VStack(spacing: PerpetoSpacing.x(3)) {
                    if let workflow {
                        if let metrics {
                            GraphViewport(graph: workflow.graph, mode: .live(LiveOverlay(metrics: metrics, workItems: runItems, events: runEvents)), selection: $selection)
                        } else {
                            GraphViewport(graph: workflow.graph, mode: .view, selection: $selection)
                                .overlay(alignment: .top) {
                                    Text(run.status == .running ? "Waiting for the first measurements from the hub." : "This run has finished. Live measurements are kept only for active runs.")
                                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                        .padding(PerpetoSpacing.x(2))
                                        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
                                        .padding(PerpetoSpacing.x(3))
                                }
                        }
                    }
                    InteractionFeed(events: runEvents, selection: selection, graph: workflow?.graph)
                        .frame(height: 210)
                }
                .padding(.leading, PerpetoSpacing.x(5))
                .padding(.bottom, PerpetoSpacing.x(5))
                ScrollView {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                        SelectionPanel(state: state, run: run, graph: workflow?.graph, metrics: metrics, selection: selection, items: runItems)
                        if let metrics {
                            VelocityPanel(metrics: metrics)
                            WhereRunningPanel(store: store, state: state, run: run, metrics: metrics, graph: workflow?.graph)
                        }
                    }
                    .padding(.horizontal, PerpetoSpacing.x(4))
                    .padding(.bottom, PerpetoSpacing.x(5))
                }
                .frame(width: 340)
            }
        }
        .confirmationDialog("Stop this run?", isPresented: $confirmStop) {
            Button("Stop run", role: .destructive) { Task { await store.control(run, .stop) } }
        } message: {
            Text("Agents finish their current turn and no new work starts. Stopped runs cannot be resumed.")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: PerpetoSpacing.x(4)) {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text(workflow?.name ?? "Run").font(PerpetoFont.display(PerpetoType.text24)).displayTracking(PerpetoType.text24).foregroundStyle(PerpetoColor.ink)
                    Text("version \(run.workflowVersion)").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    StatusLabel(run.status.label)
                }
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Mono(run.id)
                    Text("Started \(Format.relative(run.startedAt))" + (run.stoppedAt.map { ", ended \(Format.relative($0))" } ?? ""))
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
            runPicker
            Spacer()
            if let metrics {
                HStack(spacing: PerpetoSpacing.x(5)) {
                    mini("Active agents", "\(metrics.run.activeAgents)")
                    mini("In progress", "\(metrics.run.wip)")
                    mini("Cycle time p90", Format.duration(metrics.run.cycleTimeSec.p90))
                    mini("Tokens per item", Format.tokens(Int(metrics.run.tokensPerItem)))
                }
                Picker("Window", selection: $window) {
                    ForEach(MetricsWindow.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .help("Measurement window. Demo data has one 24 h snapshot.")
            }
            controls
        }
    }

    private func mini(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            Text(value).font(PerpetoFont.figure(PerpetoType.text16)).foregroundStyle(PerpetoColor.ink)
        }
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            switch run.status {
            case .running:
                Button { Task { await store.control(run, .pause) } } label: { Label("Pause", systemImage: "pause") }
                    .buttonStyle(.perpetoSecondary)
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                Button { confirmStop = true } label: { Label("Stop", systemImage: "stop") }
                    .buttonStyle(.perpetoSecondary)
            case .paused:
                Button { Task { await store.control(run, .resume) } } label: { Label("Resume", systemImage: "play") }
                    .buttonStyle(.perpetoPrimary)
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                Button { confirmStop = true } label: { Label("Stop", systemImage: "stop") }
                    .buttonStyle(.perpetoSecondary)
            default:
                EmptyView()
            }
        }
    }
}

/// Detail for the selected node or edge, or the run's bottlenecks.
struct SelectionPanel: View {
    var state: ProjectState
    var run: Run
    var graph: WorkflowGraph?
    var metrics: MetricsSnapshot?
    var selection: GraphSelection?
    var items: [WorkItem]

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            if let id = selection?.nodeId, let node = graph?.node(id) {
                nodeDetail(node)
            } else if let id = selection?.edgeId, let edge = graph?.edges.first(where: { $0.id == id }), let graph {
                EdgeInspector(edge: edge, graph: graph, metric: metrics?.edge(id), delete: nil).padding(-PerpetoSpacing.x(4))
            } else {
                SectionTitle("Bottlenecks", detail: metrics.map { "\($0.bottlenecks.count) measured" })
                if let metrics, !metrics.bottlenecks.isEmpty {
                    ForEach(metrics.bottlenecks.sorted { $0.severity.rank > $1.severity.rank }) { b in
                        BottleneckRow(bottleneck: b, label: graph?.node(b.nodeId)?.label ?? b.nodeId)
                    }
                } else {
                    Text(metrics == nil ? "No measurements for this run." : "Nothing is holding work up.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
                Text("Select a node or edge on the map for its numbers.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .panel()
    }

    @ViewBuilder
    private func nodeDetail(_ node: GraphNode) -> some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            Image(systemName: node.type.systemImage).foregroundStyle(PerpetoColor.muted)
            Text(node.label).font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
            Spacer()
            Text(node.type.title).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
        }
        if let m = metrics?.node(node.id) {
            Grid(alignment: .leading, horizontalSpacing: PerpetoSpacing.x(4), verticalSpacing: PerpetoSpacing.x(2)) {
                GridRow { cell("Active", "\(m.active) of \(m.concurrency)"); cell("Queued", "\(m.queued)") }
                GridRow { cell("Wait avg", Format.duration(m.waitSec.avg)); cell("Wait p90", Format.duration(m.waitSec.p90)) }
                GridRow { cell("Service avg", Format.duration(m.serviceSec.avg)); cell("Throughput", Format.rate(m.throughputPerHour)) }
                GridRow { cell("Utilization", Format.percent(m.utilization)); cell("Failure rate", Format.percent(m.failureRate)) }
                GridRow { cell("Done", "\(m.done)"); cell("Tokens", Format.tokens(m.tokens)) }
            }
        }
        ForEach(metrics?.bottlenecks(for: node.id) ?? []) { b in
            BottleneckRow(bottleneck: b, label: node.label)
        }
        let here = items.filter { $0.nodeId == node.id && $0.status != .done }
        if !here.isEmpty {
            Rule()
            Text("Work here").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
            ForEach(here) { item in
                HStack(spacing: PerpetoSpacing.x(2)) {
                    StatusLabel(item.status.label).frame(width: 64, alignment: .leading)
                    Text(item.title).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    if item.iteration > 1 {
                        Text("it. \(item.iteration)").font(PerpetoFont.mono()).foregroundStyle(item.iteration >= 3 ? PerpetoColor.warning : PerpetoColor.muted)
                    }
                }
            }
        }
    }

    private func cell(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            Text(value).font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
        }
    }
}

struct BottleneckRow: View {
    var bottleneck: Bottleneck
    var label: String

    var body: some View {
        HStack(alignment: .top, spacing: PerpetoSpacing.x(2)) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundStyle(bottleneck.severity.tone == .neutral ? PerpetoColor.muted : bottleneck.severity.tone.color)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text("\(label): \(bottleneck.reason.title.lowercased())").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    StatusLabel(bottleneck.severity.title, tone: bottleneck.severity.tone)
                }
                Text(bottleneck.evidence).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct VelocityPanel: View {
    var metrics: MetricsSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Velocity", detail: "items done per day")
            VelocityChart(trend: metrics.run.velocity.trend).frame(height: 110)
            Grid(alignment: .leading, horizontalSpacing: PerpetoSpacing.x(4), verticalSpacing: PerpetoSpacing.x(2)) {
                GridRow {
                    Figure("Per day", value: String(format: "%.1f", metrics.run.velocity.itemsDonePerDay))
                    Figure("In progress", value: "\(metrics.run.wip)")
                }
                GridRow {
                    Figure("Cycle time", value: Format.duration(metrics.run.cycleTimeSec.avg), detail: "p90 " + Format.duration(metrics.run.cycleTimeSec.p90))
                    Figure("Tokens per item", value: Format.tokens(Int(metrics.run.tokensPerItem)))
                }
            }
        }
        .panel()
    }
}

/// Machines → agents → nodes for the run.
struct WhereRunningPanel: View {
    var store: FactoryStore
    var state: ProjectState
    var run: Run
    var metrics: MetricsSnapshot
    var graph: WorkflowGraph?

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle("Where work is running", detail: Format.plural(metrics.run.machines.count, "machine"))
            ForEach(Array(metrics.run.machines.enumerated()), id: \.element.id) { index, load in
                if index > 0 { Rule() }
                let machine = store.machine(load.machineId)
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    HStack(spacing: PerpetoSpacing.x(2)) {
                        Image(systemName: "desktopcomputer").foregroundStyle(PerpetoColor.muted).font(.system(size: 12))
                        Text(machine?.name ?? load.machineId).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                        if let machine { StatusLabel(machine.status.label) }
                        Spacer()
                        Text(Format.plural(load.activeAgents, "agent")).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                    }
                    if let machine {
                        Meter(Double(machine.running.agents) / Double(max(machine.capacity.maxAgents, 1)))
                        Text("\(machine.running.agents) of \(machine.capacity.maxAgents) agent slots, \(machine.running.jobs) of \(machine.capacity.maxJobs) CI slots")
                            .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                    ForEach(state.assignments.filter { $0.runId == run.id && $0.machineId == load.machineId && $0.isWorking }) { a in
                        HStack(spacing: PerpetoSpacing.x(2)) {
                            Rectangle().fill(PerpetoColor.border).frame(width: 8, height: 1)
                            Text(a.role).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.ink)
                            Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(PerpetoColor.muted)
                            Text(graph?.node(a.nodeId)?.label ?? a.nodeId).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink)
                            Spacer()
                        }
                    }
                    ForEach(store.factory.jobs.filter { $0.runId == run.id && $0.machineId == load.machineId && ($0.status == .running || $0.status == .leased) }) { job in
                        HStack(spacing: PerpetoSpacing.x(2)) {
                            Rectangle().fill(PerpetoColor.border).frame(width: 8, height: 1)
                            Text(job.id).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.ink)
                            Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(PerpetoColor.muted)
                            Text("CI at \(Format.shortSha(job.revision))").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink)
                            Spacer()
                        }
                    }
                }
            }
        }
        .panel()
    }
}

/// Interaction events for the run, filtered by the map selection.
struct InteractionFeed: View {
    var events: [HubEvent]
    var selection: GraphSelection?
    var graph: WorkflowGraph?

    private var filtered: [HubEvent] {
        switch selection {
        case .node(let id): events.filter { $0.nodeIds.contains(id) }
        case .edge(let id): events.filter { $0.edgeId == id }
        case nil: events
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle("Interactions", detail: filterDetail) {
                Text("\(filtered.count) events, \(filtered.filter(\.isUnplanned).count) unplanned")
                    .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
            }
            .padding(.bottom, PerpetoSpacing.x(2))
            Rule()
            if filtered.isEmpty {
                Text("No interactions recorded for this selection.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(filtered) { event in
                            EventRow(event: event, graph: graph).padding(.vertical, PerpetoSpacing.x(2))
                            Rule()
                        }
                    }
                }
            }
        }
        .panel()
    }

    private var filterDetail: String {
        switch selection {
        case .node(let id): "involving \(graph?.node(id)?.label ?? id)"
        case .edge(let id): "on edge \(id)"
        case nil: "all roles"
        }
    }
}
