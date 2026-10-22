import Foundation

/// Everything the factory-level screens need.
public struct FactoryState: Sendable, Hashable {
    public var projects: [Project]
    public var machines: [Machine]
    public var accounts: [Account]
    public var jobs: [Job]
    public var overview: FactoryOverview
    public var usage: UsageBundle
    /// Subscription pacing; nil when the hub has no pacing route yet.
    public var pacing: Pacing?
    /// Observed T3 Code sessions; nil when the hub doesn't observe sessions yet.
    public var sessions: ObservedSessions?

    public init(projects: [Project], machines: [Machine], accounts: [Account], jobs: [Job], overview: FactoryOverview, usage: UsageBundle, pacing: Pacing? = nil,
                sessions: ObservedSessions? = nil) {
        self.sessions = sessions
        self.projects = projects
        self.machines = machines
        self.accounts = accounts
        self.jobs = jobs
        self.overview = overview
        self.usage = usage
        self.pacing = pacing
    }

    public static let empty = FactoryState(projects: [], machines: [], accounts: [], jobs: [], overview: .init(activeAgents: 0, queuedWork: 0, tokensToday: 0, machinesOnline: 0), usage: .empty)
}

public struct UsageBundle: Sendable, Hashable {
    public var byDay: [UsageGroup]
    public var byProvider: [UsageGroup]
    public var byModel: [UsageGroup]
    public var byMachine: [UsageGroup]
    public var byRole: [UsageGroup]

    public init(byDay: [UsageGroup], byProvider: [UsageGroup], byModel: [UsageGroup], byMachine: [UsageGroup], byRole: [UsageGroup] = []) {
        self.byRole = byRole
        self.byDay = byDay
        self.byProvider = byProvider
        self.byModel = byModel
        self.byMachine = byMachine
    }

    public init(records: [UsageRecord]) {
        byDay = UsageGroup.group(records, by: .day)
        byProvider = UsageGroup.group(records, by: .provider)
        byModel = UsageGroup.group(records, by: .model)
        byMachine = UsageGroup.group(records, by: .machine)
        byRole = UsageGroup.group(records, by: .role)
    }

    public static let empty = UsageBundle(byDay: [], byProvider: [], byModel: [], byMachine: [])

    public var total: Int { byDay.reduce(0) { $0 + $1.totalTokens } }
    /// The most recent day's total, keyed `yyyy-MM-dd` like the hub.
    public var today: Int { byDay.last?.totalTokens ?? 0 }
}

/// Everything one project's screens need.
public struct ProjectState: Sendable, Hashable {
    public var workflows: [Workflow]
    /// All versions per workflow ID, oldest first.
    public var versions: [String: [Workflow]]
    public var runs: [Run]
    public var workItems: [WorkItem]
    public var assignments: [Assignment]
    public var mergeQueue: [MergeEntry]
    public var channels: [Channel]
    public var messages: [String: [Message]]
    /// The owner's unread count per channel, from the hub's read cursors.
    public var unread: [String: Int] = [:]
    public var usage: UsageBundle
    public var metrics: MetricsSnapshot?
    public var runMetrics: [String: MetricsSnapshot]
    public var events: [HubEvent]

    public init(
        workflows: [Workflow], versions: [String: [Workflow]], runs: [Run], workItems: [WorkItem], assignments: [Assignment],
        mergeQueue: [MergeEntry], channels: [Channel], messages: [String: [Message]], usage: UsageBundle,
        metrics: MetricsSnapshot?, runMetrics: [String: MetricsSnapshot], events: [HubEvent], unread: [String: Int] = [:]
    ) {
        self.unread = unread
        self.workflows = workflows
        self.versions = versions
        self.runs = runs
        self.workItems = workItems
        self.assignments = assignments
        self.mergeQueue = mergeQueue
        self.channels = channels
        self.messages = messages
        self.usage = usage
        self.metrics = metrics
        self.runMetrics = runMetrics
        self.events = events
    }

    public static let empty = ProjectState(workflows: [], versions: [:], runs: [], workItems: [], assignments: [], mergeQueue: [], channels: [], messages: [:], usage: .empty, metrics: nil, runMetrics: [:], events: [])

    public var activeAgents: Int { assignments.filter(\.isWorking).count }
    public var unreadTotal: Int { unread.values.reduce(0, +) }
    public var messagesById: [String: Message] {
        Dictionary(messages.values.flatMap { $0 }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }
    public var queuedWork: Int { workItems.filter { $0.status == .queued }.count }

    public func activeVersion(of workflowId: String) -> Workflow? {
        (versions[workflowId] ?? []).last { $0.status == .active } ?? workflows.first { $0.id == workflowId && $0.status == .active }
    }

    /// Newest draft that is newer than the active version.
    public func pendingDraft(of workflowId: String) -> Workflow? {
        let active = activeVersion(of: workflowId)?.version ?? 0
        return (versions[workflowId] ?? []).last { $0.status == .draft && $0.version > active }
    }

    public func version(_ version: Int, of workflowId: String) -> Workflow? {
        (versions[workflowId] ?? []).first { $0.version == version }
    }
}

/// One run's live state, refreshed together after live events.
public struct RunSnapshot: Sendable, Hashable {
    public var run: Run
    public var workItems: [WorkItem]
    public var assignments: [Assignment]
    public var metrics: MetricsSnapshot?

    public init(run: Run, workItems: [WorkItem], assignments: [Assignment], metrics: MetricsSnapshot?) {
        self.run = run
        self.workItems = workItems
        self.assignments = assignments
        self.metrics = metrics
    }
}

extension ProjectState {
    /// Replaces one run's data in place.
    public mutating func apply(_ snapshot: RunSnapshot) {
        let id = snapshot.run.id
        if let index = runs.firstIndex(where: { $0.id == id }) { runs[index] = snapshot.run } else { runs.insert(snapshot.run, at: 0) }
        workItems = workItems.filter { $0.runId != id } + snapshot.workItems
        assignments = assignments.filter { $0.runId != id } + snapshot.assignments
        runMetrics[id] = snapshot.metrics
    }
}

/// Progress of a workflow-architect assignment, shown while a draft is written.
public struct DraftProgress: Sendable, Hashable {
    public enum Stage: Int, Sendable, Hashable, CaseIterable, Comparable {
        case queued, reading, drafting, validating, ready, failed

        public static func < (a: Stage, b: Stage) -> Bool { a.rawValue < b.rawValue }

        public var title: String {
            switch self {
            case .queued: "Waiting for a machine"
            case .reading: "Reading docs, goals and machines"
            case .drafting: "Drafting the graph"
            case .validating: "Validating with the workflow package"
            case .ready: "Draft ready for review"
            case .failed: "Architect could not produce a valid graph"
            }
        }
    }

    public var assignmentId: String?
    public var stage: Stage
    /// Further workflows the architect proposed alongside the primary draft.
    public var alsoSuggested: [Workflow] = []
    public var attempt: Int
    public var detail: String?
    public var draft: Workflow?

    public init(assignmentId: String?, stage: Stage, attempt: Int = 1, detail: String? = nil, draft: Workflow? = nil) {
        self.assignmentId = assignmentId
        self.stage = stage
        self.attempt = attempt
        self.detail = detail
        self.draft = draft
    }
}

/// Where the app reads factory state from: the configured hub or demo fixtures.
public protocol FactoryDataSource: Sendable {
    var isDemo: Bool { get }
    func loadFactory() async throws -> FactoryState
    /// Loads a project with run metrics measured over `window`.
    func loadProject(_ projectId: String, window: MetricsWindow) async throws -> ProjectState
    /// Reloads one run: its status, work, assignments and metrics.
    func loadRun(_ runId: String, window: MetricsWindow) async throws -> RunSnapshot
    func requestDraft(projectId: String, prompt: String, baseWorkflowId: String?) -> AsyncThrowingStream<DraftProgress, Error>
    func activate(workflowId: String, version: Int) async throws -> Workflow
    func save(_ workflow: Workflow) async throws -> Workflow
    func validate(_ workflow: Workflow) async throws -> ValidationResult
    func control(runId: String, _ action: HubClient.RunControl) async throws -> Run
    func startRun(workflowId: String, settings: RunSettings) async throws -> Run
    /// Changes a running or paused run's intake settings.
    func updateRun(runId: String, settings: RunSettings) async throws -> Run
    func templates() async throws -> [WorkflowTemplate]
    /// Creates draft version 1 of a new workflow from a template.
    func createWorkflow(projectId: String, from template: WorkflowTemplate) async throws -> Workflow
    func decide(workItemId: String, _ decision: HubClient.Decision, decisionId: String?) async throws
    /// Sends as the owner. With `parentId` the message is a reply in that thread.
    func sendMessage(projectId: String, channelId: String, body: String, to recipient: MessageRecipient, parentId: String?) async throws -> Message
    /// Acknowledges a message addressed to the owner.
    func ackMessage(projectId: String, channelId: String, messageId: String) async throws -> Message
    /// Moves the owner's read cursor in a channel forward.
    func markRead(projectId: String, channelId: String, messageId: String) async throws -> UnreadState
    func enrollmentCode() async throws -> EnrollmentCode
    func drain(machineId: String) async throws -> Machine
    /// Renames a subscription or sets its plan.
    func updateAccount(id: String, _ patch: AccountPatch) async throws -> Account
    func updatePacing(_ settings: PacingSettings) async throws -> Pacing
    func events(after: Int?) -> AsyncThrowingStream<HubEvent, Error>
}

extension FactoryDataSource {
    /// Sources that predate subscription pacing refuse its writes.
    public func updateAccount(id: String, _ patch: AccountPatch) async throws -> Account {
        throw HubError.http(status: 405, code: "UNSUPPORTED", message: "Editing subscriptions is not available here.")
    }
    public func updatePacing(_ settings: PacingSettings) async throws -> Pacing {
        throw HubError.http(status: 405, code: "UNSUPPORTED", message: "Pacing is not available here.")
    }
}
