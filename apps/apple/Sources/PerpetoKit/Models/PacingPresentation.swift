import Foundation

/// Words and layout for the pacing screens, kept here so they are tested
/// alongside decoding. Mirrors `apps/web/src/lib/pacing.ts`.
public enum PacingText {
    /// A span as people say it: "38 min", "2 h 14 m", "3 d 4 h".
    public static func span(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 60 else { return "under a minute" }
        let mins = Int((seconds / 60).rounded())
        if mins < 60 { return "\(mins) min" }
        if mins < 48 * 60 {
            let h = mins / 60, m = mins % 60
            return m > 0 ? "\(h) h \(m) m" : "\(h) h"
        }
        let d = mins / 1440
        let h = Int((Double(mins % 1440) / 60).rounded())
        return h > 0 ? "\(d) d \(h) h" : "\(d) d"
    }

    /// "resets in 2 h 14 m"; a reset already passed reads as due.
    public static func resetsIn(_ date: Date?, now: Date = Date()) -> String? {
        guard let date else { return nil }
        return date <= now ? "reset due" : "resets in " + span(date.timeIntervalSince(now))
    }

    static func plural(_ count: Int, _ word: String) -> String { "\(count) \(count == 1 ? word : word + "s")" }

    public static func stateLabel(_ state: PacingAccount.State) -> String {
        switch state {
        case .burning: "Burning"
        case .next: "Up next"
        case .resting: "Resting"
        case .cooling: "Cooling down"
        case .exhausted: "Used up"
        case .unknown: "Not paced"
        }
    }

    /// What sets one provider's pace, in words.
    public static func limitedBy(_ provider: PacingProvider) -> String {
        let text: String = switch provider.limitedBy {
        case .weekly: "Held back by weekly limits"
        case .session: "Paced by session limits"
        case .slots: "Capped by machine slots"
        case .work: "Not enough ready work"
        case .none: "Running at target"
        case .unknown: "Limit not reported"
        }
        if provider.starved && provider.limitedBy != .work { return "Not enough ready work, " + text.lowercased() }
        return text
    }

    /// Over if any window overruns; under if none reaches the target; on otherwise.
    public static func track(_ account: PacingAccount) -> PacingWindow.OnTrack {
        let known = account.windows.filter { $0.onTrack != .unknown }
        if known.isEmpty { return .unknown }
        if known.contains(where: { $0.onTrack == .over }) { return .over }
        if known.allSatisfy({ $0.onTrack == .under }) { return .under }
        return .on
    }

    public static func runningAgents(_ pacing: Pacing) -> Int {
        pacing.providers.isEmpty ? pacing.accounts.reduce(0) { $0 + $1.runningAgents } : pacing.providers.reduce(0) { $0 + $1.runningAgents }
    }

    /// "5 agents running" and "on track to use 95% of every subscription by its reset".
    public static func headline(_ pacing: Pacing) -> (lead: String, detail: String) {
        let lead = plural(runningAgents(pacing), "agent") + " running"
        guard pacing.enabled else { return (lead, "pacing is off, so each machine fills its own slots") }
        let tracked = pacing.accounts.map(track).filter { $0 != .unknown }
        guard !tracked.isEmpty else { return (lead, "no subscription has reported its limits yet") }
        let over = tracked.filter { $0 == .over }.count
        let under = tracked.filter { $0 == .under }.count
        let target = "\(pacing.targetUsePercent)%"
        if over > 0 { return (lead, "\(plural(over, "subscription")) will run out before \(over == 1 ? "its" : "their") reset") }
        if under > 0 { return (lead, "\(tracked.count - under) of \(plural(tracked.count, "subscription")) on track for \(target) by their reset") }
        return (lead, "on track to use \(target) of every subscription by its reset")
    }

    /// "95% at reset", or "runs out before reset" when it overruns.
    public static func projection(_ window: MeterWindow) -> String? {
        guard let projected = window.projectedPercentAtReset else { return nil }
        if window.onTrack == .over { return "runs out before reset" }
        return "\(Int(projected.rounded()))% at reset"
    }

    /// When an account's next burn turn starts, if one is planned after `now`.
    public static func nextTurn(_ accountId: String, in pacing: Pacing, after now: Date) -> Date? {
        pacing.timeline.filter { $0.accountId == accountId && $0.phase == .burn && $0.from > now }.map(\.from).min()
    }
}

/// A usage window with the hub's projection, where pacing has one.
public struct MeterWindow: Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var projectedPercentAtReset: Double?
    public var onTrack: PacingWindow.OnTrack?

    public init(id: String, label: String, usedPercent: Double, resetsAt: Date? = nil, projectedPercentAtReset: Double? = nil, onTrack: PacingWindow.OnTrack? = nil) {
        self.id = id
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.projectedPercentAtReset = projectedPercentAtReset
        self.onTrack = onTrack
    }

    /// Heartbeat windows, session first, with projections merged in by id;
    /// pacing windows the heartbeat has not carried yet are added.
    public static func merge(_ account: Account, _ paced: PacingAccount?) -> [MeterWindow] {
        let own = (account.usage?.windows ?? []).sorted { $0.kind.order < $1.kind.order }
        let projected = Dictionary((paced?.windows ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var merged = own.map { w in
            MeterWindow(id: w.id, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt,
                        projectedPercentAtReset: projected[w.id]?.projectedPercentAtReset, onTrack: projected[w.id]?.onTrack)
        }
        for p in (paced?.windows ?? []).sorted(by: { $0.kind.order < $1.kind.order }) where !own.contains(where: { $0.id == p.id }) {
            merged.append(MeterWindow(id: p.id, label: p.label, usedPercent: p.usedPercent, resetsAt: p.resetsAt, projectedPercentAtReset: p.projectedPercentAtReset, onTrack: p.onTrack))
        }
        return merged
    }
}

/// The rotation timeline laid out as fractions of its width.
public struct PacingTimelineLayout: Sendable {
    public struct Segment: Hashable, Sendable {
        public var phase: PacingSegment.Phase
        public var start: Double
        public var end: Double
        public var from: Date
        public var to: Date
    }

    public struct Lane: Identifiable, Sendable {
        public var account: PacingAccount
        public var segments: [Segment]
        public var id: String { account.accountId }
    }

    public struct Group: Identifiable, Sendable {
        public var provider: String
        public var lanes: [Lane]
        public var id: String { provider }
    }

    public var start: Date
    public var end: Date
    /// Position of now, 0 to 1.
    public var now: Double
    public var groups: [Group]
    public var ticks: [(date: Date, at: Double)]

    /// From `hoursBefore` before now to `hoursAhead` after. Lanes are grouped
    /// by provider and ordered by their next burn, so a rotation reads as a staircase.
    public init(_ pacing: Pacing, now: Date = Date(), hoursAhead: Double = 10, hoursBefore: Double = 1) {
        let start = now.addingTimeInterval(-hoursBefore * 3600)
        let end = now.addingTimeInterval(hoursAhead * 3600)
        let total = end.timeIntervalSince(start)
        func pos(_ date: Date) -> Double { min(max(date.timeIntervalSince(start) / total, 0), 1) }
        self.start = start
        self.end = end
        self.now = pos(now)
        let lanes = pacing.accounts.map { account in
            Lane(account: account, segments: pacing.timeline
                .filter { $0.accountId == account.accountId && $0.to > start && $0.from < end }
                .sorted { $0.from < $1.from }
                .map { Segment(phase: $0.phase, start: pos($0.from), end: pos($0.to), from: $0.from, to: $0.to) })
        }
        func nextBurn(_ lane: Lane) -> Date { lane.segments.first { $0.phase == .burn && $0.to > now }?.from ?? .distantFuture }
        var order: [String] = []
        for provider in pacing.providers.map(\.provider) + pacing.accounts.map(\.provider) where !order.contains(provider) { order.append(provider) }
        groups = order.compactMap { provider in
            let group = lanes.filter { $0.account.provider == provider }
                .sorted { (nextBurn($0), $0.account.label) < (nextBurn($1), $1.account.label) }
            return group.isEmpty ? nil : Group(provider: provider, lanes: group)
        }
        var ticks: [(Date, Double)] = []
        let step: TimeInterval = 2 * 3600
        var t = (start.timeIntervalSinceReferenceDate / step).rounded(.up) * step
        while t <= end.timeIntervalSinceReferenceDate {
            let date = Date(timeIntervalSinceReferenceDate: t)
            if abs(date.timeIntervalSince(now)) >= 0.6 * 3600 && pos(date) <= 0.97 { ticks.append((date, pos(date))) }
            t += step
        }
        self.ticks = ticks
    }
}
