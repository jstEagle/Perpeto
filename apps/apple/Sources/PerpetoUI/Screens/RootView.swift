import PerpetoKit
import SwiftUI

/// Main window: project-first sidebar, detail screen and a toolbar that
/// always shows the selected project's agent count and token usage.
public struct RootView: View {
    @Bindable var store: FactoryStore
    @Bindable var navigator: Navigator
    var openSettings: () -> Void

    @State private var expanded: Set<String> = []
    /// Set from the detail column's width, not the size class: an iPad in
    /// portrait with the sidebar open is as narrow as a large phone.
    @State private var narrowDetail = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact || narrowDetail }
    #else
    private var compact: Bool { narrowDetail }
    #endif

    /// Below this detail width, layouts stack instead of compressing. The
    /// Mac window's minimum keeps it above its threshold.
    #if os(iOS)
    nonisolated static let compactWidth: CGFloat = 900
    #else
    nonisolated static let compactWidth: CGFloat = 760
    #endif

    public init(store: FactoryStore, navigator: Navigator, openSettings: @escaping () -> Void) {
        self.store = store
        self.navigator = navigator
        self.openSettings = openSettings
    }

    public var body: some View {
        NavigationSplitView(columnVisibility: $navigator.columnVisibility) {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 300)
        } detail: {
            VStack(spacing: 0) {
                if let error = store.lastError {
                    ErrorBanner(error) { store.lastError = nil }
                }
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .canvasBackground()
            .onGeometryChange(for: Bool.self) { $0.size.width < Self.compactWidth } action: { narrowDetail = $0 }
            .environment(\.compactLayout, compact)
            .toolbar { toolbar }
            .navigationTitle(navigator.route?.title ?? "perpeto")
            #if os(macOS)
            .navigationSubtitle(subtitle)
            #else
            // Screens carry their own titles; the bar keeps the vitals.
            .toolbarTitleDisplayMode(.inline)
            #endif
        }
        .tint(PerpetoColor.action)
        .task {
            if store.factory.projects.isEmpty { await store.refresh() }
            if navigator.route == nil, let first = store.factory.projects.first {
                navigator.route = .project(first.id, .overview)
            }
            if let id = navigator.projectId { expanded.insert(id) }
        }
        .onChange(of: navigator.route) { _, route in
            if let id = route?.projectId { expanded.insert(id) }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let id = navigator.projectId, let project = store.project(id) { parts.append(project.name) }
        if store.isDemo { parts.append("Demo data") }
        return parts.joined(separator: " · ")
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $navigator.route) {
            Section("Projects") {
                ForEach(store.factory.projects) { project in
                    DisclosureGroup(isExpanded: binding(for: project.id)) {
                        ForEach(ProjectSection.allCases) { section in
                            SidebarLabel(title: section.title, systemImage: section.systemImage)
                                .badge(badge(section, project: project.id))
                                .tag(Route.project(project.id, section))
                        }
                    } label: {
                        ProjectRow(project: project, agents: store.state(project.id).activeAgents)
                    }
                }
            }
            Section("Factory") {
                ForEach(FactorySection.allCases) { section in
                    SidebarLabel(title: section.title, systemImage: section.systemImage)
                        .tag(Route.factory(section))
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                PerpetoLockup(height: 22)
                Spacer()
            }
            .padding(.horizontal, PerpetoSpacing.x(4))
            .padding(.top, PerpetoSpacing.x(1))
            .padding(.bottom, PerpetoSpacing.x(3))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConnectionFooter(isDemo: store.isDemo, lastUpdated: store.lastUpdated, openSettings: openSettings)
        }
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(get: { expanded.contains(id) }, set: { open in
            if open { expanded.insert(id) } else { expanded.remove(id) }
        })
    }

    private func badge(_ section: ProjectSection, project: String) -> Text? {
        let state = store.state(project)
        switch section {
        case .workflows:
            let drafts = state.workflows.filter { state.pendingDraft(of: $0.id) != nil }.count
            return drafts > 0 ? Text("\(drafts) draft") : nil
        case .runs:
            let running = state.runs.filter { $0.status == .running }.count
            return running > 0 ? Text("\(running)") : nil
        case .mergeQueue:
            let waiting = state.mergeQueue.filter { $0.status == .queued || $0.status == .testing }.count
            return waiting > 0 ? Text("\(waiting)") : nil
        default: return nil
        }
    }

    // MARK: Detail

    @ViewBuilder
    private var detail: some View {
        switch navigator.route {
        case .project(let id, let section):
            if let project = store.project(id) {
                ProjectScreen(store: store, navigator: navigator, project: project, section: section)
            } else {
                EmptyState("Project not found", message: "It may have been removed from the hub. Choose another project in the sidebar.")
            }
        case .factory(.machines): MachinesScreen(store: store)
        case .factory(.accounts): AccountsScreen(store: store)
        case .factory(.usage): UsageScreen(store: store)
        case nil:
            if store.isLoading {
                VStack(spacing: PerpetoSpacing.x(3)) {
                    SpindleLoader(size: 28)
                    Text("Loading factory state").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                EmptyState("Create a project", message: "Add a repository with its docs and goals to start planning work.")
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        #if os(macOS)
        ToolbarItem(placement: .navigation) {
            if let id = navigator.projectId {
                ProjectVitals(state: store.state(id))
            }
        }
        #else
        ToolbarItem(placement: .principal) {
            if let id = navigator.projectId {
                ProjectVitals(state: store.state(id), compact: compact)
            } else {
                Text(navigator.route?.title ?? "perpeto").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
            }
        }
        #endif
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .help("Refresh factory state (⌘R)")
            .disabled(store.isLoading)
        }
    }
}

/// Active agents and tokens today for the selected project.
struct ProjectVitals: View {
    var state: ProjectState
    /// Shorter labels for the iPhone navigation bar.
    var compact = false

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(compact ? 3 : 4)) {
            vital(systemImage: "person.2", value: "\(state.activeAgents)", label: compact ? "working" : state.activeAgents == 1 ? "agent working" : "agents working")
            vital(systemImage: "number", value: Format.tokens(state.usage.today), label: compact ? "today" : "tokens today")
        }
        .padding(.horizontal, PerpetoSpacing.x(2))
        .accessibilityElement(children: .combine)
    }

    private func vital(systemImage: String, value: String, label: String) -> some View {
        HStack(spacing: PerpetoSpacing.x(1.5)) {
            Image(systemName: systemImage).font(.system(size: 11)).foregroundStyle(PerpetoColor.muted)
            Text(value).font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                .contentTransition(.numericText())
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
        }
        .fixedSize()
    }
}

struct ProjectRow: View {
    var project: Project
    var agents: Int

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            Image(systemName: "folder").foregroundStyle(PerpetoColor.muted)
            Text(project.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
            Spacer(minLength: 0)
            if agents > 0 {
                Text("\(agents)")
                    .font(PerpetoFont.caption.monospacedDigit())
                    .foregroundStyle(PerpetoColor.action)
                    .help(Format.plural(agents, "agent") + " working")
            }
        }
    }
}

/// Calm indicator of where data comes from.
struct ConnectionFooter: View {
    var isDemo: Bool
    var lastUpdated: Date?
    var openSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            Rule()
            HStack(alignment: .top, spacing: PerpetoSpacing.x(2)) {
                Circle()
                    .fill(isDemo ? PerpetoColor.controlBorder : PerpetoColor.success)
                    .frame(width: 6, height: 6)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(isDemo ? "Demo data" : "Connected to hub")
                        .font(PerpetoFont.captionMedium)
                        .foregroundStyle(PerpetoColor.ink)
                    Text(isDemo ? "No hub is configured. Changes stay on \(Platform.device)." : lastUpdated.map { "Updated " + Format.relative($0) } ?? "Waiting for first update")
                        .font(PerpetoFont.caption)
                        .foregroundStyle(PerpetoColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if isDemo {
                        Button("Connect a hub", action: openSettings)
                            .buttonStyle(.plain)
                            .font(PerpetoFont.caption)
                            .foregroundStyle(PerpetoColor.action)
                    }
                }
            }
            .padding(.horizontal, PerpetoSpacing.x(4))
            .padding(.vertical, PerpetoSpacing.x(2))
        }
    }
}

/// Routes a project section to its screen.
struct ProjectScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    var project: Project
    var section: ProjectSection

    var body: some View {
        let state = store.state(project.id)
        switch section {
        case .overview: OverviewScreen(store: store, navigator: navigator, project: project, state: state)
        case .workflows: WorkflowsScreen(store: store, navigator: navigator, project: project, state: state)
        case .runs: RunsScreen(store: store, navigator: navigator, project: project, state: state)
        case .work: WorkScreen(store: store, project: project, state: state)
        case .messages: MessagesScreen(store: store, project: project, state: state)
        case .mergeQueue: MergeQueueScreen(store: store, project: project, state: state)
        }
    }
}

/// Sidebar row with a monochrome muted symbol instead of the tinted default.
struct SidebarLabel: View {
    var title: String
    var systemImage: String

    var body: some View {
        Label {
            Text(title).foregroundStyle(PerpetoColor.ink)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(PerpetoColor.muted)
        }
    }
}
