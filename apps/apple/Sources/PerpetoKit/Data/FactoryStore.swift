import Foundation
import Observation

/// App-wide state. Views read from it; it talks to the hub or demo fixtures.
@MainActor
@Observable
public final class FactoryStore {
    public private(set) var source: FactoryDataSource
    public private(set) var factory: FactoryState = .empty
    public private(set) var projectStates: [String: ProjectState] = [:]
    public private(set) var isLoading = false
    public private(set) var lastUpdated: Date?
    /// Most recent failed operation, phrased for display.
    public var lastError: String?
    /// Architect progress per project while a draft is being written.
    public private(set) var drafts: [String: DraftProgress] = [:]
    /// Window for run and project metrics. Changing it refetches them.
    public private(set) var metricsWindow: MetricsWindow = .day

    private var eventTask: Task<Void, Never>?
    private var draftTasks: [String: Task<Void, Never>] = [:]
    /// Live events are coalesced: bursts of events trigger one refetch.
    private var pendingRuns: Set<String> = []
    private var pendingProjects: Set<String> = []
    private var pendingFactory = false
    private var refreshTask: Task<Void, Never>?
    /// Quiet period before refetching after a live event.
    public var eventDebounce: Duration = .milliseconds(750)

    public init(source: FactoryDataSource) {
        self.source = source
    }

    public var isDemo: Bool { source.isDemo }

    /// Observe-only: the hub has loaded and reports no projects, so the app
    /// is about the factory (sessions, machines, subscriptions, usage) and
    /// hides the project-only sections.
    public var isObserveOnly: Bool { lastUpdated != nil && factory.projects.isEmpty }

    /// Picks the hub when settings are complete, otherwise demo data.
    public static func makeSource(settings: HubSettings = HubSettings()) -> (FactoryDataSource, String?) {
        do {
            if let client = try settings.makeClient() { return (HubDataSource(client: client), nil) }
        } catch {
            return (DemoDataSource(), (error as? HubError)?.errorDescription)
        }
        return (DemoDataSource(), nil)
    }

    public func use(_ source: FactoryDataSource) async {
        eventTask?.cancel()
        self.source = source
        factory = .empty
        projectStates = [:]
        drafts = [:]
        templates = []
        await refresh()
    }

    public func project(_ id: String) -> Project? { factory.projects.first { $0.id == id } }
    public func state(_ projectId: String) -> ProjectState { projectStates[projectId] ?? .empty }
    public func machine(_ id: String?) -> Machine? { factory.machines.first { $0.id == id } }
    public var machineNames: [String: String] { Dictionary(factory.machines.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a }) }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            factory = try await source.loadFactory()
            for project in factory.projects {
                projectStates[project.id] = try await source.loadProject(project.id, window: metricsWindow)
            }
            lastUpdated = Date()
            lastError = nil
            startEvents()
        } catch {
            lastError = describe(error, operation: "Refreshing factory state")
        }
    }

    public func reloadProject(_ id: String) async {
        do {
            projectStates[id] = try await source.loadProject(id, window: metricsWindow)
        } catch {
            lastError = describe(error, operation: "Loading the project")
        }
    }

    private func startEvents() {
        guard !source.isDemo, eventTask == nil || eventTask?.isCancelled == true else { return }
        let after = projectStates.values.flatMap(\.events).map(\.seq).max()
        let stream = source.events(after: after)
        eventTask = Task { [weak self] in
            do {
                for try await event in stream {
                    self?.apply(event)
                }
            } catch {
                self?.lastError = self?.describe(error, operation: "Following live events")
            }
        }
    }

    func apply(_ event: HubEvent) {
        guard !event.isHousekeeping else { return }
        if let projectId = event.projectId {
            var state = projectStates[projectId] ?? .empty
            state.events.insert(event, at: 0)
            if state.events.count > 1000 { state.events.removeLast(state.events.count - 1000) }
            projectStates[projectId] = state
        }
        scheduleRefresh(for: event)
    }

    /// Decides what an event invalidates, then refetches after a quiet period
    /// so a burst of interactions costs one round of requests.
    private func scheduleRefresh(for event: HubEvent) {
        let type = event.type
        if type.hasPrefix("machine.") || type.hasPrefix("enrollment.") || type.hasSuffix(".usage") || type.hasPrefix("pacing.") || type.hasPrefix("account.")
            || type.hasPrefix("session.") || type.hasPrefix("sessions.") {
            pendingFactory = true
        }
        if let runId = event.runId, projectStates[event.projectId ?? ""]?.runs.contains(where: { $0.id == runId }) == true {
            pendingRuns.insert(runId)
        }
        if let projectId = event.projectId,
           type.hasPrefix("workflow.") || type.hasPrefix("merge-entry.") || type.hasPrefix("project.") || type == "run.started"
            || type.hasPrefix("message.") || type == "agent.messaged"
            || (event.runId != nil && projectStates[projectId]?.runs.contains(where: { $0.id == event.runId }) != true) {
            pendingProjects.insert(projectId)
        }
        guard refreshTask == nil, pendingFactory || !pendingRuns.isEmpty || !pendingProjects.isEmpty else { return }
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: self?.eventDebounce ?? .milliseconds(750))
            await self?.flushRefresh()
        }
    }

    private func flushRefresh() async {
        let runs = pendingRuns, projects = pendingProjects, factoryChanged = pendingFactory
        pendingRuns = []
        pendingProjects = []
        pendingFactory = false
        refreshTask = nil
        if factoryChanged, let factory = try? await source.loadFactory() { self.factory = factory }
        for projectId in projects {
            await reloadProject(projectId, keepEvents: true)
        }
        for runId in runs {
            guard let projectId = projectStates.first(where: { $0.value.runs.contains { $0.id == runId } })?.key,
                  !projects.contains(projectId),
                  let snapshot = try? await source.loadRun(runId, window: metricsWindow) else { continue }
            projectStates[projectId]?.apply(snapshot)
        }
        lastUpdated = Date()
    }

    /// Reloads a project but keeps live events already received.
    private func reloadProject(_ id: String, keepEvents: Bool) async {
        let events = projectStates[id]?.events ?? []
        await reloadProject(id)
        if keepEvents, var state = projectStates[id] {
            let known = Set(state.events.map(\.seq))
            state.events = (state.events + events.filter { !known.contains($0.seq) }).sorted { $0.seq > $1.seq }
            projectStates[id] = state
        }
    }

    // MARK: Metrics window

    /// Changes the metrics window and refetches metrics for every loaded run.
    public func setMetricsWindow(_ window: MetricsWindow) async {
        guard window != metricsWindow else { return }
        metricsWindow = window
        for (projectId, state) in projectStates {
            for runId in state.runMetrics.keys {
                guard let snapshot = try? await source.loadRun(runId, window: window) else { continue }
                projectStates[projectId]?.apply(snapshot)
            }
        }
    }

    // MARK: Workflow authoring

    public func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) {
        draftTasks[projectId]?.cancel()
        drafts[projectId] = DraftProgress(assignmentId: nil, stage: .queued)
        let stream = source.requestDraft(projectId: projectId, prompt: prompt, baseWorkflowId: baseWorkflowId)
        draftTasks[projectId] = Task { [weak self] in
            do {
                for try await progress in stream {
                    self?.drafts[projectId] = progress
                }
                await self?.reloadProject(projectId)
            } catch {
                self?.drafts[projectId] = DraftProgress(assignmentId: nil, stage: .failed, detail: self?.describe(error, operation: "Requesting a draft"))
            }
        }
    }

    public func clearDraft(projectId: String) {
        draftTasks[projectId]?.cancel()
        drafts[projectId] = nil
    }

    public func activate(_ workflow: Workflow) async {
        await perform("Activating the workflow", projectId: workflow.projectId) {
            _ = try await self.source.activate(workflowId: workflow.id, version: workflow.version)
        }
    }

    @discardableResult
    public func save(_ workflow: Workflow) async -> Workflow? {
        var saved: Workflow?
        await perform("Saving the workflow", projectId: workflow.projectId) {
            saved = try await self.source.save(workflow)
        }
        return saved
    }

    public func validate(_ workflow: Workflow) async -> ValidationResult {
        (try? await source.validate(workflow)) ?? WorkflowValidator.validate(workflow.graph)
    }

    // MARK: Runs and work

    public func control(_ run: Run, _ action: HubClient.RunControl) async {
        await perform("Changing the run state", projectId: run.projectId) {
            _ = try await self.source.control(runId: run.id, action)
        }
    }

    public func startRun(projectId: String, workflowId: String, settings: RunSettings = RunSettings()) async {
        await perform("Starting a run", projectId: projectId) {
            _ = try await self.source.startRun(workflowId: workflowId, settings: settings)
        }
    }

    public func updateRun(_ run: Run, settings: RunSettings) async {
        await perform("Saving the run settings", projectId: run.projectId) {
            _ = try await self.source.updateRun(runId: run.id, settings: settings)
        }
    }

    /// The template library, cached after the first read.
    public private(set) var templates: [WorkflowTemplate] = []

    public func loadTemplates() async {
        guard templates.isEmpty else { return }
        templates = (try? await source.templates()) ?? []
    }

    /// Creates a workflow from a template and returns it, as draft version 1.
    public func createWorkflow(projectId: String, from template: WorkflowTemplate) async -> Workflow? {
        var created: Workflow?
        await perform("Creating the workflow", projectId: projectId) {
            created = try await self.source.createWorkflow(projectId: projectId, from: template)
        }
        return created
    }

    /// Answers the wait the person saw: sends the item's `decisionId`. If the
    /// item has moved on, the hub refuses it and the project reloads.
    public func decide(projectId: String, item: WorkItem, _ decision: HubClient.Decision) async {
        do {
            try await source.decide(workItemId: item.id, decision, decisionId: item.decisionId)
            lastError = nil
        } catch HubError.conflict(let code, _) where code == "STALE_DECISION" || code == "CONFLICT" {
            lastError = "\(item.title) now waits for a different decision, so yours was not applied. The list is refreshed; decide again if it still needs you."
        } catch {
            lastError = describe(error, operation: "Recording the decision")
        }
        await reloadProject(projectId)
    }

    public func send(projectId: String, channelId: String, body: String, to recipient: MessageRecipient = .everyone, parentId: String? = nil) async {
        await perform("Sending the message", projectId: projectId) {
            _ = try await self.source.sendMessage(projectId: projectId, channelId: channelId, body: body, to: recipient, parentId: parentId)
        }
    }

    /// Acknowledges a message addressed to the owner, in place.
    public func acknowledge(_ message: Message) async {
        do {
            let updated = try await source.ackMessage(projectId: message.projectId, channelId: message.channelId, messageId: message.id)
            if let index = projectStates[message.projectId]?.messages[message.channelId]?.firstIndex(where: { $0.id == message.id }) {
                projectStates[message.projectId]?.messages[message.channelId]?[index] = updated
            }
            lastError = nil
        } catch {
            lastError = describe(error, operation: "Acknowledging the message")
        }
    }

    /// Marks a channel read up to its newest message. Quiet on failure: the
    /// count stays and the next refresh tries again.
    public func markRead(projectId: String, channelId: String) async {
        guard (projectStates[projectId]?.unread[channelId] ?? 0) > 0,
              let last = projectStates[projectId]?.messages[channelId]?.last else { return }
        if let result = try? await source.markRead(projectId: projectId, channelId: channelId, messageId: last.id) {
            projectStates[projectId]?.unread[channelId] = result.unreadCount
        }
    }

    public func enrollmentCode() async -> EnrollmentCode? {
        do { return try await source.enrollmentCode() } catch {
            lastError = describe(error, operation: "Creating an enrollment code")
            return nil
        }
    }

    public func drain(_ machine: Machine) async { await apply(.drain, to: machine) }

    /// Cordons, uncordons or drains a machine, shows the hub's answer at
    /// once, then reloads the fleet. A hub without `PATCH /machines/:id`
    /// still drains through its older route.
    public func apply(_ action: FleetAction, to machine: Machine) async {
        do {
            let updated: Machine
            do {
                updated = try await source.updateMachine(id: machine.id, action.patch)
            } catch HubError.http(let status, _, _) where action == .drain && (status == 404 || status == 405) {
                updated = try await source.drain(machineId: machine.id)
            }
            if let index = factory.machines.firstIndex(where: { $0.id == machine.id }) { factory.machines[index] = updated }
            lastError = nil
            factory = try await source.loadFactory()
        } catch {
            let verb = switch action {
            case .cordon: "Cordoning"
            case .uncordon: "Uncordoning"
            case .drain: "Draining"
            }
            lastError = describe(error, operation: "\(verb) \(machine.name)")
        }
    }

    // MARK: Subscriptions and pacing

    /// Renames a subscription or sets its plan, then reloads the factory.
    @discardableResult
    public func updateAccount(_ account: Account, label: String, plan: String) async -> Bool {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let plan = plan.trimmingCharacters(in: .whitespacesAndNewlines)
        let patch = AccountPatch(label: label == account.label ? nil : label, plan: plan == (account.plan ?? "") ? nil : plan)
        guard patch.label != nil || patch.plan != nil else { return true }
        do {
            _ = try await source.updateAccount(id: account.id, patch)
            factory = try await source.loadFactory()
            lastError = nil
            return true
        } catch {
            lastError = describe(error, operation: "Saving \(account.label)")
            return false
        }
    }

    /// Applies pacing settings on screen at once; the hub's answer replaces them.
    public func updatePacing(_ settings: PacingSettings) async {
        let before = factory.pacing
        if let current = factory.pacing { factory.pacing = settings.applied(to: current) }
        do {
            factory.pacing = try await source.updatePacing(settings)
            lastError = nil
        } catch {
            factory.pacing = before
            lastError = describe(error, operation: "Saving the pacing settings")
        }
    }

    private func perform(_ operation: String, projectId: String, _ body: @escaping () async throws -> Void) async {
        do {
            try await body()
            lastError = nil
        } catch {
            lastError = describe(error, operation: operation)
        }
        await reloadProject(projectId)
    }

    nonisolated func describe(_ error: Error, operation: String) -> String {
        let reason = (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
        return "\(operation) failed. \(reason)"
    }
}
