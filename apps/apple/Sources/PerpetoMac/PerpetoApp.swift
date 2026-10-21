import AppKit
import PerpetoKit
import PerpetoUI
import SwiftUI

@main
struct PerpetoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store: FactoryStore
    @State private var navigator = Navigator()
    @AppStorage(AppearanceMode.defaultsKey) private var appearance: AppearanceMode = .system

    init() {
        // Snapshots use demo fixtures unless a hub is named for them explicitly.
        let (source, error): (FactoryDataSource, String?) = Snapshotter.requestedDirectory == nil
            ? FactoryStore.makeSource()
            : (Snapshotter.hubSource().map { $0 as FactoryDataSource } ?? DemoDataSource(), nil)
        let store = FactoryStore(source: source)
        store.lastError = error
        _store = State(initialValue: store)
    }

    var body: some Scene {
        Window("perpeto", id: "main") {
            MainWindow(store: store, navigator: navigator)
                .frame(minWidth: 1100, minHeight: 700)
                .preferredColorScheme(appearance.colorScheme)
                .onChange(of: appearance, initial: true) { _, mode in AppDelegate.apply(mode) }
        }
        .defaultSize(width: 1440, height: 960)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { PerpetoCommands(store: store, navigator: navigator) }

        Settings {
            SettingsView(store: store)
                .preferredColorScheme(appearance.colorScheme)
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
                    await Snapshotter(store: store, navigator: navigator, directory: directory, openSettings: { openSettings() }).run()
                }
            }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let directory = IconRenderer.requestedDirectory {
            // The icon is always the light mark on white.
            NSApp.appearance = NSAppearance(named: .aqua)
            IconRenderer.render(to: directory)
            exit(0)
        }
        Self.apply(.current)
    }

    /// Menus, alerts and window chrome follow the chosen appearance; nil follows the system.
    @MainActor
    static func apply(_ mode: AppearanceMode) {
        switch mode {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
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
    @FocusedValue(\.editorUndo) private var editorUndo

    var body: some Commands {
        // The graph editor keeps its own history; elsewhere, undo goes to the
        // first responder as usual (text fields, for example).
        CommandGroup(replacing: .undoRedo) {
            Button(editorUndo?.undoName.map { "Undo \($0)" } ?? "Undo") {
                if let editorUndo, editorUndo.undoName != nil { editorUndo.undo() } else { NSApp.sendAction(Selector(("undo:")), to: nil, from: nil) }
            }
            .keyboardShortcut("z", modifiers: .command)
            Button(editorUndo?.redoName.map { "Redo \($0)" } ?? "Redo") {
                if let editorUndo, editorUndo.redoName != nil { editorUndo.redo() } else { NSApp.sendAction(Selector(("redo:")), to: nil, from: nil) }
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
        }
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
