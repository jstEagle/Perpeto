import AppKit
import PerpetoKit
import PerpetoUI
import SwiftUI

// Developer tooling, triggered only by launch arguments:
//   --snapshots <dir>   capture the main window on each screen, then quit
//     --hub-url <url> --hub-token-file <path>   capture a live hub instead of
//     demo data; the token is read from an owner-only file, never an argument
//     --live-check   also add one input to the newest run through the API and
//     capture again, to show live events refreshing the map without ⌘R
//     --themes <prefix>   capture only Overview, Workflows, the live map,
//     Messages and Settings, named <prefix>overview.png and so on; combine
//     with -perpeto.appearance light|dark to force the appearance
//     --pacing <prefix>   capture only Accounts and Pacing, named
//     <prefix>accounts.png and <prefix>pacing.png
//     --fleet <prefix>    capture Fleet, then Fleet with a machine cordoned;
//     combine with -perpeto.demo fleet for the overloaded two-machine fleet
//     --ci <prefix>       capture the CI screen and two demo pipeline runs
//     --observe <prefix>  capture the observe-only screens (Home, Sessions,
//     Accounts, Pacing, Usage, Machines);
//     combine with -perpeto.demo observe for the demo without projects
//   --render-icon <dir> write the app icon PNGs, then quit

enum LaunchArgument {
    static func value(after flag: String) -> URL? {
        string(after: flag).map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    static func string(after flag: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }
}

/// Visits each screen and captures only this app's window with
/// `screencapture -l <windowNumber>`, so nothing else on screen is recorded.
@MainActor
struct Snapshotter {
    static var requestedDirectory: URL? { LaunchArgument.value(after: "--snapshots") }

    /// A hub client for snapshotting live data, when both flags are given.
    static func hubSource() -> HubDataSource? {
        guard let url = LaunchArgument.string(after: "--hub-url").flatMap(URL.init(string:)),
              let path = LaunchArgument.string(after: "--hub-token-file"),
              let token = try? String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let client = try? HubClient(baseURL: url, token: token) else { return nil }
        return HubDataSource(client: client)
    }

    var store: FactoryStore
    var navigator: Navigator
    var directory: URL
    var openSettings: () -> Void = {}

    func run() async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        await store.refresh()
        if let prefix = LaunchArgument.string(after: "--observe") {
            try? await Task.sleep(for: .seconds(1.5))
            for (name, show) in observeShots(prefix: prefix) {
                show()
                try? await Task.sleep(for: .seconds(1.4))
                capture(name)
            }
            NSApp.terminate(nil)
            return
        }
        guard let project = store.factory.projects.first?.id else { return }
        let shots = LaunchArgument.string(after: "--fleet").map { fleetShots(prefix: $0) }
            ?? LaunchArgument.string(after: "--pacing").map { pacingShots(prefix: $0) }
            ?? LaunchArgument.string(after: "--ci").map { ciShots(project, prefix: $0) }
            ?? LaunchArgument.string(after: "--themes").map { themeShots(project, prefix: $0) }
            ?? (store.isDemo ? demoShots(project) : hubShots(project))
        try? await Task.sleep(for: .seconds(1.5))
        for (name, show) in shots {
            show()
            try? await Task.sleep(for: .seconds(name.hasPrefix("12") || name.contains("window") || name.contains("after-live") ? 4 : 1.4))
            capture(name)
        }
        NSApp.terminate(nil)
    }

    /// Live hub screens. The run is the project's newest; the selected node is its busiest.
    private func hubShots(_ project: String) -> [(String, () -> Void)] {
        let state = store.state(project)
        let run = state.runs.first?.id
        let busiest = run.flatMap { state.runMetrics[$0]?.nodes.max { $0.active < $1.active }?.nodeId }
        let bottleneck = run.flatMap { state.runMetrics[$0]?.bottlenecks.first { $0.severity != .info }?.nodeId }
        let firstStep = state.runs.first.flatMap { state.version($0.workflowVersion, of: $0.workflowId)?.graph.nodes.first?.id }
        return [
            ("hub-01-overview", { navigator.route = .project(project, .overview) }),
            ("hub-02-workflow-proposal", { navigator.route = .project(project, .workflows) }),
            ("hub-03-run-live-map", { navigator.selectedRunId = run; navigator.route = .project(project, .runs) }),
            // The map opens on the bottleneck; panning away and back uses "Show on map".
            ("hub-03a-run-map-panned-away", { navigator.selectedNodeId = firstStep }),
            ("hub-03b-run-show-on-map", { navigator.selectedNodeId = bottleneck ?? busiest }),
            ("hub-03c-run-window-1h", { Task { await store.setMetricsWindow(.hour) } }),
            ("hub-04-work", { navigator.route = .project(project, .work) }),
            ("hub-05-messages", { navigator.route = .project(project, .messages) }),
            ("hub-07-machines", { navigator.route = .factory(.machines) }),
            ("hub-08-accounts", { navigator.route = .factory(.accounts) }),
            ("hub-08b-pacing", { navigator.route = .factory(.pacing) }),
            ("hub-09-usage", { navigator.route = .factory(.usage) }),
        ] + (CommandLine.arguments.contains("--live-check") ? liveCheck(project, run: run) : [])
    }

    /// Adds an input through the hub, outside the store, then shows the run.
    /// The store must pick the change up from the event stream alone.
    private func liveCheck(_ project: String, run: String?) -> [(String, () -> Void)] {
        guard let run, let source = store.source as? HubDataSource else { return [] }
        return [
            ("hub-10-before-live-input", {
                navigator.selectedNodeId = nil
                navigator.route = .project(project, .work)
            }),
            ("hub-11-after-live-input", {
                Task { try? await source.client.addInputs(runId: run, items: ["Live update check"]) }
            }),
        ]
    }

    /// CI: pipeline runs, runners and flaky jobs, then a live run's jobs and log.
    private func ciShots(_ project: String, prefix: String) -> [(String, () -> Void)] {
        [
            ("\(prefix)ci", { tall(height: 1100); navigator.selectedPipelineRunId = nil; navigator.route = .project(project, .ci) }),
            ("\(prefix)ci-run", { navigator.selectedPipelineRunId = "plr_live" }),
            ("\(prefix)ci-run-failed", { navigator.selectedPipelineRunId = "plr_failed" }),
        ]
    }

    /// Subscriptions and pacing, for reviewing them in each appearance.
    private func pacingShots(prefix: String) -> [(String, () -> Void)] {
        [
            ("\(prefix)accounts", { tall(); navigator.route = .factory(.accounts) }),
            ("\(prefix)pacing", { navigator.route = .factory(.pacing) }),
        ]
    }

    /// The Fleet screen, then the same machine cordoned. Combine with
    /// `-perpeto.demo fleet` for the overloaded two-machine fleet.
    private func fleetShots(prefix: String) -> [(String, () -> Void)] {
        [
            ("\(prefix)fleet", { tall(height: 1000); navigator.route = .factory(.machines) }),
            ("\(prefix)fleet-cordoned", {
                if let machine = store.factory.machines.first(where: FleetText.accepting) { Task { await store.apply(.cordon, to: machine) } }
            }),
            ("\(prefix)fleet-50", {
                tall(height: 1800)
                guard let demo = store.source as? DemoDataSource else { return }
                Task {
                    await demo.setMachines(DemoFleet.generated(count: 50, now: Date()))
                    await store.refresh()
                }
            }),
        ]
    }

    /// The observe-only factory, for reviewing it in each appearance.
    private func observeShots(prefix: String) -> [(String, () -> Void)] {
        [
            ("\(prefix)home", { tall(height: 1240); navigator.route = .factory(.home) }),
            ("\(prefix)sessions", { tall(height: 1900); navigator.route = .factory(.sessions) }),
            ("\(prefix)accounts", { tall(height: 960); navigator.route = .factory(.accounts) }),
            ("\(prefix)pacing", { navigator.route = .factory(.pacing) }),
            ("\(prefix)usage", { tall(height: 1160); navigator.route = .factory(.usage) }),
            ("\(prefix)machines", { tall(height: 960); navigator.route = .factory(.machines) }),
        ]
    }

    /// Makes the main window tall enough to show a whole screen in one capture.
    private func tall(height: CGFloat = 1360) {
        guard let window = NSApp.windows.first(where: { $0.isVisible && !$0.isSheet && $0.frame.width > 200 }) else { return }
        var frame = window.frame
        frame.origin.y += frame.height - height
        frame.size.height = height
        window.setFrame(frame, display: true)
    }

    /// The screens used to review light and dark appearance side by side.
    private func themeShots(_ project: String, prefix: String) -> [(String, () -> Void)] {
        [
            ("\(prefix)overview", { navigator.route = .project(project, .overview) }),
            ("\(prefix)workflows", { navigator.route = .project(project, .workflows) }),
            ("\(prefix)run-live-map", { navigator.selectedRunId = DemoFixtures.liveRunId; navigator.route = .project(project, .runs) }),
            ("\(prefix)run-node-selected", { navigator.selectedNodeId = "review" }),
            ("\(prefix)messages", { navigator.route = .project(project, .messages) }),
            ("\(prefix)merge-queue", { navigator.route = .project(project, .mergeQueue) }),
            ("\(prefix)accounts", { navigator.route = .factory(.accounts) }),
            ("\(prefix)pacing", { navigator.route = .factory(.pacing) }),
            ("\(prefix)usage", { navigator.route = .factory(.usage) }),
            ("\(prefix)settings", { openSettings() }),
        ]
    }

    private func demoShots(_ project: String) -> [(String, () -> Void)] {
        [
            ("01-overview", { navigator.route = .project(project, .overview) }),
            ("02-workflow-proposal", { navigator.route = .project(project, .workflows) }),
            ("03-run-live-map", { navigator.selectedRunId = DemoFixtures.liveRunId; navigator.route = .project(project, .runs) }),
            ("03b-run-node-selected", { navigator.selectedNodeId = "review" }),
            ("04-work", { navigator.route = .project(project, .work) }),
            ("05-messages", { navigator.route = .project(project, .messages) }),
            ("06-merge-queue", { navigator.route = .project(project, .mergeQueue) }),
            ("07-machines", { navigator.route = .factory(.machines) }),
            ("08-accounts", { navigator.route = .factory(.accounts) }),
            ("08b-pacing", { navigator.route = .factory(.pacing) }),
            ("09-usage", { navigator.route = .factory(.usage) }),
            ("10-workflow-prompt", { navigator.route = .project("prj_docs", .workflows) }),
            ("11-architect-progress", {
                store.requestDraft(projectId: "prj_docs", prompt: "Plan from our goals, build with Codex, review every PR with Claude, run CI on the Linux box and merge one at a time.", baseWorkflowId: nil)
            }),
            ("12-architect-draft-ready", {}),
            ("13-first-draft", {
                store.clearDraft(projectId: "prj_docs")
                navigator.route = .project("prj_docs", .overview)
                navigator.route = .project("prj_docs", .workflows)
            }),
            ("14-editor", { navigator.route = .project(project, .workflows); navigator.editWorkflowRequest += 1 }),
            ("15a-budget-paused-run", { navigator.selectedRunId = DemoFixtures.improveRunId; navigator.route = .project(project, .runs) }),
            ("15b-run-settings-sheet", { navigator.runSettingsRequest += 1 }),
            ("15-runs-list", { navigator.selectedRunId = nil; navigator.route = .project(project, .runs) }),
            ("16-empty-runs", { navigator.route = .project("prj_docs", .runs) }),
            ("17-error", {
                navigator.route = .project(project, .overview)
                store.lastError = "Activating the workflow failed. The hub could not be reached. Check that it is running, then try again."
            }),
            ("18-settings", {
                store.lastError = nil
                openSettings()
            }),
        ]
    }

    private func capture(_ name: String) {
        // The settings shot captures the Settings window; every other shot the main window.
        let candidates = NSApp.windows.filter { $0.isVisible && $0.contentView != nil && !$0.isSheet && $0.frame.width > 200 }
        let settings = candidates.first { $0.identifier?.rawValue.contains("Settings") == true || $0.title.contains("Settings") || $0.title.contains("General") }
        let sheet = NSApp.windows.first { $0.isSheet && $0.isVisible }
        let main = candidates.first(where: { $0.title != "" && $0 != settings }) ?? candidates.first
        guard let window = name.contains("sheet") ? (sheet ?? main) : name.contains("settings") ? (settings ?? NSApp.keyWindow) : main else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-l", String(window.windowNumber), directory.appendingPathComponent("\(name).png").path]
        try? process.run()
        process.waitUntilExit()
    }
}

/// The app icon: the Spindle in ink on white, on the macOS icon grid. Rendered in light appearance.
struct AppIconView: View {
    var size: CGFloat

    var body: some View {
        let inset = size * 100 / 1024
        let body = size - inset * 2
        ZStack {
            RoundedRectangle(cornerRadius: body * 0.2237, style: .continuous)
                .fill(PerpetoColor.canvas)
                .overlay(
                    RoundedRectangle(cornerRadius: body * 0.2237, style: .continuous)
                        .strokeBorder(PerpetoColor.border, lineWidth: max(1, size / 512)))
                .frame(width: body, height: body)
            SpindleShape()
                .fill(PerpetoColor.ink)
                .frame(width: body * 0.62, height: body * 0.62)
        }
        .frame(width: size, height: size)
    }
}

@MainActor
enum IconRenderer {
    static var requestedDirectory: URL? { LaunchArgument.value(after: "--render-icon") }

    /// Writes an `.iconset` folder for `iconutil`.
    static func render(to directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for points in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = CGFloat(points * scale)
                let renderer = ImageRenderer(content: AppIconView(size: pixels))
                renderer.scale = 1
                guard let image = renderer.cgImage else { continue }
                let rep = NSBitmapImageRep(cgImage: image)
                let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
                try? rep.representation(using: .png, properties: [:])?.write(to: directory.appendingPathComponent(name))
            }
        }
    }
}
