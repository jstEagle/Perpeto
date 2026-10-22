import Foundation

/// Display names for model IDs: "claude-opus-5-5" → "Claude Opus 5.5",
/// "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5", "gpt-5.5-codex" →
/// "GPT-5.5 Codex". Anything else is shown as sent.
public enum ModelName {
    public static func display(_ id: String) -> String {
        let raw = id.trimmingCharacters(in: .whitespaces)
        let lower = raw.lowercased()
        var parts = lower.split(separator: "-").map(String.init)
        guard let family = parts.first, ["claude", "gpt", "o3", "o4"].contains(family) || family.hasPrefix("gpt") else { return raw }
        // A trailing date stamp ("20250929") or "latest" is not part of the name.
        if let last = parts.last, (last.count == 8 && Int(last) != nil) || last == "latest" { parts.removeLast() }
        if family == "claude" {
            var words = ["Claude"]
            var numbers: [String] = []
            for part in parts.dropFirst() {
                if Int(part) != nil { numbers.append(part) } else {
                    if !numbers.isEmpty { words.append(numbers.joined(separator: ".")); numbers = [] }
                    words.append(part.prefix(1).uppercased() + part.dropFirst())
                }
            }
            if !numbers.isEmpty { words.append(numbers.joined(separator: ".")) }
            // "claude-3-5-sonnet" style puts the version first; keep it readable either way.
            return words.joined(separator: " ")
        }
        if family == "gpt", parts.count >= 2 {
            let version = parts[1]
            let rest = parts.dropFirst(2).map { $0 == "mini" || $0 == "nano" ? $0 : $0.prefix(1).uppercased() + $0.dropFirst() }
            return (["GPT-" + version] + rest).joined(separator: " ")
        }
        return raw
    }
}

/// Words for observed sessions, kept in step with the web app.
public enum SessionText {
    public static func statusLabel(_ status: ObservedSession.Status) -> String {
        switch status {
        case .running: "Running"
        case .waiting: "Waiting for you"
        case .idle: "Idle"
        case .error: "Error"
        case .unknown: "Not reported"
        }
    }

    public static func title(_ session: ObservedSession) -> String { session.title ?? "Untitled session" }

    /// "42 min", "3 h", "2 d": coarse, for lists that update.
    public static func ago(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 60 else { return "under a minute" }
        let mins = Int((seconds / 60).rounded())
        if mins < 60 { return "\(mins) min" }
        let hours = seconds / 3600
        if hours < 10 {
            let h = Int(hours), m = mins - h * 60
            return m >= 5 ? "\(h) h \(m) m" : "\(h) h"
        }
        if hours < 48 { return "\(Int(hours.rounded())) h" }
        return "\(Int((hours / 24).rounded())) d"
    }

    /// Running: how long it has been open. Waiting: how long it has waited.
    /// Idle or failed: when it was last active.
    public static func time(_ session: ObservedSession, now: Date = Date()) -> String {
        switch session.status {
        case .running:
            guard let start = session.createdAt else { return "running" }
            return "for " + ago(now.timeIntervalSince(start))
        case .waiting:
            guard let since = session.lastActivityAt else { return "waiting" }
            return "waiting " + ago(now.timeIntervalSince(since))
        default:
            guard let last = session.lastActivityAt else { return "no activity reported" }
            let gap = now.timeIntervalSince(last)
            return gap < 60 ? "active just now" : "active \(ago(gap)) ago"
        }
    }

    /// "perpeto · feat/observe · Claude Opus 5.5", for the line under a title.
    public static func metaParts(_ session: ObservedSession) -> (project: String?, branch: String?, model: String?) {
        (session.project?.name, session.branch, session.model.map(ModelName.display))
    }

    public static func plural(_ count: Int, _ word: String) -> String { "\(count) \(count == 1 ? word : word + "s")" }
}

/// Sessions with their subagents nested under them.
public struct SessionNode: Hashable, Sendable, Identifiable {
    public var session: ObservedSession
    public var children: [ObservedSession]
    public var id: String { session.id }

    /// The subagent count to show: what the hub counted, or what arrived.
    public var subagents: Int { max(session.childCount, children.count) }

    /// Running, waiting and failed children lift a quiet parent's place in the list.
    public var order: Int { ([session.status.order] + children.map(\.status.order)).min() ?? 4 }

    public func matches(_ status: ObservedSession.Status?) -> Bool {
        guard let status else { return true }
        return session.status == status || children.contains { $0.status == status }
    }
}

public enum SessionTree {
    /// Roots ordered waiting, running, failed, idle, then by latest activity.
    /// A child whose parent is not in the list is shown as a root.
    public static func build(_ sessions: [ObservedSession]) -> [SessionNode] {
        let threads = Set(sessions.map(\.threadId))
        var children: [String: [ObservedSession]] = [:]
        var roots: [ObservedSession] = []
        for s in sessions {
            if let parent = s.parentThreadId, parent != s.threadId, threads.contains(parent) {
                children[parent, default: []].append(s)
            } else {
                roots.append(s)
            }
        }
        let recent: (ObservedSession, ObservedSession) -> Bool = { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
        let byStatus: (ObservedSession, ObservedSession) -> Bool = { $0.status.order != $1.status.order ? $0.status.order < $1.status.order : recent($0, $1) }
        return roots.map { SessionNode(session: $0, children: (children[$0.threadId] ?? []).sorted(by: byStatus)) }
            .sorted { $0.order != $1.order ? $0.order < $1.order : recent($0.session, $1.session) }
    }

    /// Counts per status across every session, subagents included.
    public static func counts(_ sessions: [ObservedSession]) -> [ObservedSession.Status: Int] {
        Dictionary(grouping: sessions, by: \.status).mapValues(\.count)
    }
}

extension PacingText {
    public struct Advice: Hashable, Sendable {
        /// "4 sessions running"
        public var lead: String
        /// "Claude on track for 82% by reset, Codex for 61%" and "room for about 5 more agents".
        public var clauses: [String]
        public var text: String { ([lead] + clauses).joined(separator: " · ") }

        public init(lead: String, clauses: [String]) {
            self.lead = lead
            self.clauses = clauses
        }
    }

    /// The advice headline for observe-only pacing:
    /// "4 sessions running · Claude on track for 82% by reset, Codex for 61% · room for about 5 more agents".
    /// `sessionsRunning` comes from the session summary; without it the
    /// running agents pacing reports are counted instead.
    public static func advice(_ pacing: Pacing, sessionsRunning: Int?) -> Advice {
        let lead = sessionsRunning.map { plural($0, "session") + " running" } ?? plural(runningAgents(pacing), "agent") + " running"
        let order = ["claudeAgent", "codex"]
        var providers: [String] = []
        for a in pacing.accounts where !providers.contains(a.provider) { providers.append(a.provider) }
        providers.sort { (order.firstIndex(of: $0) ?? order.count, $0) < (order.firstIndex(of: $1) ?? order.count, $1) }
        var over: [String] = []
        var on: [(String, Int)] = []
        for provider in providers {
            let windows = pacing.accounts.filter { $0.provider == provider }.flatMap(\.windows)
            guard let top = windows.map(\.projectedPercentAtReset).max() else { continue }
            if windows.contains(where: { $0.onTrack == .over }) { over.append(providerName(provider)) } else { on.append((providerName(provider), Int(top.rounded()))) }
        }
        var tracks = over.map { "\($0) runs out before reset" }
        for (i, item) in on.enumerated() {
            tracks.append(i == 0 ? "\(item.0) on track for \(item.1)% by reset" : "\(item.0) for \(item.1)%")
        }
        var clauses: [String] = []
        if !tracks.isEmpty { clauses.append(tracks.joined(separator: ", ")) }
        let reported = pacing.accounts.compactMap(\.headroomAgents)
        if !reported.isEmpty {
            let room = reported.reduce(0, +)
            clauses.append(room == 0 ? "no room for more agents" : "room for about \(room) more \(room == 1 ? "agent" : "agents")")
        }
        return Advice(lead: lead, clauses: clauses)
    }

    /// "Room for about 3 more agents" for one subscription.
    public static func headroom(_ agents: Int?) -> String? {
        guard let agents else { return nil }
        return agents == 0 ? "No room for more agents" : "Room for about \(agents) more \(agents == 1 ? "agent" : "agents")"
    }

    static func providerName(_ id: String) -> String {
        switch id {
        case "claudeAgent": "Claude"
        case "codex": "Codex"
        default: id
        }
    }
}
