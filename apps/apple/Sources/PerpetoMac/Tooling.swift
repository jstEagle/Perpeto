import AppKit
import PerpetoKit
import PerpetoUI
import SwiftUI

// Developer tooling, triggered only by launch arguments:
//   --snapshots <dir>   capture the main window on each screen, then quit
//   --render-icon <dir> write the app icon PNGs, then quit

enum LaunchArgument {
    static func value(after flag: String) -> URL? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return URL(fileURLWithPath: args[index + 1], isDirectory: true)
    }
}

/// Visits each screen and captures only this app's window with
/// `screencapture -l <windowNumber>`, so nothing else on screen is recorded.
@MainActor
struct Snapshotter {
    static var requestedDirectory: URL? { LaunchArgument.value(after: "--snapshots") }

    var store: FactoryStore
    var navigator: Navigator
    var directory: URL

    func run() async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        await store.refresh()
        guard let project = store.factory.projects.first?.id else { return }
        let shots: [(String, () -> Void)] = [
            ("01-overview", { navigator.route = .project(project, .overview) }),
            ("02-workflow-proposal", { navigator.route = .project(project, .workflows) }),
            ("03-run-live-map", { navigator.selectedRunId = DemoFixtures.liveRunId; navigator.route = .project(project, .runs) }),
            ("03b-run-node-selected", { navigator.selectedNodeId = "review" }),
            ("04-work", { navigator.route = .project(project, .work) }),
            ("05-messages", { navigator.route = .project(project, .messages) }),
            ("06-merge-queue", { navigator.route = .project(project, .mergeQueue) }),
            ("07-machines", { navigator.route = .factory(.machines) }),
            ("08-accounts", { navigator.route = .factory(.accounts) }),
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
        ]
        try? await Task.sleep(for: .seconds(1.5))
        for (name, show) in shots {
            show()
            try? await Task.sleep(for: .seconds(name.hasPrefix("12") ? 4 : 1.4))
            capture(name)
        }
        NSApp.terminate(nil)
    }

    private func capture(_ name: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.title != "" && !$0.isSheet }) else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-l", String(window.windowNumber), directory.appendingPathComponent("\(name).png").path]
        try? process.run()
        process.waitUntilExit()
    }
}

/// The app icon: the Spindle in ink on warm paper, on the macOS icon grid.
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
