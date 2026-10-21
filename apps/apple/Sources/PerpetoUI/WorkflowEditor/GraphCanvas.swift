import PerpetoKit
import SwiftUI

public enum GraphSelection: Hashable, Sendable {
    case node(String)
    case edge(String)

    public var nodeId: String? {
        if case .node(let id) = self { return id }
        return nil
    }

    public var edgeId: String? {
        if case .edge(let id) = self { return id }
        return nil
    }
}

/// Live state drawn over the approved graph during a run.
public struct LiveOverlay: Equatable {
    public struct Unplanned: Equatable, Identifiable {
        public var from: String
        public var to: String
        public var kind: GraphEdge.Kind
        public var count: Int
        public var id: String { "\(from)>\(to):\(kind.rawValue)" }
    }

    public var metrics: MetricsSnapshot
    public var workItems: [WorkItem]
    public var unplanned: [Unplanned]

    public init(metrics: MetricsSnapshot, workItems: [WorkItem], events: [HubEvent]) {
        self.metrics = metrics
        self.workItems = workItems
        var counts: [String: Unplanned] = [:]
        for event in events where event.isUnplanned {
            guard let from = event.sourceNodeId, let to = event.targetNodeId else { continue }
            let kind: GraphEdge.Kind = event.interaction == .agentDelegated ? .delegates : event.interaction == .agentMessaged ? .messages : .flow
            let key = "\(from)>\(to):\(kind.rawValue)"
            counts[key, default: Unplanned(from: from, to: to, kind: kind, count: 0)].count += 1
        }
        // Prefer the hub's measured count when it reports the same pair.
        for metric in metrics.edges where metric.unplanned {
            guard let from = metric.from, let to = metric.to, from != "?", to != "?" else { continue }
            counts["\(from)>\(to):\(metric.kind.rawValue)"] = Unplanned(from: from, to: to, kind: metric.kind, count: metric.count)
        }
        unplanned = counts.values.sorted { $0.id < $1.id }
    }

    /// Unplanned interactions drawn like role edges, outside the flow band.
    var edges: [GraphEdge] {
        unplanned.map { GraphEdge(id: "unplanned:" + $0.id, from: .init(node: $0.from), to: .init(node: $0.to), kind: $0.kind) }
    }
}

/// Which delegates and messages edges the canvas draws.
public enum RoleEdgeScope: String, CaseIterable, Hashable, Sendable {
    case all, selected

    public var title: String {
        switch self {
        case .all: "All roles"
        case .selected: "Selected node"
        }
    }
}

public enum GraphMode: Equatable {
    case view
    case edit(issues: [ValidationIssue])
    case diff(WorkflowDiff)
    case live(LiveOverlay)

    var nodeHeight: CGFloat {
        if case .live = self { return 156 }
        return 76
    }

    var isLive: Bool {
        if case .live = self { return true }
        return false
    }
}

/// Draws a workflow graph on a ruled surface. One component serves the
/// editor, the draft diff and the live run map so the drawing stays identical.
public struct GraphCanvas: View {
    var graph: WorkflowGraph
    var mode: GraphMode
    @Binding var selection: GraphSelection?
    var zoom: CGFloat
    /// Unscaled minimum drawing size, so the ruling fills the viewport.
    var minSize: CGSize
    var editable: Bool
    var connectKind: GraphEdge.Kind
    var roleScope: RoleEdgeScope
    var onMove: (String, GraphNode.Position) -> Void
    var onConnect: (GraphEdge.Endpoint, GraphEdge.Endpoint, GraphEdge.Kind) -> Void

    @State private var dragOverrides: [String: CGPoint] = [:]
    @State private var dragStart: [String: CGPoint] = [:]
    @State private var pending: (from: GraphEdge.Endpoint, start: CGPoint, end: CGPoint)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        graph: WorkflowGraph, mode: GraphMode, selection: Binding<GraphSelection?>, zoom: CGFloat = 1, minSize: CGSize = .zero, editable: Bool = false,
        connectKind: GraphEdge.Kind = .messages, roleScope: RoleEdgeScope = .all,
        onMove: @escaping (String, GraphNode.Position) -> Void = { _, _ in },
        onConnect: @escaping (GraphEdge.Endpoint, GraphEdge.Endpoint, GraphEdge.Kind) -> Void = { _, _, _ in }
    ) {
        self.graph = graph
        self.mode = mode
        _selection = selection
        self.zoom = zoom
        self.minSize = minSize
        self.editable = editable
        self.connectKind = connectKind
        self.roleScope = roleScope
        self.onMove = onMove
        self.onConnect = onConnect
    }

    private var layout: GraphLayout { Self.layout(graph: graph, mode: mode, overrides: dragOverrides) }

    /// The one layout used by the canvas and the viewport's fit calculation.
    static func layout(graph: WorkflowGraph, mode: GraphMode, overrides: [String: CGPoint] = [:]) -> GraphLayout {
        var g = graph
        var extra: [GraphEdge] = []
        switch mode {
        case .diff(let diff):
            // Removed nodes and edges are routed too, so they draw as ghosts.
            g.nodes += diff.removedNodes.filter { r in !g.nodes.contains { $0.id == r.id } }
            g.edges += diff.removedEdges.filter { r in !g.edges.contains { $0.id == r.id } }
        case .live(let live): extra = live.edges
        default: break
        }
        return GraphLayout(graph: g, nodeHeight: mode.nodeHeight, overrides: overrides, extraRoleEdges: extra)
    }

    private func isRole(_ edge: GraphEdge) -> Bool { edge.kind == .delegates || edge.kind == .messages }

    /// Role edges follow the scope; flow edges are always drawn.
    private func isVisible(_ edge: GraphEdge) -> Bool {
        guard isRole(edge) || edge.id.hasPrefix("unplanned:"), roleScope == .selected else { return true }
        switch selection {
        case .node(let id): return edge.from.node == id || edge.to.node == id
        case .edge(let id): return edge.id == id
        case nil: return false
        }
    }

    public var body: some View {
        let layout = self.layout
        let content = layout.contentSize
        let size = CGSize(width: max(content.width, minSize.width), height: max(content.height, minSize.height))
        ZStack(alignment: .topLeading) {
            RuledGrid()
            edgesLayer(layout)
                .allowsHitTesting(false)
            ForEach(layout.graph.nodes) { node in
                nodeView(node, layout: layout)
            }
            if editable { portHandles(layout) }
            edgeLabels(layout)
                .allowsHitTesting(false)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .coordinateSpace(name: "graph")
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .named("graph")) { location in
            selection = layout.edge(at: location, where: isVisible).map { .edge($0.id) }
        }
        .scaleEffect(zoom, anchor: .topLeading)
        .frame(width: size.width * zoom, height: size.height * zoom, alignment: .topLeading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: mode)
    }

    // MARK: Nodes

    @ViewBuilder
    private func nodeView(_ node: GraphNode, layout: GraphLayout) -> some View {
        let frame = layout.frame(node)
        NodeCard(node: node, mode: mode, selected: selection == .node(node.id))
            .frame(width: frame.width, height: frame.height)
            .position(x: frame.midX, y: frame.midY)
            .onTapGesture { selection = .node(node.id) }
            .gesture(editable ? dragGesture(node, layout: layout) : nil)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }

    private func dragGesture(_ node: GraphNode, layout: GraphLayout) -> some Gesture {
        DragGesture(minimumDistance: 3, coordinateSpace: .named("graph"))
            .onChanged { value in
                let start = dragStart[node.id] ?? CGPoint(x: node.position.x, y: node.position.y)
                dragStart[node.id] = start
                selection = .node(node.id)
                dragOverrides[node.id] = CGPoint(x: max(16, start.x + value.translation.width), y: max(64, start.y + value.translation.height))
            }
            .onEnded { _ in
                if let p = dragOverrides[node.id] {
                    onMove(node.id, .init(x: GraphLayout.snap(p.x), y: GraphLayout.snap(p.y)))
                }
                dragOverrides[node.id] = nil
                dragStart[node.id] = nil
            }
    }

    // MARK: Ports

    @ViewBuilder
    private func portHandles(_ layout: GraphLayout) -> some View {
        ForEach(layout.graph.nodes) { node in
            ForEach(node.type.outputPorts + (node.type.isAgentRole ? [GraphPort.role] : []), id: \.self) { port in
                let p = layout.point(node, port: port)
                PortHandle(port: port)
                    .position(p)
                    .gesture(
                        DragGesture(minimumDistance: 2, coordinateSpace: .named("graph"))
                            .onChanged { value in
                                pending = (GraphEdge.Endpoint(node: node.id, port: port == .out ? nil : port.rawValue), p, value.location)
                            }
                            .onEnded { value in
                                defer { pending = nil }
                                guard let target = layout.graph.nodes.first(where: { layout.frame($0).insetBy(dx: -8, dy: -8).contains(value.location) }),
                                      target.id != node.id || port == .role else { return }
                                if port == .role {
                                    onConnect(.init(node: node.id, port: "role"), .init(node: target.id, port: "role"), connectKind)
                                } else {
                                    onConnect(.init(node: node.id, port: port == .out ? nil : port.rawValue), .init(node: target.id), .flow)
                                }
                            })
                    .help(port == .role ? "Drag to another agent role to add a \(EdgeStyle.title(connectKind).lowercased()) edge" : "Drag to a node to add a flow edge from \(port.rawValue)")
            }
        }
    }

    // MARK: Edges

    private func edgesLayer(_ layout: GraphLayout) -> some View {
        Canvas { context, _ in
            let selectedEdge = selection?.edgeId
            let selectedNode = selection?.nodeId

            /// Paper-coloured halo first, so a line drawn later breaks the
            /// lines it crosses, like a bridge on a wiring drawing.
            func draw(_ points: [CGPoint], kind: GraphEdge.Kind, color: Color, width: CGFloat, style: StrokeStyle? = nil) {
                let path = Path.rounded(points)
                context.stroke(path, with: .color(PerpetoColor.surface), style: StrokeStyle(lineWidth: width + 4, lineCap: .butt, lineJoin: .round))
                context.stroke(path, with: .color(color), style: style ?? EdgeStyle.stroke(kind, width: kind == .messages ? width + 0.75 : width))
                EdgeStyle.drawMarkers(&context, kind: kind, points: points, color: color)
            }

            if case .diff(let diff) = mode {
                for edge in diff.removedEdges {
                    guard let route = layout.route(edge) else { continue }
                    draw(route.points, kind: edge.kind, color: PerpetoColor.error.opacity(0.7), width: 1.5, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                }
            }

            // Roles first, flow on top: work movement is the primary reading.
            let ordered = graph.edges.filter { isRole($0) } + graph.edges.filter { !isRole($0) }
            for edge in ordered where isVisible(edge) {
                guard let route = layout.route(edge) else { continue }
                var color = EdgeStyle.color(edge.kind)
                var width: CGFloat = 1.5
                var opacity = 1.0
                switch mode {
                case .diff(let diff):
                    if diff.edges[edge.id] == .added {
                        color = PerpetoColor.success
                        width = 2
                    } else {
                        opacity = 0.4
                    }
                case .live(let live):
                    if let metric = live.metrics.edge(edge.id) {
                        let maxCount = Double(live.metrics.edges.map(\.count).max() ?? 1)
                        width = 1.25 + 1.75 * CGFloat(Double(metric.count) / max(maxCount, 1))
                    } else {
                        opacity = 0.5
                    }
                    if let selectedNode, edge.from.node != selectedNode, edge.to.node != selectedNode { opacity *= 0.35 }
                case .edit(let issues):
                    if issues.contains(where: { $0.edgeId == edge.id && $0.severity == .error }) { color = PerpetoColor.error }
                    if let selectedNode, isRole(edge), edge.from.node != selectedNode, edge.to.node != selectedNode { opacity = 0.35 }
                case .view:
                    if let selectedNode, isRole(edge), edge.from.node != selectedNode, edge.to.node != selectedNode { opacity = 0.35 }
                }
                if selectedEdge == edge.id {
                    // Selection is accent at the selection stroke, like selected nodes.
                    color = PerpetoColor.accent
                    width = max(width, 2)
                    opacity = 1
                }
                draw(route.points, kind: edge.kind, color: color.opacity(opacity), width: width)
            }

            if case .live(let live) = mode {
                for edge in live.edges where isVisible(edge) {
                    guard let route = layout.route(edge) else { continue }
                    var opacity = 1.0
                    if let selectedNode, edge.from.node != selectedNode, edge.to.node != selectedNode { opacity = 0.35 }
                    draw(route.points, kind: .flow, color: PerpetoColor.error.opacity(opacity), width: 1.75,
                         style: StrokeStyle(lineWidth: 1.75, lineCap: .round, dash: [0.5, 4.5]))
                }
            }

            if let pending {
                let mid = CGPoint(x: (pending.start.x + pending.end.x) / 2, y: pending.start.y)
                let points = [pending.start, mid, CGPoint(x: mid.x, y: pending.end.y), pending.end]
                let kind: GraphEdge.Kind = pending.from.port == "role" ? connectKind : .flow
                context.stroke(Path.rounded(points), with: .color(PerpetoColor.focus), style: EdgeStyle.stroke(kind, width: 1.5))
            }
        }
    }

    private func liveLabels(_ live: LiveOverlay) -> [EdgeLabel] {
        let flow = graph.edges.filter { !isRole($0) }
        let roles = graph.edges.filter { isRole($0) && isVisible($0) }
        let counts = (flow + roles).compactMap { edge in
            live.metrics.edge(edge.id).map { EdgeLabel(id: edge.id, text: "\($0.count)", color: EdgeStyle.color(edge.kind)) }
        }
        let unplanned = zip(live.unplanned, live.edges).filter { isVisible($0.1) }.map {
            EdgeLabel(id: $0.1.id, text: "Unplanned \($0.0.count)", color: PerpetoColor.error)
        }
        return counts + unplanned
    }

    private struct EdgeLabel: Identifiable {
        var id: String
        var text: String
        var color: Color
    }

    /// Counts on the live map. Flow first so it gets the preferred spots,
    /// then roles, then unplanned interactions; no two labels overlap.
    @ViewBuilder
    private func edgeLabels(_ layout: GraphLayout) -> some View {
        if case .live(let live) = mode {
            let labels = liveLabels(live)
            let positions = layout.placeLabels(labels.map { .init(edgeId: $0.id, size: CountPill.size(for: $0.text)) })
            ForEach(labels) { label in
                if let point = positions[label.id] {
                    CountPill(text: label.text, color: label.color).position(point)
                }
            }
        }
    }
}

struct CountPill: View {
    var text: String
    var color: Color

    /// Measured size of the pill for label placement: 12 pt mono is 7.2 pt per glyph.
    static func size(for text: String) -> CGSize { CGSize(width: CGFloat(text.count) * 7.25 + 10, height: 18) }
    var body: some View {
        Text(text)
            .font(PerpetoFont.mono().monospacedDigit())
            .foregroundStyle(color == PerpetoColor.error ? PerpetoColor.error : PerpetoColor.ink)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: 3))
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(color.opacity(0.5)))
            .fixedSize()
    }
}

struct PortHandle: View {
    var port: GraphPort
    @State private var hovering = false

    var body: some View {
        ZStack {
            Color.clear.frame(width: 16, height: 16).contentShape(Rectangle())
            if port == .role {
                Rectangle().fill(PerpetoColor.surface).frame(width: 7, height: 7)
                    .overlay(Rectangle().strokeBorder(PerpetoColor.controlBorder, lineWidth: 1.25))
                    .rotationEffect(.degrees(45))
            } else {
                Circle().fill(color).frame(width: hovering ? 10 : 8, height: hovering ? 10 : 8)
                    .overlay(Circle().strokeBorder(PerpetoColor.surface, lineWidth: 1.5))
            }
        }
        .onHover { hovering = $0 }
    }

    var color: Color {
        switch port {
        case .pass: PerpetoColor.success
        case .fail: PerpetoColor.error
        default: PerpetoColor.ink
        }
    }
}

/// Engineering-paper ruling: 16 pt minor lines, 64 pt major lines.
public struct RuledGrid: View {
    public init() {}
    public var body: some View {
        Canvas { context, size in
            var minor = Path()
            var major = Path()
            var x: CGFloat = 0
            while x <= size.width {
                var p = Path()
                p.move(to: CGPoint(x: x + 0.5, y: 0))
                p.addLine(to: CGPoint(x: x + 0.5, y: size.height))
                if Int(x) % Int(PerpetoEditor.gridMajor) == 0 { major.addPath(p) } else { minor.addPath(p) }
                x += GraphLayout.grid
            }
            var y: CGFloat = 0
            while y <= size.height {
                var p = Path()
                p.move(to: CGPoint(x: 0, y: y + 0.5))
                p.addLine(to: CGPoint(x: size.width, y: y + 0.5))
                if Int(y) % Int(PerpetoEditor.gridMajor) == 0 { major.addPath(p) } else { minor.addPath(p) }
                y += GraphLayout.grid
            }
            context.stroke(minor, with: .color(PerpetoColor.gridMinor), lineWidth: 0.5)
            context.stroke(major, with: .color(PerpetoColor.gridMajor), lineWidth: 0.75)
        }
        .background(PerpetoColor.surface)
    }
}
