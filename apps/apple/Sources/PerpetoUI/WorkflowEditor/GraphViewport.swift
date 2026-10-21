import PerpetoKit
import SwiftUI

/// Scrollable, zoomable frame around a graph canvas, with a legend.
struct GraphViewport: View {
    var graph: WorkflowGraph
    var mode: GraphMode
    @Binding var selection: GraphSelection?
    var editable = false
    var connectKind: GraphEdge.Kind = .messages
    /// Initial role-edge scope; the legend toggles it.
    var initialRoleScope: RoleEdgeScope = .all
    var onMove: (String, GraphNode.Position) -> Void = { _, _ in }
    var onConnect: (GraphEdge.Endpoint, GraphEdge.Endpoint, GraphEdge.Kind) -> Void = { _, _, _ in }

    @State private var zoom: CGFloat?
    @State private var roleScope: RoleEdgeScope?

    var body: some View {
        GeometryReader { proxy in
            let content = GraphCanvas.layout(graph: graph, mode: mode).contentSize
            let scope = roleScope ?? initialRoleScope
            let fit = min(1, max(0.5, min(proxy.size.width / content.width, (proxy.size.height - 40) / content.height)))
            let scale = zoom ?? fit
            ScrollView([.horizontal, .vertical]) {
                GraphCanvas(graph: graph, mode: mode, selection: $selection, zoom: scale,
                            minSize: CGSize(width: proxy.size.width / scale, height: proxy.size.height / scale),
                            editable: editable, connectKind: connectKind, roleScope: scope, onMove: onMove, onConnect: onConnect)
            }
            .overlay(alignment: .bottomLeading) { EdgeLegend(live: mode.isLive, scope: Binding(get: { scope }, set: { roleScope = $0 })).padding(PerpetoSpacing.x(3)) }
            .overlay(alignment: .bottomTrailing) {
                ZoomControl(zoom: scale, fit: { zoom = nil }, change: { zoom = min(1.5, max(0.4, scale + $0)) })
                    .padding(PerpetoSpacing.x(3))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous).strokeBorder(PerpetoColor.border))
    }
}

struct EdgeLegend: View {
    var live: Bool
    @Binding var scope: RoleEdgeScope

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(4)) {
            ForEach([GraphEdge.Kind.flow, .delegates, .messages], id: \.self) { kind in
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    Canvas { context, size in
                        var path = Path()
                        path.move(to: CGPoint(x: 0, y: size.height / 2))
                        path.addLine(to: CGPoint(x: size.width - 4, y: size.height / 2))
                        context.stroke(path, with: .color(EdgeStyle.color(kind)), style: EdgeStyle.stroke(kind, width: kind == .messages ? 2.25 : 1.5))
                        EdgeStyle.drawMarkers(&context, kind: kind, points: [CGPoint(x: 2, y: size.height / 2), CGPoint(x: size.width - 2, y: size.height / 2)], color: EdgeStyle.color(kind))
                    }
                    .frame(width: 28, height: 10)
                    Text(EdgeStyle.title(kind)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink)
                }
                .help(EdgeStyle.meaning(kind))
            }
            if live {
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    Canvas { context, size in
                        var path = Path()
                        path.move(to: CGPoint(x: 0, y: size.height / 2))
                        path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                        context.stroke(path, with: .color(PerpetoColor.error), style: StrokeStyle(lineWidth: 1.75, lineCap: .round, dash: [0.5, 4.5]))
                    }
                    .frame(width: 28, height: 10)
                    Text("Unplanned").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink)
                }
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    RoundedRectangle(cornerRadius: 1.5).fill(PerpetoColor.ink).frame(width: 7, height: 7)
                    RoundedRectangle(cornerRadius: 1.5).strokeBorder(PerpetoColor.ink).frame(width: 7, height: 7)
                    Text("Active, queued item").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.ink)
                }
            }
            Rule(vertical: true).frame(height: 16)
            Picker("Show role edges for", selection: $scope) {
                ForEach(RoleEdgeScope.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .help("Show delegates and messages for every role, or only for the selected node")
        }
        .padding(.horizontal, PerpetoSpacing.x(3))
        .padding(.vertical, PerpetoSpacing.x(1.5))
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control).strokeBorder(PerpetoColor.border))
    }
}

struct ZoomControl: View {
    var zoom: CGFloat
    var fit: () -> Void
    var change: (CGFloat) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button { change(-0.1) } label: { Image(systemName: "minus").frame(width: 24, height: 24) }
                .keyboardShortcut("-", modifiers: .command)
                .help("Zoom out (⌘-)")
            Button(action: fit) {
                Text(Format.percent(zoom)).font(PerpetoFont.caption.monospacedDigit()).frame(width: 44, height: 24)
            }
            .keyboardShortcut("0", modifiers: .command)
            .help("Fit to view (⌘0)")
            Button { change(0.1) } label: { Image(systemName: "plus").frame(width: 24, height: 24) }
                .keyboardShortcut("=", modifiers: .command)
                .help("Zoom in (⌘=)")
        }
        .buttonStyle(.plain)
        .foregroundStyle(PerpetoColor.ink)
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control).strokeBorder(PerpetoColor.controlBorder))
    }
}
