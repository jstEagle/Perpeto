import PerpetoKit
import SwiftUI

/// Runs: the list, or one run's live map.
struct RunsScreen: View {
    var store: FactoryStore
    @Bindable var navigator: Navigator
    var project: Project
    var state: ProjectState

    @State private var selection: GraphSelection?

    private var run: Run? { state.runs.first { $0.id == navigator.selectedRunId } }

    var body: some View {
        Group {
            if let run {
                RunDetail(store: store, navigator: navigator, project: project, state: state, run: run, selection: $selection)
                    .id(run.id)
            } else if state.runs.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                        ScreenHeader("Runs")
                        EmptyState("No runs yet", message: "Activate a workflow, then start a run to see work move through it.", systemImage: "play.circle") {
                            Button("Open workflows") { navigator.route = .project(project.id, .workflows) }.buttonStyle(.perpetoPrimary)
                        }
                        .card()
                    }
                    .screenPadding()
                }
            } else {
                RunsList(state: state, store: store) { navigator.selectedRunId = $0.id }
            }
        }
        .onChange(of: navigator.selectedRunId) { _, _ in selection = nil }
        .onChange(of: navigator.selectedNodeId, initial: true) { _, id in
            if let id { selection = .node(id) }
        }
    }
}

/// Runs newest first. Tapping one opens its live map.
struct RunsList: View {
    var state: ProjectState
    var store: FactoryStore
    var open: (Run) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Runs", subtitle: "Each run follows the workflow version that was active when it started.")
                    .padding(.bottom, PerpetoSpacing.x(2))
                RowList(state.runs) { run in
                    Button { open(run) } label: { row(run) }.buttonStyle(.plain)
                }
                .card()
            }
            .screenPadding()
        }
    }

    private func row(_ run: Run) -> some View {
        let name = state.workflows.first { $0.id == run.workflowId }?.name ?? "Workflow"
        let active = state.assignments.filter { $0.runId == run.id && $0.isWorking }.count
        return HStack(spacing: PerpetoSpacing.x(4)) {
            IconTile(ProjectSection.runs.systemImage)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text("\(name) run").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    Tag("v\(run.workflowVersion)")
                }
                HStack(spacing: 5) {
                    Mono(run.id)
                    Text("· " + RunMeta.times(run) + (active > 0 ? " · \(Format.plural(active, "agent")) working" : ""))
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                }
            }
            Spacer(minLength: PerpetoSpacing.x(2))
            StatusLabel(run.isBudgetHeld ? ("Intake paused", .paused) : run.status.label)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .medium)).foregroundStyle(PerpetoColor.faint)
        }
        .contentShape(Rectangle())
    }
}

struct RunDetail: View {
    var store: FactoryStore
    var navigator: Navigator
    var project: Project
    var state: ProjectState
    var run: Run
    @Binding var selection: GraphSelection?

    enum Tab: Hashable { case map, work, timeline }
    @State private var tab: Tab = .map
    @State private var confirmStop = false
    @State private var moreIssues = false
    @State private var showAllActivity = false
    @State private var nodeDetails = false
    /// Bumped by "Show on map" to pan to and highlight a step.
    @State private var focusToken = 0
    @State private var focusNodeId: String?
    @State private var mapWidth: CGFloat = 960
    @State private var editingSettings = false
    @Environment(\.readOnlySettings) private var readOnly
    @Environment(\.compactLayout) private var compact

    private var workflow: Workflow? {
        state.version(run.workflowVersion, of: run.workflowId) ?? state.workflows.first { $0.id == run.workflowId }
    }

    private var metrics: MetricsSnapshot? { state.runMetrics[run.id] }
    private var runEvents: [HubEvent] { state.events.filter { $0.runId == run.id && $0.interaction != .unknown } }
    private var runItems: [WorkItem] { state.workItems.filter { $0.runId == run.id } }
    private var bottlenecks: [Bottleneck] {
        (metrics?.bottlenecks ?? []).filter { $0.severity != .info }.sorted { $0.severity.rank > $1.severity.rank }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                header.padding(.bottom, PerpetoSpacing.x(compact ? 0 : 2))
                intakeCard
                if let top = bottlenecks.first { attentionCard(top) }
                switcher
                switch tab {
                case .map: mapSection
                case .work: workList
                case .timeline: ActivityCard(events: runEvents, graph: workflow?.graph, messages: state.messagesById, machines: store.machineNames, limit: nil, showAll: .constant(true))
                }
            }
            .screenPadding()
        }
        .onChange(of: navigator.runSettingsRequest) { _, _ in if !readOnly { editingSettings = true } }
        .sheet(isPresented: $editingSettings) {
            RunSettingsSheet(title: "Run settings", confirm: "Save settings", settings: run.settings) { settings in
                Task { await store.updateRun(run, settings: settings) }
            }
        }
        .confirmationDialog("Stop this run?", isPresented: $confirmStop) {
            Button("Stop run", role: .destructive) { Task { await store.control(run, .stop) } }
        } message: {
            Text("Agents finish their current turn and no new work starts. Stopped runs cannot be resumed.")
        }
        .sheet(isPresented: Binding(get: { compact && selection != nil }, set: { if !$0 { selection = nil } })) {
            ScrollView {
                SelectionCard(state: state, run: run, graph: workflow?.graph, metrics: metrics, selection: selection, items: runItems, close: { selection = nil })
                    .padding(PerpetoSpacing.x(4))
            }
            .background(PerpetoColor.canvas)
            .presentationDetents([.medium, .large])
            .presentationBackgroundInteraction(.enabled(upThrough: .medium))
            .presentationCornerRadius(PerpetoRadius.sheet)
        }
    }

    // MARK: Header

    private var header: some View {
        ScreenHeader(
            "\(workflow?.name ?? "Workflow") run",
            back: ("Runs", { navigator.selectedRunId = nil }),
            status: run.isBudgetHeld ? ("Running, intake paused", .paused) : run.status.label,
            meta: { RunMeta(run: run) }
        ) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                if !readOnly, run.status == .running || run.status == .paused {
                    Button { editingSettings = true } label: { Label("Settings", systemImage: "slider.horizontal.3") }
                        .buttonStyle(.perpetoSecondary)
                }
                controls
            }
            .fullWidthButtons(compact)
        }
    }

    /// Keep running, intake source and budget, with today's use.
    @ViewBuilder
    private var intakeCard: some View {
        let hasBudget = !(run.settings.budget?.isEmpty ?? true)
        if run.settings.keepOpen || run.settings.source != nil || hasBudget {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                if run.isBudgetHeld { BudgetHoldNote(run: run) }
                let summary = VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    Text("Intake and budget").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                    RunSettingsSummary(settings: run.settings)
                }
                if compact || !hasBudget {
                    summary
                    if hasBudget { BudgetLine(run: run) }
                } else {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(10)) {
                        summary.frame(maxWidth: .infinity, alignment: .leading)
                        BudgetLine(run: run).frame(width: 360)
                    }
                }
            }
            .card()
        }
    }

    @ViewBuilder
    private var controls: some View {
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

    // MARK: Attention

    private func attentionCard(_ top: Bottleneck) -> some View {
        let label = workflow?.graph.node(top.nodeId)?.label ?? top.nodeId
        let draft = state.pendingDraft(of: run.workflowId)
        let actions = HStack(spacing: PerpetoSpacing.x(2)) {
            Button("Show on map") { showOnMap(top.nodeId) }
            .buttonStyle(.perpetoGhost)
            if let draft {
                Button("Review proposal") {
                    navigator.selectedWorkflowId = draft.id
                    navigator.route = .project(project.id, .workflows)
                }
                .buttonStyle(.perpetoPrimary)
                .controlSize(.small)
            }
        }
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                StatusIcon(.warning, size: 20).padding(.top, 1)
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    Text("\(label) is \(top.reason.title.lowercased())").font(PerpetoType.text(PerpetoType.text16, weight: .medium)).foregroundStyle(PerpetoColor.ink)
                    Text(top.evidence).perpetoBody(PerpetoType.text14, color: PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: PerpetoLayout.readingMax, alignment: .leading)
                    if compact { actions.padding(.top, PerpetoSpacing.x(2)) }
                }
                if !compact {
                    Spacer(minLength: PerpetoSpacing.x(4))
                    actions
                }
            }
            if bottlenecks.count > 1 {
                Disclosure(Format.plural(bottlenecks.count - 1, "more issue"), isExpanded: $moreIssues) {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                        ForEach(bottlenecks.dropFirst()) { b in
                            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                                Text("\(workflow?.graph.node(b.nodeId)?.label ?? b.nodeId) is \(b.reason.title.lowercased())")
                                    .font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                                Text(b.evidence).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(.leading, PerpetoSpacing.x(9))
            }
        }
        .card()
    }

    // MARK: Switcher

    private var switcher: some View {
        let tabs = PillPicker([(value: Tab.map, title: "Live map", count: nil), (value: .work, title: "Work", count: runItems.count), (value: .timeline, title: "Timeline", count: nil)], selection: $tab)
        let window = PillPicker(MetricsWindow.allCases.map { ($0, $0.shortTitle) },
                                selection: Binding(get: { store.metricsWindow }, set: setWindow))
        return Group {
            if compact {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) { tabs; window }
            } else {
                HStack {
                    tabs
                    Spacer()
                    window.help("Measurement window for the map, velocity and bottlenecks")
                }
            }
        }
    }

    /// Pans the map to the step and selects it, which highlights it.
    private func showOnMap(_ nodeId: String) {
        tab = .map
        focusNodeId = nodeId
        withAnimation(PerpetoMotion.easeOut()) { selection = .node(nodeId) }
        focusToken += 1
    }

    private func setWindow(_ window: MetricsWindow) {
        Task { await store.setMetricsWindow(window) }
    }

    // MARK: Map

    @ViewBuilder
    private var mapSection: some View {
        if let workflow {
            let mode: GraphMode = metrics.map { .live(LiveOverlay(metrics: $0, workItems: runItems, events: runEvents)) } ?? .view
            if compact {
                StepList(graph: workflow.graph, live: metrics.map { LiveOverlay(metrics: $0, workItems: runItems, events: runEvents) }, selection: $selection)
            } else {
                GraphViewport(graph: workflow.graph, mode: mode, selection: $selection, initialRoleScope: .selected,
                              fitWithCompactCards: true, focusNodeId: focusNodeId ?? selection?.nodeId ?? bottlenecks.first?.nodeId, focusToken: focusToken)
                    .frame(height: GraphViewport.idealHeight(graph: workflow.graph, mode: mode, width: mapWidth, compactCards: true))
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { mapWidth = $0 }
                    .overlay(alignment: .top) {
                        if metrics == nil {
                            Text(run.status == .running ? "Waiting for the first measurements from the hub." : "This run has ended. Live measurements are kept only while a run is active.")
                                .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                .padding(.horizontal, PerpetoSpacing.x(4)).frame(height: 32)
                                .background(Capsule().fill(PerpetoColor.surface)).pillElevation(.card, height: 32)
                                .padding(PerpetoSpacing.x(4))
                        }
                    }
                if selection != nil {
                    SelectionCard(state: state, run: run, graph: workflow.graph, metrics: metrics, selection: selection, items: runItems, close: { selection = nil })
                        .transition(.opacity)
                }
            }
        }
        AdaptiveColumns(sideWidth: 380) {
            ActivityCard(events: runEvents, graph: workflow?.graph, messages: state.messagesById, machines: store.machineNames, limit: 5, showAll: $showAllActivity)
        } side: {
            if let metrics {
                VelocityCard(metrics: metrics, window: store.metricsWindow)
                WhereRunningCard(store: store, metrics: metrics, graph: workflow?.graph)
            }
        }
        if let metrics, let graph = workflow?.graph {
            Disclosure("Node details", isExpanded: $nodeDetails) {
                NodeTable(graph: graph, metrics: metrics) { selection = .node($0) }
            }
            .card()
        }
    }

    // MARK: Work

    private var workList: some View {
        Group {
            if runItems.isEmpty {
                EmptyState("No work yet", message: "Work items appear when the planner splits this run's input.", systemImage: "checklist")
            } else {
                RowList(runItems) { item in
                    HStack(spacing: PerpetoSpacing.x(3)) {
                        RowText(item.title, meta: "\(workflow?.graph.node(item.nodeId)?.label ?? item.nodeId)" + (item.iteration > 1 ? " · round \(item.iteration)" : "") + (item.prUrl.map { " · \(Format.prNumber($0))" } ?? ""))
                        Spacer(minLength: PerpetoSpacing.x(2))
                        StatusLabel(item.statusLabel)
                    }
                }
            }
        }
        .card()
    }
}

extension MetricsWindow {
    /// "1 h", "24 h", "7 d" for the window picker.
    var shortTitle: String {
        switch self {
        case .hour: "1 h"
        case .day: "24 h"
        case .week: "7 d"
        }
    }

    var startLabel: String {
        switch self {
        case .hour: "1 h ago"
        case .day: "24 h ago"
        case .week: "7 d ago"
        }
    }

    var metaTitle: String {
        switch self {
        case .hour: "Last hour"
        case .day: "Last 24 h"
        case .week: "Last 7 days"
        }
    }
}

// MARK: Cards

/// The latest events, a line of meta each; the rest on demand.
struct ActivityCard: View {
    var events: [HubEvent]
    var graph: WorkflowGraph?
    var messages: [String: Message]
    var machines: [String: String]
    var limit: Int?
    @Binding var showAll: Bool

    var body: some View {
        let shown = (limit == nil || showAll) ? events : Array(events.prefix(limit ?? 5))
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Activity", detail: Format.plural(events.count, "event"))
            if events.isEmpty {
                Text("No interactions recorded yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            } else {
                RowList(shown) { event in
                    EventRow(event: event, graph: graph, messages: messages, machines: machines)
                }
                if let limit, events.count > limit {
                    Button(showAll ? "Show fewer" : "Show all \(events.count)") { showAll.toggle() }
                        .buttonStyle(.plain)
                        .font(PerpetoFont.captionMedium)
                        .foregroundStyle(PerpetoColor.inkSoft)
                        .padding(.top, PerpetoSpacing.x(2))
                }
            }
        }
        .card()
    }
}

/// One event: time, what happened, and one line of meta.
struct EventRow: View {
    var event: HubEvent
    var graph: WorkflowGraph?
    var messages: [String: Message] = [:]
    var machines: [String: String] = [:]

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(5)) {
            Text(event.at.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                .frame(width: 40, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                if let meta { Text(meta).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2) }
            }
            Spacer(minLength: 0)
            if let result = event.data["result"]?.stringValue, ["fail", "failed", "error"].contains(result) {
                StatusLabel("Failed", tone: .error)
            }
        }
    }

    private func label(_ id: String?) -> String? { id.map { graph?.node($0)?.label ?? $0 } }

    private var route: String? {
        guard let from = label(event.sourceNodeId), let to = label(event.targetNodeId) else { return nil }
        return "\(from) to \(to)"
    }

    private var title: String {
        if let summary = event.data["summary"]?.stringValue { return summary }
        if let id = event.data["messageId"]?.stringValue, let message = messages[id] { return message.body }
        switch event.interaction {
        case .agentMessaged:
            let sender = event.data["senderRoleId"]?.stringValue ?? event.data["role"]?.stringValue ?? label(event.sourceNodeId) ?? "An agent"
            return "\(sender.capitalizedFirst) messaged \(event.data["recipientRoleId"]?.stringValue ?? label(event.targetNodeId) ?? "a role")"
        case .agentDelegated: return "\((event.data["role"]?.stringValue ?? label(event.sourceNodeId) ?? "An agent").capitalizedFirst) delegated to \(label(event.targetNodeId) ?? "a role")"
        case .workitemMoved: return "Work moved \(route.map { "from " + $0.replacingOccurrences(of: " to ", with: " to ") } ?? "on")"
        case .gateResult:
            let result = event.data["result"]?.stringValue ?? "done"
            return "\(label(event.data["nodeId"]?.stringValue) ?? "A gate") \(["pass", "passed"].contains(result) ? "passed" : result == "blocked" ? "is waiting for a person" : "failed")"
        case .assignmentState:
            let who = (event.data["role"]?.stringValue ?? label(event.data["nodeId"]?.stringValue) ?? "An agent").capitalizedFirst
            let state = event.data["state"]?.stringValue ?? "updated"
            return "\(who) \(state == "running" ? "started" : state)" + (event.data["machineId"]?.stringValue.map { " on \(machines[$0] ?? $0)" } ?? "")
        case .unknown: return event.type
        }
    }

    private var meta: String? {
        var parts: [String] = []
        if event.isUnplanned { parts.append(event.interaction == .agentDelegated ? "Unplanned delegation" : "Unplanned message") }
        if let route, event.interaction != .assignmentState { parts.append(route) } else if let node = label(event.data["nodeId"]?.stringValue) { parts.append(node) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// Two numbers and the trend bars.
struct VelocityCard: View {
    var metrics: MetricsSnapshot
    var window: MetricsWindow

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            SectionTitle("Velocity", detail: window.metaTitle)
            FigureStrip([
                Figure("Items done per day", value: String(format: "%.1f", metrics.run.velocity.itemsDonePerDay)),
                Figure.duration("Cycle time", seconds: metrics.run.cycleTimeSec.avg),
            ])
            if metrics.run.velocity.trend.allSatisfy({ $0 == 0 }) {
                Text("No items finished in this window.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            } else {
                TrendBars(metrics.run.velocity.trend, start: window.startLabel).frame(height: 104)
            }
        }
        .card()
    }
}

/// Machine rows with slot meters.
struct WhereRunningCard: View {
    var store: FactoryStore
    var metrics: MetricsSnapshot
    var graph: WorkflowGraph?

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Where work is running")
            let loads = metrics.run.machines
            if loads.isEmpty {
                Text("No machine holds work for this run right now.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            } else {
                RowList(loads) { load in
                    let machine = store.machine(load.machineId)
                    let capacity = machine?.capacity.maxAgents ?? max(load.activeAgents, 1)
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                        HStack {
                            Mono(machine?.name ?? load.machineId, color: PerpetoColor.ink, size: PerpetoType.text14)
                            Spacer()
                            Text("\(load.activeAgents) of \(capacity) slots").font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                        }
                        Meter(Double(load.activeAgents) / Double(capacity))
                        Text(load.nodes.map { graph?.node($0)?.label ?? $0 }.joined(separator: ", "))
                            .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                }
            }
        }
        .card()
    }
}

/// The selected node or edge: three numbers, the rest on demand, and the
/// work currently there.
struct SelectionCard: View {
    var state: ProjectState
    var run: Run
    var graph: WorkflowGraph?
    var metrics: MetricsSnapshot?
    var selection: GraphSelection?
    var items: [WorkItem]
    var close: () -> Void
    @State private var more = false

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            if let id = selection?.nodeId, let node = graph?.node(id) {
                head(node.label, meta: node.harness.map { "\(node.type.title) · \(Format.model($0.model))" } ?? node.type.title, icon: node.type.systemImage)
                if let m = metrics?.node(id) {
                    FigureStrip([
                        Figure("Active", value: m.concurrency.map { "\(m.active) of \($0)" } ?? "\(m.active)", size: PerpetoType.text24),
                        Figure("Queued", value: "\(m.queued)", size: PerpetoType.text24),
                        Figure("Wait, p90", value: Format.duration(m.waitSec.p90), size: PerpetoType.text24),
                    ])
                    Disclosure("More metrics", isExpanded: $more) {
                        FigureStrip([
                            Figure("Service time", value: Format.duration(m.serviceSec.avg), size: PerpetoType.text20),
                            Figure("Throughput", value: Format.rate(m.throughputPerHour), size: PerpetoType.text20),
                            Figure("Failure rate", value: m.failureRate.map(Format.percent) ?? "n/a", size: PerpetoType.text20),
                        ])
                    }
                }
                ForEach(metrics?.bottlenecks(for: id) ?? []) { b in
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(3)) {
                        StatusIcon(b.severity.tone)
                        Text(b.evidence).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
                let here = items.filter { $0.nodeId == id && $0.status != .done }
                if !here.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Work here").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                        RowList(here) { item in
                            HStack {
                                Text(item.title).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                                Spacer()
                                if item.iteration > 1 { Text("round \(item.iteration)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                                StatusLabel(item.statusLabel)
                            }
                        }
                    }
                }
            } else if let id = selection?.edgeId, let graph, let edge = graph.edges.first(where: { $0.id == id }) {
                let name = { (n: String) in graph.node(n)?.label ?? n }
                head("\(name(edge.from.node)) to \(name(edge.to.node))", meta: EdgeStyle.meaning(edge.kind), icon: "arrow.right")
                FigureStrip([Figure(edge.kind == .flow ? "Items moved" : "Interactions", value: "\(metrics?.edge(id)?.count ?? 0)", size: PerpetoType.text24)])
            }
        }
        .card()
    }

    private func head(_ title: String, meta: String, icon: String) -> some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            IconTile(icon)
            RowText(title, meta: meta)
            Spacer()
            IconButton("xmark", label: "Close details", action: close)
        }
    }
}

/// Every step's numbers, behind "Node details".
struct NodeTable: View {
    var graph: WorkflowGraph
    var metrics: MetricsSnapshot
    var select: (String) -> Void

    var body: some View {
        let rows = graph.flowOrder.filter { metrics.node($0.id) != nil }
        Grid(alignment: .leading, horizontalSpacing: PerpetoSpacing.x(6), verticalSpacing: PerpetoSpacing.x(3)) {
            GridRow {
                ForEach(["Step", "Active", "Queued", "Wait, p90", "Throughput", "Failure rate"], id: \.self) { title in
                    Text(title).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        .gridColumnAlignment(title == "Step" ? .leading : .trailing)
                }
            }
            ForEach(rows) { node in
                let m = metrics.node(node.id)!
                Divider().overlay(PerpetoColor.border).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    Button(node.label) { select(node.id) }.buttonStyle(.plain).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    Text(m.concurrency.map { "\(m.active) of \($0)" } ?? "\(m.active)")
                    Text("\(m.queued)")
                    Text(Format.duration(m.waitSec.p90))
                    Text(Format.rate(m.throughputPerHour))
                    Text(m.failureRate.map(Format.percent) ?? "n/a")
                }
                .font(PerpetoFont.body.monospacedDigit())
                .foregroundStyle(PerpetoColor.ink)
            }
        }
    }
}
