import CoreGraphics
import Foundation

/// Geometry for drawing a workflow graph as a calm drawing: soft cards on a
/// quiet field joined by thin orthogonal lines with rounded corners.
///
/// Flow that moves forward along a row runs straight from the right edge of
/// one card to the left edge of the next. Every other edge attaches to the
/// top or bottom of a card and runs in a lane: work that moves to a later row
/// leaves the bottom and enters the next card from the top; a return (a loop
/// or a failed gate) leaves the top and comes back to the top of the earlier
/// card, as one clean line above the row. Delegates and messages edges are
/// relationships rather than movement, so they use the outer channels above
/// the first row and below the last, and the side gutters to change rows.
/// Lanes are allocated shortest span first so nested routes never share or
/// cross a lane inside a channel.
public struct GraphLayout: Sendable {
    public static let nodeWidth: CGFloat = PerpetoEditor.nodeWidth
    public static let grid: CGFloat = PerpetoEditor.dotSpacing
    public static let margin: CGFloat = 40
    /// Vertical space between rows, which also holds the lanes between them.
    public static let rowGap: CGFloat = 104
    /// Stored row pitch assumed when a graph has a single row.
    static let storedRowPitch: CGFloat = 180

    static let laneStart: CGFloat = 24
    static let lanePitch: CGFloat = 12
    static let gutterStart: CGFloat = 32
    static let slotPitch: CGFloat = 20

    public struct Route: Hashable, Sendable {
        public var points: [CGPoint]
        /// Preferred spot for a traffic count or label.
        public var labelPoint: CGPoint
        /// True for flow that goes back to an earlier step.
        public var isReturn: Bool
        public init(points: [CGPoint], labelPoint: CGPoint, isReturn: Bool = false) {
            self.points = points
            self.labelPoint = labelPoint
            self.isReturn = isReturn
        }
    }

    /// Which edge of a card carries its delegates and messages edges.
    public enum RoleSide: Sendable { case top, bottom }

    enum Side: Hashable, Sendable { case top, bottom }
    enum Channel: Hashable, Sendable { case top, gap(Int), bottom, left, right }

    public let graph: WorkflowGraph
    public let nodeHeight: CGFloat
    /// Horizontal spread applied to stored positions so cards in a row keep a
    /// gutter between them. Drags divide by it to store positions.
    public let xScale: CGFloat
    /// Planned delegates/messages edges plus extra role-style edges, such as
    /// unplanned interactions on the live map.
    public let roleEdges: [GraphEdge]
    public let contentSize: CGSize
    private let frames: [String: CGRect]
    private let routes: [String: Route]
    private let sides: [String: RoleSide]

    /// - Parameters:
    ///   - overrides: live origins while dragging, in stored coordinates.
    ///   - extraRoleEdges: edges drawn like roles but not part of the graph.
    ///   - includeRole: which role edges to route. Hidden ones take no space.
    public init(graph: WorkflowGraph, nodeHeight: CGFloat, overrides: [String: CGPoint] = [:], extraRoleEdges: [GraphEdge] = [],
                includeRole: (GraphEdge) -> Bool = { _ in true }) {
        self.graph = graph
        self.nodeHeight = nodeHeight
        let nodeIds = Set(graph.nodes.map(\.id))
        let roleEdges = (graph.edges.filter { $0.kind == .delegates || $0.kind == .messages }
            + extraRoleEdges.filter { nodeIds.contains($0.from.node) && nodeIds.contains($0.to.node) }).filter(includeRole)
        self.roleEdges = roleEdges

        // Stretch stored positions so cards keep their gaps at this size.
        let xScale = Self.spread(graph)
        self.xScale = xScale
        let ys = Array(Set(graph.nodes.map { CGFloat($0.position.y) })).sorted()
        let rowPitch = zip(ys, ys.dropFirst()).map { $1 - $0 }.filter { $0 > 1 }.min() ?? Self.storedRowPitch
        let yScale = max(1, (nodeHeight + Self.rowGap) / rowPitch)
        let leftX = graph.nodes.map(\.position.x).min() ?? 0
        let topY = graph.nodes.map(\.position.y).min() ?? 0
        let size = CGSize(width: Self.nodeWidth, height: nodeHeight)
        var raw: [String: CGRect] = [:]
        for node in graph.nodes {
            let p = overrides[node.id] ?? CGPoint(x: node.position.x, y: node.position.y)
            raw[node.id] = CGRect(origin: CGPoint(x: leftX + (p.x - leftX) * xScale, y: topY + (p.y - topY) * yScale), size: size)
        }

        // Rows are clusters of vertically overlapping cards.
        var rows: [(minY: CGFloat, maxY: CGFloat)] = []
        var rowOf: [String: Int] = [:]
        for node in graph.nodes.sorted(by: { raw[$0.id]!.minY < raw[$1.id]!.minY }) {
            let f = raw[node.id]!
            if let last = rows.last, f.minY < last.maxY - 1 {
                rows[rows.count - 1].maxY = max(last.maxY, f.maxY)
            } else {
                rows.append((f.minY, f.maxY))
            }
            rowOf[node.id] = rows.count - 1
        }
        let lastRow = max(rows.count - 1, 0)
        var sides: [String: RoleSide] = [:]
        for node in graph.nodes { sides[node.id] = (rowOf[node.id] ?? 0) == 0 ? .top : .bottom }
        self.sides = sides

        func channel(_ side: Side, row: Int) -> Channel {
            switch side {
            case .top: row == 0 ? .top : .gap(row - 1)
            case .bottom: row == lastRow ? .bottom : .gap(row)
            }
        }

        // Plan every edge: straight, or attached to card sides through lanes.
        struct Plan { var a: Side; var b: Side; var ca: Channel; var cb: Channel; var gutter: Channel?; var isReturn: Bool; var role: Bool }
        var straight: Set<String> = []
        var plans: [String: Plan] = [:]
        var requests: [(id: String, channel: Channel, span: CGFloat, role: Bool)] = []
        let allMinX = raw.values.map(\.minX).min() ?? 0
        let allMaxX = raw.values.map(\.maxX).max() ?? 0

        func plan(_ edge: GraphEdge, role: Bool) {
            guard let a = raw[edge.from.node], let b = raw[edge.to.node], let ra = rowOf[edge.from.node], let rb = rowOf[edge.to.node] else { return }
            var sa: Side, sb: Side, isReturn = false
            if role {
                sa = sides[edge.from.node] == .top ? .top : .bottom
                sb = sides[edge.to.node] == .top ? .top : .bottom
            } else if ra == rb {
                let blocked = graph.nodes.contains { n in
                    n.id != edge.from.node && n.id != edge.to.node && rowOf[n.id] == ra && raw[n.id]!.maxX > a.maxX && raw[n.id]!.minX < b.minX
                }
                if b.minX > a.maxX + 8 && !blocked && edge.from.port != "fail" {
                    straight.insert(edge.id)
                    return
                }
                isReturn = b.minX <= a.minX
                sa = .top; sb = .top
            } else if ra < rb {
                sa = .bottom; sb = .top
            } else {
                isReturn = true
                sa = .top; sb = .bottom
            }
            let ca = channel(sa, row: ra), cb = channel(sb, row: rb)
            if ca == cb {
                plans[edge.id] = Plan(a: sa, b: sb, ca: ca, cb: cb, gutter: nil, isReturn: isReturn, role: role)
                requests.append((edge.id, ca, abs(a.midX - b.midX), role))
            } else {
                let leftCost = (a.midX - allMinX) + (b.midX - allMinX)
                let rightCost = (allMaxX - a.midX) + (allMaxX - b.midX)
                let gutter: Channel = leftCost <= rightCost ? .left : .right
                plans[edge.id] = Plan(a: sa, b: sb, ca: ca, cb: cb, gutter: gutter, isReturn: isReturn, role: role)
                let edgeX = gutter == .left ? allMinX : allMaxX
                // Routes that wrap to a gutter enclose their channels, so they take the outer lanes.
                requests.append((edge.id + "#a", ca, 10_000 + abs(a.midX - edgeX), role))
                requests.append((edge.id + "#b", cb, 10_000 + abs(b.midX - edgeX), role))
                requests.append((edge.id, gutter, abs(a.midY - b.midY), role))
            }
        }
        for edge in graph.edges where edge.kind == .flow || edge.kind == .unknown { plan(edge, role: false) }
        for edge in roleEdges { plan(edge, role: true) }

        // Allocate lanes per channel: flow before roles, shortest span first.
        var laneIndex: [String: Int] = [:]
        var laneCount: [Channel: Int] = [:]
        for (channel, items) in Dictionary(grouping: requests, by: \.channel) {
            let ordered = items.sorted { ($0.role ? 1 : 0, $0.span, $0.id) < ($1.role ? 1 : 0, $1.span, $1.id) }
            for (i, item) in ordered.enumerated() { laneIndex[item.id + "@" + Self.key(channel)] = i }
            laneCount[channel] = ordered.count
        }

        // Make room above and to the left for channels, on the dot grid.
        func extent(_ n: Int, start: CGFloat) -> CGFloat { n == 0 ? 0 : start + CGFloat(n - 1) * Self.lanePitch + 14 }
        let topExtent = extent(laneCount[.top] ?? 0, start: Self.laneStart)
        let leftExtent = extent(laneCount[.left] ?? 0, start: Self.gutterStart)
        let minY = raw.values.map(\.minY).min() ?? 0
        let dx = max(0, ceil((Self.margin + leftExtent - allMinX) / Self.grid) * Self.grid)
        let dy = max(0, ceil((Self.margin + topExtent - minY) / Self.grid) * Self.grid)
        var frames: [String: CGRect] = [:]
        for (id, f) in raw { frames[id] = f.offsetBy(dx: dx, dy: dy) }
        self.frames = frames
        let shiftedRows = rows.map { (minY: $0.minY + dy, maxY: $0.maxY + dy) }
        let minX = allMinX + dx, maxX = allMaxX + dx

        func pitch(_ channel: Channel) -> CGFloat {
            let n = laneCount[channel] ?? 0
            guard case .gap(let g) = channel, n > 1, g + 1 < shiftedRows.count else { return Self.lanePitch }
            let room = shiftedRows[g + 1].minY - shiftedRows[g].maxY - 2 * Self.laneStart
            return max(5, min(Self.lanePitch, room / CGFloat(n - 1)))
        }
        func lane(_ channel: Channel, _ id: String) -> CGFloat {
            let i = CGFloat(laneIndex[id + "@" + Self.key(channel)] ?? 0)
            switch channel {
            case .top: return (shiftedRows.first?.minY ?? 0) - Self.laneStart - i * pitch(channel)
            case .gap(let g):
                // Centre the lanes in the gap so stubs above and below are equal.
                let n = CGFloat(laneCount[channel] ?? 1)
                let mid = (shiftedRows[g].maxY + (g + 1 < shiftedRows.count ? shiftedRows[g + 1].minY : shiftedRows[g].maxY + Self.rowGap)) / 2
                return mid - (n - 1) * pitch(channel) / 2 + i * pitch(channel)
            case .bottom: return (shiftedRows.last?.maxY ?? 0) + Self.laneStart + i * pitch(channel)
            case .left: return minX - Self.gutterStart - i * pitch(channel)
            case .right: return maxX + Self.gutterStart + i * pitch(channel)
            }
        }

        var routes: [String: Route] = [:]
        for edge in graph.edges where straight.contains(edge.id) {
            guard let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let p1 = CGPoint(x: a.maxX, y: a.midY), p2 = CGPoint(x: b.minX, y: b.midY)
            if abs(p1.y - p2.y) < 1 {
                routes[edge.id] = Route(points: [p1, p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: p1.y))
            } else {
                let midX = ((p1.x + p2.x) / 2).rounded()
                routes[edge.id] = Route(points: [p1, CGPoint(x: midX, y: p1.y), CGPoint(x: midX, y: p2.y), p2], labelPoint: CGPoint(x: midX, y: (p1.y + p2.y) / 2))
            }
        }

        // Attachment slots: spread lanes along each card side, ordered so
        // stubs do not cross lanes that leave the same side.
        struct Attachment { var edgeId: String; var isFrom: Bool; var heading: CGFloat; var depth: Int }
        var attachments: [String: [Attachment]] = [:]
        var laneY: [String: (a: CGFloat, b: CGFloat, gutterX: CGFloat?)] = [:]
        let planned = graph.edges.filter { plans[$0.id] != nil && !roleEdges.contains($0) } + roleEdges
        for edge in planned {
            guard let plan = plans[edge.id], let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let gutterX = plan.gutter.map { lane($0, edge.id) }
            let ya = plan.gutter == nil ? lane(plan.ca, edge.id) : lane(plan.ca, edge.id + "#a")
            let yb = plan.gutter == nil ? ya : lane(plan.cb, edge.id + "#b")
            laneY[edge.id] = (ya, yb, gutterX)
            // Depth is how far the lane is from the card. Gap lanes are
            // numbered downward, so for a card below the gap they count back.
            func depth(_ id: String, _ channel: Channel, _ side: Side) -> Int {
                let i = laneIndex[id + "@" + Self.key(channel)] ?? 0
                if case .gap = channel, side == .top { return (laneCount[channel] ?? 1) - 1 - i }
                return i
            }
            let depthA = depth(plan.gutter == nil ? edge.id : edge.id + "#a", plan.ca, plan.a)
            let depthB = depth(plan.gutter == nil ? edge.id : edge.id + "#b", plan.cb, plan.b)
            var headingA = (gutterX ?? b.midX) - a.midX
            var headingB = (gutterX ?? a.midX) - b.midX
            if edge.from.node == edge.to.node { headingA = -1; headingB = 1 }
            // Depth grows away from the card: toward the top for top sides.
            attachments[edge.from.node + Self.key(plan.a), default: []].append(Attachment(edgeId: edge.id, isFrom: true, heading: headingA, depth: depthA))
            attachments[edge.to.node + Self.key(plan.b), default: []].append(Attachment(edgeId: edge.id, isFrom: false, heading: headingB, depth: depthB))
        }
        var slotX: [String: CGFloat] = [:]
        for (key, list) in attachments {
            let nodeId = String(key.dropLast(key.hasSuffix("top") ? 3 : 6))
            guard let f = frames[nodeId] else { continue }
            let left = list.filter { $0.heading < 0 }.sorted { ($0.depth, $0.edgeId) < ($1.depth, $1.edgeId) }
            let right = list.filter { $0.heading >= 0 }.sorted { ($0.depth, $0.edgeId) > ($1.depth, $1.edgeId) }
            let ordered = left + right
            let n = CGFloat(ordered.count)
            let step = n > 1 ? min(Self.slotPitch, (f.width - 48) / (n - 1)) : 0
            for (k, item) in ordered.enumerated() {
                slotX[item.edgeId + (item.isFrom ? ">" : "<")] = f.midX + (CGFloat(k) - (n - 1) / 2) * step
            }
        }
        for edge in planned {
            guard let plan = plans[edge.id], let y = laneY[edge.id], let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let xa = slotX[edge.id + ">"] ?? a.midX, xb = slotX[edge.id + "<"] ?? b.midX
            let pa = CGPoint(x: xa, y: plan.a == .top ? a.minY : a.maxY)
            let pb = CGPoint(x: xb, y: plan.b == .top ? b.minY : b.maxY)
            if let gx = y.gutterX {
                routes[edge.id] = Route(
                    points: [pa, CGPoint(x: xa, y: y.a), CGPoint(x: gx, y: y.a), CGPoint(x: gx, y: y.b), CGPoint(x: xb, y: y.b), pb],
                    labelPoint: CGPoint(x: gx, y: (y.a + y.b) / 2), isReturn: plan.isReturn)
            } else {
                routes[edge.id] = Route(
                    points: [pa, CGPoint(x: xa, y: y.a), CGPoint(x: xb, y: y.a), pb],
                    labelPoint: CGPoint(x: (xa + xb) / 2, y: y.a), isReturn: plan.isReturn)
            }
        }
        self.routes = routes

        let allPoints = routes.values.flatMap(\.points)
        let maxFrameX = frames.values.map(\.maxX).max() ?? 0
        let maxFrameY = frames.values.map(\.maxY).max() ?? 0
        let width = max(maxFrameX, allPoints.map(\.x).max() ?? 0) + Self.margin
        let height = max(maxFrameY, allPoints.map(\.y).max() ?? 0) + Self.margin + 40
        contentSize = CGSize(width: max(width, 480), height: max(height, 280))
    }

    /// The smallest horizontal scale that leaves the node gap between cards
    /// that share a row. 1 when the stored layout already fits.
    static func spread(_ graph: WorkflowGraph) -> CGFloat {
        let pitch = Double(nodeWidth + PerpetoEditor.nodeGapX)
        var scale = 1.0
        for (i, a) in graph.nodes.enumerated() {
            for b in graph.nodes[(i + 1)...] where abs(a.position.y - b.position.y) < 76 {
                let dx = abs(a.position.x - b.position.x)
                if dx > 0.5, dx < pitch { scale = max(scale, pitch / dx) }
            }
        }
        return CGFloat(scale)
    }

    static func key(_ channel: Channel) -> String {
        switch channel {
        case .top: "top"
        case .gap(let g): "gap\(g)"
        case .bottom: "bottom"
        case .left: "left"
        case .right: "right"
        }
    }

    static func key(_ side: Side) -> String { side == .top ? "top" : "bottom" }

    // MARK: Geometry

    public func frame(_ node: GraphNode) -> CGRect {
        frames[node.id] ?? CGRect(origin: .zero, size: CGSize(width: Self.nodeWidth, height: nodeHeight))
    }

    public func frame(id: String) -> CGRect? { frames[id] }

    public func roleSide(_ nodeId: String) -> RoleSide { sides[nodeId] ?? .top }

    /// Port positions for the editor: input on the left, output and pass on
    /// the right, fail on the top-right where returns leave, role on the
    /// card edge that faces its channel.
    public func point(_ node: GraphNode, port: GraphPort) -> CGPoint {
        let f = frame(node)
        switch port {
        case .in: return CGPoint(x: f.minX, y: f.midY)
        case .out, .pass: return CGPoint(x: f.maxX, y: f.midY)
        case .fail: return CGPoint(x: f.maxX - 28, y: f.minY)
        case .role: return CGPoint(x: f.minX + 28, y: roleSide(node.id) == .top ? f.minY : f.maxY)
        }
    }

    public func route(_ edge: GraphEdge) -> Route? { routes[edge.id] }
    public func route(id: String) -> Route? { routes[id] }

    public static func snap(_ value: CGFloat) -> CGFloat { (value / grid).rounded() * grid }

    // MARK: Labels

    public struct LabelRequest: Sendable {
        public var edgeId: String
        public var size: CGSize
        public init(edgeId: String, size: CGSize) {
            self.edgeId = edgeId
            self.size = size
        }
    }

    /// Places each label on its own route so that no two labels overlap and
    /// none covers a card. Earlier requests win the preferred spots.
    public func placeLabels(_ requests: [LabelRequest]) -> [String: CGPoint] {
        var placed: [CGRect] = []
        var result: [String: CGPoint] = [:]
        let obstacles = frames.values.map { $0.insetBy(dx: -2, dy: -2) }
        for request in requests {
            guard let route = routes[request.edgeId] else { continue }
            var candidates = [route.labelPoint]
            let segments = zip(route.points, route.points.dropFirst())
                .map { ($0, $1) }
                .sorted { Self.length($0.0, $0.1) > Self.length($1.0, $1.1) }
            for (a, b) in segments {
                for t in [0.5, 0.3, 0.7, 0.15, 0.85] as [CGFloat] {
                    candidates.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
                }
            }
            func rect(_ p: CGPoint) -> CGRect {
                CGRect(x: p.x - request.size.width / 2, y: p.y - request.size.height / 2, width: request.size.width, height: request.size.height)
            }
            let free = candidates.first { p in
                let r = rect(p).insetBy(dx: -2, dy: -1)
                return !placed.contains { $0.intersects(r) } && !obstacles.contains { $0.intersects(r) }
            }
            let chosen = free ?? route.labelPoint
            placed.append(rect(chosen))
            result[request.edgeId] = chosen
        }
        return result
    }

    static func length(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(b.x - a.x, b.y - a.y) }

    // MARK: Hit testing

    /// Nearest edge to a point within `tolerance`, for click selection.
    public func edge(at point: CGPoint, tolerance: CGFloat = 6, where include: (GraphEdge) -> Bool = { _ in true }) -> GraphEdge? {
        var best: (GraphEdge, CGFloat)?
        for edge in graph.edges where include(edge) {
            guard let route = routes[edge.id] else { continue }
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

extension WorkflowGraph {
    /// Nodes in flow order: breadth first from the inputs along flow edges,
    /// ignoring returns, then anything unreachable. Used by the step list.
    public var flowOrder: [GraphNode] {
        var order: [String] = []
        var seen = Set<String>()
        var queue = nodes.filter { $0.type == .input }.sorted { ($0.position.y, $0.position.x) < ($1.position.y, $1.position.x) }.map(\.id)
        while !queue.isEmpty {
            let id = queue.removeFirst()
            guard seen.insert(id).inserted else { continue }
            order.append(id)
            let next = edges.filter { $0.kind == .flow && $0.from.node == id && !seen.contains($0.to.node) }
                .sorted { ($0.from.port == "fail" ? 1 : 0) < ($1.from.port == "fail" ? 1 : 0) }
                .map(\.to.node)
            queue += next
        }
        order += nodes.map(\.id).filter { !seen.contains($0) }
        return order.compactMap(node)
    }
}
