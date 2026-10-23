import Observation
import PerpetoKit
import SwiftUI

/// Project-level screens, in contract order.
public enum ProjectSection: String, CaseIterable, Hashable, Sendable, Identifiable {
    case overview, workflows, runs, work, messages, mergeQueue, ci

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .overview: "Overview"
        case .workflows: "Workflows"
        case .runs: "Runs"
        case .work: "Work"
        case .messages: "Messages"
        case .mergeQueue: "Merge queue"
        case .ci: "CI"
        }
    }

    public var systemImage: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .workflows: "point.topleft.down.to.point.bottomright.curvepath"
        case .runs: "play.circle"
        case .work: "checklist"
        case .messages: "bubble.left"
        case .mergeQueue: "arrow.triangle.branch"
        case .ci: "checkmark.seal"
        }
    }

    public var shortcut: KeyEquivalent {
        KeyEquivalent(Character(String(ProjectSection.allCases.firstIndex(of: self)! + 1)))
    }
}

public enum FactorySection: String, CaseIterable, Hashable, Sendable, Identifiable {
    /// The observe-only home: sessions, machines, subscriptions and usage at a glance.
    case home, sessions, machines, accounts, pacing, usage, storage

    public var id: String { rawValue }

    /// The Factory group in the sidebar. Home leads the observe-only sidebar on its own.
    public static let grouped: [FactorySection] = [.sessions, .machines, .storage, .accounts, .pacing, .usage]

    public var title: String {
        switch self {
        case .home: "Home"
        case .sessions: "Sessions"
        case .machines: "Fleet"
        case .accounts: "Accounts"
        case .pacing: "Pacing"
        case .usage: "Usage"
        case .storage: "Storage"
        }
    }

    public var systemImage: String {
        switch self {
        case .home: "house"
        case .sessions: "rectangle.stack"
        case .machines: "desktopcomputer"
        case .accounts: "person.2"
        case .pacing: "gauge.with.dots.needle.67percent"
        case .usage: "chart.bar"
        case .storage: "internaldrive"
        }
    }

    /// ⌥⌘0 Home, ⌥⌘1 Sessions, then Machines, Accounts, Pacing, Usage and Storage.
    public var shortcut: KeyEquivalent {
        KeyEquivalent(Character(String(FactorySection.allCases.firstIndex(of: self)!)))
    }
}

public enum Route: Hashable, Sendable {
    case project(String, ProjectSection)
    case factory(FactorySection)

    public var title: String {
        switch self {
        case .project(_, let section): section.title
        case .factory(let section): section.title
        }
    }

    public var projectId: String? {
        if case .project(let id, _) = self { return id }
        return nil
    }
}

/// Selection shared by the window, menus and keyboard shortcuts.
@MainActor
@Observable
public final class Navigator {
    public var route: Route?
    public var selectedRunId: String?
    public var selectedWorkflowId: String?
    /// Pipeline run open on the CI screen.
    public var selectedPipelineRunId: String?
    /// Set by ⌘N to open the architect prompt.
    public var composeWorkflowRequest = 0
    /// Opens the hand editor for the workflow version on screen.
    public var editWorkflowRequest = 0
    /// Node to select on the run map, for deep links.
    public var selectedNodeId: String?
    /// Opens the run settings sheet on the run screen.
    public var runSettingsRequest = 0
    /// Sidebar visibility of the main split view.
    public var columnVisibility: NavigationSplitViewVisibility = .automatic

    public init(route: Route? = nil) {
        self.route = route
    }

    public var projectId: String? { route?.projectId }

    public func show(_ section: ProjectSection, fallbackProject: String?) {
        guard let id = projectId ?? fallbackProject else { return }
        route = .project(id, section)
    }

    public func show(_ section: FactorySection) {
        route = .factory(section)
    }
}
