import PerpetoKit
import SwiftUI

extension Path {
    /// Polyline with rounded corners: 12 pt on the map.
    static func rounded(_ points: [CGPoint], radius: CGFloat = PerpetoEditor.edgeCorner) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        guard points.count > 2 else {
            points.dropFirst().forEach { path.addLine(to: $0) }
            return path
        }
        for i in 1..<(points.count - 1) {
            let prev = points[i - 1], corner = points[i], next = points[i + 1]
            let r = min(radius, hypot(corner.x - prev.x, corner.y - prev.y) / 2, hypot(next.x - corner.x, next.y - corner.y) / 2)
            path.addArc(tangent1End: corner, tangent2End: next, radius: r)
        }
        path.addLine(to: points[points.count - 1])
        return path
    }
}

/// How an edge is drawn. Thin grey lines, no arrowheads: flow runs left to
/// right and top to bottom, and returns go back over the top.
public enum EdgeLook: Hashable, CaseIterable {
    /// A flow path.
    case flow
    /// Flow that carried work in the selected window.
    case flowing
    /// A flow path no work has reached yet.
    case notReached
    case delegates
    case messages
    /// An interaction no edge in the approved graph allows.
    case unplanned

    var title: String {
        switch self {
        case .flow: "Flow"
        case .flowing: "Flowing now"
        case .notReached: "Not reached"
        case .delegates: "Delegates"
        case .messages: "Messages"
        case .unplanned: "Unplanned"
        }
    }

    var color: Color {
        switch self {
        case .flow, .notReached: PerpetoColor.editorEdge
        case .flowing: PerpetoColor.editorEdgeActive
        case .delegates, .messages: PerpetoColor.grey300
        case .unplanned: PerpetoColor.ink
        }
    }

    var stroke: StrokeStyle {
        switch self {
        case .flow: StrokeStyle(lineWidth: PerpetoStroke.edge, lineCap: .round, lineJoin: .round)
        case .flowing: StrokeStyle(lineWidth: PerpetoStroke.edgeActive, lineCap: .round, lineJoin: .round)
        case .notReached: StrokeStyle(lineWidth: PerpetoStroke.edge, lineCap: .butt, lineJoin: .round, dash: [3, 5])
        case .delegates: StrokeStyle(lineWidth: PerpetoStroke.edge, lineCap: .butt, lineJoin: .round, dash: [8, 5])
        case .messages: StrokeStyle(lineWidth: PerpetoStroke.edgeActive, lineCap: .round, lineJoin: .round, dash: [0.5, 4])
        case .unplanned: StrokeStyle(lineWidth: PerpetoStroke.edgeActive, lineCap: .round, lineJoin: .round, dash: [0.5, 4])
        }
    }
}

/// Words for edge kinds, used in lists and inspectors.
public enum EdgeStyle {
    public static func title(_ kind: GraphEdge.Kind) -> String {
        switch kind {
        case .flow: "Flow"
        case .delegates: "Delegates"
        case .messages: "Messages"
        case .unknown: "Unknown"
        }
    }

    public static func meaning(_ kind: GraphEdge.Kind) -> String {
        switch kind {
        case .flow: "Moves work items"
        case .delegates: "May assign work or spawn subagents"
        case .messages: "May message each other"
        case .unknown: "Not recognised"
        }
    }
}

extension NodeType {
    public var systemImage: String {
        switch self {
        case .input: "tray"
        case .planner: "list.bullet"
        case .agent: "chevron.left.forwardslash.chevron.right"
        case .review: "eye"
        case .ci: "checkmark.square"
        case .mergeQueue: "arrow.triangle.branch"
        case .loop: "arrow.trianglehead.2.clockwise"
        case .human: "person"
        case .output: "flag"
        case .unknown: "questionmark.square"
        }
    }
}
