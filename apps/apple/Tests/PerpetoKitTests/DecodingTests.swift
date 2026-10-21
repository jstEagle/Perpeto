import Foundation
import Testing
@testable import PerpetoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try HubCoding.decoder().decode(T.self, from: Data(json.utf8))
}

@Suite("Contract entity decoding")
struct EntityDecodingTests {
    @Test func project() throws {
        let project = try decode(Project.self, """
        { "id": "prj_a1", "name": "perpeto", "repo": { "url": "https://github.com/jstEagle/Perpeto", "defaultBranch": "main" },
          "docs": [{ "id": "doc_1", "title": "Vision", "path": "docs/product/vision.md", "kind": "vision" }],
          "goals": ["Ship"], "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:30:00Z" }
        """)
        #expect(project.repo.defaultBranch == "main")
        #expect(project.repo.localPath == nil)
        #expect(project.docs.first?.kind == .vision)
        #expect(project.updatedAt.timeIntervalSince(project.createdAt) == 1800)
    }

    @Test func workflowWithAuthorship() throws {
        let workflow = try decode(Workflow.self, """
        { "id": "wf_1", "projectId": "prj_a1", "name": "Build", "purpose": "build", "version": 4, "status": "draft",
          "authoredBy": { "kind": "agent", "assignmentId": "asg_9", "prompt": "Describe how this project should be built" },
          "rationale": "Review is saturated.", "parentVersion": 3,
          "graph": { "schema": "perpeto.workflow/1",
            "nodes": [{ "id": "in", "type": "input", "label": "Ideas", "position": { "x": 0, "y": 0 }, "config": { "source": "manual" } },
                      { "id": "mq", "type": "merge-queue", "label": "Queue", "position": { "x": 200, "y": 0 }, "config": { "strategy": "serial", "requiredChecks": ["CI"] } }],
            "edges": [{ "id": "e1", "from": { "node": "in" }, "to": { "node": "mq", "port": null }, "kind": "flow" }] } }
        """)
        #expect(workflow.authoredBy?.kind == .agent)
        #expect(workflow.authoredBy?.assignmentId == "asg_9")
        #expect(workflow.rationale == "Review is saturated.")
        #expect(workflow.parentVersion == 3)
        #expect(workflow.graph.nodes[1].type == .mergeQueue)
        #expect(workflow.graph.nodes[1].config["requiredChecks"]?.arrayValue?.first?.stringValue == "CI")
        #expect(workflow.graph.edges[0].from.port == nil)
    }

    @Test func workflowWithoutAuthorshipFromOlderHub() throws {
        let workflow = try decode(Workflow.self, """
        { "id": "wf_1", "projectId": "p", "name": "B", "purpose": "custom", "version": 1, "status": "active",
          "graph": { "schema": "perpeto.workflow/1", "nodes": [], "edges": [] } }
        """)
        #expect(workflow.authoredBy == nil)
        #expect(workflow.rationale == nil)
        #expect(workflow.parentVersion == nil)
    }

    @Test func assignmentWithResult() throws {
        let assignment = try decode(Assignment.self, """
        { "id": "asg_1", "runId": "run_1", "workItemId": "wi_1", "nodeId": "build", "role": "builder", "prompt": "Do it",
          "harness": { "provider": "claudeAgent", "model": "claude-opus-5-5", "options": { "fast": true } },
          "policy": { "maxSubagents": 2, "allowedSubagentProviders": ["codex"], "canMessage": ["review"] },
          "requirements": { "os": "darwin" }, "status": "succeeded", "machineId": "mch_1",
          "leaseExpiresAt": "2026-10-21T10:00:00.5Z", "attempt": 2,
          "result": { "outcome": "success", "summary": "Opened PR", "prUrl": "https://example.com/pr/1", "headSha": "abc" } }
        """)
        #expect(assignment.harness.options?["fast"]?.boolValue == true)
        #expect(assignment.policy.maxTurns == nil)
        #expect(assignment.result?.outcome == .success)
        #expect(assignment.isWorking == false)
    }

    @Test func jobMachineAccountUsage() throws {
        let job = try decode(Job.self, """
        { "id": "job_1", "projectId": "p", "repo": "r", "revision": "0123456789abcdef0123456789abcdef01234567",
          "steps": [{ "name": "Test", "run": "npm test", "timeoutSec": 600 }], "requirements": {}, "status": "error",
          "attempt": 1, "artifacts": [], "configHash": "h" }
        """)
        #expect(job.status == .error)
        #expect(job.steps.first?.timeoutSec == 600)

        let machine = try decode(Machine.self, """
        { "id": "mch_1", "name": "studio", "os": "darwin", "arch": "arm64", "labels": [], "providers": ["codex"],
          "capacity": { "maxAgents": 6, "maxJobs": 2 }, "running": { "agents": 3, "jobs": 0 }, "status": "draining",
          "lastHeartbeatAt": "2026-10-21T10:00:00Z", "version": "0.3.0" }
        """)
        #expect(machine.status == .draining)
        #expect(machine.capacity.maxAgents == 6)

        let account = try decode(Account.self, """
        { "id": "acct_1", "machineId": "mch_1", "provider": "claudeAgent", "label": "Max", "status": "cooling", "cooldownUntil": "2026-10-21T11:00:00Z" }
        """)
        #expect(account.status == .cooling)
        #expect(account.lastUsedAt == nil)

        let usage = try decode(UsageRecord.self, """
        { "id": "use_1", "projectId": "p", "machineId": "m", "provider": "codex", "model": "gpt-5-codex",
          "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 100, "cacheWriteTokens": 1, "at": "2026-10-21T10:00:00Z" }
        """)
        #expect(usage.totalTokens == 116)
        #expect(usage.costUsd == nil)
    }

    @Test func eventInteraction() throws {
        let event = try decode(HubEvent.self, """
        { "seq": 42, "at": "2026-10-21T10:00:00Z", "type": "agent.messaged", "projectId": "p", "runId": "run_1",
          "subject": { "kind": "assignment", "id": "asg_1" },
          "data": { "messageId": "msg_1", "senderRoleId": "builder", "recipientRoleId": "planner", "nodeId": "build",
                    "sourceNodeId": "build", "targetNodeId": "plan", "role": "builder", "unplanned": true } }
        """)
        #expect(event.interaction == .agentMessaged)
        #expect(event.isUnplanned)
        #expect(event.nodeIds == ["build", "plan"])
    }

    @Test func unknownEnumValuesDoNotFailDecoding() throws {
        let run = try decode(Run.self, """
        { "id": "run_1", "projectId": "p", "workflowId": "w", "workflowVersion": 1, "status": "archived", "startedAt": "2026-10-21T10:00:00Z" }
        """)
        #expect(run.status == .unknown)
        let node = try decode(GraphNode.self, """
        { "id": "x", "type": "fancy", "label": "X", "position": { "x": 1, "y": 2 }, "config": {} }
        """)
        #expect(node.type == .unknown)
    }

    @Test func invalidTimestampFails() {
        #expect(throws: DecodingError.self) {
            try decode(Run.self, """
            { "id": "run_1", "projectId": "p", "workflowId": "w", "workflowVersion": 1, "status": "running", "startedAt": "yesterday" }
            """)
        }
    }
}

@Suite("Observing-runs metrics decoding")
struct MetricsDecodingTests {
    static let snapshotJSON = """
    { "nodes": [{ "nodeId": "review", "queued": 7, "active": 1, "done": 30, "failed": 13, "errors": 0, "concurrency": 1, "utilization": 1.0,
                  "waitSec": { "avg": 2280, "p90": 4260 }, "serviceSec": { "avg": 1340, "p90": 2100 },
                  "throughputPerHour": 1.4, "failureRate": 0.43, "tokens": 3120000, "retries": 2, "escalations": 0 },
                { "nodeId": "in", "queued": 0, "active": 0, "done": 3, "failed": 0, "errors": 0, "concurrency": null, "utilization": null,
                  "waitSec": { "avg": null, "p90": null }, "serviceSec": { "avg": null, "p90": null },
                  "throughputPerHour": 0, "failureRate": null, "tokens": 0, "retries": 0, "escalations": 0 }],
      "edges": [{ "edgeId": "m1", "kind": "messages", "count": 46, "unplanned": false },
                { "edgeId": "unplanned:messages:build->plan", "kind": "messages", "count": 4, "unplanned": true, "from": "build", "to": "plan" }],
      "runs": ["run_1"],
      "run": { "velocity": { "itemsDonePerDay": 5.5, "trend": [2, 4, 6] }, "cycleTimeSec": { "avg": 15100, "p90": 26400 },
               "wip": 15, "tokensPerItem": 1508000, "activeAgents": 5, "retries": 2, "escalations": 1, "waitingOnHuman": 0,
               "machines": [{ "machineId": "mch_studio", "activeAgents": 4, "nodes": ["build", "review"] }] },
      "bottlenecks": [{ "nodeId": "review", "reason": "saturated", "evidence": "Utilization 1.00", "severity": "critical" },
                      { "nodeId": "loop", "reason": "rework-loop", "evidence": "1.6 iterations", "severity": "warning" },
                      { "nodeId": "ci", "reason": "no-capacity", "evidence": "No linux machine", "severity": "info" }] }
    """

    @Test func snapshot() throws {
        let snapshot = try decode(MetricsSnapshot.self, Self.snapshotJSON)
        let review = try #require(snapshot.node("review"))
        #expect(review.utilization == 1.0)
        #expect(review.waitSec.p90 == 4260)
        #expect(review.retries == 2)
        let input = try #require(snapshot.node("in"))
        #expect(input.concurrency == nil)
        #expect(input.waitSec.avg == nil)
        #expect(input.failureRate == nil)
        let unplanned = try #require(snapshot.edges.first { $0.unplanned })
        #expect(unplanned.from == "build")
        #expect(unplanned.to == "plan")
        #expect(snapshot.runs == ["run_1"])
        #expect(snapshot.run.escalations == 1)
        #expect(snapshot.edge("m1")?.kind == .messages)
        #expect(snapshot.run.velocity.trend == [2, 4, 6])
        #expect(snapshot.run.machines.first?.nodes == ["build", "review"])
        #expect(snapshot.bottlenecks.map(\.reason) == [.saturated, .reworkLoop, .noCapacity])
        #expect(snapshot.topBottleneck?.nodeId == "review")
    }

    @Test func allBottleneckReasons() throws {
        for raw in ["saturated", "queue-growing", "high-failure", "waiting-on-human", "no-capacity", "rework-loop"] {
            let b = try decode(Bottleneck.self, #"{ "nodeId": "n", "reason": "\#(raw)", "evidence": "e", "severity": "info" }"#)
            #expect(b.reason.rawValue == raw)
        }
    }

    @Test func roundTrip() throws {
        var snapshot = DemoFixtures.liveMetrics()
        // The window is the request's, not part of the body.
        snapshot.window = nil
        let data = try HubCoding.encoder().encode(snapshot)
        #expect(try HubCoding.decoder().decode(MetricsSnapshot.self, from: data) == snapshot)
    }
}

@Suite("Response envelopes")
struct EnvelopeTests {
    struct Item: Decodable, Equatable { var id: String }

    @Test func keyedList() throws {
        let decoder = HubCoding.decoder()
        decoder.userInfo[KeyedList<Item>.keyInfo] = "groups"
        let list = try decoder.decode(KeyedList<Item>.self, from: Data(#"{"groupBy":"day","groups":[{"id":"a"}],"totals":{"records":1}}"#.utf8))
        #expect(list.items == [Item(id: "a")])
    }

    @Test func validationSplitsErrorsAndWarnings() throws {
        let result = try decode(ValidationResult.self, """
        {"valid":false,"errors":[{"code":"NO_INPUT","message":"m"}],"warnings":[{"code":"UNREACHABLE","message":"w","nodeId":"x"}]}
        """)
        #expect(result.valid == false)
        #expect(result.errorCount == 1)
        #expect(result.warningCount == 1)
        #expect(result.issues.last?.nodeId == "x")
    }

    @Test func lossyDocsAndArchitectAssignment() throws {
        let project = try decode(Project.self, """
        { "id": "prj_1", "name": "n", "repo": { "url": "u", "defaultBranch": "main" }, "docs": ["README.md", { "id": "d", "title": "Spec", "kind": "spec" }],
          "goals": [], "createdAt": "2026-10-21T09:00:00Z", "updatedAt": "2026-10-21T09:00:00Z" }
        """)
        #expect(project.docs.map(\.id) == ["d"])
        let assignment = try decode(Assignment.self, HubShapes.architectAssignment)
        #expect(assignment.workItemId == nil)
        #expect(assignment.architectAttempt == 1)
    }

    @Test func overviewDefaultsMissingCounts() throws {
        let overview = try decode(FactoryOverview.self, #"{"activeAgents":5}"#)
        #expect(overview.activeAgents == 5)
        #expect(overview.machinesOnline == 0)
    }
}
