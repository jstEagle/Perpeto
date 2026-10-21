import Foundation

/// Reads and writes factory state through Hub API v1.
public struct HubDataSource: FactoryDataSource {
    public let client: HubClient
    /// Role the owner sends messages as.
    public let ownerRoleId: String

    public init(client: HubClient, ownerRoleId: String = "owner") {
        self.client = client
        self.ownerRoleId = ownerRoleId
    }

    public var isDemo: Bool { false }

    public func loadFactory() async throws -> FactoryState {
        async let projects = client.projects()
        async let machines = client.machines()
        async let accounts = client.accounts()
        async let jobs = client.jobs()
        async let overview = client.overview()
        async let usage = usageBundle(projectId: nil)
        return try await FactoryState(projects: projects, machines: machines, accounts: accounts, jobs: jobs, overview: overview, usage: usage)
    }

    public func loadProject(_ projectId: String) async throws -> ProjectState {
        async let workflowsCall = client.workflows(projectId: projectId)
        async let mergeQueue = client.mergeQueue(projectId: projectId)
        async let usage = usageBundle(projectId: projectId)
        async let channelsCall = (try? client.channels(projectId: projectId)) ?? []
        async let metrics = try? client.projectMetrics(projectId: projectId, window: .day)
        async let eventsCall = (try? client.events(after: nil, limit: 500)) ?? []

        let workflows = try await workflowsCall
        var versions: [String: [Workflow]] = [:]
        for workflow in workflows {
            versions[workflow.id] = ((try? await client.versions(workflowId: workflow.id)) ?? [workflow]).sorted { $0.version < $1.version }
        }

        // Runs are reached through events and work items; the contract has no
        // project run list, so collect run IDs from the event log.
        let events = await eventsCall.filter { $0.projectId == projectId }
        let runIds = Array(Set(events.compactMap(\.runId)))
        var runs: [Run] = []
        var items: [WorkItem] = []
        var assignments: [Assignment] = []
        var runMetrics: [String: MetricsSnapshot] = [:]
        for runId in runIds {
            guard let run = try? await client.run(runId) else { continue }
            runs.append(run)
            items += (try? await client.workItems(runId: runId)) ?? []
            assignments += (try? await client.assignments(runId: runId)) ?? []
            if run.status == .running || run.status == .paused {
                runMetrics[runId] = try? await client.runMetrics(runId: runId, window: .day)
            }
        }

        let channels = await channelsCall
        var messages: [String: [Message]] = [:]
        for channel in channels {
            messages[channel.id] = (try? await client.messages(projectId: projectId, channelId: channel.id))?.messages ?? []
        }

        return try await ProjectState(
            workflows: workflows, versions: versions, runs: runs.sorted { $0.startedAt > $1.startedAt }, workItems: items,
            assignments: assignments, mergeQueue: mergeQueue, channels: channels, messages: messages, usage: usage,
            metrics: metrics, runMetrics: runMetrics, events: events)
    }

    private func usageBundle(projectId: String?) async throws -> UsageBundle {
        async let day = client.usage(projectId: projectId, groupBy: .day)
        async let provider = client.usage(projectId: projectId, groupBy: .provider)
        async let model = client.usage(projectId: projectId, groupBy: .model)
        async let machine = client.usage(projectId: projectId, groupBy: .machine)
        return try await UsageBundle(byDay: day.sorted { $0.key < $1.key }, byProvider: provider, byModel: model, byMachine: machine)
    }

    /// Requests a draft, then follows the architect assignment through the
    /// event stream until a new draft version appears.
    public func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) -> AsyncThrowingStream<DraftProgress, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let result = try await client.requestDraft(projectId: projectId, prompt: prompt, baseWorkflowId: baseWorkflowId)
                    let assignmentId = result.followAssignmentId
                    continuation.yield(DraftProgress(assignmentId: assignmentId, stage: .queued))
                    let latestSeq = (try? await client.events(after: nil, limit: 1))?.last?.seq
                    for try await event in client.eventStream(after: latestSeq) {
                        guard event.subject.id == assignmentId || event.data["assignmentId"]?.stringValue == assignmentId else { continue }
                        let state = event.data["state"]?.stringValue ?? event.data["status"]?.stringValue
                        switch state {
                        case "leased": continuation.yield(DraftProgress(assignmentId: assignmentId, stage: .reading))
                        case "running": continuation.yield(DraftProgress(assignmentId: assignmentId, stage: .drafting))
                        case "failed", "cancelled":
                            continuation.yield(DraftProgress(assignmentId: assignmentId, stage: .failed, detail: event.data["summary"]?.stringValue))
                            continuation.finish()
                            return
                        case "succeeded":
                            continuation.yield(DraftProgress(assignmentId: assignmentId, stage: .validating))
                            let workflows = try await client.workflows(projectId: projectId)
                            let candidates = try await withThrowingTaskGroup(of: [Workflow].self) { group in
                                for workflow in workflows { group.addTask { try await client.versions(workflowId: workflow.id) } }
                                return try await group.reduce(into: [Workflow]()) { $0 += $1 }
                            }
                            let draft = candidates.filter { $0.authoredBy?.assignmentId == assignmentId }.max { $0.version < $1.version }
                            continuation.yield(DraftProgress(assignmentId: assignmentId, stage: draft == nil ? .failed : .ready, draft: draft))
                            continuation.finish()
                            return
                        default: break
                        }
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
    public func startRun(workflowId: String) async throws -> Run { try await client.startRun(workflowId: workflowId) }
    public func decide(workItemId: String, _ decision: HubClient.Decision) async throws -> WorkItem { try await client.decide(workItemId: workItemId, decision) }
    public func sendMessage(projectId: String, channelId: String, body: String) async throws -> Message {
        try await client.sendMessage(projectId: projectId, channelId: channelId, senderRoleId: ownerRoleId, recipientRoleId: nil, body: body)
    }
    public func enrollmentCode() async throws -> EnrollmentCode { try await client.createEnrollmentCode() }
    public func drain(machineId: String) async throws -> Machine { try await client.drain(machineId: machineId) }
    public func events(after: Int?) -> AsyncThrowingStream<HubEvent, Error> { client.eventStream(after: after) }
}
