import Foundation

/// Reads and writes factory state through Hub API v1.
public struct HubDataSource: FactoryDataSource {
    public let client: HubClient
    /// Role the owner sends messages as.
    public let ownerRoleId: String
    /// How many of the newest runs get work, assignments and metrics loaded.
    public let detailedRuns: Int
    /// Delay between architect status checks.
    public let pollInterval: Duration

    public init(client: HubClient, ownerRoleId: String = "owner", detailedRuns: Int = 8, pollInterval: Duration = .seconds(1)) {
        self.client = client
        self.ownerRoleId = ownerRoleId
        self.detailedRuns = detailedRuns
        self.pollInterval = pollInterval
    }

    public var isDemo: Bool { false }

    public func loadFactory() async throws -> FactoryState {
        async let projects = client.projects()
        async let machines = client.machines()
        async let accounts = client.accounts()
        async let jobs = client.jobs()
        async let overview = client.overview()
        async let usage = usageBundle(projectId: nil)
        // Hubs without pacing, or a failing pacing route, leave the rest of the factory readable.
        async let pacing = (try? client.pacing()) ?? nil
        async let sessions = loadSessions()
        // A pinned client follows a certificate rotation the hub announces; a no-op otherwise.
        async let rotation: Void = client.followCertificateRotation()
        _ = await rotation
        return try await FactoryState(projects: projects, machines: machines, accounts: accounts, jobs: jobs, overview: overview, usage: usage, pacing: pacing,
                                      sessions: sessions)
    }

    /// Observed T3 sessions and a summary per window. Nil when the hub has no
    /// sessions route; a failing call leaves the rest of the factory readable.
    func loadSessions() async -> ObservedSessions? {
        async let list = try? client.allSessions()
        async let hour = try? client.sessionSummary(window: .hour)
        async let day = try? client.sessionSummary(window: .day)
        async let week = try? client.sessionSummary(window: .week)
        let (sessions, h, d, w) = await (list, hour, day, week)
        var summaries: [SessionWindow: SessionSummary] = [:]
        summaries[.hour] = h ?? nil
        summaries[.day] = d ?? nil
        summaries[.week] = w ?? nil
        guard let found = sessions ?? nil else { return summaries.isEmpty ? nil : ObservedSessions(sessions: [], summaries: summaries) }
        return ObservedSessions(sessions: found, summaries: summaries)
    }

    public func loadProject(_ projectId: String, window: MetricsWindow) async throws -> ProjectState {
        async let workflowsCall = client.workflows(projectId: projectId)
        async let runsCall = client.runs(projectId: projectId)
        async let mergeQueue = client.mergeQueue(projectId: projectId)
        async let usage = usageBundle(projectId: projectId)
        async let channelsCall = (try? client.channels(projectId: projectId)) ?? []
        async let metrics = try? client.projectMetrics(projectId: projectId, window: window)
        async let eventsCall = try? client.recentEvents(count: 1000) { $0.projectId == projectId && !$0.isHousekeeping }

        let workflows = try await workflowsCall
        var versions: [String: [Workflow]] = [:]
        for workflow in workflows {
            versions[workflow.id] = Self.markActive((try? await client.versions(workflowId: workflow.id)) ?? [workflow], head: workflow)
        }

        let runs = try await runsCall
        var items: [WorkItem] = []
        var assignments: [Assignment] = []
        var runMetrics: [String: MetricsSnapshot] = [:]
        for run in runs.prefix(detailedRuns) {
            guard let snapshot = try? await loadRun(run, window: window) else { continue }
            items += snapshot.workItems
            assignments += snapshot.assignments
            runMetrics[run.id] = snapshot.metrics
        }

        let channels = await channelsCall
        var messages: [String: [Message]] = [:]
        var unread: [String: Int] = [:]
        for channel in channels {
            messages[channel.id] = (try? await client.messages(projectId: projectId, channelId: channel.id))?.messages ?? []
            unread[channel.id] = (try? await client.unread(projectId: projectId, channelId: channel.id, roleId: ownerRoleId, limit: 1))?.unreadCount
        }
        // Newest first, like the live feed.
        let events = (await eventsCall)?.events.reversed() ?? []

        var state = try await ProjectState(
            workflows: workflows, versions: versions, runs: runs, workItems: items,
            assignments: assignments, mergeQueue: mergeQueue, channels: channels, messages: messages, usage: usage,
            metrics: metrics, runMetrics: runMetrics, events: Array(events))
        state.unread = unread
        return state
    }

    public func loadRun(_ runId: String, window: MetricsWindow) async throws -> RunSnapshot {
        try await loadRun(try await client.run(runId), window: window)
    }

    private func loadRun(_ run: Run, window: MetricsWindow) async throws -> RunSnapshot {
        async let items = client.workItems(runId: run.id)
        async let assignments = client.assignments(runId: run.id)
        // 409 NO_RUN_STATE when the engine kept nothing for this run.
        async let metrics = try? client.runMetrics(runId: run.id, window: window)
        return try await RunSnapshot(run: run, workItems: items, assignments: assignments, metrics: metrics)
    }

    /// Version records are always stored as drafts; the head carries the
    /// `activeVersion` pointer. Mark that version active for display.
    static func markActive(_ versions: [Workflow], head: Workflow) -> [Workflow] {
        let active = head.status == .active ? (head.activeVersion ?? head.version) : head.activeVersion
        return versions.sorted { $0.version < $1.version }.map { version in
            var version = version
            if version.version == active { version.status = .active }
            return version
        }
    }

    private func usageBundle(projectId: String?) async throws -> UsageBundle {
        async let day = client.usage(projectId: projectId, groupBy: .day)
        async let provider = client.usage(projectId: projectId, groupBy: .provider)
        async let model = client.usage(projectId: projectId, groupBy: .model)
        // Older hubs reject role grouping.
        async let role = (try? client.usage(projectId: projectId, groupBy: .role)) ?? []
        async let machine = client.usage(projectId: projectId, groupBy: .machine)
        return try await UsageBundle(byDay: day.sorted { $0.key < $1.key }, byProvider: provider, byModel: model, byMachine: machine, byRole: role)
    }

    /// Requests a draft, then follows the architect assignment with
    /// `GET /assignments/:id`, including retries after invalid results, until
    /// the hub reports a saved draft or gives up.
    public func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) -> AsyncThrowingStream<DraftProgress, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var assignment = try await client.requestDraft(projectId: projectId, prompt: prompt, baseWorkflowId: baseWorkflowId)
                    var attempt = 1
                    var detail: String?
                    while !Task.isCancelled {
                        let stage: DraftProgress.Stage
                        switch assignment.status {
                        case .queued: stage = .queued
                        case .leased: stage = .reading
                        case .running: stage = .drafting
                        case .succeeded, .failed, .cancelled, .unknown:
                            if let next = assignment.retryAssignmentId {
                                attempt += 1
                                let count = assignment.architectErrors?.count ?? 0
                                detail = "Attempt \(attempt): fixing \(count == 1 ? "1 validation error" : "\(count) validation errors") from the last draft."
                                assignment = try await client.assignment(next)
                                continue
                            }
                            if let workflowId = assignment.draftWorkflowId, let version = assignment.draftVersion {
                                continuation.yield(DraftProgress(assignmentId: assignment.id, stage: .validating, attempt: attempt, detail: detail))
                                let draft = try await client.versions(workflowId: workflowId).first { $0.version == version }
                                var progress = DraftProgress(assignmentId: assignment.id, stage: draft == nil ? .failed : .ready, attempt: attempt, draft: draft)
                                // Additional workflows the architect proposed, saved as separate drafts.
                                for ref in (assignment.drafts ?? []) where ref.workflowId != workflowId {
                                    if let extra = try? await client.versions(workflowId: ref.workflowId).first(where: { $0.version == ref.version }) {
                                        progress.alsoSuggested.append(extra)
                                    }
                                }
                                continuation.yield(progress)
                            } else {
                                let reason = assignment.architectErrors?.first?.message ?? assignment.result?.summary
                                continuation.yield(DraftProgress(assignmentId: assignment.id, stage: .failed, attempt: attempt, detail: reason))
                            }
                            continuation.finish()
                            return
                        }
                        continuation.yield(DraftProgress(assignmentId: assignment.id, stage: stage, attempt: attempt, detail: detail))
                        try await Task.sleep(for: pollInterval)
                        assignment = try await client.assignment(assignment.id)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func activate(workflowId: String, version: Int) async throws -> Workflow { try await client.activate(workflowId: workflowId, version: version) }
    public func save(_ workflow: Workflow) async throws -> Workflow { try await client.saveWorkflow(workflow) }
    public func validate(_ workflow: Workflow) async throws -> ValidationResult { try await client.validate(workflowId: workflow.id, graph: workflow.graph) }
    public func control(runId: String, _ action: HubClient.RunControl) async throws -> Run { try await client.control(runId: runId, action) }
    public func startRun(workflowId: String, settings: RunSettings) async throws -> Run { try await client.startRun(workflowId: workflowId, settings: settings) }
    public func updateRun(runId: String, settings: RunSettings) async throws -> Run { try await client.updateRun(runId: runId, settings: settings) }
    public func templates() async throws -> [WorkflowTemplate] { try await client.templates() }
    public func createWorkflow(projectId: String, from template: WorkflowTemplate) async throws -> Workflow {
        guard let graph = template.graph else { throw HubError.http(status: 400, code: "TEMPLATE_GRAPH", message: "This hub did not send the template's graph.") }
        return try await client.createWorkflow(projectId: projectId, name: template.name, purpose: template.purpose, graph: graph, rationale: template.description)
    }
    public func decide(workItemId: String, _ decision: HubClient.Decision, decisionId: String?) async throws {
        try await client.decide(workItemId: workItemId, decision, decisionId: decisionId)
    }
    public func sendMessage(projectId: String, channelId: String, body: String, to recipient: MessageRecipient, parentId: String?) async throws -> Message {
        try await client.sendMessage(projectId: projectId, channelId: channelId, senderRoleId: ownerRoleId, to: recipient, parentId: parentId, body: body)
    }
    public func ackMessage(projectId: String, channelId: String, messageId: String) async throws -> Message {
        try await client.ackMessage(projectId: projectId, channelId: channelId, messageId: messageId, roleId: ownerRoleId)
    }
    public func markRead(projectId: String, channelId: String, messageId: String) async throws -> UnreadState {
        try await client.markRead(projectId: projectId, channelId: channelId, messageId: messageId, roleId: ownerRoleId)
    }
    public func enrollmentCode() async throws -> EnrollmentCode { try await client.createEnrollmentCode() }
    public func drain(machineId: String) async throws -> Machine { try await client.drain(machineId: machineId) }
    public func updateMachine(id: String, _ patch: MachinePatch) async throws -> Machine { try await client.updateMachine(id: id, patch) }
    public func updateAccount(id: String, _ patch: AccountPatch) async throws -> Account { try await client.updateAccount(id: id, patch) }
    public func updatePacing(_ settings: PacingSettings) async throws -> Pacing { try await client.updatePacing(settings) }
    public func events(after: Int?) -> AsyncThrowingStream<HubEvent, Error> { client.eventStream(after: after) }
}
