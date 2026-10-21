import CoreGraphics
import Foundation

/// Geometry for drawing a workflow graph as a precise ruled drawing: fixed
/// node sizes, ports on card edges and orthogonal routing.
///
/// Flow edges own the band the work moves through: they run straight along a
/// row, or in numbered lanes in the gap between rows. Delegates and messages
/// edges are relationships rather than movement, so they stay out of that
/// band: they leave a node from its outer edge (the top of the first row, the
/// bottom of later rows), run in channels above or below the drawing, and use
/// the side gutters to change rows. Lanes are allocated shortest span first so
/// nested routes never cross each other inside a channel.
public struct GraphLayout: Sendable {
    public static let nodeWidth: CGFloat = 168
    public static let grid: CGFloat = PerpetoEditor.gridMinor
    public static let margin: CGFloat = 48
    /// Stored positions assume 76 pt cards on a 180 pt row pitch.
    public static let baseNodeHeight: CGFloat = 76
    public static let rowGap: CGFloat = 104

    static let laneStart: CGFloat = 16
    static let lanePitch: CGFloat = 10
    static let gutterStart: CGFloat = 32
    static let stub: CGFloat = 12
    static let slotPitch: CGFloat = 14

    public struct Route: Hashable, Sendable {
        public var points: [CGPoint]
        /// Preferred spot for a traffic count or label.
        public var labelPoint: CGPoint
        public init(points: [CGPoint], labelPoint: CGPoint) {
            self.points = points
            self.labelPoint = labelPoint
        }
    }

    /// Which edge of a card carries its delegates and messages edges.
    public enum RoleSide: Sendable { case top, bottom }

    enum Channel: Hashable, Sendable { case top, gap(Int), bottom, left, right }

    public let graph: WorkflowGraph
    public let nodeHeight: CGFloat
    /// Horizontal spread applied to stored positions so cards in a row keep a
    /// gutter between them. Graphs from other clients and templates may be
    /// laid out for narrower cards. Drags divide by it to store positions.
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
    public init(graph: WorkflowGraph, nodeHeight: CGFloat, overrides: [String: CGPoint] = [:], extraRoleEdges: [GraphEdge] = []) {
        self.graph = graph
        self.nodeHeight = nodeHeight
        let nodeIds = Set(graph.nodes.map(\.id))
        let roleEdges = graph.edges.filter { $0.kind == .delegates || $0.kind == .messages }
            + extraRoleEdges.filter { nodeIds.contains($0.from.node) && nodeIds.contains($0.to.node) }
        self.roleEdges = roleEdges

        // Taller live cards stretch rows so the gaps between rows keep their lanes.
        let rowStretch = (nodeHeight + Self.rowGap) / (Self.baseNodeHeight + Self.rowGap)
        let topY = graph.nodes.map(\.position.y).min() ?? 0
        let xScale = Self.spread(graph)
        self.xScale = xScale
        let leftX = graph.nodes.map(\.position.x).min() ?? 0
        let size = CGSize(width: Self.nodeWidth, height: nodeHeight)
        var raw: [String: CGRect] = [:]
        for node in graph.nodes {
            let stored = overrides[node.id].map { (x: Double($0.x), y: Double($0.y), override: true) } ?? (x: node.position.x, y: node.position.y, override: false)
            let x = leftX + (stored.x - leftX) * xScale
            let origin = CGPoint(x: x, y: stored.override ? stored.y : topY + (stored.y - topY) * rowStretch)
            raw[node.id] = CGRect(origin: origin, size: size)
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

        func channel(for side: RoleSide, row: Int) -> Channel {
            switch side {
            case .top: row == 0 ? .top : .gap(row - 1)
            case .bottom: row == lastRow ? .bottom : .gap(row)
            }
        }

        func flowPort(_ edge: GraphEdge) -> GraphPort {
            edge.from.port.flatMap(GraphPort.init(rawValue:)) ?? (graph.node(edge.from.node)?.type == .mergeQueue ? .pass : .out)
        }

        // Plan: which flow edges need a lane, and in which channel.
        enum FlowPlan { case direct, lane(Channel) }
        var flowPlans: [String: FlowPlan] = [:]
        var requests: [(id: String, channel: Channel, span: CGFloat, role: Bool)] = []
        for edge in graph.edges where edge.kind == .flow || edge.kind == .unknown {
            guard let a = raw[edge.from.node], let b = raw[edge.to.node], let ra = rowOf[edge.from.node], let rb = rowOf[edge.to.node] else { continue }
            let p1 = Self.port(a, flowPort(edge)), p2 = Self.port(b, .in)
            let plan: FlowPlan
            if ra == rb {
                let blocked = graph.nodes.contains { n in
                    n.id != edge.from.node && n.id != edge.to.node && rowOf[n.id] == ra
                        && raw[n.id]!.maxX > p1.x && raw[n.id]!.minX < p2.x
                }
                plan = p2.x > p1.x + 24 && !blocked ? .direct : .lane(channel(for: .top, row: ra))
            } else {
                plan = .lane(ra < rb ? channel(for: .bottom, row: ra) : channel(for: .bottom, row: rb))
            }
            flowPlans[edge.id] = plan
            if case .lane(let c) = plan { requests.append((edge.id, c, abs(p2.x - p1.x) + abs(p2.y - p1.y), false)) }
        }

        let allMinX = raw.values.map(\.minX).min() ?? 0
        let allMaxX = raw.values.map(\.maxX).max() ?? 0

        // Role edges: one channel when both ends share it, otherwise out to a
        // gutter, along it, and back in.
        struct RolePlan { var a: Channel; var b: Channel; var gutter: Channel? }
        var rolePlans: [String: RolePlan] = [:]
        for edge in roleEdges {
            guard let a = raw[edge.from.node], let b = raw[edge.to.node], let ra = rowOf[edge.from.node], let rb = rowOf[edge.to.node] else { continue }
            let ca = channel(for: sides[edge.from.node]!, row: ra)
            let cb = channel(for: sides[edge.to.node]!, row: rb)
            if ca == cb {
                rolePlans[edge.id] = RolePlan(a: ca, b: cb, gutter: nil)
                requests.append((edge.id, ca, abs(a.midX - b.midX), true))
            } else {
                let leftCost = (a.midX - allMinX) + (b.midX - allMinX)
                let rightCost = (allMaxX - a.midX) + (allMaxX - b.midX)
                let gutter: Channel = leftCost <= rightCost ? .left : .right
                rolePlans[edge.id] = RolePlan(a: ca, b: cb, gutter: gutter)
                let edgeX = gutter == .left ? allMinX : allMaxX
                // Routes that wrap to a gutter enclose everything in their
                // channel, so they always take the outer lanes.
                requests.append((edge.id + "#a", ca, 10_000 + abs(a.midX - edgeX), true))
                requests.append((edge.id + "#b", cb, 10_000 + abs(b.midX - edgeX), true))
                requests.append((edge.id, gutter, abs(a.midY - b.midY), true))
            }
        }

        // Allocate lanes per channel: flow before roles, shortest span first.
        var laneIndex: [String: Int] = [:]
        var laneCount: [Channel: Int] = [:]
        let byChannel = Dictionary(grouping: requests, by: \.channel)
        for (channel, items) in byChannel {
            let ordered = items.sorted { ($0.role ? 1 : 0, $0.span, $0.id) < ($1.role ? 1 : 0, $1.span, $1.id) }
            for (i, item) in ordered.enumerated() { laneIndex[item.id + "@" + Self.key(channel)] = i }
            laneCount[channel] = ordered.count
        }

        // Make room above and to the left for channels, on the grid.
        func extent(_ n: Int, start: CGFloat) -> CGFloat { n == 0 ? 0 : start + CGFloat(n - 1) * Self.lanePitch + 12 }
        let topExtent = extent(laneCount[.top] ?? 0, start: Self.laneStart)
        let leftExtent = extent(laneCount[.left] ?? 0, start: Self.gutterStart)
        let minY = raw.values.map(\.minY).min() ?? 0
        let dx = max(0, ceil((16 + max(leftExtent, Self.stub) - allMinX) / Self.grid) * Self.grid)
        let dy = max(0, ceil((24 + topExtent - minY) / Self.grid) * Self.grid)
        var frames: [String: CGRect] = [:]
        for (id, f) in raw { frames[id] = f.offsetBy(dx: dx, dy: dy) }
        self.frames = frames
        let shiftedRows = rows.map { (minY: $0.minY + dy, maxY: $0.maxY + dy) }
        let minX = allMinX + dx, maxX = allMaxX + dx

        func pitch(_ channel: Channel) -> CGFloat {
            let n = laneCount[channel] ?? 0
            guard case .gap(let g) = channel, n > 1, g + 1 < shiftedRows.count else { return Self.lanePitch }
            let room = shiftedRows[g + 1].minY - shiftedRows[g].maxY - Self.laneStart - 14
            return max(4, min(Self.lanePitch, room / CGFloat(n - 1)))
        }
        func lane(_ channel: Channel, _ id: String) -> CGFloat {
            let i = CGFloat(laneIndex[id + "@" + Self.key(channel)] ?? 0)
            let offset = (channel == .left || channel == .right ? Self.gutterStart : Self.laneStart) + i * pitch(channel)
            switch channel {
            case .top: return (shiftedRows.first?.minY ?? 0) - offset
            case .gap(let g): return shiftedRows[g].maxY + offset
            case .bottom: return (shiftedRows.last?.maxY ?? 0) + offset
            case .left: return minX - offset
            case .right: return maxX + offset
            }
        }

        var routes: [String: Route] = [:]
        for edge in graph.edges where edge.kind == .flow || edge.kind == .unknown {
            guard let plan = flowPlans[edge.id], let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let p1 = Self.port(a, flowPort(edge)), p2 = Self.port(b, .in)
            switch plan {
            case .direct:
                if abs(p1.y - p2.y) < 1 {
                    routes[edge.id] = Route(points: [p1, p2], labelPoint: CGPoint(x: (p1.x + p2.x) / 2, y: p1.y))
                } else {
                    let midX = ((p1.x + p2.x) / 8).rounded() * 4
                    routes[edge.id] = Route(points: [p1, CGPoint(x: midX, y: p1.y), CGPoint(x: midX, y: p2.y), p2], labelPoint: CGPoint(x: midX, y: (p1.y + p2.y) / 2))
                }
            case .lane(let channel):
                let y = lane(channel, edge.id)
                let out = p1.x + Self.stub, inX = p2.x - Self.stub
                routes[edge.id] = Route(
                    points: [p1, CGPoint(x: out, y: p1.y), CGPoint(x: out, y: y), CGPoint(x: inX, y: y), CGPoint(x: inX, y: p2.y), p2],
                    labelPoint: CGPoint(x: (out + inX) / 2, y: y))
            }
        }

        // Attachment slots: spread role edges along each card edge, ordered so
        // stubs do not cross lanes that leave the same card.
        struct Attachment { var edgeId: String; var isFrom: Bool; var heading: CGFloat; var depth: Int }
        var attachments: [String: [Attachment]] = [:]
        var laneY: [String: (a: CGFloat, b: CGFloat, gutterX: CGFloat?)] = [:]
        for edge in roleEdges {
            guard let plan = rolePlans[edge.id], let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let gutterX = plan.gutter.map { lane($0, edge.id) }
            let ya = plan.gutter == nil ? lane(plan.a, edge.id) : lane(plan.a, edge.id + "#a")
            let yb = plan.gutter == nil ? ya : lane(plan.b, edge.id + "#b")
            laneY[edge.id] = (ya, yb, gutterX)
            let depthA = laneIndex[(plan.gutter == nil ? edge.id : edge.id + "#a") + "@" + Self.key(plan.a)] ?? 0
            let depthB = laneIndex[(plan.gutter == nil ? edge.id : edge.id + "#b") + "@" + Self.key(plan.b)] ?? 0
            var headingA = (gutterX ?? b.midX) - a.midX
            var headingB = (gutterX ?? a.midX) - b.midX
            if edge.from.node == edge.to.node { headingA = -1; headingB = 1 }
            attachments[edge.from.node, default: []].append(Attachment(edgeId: edge.id, isFrom: true, heading: headingA, depth: depthA))
            attachments[edge.to.node, default: []].append(Attachment(edgeId: edge.id, isFrom: false, heading: headingB, depth: depthB))
        }
        var slotX: [String: CGFloat] = [:]
        for (nodeId, list) in attachments {
            guard let f = frames[nodeId] else { continue }
            let left = list.filter { $0.heading < 0 }.sorted { ($0.depth, $0.edgeId) < ($1.depth, $1.edgeId) }
            let right = list.filter { $0.heading >= 0 }.sorted { ($0.depth, $0.edgeId) > ($1.depth, $1.edgeId) }
            let ordered = left + right
            let n = CGFloat(ordered.count)
            let step = n > 1 ? min(Self.slotPitch, (f.width - 32) / (n - 1)) : 0
            for (k, item) in ordered.enumerated() {
                slotX[item.edgeId + (item.isFrom ? ">" : "<")] = f.midX + (CGFloat(k) - (n - 1) / 2) * step
            }
        }
        for edge in roleEdges {
            guard let y = laneY[edge.id], let a = frames[edge.from.node], let b = frames[edge.to.node] else { continue }
            let xa = slotX[edge.id + ">"] ?? a.midX, xb = slotX[edge.id + "<"] ?? b.midX
            let pa = CGPoint(x: xa, y: sides[edge.from.node] == .top ? a.minY : a.maxY)
            let pb = CGPoint(x: xb, y: sides[edge.to.node] == .top ? b.minY : b.maxY)
            if let gx = y.gutterX {
                routes[edge.id] = Route(
                    points: [pa, CGPoint(x: xa, y: y.a), CGPoint(x: gx, y: y.a), CGPoint(x: gx, y: y.b), CGPoint(x: xb, y: y.b), pb],
                    labelPoint: CGPoint(x: gx, y: (y.a + y.b) / 2))
            } else {
                routes[edge.id] = Route(
                    points: [pa, CGPoint(x: xa, y: y.a), CGPoint(x: xb, y: y.a), pb],
                    labelPoint: CGPoint(x: (xa + xb) / 2, y: y.a))
            }
        }
        self.routes = routes

        let allPoints = routes.values.flatMap(\.points)
        let maxFrameX = frames.values.map(\.maxX).max() ?? 0
        let maxFrameY = frames.values.map(\.maxY).max() ?? 0
        let width = max(maxFrameX, allPoints.map(\.x).max() ?? 0) + Self.margin
        let height = max(maxFrameY, allPoints.map(\.y).max() ?? 0) + Self.margin + 48
        contentSize = CGSize(width: max(width, 640), height: max(height, 360))
    }

    /// The smallest horizontal scale that leaves 40 pt between cards that
    /// share a row. 1 when the stored layout already fits.
    static func spread(_ graph: WorkflowGraph) -> CGFloat {
        let pitch = Double(nodeWidth + 40)
        var scale = 1.0
        for (i, a) in graph.nodes.enumerated() {
            for b in graph.nodes[(i + 1)...] where abs(a.position.y - b.position.y) < Double(baseNodeHeight) {
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

    static func port(_ f: CGRect, _ port: GraphPort) -> CGPoint {
        switch port {
        case .in: CGPoint(x: f.minX, y: f.minY + 38)
        case .out: CGPoint(x: f.maxX, y: f.minY + 38)
        case .pass: CGPoint(x: f.maxX, y: f.minY + 30)
        case .fail: CGPoint(x: f.maxX, y: f.minY + 52)
        case .role: CGPoint(x: f.midX, y: f.maxY)
        }
    }

    // MARK: Geometry

    public func frame(_ node: GraphNode) -> CGRect {
        frames[node.id] ?? CGRect(origin: .zero, size: CGSize(width: Self.nodeWidth, height: nodeHeight))
    }

    public func frame(id: String) -> CGRect? { frames[id] }

    public func roleSide(_ nodeId: String) -> RoleSide { sides[nodeId] ?? .top }

    /// Port positions on the card edge. The role port sits on the card edge
    /// that faces its channel.
    public func point(_ node: GraphNode, port: GraphPort) -> CGPoint {
        let f = frame(node)
        if port == .role { return CGPoint(x: f.midX, y: roleSide(node.id) == .top ? f.minY : f.maxY) }
        return Self.port(f, port)
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
