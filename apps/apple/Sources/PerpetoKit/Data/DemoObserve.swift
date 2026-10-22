import Foundation

/// Which demo factory to show without a hub. `full` is the project factory
/// with workflows and runs; `observe` has no projects and only watches T3
/// Code sessions and subscriptions on two Macs. Chosen with the UserDefaults
/// key `perpeto.demo` (`-perpeto.demo observe` at launch, or Settings).
public enum DemoScenario: String, CaseIterable, Sendable, Identifiable {
    case full, observe

    public static let defaultsKey = "perpeto.demo"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .full: "Full factory"
        case .observe: "Observe only"
        }
    }

    public static var current: DemoScenario {
        UserDefaults.standard.string(forKey: defaultsKey).flatMap(DemoScenario.init(rawValue:)) ?? .full
    }
}

/// Observed T3 Code sessions and subscriptions, mirroring the web demo.
/// Two machines: this Mac and a
/// Mac mini. Four sessions run (one with subagents), one waits for the
/// owner, one failed, the rest are idle. Times are relative to `now`.
public enum DemoObserve {
    public static let macId = "mch_macbook"
    public static let miniId = "mch_macmini"
    static let macName = "justus-macbook-pro"
    static let miniName = "mac-mini"

    public static func machines(now: Date) -> [Machine] {
        [
            Machine(id: macId, name: macName, os: "darwin", arch: "arm64", labels: ["this-mac"], providers: ["claudeAgent", "codex"],
                    capacity: .init(maxAgents: 0, maxJobs: 0), running: .init(agents: 3, jobs: 0), status: .online,
                    lastHeartbeatAt: now.addingTimeInterval(-6), version: "0.4.0"),
            Machine(id: miniId, name: miniName, os: "darwin", arch: "arm64", labels: [], providers: ["claudeAgent", "codex"],
                    capacity: .init(maxAgents: 0, maxJobs: 0), running: .init(agents: 1, jobs: 0), status: .online,
                    lastHeartbeatAt: now.addingTimeInterval(-11), version: "0.4.0"),
        ]
    }

    struct Spec {
        var id: String
        var machine: Int
        var title: String?
        var project: String?
        var branch: String?
        var provider: String
        var model: String
        var status: ObservedSession.Status
        var parent: String? = nil
        var children = 0
        /// Minutes ago.
        var created: Double
        var active: Double
        var turns: Int
        /// Thousands of input and output tokens, and cache reads.
        var input: Int
        var output: Int
        var cache: Int
    }

    static let specs: [Spec] = [
        Spec(id: "ses_obs01", machine: 0, title: "Observe-only sessions view for the web app", project: "perpeto", branch: "feat/observe-sessions",
             provider: "claudeAgent", model: "claude-opus-5-5", status: .running, children: 3, created: 42, active: 0.2, turns: 31, input: 184, output: 46, cache: 3_120),
        Spec(id: "ses_obs01a", machine: 0, title: "Decode the sessions contract", project: "perpeto", branch: "feat/observe-sessions",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .running, parent: "ses_obs01", created: 11, active: 0.4, turns: 9, input: 38, output: 12, cache: 410),
        Spec(id: "ses_obs01b", machine: 0, title: "Write Swift decoding tests", project: "perpeto", branch: "feat/observe-sessions",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .idle, parent: "ses_obs01", created: 27, active: 14, turns: 7, input: 29, output: 9, cache: 260),
        Spec(id: "ses_obs01c", machine: 0, title: "Check dark mode contrast", project: "perpeto", branch: "feat/observe-sessions",
             provider: "claudeAgent", model: "claude-haiku-5-5", status: .idle, parent: "ses_obs01", created: 33, active: 21, turns: 4, input: 12, output: 3, cache: 90),
        Spec(id: "ses_obs02", machine: 0, title: "Migrate billing webhooks to Stripe v2", project: "lumin-web", branch: "fix/stripe-webhooks",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .waiting, created: 78, active: 3, turns: 22, input: 96, output: 31, cache: 1_480),
        Spec(id: "ses_obs03", machine: 0, title: "Speed up event stream reconnects", project: "perpeto", branch: "perf/sse-reconnect",
             provider: "codex", model: "gpt-5.5-codex", status: .running, created: 18, active: 0.5, turns: 12, input: 61, output: 18, cache: 520),
        Spec(id: "ses_obs04", machine: 1, title: "Nightly dependency upgrades", project: "lumin-api", branch: "chore/deps-oct",
             provider: "codex", model: "gpt-5.5-codex", status: .running, created: 65, active: 1, turns: 27, input: 142, output: 37, cache: 1_960),
        Spec(id: "ses_obs05", machine: 1, title: "Generate iOS simulator screenshots", project: "perpeto", branch: "chore/ios-shots",
             provider: "codex", model: "gpt-5.5", status: .error, created: 54, active: 26, turns: 8, input: 22, output: 6, cache: 140),
        Spec(id: "ses_obs06", machine: 1, title: "Draft onboarding email copy", project: "lumin-marketing", branch: "main",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .idle, created: 95, active: 40, turns: 14, input: 41, output: 22, cache: 380),
        Spec(id: "ses_obs07", machine: 0, title: "Fix the flaky merge queue test", project: "perpeto", branch: "fix/merge-queue-flake",
             provider: "claudeAgent", model: "claude-opus-5-5", status: .idle, created: 260, active: 130, turns: 19, input: 88, output: 24, cache: 1_210),
        Spec(id: "ses_obs08", machine: 0, title: "Explain the pacing maths", project: nil, branch: nil,
             provider: "claudeAgent", model: "claude-opus-5-5", status: .idle, created: 400, active: 310, turns: 6, input: 17, output: 9, cache: 120),
        Spec(id: "ses_obs09", machine: 1, title: "Refactor auth middleware", project: "lumin-api", branch: "refactor/auth-mw",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .idle, created: 520, active: 300, turns: 25, input: 103, output: 29, cache: 1_640),
        Spec(id: "ses_obs10", machine: 1, title: nil, project: "lumin-web", branch: "main",
             provider: "claudeAgent", model: "claude-sonnet-5-5", status: .idle, created: 1_700, active: 1_440, turns: 2, input: 5, output: 1, cache: 30),
    ]

    public static func sessions(now: Date, machines: [(id: String, name: String)]? = nil) -> [ObservedSession] {
        let hosts = machines ?? [(macId, macName), (miniId, miniName)]
        func ago(_ mins: Double) -> Date { now.addingTimeInterval(-mins * 60) }
        return specs.map { s in
            let host = hosts[min(s.machine, hosts.count - 1)]
            return ObservedSession(
                id: s.id, machineId: host.id, machineName: host.name, threadId: "thr_" + s.id.dropFirst(4),
                title: s.title, project: s.project.map { .init(name: $0, path: "~/Developer/\($0)") }, branch: s.branch,
                provider: s.provider, providerInstanceId: s.provider == "codex" ? "codex-default" : "claude-default", model: s.model, status: s.status,
                parentThreadId: s.parent.map { "thr_" + $0.dropFirst(4) }, childCount: s.children,
                createdAt: ago(s.created), lastActivityAt: ago(s.active), turns: s.turns,
                tokens: SessionTokens(input: s.input * 1000, output: s.output * 1000, cacheRead: s.cache * 1000, cacheWrite: s.cache * 60, reasoning: s.output * 300))
        }
    }

    /// Hourly input and output over the last day: quiet overnight, busy in the
    /// afternoon. Deterministic so screenshots are stable.
    static func series(now: Date, buckets: Int, step: TimeInterval, scale: Double) -> [TokenPoint] {
        let shape: [Double] = [0.1, 0.05, 0.04, 0.03, 0.03, 0.05, 0.12, 0.28, 0.46, 0.62, 0.71, 0.58, 0.5, 0.66, 0.84, 0.92, 1.0, 0.88, 0.7, 0.52, 0.44, 0.61, 0.79, 0.9]
        let end = (now.timeIntervalSinceReferenceDate / step).rounded(.down) * step
        return (0..<buckets).map { i in
            let at = Date(timeIntervalSinceReferenceDate: end - Double(buckets - 1 - i) * step)
            let level = shape[(i + shape.count - buckets % shape.count) % shape.count]
            let input = Int(scale * level * 1000) * 1000
            return TokenPoint(at: at, input: input, output: input / 4)
        }
    }

    public static func summaries(now: Date, sessions: [ObservedSession], machines: [Machine]) -> [SessionWindow: SessionSummary] {
        func count(_ machineId: String, _ status: ObservedSession.Status) -> Int { sessions.filter { $0.machineId == machineId && $0.status == status }.count }
        let observed = machines.map { m in
            ObservedMachine(machineId: m.id, name: m.name, online: m.status == .online, observing: true,
                            lastObservedAt: m.lastHeartbeatAt, running: count(m.id, .running), waiting: count(m.id, .waiting), idle: count(m.id, .idle))
        }
        let totals = SessionSummary.Totals(running: sessions.filter { $0.status == .running }.count, waiting: sessions.filter { $0.status == .waiting }.count,
                                           sessionsActive: sessions.filter { $0.status == .running || $0.status == .waiting }.count)
        func groups(_ key: (ObservedSession) -> String, factor: Double) -> [TokenGroup] {
            Dictionary(grouping: sessions, by: key).map { key, list in
                TokenGroup(key: key, input: Int(Double(list.reduce(0) { $0 + $1.tokens.input }) * factor), output: Int(Double(list.reduce(0) { $0 + $1.tokens.output }) * factor),
                           cacheRead: Int(Double(list.reduce(0) { $0 + $1.tokens.cacheRead }) * factor), cacheWrite: Int(Double(list.reduce(0) { $0 + $1.tokens.cacheWrite }) * factor))
            }
            .sorted { $0.total > $1.total }
        }
        func summary(_ factor: Double, series: [TokenPoint]) -> SessionSummary {
            SessionSummary(machines: observed, totals: totals, tokens: .init(
                byProvider: groups(\.provider, factor: factor), byModel: groups({ $0.model ?? "unknown" }, factor: factor),
                byMachine: groups(\.machineId, factor: factor), series: series))
        }
        return [
            .hour: summary(0.11, series: series(now: now, buckets: 12, step: 300, scale: 18)),
            .day: summary(1, series: series(now: now, buckets: 24, step: 3600, scale: 62)),
            .week: summary(5.4, series: series(now: now, buckets: 28, step: 6 * 3600, scale: 330)),
        ]
    }

    public static func observed(now: Date, machines: [Machine]) -> ObservedSessions {
        let list = sessions(now: now, machines: machines.prefix(2).map { ($0.id, $0.name) })
        return ObservedSessions(sessions: list, summaries: summaries(now: now, sessions: list, machines: Array(machines.prefix(2))))
    }

    // MARK: Subscriptions

    public static func accounts(now: Date) -> [Account] {
        func window(_ kind: UsageWindowKind, _ used: Double, resetIn mins: Double) -> UsageWindow {
            UsageWindow(id: kind.rawValue, kind: kind, label: kind.defaultLabel, usedPercent: used, resetsAt: now.addingTimeInterval(mins * 60),
                        windowMins: kind == .session ? 300 : 7 * 24 * 60)
        }
        return [
            Account(id: "acct_obs_claude", machineId: macId, provider: "claudeAgent", label: "Claude Max", status: .active, lastUsedAt: now.addingTimeInterval(-12),
                    plan: "Max 20x", usage: AccountUsage(checkedAt: now.addingTimeInterval(-45), windows: [window(.session, 46, resetIn: 130), window(.weekly, 58, resetIn: 4_560)]),
                    source: "observed"),
            Account(id: "acct_obs_chatgpt", machineId: miniId, provider: "codex", label: "ChatGPT Pro", status: .active, lastUsedAt: now.addingTimeInterval(-60),
                    plan: "Pro", usage: AccountUsage(checkedAt: now.addingTimeInterval(-70), windows: [window(.session, 22, resetIn: 220), window(.weekly, 41, resetIn: 5_880)]),
                    source: "observed"),
        ]
    }

    /// Advice-mode pacing: nothing is enforced; projections at the current
    /// pace and about how many more agents each subscription could take.
    public static func pacing(now: Date) -> Pacing {
        func window(_ kind: UsageWindowKind, _ used: Double, resetIn mins: Double, projected: Double) -> PacingWindow {
            PacingWindow(id: kind.rawValue, kind: kind, label: kind.defaultLabel, usedPercent: used, resetsAt: now.addingTimeInterval(mins * 60),
                         projectedPercentAtReset: projected, onTrack: .under)
        }
        return Pacing(
            mode: .advise, enabled: false, strategy: .unknown, targetUsePercent: 95, updatedAt: now.addingTimeInterval(-60),
            providers: [
                PacingProvider(provider: "claudeAgent", targetAgents: 0, runningAgents: 2, slots: 0, readyWork: 0, limitedBy: .unknown, starved: false),
                PacingProvider(provider: "codex", targetAgents: 0, runningAgents: 2, slots: 0, readyWork: 0, limitedBy: .unknown, starved: false),
            ],
            accounts: [
                PacingAccount(accountId: "acct_obs_claude", machineId: macId, provider: "claudeAgent", label: "Claude Max", plan: "Max 20x", state: .unknown,
                              targetAgents: 0, runningAgents: 2, burnPerAgentHour: 6.2,
                              windows: [window(.session, 46, resetIn: 130, projected: 71), window(.weekly, 58, resetIn: 4_560, projected: 82)], headroomAgents: 3),
                PacingAccount(accountId: "acct_obs_chatgpt", machineId: miniId, provider: "codex", label: "ChatGPT Pro", plan: "Pro", state: .unknown,
                              targetAgents: 0, runningAgents: 2, burnPerAgentHour: 4.1,
                              windows: [window(.session, 22, resetIn: 220, projected: 48), window(.weekly, 41, resetIn: 5_880, projected: 61)], headroomAgents: 2),
            ],
            timeline: [])
    }

    /// The observe-only factory: no projects, two Macs, observed sessions and subscriptions.
    public static func factory(now: Date) -> FactoryState {
        let machines = machines(now: now)
        let observed = observed(now: now, machines: machines)
        return FactoryState(
            projects: [], machines: machines, accounts: accounts(now: now), jobs: [],
            overview: FactoryOverview(activeAgents: observed.running, queuedWork: 0, tokensToday: observed.summary(.day)?.tokens.total ?? 0,
                                      machinesOnline: machines.count, owner: OwnerProfile(name: "Justus", initials: "JH")),
            usage: .empty, pacing: pacing(now: now), sessions: observed)
    }
}
