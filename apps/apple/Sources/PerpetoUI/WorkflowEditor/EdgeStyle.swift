import PerpetoKit
import SwiftUI

extension Path {
    /// Polyline with rounded corners matching the 6 pt control radius.
    static func rounded(_ points: [CGPoint], radius: CGFloat = PerpetoRadius.control) -> Path {
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

// MARK: Edge appearance

/// One meaning per line style, consistent across editor, diff and live map.
public enum EdgeStyle {
    public static func color(_ kind: GraphEdge.Kind) -> Color {
        switch kind {
        case .flow, .unknown: PerpetoColor.ink
        case .delegates: PerpetoColor.controlBorder
        case .messages: PerpetoColor.muted
        }
    }

    public static func stroke(_ kind: GraphEdge.Kind, width: CGFloat = 1.5) -> StrokeStyle {
        switch kind {
        case .flow, .unknown: StrokeStyle(lineWidth: width, lineCap: .butt, lineJoin: .round)
        case .delegates: StrokeStyle(lineWidth: width, lineCap: .butt, lineJoin: .round, dash: [7, 4])
        case .messages: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: [0.5, 4.5])
        }
    }

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

    /// End markers: a filled arrow for flow, an open arrow for delegation,
    /// round terminals at both ends for messaging.
    static func drawMarkers(_ context: inout GraphicsContext, kind: GraphEdge.Kind, points: [CGPoint], color: Color) {
        guard points.count >= 2 else { return }
        let end = points[points.count - 1]
        let before = points[points.count - 2]
        let angle = atan2(end.y - before.y, end.x - before.x)
        switch kind {
        case .flow, .unknown:
            context.fill(arrow(at: end, angle: angle, length: 7, width: 5), with: .color(color))
        case .delegates:
            context.stroke(openArrow(at: end, angle: angle, length: 7, width: 5), with: .color(color), lineWidth: 1.5)
        case .messages:
            for p in [points[0], end] {
                context.fill(Path(ellipseIn: CGRect(x: p.x - 2.5, y: p.y - 2.5, width: 5, height: 5)), with: .color(color))
            }
        }
    }

    static func arrow(at tip: CGPoint, angle: CGFloat, length: CGFloat, width: CGFloat) -> Path {
        var path = Path()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle) + width * sin(angle), y: tip.y - length * sin(angle) - width * cos(angle)))
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle) - width * sin(angle), y: tip.y - length * sin(angle) + width * cos(angle)))
        path.closeSubpath()
        return path
    }

    static func openArrow(at tip: CGPoint, angle: CGFloat, length: CGFloat, width: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: tip.x - length * cos(angle) + width * sin(angle), y: tip.y - length * sin(angle) - width * cos(angle)))
        path.addLine(to: tip)
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle) - width * sin(angle), y: tip.y - length * sin(angle) + width * cos(angle)))
        return path
    }
}

extension NodeType {
    public var systemImage: String {
        switch self {
        case .input: "tray.and.arrow.down"
        case .planner: "list.bullet.rectangle"
        case .agent: "hammer"
        case .review: "checkmark.seal"
        case .ci: "checklist"
        case .mergeQueue: "arrow.triangle.merge"
        case .loop: "arrow.triangle.2.circlepath"
        case .human: "person"
        case .output: "shippingbox"
        case .unknown: "questionmark.square"
        }
    }
}
