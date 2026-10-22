import PerpetoKit
import PerpetoUI
import SwiftUI

/// iPhone and iPad app. Shares every screen with the Mac through PerpetoUI;
/// navigation adapts from a split view on iPad to a stack on iPhone.
@main
struct PerpetoiOSApp: App {
    @State private var store: FactoryStore
    @State private var navigator: Navigator
    @State private var showConnection = false
    @AppStorage(AppearanceMode.defaultsKey) private var appearance: AppearanceMode = .system

    init() {
        let (source, error) = LaunchOptions.hubSource().map { ($0 as FactoryDataSource, nil) } ?? FactoryStore.makeSource()
        let store = FactoryStore(source: source)
        store.lastError = error
        _store = State(initialValue: store)
        _navigator = State(initialValue: Navigator())
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: store, navigator: navigator, openSettings: { showConnection = true })
                .sheet(isPresented: $showConnection) {
                    NavigationStack {
                        SettingsView(store: store)
                            .navigationTitle("Settings")
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) { Button("Done") { showConnection = false } }
                            }
                    }
                    .tint(PerpetoColor.ink)
                    .preferredColorScheme(appearance.colorScheme)
                }
                .task {
                    await LaunchOptions.apply(to: navigator, store: store)
                    if CommandLine.arguments.contains("--settings") { showConnection = true }
                }
                .preferredColorScheme(appearance.colorScheme)
        }
    }
}

/// Developer launch arguments, used to capture simulator screenshots:
///   --route <overview|workflows|runs|runs-list|work|messages|merge-queue|home|sessions|machines|accounts|pacing|usage>
///     (`runs` opens the running run's map; `runs-list` the list of runs)
///   --node <node id>     select a node on the run map
///   --run <run id>       open this run instead of the running one
///   --detail-only        hide the sidebar (iPad)
///   --settings           open the settings sheet
///   -perpeto.appearance <system|light|dark>   override the appearance for this launch
///   -perpeto.demo <full|observe>   pick the demo factory (observe: no projects, T3 sessions only)
///   --hub-url <url> --hub-token-file <path>   read a live hub; the token
///     comes from an owner-only file, never an argument
enum LaunchOptions {
    static func value(_ flag: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    static func hubSource() -> HubDataSource? {
        guard let url = value("--hub-url").flatMap(URL.init(string:)),
              let path = value("--hub-token-file"),
              let token = try? String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let client = try? HubClient(baseURL: url, token: token) else { return nil }
        return HubDataSource(client: client)
    }

    @MainActor
    static func apply(to navigator: Navigator, store: FactoryStore) async {
        guard let route = value("--route") else { return }
        if store.factory.projects.isEmpty { await store.refresh() }
        if let section = FactorySection.allCases.first(where: { $0.rawValue == route }) {
            navigator.route = .factory(section)
            if CommandLine.arguments.contains("--detail-only") { navigator.columnVisibility = .detailOnly }
            return
        }
        guard let project = store.factory.projects.first?.id else { return }
        switch route {
        case "runs-list": navigator.route = .project(project, .runs)
        default:
            let section = ProjectSection.allCases.first { $0.rawValue == route || $0.title.lowercased().replacingOccurrences(of: " ", with: "-") == route } ?? .overview
            if section == .runs { navigator.selectedRunId = value("--run") ?? store.state(project).runs.first { $0.status == .running }?.id }
            navigator.route = .project(project, section)
        }
        navigator.selectedNodeId = value("--node")
        if CommandLine.arguments.contains("--detail-only") { navigator.columnVisibility = .detailOnly }
    }
}
