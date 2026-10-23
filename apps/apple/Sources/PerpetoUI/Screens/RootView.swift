import PerpetoKit
import SwiftUI

/// The app shell. Mac and iPad: a split view with the Mono sidebar on the
/// canvas and an untitled toolbar; the page title lives in the content.
/// iPhone: five tabs (Overview, Runs, Work, Messages, More).
public struct RootView: View {
    @Bindable var store: FactoryStore
    @Bindable var navigator: Navigator
    var openSettings: () -> Void

    /// Set from the detail column's width: an iPad in portrait with the
    /// sidebar open is as narrow as a large phone.
    @State private var narrowDetail = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    /// Below this detail width, layouts stack instead of compressing.
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
        Group {
            #if os(iOS)
            if sizeClass == .compact {
                PhoneTabs(store: store, navigator: navigator, openSettings: openSettings)
            } else {
                split
            }
            #else
            split
            #endif
        }
        .tint(PerpetoColor.ink)
        // Switching between a hub with projects and one without (or between
        // demo factories) moves off screens that no longer exist.
        .onChange(of: store.isObserveOnly) { _, observing in
            if observing, navigator.route?.projectId != nil || navigator.route == nil {
                navigator.route = .factory(.home)
            } else if !observing, navigator.route == .factory(.home) || navigator.route == nil, let first = store.factory.projects.first {
                navigator.route = .project(first.id, .overview)
            }
        }
        .task {
            if store.factory.projects.isEmpty { await store.refresh() }
            if navigator.route == nil {
                if let first = store.factory.projects.first {
                    navigator.route = .project(first.id, .overview)
                } else if store.isObserveOnly {
                    navigator.route = .factory(.home)
                }
            }
        }
    }

    private var split: some View {
        NavigationSplitView(columnVisibility: $navigator.columnVisibility) {
            Sidebar(store: store, navigator: navigator, openSettings: openSettings)
                .navigationSplitViewColumnWidth(min: 232, ideal: PerpetoLayout.sidebarWidth, max: 300)
        } detail: {
            DetailView(store: store, navigator: navigator)
                .onGeometryChange(for: Bool.self) { $0.size.width < Self.compactWidth } action: { narrowDetail = $0 }
                .environment(\.compactLayout, narrowDetail)
                #if os(macOS)
                .toolbar(removing: .title)
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                #else
                .toolbarBackground(.hidden, for: .navigationBar)
                #endif
        }
    }
}

/// The selected screen, with errors floating above it.
struct DetailView: View {
    var store: FactoryStore
    var navigator: Navigator

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .canvasBackground()
            .overlay(alignment: .top) {
                if let error = store.lastError {
                    ErrorBanner(error) { store.lastError = nil }
                        .frame(maxWidth: PerpetoLayout.readingMax)
                        .padding(PerpetoSpacing.x(4))
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch navigator.route {
        case .project(let id, let section):
            if let project = store.project(id) {
                ProjectScreen(store: store, navigator: navigator, project: project, section: section)
            } else {
                EmptyState("Project not found", message: "It may have been removed from the hub. Choose another project.", systemImage: "folder")
            }
        case .factory(let section): FactoryScreen(store: store, navigator: navigator, section: section)
        case nil:
            if store.isLoading {
                VStack(spacing: PerpetoSpacing.x(4)) {
                    SpindleLoader(size: 32)
                    Text("Loading factory state").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .combine)
            } else {
                EmptyState("Create a project", message: "Add a repository with its docs and goals to start planning work.", systemImage: "folder.badge.plus")
            }
        }
    }
}

// MARK: Sidebar

struct Sidebar: View {
    var store: FactoryStore
    @Bindable var navigator: Navigator
    var openSettings: () -> Void

    private var projectId: String? { navigator.projectId ?? store.factory.projects.first?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PerpetoLockup(height: 22)
                .padding(.horizontal, PerpetoSpacing.x(3))
                .padding(.top, PerpetoSpacing.x(4))
                .padding(.bottom, PerpetoSpacing.x(8))
                .accessibilityLabel("perpeto")
            ScrollView {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                    if store.isObserveOnly {
                        NavItem(title: FactorySection.home.title, systemImage: FactorySection.home.systemImage,
                                selected: navigator.route == .factory(.home), trailing: nil) {
                            navigator.route = .factory(.home)
                        }
                    } else if let projectId, let project = store.project(projectId) {
                        ProjectSwitcher(store: store, navigator: navigator, current: project)
                            .padding(.bottom, PerpetoSpacing.x(6))
                        ForEach(ProjectSection.allCases) { section in
                            NavItem(title: section.title, systemImage: section.systemImage,
                                    selected: navigator.route == .project(projectId, section),
                                    trailing: trailing(section, project: projectId)) {
                                if section == .runs { navigator.selectedRunId = nil }
                                navigator.route = .project(projectId, section)
                            }
                        }
                    }
                    Text("Factory").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        .padding(.horizontal, PerpetoSpacing.x(3))
                        .padding(.top, PerpetoSpacing.x(6))
                        .padding(.bottom, PerpetoSpacing.x(2))
                    ForEach(FactorySection.grouped) { section in
                        NavItem(title: section.title, systemImage: section.systemImage, selected: navigator.route == .factory(section),
                                trailing: section == .sessions ? sessionsTrailing : nil) {
                            navigator.route = .factory(section)
                        }
                    }
                }
            }
            .scrollIndicators(.never)
            AccountRow(store: store, openSettings: openSettings)
                .padding(.top, PerpetoSpacing.x(3))
        }
        .padding(.horizontal, PerpetoSpacing.x(4))
        .padding(.bottom, PerpetoSpacing.x(5))
        .frame(maxHeight: .infinity, alignment: .top)
        .background(PerpetoColor.canvas)
        #if os(macOS)
        .toolbar(removing: .sidebarToggle)
        #else
        .toolbar(.hidden, for: .navigationBar)
        #endif
    }

    /// Sessions waiting for the owner are counted; otherwise the live dot shows while any run.
    private var sessionsTrailing: NavItem.Trailing? {
        guard let observed = store.factory.sessions else { return nil }
        if observed.waiting > 0 { return .count(observed.waiting) }
        return observed.running > 0 ? .live : nil
    }

    private func trailing(_ section: ProjectSection, project: String) -> NavItem.Trailing? {
        let state = store.state(project)
        switch section {
        case .runs: return state.runs.contains { $0.status == .running } ? .live : nil
        case .work:
            let open = state.workItems.filter { $0.status != .done && $0.status != .failed }.count
            return open > 0 ? .count(open) : nil
        case .mergeQueue:
            let open = state.mergeQueue.filter { $0.status == .queued || $0.status == .testing || $0.status == .merging }.count
            return open > 0 ? .count(open) : nil
        case .messages:
            return state.unreadTotal > 0 ? .count(state.unreadTotal) : nil
        case .workflows:
            let drafts = state.workflows.filter { state.pendingDraft(of: $0.id) != nil }.count
            return drafts > 0 ? .count(drafts) : nil
        default: return nil
        }
    }
}

/// A sidebar item: 38 tall, 12 pt corners. The current item is a white
/// surface with card elevation and an ink label.
struct NavItem: View {
    enum Trailing: Equatable { case count(Int), live }

    var title: String
    var systemImage: String
    var selected: Bool
    var trailing: Trailing?
    var action: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(selected ? PerpetoColor.ink : PerpetoColor.muted)
                    .frame(width: 20)
                Text(title)
                    .font(PerpetoType.text(PerpetoType.text14, weight: selected ? .medium : .regular))
                    .foregroundStyle(selected ? PerpetoColor.ink : PerpetoColor.inkSoft)
                Spacer(minLength: 0)
                switch trailing {
                case .live: LiveDot(size: 6)
                case .count(let n): Text("\(n)").font(PerpetoFont.small.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                case nil: EmptyView()
                }
            }
            .padding(.horizontal, PerpetoSpacing.x(3))
            .frame(height: 38)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous).fill(PerpetoColor.surface)
                        .perpetoElevation(.card, cornerRadius: PerpetoRadius.control)
                } else if hovering {
                    RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous).fill(PerpetoColor.canvasStrong)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(PerpetoMotion.standard(reduceMotion: reduceMotion), value: hovering)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Monogram tile, project name and owner; a menu switches projects.
struct ProjectSwitcher: View {
    var store: FactoryStore
    var navigator: Navigator
    var current: Project

    var body: some View {
        Menu {
            ForEach(store.factory.projects) { project in
                Button(project.name) { navigator.route = .project(project.id, .overview) }
            }
        } label: {
            HStack(spacing: PerpetoSpacing.x(3)) {
                Monogram(text: current.name)
                VStack(alignment: .leading, spacing: 1) {
                    Text(current.name).font(PerpetoType.text(PerpetoType.text14, weight: .semibold)).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                    Text(Format.repoOwner(current.repo.url)).font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(PerpetoColor.muted)
            }
            .padding(.horizontal, PerpetoSpacing.x(2))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .accessibilityLabel("Project: \(current.name). Switch project")
    }
}

/// A 32 pt white monogram tile with card elevation.
struct Monogram: View {
    var text: String
    var filled = false
    var body: some View {
        Text(String(text.prefix(1)).lowercased())
            .font(PerpetoType.text(PerpetoType.text16, weight: .semibold))
            .foregroundStyle(PerpetoColor.ink)
            .frame(width: 32, height: 32)
            .background(filled ? PerpetoColor.surfaceSubtle : PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.small + 2, style: .continuous))
            .modifier(MonogramElevation(on: !filled))
    }
}

struct MonogramElevation: ViewModifier {
    var on: Bool
    func body(content: Content) -> some View {
        if on { content.perpetoElevation(.card, cornerRadius: PerpetoRadius.small + 2) } else { content }
    }
}

/// Pinned to the bottom: where data comes from, and the connection settings.
struct AccountRow: View {
    var store: FactoryStore
    var openSettings: () -> Void

    var body: some View {
        let owner = store.factory.overview.owner
        HStack(spacing: PerpetoSpacing.x(3)) {
            Group {
                if let initials = owner?.initials, !initials.isEmpty {
                    Text(initials)
                } else {
                    Image(systemName: "person")
                }
            }
            .font(PerpetoFont.captionMedium)
            .foregroundStyle(PerpetoColor.inkSoft)
            .frame(width: 32, height: 32)
            .background(Circle().fill(PerpetoColor.surfaceSubtle))
            VStack(alignment: .leading, spacing: 1) {
                Text(owner?.name ?? "Owner").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                Text(store.isDemo ? "Demo data" : store.lastUpdated.map { "Connected · " + Format.relative($0) } ?? "Connected to hub")
                    .font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            IconButton("slider.horizontal.3", label: "Settings", action: openSettings)
        }
        .padding(.horizontal, PerpetoSpacing.x(1))
    }
}

/// Routes a factory section to its screen.
struct FactoryScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    var section: FactorySection

    var body: some View {
        switch section {
        case .home: ObserveHomeScreen(store: store, navigator: navigator)
        case .sessions: SessionsScreen(store: store)
        case .machines: MachinesScreen(store: store)
        case .accounts: AccountsScreen(store: store)
        case .pacing: PacingScreen(store: store)
        case .usage: UsageScreen(store: store)
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
        case .ci: CIScreen(store: store, navigator: navigator, project: project)
        }
    }
}
