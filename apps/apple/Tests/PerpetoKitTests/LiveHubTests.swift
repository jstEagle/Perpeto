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
