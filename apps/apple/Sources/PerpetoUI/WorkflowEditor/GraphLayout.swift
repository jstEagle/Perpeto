import PerpetoKit
import SwiftUI

/// Geometry for drawing a workflow graph as a precise ruled drawing:
/// fixed node sizes, ports on card edges, right-angle edge routing.
public struct GraphLayout {
    public static let nodeWidth: CGFloat = 168
    public static let grid: CGFloat = 16
    public static let margin: CGFloat = 48

    public var graph: WorkflowGraph
    public var nodeHeight: CGFloat
    /// Live positions while dragging, overriding stored positions.
    public var overrides: [String: CGPoint]
    /// Stored positions assume 76 pt cards on a 180 pt row pitch. Taller
    /// live cards stretch rows so the gaps between rows keep their lanes.
    private let rowStretch: CGFloat
    private let topY: CGFloat
    /// Lane index per edge, assigned in edge order so lanes never overlap.
    private var lanes: [String: Int] = [:]

    public static let baseNodeHeight: CGFloat = 76
    public static let rowGap: CGFloat = 104

    public init(graph: WorkflowGraph, nodeHeight: CGFloat, overrides: [String: CGPoint] = [:]) {
        self.graph = graph
        self.nodeHeight = nodeHeight
        self.overrides = overrides
        rowStretch = (nodeHeight + Self.rowGap) / (Self.baseNodeHeight + Self.rowGap)
        topY = graph.nodes.map(\.position.y).min() ?? 0
        var lane = 0
        for edge in graph.edges where edge.kind != .flow || needsLane(edge) {
            lanes[edge.id] = lane
            lane += 1
        }
    }

    public func origin(_ node: GraphNode) -> CGPoint {
        if let override = overrides[node.id] { return override }
        return CGPoint(x: node.position.x, y: topY + (node.position.y - topY) * rowStretch)
    }

    public func frame(_ node: GraphNode) -> CGRect {
        CGRect(origin: origin(node), size: CGSize(width: Self.nodeWidth, height: nodeHeight))
    }

    public func frame(id: String) -> CGRect? { graph.node(id).map(frame) }

    /// Port positions on the card edge.
    public func point(_ node: GraphNode, port: GraphPort) -> CGPoint {
        let f = frame(node)
        switch port {
        case .in: return CGPoint(x: f.minX, y: f.minY + 38)
        case .out: return CGPoint(x: f.maxX, y: f.minY + 38)
        case .pass: return CGPoint(x: f.maxX, y: f.minY + 30)
        case .fail: return CGPoint(x: f.maxX, y: f.minY + 52)
        case .role: return CGPoint(x: f.midX, y: f.maxY)
        }
    }

    /// Size that contains every node plus room for lanes and labels.
    public var contentSize: CGSize {
        let frames = graph.nodes.map(frame)
        let maxX = frames.map(\.maxX).max() ?? 0
        let maxY = frames.map(\.maxY).max() ?? 0
        return CGSize(width: max(maxX + Self.margin, 640), height: max(maxY + Self.margin + 48, 360))
    }

    public static func snap(_ value: CGFloat) -> CGFloat { (value / grid).rounded() * grid }

    // MARK: Routing

    public struct Route {
        public var points: [CGPoint]
        /// Where a traffic count or label sits.
        public var labelPoint: CGPoint
    }

    private enum Relation { case sameRow, below, above }

    private func relation(_ a: CGRect, _ b: CGRect) -> Relation {
        if b.minY >= a.maxY { return .below }
        if b.maxY <= a.minY { return .above }
        return .sameRow
    }

    private func needsLane(_ edge: GraphEdge) -> Bool {
        guard let a = graph.node(edge.from.node), let b = graph.node(edge.to.node) else { return false }
        let fa = CGRect(origin: CGPoint(x: a.position.x, y: a.position.y), size: CGSize(width: Self.nodeWidth, height: Self.baseNodeHeight))
        let fb = CGRect(origin: CGPoint(x: b.position.x, y: b.position.y), size: CGSize(width: Self.nodeWidth, height: Self.baseNodeHeight))
        return relation(fa, fb) != .sameRow || fb.minX <= fa.maxX
    }

    private func laneOffset(_ edge: GraphEdge) -> CGFloat { 16 + CGFloat(lanes[edge.id] ?? 0) * 9 }

    /// Orthogonal route for an edge. Edges between rows run in numbered lanes
    /// in the gap between them, like a carriage return; edges that go back
    /// within a row run above it.
    public func route(_ edge: GraphEdge) -> Route? {
        guard let from = graph.node(edge.from.node), let to = graph.node(edge.to.node) else { return nil }
        switch edge.kind {
        case .flow, .unknown:
            let port = edge.from.port.flatMap(GraphPort.init(rawValue:)) ?? .out
            return flowRoute(edge, from: frame(from), to: frame(to), p1: point(from, port: port), p2: point(to, port: .in))
        case .delegates, .messages:
            return roleRoute(edge, from: frame(from), to: frame(to))
        }
    }

    private func flowRoute(_ edge: GraphEdge, from a: CGRect, to b: CGRect, p1: CGPoint, p2: CGPoint) -> Route {
        let lane: CGFloat
        switch relation(a, b) {
        case .sameRow where p2.x > p1.x + 24:
            if abs(p1.y - p2.y) < 1 {
                return Route(points: [p1, p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: p1.y))
            }
            let midX = Self.snapHalf((p1.x + p2.x) / 2)
            return Route(points: [p1, CGPoint(x: midX, y: p1.y), CGPoint(x: midX, y: p2.y), p2], labelPoint: CGPoint(x: midX, y: (p1.y + p2.y) / 2))
        case .sameRow:
            lane = min(a.minY, b.minY) - laneOffset(edge)
        case .below:
            lane = a.maxY + laneOffset(edge)
        case .above:
            lane = b.maxY + laneOffset(edge)
        }
        let out = p1.x + 12
        let inX = p2.x - 12
        let points = [p1, CGPoint(x: out, y: p1.y), CGPoint(x: out, y: lane), CGPoint(x: inX, y: lane), CGPoint(x: inX, y: p2.y), p2]
        return Route(points: points, labelPoint: CGPoint(x: (out + inX) / 2, y: lane))
    }

    private func roleRoute(_ edge: GraphEdge, from a: CGRect, to b: CGRect) -> Route {
        let index = CGFloat(lanes[edge.id] ?? 0)
        let shift = (index.truncatingRemainder(dividingBy: 3) - 1) * 12
        switch relation(a, b) {
        case .sameRow:
            let lane = max(a.maxY, b.maxY) + laneOffset(edge)
            let p1 = CGPoint(x: a.midX + shift, y: a.maxY), p2 = CGPoint(x: b.midX + shift, y: b.maxY)
            return Route(points: [p1, CGPoint(x: p1.x, y: lane), CGPoint(x: p2.x, y: lane), p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: lane))
        case .below:
            let lane = a.maxY + laneOffset(edge)
            let p1 = CGPoint(x: a.midX + shift, y: a.maxY), p2 = CGPoint(x: b.midX + shift, y: b.minY)
            return Route(points: [p1, CGPoint(x: p1.x, y: lane), CGPoint(x: p2.x, y: lane), p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: lane))
        case .above:
            let lane = b.maxY + laneOffset(edge)
            let p1 = CGPoint(x: a.midX + shift, y: a.minY), p2 = CGPoint(x: b.midX + shift, y: b.maxY)
            return Route(points: [p1, CGPoint(x: p1.x, y: lane), CGPoint(x: p2.x, y: lane), p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: lane))
        }
    }

    /// Route between two node tops, used for unplanned interactions.
    public func unplannedRoute(fromId: String, toId: String, index: Int) -> Route? {
        guard let from = graph.node(fromId), let to = graph.node(toId) else { return nil }
        let a = frame(from)
        let b = frame(to)
        let lane = min(a.minY, b.minY) - 14 - CGFloat(index) * 9
        let start = CGPoint(x: a.midX + 24, y: a.minY)
        let end = CGPoint(x: b.midX + 24, y: b.minY)
        return Route(points: [start, CGPoint(x: start.x, y: lane), CGPoint(x: end.x, y: lane), end], labelPoint: CGPoint(x: (start.x + end.x) / 2, y: lane))
    }

    static func snapHalf(_ v: CGFloat) -> CGFloat { (v / 4).rounded() * 4 }

    /// Nearest edge to a point within `tolerance`, for click selection.
    public func edge(at point: CGPoint, tolerance: CGFloat = 6) -> GraphEdge? {
        var best: (GraphEdge, CGFloat)?
        for edge in graph.edges {
            guard let route = route(edge) else { continue }
            for (a, b) in zip(route.points, route.points.dropFirst()) {
                let d = Self.distance(point, a, b)
                if d <= tolerance, d < (best?.1 ?? .infinity) { best = (edge, d) }
            }
        }
        return best?.0
    }

    static func distance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0 else { return hypot(p.x - a.x, p.y - a.y) }
        let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }
}

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
