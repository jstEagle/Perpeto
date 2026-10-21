#if os(iOS)
import PerpetoKit
import SwiftUI

/// iPhone: Overview, Runs, Work, Messages and More, each in its own stack.
/// The navigator's route picks the tab, so links between screens still work.
struct PhoneTabs: View {
    var store: FactoryStore
    @Bindable var navigator: Navigator
    var openSettings: () -> Void

    enum Tab: Hashable { case overview, runs, work, messages, more }

    @State private var tab: Tab = .overview
    @State private var morePath: [Route] = []

    private var projectId: String? { navigator.projectId ?? store.factory.projects.first?.id }

    var body: some View {
        TabView(selection: $tab) {
            stack(.overview).tabItem { Label("Overview", systemImage: ProjectSection.overview.systemImage) }.tag(Tab.overview)
            stack(.runs).tabItem { Label("Runs", systemImage: ProjectSection.runs.systemImage) }.tag(Tab.runs)
            stack(.work).tabItem { Label("Work", systemImage: ProjectSection.work.systemImage) }.tag(Tab.work)
            stack(.messages).tabItem { Label("Messages", systemImage: ProjectSection.messages.systemImage) }.tag(Tab.messages)
            more.tabItem { Label("More", systemImage: "ellipsis") }.tag(Tab.more)
        }
        .environment(\.compactLayout, true)
        .environment(\.readOnlySettings, true)
        .environment(\.symbolVariants, .none)
        .onChange(of: tab) { _, tab in
            guard let projectId else { return }
            switch tab {
            case .overview: navigator.route = .project(projectId, .overview)
            case .runs: navigator.route = .project(projectId, .runs)
            case .work: navigator.route = .project(projectId, .work)
            case .messages: navigator.route = .project(projectId, .messages)
            case .more: break
            }
        }
        .onChange(of: navigator.route, initial: true) { _, route in follow(route) }
    }

    /// Links like "Open live map" set the route; show the matching tab.
    private func follow(_ route: Route?) {
        switch route {
        case .project(_, .overview): tab = .overview
        case .project(_, .runs): tab = .runs
        case .project(_, .work): tab = .work
        case .project(_, .messages): tab = .messages
        case .some(let other):
            tab = .more
            if morePath.last != other { morePath = [other] }
        case nil: break
        }
    }

    private func stack(_ section: ProjectSection) -> some View {
        NavigationStack {
            Group {
                if let projectId, let project = store.project(projectId) {
                    ProjectScreen(store: store, navigator: navigator, project: project, section: section)
                } else {
                    DetailView(store: store, navigator: navigator)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .canvasBackground()
            .overlay(alignment: .top) {
                if let error = store.lastError {
                    ErrorBanner(error) { store.lastError = nil }.padding(PerpetoSpacing.x(4))
                }
            }
            .toolbar { bar }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    @ToolbarContentBuilder
    private var bar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            SpindleShape().fill(PerpetoColor.ink).frame(width: 22, height: 22).accessibilityLabel("perpeto")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                ForEach(store.factory.projects) { project in
                    Button(project.name) { navigator.route = .project(project.id, .overview) }
                }
                Divider()
                Button("Hub connection", action: openSettings)
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(PerpetoColor.ink)
                    .accessibilityLabel("Projects and settings")
            }
        }
    }

    private var more: some View {
        NavigationStack(path: $morePath) {
            ScrollView {
                VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                    ScreenHeader("More")
                    VStack(alignment: .leading, spacing: 0) {
                        if let projectId {
                            link("Workflows", ProjectSection.workflows.systemImage, .project(projectId, .workflows))
                            Rule()
                            link("Merge queue", ProjectSection.mergeQueue.systemImage, .project(projectId, .mergeQueue))
                            Rule()
                        }
                        link("Machines", FactorySection.machines.systemImage, .factory(.machines))
                        Rule()
                        link("Accounts", FactorySection.accounts.systemImage, .factory(.accounts))
                        Rule()
                        link("Usage", FactorySection.usage.systemImage, .factory(.usage))
                    }
                    .card()
                    Button(action: openSettings) {
                        HStack(spacing: PerpetoSpacing.x(3)) {
                            IconTile("slider.horizontal.3")
                            RowText("Hub connection", meta: store.isDemo ? "Demo data. Connect a hub to see live work." : "Connected")
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(PerpetoColor.faint)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .card()
                }
                .screenPadding()
            }
            .canvasBackground()
            .toolbar { bar }
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                Group {
                    switch route {
                    case .project(let id, let section):
                        if let project = store.project(id) { ProjectScreen(store: store, navigator: navigator, project: project, section: section) }
                    case .factory(.machines): MachinesScreen(store: store)
                    case .factory(.accounts): AccountsScreen(store: store)
                    case .factory(.usage): UsageScreen(store: store)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .canvasBackground()
                .toolbarBackground(.hidden, for: .navigationBar)
            }
        }
    }

    private func link(_ title: String, _ image: String, _ route: Route) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                IconTile(image)
                Text(title).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(PerpetoColor.faint)
            }
            .padding(.vertical, PerpetoSpacing.x(3))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
#endif
