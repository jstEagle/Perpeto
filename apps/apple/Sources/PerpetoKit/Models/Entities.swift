import Foundation

// Entities from docs/architecture/README.md "Entities". Field names match the
// contract exactly; timestamps are ISO 8601 UTC strings decoded as Date.

public struct Project: Codable, Hashable, Identifiable, Sendable {
    public struct Repo: Codable, Hashable, Sendable {
        public var url: String
        public var defaultBranch: String
        public var localPath: String?

        public init(url: String, defaultBranch: String, localPath: String? = nil) {
            self.url = url
            self.defaultBranch = defaultBranch
            self.localPath = localPath
        }
    }

    public var id: String
    public var name: String
    public var repo: Repo
    public var docs: [DocRef]
    public var goals: [String]
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String, name: String, repo: Repo, docs: [DocRef], goals: [String], createdAt: Date, updatedAt: Date) {
        self.id = id
        self.name = name
        self.repo = repo
        self.docs = docs
        self.goals = goals
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey { case id, name, repo, docs, goals, createdAt, updatedAt }

    /// The hub stores `docs` as an open array; entries that are not doc
    /// references are skipped rather than failing the project.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        repo = try c.decode(Repo.self, forKey: .repo)
        docs = (try? c.decodeIfPresent(Lossy<DocRef>.self, forKey: .docs))?.elements ?? []
        goals = (try? c.decodeIfPresent([String].self, forKey: .goals)) ?? []
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    }
}

public struct DocRef: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, LenientEnum {
        case requirements, vision, spec, notes, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var title: String
    public var path: String?
    public var url: String?
    public var kind: Kind

    public init(id: String, title: String, path: String? = nil, url: String? = nil, kind: Kind) {
        self.id = id
        self.title = title
        self.path = path
        self.url = url
        self.kind = kind
    }
}

public struct Workflow: Codable, Hashable, Identifiable, Sendable {
    public enum Purpose: String, LenientEnum {
        case build, improve, maintain, custom, unknown
        public static var unknownCase: Self { .unknown }
    }

    public enum Status: String, LenientEnum {
        case draft, active, paused, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var projectId: String
    public var name: String
    public var purpose: Purpose
    public var version: Int
    public var graph: WorkflowGraph
    public var status: Status
    /// Who wrote this version. Absent on hubs that predate agent authoring.
    public var authoredBy: Authorship?
    /// The architect's explanation for an agent-authored version.
    public var rationale: String?
    /// The version this one was derived from.
    public var parentVersion: Int?
    /// On a workflow head: the version new runs use. Version records omit it.
    public var activeVersion: Int?
    /// Not in the contract's entity line; read when a hub includes it.
    public var createdAt: Date?

    public init(
        id: String, projectId: String, name: String, purpose: Purpose, version: Int, graph: WorkflowGraph,
        status: Status, authoredBy: Authorship? = nil, rationale: String? = nil, parentVersion: Int? = nil,
        activeVersion: Int? = nil, createdAt: Date? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.name = name
        self.purpose = purpose
        self.version = version
        self.graph = graph
        self.status = status
        self.authoredBy = authoredBy
        self.rationale = rationale
        self.parentVersion = parentVersion
        self.activeVersion = activeVersion
        self.createdAt = createdAt
    }
}

/// `authoredBy: { kind: 'agent'|'user', assignmentId?, prompt? }`
public struct Authorship: Codable, Hashable, Sendable {
    public enum Kind: String, LenientEnum {
        case agent, user, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var kind: Kind
    public var assignmentId: String?
    public var prompt: String?

    public init(kind: Kind, assignmentId: String? = nil, prompt: String? = nil) {
        self.kind = kind
        self.assignmentId = assignmentId
        self.prompt = prompt
    }
}

public struct Run: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case running, paused, stopped, completed, failed, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var projectId: String
    public var workflowId: String
    public var workflowVersion: Int
    public var status: Status
    public var startedAt: Date
    public var stoppedAt: Date?

    public init(id: String, projectId: String, workflowId: String, workflowVersion: Int, status: Status, startedAt: Date, stoppedAt: Date? = nil) {
        self.id = id
        self.projectId = projectId
        self.workflowId = workflowId
        self.workflowVersion = workflowVersion
        self.status = status
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
    }
}

public struct WorkItem: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case queued, active, blocked, done, failed, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var runId: String
    public var title: String
    public var body: String
    public var nodeId: String
    public var status: Status
    public var branch: String?
    public var prUrl: String?
    public var headSha: String?
    public var iteration: Int
    public var parentId: String?

    public init(
        id: String, runId: String, title: String, body: String, nodeId: String, status: Status, branch: String? = nil,
        prUrl: String? = nil, headSha: String? = nil, iteration: Int, parentId: String? = nil
    ) {
        self.id = id
        self.runId = runId
        self.title = title
        self.body = body
        self.nodeId = nodeId
        self.status = status
        self.branch = branch
        self.prUrl = prUrl
        self.headSha = headSha
        self.iteration = iteration
        self.parentId = parentId
    }

    enum CodingKeys: String, CodingKey { case id, runId, title, body, nodeId, status, branch, prUrl, headSha, iteration, parentId }

    /// The hub passes engine state through; optional detail may be absent.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        runId = try c.decode(String.self, forKey: .runId)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        nodeId = try c.decode(String.self, forKey: .nodeId)
        status = try c.decode(Status.self, forKey: .status)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        prUrl = try c.decodeIfPresent(String.self, forKey: .prUrl)
        headSha = try c.decodeIfPresent(String.self, forKey: .headSha)
        iteration = try c.decodeIfPresent(Int.self, forKey: .iteration) ?? 0
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
    }
}

public struct Harness: Codable, Hashable, Sendable {
    /// T3 driver kind, for example `claudeAgent` or `codex`.
    public var provider: String
    public var model: String
    public var options: [String: JSONValue]?

    public init(provider: String, model: String, options: [String: JSONValue]? = nil) {
        self.provider = provider
        self.model = model
        self.options = options
    }
}

public struct AgentPolicy: Codable, Hashable, Sendable {
    public var maxSubagents: Int
    public var allowedSubagentProviders: [String]
    public var maxTurns: Int?
    public var maxTokens: Int?
    public var canMessage: [String]

    public init(maxSubagents: Int, allowedSubagentProviders: [String], maxTurns: Int? = nil, maxTokens: Int? = nil, canMessage: [String]) {
        self.maxSubagents = maxSubagents
        self.allowedSubagentProviders = allowedSubagentProviders
        self.maxTurns = maxTurns
        self.maxTokens = maxTokens
        self.canMessage = canMessage
    }

    enum CodingKeys: String, CodingKey { case maxSubagents, allowedSubagentProviders, maxTurns, maxTokens, canMessage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxSubagents = try c.decodeIfPresent(Int.self, forKey: .maxSubagents) ?? 0
        allowedSubagentProviders = try c.decodeIfPresent([String].self, forKey: .allowedSubagentProviders) ?? []
        maxTurns = try c.decodeIfPresent(Int.self, forKey: .maxTurns)
        maxTokens = try c.decodeIfPresent(Int.self, forKey: .maxTokens)
        canMessage = try c.decodeIfPresent([String].self, forKey: .canMessage) ?? []
    }
}

public struct MachineRequirements: Codable, Hashable, Sendable {
    public var os: String?
    public var labels: [String]?
    public var providers: [String]?

    public init(os: String? = nil, labels: [String]? = nil, providers: [String]? = nil) {
        self.os = os
        self.labels = labels
        self.providers = providers
    }
}

public struct AssignmentResult: Codable, Hashable, Sendable {
    public enum Outcome: String, LenientEnum {
        case success, failure, blocked, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var outcome: Outcome
    public var summary: String
    public var branch: String?
    public var prUrl: String?
    public var headSha: String?
    public var threadRef: String?
    /// Review verdict, `pass` or `fail`.
    public var verdict: String?

    public init(outcome: Outcome, summary: String, branch: String? = nil, prUrl: String? = nil, headSha: String? = nil, threadRef: String? = nil, verdict: String? = nil) {
        self.outcome = outcome
        self.summary = summary
        self.branch = branch
        self.prUrl = prUrl
        self.headSha = headSha
        self.threadRef = threadRef
        self.verdict = verdict
    }

    enum CodingKeys: String, CodingKey { case outcome, summary, branch, prUrl, headSha, threadRef, verdict }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outcome = try c.decodeIfPresent(Outcome.self, forKey: .outcome) ?? .unknown
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        prUrl = try c.decodeIfPresent(String.self, forKey: .prUrl)
        headSha = try c.decodeIfPresent(String.self, forKey: .headSha)
        threadRef = try c.decodeIfPresent(String.self, forKey: .threadRef)
        verdict = try c.decodeIfPresent(String.self, forKey: .verdict)
    }
}

public struct Assignment: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case queued, leased, running, succeeded, failed, cancelled, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    /// Absent on project-scoped assignments such as the workflow architect.
    public var runId: String?
    public var workItemId: String?
    public var nodeId: String
    public var role: String
    public var prompt: String
    public var harness: Harness
    public var policy: AgentPolicy
    public var requirements: MachineRequirements
    public var status: Status
    public var machineId: String?
    public var leaseExpiresAt: Date?
    public var attempt: Int
    public var result: AssignmentResult?
    /// Workflow architect only: set when a valid draft was saved.
    public var draftWorkflowId: String?
    public var draftVersion: Int?
    /// Workflow architect only: the next attempt after an invalid result.
    public var retryAssignmentId: String?
    public var architectErrors: [ValidationIssue]?
    public var architectAttempt: Int?

    public init(
        id: String, runId: String?, workItemId: String?, nodeId: String, role: String, prompt: String, harness: Harness,
        policy: AgentPolicy, requirements: MachineRequirements, status: Status, machineId: String? = nil,
        leaseExpiresAt: Date? = nil, attempt: Int, result: AssignmentResult? = nil
    ) {
        self.id = id
        self.runId = runId
        self.workItemId = workItemId
        self.nodeId = nodeId
        self.role = role
        self.prompt = prompt
        self.harness = harness
        self.policy = policy
        self.requirements = requirements
        self.status = status
        self.machineId = machineId
        self.leaseExpiresAt = leaseExpiresAt
        self.attempt = attempt
        self.result = result
    }

    enum CodingKeys: String, CodingKey {
        case id, runId, workItemId, nodeId, role, prompt, harness, policy, requirements, status, machineId, leaseExpiresAt, attempt, result
        case draftWorkflowId, draftVersion, retryAssignmentId, architectErrors, architectAttempt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        workItemId = try c.decodeIfPresent(String.self, forKey: .workItemId)
        nodeId = try c.decode(String.self, forKey: .nodeId)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? nodeId
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        harness = try c.decode(Harness.self, forKey: .harness)
        policy = try c.decodeIfPresent(AgentPolicy.self, forKey: .policy) ?? AgentPolicy(maxSubagents: 0, allowedSubagentProviders: [], canMessage: [])
        requirements = try c.decodeIfPresent(MachineRequirements.self, forKey: .requirements) ?? MachineRequirements()
        status = try c.decode(Status.self, forKey: .status)
        machineId = try c.decodeIfPresent(String.self, forKey: .machineId)
        leaseExpiresAt = try c.decodeIfPresent(Date.self, forKey: .leaseExpiresAt)
        attempt = try c.decodeIfPresent(Int.self, forKey: .attempt) ?? 1
        result = try c.decodeIfPresent(AssignmentResult.self, forKey: .result)
        draftWorkflowId = try c.decodeIfPresent(String.self, forKey: .draftWorkflowId)
        draftVersion = try c.decodeIfPresent(Int.self, forKey: .draftVersion)
        retryAssignmentId = try c.decodeIfPresent(String.self, forKey: .retryAssignmentId)
        architectErrors = (try? c.decodeIfPresent(Lossy<ValidationIssue>.self, forKey: .architectErrors))?.elements
        architectAttempt = try c.decodeIfPresent(Int.self, forKey: .architectAttempt)
    }

    public var isWorking: Bool { status == .running || status == .leased }
}

public struct JobStep: Codable, Hashable, Sendable {
    public var name: String
    public var run: String
    public var timeoutSec: Int?

    public init(name: String, run: String, timeoutSec: Int? = nil) {
        self.name = name
        self.run = run
        self.timeoutSec = timeoutSec
    }
}

/// Referenced but not defined by the contract; decoded leniently.
public struct ArtifactRef: Codable, Hashable, Sendable {
    public var name: String?
    public var path: String?
    public var url: String?

    public init(name: String? = nil, path: String? = nil, url: String? = nil) {
        self.name = name
        self.path = path
        self.url = url
    }
}

public struct Job: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case queued, leased, running, passed, failed, cancelled, error, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var projectId: String
    public var runId: String?
    public var workItemId: String?
    public var repo: String
    /// Full commit SHA the job ran against.
    public var revision: String
    public var steps: [JobStep]
    public var requirements: MachineRequirements
    public var status: Status
    public var machineId: String?
    public var leaseExpiresAt: Date?
    public var attempt: Int
    public var logRef: String?
    public var artifacts: [ArtifactRef]
    public var configHash: String

    public init(
        id: String, projectId: String, runId: String? = nil, workItemId: String? = nil, repo: String, revision: String,
        steps: [JobStep], requirements: MachineRequirements, status: Status, machineId: String? = nil,
        leaseExpiresAt: Date? = nil, attempt: Int, logRef: String? = nil, artifacts: [ArtifactRef] = [], configHash: String
    ) {
        self.id = id
        self.projectId = projectId
        self.runId = runId
        self.workItemId = workItemId
        self.repo = repo
        self.revision = revision
        self.steps = steps
        self.requirements = requirements
        self.status = status
        self.machineId = machineId
        self.leaseExpiresAt = leaseExpiresAt
        self.attempt = attempt
        self.logRef = logRef
        self.artifacts = artifacts
        self.configHash = configHash
    }

    enum CodingKeys: String, CodingKey {
        case id, projectId, runId, workItemId, repo, revision, steps, requirements, status, machineId, leaseExpiresAt, attempt, logRef, artifacts, configHash
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = try c.decode(String.self, forKey: .projectId)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        workItemId = try c.decodeIfPresent(String.self, forKey: .workItemId)
        repo = (try? c.decode(String.self, forKey: .repo)) ?? (try? c.decode(Project.Repo.self, forKey: .repo))?.url ?? ""
        revision = try c.decodeIfPresent(String.self, forKey: .revision) ?? ""
        steps = (try? c.decodeIfPresent(Lossy<JobStep>.self, forKey: .steps))?.elements ?? []
        requirements = try c.decodeIfPresent(MachineRequirements.self, forKey: .requirements) ?? MachineRequirements()
        status = try c.decode(Status.self, forKey: .status)
        machineId = try c.decodeIfPresent(String.self, forKey: .machineId)
        leaseExpiresAt = try c.decodeIfPresent(Date.self, forKey: .leaseExpiresAt)
        attempt = try c.decodeIfPresent(Int.self, forKey: .attempt) ?? 1
        logRef = try c.decodeIfPresent(String.self, forKey: .logRef)
        artifacts = (try? c.decodeIfPresent(Lossy<ArtifactRef>.self, forKey: .artifacts))?.elements ?? []
        configHash = try c.decodeIfPresent(String.self, forKey: .configHash) ?? ""
    }
}

public struct MergeEntry: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case queued, testing, merging, merged, rejected, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var projectId: String
    public var prUrl: String
    public var headSha: String
    public var baseBranch: String
    public var status: Status
    public var jobId: String?
    public var reason: String?

    public init(id: String, projectId: String, prUrl: String, headSha: String, baseBranch: String, status: Status, jobId: String? = nil, reason: String? = nil) {
        self.id = id
        self.projectId = projectId
        self.prUrl = prUrl
        self.headSha = headSha
        self.baseBranch = baseBranch
        self.status = status
        self.jobId = jobId
        self.reason = reason
    }
}

public struct Machine: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case online, offline, draining, unknown
        public static var unknownCase: Self { .unknown }
    }

    public struct Capacity: Codable, Hashable, Sendable {
        public var maxAgents: Int
        public var maxJobs: Int
        public init(maxAgents: Int, maxJobs: Int) {
            self.maxAgents = maxAgents
            self.maxJobs = maxJobs
        }
    }

    public struct Running: Codable, Hashable, Sendable {
        public var agents: Int
        public var jobs: Int
        public init(agents: Int, jobs: Int) {
            self.agents = agents
            self.jobs = jobs
        }
    }

    public var id: String
    public var name: String
    public var os: String
    public var arch: String
    public var labels: [String]
    public var providers: [String]
    public var capacity: Capacity
    public var running: Running
    public var status: Status
    public var lastHeartbeatAt: Date
    public var version: String

    public init(
        id: String, name: String, os: String, arch: String, labels: [String], providers: [String], capacity: Capacity,
        running: Running, status: Status, lastHeartbeatAt: Date, version: String
    ) {
        self.id = id
        self.name = name
        self.os = os
        self.arch = arch
        self.labels = labels
        self.providers = providers
        self.capacity = capacity
        self.running = running
        self.status = status
        self.lastHeartbeatAt = lastHeartbeatAt
        self.version = version
    }

    enum CodingKeys: String, CodingKey { case id, name, os, arch, labels, providers, capacity, running, status, lastHeartbeatAt, version }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        os = try c.decodeIfPresent(String.self, forKey: .os) ?? ""
        arch = try c.decodeIfPresent(String.self, forKey: .arch) ?? ""
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
        providers = try c.decodeIfPresent([String].self, forKey: .providers) ?? []
        capacity = try c.decodeIfPresent(Capacity.self, forKey: .capacity) ?? Capacity(maxAgents: 0, maxJobs: 0)
        running = try c.decodeIfPresent(Running.self, forKey: .running) ?? Running(agents: 0, jobs: 0)
        status = try c.decode(Status.self, forKey: .status)
        lastHeartbeatAt = try c.decodeIfPresent(Date.self, forKey: .lastHeartbeatAt) ?? .distantPast
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
    }
}

public struct Account: Codable, Hashable, Identifiable, Sendable {
    public enum Status: String, LenientEnum {
        case active, cooling, disabled, invalid, unknown
        public static var unknownCase: Self { .unknown }
    }

    public var id: String
    public var machineId: String
    public var provider: String
    public var label: String
    public var status: Status
    public var cooldownUntil: Date?
    public var lastUsedAt: Date?

    public init(id: String, machineId: String, provider: String, label: String, status: Status, cooldownUntil: Date? = nil, lastUsedAt: Date? = nil) {
        self.id = id
        self.machineId = machineId
        self.provider = provider
        self.label = label
        self.status = status
        self.cooldownUntil = cooldownUntil
        self.lastUsedAt = lastUsedAt
    }
}

public struct UsageRecord: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var projectId: String
    public var runId: String?
    public var assignmentId: String?
    public var machineId: String
    public var accountId: String?
    public var provider: String
    public var model: String
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    public var costUsd: Double?
    public var at: Date

    public init(
        id: String, projectId: String, runId: String? = nil, assignmentId: String? = nil, machineId: String,
        accountId: String? = nil, provider: String, model: String, inputTokens: Int, outputTokens: Int,
        cacheReadTokens: Int, cacheWriteTokens: Int, costUsd: Double? = nil, at: Date
    ) {
        self.id = id
        self.projectId = projectId
        self.runId = runId
        self.assignmentId = assignmentId
        self.machineId = machineId
        self.accountId = accountId
        self.provider = provider
        self.model = model
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.at = at
    }

    public var totalTokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens }
}

public struct HubEvent: Codable, Hashable, Identifiable, Sendable {
    public struct Subject: Codable, Hashable, Sendable {
        public var kind: String
        public var id: String
        public init(kind: String, id: String) {
            self.kind = kind
            self.id = id
        }
    }

    /// Hub-global increasing sequence number.
    public var seq: Int
    public var at: Date
    public var type: String
    public var projectId: String?
    public var runId: String?
    public var subject: Subject
    public var data: JSONValue

    public var id: Int { seq }

    public init(seq: Int, at: Date, type: String, projectId: String? = nil, runId: String? = nil, subject: Subject, data: JSONValue) {
        self.seq = seq
        self.at = at
        self.type = type
        self.projectId = projectId
        self.runId = runId
        self.subject = subject
        self.data = data
    }
}

/// Interaction event types from "Observing runs".
public enum InteractionType: String, LenientEnum {
    case workitemMoved = "workitem.moved"
    case agentDelegated = "agent.delegated"
    case agentMessaged = "agent.messaged"
    case assignmentState = "assignment.state"
    case gateResult = "gate.result"
    case unknown
    public static var unknownCase: Self { .unknown }
}

extension HubEvent {
    /// Lease renewals and heartbeats arrive every few seconds and change
    /// nothing a person reads; they are neither shown nor used to refetch.
    public var isHousekeeping: Bool { type == "machine.heartbeat" || type.hasSuffix(".renewed") }

    public var interaction: InteractionType { InteractionType(rawValue: type) ?? .unknown }
    /// Interactions with no matching edge are recorded with `unplanned: true`.
    public var isUnplanned: Bool { data["unplanned"]?.boolValue ?? false }
    /// Node that sent the work, delegation or message (`data.sourceNodeId`;
    /// engine `workitem.moved` events use `from`).
    public var sourceNodeId: String? { data["sourceNodeId"]?.stringValue ?? data["from"]?.stringValue }
    /// Node on the receiving end (`data.targetNodeId`, or `to`).
    public var targetNodeId: String? { data["targetNodeId"]?.stringValue ?? data["to"]?.stringValue }
    /// Graph node IDs this event touches.
    public var nodeIds: [String] {
        var ids: [String] = []
        for id in [sourceNodeId, targetNodeId, data["nodeId"]?.stringValue].compactMap({ $0 }) where !ids.contains(id) { ids.append(id) }
        return ids
    }
    public var edgeId: String? { data["edgeId"]?.stringValue }
}
