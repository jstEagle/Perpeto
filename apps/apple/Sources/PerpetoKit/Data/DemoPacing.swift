import Foundation

/// Demo subscriptions mid-rotation, mirroring the web demo
/// (`apps/web/src/api/pacing-fixtures.ts`). Five Claude logins share 5-hour
/// session windows: each burns for an hour, starting the moment its own
/// session resets, so the first has reset by the time the fifth finishes.
/// Two Codex logins alternate in 2.5-hour turns; one is short of ready work.
/// Weekly windows sit at varied levels. Times are relative to `now`.
public enum DemoPacing {
    struct WindowSpec {
        var kind: UsageWindowKind
        var used: Double
        /// Minutes from now.
        var resetIn: Double
        var projected: Double
        var track: PacingWindow.OnTrack
    }

    struct Sub {
        var id: String
        var machineId: String
        var provider: String
        var label: String
        var plan: String
        var state: PacingAccount.State
        var agents: Int
        var target: Int
        var burnPerAgentHour: Double?
        var idle: Double
        var session: WindowSpec
        var weekly: WindowSpec
        var windows: [WindowSpec] { [session, weekly] }
    }

    static func on(_ used: Double, _ resetIn: Double, _ projected: Double? = nil) -> WindowSpec {
        WindowSpec(kind: .session, used: used, resetIn: resetIn, projected: projected ?? used, track: .on)
    }

    static func week(_ used: Double, hours: Double, _ projected: Double, _ track: PacingWindow.OnTrack = .on) -> WindowSpec {
        WindowSpec(kind: .weekly, used: used, resetIn: hours * 60, projected: projected, track: track)
    }

    static let studio = DemoFixtures.studioId
    static let linux = DemoFixtures.linuxId

    /// In rotation order per provider.
    static let subs: [Sub] = [
        Sub(id: "acct_c1", machineId: studio, provider: "claudeAgent", label: "Claude · build", plan: "Max 20x", state: .burning, agents: 4, target: 4, burnPerAgentHour: 23.8, idle: 0,
            session: on(55, 265, 95), weekly: week(62, hours: 76, 95)),
        Sub(id: "acct_c2", machineId: studio, provider: "claudeAgent", label: "Claude · personal", plan: "Max 20x", state: .next, agents: 0, target: 0, idle: 0,
            session: on(95, 25), weekly: week(81, hours: 30, 96)),
        Sub(id: "acct_c3", machineId: studio, provider: "claudeAgent", label: "Claude · Lumin 1", plan: "Max 5x", state: .resting, agents: 0, target: 0, idle: 0,
            session: on(94, 85), weekly: week(34, hours: 146, 93)),
        Sub(id: "acct_c4", machineId: linux, provider: "claudeAgent", label: "Claude · Lumin 2", plan: "Max 5x", state: .resting, agents: 0, target: 0, idle: 0,
            session: on(96, 145), weekly: week(88, hours: 14, 97)),
        Sub(id: "acct_c5", machineId: linux, provider: "claudeAgent", label: "Claude · Lumin 3", plan: "Max 5x", state: .resting, agents: 0, target: 0, idle: 0,
            session: on(95, 205), weekly: week(47, hours: 107, 94)),
        Sub(id: "acct_x1", machineId: linux, provider: "codex", label: "ChatGPT · build", plan: "Pro", state: .burning, agents: 1, target: 3, burnPerAgentHour: 30.4, idle: 35,
            session: WindowSpec(kind: .session, used: 38, resetIn: 240, projected: 78, track: .under), weekly: week(55, hours: 57, 84, .under)),
        Sub(id: "acct_x2", machineId: studio, provider: "codex", label: "ChatGPT · Lumin", plan: "Pro", state: .resting, agents: 0, target: 0, idle: 0,
            session: on(93, 90), weekly: week(40, hours: 120, 92)),
    ]

    static let windowMins: [UsageWindowKind: Double] = [.session: 300, .weekly: 7 * 24 * 60]

    public static func accounts(now: Date) -> [Account] {
        subs.map { s in
            Account(
                id: s.id, machineId: s.machineId, provider: s.provider, label: s.label, status: .active,
                lastUsedAt: now.addingTimeInterval(s.state == .burning ? -20 : -(300 - s.session.resetIn) * 60), plan: s.plan,
                usage: AccountUsage(checkedAt: now.addingTimeInterval(-40), windows: s.windows.map {
                    UsageWindow(id: $0.kind.rawValue, kind: $0.kind, label: $0.kind.defaultLabel, usedPercent: $0.used,
                                resetsAt: now.addingTimeInterval($0.resetIn * 60), windowMins: windowMins[$0.kind])
                }))
        }
    }

    public static let defaultSettings = PacingSettings(enabled: true, strategy: .rotation, targetUsePercent: 95, minAgents: 1, maxAgents: 12)

    /// Burn turns of `burnMins` handed round `ids`, the first starting `firstStart` minutes from now.
    static func rotation(_ ids: [String], firstStart: Double, burnMins: Double, now: Date, from: Double, to: Double) -> [PacingSegment] {
        let cycle = Double(ids.count) * burnMins
        func at(_ mins: Double) -> Date { now.addingTimeInterval(mins * 60) }
        var segments: [PacingSegment] = []
        for (i, id) in ids.enumerated() {
            var t = firstStart + Double(i) * burnMins
            while t > from { t -= cycle }
            var cursor = from
            while t < to {
                if t + burnMins > from {
                    if t > cursor { segments.append(PacingSegment(accountId: id, from: at(cursor), to: at(t), phase: .rest)) }
                    segments.append(PacingSegment(accountId: id, from: at(max(t, from)), to: at(min(t + burnMins, to)), phase: .burn))
                    cursor = t + burnMins
                }
                t += cycle
            }
            if cursor < to { segments.append(PacingSegment(accountId: id, from: at(cursor), to: at(to), phase: .rest)) }
        }
        return segments
    }

    /// The plan the demo hub reports for these settings. Rotation burns one
    /// login per provider at a time; parallel spreads one agent across each.
    /// Projections of on-track windows follow the target.
    public static func pacing(now: Date, settings: PacingSettings = defaultSettings, labels: [String: (label: String, plan: String?)] = [:]) -> Pacing {
        let enabled = settings.enabled ?? true
        let parallel = settings.strategy == .parallel
        let target = Double(settings.targetUsePercent ?? 95)
        let nudge: [Double] = [0, 1, -1, 1, 0, 0, -1]
        let accounts = subs.enumerated().map { i, s in
            let agents = !enabled ? 0 : parallel ? 1 : s.agents
            func projected(_ w: WindowSpec) -> Double {
                let value = w.track == .on && (w.kind == .weekly || s.state == .burning) ? target + nudge[i] : w.projected
                return min(100, max(w.used, value))
            }
            return PacingAccount(
                accountId: s.id, machineId: s.machineId, provider: s.provider, label: labels[s.id]?.label ?? s.label, plan: labels[s.id]?.plan ?? s.plan,
                state: !enabled ? .unknown : parallel ? .burning : s.state, targetAgents: !enabled ? 0 : parallel ? 1 : s.target, runningAgents: agents,
                burnPerAgentHour: s.burnPerAgentHour,
                windows: s.windows.map {
                    PacingWindow(id: $0.kind.rawValue, kind: $0.kind, label: $0.kind.defaultLabel, usedPercent: $0.used, resetsAt: now.addingTimeInterval($0.resetIn * 60),
                                 projectedPercentAtReset: projected($0), onTrack: enabled ? $0.track : .unknown)
                },
                idleForecastMins: enabled ? s.idle : 0)
        }
        func ids(_ provider: String) -> [String] { subs.filter { $0.provider == provider }.map(\.id) }
        let from: Double = -120, to: Double = 11 * 60
        let timeline: [PacingSegment] = !enabled ? [] : parallel
            ? subs.map { PacingSegment(accountId: $0.id, from: now.addingTimeInterval(from * 60), to: now.addingTimeInterval(to * 60), phase: .burn) }
            : rotation(ids("claudeAgent"), firstStart: -35, burnMins: 60, now: now, from: from, to: to)
                + rotation(ids("codex"), firstStart: -60, burnMins: 150, now: now, from: from, to: to)
        func sum(_ provider: String, _ value: (PacingAccount) -> Int) -> Int { accounts.filter { $0.provider == provider }.reduce(0) { $0 + value($1) } }
        return Pacing(
            enabled: enabled, strategy: settings.strategy ?? .rotation, targetUsePercent: settings.targetUsePercent ?? 95,
            minAgents: settings.minAgents, maxAgents: settings.maxAgents, updatedAt: now.addingTimeInterval(-120),
            providers: [
                PacingProvider(provider: "claudeAgent", targetAgents: sum("claudeAgent", \.targetAgents), runningAgents: sum("claudeAgent", \.runningAgents),
                               slots: 10, readyWork: 9, limitedBy: enabled ? .session : .none, starved: false),
                PacingProvider(provider: "codex", targetAgents: sum("codex", \.targetAgents), runningAgents: sum("codex", \.runningAgents),
                               slots: 10, readyWork: 1, limitedBy: enabled ? .work : .none, starved: enabled),
            ],
            accounts: accounts, timeline: timeline)
    }
}
