import PerpetoKit
import SwiftUI

/// The map card: the dotted field pans and zooms (buttons, pinch or
/// trackpad), with the legend bottom left and the zoom pill bottom right.
struct GraphViewport: View {
    var graph: WorkflowGraph
    var mode: GraphMode
    @Binding var selection: GraphSelection?
    var editable = false
    var connectKind: GraphEdge.Kind = .messages
    /// Initial role-edge scope; the legend toggles it.
    var initialRoleScope: RoleEdgeScope = .selected
    /// Live map: switch to compact cards when the drawing would not fit.
    var fitWithCompactCards = false
    /// A step to keep in view: centred when the map opens (if the drawing is
    /// wider than the view) and whenever `focusToken` changes.
    var focusNodeId: String?
    var focusToken = 0

    @State private var zoom: CGFloat?
    @State private var roleScope: RoleEdgeScope?
    /// Zoom when a pinch began, so the gesture scales from where it started.
    @State private var pinchBase: CGFloat?
    @State private var position = ScrollPosition()
    @Environment(\.compactLayout) private var compact
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var onMove: (String, GraphNode.Position) -> Void = { _, _ in }
    var onConnect: (GraphEdge.Endpoint, GraphEdge.Endpoint, GraphEdge.Kind) -> Void = { _, _, _ in }

    var body: some View {
        GeometryReader { proxy in
            let scope = roleScope ?? initialRoleScope
            let probe = GraphCanvas(graph: graph, mode: mode, selection: $selection, roleScope: scope)
            let room = CGSize(width: proxy.size.width, height: proxy.size.height - 56)
            let full = GraphCanvas.layout(graph: graph, mode: mode, include: probe.isVisible)
            let fullFit = min(room.width / full.contentSize.width, room.height / full.contentSize.height)
            // Fit all steps by default: switch to compact cards when the full
            // drawing would need shrinking, and allow them smaller.
            let compact = fitWithCompactCards && fullFit < 0.85
            let layout = compact ? GraphCanvas.layout(graph: graph, mode: mode, compact: true, include: probe.isVisible) : full
            let content = layout.contentSize
            let fit = min(1, max(compact ? 0.45 : 0.6, min(room.width / content.width, room.height / content.height)))
            let scale = zoom ?? fit
            let canvas = GraphCanvas(graph: graph, mode: mode, selection: $selection, zoom: scale,
                                     minSize: CGSize(width: proxy.size.width / scale, height: proxy.size.height / scale),
                                     editable: editable, connectKind: connectKind, roleScope: scope, compact: compact, onMove: onMove, onConnect: onConnect)
            ScrollView([.horizontal, .vertical]) { canvas }
                .scrollIndicators(.hidden)
                .scrollPosition($position)
                .onAppear {
                    // Keep the step that needs attention in view when the drawing is wider than the map.
                    if content.width * scale > proxy.size.width + 1 { reveal(focusNodeId, layout: layout, scale: scale, in: proxy.size, animated: false) }
                }
                .onChange(of: focusToken) { _, _ in reveal(focusNodeId, layout: layout, scale: scale, in: proxy.size, animated: true) }
                .background(PerpetoColor.editorCanvas)
                .simultaneousGesture(
                    MagnifyGesture()
                        .onChanged { value in
                            let base = pinchBase ?? scale
                            pinchBase = base
                            zoom = min(1.5, max(0.3, base * value.magnification))
                        }
                        .onEnded { _ in pinchBase = nil })
                .overlay(alignment: .bottomLeading) {
                    MapLegend(looks: canvas.looksOnScreen, live: mode.isLive, hasRoles: graph.edges.contains { $0.kind != .flow },
                              scope: Binding(get: { scope }, set: { roleScope = $0 }))
                        .padding(PerpetoSpacing.x(5))
                }
                .overlay(alignment: .bottomTrailing) {
                    ZoomControl(zoom: scale, fit: { zoom = nil }, change: { delta in
                        withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) { zoom = min(1.5, max(0.3, scale + delta)) }
                    })
                    .padding(PerpetoSpacing.x(4))
                }
        }
        .clipShape(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous))
        .perpetoElevation(.card, cornerRadius: PerpetoRadius.panel)
    }

    /// The card height that shows the fitted drawing without empty space,
    /// for a map of the given width. Mirrors the fitting in `body`.
    static func idealHeight(graph: WorkflowGraph, mode: GraphMode, width: CGFloat, compactCards: Bool, minHeight: CGFloat = 320, maxHeight: CGFloat = 720) -> CGFloat {
        let hideRoles: (GraphEdge) -> Bool = { _ in false }
        let full = GraphCanvas.layout(graph: graph, mode: mode, include: hideRoles).contentSize
        let compact = compactCards && width / full.width < 0.85
        let content = compact ? GraphCanvas.layout(graph: graph, mode: mode, compact: true, include: hideRoles).contentSize : full
        let scale = min(1, max(compact ? 0.45 : 0.6, width / content.width))
        return min(maxHeight, max(minHeight, content.height * scale + 56))
    }

    /// Pans so the step is centred, as far as the drawing allows.
    private func reveal(_ nodeId: String?, layout: GraphLayout, scale: CGFloat, in size: CGSize, animated: Bool) {
        guard let nodeId, let frame = layout.frame(id: nodeId) else { return }
        let content = CGSize(width: max(layout.contentSize.width, size.width / scale) * scale, height: max(layout.contentSize.height, size.height / scale) * scale)
        let x = min(max(0, frame.midX * scale - size.width / 2), max(0, content.width - size.width))
        let y = min(max(0, frame.midY * scale - size.height / 2), max(0, content.height - size.height))
        withAnimation(animated ? PerpetoMotion.easeOut(PerpetoMotion.slow, reduceMotion: reduceMotion) : nil) {
            position.scrollTo(point: CGPoint(x: x, y: y))
        }
    }
}

/// Only the styles currently on screen, in 12 pt muted.
struct MapLegend: View {
    var looks: [EdgeLook]
    var live: Bool
    var hasRoles: Bool
    @Binding var scope: RoleEdgeScope
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(5)) {
            ForEach(looks, id: \.self) { look in
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Canvas { context, size in
                        var path = Path()
                        path.move(to: CGPoint(x: 0, y: size.height / 2))
                        path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                        context.stroke(path, with: .color(look.color), style: look.stroke)
                    }
                    .frame(width: 22, height: 8)
                    Text(look.title)
                }
            }
            if live {
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    Circle().fill(PerpetoColor.accent).frame(width: 6, height: 6)
                    Text("Live")
                }
            }
            if hasRoles {
                Button {
                    withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) { scope = scope == .all ? .selected : .all }
                } label: {
                    Text(scope == .all ? "Roles for selection only" : "Show all roles")
                        .underline(false)
                        .foregroundStyle(PerpetoColor.inkSoft)
                }
                .buttonStyle(.plain)
                .help("Delegates and messages: show them for every role, or only for the selected step")
            }
        }
        .font(PerpetoFont.small)
        .foregroundStyle(PerpetoColor.muted)
        .padding(.horizontal, PerpetoSpacing.x(3))
        .frame(height: 28)
        .background(Capsule().fill(PerpetoColor.editorCanvas.opacity(0.92)))
    }
}

/// The map toolbar: a white pill, bottom right. Zoom out, level, zoom in, fit.
struct ZoomControl: View {
    var zoom: CGFloat
    var fit: () -> Void
    var change: (CGFloat) -> Void

    var body: some View {
        HStack(spacing: 0) {
            button("minus", "Zoom out") { change(-0.1) }
                .keyboardShortcut("-", modifiers: .command)
            Text(Format.percent(zoom)).font(PerpetoFont.small.monospacedDigit()).foregroundStyle(PerpetoColor.muted).frame(width: 44)
            button("plus", "Zoom in") { change(0.1) }
                .keyboardShortcut("=", modifiers: .command)
            button("arrow.up.left.and.arrow.down.right", "Fit to view", action: fit)
                .keyboardShortcut("0", modifiers: .command)
        }
        .padding(.horizontal, PerpetoSpacing.x(1))
        .frame(height: 40)
        .background(Capsule().fill(PerpetoColor.surface))
        .pillElevation(.raised, height: 40)
    }

    private func button(_ image: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: image).font(.system(size: 12, weight: .medium)).foregroundStyle(PerpetoColor.inkSoft)
                .frame(width: 32, height: 32).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .help(label)
    }
}

/// Narrow screens: the map becomes a list of steps in flow order, joined by
/// a short grey connector. Returns are written in the meta line.
struct StepList: View {
    var graph: WorkflowGraph
    var live: LiveOverlay?
    @Binding var selection: GraphSelection?

    var body: some View {
        let order = graph.flowOrder
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(order.enumerated()), id: \.element.id) { index, node in
                if index > 0 {
                    Rectangle().fill(PerpetoColor.grey200).frame(width: PerpetoStroke.edge, height: 12).padding(.leading, PerpetoSpacing.x(9))
                }
                Button { selection = .node(node.id) } label: { row(node) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func row(_ node: GraphNode) -> some View {
        let metrics = live?.metrics.node(node.id)
        let bottleneck = live?.metrics.bottlenecks(for: node.id).filter { $0.severity != .info }.max { $0.severity.rank < $1.severity.rank }
        return HStack(spacing: PerpetoSpacing.x(3)) {
            IconTile(node.type.systemImage, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(node.label).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Text(meta(node, metrics)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
            }
            Spacer(minLength: PerpetoSpacing.x(2))
            if let bottleneck {
                StatusLabel(bottleneck.reason.title, tone: .warning)
            } else if (metrics?.active ?? 0) > 0 {
                LiveDot()
            } else if let metrics, node.type == .input || node.type == .output {
                Text(node.type == .input ? "\(metrics.done) in" : "\(metrics.done)").font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
            } else if live != nil {
                Text("Idle").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .padding(.horizontal, PerpetoSpacing.x(4))
        .padding(.vertical, PerpetoSpacing.x(3))
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous))
        .perpetoElevation(.card, cornerRadius: PerpetoRadius.node)
        .selectionOutline(selection == .node(node.id))
        .contentShape(Rectangle())
    }

    private func meta(_ node: GraphNode, _ m: NodeMetrics?) -> String {
        guard let live else { return node.harness.map { Format.model($0.model) } ?? node.type.title }
        var parts: [String] = []
        if let m {
            switch node.type {
            case .input: parts.append(node.config["source"]?.stringValue == "goals" ? "From project goals" : "Manual input")
            case .output: parts.append("Work item finished")
            default:
                if m.active > 0 { parts.append(m.concurrency.map { "\(m.active) of \($0) active" } ?? "\(m.active) active") }
                if m.queued > 0 { parts.append("\(m.queued) queued") }
            }
        }
        // Returns are written out: "12 returned to Builder".
        for edge in graph.edges where edge.kind == .flow && edge.from.node == node.id && edge.from.port == "fail" {
            if let count = live.metrics.edge(edge.id)?.count, count > 0 {
                parts.append("\(count) returned to \(graph.node(edge.to.node)?.label ?? edge.to.node)")
            }
        }
        if parts.isEmpty { parts.append(node.harness.map { Format.model($0.model) } ?? node.type.title) }
        return parts.joined(separator: " · ")
    }
}
