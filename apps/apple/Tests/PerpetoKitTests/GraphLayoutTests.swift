import CoreGraphics
import Foundation
import Testing
@testable import PerpetoKit

@Suite("Graph routing")
struct GraphLayoutTests {
    static let unplanned = GraphEdge(id: "unplanned:build>plan", from: .init(node: "build"), to: .init(node: "plan"), kind: .messages)

    /// The hub's build template, laid out for narrower cards than ours.
    static func template() -> WorkflowGraph? {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/workflow/templates/build.json").standardized
        return (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(WorkflowGraph.self, from: $0) }
    }

    static func layouts() -> [(String, GraphLayout)] {
        (template().map { [("hub template live", GraphLayout(graph: $0, nodeHeight: 156))] } ?? []) + [
            ("v3 editor", GraphLayout(graph: DemoFixtures.buildGraphV3(), nodeHeight: 76)),
            ("v3 live", GraphLayout(graph: DemoFixtures.buildGraphV3(), nodeHeight: 156, extraRoleEdges: [unplanned])),
            ("v4 proposal", GraphLayout(graph: DemoFixtures.buildGraphV4(), nodeHeight: 76)),
        ]
    }

    static func segments(_ route: GraphLayout.Route) -> [(CGPoint, CGPoint)] { Array(zip(route.points, route.points.dropFirst())) }

    @Test func roleEdgesStayOutOfTheFlowBand() {
        for (name, layout) in Self.layouts() {
            let frames = layout.graph.nodes.map { layout.frame($0) }
            let row0 = frames.filter { $0.minY == frames.map(\.minY).min() }
            let row1Top = frames.map(\.minY).filter { $0 > row0[0].maxY }.min() ?? .infinity
            for edge in layout.roleEdges {
                let route = try! #require(layout.route(edge))
                for (a, b) in Self.segments(route) where abs(a.y - b.y) < 0.5 {
                    // Horizontal role segments never run in the gap between the first two rows.
                    let inGap = a.y > row0[0].maxY + 0.5 && a.y < row1Top - 0.5
                    #expect(!inGap, "\(name): \(edge.id) runs through the flow band at y \(a.y)")
                }
            }
        }
    }

    @Test func routesNeverCrossCards() {
        for (name, layout) in Self.layouts() {
            for edge in layout.graph.edges + layout.roleEdges {
                guard let route = layout.route(edge) else { continue }
                for node in layout.graph.nodes {
                    let inner = layout.frame(node).insetBy(dx: 2, dy: 2)
                    for (a, b) in Self.segments(route) {
                        let box = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y)).insetBy(dx: -0.5, dy: -0.5)
                        #expect(!box.intersects(inner), "\(name): \(edge.id) crosses \(node.id)")
                    }
                }
            }
        }
    }

    @Test func parallelLanesNeverOverlap() {
        for (name, layout) in Self.layouts() {
            let all = (layout.graph.edges + layout.roleEdges).compactMap { e in layout.route(e).map { (e, $0) } }
            for (i, (e1, r1)) in all.enumerated() {
                for (e2, r2) in all[(i + 1)...] where e1.to.node != e2.to.node && e1.from.node != e2.from.node {
                    for (a, b) in Self.segments(r1) where abs(a.y - b.y) < 0.5 {
                        for (c, d) in Self.segments(r2) where abs(c.y - d.y) < 0.5 && abs(a.y - c.y) < 0.5 {
                            let overlap = min(max(a.x, b.x), max(c.x, d.x)) - max(min(a.x, b.x), min(c.x, d.x))
                            #expect(overlap <= 0.5, "\(name): \(e1.id) and \(e2.id) share a lane")
                        }
                    }
                }
            }
        }
    }

    @Test func labelsNeverOverlap() {
        for (name, layout) in Self.layouts() {
            let ids = (layout.graph.edges + layout.roleEdges).map(\.id)
            let size = CGSize(width: 34, height: 18)
            let placed = layout.placeLabels(ids.map { .init(edgeId: $0, size: size) })
            let rects = placed.map { CGRect(x: $0.value.x - size.width / 2, y: $0.value.y - size.height / 2, width: size.width, height: size.height) }
            for (i, a) in rects.enumerated() {
                for b in rects[(i + 1)...] { #expect(!a.intersects(b), "\(name): labels overlap") }
                for node in layout.graph.nodes { #expect(!a.intersects(layout.frame(node)), "\(name): label covers \(node.id)") }
            }
        }
    }

    @Test func hubTemplateIsValidLocally() throws {
        let result = WorkflowValidator.validate(try #require(Self.template()))
        #expect(result.issues.filter { $0.severity == .error }.map(\.message) == [])
    }

    /// Perpendicular crossings between two edges' segments, away from their ends.
    static func crossings(_ r1: GraphLayout.Route, _ r2: GraphLayout.Route) -> Int {
        var count = 0
        for (a, b) in segments(r1) {
            for (c, d) in segments(r2) {
                let h1 = abs(a.y - b.y) < 0.5, h2 = abs(c.y - d.y) < 0.5
                guard h1 != h2 else { continue }
                let (h, v) = h1 ? ((a, b), (c, d)) : ((c, d), (a, b))
                let x = v.0.x, y = h.0.y
                let inH = x > min(h.0.x, h.1.x) + 0.5 && x < max(h.0.x, h.1.x) - 0.5
                let inV = y > min(v.0.y, v.1.y) + 0.5 && y < max(v.0.y, v.1.y) - 0.5
                if inH && inV { count += 1 }
            }
        }
        return count
    }

    @Test func flowLinesNeverCross() {
        for (name, layout) in Self.layouts() {
            let flow = layout.graph.edges.filter { $0.kind == .flow }.compactMap { e in layout.route(e).map { (e, $0) } }
            for (i, (e1, r1)) in flow.enumerated() {
                for (e2, r2) in flow[(i + 1)...] {
                    #expect(Self.crossings(r1, r2) == 0, "\(name): \(e1.id) crosses \(e2.id)")
                }
            }
        }
    }

    @Test func returnsShareOneLineAndOneLabel() throws {
        let layout = GraphLayout(graph: DemoFixtures.buildGraphV3(), nodeHeight: 120)
        let returns = try #require(layout.returnGroups["loop"])
        #expect(Set(returns) == ["e6", "e8"])
        let ends = returns.compactMap { layout.route(id: $0)?.points.last }
        #expect(Set(ends.map { "\($0.x),\($0.y)" }).count == 1, "returns enter the loop at one point")
        let label = try #require(layout.route(id: "ret:loop"))
        let loop = try #require(layout.frame(id: "loop"))
        // The shared return lane runs above the node rows.
        #expect(label.points.allSatisfy { $0.y < loop.minY })
        #expect(layout.route(id: "e6")?.isReturn == true)
    }

    @Test func forwardEdgesThatSkipRowsUseTheLeftGutter() throws {
        var graph = DemoFixtures.buildGraphV4()
        graph.edges.append(GraphEdge(id: "skip", from: .init(node: "plan"), to: .init(node: "review-ui"), kind: .flow))
        let layout = GraphLayout(graph: graph, nodeHeight: 120)
        let route = try #require(layout.route(id: "skip"))
        let minX = graph.nodes.map { layout.frame($0).minX }.min() ?? 0
        #expect(route.points.contains { $0.x < minX })
        for (_, other) in graph.edges.filter({ $0.kind == .flow && $0.id != "skip" }).compactMap({ e in layout.route(e).map { (e, $0) } }) {
            #expect(Self.crossings(route, other) == 0)
        }
    }

    @Test func crowdedLayoutsSpreadApart() throws {
        let graph = try #require(Self.template())
        let layout = GraphLayout(graph: graph, nodeHeight: 76)
        #expect(layout.xScale > 1)
        let frames = graph.nodes.map { layout.frame($0) }
        for (i, a) in frames.enumerated() {
            for b in frames[(i + 1)...] { #expect(!a.insetBy(dx: -8, dy: 0).intersects(b), "cards collide") }
        }
    }

    @Test func drawingLeavesRoomForChannels() {
        let layout = GraphLayout(graph: DemoFixtures.buildGraphV3(), nodeHeight: 156, extraRoleEdges: [Self.unplanned])
        let points = (layout.graph.edges + layout.roleEdges).compactMap(layout.route).flatMap(\.points)
        #expect(points.allSatisfy { $0.x >= 0 && $0.y >= 0 && $0.x <= layout.contentSize.width && $0.y <= layout.contentSize.height })
    }
}

@Suite("Compact map")
struct CompactLayoutTests {
    @Test func compactCardsFitMoreAndStillNeverCross() throws {
        let graph = try #require(GraphLayoutTests.template())
        let full = GraphLayout(graph: graph, nodeHeight: 120)
        let compact = GraphLayout(graph: graph, nodeHeight: 84, nodeWidth: GraphLayout.compactNodeWidth, gapX: GraphLayout.compactGapX)
        #expect(compact.contentSize.width < full.contentSize.width * 0.85)
        let flow = graph.edges.filter { $0.kind == .flow }.compactMap { compact.route($0) }
        for (i, a) in flow.enumerated() { for b in flow[(i + 1)...] { #expect(GraphLayoutTests.crossings(a, b) == 0) } }
    }
}
