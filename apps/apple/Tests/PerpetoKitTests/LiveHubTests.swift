import Foundation
import Testing
@testable import PerpetoKit

/// Runs against a real hub only when `PERPETO_HUB_URL` and
/// `PERPETO_HUB_TOKEN_FILE` are set, for example after
/// `scripts/seed-hub.mjs`. Reads every route the app uses and decodes it.
@Suite("Live hub", .enabled(if: LiveHub.client != nil))
struct LiveHubTests {
    @Test func everyReadDecodes() async throws {
        let client = try #require(LiveHub.client)
        let source = HubDataSource(client: client)
        #expect(try await client.health().status == "ok")
        let factory = try await source.loadFactory()
        #expect(!factory.projects.isEmpty)
        for project in factory.projects {
            let state = try await source.loadProject(project.id, window: .day)
            for run in state.runs.prefix(2) {
                for window in MetricsWindow.allCases {
                    let snapshot = try await source.loadRun(run.id, window: window)
                    if let metrics = snapshot.metrics {
                        #expect(metrics.window == window)
                        #expect(!metrics.nodes.isEmpty)
                    }
                }
            }
            for workflow in state.workflows {
                let result = try await client.validate(workflowId: workflow.id, graph: workflow.graph)
                #expect(result.valid, "\(workflow.name): \(result.issues.map(\.message))")
                #expect(WorkflowValidator.validate(workflow.graph).errorCount == 0, "local validator disagrees on \(workflow.name)")
            }
            // The data source tolerates some failures; call each route directly so none hides.
            _ = try await client.jobs(projectId: project.id)
            _ = try await client.projectMetrics(projectId: project.id, window: .week)
            _ = try await client.mergeQueue(projectId: project.id)
            for channel in try await client.channels(projectId: project.id) {
                _ = try await client.messages(projectId: project.id, channelId: channel.id)
            }
            for run in try await client.runs(projectId: project.id).prefix(2) {
                let metrics = try await client.runMetrics(runId: run.id, window: .hour)
                #expect(!metrics.nodes.isEmpty)
                for assignment in try await client.assignments(runId: run.id).prefix(3) {
                    #expect(try await client.assignment(assignment.id).id == assignment.id)
                }
                _ = try await client.workItems(runId: run.id)
            }
        }
        let page = try await client.events(after: nil, limit: 50)
        #expect(page.nextCursor != nil)
        let recent = try await client.recentEvents(count: 100)
        #expect(recent.events.count <= 100)
        _ = try await client.overview()
        _ = try await client.accounts()
        for grouping in UsageGrouping.allCases { _ = try await client.usage(groupBy: grouping) }
    }

    /// Creates a small project whose run waits at a human gate, answers it
    /// with its decisionId, then shows a repeat of that answer is refused.
    @Test func humanDecisionIsBoundToItsWait() async throws {
        let client = try #require(LiveHub.client)
        let project = try await client.createProject(.init(name: "decision-check", repo: .init(url: "https://example.com/r.git", defaultBranch: "main")))
        let graph = WorkflowGraph(nodes: [
            GraphNode(id: "ideas", type: .input, label: "Ideas", position: .init(x: 0, y: 0), config: ["source": "manual"]),
            GraphNode(id: "approve", type: .human, label: "Approve", position: .init(x: 208, y: 0), config: ["prompt": "Approve this release."]),
            GraphNode(id: "done", type: .output, label: "Done", position: .init(x: 416, y: 0)),
            GraphNode(id: "dropped", type: .output, label: "Dropped", position: .init(x: 416, y: 180)),
        ], edges: [
            GraphEdge(id: "e1", from: .init(node: "ideas"), to: .init(node: "approve"), kind: .flow),
            GraphEdge(id: "e2", from: .init(node: "approve", port: "pass"), to: .init(node: "done"), kind: .flow),
            GraphEdge(id: "e3", from: .init(node: "approve", port: "fail"), to: .init(node: "dropped"), kind: .flow),
        ])
        #expect(WorkflowValidator.validate(graph).valid)
        var unprompted = graph
        unprompted.nodes[1].config = [:]
        // Local checks and the workflow package agree that a person needs a prompt.
        #expect(WorkflowValidator.validate(unprompted).issues.contains { $0.code == "MISSING_CONFIG" })
        await #expect(throws: HubError.self) {
            _ = try await client.createWorkflow(projectId: project.id, name: "Unprompted", purpose: .custom, graph: unprompted)
        }
        let workflow = try await client.createWorkflow(projectId: project.id, name: "Approve", purpose: .custom, graph: graph)
        _ = try await client.activate(workflowId: workflow.id, version: workflow.version)
        let run = try await client.startRun(workflowId: workflow.id, items: ["Ship it", "Ship that"])
        var waiting: [WorkItem] = []
        for _ in 0..<50 where waiting.count < 2 {
            waiting = try await client.workItems(runId: run.id).filter { $0.status == .blocked && $0.decisionId != nil }
            try await Task.sleep(for: .milliseconds(100))
        }
        let item = try #require(waiting.first)
        try await client.decide(workItemId: item.id, .pass, decisionId: item.decisionId)
        await #expect(throws: HubError.self) {
            try await client.decide(workItemId: item.id, .pass, decisionId: item.decisionId)
        }
        // The data source path the app uses.
        try await HubDataSource(client: client).decide(workItemId: waiting[1].id, .fail, decisionId: waiting[1].decisionId)
        let after = try await client.workItems(runId: run.id)
        #expect(after.first { $0.id == item.id }?.status != .blocked)
        #expect(after.first { $0.id == waiting[1].id }?.status != .blocked)
    }
}

enum LiveHub {
    static let client: HubClient? = {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["PERPETO_HUB_URL"].flatMap(URL.init(string:)),
              let path = env["PERPETO_HUB_TOKEN_FILE"],
              let token = try? String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return try? HubClient(baseURL: url, token: token)
    }()
}
