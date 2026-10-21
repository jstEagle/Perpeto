import Foundation
import Testing
@testable import PerpetoKit

@Suite("Workflow validation and diff")
struct WorkflowTests {
    @Test func demoGraphsAreValid() {
        for graph in [DemoFixtures.buildGraphV3(), DemoFixtures.buildGraphV4()] {
            let result = WorkflowValidator.validate(graph)
            #expect(result.valid, "\(result.issues.map(\.message))")
        }
    }

    @Test func missingEndsAndHarness() {
        let graph = WorkflowGraph(nodes: [GraphNode(id: "a", type: .agent, label: "Agent", position: .init(x: 0, y: 0))], edges: [])
        let codes = Set(WorkflowValidator.validate(graph).issues.map(\.code))
        #expect(codes.isSuperset(of: ["NO_INPUT", "NO_OUTPUT", "NO_HARNESS", "UNCONNECTED_PORT"]))
    }

    @Test func gatesMustUsePassAndFail() {
        var graph = DemoFixtures.buildGraphV3()
        let index = graph.edges.firstIndex { $0.id == "e5" }!
        graph.edges[index].from.port = "out"
        let issues = WorkflowValidator.validate(graph).issues
        #expect(issues.contains { $0.code == "BAD_PORT" && $0.edgeId == "e5" })
    }

    @Test func cycleWithoutLoopIsRejected() {
        var graph = DemoFixtures.buildGraphV3()
        let index = graph.edges.firstIndex { $0.id == "e6" }!
        graph.edges[index].to = .init(node: "build")
        #expect(WorkflowValidator.validate(graph).issues.contains { $0.code == "UNBOUNDED_CYCLE" })
    }

    @Test func roleEdgesConnectAgentsOnly() {
        var graph = DemoFixtures.buildGraphV3()
        graph.edges.append(GraphEdge(id: "bad", from: .init(node: "ci"), to: .init(node: "build"), kind: .delegates))
        #expect(WorkflowValidator.validate(graph).issues.contains { $0.code == "ROLE_EDGE" && $0.edgeId == "bad" })
    }

    @Test func diffBetweenActiveAndProposal() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let versions = DemoFixtures.buildVersions(now: now)
        let diff = WorkflowDiff(from: versions[2], to: versions[3])
        #expect(diff.nodes["review"] == .changed)
        #expect(diff.nodes["review-ui"] == .added)
        #expect(diff.nodes["build"] == .unchanged)
        #expect(diff.edgeCount(.added) == 4)
        #expect(diff.removedEdges.map(\.id) == ["m2"])
        #expect(!diff.isEmpty)
    }

    @Test func movingANodeIsNotAChange() {
        let now = Date()
        var proposed = DemoFixtures.buildVersions(now: now)[2]
        let base = proposed
        proposed.graph.nodes[0].position.x += 40
        proposed.version += 1
        #expect(WorkflowDiff(from: base, to: proposed).isEmpty)
    }

    @Test func firstDraftIsAllAdded() {
        let draft = DemoFixtures.buildVersions(now: Date())[2]
        let diff = WorkflowDiff(from: nil, to: draft)
        #expect(diff.count(.added) == draft.graph.nodes.count)
    }
}

@Suite("Demo data source")
struct DemoDataSourceTests {
    @Test func storyHasSaturatedReviewReworkLoopAndTwoMachines() async throws {
        let source = DemoDataSource(now: { Date(timeIntervalSince1970: 1_800_000_000) }, stageDelay: .zero)
        let factory = try await source.loadFactory()
        #expect(factory.machines.filter { $0.status == .online }.count == 2)
        let state = try await source.loadProject(DemoFixtures.primaryProjectId)
        let metrics = try #require(state.metrics)
        #expect(metrics.topBottleneck?.reason == .saturated)
        #expect(metrics.bottlenecks.contains { $0.reason == .reworkLoop })
        #expect(state.pendingDraft(of: DemoFixtures.buildWorkflowId)?.version == 4)
        #expect(state.activeVersion(of: DemoFixtures.buildWorkflowId)?.version == 3)
        #expect(state.activeAgents == metrics.run.activeAgents)
        #expect(Set(state.assignments.filter(\.isWorking).compactMap(\.machineId)) == [DemoFixtures.studioId, DemoFixtures.linuxId])
    }

    @Test func draftThenActivate() async throws {
        let source = DemoDataSource(now: { Date(timeIntervalSince1970: 1_800_000_000) }, stageDelay: .zero)
        var stages: [DraftProgress.Stage] = []
        var draft: Workflow?
        for try await progress in source.requestDraft(projectId: DemoFixtures.primaryProjectId, prompt: "Require a person to approve merges", baseWorkflowId: DemoFixtures.buildWorkflowId) {
            stages.append(progress.stage)
            draft = progress.draft ?? draft
        }
        #expect(stages == [.queued, .reading, .drafting, .validating, .ready])
        let proposed = try #require(draft)
        #expect(proposed.version == 5)
        #expect(proposed.authoredBy?.kind == .agent)
        #expect(proposed.authoredBy?.prompt == "Require a person to approve merges")
        #expect(proposed.parentVersion == 3)
        #expect(WorkflowValidator.validate(proposed.graph).valid)

        _ = try await source.activate(workflowId: proposed.id, version: 5)
        let state = try await source.loadProject(DemoFixtures.primaryProjectId)
        #expect(state.activeVersion(of: proposed.id)?.version == 5)
        #expect(state.versions[proposed.id]?.filter { $0.status == .active }.count == 1)
    }

    @Test func usageGroupsAddUp() {
        let records = DemoFixtures.usageRecords(projectId: DemoFixtures.primaryProjectId, now: Date(timeIntervalSince1970: 1_800_000_000))
        let bundle = UsageBundle(records: records)
        #expect(bundle.byDay.count == 14)
        #expect(bundle.total == records.reduce(0) { $0 + $1.totalTokens })
        #expect(bundle.byProvider.reduce(0) { $0 + $1.totalTokens } == bundle.total)
    }
}

@Suite("Logo geometry")
struct LogoTests {
    @Test func symbolAndWordmarkParse() {
        #expect(LogoGeometry.spindle.path.boundingRect.width > 700)
        let ratio = WordmarkShape.aspectRatio
        #expect(ratio > 3.9 && ratio < 4.3, "wordmark aspect \(ratio)")
    }

    @Test func parserHandlesRelativeCommands() {
        let path = SVGPathParser.parse("M10 10 l 5 0 c 0 5 -5 5 -5 0 z")
        #expect(path.boundingRect == CGRect(x: 10, y: 10, width: 5, height: 3.75))
    }
}
