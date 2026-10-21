import AppKit
import PerpetoKit
import PerpetoUI
import SwiftUI

@main
struct PerpetoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store: FactoryStore
    @State private var navigator = Navigator()

    init() {
        // Snapshots always use demo fixtures, never a configured hub.
        let (source, error): (FactoryDataSource, String?) = Snapshotter.requestedDirectory == nil ? FactoryStore.makeSource() : (DemoDataSource(), nil)
        let store = FactoryStore(source: source)
        store.lastError = error
        _store = State(initialValue: store)
    }

    var body: some Scene {
        Window("perpeto", id: "main") {
            MainWindow(store: store, navigator: navigator)
                .frame(minWidth: 1100, minHeight: 700)
                .preferredColorScheme(.light)
        }
        .defaultSize(width: 1600, height: 1000)
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands { PerpetoCommands(store: store, navigator: navigator) }

        Settings {
            SettingsView(store: store)
                .preferredColorScheme(.light)
        }
    }
}

struct MainWindow: View {
    var store: FactoryStore
    var navigator: Navigator
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        RootView(store: store, navigator: navigator, openSettings: { openSettings() })
            .task {
                if let directory = Snapshotter.requestedDirectory {
                    await Snapshotter(store: store, navigator: navigator, directory: directory).run()
                }
            }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Dark mode is intentionally undefined in brand.md; stay in light appearance.
        NSApp.appearance = NSAppearance(named: .aqua)
        NSApp.setActivationPolicy(.regular)
        if let directory = IconRenderer.requestedDirectory {
            IconRenderer.render(to: directory)
            exit(0)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// Menus and keyboard shortcuts.
struct PerpetoCommands: Commands {
    var store: FactoryStore
    var navigator: Navigator

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New workflow draft…") {
                navigator.show(.workflows, fallbackProject: store.factory.projects.first?.id)
                navigator.composeWorkflowRequest += 1
            }
            .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(after: .sidebar) {
            Button("Refresh") { Task { await store.refresh() } }
                .keyboardShortcut("r", modifiers: .command)
            Divider()
        }
        CommandMenu("Go") {
            Section("Project") {
                ForEach(ProjectSection.allCases) { section in
                    Button(section.title) { navigator.show(section, fallbackProject: store.factory.projects.first?.id) }
                        .keyboardShortcut(section.shortcut, modifiers: .command)
                }
            }
            Section("Factory") {
                ForEach(FactorySection.allCases) { section in
                    Button(section.title) { navigator.show(section) }
                        .keyboardShortcut(section.shortcut, modifiers: [.command, .option])
                }
            }
            Divider()
            Menu("Project") {
                ForEach(store.factory.projects) { project in
                    Button(project.name) { navigator.route = .project(project.id, .overview) }
                }
            }
        }
    }
}
