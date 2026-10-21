import Foundation

/// Deterministic demo fixtures, used when no hub is configured.
///
/// The story: the `perpeto` project runs its agent-authored Build workflow on
/// two machines. Builders finish faster than the single reviewer can keep up,
/// so review is saturated and its queue is growing. Items that fail review go
/// back through the loop, and several are on their last allowed iteration.
/// A reviewer agent has proposed a draft that adds a second review role.
public enum DemoFixtures {
    public static let primaryProjectId = "prj_perpeto"
    public static let buildWorkflowId = "wf_build"
    public static let improveWorkflowId = "wf_improve"
    public static let liveRunId = "run_7kq2m"
    public static let studioId = "mch_studio"
    public static let linuxId = "mch_linux01"

    public static func factory(now: Date) -> FactoryState {
        let projects = projects(now: now)
        let records = projects.flatMap { usageRecords(projectId: $0.id, now: now) }
        let primary = project(primaryProjectId, now: now)
        let machines = machines(now: now)
        return FactoryState(
            projects: projects,
            machines: machines,
            accounts: accounts(now: now),
            jobs: jobs(now: now),
            overview: FactoryOverview(
                activeAgents: primary.activeAgents,
                queuedWork: primary.queuedWork,
                tokensToday: UsageBundle(records: records).today,
                machinesOnline: machines.filter { $0.status == .online }.count),
            usage: UsageBundle(records: records))
    }

    public static func projects(now: Date) -> [Project] {
        [
            Project(
                id: primaryProjectId, name: "perpeto",
                repo: .init(url: "https://github.com/jstEagle/Perpeto", defaultBranch: "main", localPath: "~/Developer/Perpeto"),
                docs: [
                    DocRef(id: "doc_vision", title: "Vision", path: "docs/product/vision.md", kind: .vision),
                    DocRef(id: "doc_arch", title: "Factory architecture", path: "docs/architecture/README.md", kind: .spec),
                    DocRef(id: "doc_dod", title: "Definition of done", path: "docs/product/definition-of-done.md", kind: .requirements),
                ],
                goals: [
                    "Run a build workflow from input to merged output on two machines",
                    "Every merge is backed by CI at the exact head commit",
                    "Keep review latency under 30 minutes at p90",
                ],
                createdAt: now.addingTimeInterval(-86400 * 9), updatedAt: now.addingTimeInterval(-3600 * 2)),
            Project(
                id: "prj_ledger", name: "ledger-service",
                repo: .init(url: "https://github.com/example/ledger-service", defaultBranch: "main"),
                docs: [DocRef(id: "doc_ledger_req", title: "Requirements", path: "docs/requirements.md", kind: .requirements)],
                goals: ["Reduce p95 write latency", "Remove deprecated v1 endpoints"],
                createdAt: now.addingTimeInterval(-86400 * 30), updatedAt: now.addingTimeInterval(-86400)),
            Project(
                id: "prj_docs", name: "docs-site",
                repo: .init(url: "https://github.com/example/docs-site", defaultBranch: "main"),
                docs: [], goals: ["Publish setup guides for machine enrollment"],
                createdAt: now.addingTimeInterval(-86400 * 2), updatedAt: now.addingTimeInterval(-86400 * 2)),
        ]
    }

    public static func project(_ id: String, now: Date) -> ProjectState {
        switch id {
        case primaryProjectId: perpeto(now: now)
        case "prj_ledger": ledger(now: now)
        default: ProjectState(
            workflows: [], versions: [:], runs: [], workItems: [], assignments: [], mergeQueue: [], channels: [],
            messages: [:], usage: UsageBundle(records: usageRecords(projectId: id, now: now)), metrics: nil, runMetrics: [:], events: [])
        }
    }

    // MARK: Machines and accounts

    public static func machines(now: Date) -> [Machine] {
        [
            Machine(
                id: studioId, name: "studio-m4", os: "darwin", arch: "arm64", labels: ["mac", "xcode"],
                providers: ["claudeAgent", "codex"], capacity: .init(maxAgents: 6, maxJobs: 2), running: .init(agents: 4, jobs: 0),
                status: .online, lastHeartbeatAt: now.addingTimeInterval(-4), version: "0.3.0"),
            Machine(
                id: linuxId, name: "build-linux-01", os: "linux", arch: "x64", labels: ["linux", "ci"],
                providers: ["claudeAgent", "codex"], capacity: .init(maxAgents: 4, maxJobs: 2), running: .init(agents: 1, jobs: 1),
                status: .online, lastHeartbeatAt: now.addingTimeInterval(-7), version: "0.3.0"),
        ]
    }

    public static func accounts(now: Date) -> [Account] {
        [
            Account(id: "acct_c1", machineId: studioId, provider: "claudeAgent", label: "Claude Max 1", status: .active, lastUsedAt: now.addingTimeInterval(-40)),
            Account(id: "acct_c2", machineId: studioId, provider: "claudeAgent", label: "Claude Max 2", status: .cooling, cooldownUntil: now.addingTimeInterval(38 * 60), lastUsedAt: now.addingTimeInterval(-22 * 60)),
            Account(id: "acct_x1", machineId: studioId, provider: "codex", label: "ChatGPT Pro 1", status: .active, lastUsedAt: now.addingTimeInterval(-90)),
            Account(id: "acct_c3", machineId: linuxId, provider: "claudeAgent", label: "Claude Max 3", status: .active, lastUsedAt: now.addingTimeInterval(-300)),
            Account(id: "acct_x2", machineId: linuxId, provider: "codex", label: "ChatGPT Pro 2", status: .invalid, lastUsedAt: now.addingTimeInterval(-86400 * 3)),
        ]
    }

    public static func jobs(now: Date) -> [Job] {
        [
            Job(id: "job_91c", projectId: primaryProjectId, runId: liveRunId, workItemId: "wi_07", repo: "https://github.com/jstEagle/Perpeto",
                revision: "8e41c0d2b7a9f3e15c6d4a8b2f0e9c7d1a3b5e6f", steps: ciSteps, requirements: .init(os: "linux", labels: ["ci"]),
                status: .running, machineId: linuxId, leaseExpiresAt: now.addingTimeInterval(48), attempt: 1, configHash: "c0f3a1"),
            Job(id: "job_90b", projectId: primaryProjectId, runId: liveRunId, workItemId: "wi_03", repo: "https://github.com/jstEagle/Perpeto",
                revision: "3f2a9c1e0d8b7a6f5e4d3c2b1a0f9e8d7c6b5a49", steps: ciSteps, requirements: .init(os: "linux", labels: ["ci"]),
                status: .failed, machineId: linuxId, attempt: 1, configHash: "c0f3a1"),
            Job(id: "job_8fa", projectId: primaryProjectId, runId: liveRunId, workItemId: "wi_01", repo: "https://github.com/jstEagle/Perpeto",
                revision: "a71d2e9f0c3b4a5d6e7f8091a2b3c4d5e6f70812", steps: ciSteps, requirements: .init(os: "linux", labels: ["ci"]),
                status: .passed, machineId: linuxId, attempt: 1, configHash: "c0f3a1"),
        ]
    }

    static let ciSteps = [
        JobStep(name: "Install", run: "npm ci", timeoutSec: 600),
        JobStep(name: "Test", run: "npm test", timeoutSec: 900),
        JobStep(name: "Build runtime", run: "npm run build", timeoutSec: 1200),
    ]

    // MARK: Workflows

    static func harness(_ provider: String, _ model: String) -> JSONValue {
        ["provider": .string(provider), "model": .string(model)]
    }

    /// Grid layout shared by the graph versions: 208 pt columns, 180 pt rows.
    static func column(_ index: Int, row: Int = 0) -> GraphNode.Position {
        .init(x: Double(48 + index * 208), y: Double(64 + row * 180))
    }

    public static func buildGraphV3() -> WorkflowGraph {
        WorkflowGraph(
            nodes: [
                GraphNode(id: "in", type: .input, label: "Roadmap", position: column(0),
                          config: ["source": "goals", "docs": ["doc_vision", "doc_arch"]]),
                GraphNode(id: "plan", type: .planner, label: "Planner", position: column(1),
                          config: ["harness": harness("claudeAgent", "claude-opus-5-5"), "prompt": "Split goals into reviewable work items with acceptance checks.", "maxItems": 12]),
                GraphNode(id: "loop", type: .loop, label: "Review loop", position: column(2),
                          config: ["until": "review-pass", "maxIterations": 3]),
                GraphNode(id: "build", type: .agent, label: "Builder", position: column(3),
                          config: ["harness": harness("codex", "gpt-5-codex"), "prompt": "Implement the work item on its own branch and open a PR.", "concurrency": 6,
                                   "policy": ["maxSubagents": 2, "allowedSubagentProviders": ["codex"], "maxTurns": 40]]),
                GraphNode(id: "review", type: .review, label: "Reviewer", position: column(0, row: 1),
                          config: ["harness": harness("claudeAgent", "claude-opus-5-5"), "prompt": "Review the PR against the item's acceptance checks.", "concurrency": 1,
                                   "rubric": "Correctness, tests at the head commit, contract names unchanged."]),
                GraphNode(id: "ci", type: .ci, label: "CI", position: column(1, row: 1),
                          config: ["steps": .array(ciSteps.map { ["name": .string($0.name), "run": .string($0.run)] }), "requirements": ["os": "linux", "labels": ["ci"]]]),
                GraphNode(id: "mq", type: .mergeQueue, label: "Merge queue", position: column(2, row: 1),
                          config: ["strategy": "serial", "method": "squash", "requiredChecks": ["CI"]]),
                GraphNode(id: "out", type: .output, label: "Merged to main", position: column(3, row: 1)),
            ],
            edges: [
                GraphEdge(id: "e1", from: .init(node: "in"), to: .init(node: "plan"), kind: .flow),
                GraphEdge(id: "e2", from: .init(node: "plan"), to: .init(node: "loop"), kind: .flow),
                GraphEdge(id: "e3", from: .init(node: "loop"), to: .init(node: "build"), kind: .flow),
                GraphEdge(id: "e4", from: .init(node: "build"), to: .init(node: "review"), kind: .flow),
                GraphEdge(id: "e5", from: .init(node: "review", port: "pass"), to: .init(node: "ci"), kind: .flow),
                GraphEdge(id: "e6", from: .init(node: "review", port: "fail"), to: .init(node: "loop"), kind: .flow),
                GraphEdge(id: "e7", from: .init(node: "ci", port: "pass"), to: .init(node: "mq"), kind: .flow),
                GraphEdge(id: "e8", from: .init(node: "ci", port: "fail"), to: .init(node: "loop"), kind: .flow),
                GraphEdge(id: "e9", from: .init(node: "mq"), to: .init(node: "out"), kind: .flow),
                GraphEdge(id: "d1", from: .init(node: "plan", port: "role"), to: .init(node: "build", port: "role"), kind: .delegates),
                GraphEdge(id: "m1", from: .init(node: "build", port: "role"), to: .init(node: "review", port: "role"), kind: .messages),
                GraphEdge(id: "m2", from: .init(node: "plan", port: "role"), to: .init(node: "review", port: "role"), kind: .messages),
            ])
    }

    /// The reviewer agent's proposal: a second, UI-focused review role and
    /// review concurrency raised from 1 to 2.
    public static func buildGraphV4() -> WorkflowGraph {
        var graph = buildGraphV3()
        if let index = graph.nodes.firstIndex(where: { $0.id == "review" }) {
            graph.nodes[index].config["concurrency"] = 2
        }
        graph.nodes.append(GraphNode(
            id: "review-ui", type: .review, label: "UI reviewer", position: column(0, row: 2),
            config: ["harness": harness("claudeAgent", "claude-sonnet-5-5"), "prompt": "Review UI and copy changes against brand/README.md.", "concurrency": 1,
                     "rubric": "Tokens only, sentence case, explicit status labels."]))
        graph.edges.removeAll { $0.id == "m2" }
        graph.edges += [
            GraphEdge(id: "e10", from: .init(node: "build"), to: .init(node: "review-ui"), kind: .flow),
            GraphEdge(id: "e11", from: .init(node: "review-ui", port: "pass"), to: .init(node: "ci"), kind: .flow),
            GraphEdge(id: "e12", from: .init(node: "review-ui", port: "fail"), to: .init(node: "loop"), kind: .flow),
            GraphEdge(id: "m3", from: .init(node: "build", port: "role"), to: .init(node: "review-ui", port: "role"), kind: .messages),
        ]
        return graph
    }

    static func buildVersions(now: Date) -> [Workflow] {
        var v1 = buildGraphV3()
        v1.nodes = v1.nodes.filter { $0.id != "loop" }
        v1.edges = [
            GraphEdge(id: "e1", from: .init(node: "in"), to: .init(node: "plan"), kind: .flow),
            GraphEdge(id: "e2b", from: .init(node: "plan"), to: .init(node: "build"), kind: .flow),
            GraphEdge(id: "e4", from: .init(node: "build"), to: .init(node: "review"), kind: .flow),
            GraphEdge(id: "e5", from: .init(node: "review", port: "pass"), to: .init(node: "ci"), kind: .flow),
            GraphEdge(id: "e6b", from: .init(node: "review", port: "fail"), to: .init(node: "out"), kind: .flow),
            GraphEdge(id: "e7", from: .init(node: "ci", port: "pass"), to: .init(node: "mq"), kind: .flow),
            GraphEdge(id: "e9", from: .init(node: "mq"), to: .init(node: "out"), kind: .flow),
        ]
        var v2 = buildGraphV3()
        if let i = v2.nodes.firstIndex(where: { $0.id == "build" }) { v2.nodes[i].config["concurrency"] = 4 }

        let base = { (version: Int, graph: WorkflowGraph, status: Workflow.Status, author: Authorship, rationale: String?, parent: Int?, age: Double) in
            Workflow(id: buildWorkflowId, projectId: primaryProjectId, name: "Build", purpose: .build, version: version, graph: graph,
                     status: status, authoredBy: author, rationale: rationale, parentVersion: parent, createdAt: now.addingTimeInterval(-age))
        }
        return [
            base(1, v1, .draft, Authorship(kind: .agent, assignmentId: "asg_arch1", prompt: "Build features from the roadmap. Review every PR and run CI on our own Linux box before merging."),
                 "Started from the build template. One reviewer is enough for the first week; CI runs on build-linux-01 because it is the only machine labelled ci.", nil, 86400 * 8),
            base(2, v2, .draft, Authorship(kind: .user),
                 nil, 1, 86400 * 6),
            base(3, buildGraphV3(), .active, Authorship(kind: .agent, assignmentId: "asg_arch2", prompt: "Failed reviews should go back to the builder, at most three times, instead of ending the item."),
                 "Added a review loop limited to 3 iterations so review and CI failures return work to the builder. Builder concurrency is back to 6 because both machines have capacity for it.", 2, 86400 * 3),
            base(4, buildGraphV4(), .draft, Authorship(kind: .agent, assignmentId: "asg_rv118", prompt: "Proposed by Reviewer during run_7kq2m: review is saturated."),
                 "Review has been at full utilization for 3 hours with the queue growing from 3 to 7 items, while builders sit at 67%. Raising review concurrency to 2 and routing UI changes to a separate reviewer should cut review wait roughly in half. CI and the merge queue are unchanged.", 3, 1800),
        ]
    }

    static func improveWorkflow(now: Date) -> Workflow {
        Workflow(
            id: improveWorkflowId, projectId: primaryProjectId, name: "Improve", purpose: .improve, version: 1,
            graph: WorkflowGraph(
                nodes: [
                    GraphNode(id: "in", type: .input, label: "Goals", position: column(0), config: ["source": "goals"]),
                    GraphNode(id: "audit", type: .planner, label: "Auditor", position: column(1), config: ["harness": harness("claudeAgent", "claude-opus-5-5"), "prompt": "Find the highest-value improvement against current goals.", "maxItems": 3]),
                    GraphNode(id: "fix", type: .agent, label: "Improver", position: column(2), config: ["harness": harness("codex", "gpt-5-codex"), "concurrency": 2]),
                    GraphNode(id: "review", type: .review, label: "Reviewer", position: column(3), config: ["harness": harness("claudeAgent", "claude-opus-5-5"), "concurrency": 1]),
                    GraphNode(id: "ci", type: .ci, label: "CI", position: column(0, row: 1), config: ["steps": [["name": "Test", "run": "npm test"]]]),
                    GraphNode(id: "mq", type: .mergeQueue, label: "Merge queue", position: column(1, row: 1), config: ["strategy": "serial", "method": "squash"]),
                    GraphNode(id: "out", type: .output, label: "Merged", position: column(2, row: 1)),
                ],
                edges: [
                    GraphEdge(id: "e1", from: .init(node: "in"), to: .init(node: "audit"), kind: .flow),
                    GraphEdge(id: "e2", from: .init(node: "audit"), to: .init(node: "fix"), kind: .flow),
                    GraphEdge(id: "e3", from: .init(node: "fix"), to: .init(node: "review"), kind: .flow),
                    GraphEdge(id: "e4", from: .init(node: "review", port: "pass"), to: .init(node: "ci"), kind: .flow),
                    GraphEdge(id: "e5", from: .init(node: "review", port: "fail"), to: .init(node: "out"), kind: .flow),
                    GraphEdge(id: "e6", from: .init(node: "ci", port: "pass"), to: .init(node: "mq"), kind: .flow),
                    GraphEdge(id: "e7", from: .init(node: "mq"), to: .init(node: "out"), kind: .flow),
                    GraphEdge(id: "d1", from: .init(node: "audit", port: "role"), to: .init(node: "fix", port: "role"), kind: .delegates),
                ]),
            status: .paused, authoredBy: Authorship(kind: .agent, assignmentId: "asg_arch3", prompt: "Once a week, pick one improvement from the goals and ship it."),
            rationale: "A small weekly loop: one auditor proposes up to three items, two improvers build them.", parentVersion: nil,
            createdAt: now.addingTimeInterval(-86400 * 2))
    }

    // MARK: The live run

    struct ItemSeed {
        var id: String
        var title: String
        var node: String
        var status: WorkItem.Status
        var iteration: Int
        var pr: Int?
    }

    static let itemSeeds: [ItemSeed] = [
        .init(id: "wi_01", title: "Renew assignment leases during long turns", node: "out", status: .done, iteration: 1, pr: 212),
        .init(id: "wi_02", title: "Reject results from stale leases with 409 lease_lost", node: "out", status: .done, iteration: 2, pr: 214),
        .init(id: "wi_04", title: "Stream hub events over SSE", node: "out", status: .done, iteration: 1, pr: 215),
        .init(id: "wi_05", title: "Idempotency keys on run controls", node: "out", status: .done, iteration: 1, pr: 217),
        .init(id: "wi_06", title: "Usage ledger daily rollup", node: "out", status: .done, iteration: 2, pr: 218),
        .init(id: "wi_08", title: "Machine drain stops new leases", node: "out", status: .done, iteration: 1, pr: 220),
        .init(id: "wi_09", title: "Heartbeat marks machine offline after three misses", node: "out", status: .done, iteration: 1, pr: 221),
        .init(id: "wi_10", title: "Fake executor for node tests", node: "out", status: .done, iteration: 1, pr: 222),
        .init(id: "wi_11", title: "Overview counts endpoint", node: "out", status: .done, iteration: 3, pr: 224),
        .init(id: "wi_07", title: "CI job runs in a fresh worktree per revision", node: "ci", status: .active, iteration: 1, pr: 226),
        .init(id: "wi_12", title: "Merge queue serial strategy", node: "mq", status: .queued, iteration: 2, pr: 227),
        .init(id: "wi_13", title: "Enrollment codes expire after 15 minutes", node: "mq", status: .queued, iteration: 1, pr: 228),
        .init(id: "wi_14", title: "Cool down accounts on rate limit", node: "review", status: .active, iteration: 3, pr: 229),
        .init(id: "wi_15", title: "Workflow validate endpoint", node: "review", status: .queued, iteration: 1, pr: 230),
        .init(id: "wi_16", title: "Loop fails item at maxIterations", node: "review", status: .queued, iteration: 3, pr: 231),
        .init(id: "wi_17", title: "Delegation policy enforcement in @perpeto/t3-executor", node: "review", status: .queued, iteration: 2, pr: 232),
        .init(id: "wi_18", title: "Per-account usage attribution", node: "review", status: .queued, iteration: 1, pr: 233),
        .init(id: "wi_19", title: "Pause and resume run state machine", node: "review", status: .queued, iteration: 3, pr: 234),
        .init(id: "wi_20", title: "Revision-bound CI evidence", node: "review", status: .queued, iteration: 1, pr: 235),
        .init(id: "wi_21", title: "Workflow version diff endpoint", node: "review", status: .queued, iteration: 2, pr: 236),
        .init(id: "wi_22", title: "Node executor registry", node: "build", status: .active, iteration: 1, pr: nil),
        .init(id: "wi_23", title: "Interaction events with unplanned flag", node: "build", status: .active, iteration: 3, pr: nil),
        .init(id: "wi_24", title: "Project metrics endpoint", node: "build", status: .active, iteration: 1, pr: nil),
        .init(id: "wi_25", title: "Bottleneck rules from measured state", node: "build", status: .active, iteration: 2, pr: nil),
        .init(id: "wi_03", title: "Account pool hot swap on cooldown", node: "loop", status: .failed, iteration: 3, pr: 216),
    ]

    static func sha(_ seed: String) -> String {
        var hash: UInt64 = 1469598103934665603
        for byte in seed.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        let a = String(hash, radix: 16)
        let b = String(hash &* 6364136223846793005 &+ 1442695040888963407, radix: 16)
        return String((a + b + a).prefix(40)).padding(toLength: 40, withPad: "0", startingAt: 0)
    }

    static func workItems() -> [WorkItem] {
        itemSeeds.map { seed in
            let slug = seed.title.lowercased().split { !$0.isLetter && !$0.isNumber }.prefix(4).joined(separator: "-")
            return WorkItem(
                id: seed.id, runId: liveRunId, title: seed.title,
                body: "Acceptance: covered by node --test at the head commit; names match docs/architecture/README.md.",
                nodeId: seed.node, status: seed.status, branch: "factory/\(slug)",
                prUrl: seed.pr.map { "https://github.com/jstEagle/Perpeto/pull/\($0)" },
                headSha: seed.pr == nil ? nil : sha(seed.id), iteration: seed.iteration)
        }
    }

    static let builderPolicy = AgentPolicy(maxSubagents: 2, allowedSubagentProviders: ["codex"], maxTurns: 40, canMessage: ["review"])
    static let reviewPolicy = AgentPolicy(maxSubagents: 0, allowedSubagentProviders: [], canMessage: ["build", "plan"])

    static func assignments(now: Date) -> [Assignment] {
        var result: [Assignment] = []
        let builderMachines = [studioId, studioId, studioId, linuxId]
        for (index, id) in ["wi_22", "wi_23", "wi_24", "wi_25"].enumerated() {
            result.append(Assignment(
                id: "asg_b\(index + 1)", runId: liveRunId, workItemId: id, nodeId: "build", role: "builder-\(index + 1)",
                prompt: "Implement the work item on its own branch and open a PR.", harness: Harness(provider: "codex", model: "gpt-5-codex"),
                policy: builderPolicy, requirements: .init(providers: ["codex"]), status: .running, machineId: builderMachines[index],
                leaseExpiresAt: now.addingTimeInterval(41), attempt: 1))
        }
        result.append(Assignment(
            id: "asg_rv118", runId: liveRunId, workItemId: "wi_14", nodeId: "review", role: "reviewer",
            prompt: "Review the PR against the item's acceptance checks.", harness: Harness(provider: "claudeAgent", model: "claude-opus-5-5"),
            policy: reviewPolicy, requirements: .init(providers: ["claudeAgent"]), status: .running, machineId: studioId,
            leaseExpiresAt: now.addingTimeInterval(52), attempt: 1))
        for id in ["wi_15", "wi_16", "wi_17", "wi_18", "wi_19", "wi_20", "wi_21"] {
            result.append(Assignment(
                id: "asg_q\(id.suffix(2))", runId: liveRunId, workItemId: id, nodeId: "review", role: "reviewer",
                prompt: "Review the PR against the item's acceptance checks.", harness: Harness(provider: "claudeAgent", model: "claude-opus-5-5"),
                policy: reviewPolicy, requirements: .init(providers: ["claudeAgent"]), status: .queued, attempt: 1))
        }
        result.append(Assignment(
            id: "asg_f03", runId: liveRunId, workItemId: "wi_03", nodeId: "build", role: "builder-2",
            prompt: "Implement the work item on its own branch and open a PR.", harness: Harness(provider: "codex", model: "gpt-5-codex"),
            policy: builderPolicy, requirements: .init(providers: ["codex"]), status: .failed, machineId: linuxId, attempt: 3,
            result: AssignmentResult(outcome: .failure, summary: "Review failed three times: swap races with an in-flight turn. Item failed at maxIterations 3.", branch: "factory/account-pool-hot-swap", prUrl: "https://github.com/jstEagle/Perpeto/pull/216")))
        return result
    }

    static func liveMetrics() -> MetricsSnapshot {
        let p = Percentiles.init(avg:p90:)
        return MetricsSnapshot(
            window: .day,
            nodes: [
                NodeMetrics(nodeId: "in", queued: 0, active: 0, done: 25, failed: 0, concurrency: 1, utilization: 0, waitSec: p(0, 0), serviceSec: p(0, 0), throughputPerHour: 0, failureRate: 0, tokens: 0),
                NodeMetrics(nodeId: "plan", queued: 0, active: 0, done: 25, failed: 0, concurrency: 1, utilization: 0, waitSec: p(20, 45), serviceSec: p(310, 540), throughputPerHour: 0.4, failureRate: 0, tokens: 612_000),
                NodeMetrics(nodeId: "loop", queued: 0, active: 0, done: 41, failed: 1, concurrency: 1, utilization: 0, waitSec: p(0, 0), serviceSec: p(0, 0), throughputPerHour: 2.1, failureRate: 0.04, tokens: 0),
                NodeMetrics(nodeId: "build", queued: 0, active: 4, done: 37, failed: 1, concurrency: 6, utilization: 0.67, waitSec: p(140, 380), serviceSec: p(1980, 3400), throughputPerHour: 2.3, failureRate: 0.03, tokens: 9_840_000),
                NodeMetrics(nodeId: "review", queued: 7, active: 1, done: 30, failed: 13, concurrency: 1, utilization: 1.0, waitSec: p(2280, 4260), serviceSec: p(1340, 2100), throughputPerHour: 1.4, failureRate: 0.43, tokens: 3_120_000),
                NodeMetrics(nodeId: "ci", queued: 0, active: 1, done: 16, failed: 3, concurrency: 2, utilization: 0.5, waitSec: p(35, 90), serviceSec: p(610, 840), throughputPerHour: 1.2, failureRate: 0.16, tokens: 0),
                NodeMetrics(nodeId: "mq", queued: 2, active: 0, done: 9, failed: 0, concurrency: 1, utilization: 0, waitSec: p(420, 900), serviceSec: p(95, 160), throughputPerHour: 0.9, failureRate: 0, tokens: 0),
                NodeMetrics(nodeId: "out", queued: 0, active: 0, done: 9, failed: 0, concurrency: 1, utilization: 0, waitSec: p(0, 0), serviceSec: p(0, 0), throughputPerHour: 0.9, failureRate: 0, tokens: 0),
            ],
            edges: [
                EdgeMetrics(edgeId: "e1", kind: .flow, count: 3, unplanned: false),
                EdgeMetrics(edgeId: "e2", kind: .flow, count: 25, unplanned: false),
                EdgeMetrics(edgeId: "e3", kind: .flow, count: 41, unplanned: false),
                EdgeMetrics(edgeId: "e4", kind: .flow, count: 37, unplanned: false),
                EdgeMetrics(edgeId: "e5", kind: .flow, count: 17, unplanned: false),
                EdgeMetrics(edgeId: "e6", kind: .flow, count: 13, unplanned: false),
                EdgeMetrics(edgeId: "e7", kind: .flow, count: 13, unplanned: false),
                EdgeMetrics(edgeId: "e8", kind: .flow, count: 3, unplanned: false),
                EdgeMetrics(edgeId: "e9", kind: .flow, count: 9, unplanned: false),
                EdgeMetrics(edgeId: "d1", kind: .delegates, count: 25, unplanned: false),
                EdgeMetrics(edgeId: "m1", kind: .messages, count: 46, unplanned: false),
                EdgeMetrics(edgeId: "m2", kind: .messages, count: 5, unplanned: false),
                .unplanned(.messages, from: "build", to: "plan", count: 4),
            ],
            run: RunMetrics(
                // 24 hourly buckets, as the hub returns for the 24h window.
                velocity: .init(itemsDonePerDay: 5.5, trend: [1, 0, 2, 1, 0, 3, 1, 0, 2, 4, 1, 0, 2, 3, 0, 1, 2, 0, 3, 1, 2, 0, 1, 2]),
                cycleTimeSec: p(15_100, 26_400), wip: 15, tokensPerItem: 1_508_000, activeAgents: 5,
                machines: [
                    .init(machineId: studioId, activeAgents: 4, nodes: ["build", "review"]),
                    .init(machineId: linuxId, activeAgents: 1, nodes: ["build", "ci"]),
                ]),
            bottlenecks: [
                Bottleneck(nodeId: "review", reason: .saturated, evidence: "Utilization 1.00 at concurrency 1. Queue grew from 3 to 7 in 3 h. Wait p90 71 min against a 30 min goal.", severity: .critical),
                Bottleneck(nodeId: "loop", reason: .reworkLoop, evidence: "1.6 iterations per item against 1.2 last week. 4 items are on iteration 3 of 3; 1 failed at the limit.", severity: .warning),
            ])
    }

    /// The fixtures describe 24 hours. Other windows scale counts so the
    /// window picker visibly changes the map in demo mode.
    public static func scaled(_ snapshot: MetricsSnapshot, to window: MetricsWindow) -> MetricsSnapshot {
        guard window != .day else { return snapshot }
        let factor = window == .hour ? 1.0 / 12 : 5.0
        var s = snapshot
        s.window = window
        s.edges = s.edges.map { var e = $0; e.count = max(e.count > 0 ? 1 : 0, Int((Double(e.count) * factor).rounded())); return e }
        s.nodes = s.nodes.map { var n = $0; n.done = Int((Double(n.done) * factor).rounded()); n.failed = Int((Double(n.failed) * factor).rounded()); return n }
        // 12 five-minute buckets for 1h, 7 daily buckets for 7d.
        s.run.velocity.trend = window == .hour ? [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] : [2, 4, 6, 7, 5, 4, 3]
        return s
    }

    static func events(now: Date) -> [HubEvent] {
        struct Seed {
            var minutesAgo: Double
            var type: String
            var subjectKind: String
            var subjectId: String
            var data: JSONValue
        }
        let seeds: [Seed] = [
            .init(minutesAgo: 1, type: "agent.messaged", subjectKind: "assignment", subjectId: "asg_b2", data: ["sourceNodeId": "build", "targetNodeId": "review", "edgeId": "m1", "senderRoleId": "builder-2", "recipientRoleId": "reviewer", "summary": "Pushed a fix for the cooldown race; ready for another look."]),
            .init(minutesAgo: 3, type: "assignment.state", subjectKind: "assignment", subjectId: "asg_b4", data: ["nodeId": "build", "state": "running", "machineId": .string(studioId), "accountId": "acct_x1", "summary": "builder-4 started on studio-m4"]),
            .init(minutesAgo: 4, type: "agent.messaged", subjectKind: "assignment", subjectId: "asg_b3", data: ["sourceNodeId": "build", "targetNodeId": "plan", "senderRoleId": "builder-3", "recipientRoleId": "planner", "unplanned": true, "summary": "Asked the planner to split the metrics item; no messages edge connects these roles."]),
            .init(minutesAgo: 6, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_21", data: ["sourceNodeId": "build", "targetNodeId": "review", "edgeId": "e4", "summary": "Workflow version diff endpoint entered the review queue (position 7)."]),
            .init(minutesAgo: 9, type: "gate.result", subjectKind: "workItem", subjectId: "wi_07", data: ["nodeId": "review", "result": "pass", "edgeId": "e5", "summary": "Review passed CI job runs in a fresh worktree per revision."]),
            .init(minutesAgo: 9.5, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_07", data: ["sourceNodeId": "review", "targetNodeId": "ci", "edgeId": "e5", "summary": "Moved to CI at 8e41c0d."]),
            .init(minutesAgo: 12, type: "assignment.state", subjectKind: "job", subjectId: "job_91c", data: ["nodeId": "ci", "state": "running", "machineId": .string(linuxId), "summary": "CI job started on build-linux-01 at 8e41c0d."]),
            .init(minutesAgo: 16, type: "gate.result", subjectKind: "workItem", subjectId: "wi_23", data: ["nodeId": "review", "result": "fail", "edgeId": "e6", "summary": "Review failed: unplanned flag not persisted across restart. Iteration 3 of 3."]),
            .init(minutesAgo: 16.5, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_23", data: ["sourceNodeId": "review", "targetNodeId": "loop", "edgeId": "e6", "summary": "Returned to the loop for iteration 3."]),
            .init(minutesAgo: 18, type: "agent.delegated", subjectKind: "assignment", subjectId: "asg_b4", data: ["sourceNodeId": "plan", "targetNodeId": "build", "edgeId": "d1", "role": "planner", "summary": "Planner assigned Bottleneck rules from measured state."]),
            .init(minutesAgo: 22, type: "agent.messaged", subjectKind: "assignment", subjectId: "asg_rv118", data: ["sourceNodeId": "review", "targetNodeId": "build", "edgeId": "m1", "senderRoleId": "reviewer", "recipientRoleId": "builder-1", "summary": "Requested a test for cooldown expiry before approving."]),
            .init(minutesAgo: 27, type: "gate.result", subjectKind: "workItem", subjectId: "wi_03", data: ["nodeId": "ci", "result": "fail", "edgeId": "e8", "summary": "CI failed at 3f2a9c1: npm test exited 1."]),
            .init(minutesAgo: 27.5, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_03", data: ["sourceNodeId": "loop", "targetNodeId": "loop", "summary": "Account pool hot swap failed at maxIterations 3."]),
            .init(minutesAgo: 31, type: "agent.messaged", subjectKind: "assignment", subjectId: "asg_b3", data: ["sourceNodeId": "build", "targetNodeId": "plan", "senderRoleId": "builder-3", "recipientRoleId": "planner", "unplanned": true, "summary": "Reported the metrics item is larger than one PR."]),
            .init(minutesAgo: 34, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_13", data: ["sourceNodeId": "ci", "targetNodeId": "mq", "edgeId": "e7", "summary": "Enrollment codes expire after 15 minutes queued for merge."]),
            .init(minutesAgo: 40, type: "assignment.state", subjectKind: "assignment", subjectId: "asg_rv118", data: ["nodeId": "review", "state": "running", "machineId": .string(studioId), "accountId": "acct_c1", "summary": "Reviewer switched to Claude Max 1 after Claude Max 2 hit a rate limit."]),
            .init(minutesAgo: 52, type: "workitem.moved", subjectKind: "workItem", subjectId: "wi_11", data: ["sourceNodeId": "mq", "targetNodeId": "out", "edgeId": "e9", "summary": "Overview counts endpoint merged to main as PR #224."]),
            .init(minutesAgo: 58, type: "agent.messaged", subjectKind: "assignment", subjectId: "asg_rv118", data: ["sourceNodeId": "plan", "targetNodeId": "review", "edgeId": "m2", "senderRoleId": "planner", "recipientRoleId": "reviewer", "summary": "Flagged items 16 and 19 as contract-sensitive."]),
        ]
        return seeds.enumerated().map { index, seed in
            HubEvent(seq: 4800 - index, at: now.addingTimeInterval(-seed.minutesAgo * 60), type: seed.type, projectId: primaryProjectId,
                     runId: liveRunId, subject: .init(kind: seed.subjectKind, id: seed.subjectId), data: seed.data)
        }
    }

    static func perpeto(now: Date) -> ProjectState {
        let versions = buildVersions(now: now)
        let improve = improveWorkflow(now: now)
        let channelId = "run-\(liveRunId)"
        let messages: [Message] = [
            ("planner", nil, "Split the roadmap into 25 items. Contract-sensitive ones are tagged in their bodies.", 182.0),
            ("reviewer", "builder-1", "wi_11 passes. Please keep the overview keys exactly as the contract names them.", 95),
            ("builder-3", "planner", "The metrics endpoint item is two PRs. Can it be split?", 31),
            ("reviewer", nil, "Review queue is at 7. I've proposed a second review role as a draft; nothing changes until it's activated.", 29),
            ("builder-2", "reviewer", "Pushed a fix for the cooldown race; ready for another look.", 1),
        ].enumerated().map { index, row in
            Message(id: "msg_\(index)", projectId: primaryProjectId, channelId: channelId, senderRoleId: row.0, recipientRoleId: row.1, body: row.2, createdAt: now.addingTimeInterval(-row.3 * 60))
        }
        return ProjectState(
            workflows: [versions.last!, improve],
            versions: [buildWorkflowId: versions, improveWorkflowId: [improve]],
            runs: [
                Run(id: liveRunId, projectId: primaryProjectId, workflowId: buildWorkflowId, workflowVersion: 3, status: .running, startedAt: now.addingTimeInterval(-3600 * 26)),
                Run(id: "run_5hd8a", projectId: primaryProjectId, workflowId: buildWorkflowId, workflowVersion: 2, status: .stopped, startedAt: now.addingTimeInterval(-86400 * 5), stoppedAt: now.addingTimeInterval(-86400 * 3)),
                Run(id: "run_2bf1c", projectId: primaryProjectId, workflowId: improveWorkflowId, workflowVersion: 1, status: .completed, startedAt: now.addingTimeInterval(-86400 * 2), stoppedAt: now.addingTimeInterval(-86400 * 2 + 5400)),
            ],
            workItems: workItems(),
            assignments: assignments(now: now),
            mergeQueue: [
                MergeEntry(id: "mq_31", projectId: primaryProjectId, prUrl: "https://github.com/jstEagle/Perpeto/pull/224", headSha: sha("wi_11"), baseBranch: "main", status: .merged, jobId: "job_8fa"),
                MergeEntry(id: "mq_32", projectId: primaryProjectId, prUrl: "https://github.com/jstEagle/Perpeto/pull/216", headSha: sha("wi_03"), baseBranch: "main", status: .rejected, jobId: "job_90b", reason: "CI failed at 3f2a9c1: npm test exited 1."),
                MergeEntry(id: "mq_33", projectId: primaryProjectId, prUrl: "https://github.com/jstEagle/Perpeto/pull/227", headSha: sha("wi_12"), baseBranch: "main", status: .testing, jobId: "job_91c"),
                MergeEntry(id: "mq_34", projectId: primaryProjectId, prUrl: "https://github.com/jstEagle/Perpeto/pull/228", headSha: sha("wi_13"), baseBranch: "main", status: .queued),
            ],
            channels: [Channel(id: channelId, name: "Run \(liveRunId)"), Channel(id: "general", name: "General")],
            messages: [channelId: messages, "general": [
                Message(id: "msg_g1", projectId: primaryProjectId, channelId: "general", senderRoleId: "owner", body: "Prioritise anything that blocks the two-machine end-to-end check.", createdAt: now.addingTimeInterval(-86400)),
            ]],
            usage: UsageBundle(records: usageRecords(projectId: primaryProjectId, now: now)),
            metrics: liveMetrics(),
            runMetrics: [liveRunId: liveMetrics()],
            events: events(now: now))
    }

    static func ledger(now: Date) -> ProjectState {
        var workflow = improveWorkflow(now: now)
        workflow.id = "wf_ledger_improve"
        workflow.projectId = "prj_ledger"
        workflow.status = .active
        return ProjectState(
            workflows: [workflow], versions: [workflow.id: [workflow]],
            runs: [Run(id: "run_9ce0d", projectId: "prj_ledger", workflowId: workflow.id, workflowVersion: 1, status: .completed, startedAt: now.addingTimeInterval(-86400 * 4), stoppedAt: now.addingTimeInterval(-86400 * 4 + 7200))],
            workItems: [], assignments: [], mergeQueue: [], channels: [], messages: [:],
            usage: UsageBundle(records: usageRecords(projectId: "prj_ledger", now: now)), metrics: nil, runMetrics: [:], events: [])
    }

    // MARK: Usage

    /// Fourteen days of records with a deterministic pseudo-random spread.
    public static func usageRecords(projectId: String, now: Date) -> [UsageRecord] {
        let scale: Double = switch projectId {
        case primaryProjectId: 1.0
        case "prj_ledger": 0.18
        default: 0.03
        }
        var state: UInt64 = UInt64(abs(projectId.hashValueStable)) | 1
        func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 33) / Double(1 << 31)
        }
        let calendar = Calendar.utc
        let today = calendar.startOfDay(for: now)
        let combos: [(String, String, String)] = [
            ("codex", "gpt-5-codex", studioId), ("codex", "gpt-5-codex", linuxId),
            ("claudeAgent", "claude-opus-5-5", studioId), ("claudeAgent", "claude-sonnet-5-5", linuxId),
        ]
        var records: [UsageRecord] = []
        for day in 0..<14 {
            let date = today.addingTimeInterval(Double(-13 + day) * 86400 + 3600 * 9)
            // Ramp up over the run, with a weekend dip.
            let ramp = 0.35 + 0.65 * Double(day) / 13
            let weekday = calendar.component(.weekday, from: date)
            let dip = (weekday == 1 || weekday == 7) ? 0.45 : 1.0
            for (index, combo) in combos.enumerated() {
                let weight = [0.34, 0.16, 0.36, 0.14][index]
                let base = 9_000_000 * scale * ramp * dip * weight * (0.8 + 0.4 * next())
                records.append(UsageRecord(
                    id: "use_\(projectId)_\(day)_\(index)", projectId: projectId, machineId: combo.2, provider: combo.0, model: combo.1,
                    inputTokens: Int(base * 0.28), outputTokens: Int(base * 0.09), cacheReadTokens: Int(base * 0.55), cacheWriteTokens: Int(base * 0.08),
                    at: date.addingTimeInterval(Double(index) * 1800)))
            }
        }
        return records
    }
}

extension String {
    /// Stable across launches, unlike `hashValue`.
    var hashValueStable: Int {
        var hash: UInt64 = 5381
        for byte in utf8 { hash = (hash &* 33) ^ UInt64(byte) }
        return Int(truncatingIfNeeded: hash >> 1)
    }
}
