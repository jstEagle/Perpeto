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

    /// Live nodes carry a stat line and a meter; drawings only a name and meta.
    var nodeHeight: CGFloat {
        if case .live = self { return 120 }
        return 88
    }

    var isLive: Bool {
        if case .live = self { return true }
        return false
    }
}

/// Draws a workflow graph on a quiet dotted field. One component serves the
/// editor, the draft diff and the live run map so the drawing stays identical.
public struct GraphCanvas: View {
    var graph: WorkflowGraph
    var mode: GraphMode
    @Binding var selection: GraphSelection?
    var zoom: CGFloat
    /// Unscaled minimum drawing size, so the field fills the viewport.
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

    private var layout: GraphLayout {
        Self.layout(graph: graph, mode: mode, overrides: dragOverrides, include: isVisible)
    }

    /// The one layout used by the canvas and the viewport's fit calculation.
    /// Hidden role edges are left out so they reserve no space.
    static func layout(graph: WorkflowGraph, mode: GraphMode, overrides: [String: CGPoint] = [:], include: (GraphEdge) -> Bool = { _ in true }) -> GraphLayout {
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
        return GraphLayout(graph: g, nodeHeight: mode.nodeHeight, overrides: overrides, extraRoleEdges: extra, includeRole: include)
    }

    private func isRole(_ edge: GraphEdge) -> Bool { edge.kind == .delegates || edge.kind == .messages }

    /// Role edges follow the scope; flow edges are always drawn.
    func isVisible(_ edge: GraphEdge) -> Bool {
        guard isRole(edge) || edge.id.hasPrefix("unplanned:"), roleScope == .selected else { return true }
        switch selection {
        case .node(let id): return edge.from.node == id || edge.to.node == id
        case .edge(let id): return edge.id == id
        case nil: return false
        }
    }

    /// The look of an edge in the current mode.
    func look(_ edge: GraphEdge) -> EdgeLook {
        switch edge.kind {
        case .delegates: return .delegates
        case .messages: return .messages
        case .flow, .unknown:
            if case .live(let live) = mode {
                let count = live.metrics.edge(edge.id)?.count ?? 0
                return count > 0 ? .flowing : .notReached
            }
            if case .diff(let diff) = mode, diff.edges[edge.id] == .added { return .flowing }
            return .flow
        }
    }

    /// Looks on screen, for the legend.
    var looksOnScreen: [EdgeLook] {
        var looks = Set(graph.edges.filter(isVisible).map(look))
        if case .live(let live) = mode, !live.unplanned.isEmpty, live.edges.contains(where: isVisible) { looks.insert(.unplanned) }
        if mode.isLive { looks.remove(.flow) } else { looks.insert(.flow) }
        return EdgeLook.allCases.filter(looks.contains)
    }

    public var body: some View {
        let layout = self.layout
        let content = layout.contentSize
        let size = CGSize(width: max(content.width, minSize.width), height: max(content.height, minSize.height))
        ZStack(alignment: .topLeading) {
            DotGrid()
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
            withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) {
                selection = layout.edge(at: location, where: isVisible).map { .edge($0.id) }
            }
        }
        .scaleEffect(zoom, anchor: .topLeading)
        .frame(width: size.width * zoom, height: size.height * zoom, alignment: .topLeading)
        .animation(PerpetoMotion.easeOut(reduceMotion: reduceMotion), value: mode)
    }

    // MARK: Nodes

    @ViewBuilder
    private func nodeView(_ node: GraphNode, layout: GraphLayout) -> some View {
        let frame = layout.frame(node)
        let selected = selection == .node(node.id)
        NodeCard(node: node, mode: mode, selected: selected, lifted: dragOverrides[node.id] != nil)
            .frame(width: frame.width, height: frame.height)
            .position(x: frame.midX, y: frame.midY)
            .onTapGesture {
                withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) { selection = .node(node.id) }
            }
            .gesture(editable ? dragGesture(node, layout: layout) : nil)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func dragGesture(_ node: GraphNode, layout: GraphLayout) -> some Gesture {
        DragGesture(minimumDistance: 3, coordinateSpace: .named("graph"))
            .onChanged { value in
                let start = dragStart[node.id] ?? CGPoint(x: node.position.x, y: node.position.y)
                dragStart[node.id] = start
                selection = .node(node.id)
                dragOverrides[node.id] = CGPoint(x: max(0, start.x + value.translation.width / layout.xScale), y: max(0, start.y + value.translation.height))
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
            ForEach(Array(Set(node.type.outputPorts.map { $0 == .pass ? GraphPort.out : $0 })).sorted { $0.rawValue < $1.rawValue } + (node.type.isAgentRole ? [GraphPort.role] : []), id: \.self) { port in
                let p = layout.point(node, port: port)
                let connected = graph.edges.contains { $0.from.node == node.id && (($0.from.port ?? "out") == port.rawValue || (port == .out && $0.from.port == "pass")) }
                PortHandle(connected: connected)
                    .position(p)
                    .gesture(
                        DragGesture(minimumDistance: 2, coordinateSpace: .named("graph"))
                            .onChanged { value in
                                let from = port == .out ? (node.type.hasPassFail ? "pass" : nil) : port.rawValue
                                pending = (GraphEdge.Endpoint(node: node.id, port: from), p, value.location)
                            }
                            .onEnded { value in
                                defer { pending = nil }
                                guard let target = layout.graph.nodes.first(where: { layout.frame($0).insetBy(dx: -8, dy: -8).contains(value.location) }),
                                      target.id != node.id || port == .role else { return }
                                if port == .role {
                                    onConnect(.init(node: node.id, port: "role"), .init(node: target.id, port: "role"), connectKind)
                                } else {
                                    let from = port == .out ? (node.type.hasPassFail ? "pass" : nil) : port.rawValue
                                    onConnect(.init(node: node.id, port: from), .init(node: target.id), .flow)
                                }
                            })
                    .help(port == .role ? "Drag to another agent role to add a \(EdgeStyle.title(connectKind).lowercased()) edge" : "Drag to a step to send work \(port == .fail ? "that fails" : "onward")")
                    .accessibilityLabel(port == .role ? "Role port of \(node.label)" : "\(port == .fail ? "Fail" : "Output") port of \(node.label)")
            }
        }
    }

    // MARK: Edges

    private func edgesLayer(_ layout: GraphLayout) -> some View {
        Canvas { context, _ in
            let selectedEdge = selection?.edgeId
            let selectedNode = selection?.nodeId

            func draw(_ points: [CGPoint], look: EdgeLook, opacity: Double = 1, emphasis: Bool = false) {
                var style = look.stroke
                if emphasis { style.lineWidth = PerpetoStroke.selection + 0.5 }
                context.stroke(Path.rounded(points), with: .color((emphasis ? PerpetoColor.ink : look.color).opacity(opacity)), style: style)
            }

            if case .diff(let diff) = mode {
                for edge in diff.removedEdges {
                    guard let route = layout.route(edge) else { continue }
                    draw(route.points, look: .notReached, opacity: 0.6)
                }
            }

            let ordered = graph.edges.filter { isRole($0) } + graph.edges.filter { !isRole($0) }
            for edge in ordered where isVisible(edge) {
                guard let route = layout.route(edge) else { continue }
                var opacity = 1.0
                if case .diff(let diff) = mode, diff.edges[edge.id] != .added { opacity = 0.55 }
                if let selectedNode, edge.from.node != selectedNode, edge.to.node != selectedNode, isRole(edge) || mode.isLive { opacity *= 0.4 }
                draw(route.points, look: look(edge), opacity: opacity, emphasis: selectedEdge == edge.id)
            }

            if case .live(let live) = mode {
                for edge in live.edges where isVisible(edge) {
                    guard let route = layout.route(edge) else { continue }
                    var opacity = 1.0
                    if let selectedNode, edge.from.node != selectedNode, edge.to.node != selectedNode { opacity = 0.4 }
                    draw(route.points, look: .unplanned, opacity: opacity)
                }
            }

            if let pending {
                let mid = CGPoint(x: (pending.start.x + pending.end.x) / 2, y: pending.start.y)
                let points = [pending.start, mid, CGPoint(x: mid.x, y: pending.end.y), pending.end]
                context.stroke(Path.rounded(points), with: .color(PerpetoColor.ink), style: StrokeStyle(lineWidth: PerpetoStroke.edgeActive, lineCap: .round, dash: [3, 4]))
            }
        }
    }

    private struct EdgeLabel: Identifiable {
        var id: String
        var text: String
    }

    /// Counts on the live map, in pills that the line seems to pass behind.
    private func liveLabels(_ live: LiveOverlay, layout: GraphLayout) -> [EdgeLabel] {
        let flow = graph.edges.filter { !isRole($0) }
        let roles = graph.edges.filter { isRole($0) && isVisible($0) }
        let counts: [EdgeLabel] = (flow + roles).compactMap { edge in
            guard let metric = live.metrics.edge(edge.id), metric.count > 0 else { return nil }
            let returned = layout.route(edge)?.isReturn == true
            return EdgeLabel(id: edge.id, text: returned ? "\(metric.count) returned" : "\(metric.count)")
        }
        let unplanned = zip(live.unplanned, live.edges).filter { isVisible($0.1) }.map {
            EdgeLabel(id: $0.1.id, text: "\($0.0.count) unplanned")
        }
        return counts + unplanned
    }

    @ViewBuilder
    private func edgeLabels(_ layout: GraphLayout) -> some View {
        if case .live(let live) = mode {
            let labels = liveLabels(live, layout: layout)
            let positions = layout.placeLabels(labels.map { .init(edgeId: $0.id, size: CountPill.size(for: $0.text)) })
            ForEach(labels) { label in
                if let point = positions[label.id] {
                    CountPill(text: label.text).position(point)
                }
            }
        }
    }
}

/// An edge count in 12 pt muted tabular figures, inside a pill filled with
/// the field colour so the line seems to pass behind it.
struct CountPill: View {
    var text: String

    /// 12 pt text is about 6.6 pt per glyph, plus 8 pt padding either side.
    static func size(for text: String) -> CGSize { CGSize(width: CGFloat(text.count) * 6.6 + 16, height: 20) }

    var body: some View {
        Text(text)
            .font(PerpetoFont.small.monospacedDigit())
            .foregroundStyle(PerpetoColor.muted)
            .padding(.horizontal, PerpetoSpacing.x(2))
            .frame(height: 20)
            .background(Capsule().fill(PerpetoColor.editorCanvas))
            .fixedSize()
    }
}

/// Editor port: an 8 pt circle on the card edge. Open ports are a ring;
/// connected ports are solid. Hover darkens the ring to ink.
struct PortHandle: View {
    var connected: Bool
    @State private var hovering = false

    var body: some View {
        ZStack {
            Color.clear.frame(width: 20, height: 20).contentShape(Rectangle())
            Circle()
                .fill(connected ? PerpetoColor.editorEdgeActive : PerpetoColor.surface)
                .frame(width: PerpetoEditor.port, height: PerpetoEditor.port)
                .overlay(Circle().strokeBorder(hovering ? PerpetoColor.ink : PerpetoColor.editorEdge, lineWidth: 1.5))
        }
        .onHover { hovering = $0 }
    }
}

/// The quiet field behind the map: 1.5 pt dots every 24 pt, no lines.
public struct DotGrid: View {
    public init() {}
    public var body: some View {
        Canvas { context, size in
            let spacing = PerpetoEditor.dotSpacing
            let d = PerpetoEditor.dotSize
            var dots = Path()
            var y = spacing / 2
            while y <= size.height {
                var x = spacing / 2
                while x <= size.width {
                    dots.addEllipse(in: CGRect(x: x - d / 2, y: y - d / 2, width: d, height: d))
                    x += spacing
                }
                y += spacing
            }
            context.fill(dots, with: .color(PerpetoColor.editorDot))
        }
        .background(PerpetoColor.editorCanvas)
    }
}
