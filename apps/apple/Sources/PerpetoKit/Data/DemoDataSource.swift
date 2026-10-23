import Foundation

/// In-memory factory built from `DemoFixtures`. Mutations apply locally and
/// are lost on quit; nothing leaves the device.
public actor DemoDataSource: FactoryDataSource {
    private var factory: FactoryState
    private var projects: [String: ProjectState] = [:]
    private let now: @Sendable () -> Date
    /// Delay between architect stages; zero in tests.
    private let stageDelay: Duration

    public let scenario: DemoScenario

    public init(scenario: DemoScenario = .current, now: @escaping @Sendable () -> Date = Date.init, stageDelay: Duration = .milliseconds(900)) {
        self.now = now
        self.stageDelay = stageDelay
        self.scenario = scenario
        let start = now()
        self.createdAt = start
        self.mergeQueueDemo = DemoMergeQueues(now: start)
        switch scenario {
        case .full:
            var factory = DemoFixtures.factory(now: start)
            factory.sessions = DemoObserve.observed(now: start, machines: factory.machines)
            self.factory = factory
        case .observe:
            self.factory = DemoObserve.factory(now: start)
        }
    }

    private let createdAt: Date

    public nonisolated var isDemo: Bool { true }

    public func loadFactory() async throws -> FactoryState { factory }

    public func loadProject(_ projectId: String, window: MetricsWindow = .day) async throws -> ProjectState {
        var state = try project(projectId)
        for runId in state.runMetrics.keys {
            state.runMetrics[runId] = state.runMetrics[runId].map { DemoFixtures.scaled($0, to: window) }
        }
        return state
    }

    public func loadRun(_ runId: String, window: MetricsWindow) async throws -> RunSnapshot {
        guard let state = projects.values.first(where: { $0.runs.contains { $0.id == runId } }),
              let run = state.runs.first(where: { $0.id == runId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "run not found.")
        }
        return RunSnapshot(
            run: run, workItems: state.workItems.filter { $0.runId == runId }, assignments: state.assignments.filter { $0.runId == runId },
            metrics: state.runMetrics[runId].map { DemoFixtures.scaled($0, to: window) })
    }

    private func project(_ projectId: String) throws -> ProjectState {
        if let state = projects[projectId] { return state }
        let state = DemoFixtures.project(projectId, now: now())
        projects[projectId] = state
        return state
    }

    public nonisolated func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) -> AsyncThrowingStream<DraftProgress, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let assignmentId = "asg_arch\(Int.random(in: 100...999))"
                    for stage in [DraftProgress.Stage.queued, .reading, .drafting, .validating] {
                        continuation.yield(DraftProgress(assignmentId: assignmentId, stage: stage))
                        try await Task.sleep(for: stageDelay)
                    }
                    let draft = try await self.makeDraft(projectId: projectId, prompt: prompt, baseWorkflowId: baseWorkflowId, assignmentId: assignmentId)
                    var progress = DraftProgress(assignmentId: assignmentId, stage: .ready, draft: draft)
                    if baseWorkflowId == nil {
                        progress.alsoSuggested = [try await self.suggestDocs(projectId: projectId, prompt: prompt, assignmentId: assignmentId)]
                    }
                    continuation.yield(progress)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Produces a plausible draft. The demo cannot run an architect, so it
    /// applies a fixed change: a human approval gate before the merge queue,
    /// or the build template when the project has no workflow yet.
    private func makeDraft(projectId: String, prompt: String, baseWorkflowId: String?, assignmentId: String) async throws -> Workflow {
        var state = try project(projectId)
        let base = baseWorkflowId.flatMap { state.activeVersion(of: $0) ?? state.versions[$0]?.last }
        var graph: WorkflowGraph
        var rationale: String
        let workflowId = base?.id ?? "wf_\(UUID().uuidString.prefix(6).lowercased())"
        if let base {
            graph = base.graph
            graph.nodes.removeAll { $0.id == "approve" }
            graph.edges.removeAll { $0.from.node == "approve" || $0.to.node == "approve" }
            let ciPass = graph.edges.firstIndex { $0.from.node == "ci" && $0.from.port == "pass" }
            if let ciPass, let mq = graph.node("mq") {
                graph.edges[ciPass].to = .init(node: "approve")
                for index in graph.nodes.indices where graph.nodes[index].position.y == mq.position.y && graph.nodes[index].position.x >= mq.position.x {
                    graph.nodes[index].position.x += 208
                }
                graph.nodes.append(GraphNode(id: "approve", type: .human, label: "Release approval", position: .init(x: mq.position.x, y: mq.position.y),
                                             config: ["prompt": "Approve merging this change to main."]))
                graph.edges += [
                    GraphEdge(id: "h1", from: .init(node: "approve", port: "pass"), to: .init(node: "mq"), kind: .flow),
                    GraphEdge(id: "h2", from: .init(node: "approve", port: "fail"), to: .init(node: "loop"), kind: .flow),
                ]
            }
            rationale = "Added a human approval gate between CI and the merge queue, as the prompt asks for a person to sign off before merging. Rejected changes return to the review loop, so they keep their iteration count."
        } else {
            graph = DemoFixtures.buildGraphV3()
            rationale = "Used the build template: a planner splits goals into items, builders work in a review loop limited to 3 iterations, then CI and a serial merge queue. The project has two online machines, so builder concurrency is 4."
            if let i = graph.nodes.firstIndex(where: { $0.id == "build" }) { graph.nodes[i].config["concurrency"] = 4 }
        }
        let versions = state.versions[workflowId] ?? []
        let draft = Workflow(
            id: workflowId, projectId: projectId, name: base?.name ?? "Build", purpose: base?.purpose ?? .build,
            version: (versions.map(\.version).max() ?? 0) + 1, graph: graph, status: .draft,
            authoredBy: Authorship(kind: .agent, assignmentId: assignmentId, prompt: prompt), rationale: rationale,
            parentVersion: base?.version, createdAt: now())
        state.versions[workflowId, default: []].append(draft)
        if !state.workflows.contains(where: { $0.id == workflowId }) { state.workflows.append(draft) }
        projects[projectId] = state
        return draft
    }

    /// The architect may propose up to three more workflows; the demo proposes one.
    private func suggestDocs(projectId: String, prompt: String, assignmentId: String) throws -> Workflow {
        var state = try project(projectId)
        let template = DemoFixtures.templates(now: now()).first { $0.id == "docs" }!
        let workflow = Workflow(
            id: "wf_docs_\(UUID().uuidString.prefix(4).lowercased())", projectId: projectId, name: "Docs", purpose: .docs, version: 1,
            graph: template.graph!, status: .draft, authoredBy: Authorship(kind: .agent, assignmentId: assignmentId, prompt: prompt),
            rationale: "The project's goals are mostly guides. A separate docs workflow reviews accuracy and links without waiting behind feature work.",
            createdAt: now())
        state.workflows.append(workflow)
        state.versions[workflow.id] = [workflow]
        projects[projectId] = state
        return workflow
    }

    public func activate(workflowId: String, version: Int) async throws -> Workflow {
        guard let projectId = projects.first(where: { $0.value.versions[workflowId] != nil })?.key,
              var state = projects[projectId],
              var versions = state.versions[workflowId],
              let index = versions.firstIndex(where: { $0.version == version }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That workflow version no longer exists.")
        }
        for i in versions.indices where versions[i].status == .active { versions[i].status = .draft }
        versions[index].status = .active
        state.versions[workflowId] = versions
        if let w = state.workflows.firstIndex(where: { $0.id == workflowId }) { state.workflows[w] = versions[index] }
        projects[projectId] = state
        return versions[index]
    }

    public func save(_ workflow: Workflow) async throws -> Workflow {
        var state = try project(workflow.projectId)
        let result = WorkflowValidator.validate(workflow.graph)
        guard result.valid else {
            throw HubError.http(status: 422, code: "INVALID_GRAPH", message: "The graph has \(result.errorCount) validation errors. Fix them before saving.")
        }
        var saved = workflow
        saved.version = (state.versions[workflow.id]?.map(\.version).max() ?? 0) + 1
        saved.status = .draft
        saved.authoredBy = Authorship(kind: .user)
        saved.rationale = nil
        saved.parentVersion = workflow.version
        saved.createdAt = now()
        state.versions[workflow.id, default: []].append(saved)
        projects[workflow.projectId] = state
        return saved
    }

    public func validate(_ workflow: Workflow) async throws -> ValidationResult { WorkflowValidator.validate(workflow.graph) }

    public func control(runId: String, _ action: HubClient.RunControl) async throws -> Run {
        guard let projectId = projects.first(where: { $0.value.runs.contains { $0.id == runId } })?.key,
              var state = projects[projectId],
              let index = state.runs.firstIndex(where: { $0.id == runId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That run no longer exists.")
        }
        switch action {
        case .pause: state.runs[index].status = .paused
        case .resume: state.runs[index].status = .running
        case .stop:
            state.runs[index].status = .stopped
            state.runs[index].stoppedAt = now()
        }
        projects[projectId] = state
        return state.runs[index]
    }

    public func startRun(workflowId: String, settings: RunSettings) async throws -> Run {
        guard let projectId = projects.first(where: { $0.value.versions[workflowId] != nil })?.key,
              var state = projects[projectId],
              let active = state.activeVersion(of: workflowId) else {
            throw HubError.http(status: 409, code: "NOT_ACTIVE", message: "Activate a version of this workflow before starting a run.")
        }
        let run = Run(id: "run_\(UUID().uuidString.prefix(5).lowercased())", projectId: projectId, workflowId: workflowId, workflowVersion: active.version, status: .running,
                      startedAt: now(), settings: settings, intake: settings.budget == nil ? nil : RunIntake(paused: false),
                      budgetUsage: settings.budget == nil ? nil : BudgetUsage(day: DemoFixtures.utcDay(now()), tokens: 0, items: 0))
        state.runs.insert(run, at: 0)
        projects[projectId] = state
        return run
    }

    public func updateRun(runId: String, settings: RunSettings) async throws -> Run {
        guard let projectId = projects.first(where: { $0.value.runs.contains { $0.id == runId } })?.key,
              var state = projects[projectId], let index = state.runs.firstIndex(where: { $0.id == runId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That run no longer exists.")
        }
        var run = state.runs[index]
        guard run.status == .running || run.status == .paused else {
            throw HubError.http(status: 409, code: "RUN_NOT_ACTIVE", message: "Only running or paused runs can change settings.")
        }
        run.settings = settings
        // A raised limit releases a budget hold, as budget.available would.
        if let reason = run.intake?.reason, let usage = run.budgetUsage {
            let budget = settings.budget ?? RunBudget()
            let still: Bool = switch reason.limit {
            case .maxTokensPerDay: budget.maxTokensPerDay.map { usage.tokens >= $0 } ?? false
            case .maxItemsPerDay: budget.maxItemsPerDay.map { usage.items >= $0 } ?? false
            case .maxActiveItems: budget.maxActiveItems.map { reason.used >= $0 } ?? false
            case .unknown: false
            }
            if !still { run.intake = RunIntake(paused: false) }
        }
        state.runs[index] = run
        projects[projectId] = state
        return run
    }

    public func templates() async throws -> [WorkflowTemplate] { DemoFixtures.templates(now: now()) }

    public func createWorkflow(projectId: String, from template: WorkflowTemplate) async throws -> Workflow {
        var state = try project(projectId)
        let workflow = Workflow(id: "wf_\(template.id.replacingOccurrences(of: "-", with: "_"))_\(UUID().uuidString.prefix(4).lowercased())", projectId: projectId,
                                name: template.name, purpose: template.purpose, version: 1, graph: template.graph ?? DemoFixtures.buildGraphV3(), status: .draft,
                                authoredBy: Authorship(kind: .user), rationale: template.description, createdAt: now())
        state.workflows.append(workflow)
        state.versions[workflow.id] = [workflow]
        projects[projectId] = state
        return workflow
    }

    public func decide(workItemId: String, _ decision: HubClient.Decision, decisionId: String?) async throws {
        guard let projectId = projects.first(where: { $0.value.workItems.contains { $0.id == workItemId } })?.key,
              var state = projects[projectId],
              let index = state.workItems.firstIndex(where: { $0.id == workItemId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That work item no longer exists.")
        }
        if let decisionId, let current = state.workItems[index].decisionId, decisionId != current {
            throw HubError.conflict(code: "STALE_DECISION", message: "This decision answers an earlier wait; the work item now waits for another decision.")
        }
        state.workItems[index].decisionId = nil
        state.workItems[index].status = decision == .pass ? .queued : .failed
        projects[projectId] = state
    }

    /// Marks an item as waiting for a person, for tests of stale decisions.
    func setDecisionId(_ decisionId: String, workItemId: String) throws {
        guard let projectId = projects.first(where: { $0.value.workItems.contains { $0.id == workItemId } })?.key,
              let index = projects[projectId]?.workItems.firstIndex(where: { $0.id == workItemId }) else { return }
        projects[projectId]?.workItems[index].decisionId = decisionId
        projects[projectId]?.workItems[index].status = .blocked
    }

    public func sendMessage(projectId: String, channelId: String, body: String, to recipient: MessageRecipient, parentId: String?) async throws -> Message {
        var state = try project(projectId)
        let parent = parentId.flatMap { id in state.messages[channelId]?.first { $0.id == id } }
        let recipientRole: String? = switch recipient {
        case .role(let role): role
        case .everyone: nil
        case .parentSender: parent.map { $0.senderRoleId == "owner" ? $0.recipientRoleId : $0.senderRoleId } ?? nil
        }
        let id = "msg_\(UUID().uuidString.prefix(8))"
        let message = Message(id: id, projectId: projectId, channelId: channelId, senderRoleId: "owner", recipientRoleId: recipientRole, body: body,
                              createdAt: now(), threadId: parent?.threadId ?? id, parentId: parentId, senderKind: .owner,
                              receipt: recipientRole == nil ? nil : Receipt(state: .stored))
        state.messages[channelId, default: []].append(message)
        projects[projectId] = state
        return message
    }

    public func ackMessage(projectId: String, channelId: String, messageId: String) async throws -> Message {
        var state = try project(projectId)
        guard let index = state.messages[channelId]?.firstIndex(where: { $0.id == messageId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That message no longer exists.")
        }
        var message = state.messages[channelId]![index]
        guard message.recipientRoleId == "owner" else {
            throw HubError.http(status: 403, code: "NOT_RECIPIENT", message: "Only messages addressed to you can be acknowledged.")
        }
        var receipt = message.receipt ?? Receipt(state: .stored)
        if receipt.state != .acked {
            if receipt.deliveredAt == nil { receipt.deliveredAt = now(); receipt.deliveredVia = .read }
            receipt.state = .acked
            receipt.ackedAt = now()
        }
        message.receipt = receipt
        state.messages[channelId]![index] = message
        projects[projectId] = state
        return message
    }

    public func markRead(projectId: String, channelId: String, messageId: String) async throws -> UnreadState {
        var state = try project(projectId)
        let messages = state.messages[channelId] ?? []
        let position = messages.firstIndex { $0.id == messageId } ?? (messages.count - 1)
        let remaining = messages.suffix(from: min(position + 1, messages.count)).filter { $0.senderRoleId != "owner" && ($0.recipientRoleId == nil || $0.recipientRoleId == "owner") }.count
        state.unread[channelId] = remaining
        projects[projectId] = state
        return UnreadState(roleId: "owner", unreadCount: remaining, lastReadMessageId: messageId)
    }

    public func enrollmentCode() async throws -> EnrollmentCode {
        EnrollmentCode(code: "DEMO-" + String(UUID().uuidString.prefix(4)), expiresAt: now().addingTimeInterval(900))
    }

    public func drain(machineId: String) async throws -> Machine {
        guard let index = factory.machines.firstIndex(where: { $0.id == machineId }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That machine is no longer enrolled.")
        }
        factory.machines[index].status = .draining
        return factory.machines[index]
    }

    private var pacingSettings = DemoPacing.defaultSettings
    private var mergeQueueDemo: DemoMergeQueues

    public func mergeQueues(projectId: String) async throws -> MergeQueueSettings? {
        guard projectId == DemoFixtures.primaryProjectId, scenario == .full else { return nil }
        return mergeQueueDemo.settings
    }
    public func saveMergeQueues(projectId: String, config: MergeQueueConfig, baseVersion: Int) async throws -> MergeQueueSettings {
        try mergeQueueDemo.save(config, baseVersion: baseVersion)
    }
    public func mergeQueueView(id: String, window: MetricsWindow) async throws -> MergeQueueView { try mergeQueueDemo.view(id) }
    public func setMergeQueueFrozen(id: String, frozen: Bool, reason: String?) async throws -> MergeQueueView {
        try mergeQueueDemo.setFrozen(id, frozen: frozen, reason: reason)
    }
    public func mergeEntryCommand(entryId: String, _ command: MergeEntryCommand) async throws -> MergeEntry {
        try mergeQueueDemo.command(entryId, command)
    }

    public func updateAccount(id: String, _ patch: AccountPatch) async throws -> Account {
        guard let index = factory.accounts.firstIndex(where: { $0.id == id }) else {
            throw HubError.http(status: 404, code: "NOT_FOUND", message: "That subscription is no longer reported.")
        }
        if let label = patch.label {
            guard !label.trimmingCharacters(in: .whitespaces).isEmpty else { throw HubError.http(status: 400, code: "INVALID_INPUT", message: "A subscription needs a label.") }
            factory.accounts[index].label = label
        }
        if let plan = patch.plan { factory.accounts[index].plan = plan.isEmpty ? nil : plan }
        refreshPacing()
        return factory.accounts[index]
    }

    public func updatePacing(_ settings: PacingSettings) async throws -> Pacing {
        if let target = settings.targetUsePercent, !(50...100).contains(target) {
            throw HubError.http(status: 400, code: "INVALID_INPUT", message: "Target use must be between 50% and 100%.")
        }
        pacingSettings = PacingSettings(
            enabled: settings.enabled ?? pacingSettings.enabled, strategy: settings.strategy ?? pacingSettings.strategy,
            targetUsePercent: settings.targetUsePercent ?? pacingSettings.targetUsePercent,
            minAgents: settings.minAgents ?? pacingSettings.minAgents, maxAgents: settings.removeMaxAgents ? nil : settings.maxAgents ?? pacingSettings.maxAgents)
        refreshPacing()
        return factory.pacing!
    }

    /// The demo plan keeps the fixture clock so it stays consistent with the accounts' reset times.
    private func refreshPacing() {
        guard scenario == .full else { return }
        let labels = Dictionary(factory.accounts.map { ($0.id, (label: $0.label, plan: $0.plan)) }, uniquingKeysWith: { a, _ in a })
        factory.pacing = DemoPacing.pacing(now: createdAt, settings: pacingSettings, labels: labels)
    }

    public nonisolated func events(after: Int?) -> AsyncThrowingStream<HubEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}
