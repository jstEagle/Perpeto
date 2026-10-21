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

    private var eventTask: Task<Void, Never>?
    private var draftTasks: [String: Task<Void, Never>] = [:]

    public init(source: FactoryDataSource) {
        self.source = source
    }

    public var isDemo: Bool { source.isDemo }

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
        await refresh()
    }

    public func project(_ id: String) -> Project? { factory.projects.first { $0.id == id } }
    public func state(_ projectId: String) -> ProjectState { projectStates[projectId] ?? .empty }
    public func machine(_ id: String?) -> Machine? { factory.machines.first { $0.id == id } }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            factory = try await source.loadFactory()
            for project in factory.projects {
                projectStates[project.id] = try await source.loadProject(project.id)
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
            projectStates[id] = try await source.loadProject(id)
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

    private func apply(_ event: HubEvent) {
        guard let projectId = event.projectId else { return }
        var state = projectStates[projectId] ?? .empty
        state.events.insert(event, at: 0)
        if state.events.count > 1000 { state.events.removeLast(state.events.count - 1000) }
        projectStates[projectId] = state
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

    public func startRun(projectId: String, workflowId: String) async {
        await perform("Starting a run", projectId: projectId) {
            _ = try await self.source.startRun(workflowId: workflowId)
        }
    }

    public func decide(projectId: String, workItemId: String, _ decision: HubClient.Decision) async {
        await perform("Recording the decision", projectId: projectId) {
            _ = try await self.source.decide(workItemId: workItemId, decision)
        }
    }

    public func send(projectId: String, channelId: String, body: String) async {
        await perform("Sending the message", projectId: projectId) {
            _ = try await self.source.sendMessage(projectId: projectId, channelId: channelId, body: body)
        }
    }

    public func enrollmentCode() async -> EnrollmentCode? {
        do { return try await source.enrollmentCode() } catch {
            lastError = describe(error, operation: "Creating an enrollment code")
            return nil
        }
    }

    public func drain(_ machine: Machine) async {
        do {
            _ = try await source.drain(machineId: machine.id)
            factory = try await source.loadFactory()
        } catch {
            lastError = describe(error, operation: "Draining \(machine.name)")
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
