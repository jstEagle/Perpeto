import PerpetoKit
import SwiftUI

/// Subscription pacing: one sentence on where it stands, what limits the
/// pace, the rotation for the next ten hours, the projection per
/// subscription, and the three settings.
struct PacingScreen: View {
    var store: FactoryStore
    @Environment(\.compactLayout) private var compact

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                let advisory = store.factory.pacing?.isAdvisory == true
                ScreenHeader("Pacing", subtitle: advisory
                             ? "How each subscription is tracking toward its reset at the current pace, and about how many more agents it could take."
                             : "Perpeto scales the agents it runs so every subscription’s limit is used up by the time it resets, without downtime or unused tokens.")
                if let pacing = store.factory.pacing, pacing.isAdvisory {
                    adviceHero(pacing).card()
                    projections(pacing).card()
                } else if let pacing = store.factory.pacing {
                    hero(pacing).card()
                    AdaptiveColumns(sideWidth: 340) {
                        projections(pacing).card()
                    } side: {
                        PacingSettingsCard(pacing: pacing) { await store.updatePacing($0) }.card()
                    }
                } else {
                    EmptyState("This hub doesn’t pace subscriptions yet", message: "Update the hub to a version with pacing. Until then, each machine runs agents up to its own slots.", systemImage: FactorySection.pacing.systemImage)
                        .card()
                }
            }
            .screenPadding()
        }
    }

    /// Observe-only: the advice sentence, one line saying nothing is enforced,
    /// and the room each subscription has, in place of the rotation and settings.
    private func adviceHero(_ pacing: Pacing) -> some View {
        let advice = PacingText.advice(pacing, sessionsRunning: store.factory.sessions?.running)
        let size = compact ? PerpetoType.text20 : PerpetoType.text24
        var text = AttributedString(advice.lead)
        text.foregroundColor = PerpetoColor.ink
        text.font = PerpetoType.title(size)
        if !advice.clauses.isEmpty {
            var rest = AttributedString(" · " + advice.clauses.joined(separator: " · "))
            rest.foregroundColor = PerpetoColor.muted
            rest.font = PerpetoType.text(size)
            text += rest
        }
        let rooms = pacing.accounts.filter { $0.headroomAgents != nil }.prefix(3)
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(7)) {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                Text(text)
                    .tracking(PerpetoType.tracking(forHeading: size))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 760, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Text("Perpeto is only observing, so nothing is enforced. Numbers are advice.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
            if !rooms.isEmpty {
                FigureStrip(rooms.map { account in
                    let room = account.headroomAgents ?? 0
                    return Figure("\(account.label) · room for more agents", value: "\(room)", unit: room == 1 ? "agent" : "agents")
                })
                .frame(maxWidth: 760, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hero(_ pacing: Pacing) -> some View {
        let headline = PacingText.headline(pacing)
        var text = AttributedString(headline.lead)
        text.foregroundColor = PerpetoColor.ink
        text.font = PerpetoType.title(compact ? PerpetoType.text20 : PerpetoType.text24)
        var rest = AttributedString(" · " + headline.detail)
        rest.foregroundColor = PerpetoColor.muted
        rest.font = PerpetoType.text(compact ? PerpetoType.text20 : PerpetoType.text24)
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
            Text(text + rest)
                .tracking(PerpetoType.tracking(forHeading: PerpetoType.text24))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 720, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if !pacing.providers.isEmpty {
                let facts = ForEach(pacing.providers) { provider in
                    HStack(spacing: PerpetoSpacing.x(3)) {
                        Text(Format.provider(provider.provider)).font(PerpetoType.text(PerpetoType.text13, weight: .semibold)).foregroundStyle(PerpetoColor.ink)
                        if provider.starved || provider.limitedBy == .work {
                            StatusLabel(PacingText.limitedBy(provider), tone: .warning)
                        } else {
                            Text(PacingText.limitedBy(provider)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.inkSoft)
                        }
                        Text("\(provider.runningAgents) of \(Format.plural(provider.targetAgents, "agent")) · \(Format.plural(provider.readyWork, "item")) ready")
                            .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                    }
                }
                if compact {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) { facts }
                } else {
                    HStack(spacing: PerpetoSpacing.x(10)) { facts }
                }
            }
            if pacing.enabled && !pacing.timeline.isEmpty {
                PacingTimelineView(pacing: pacing)
                    .padding(.top, PerpetoSpacing.x(2))
            } else {
                Text(pacing.enabled ? "No turns planned yet. The plan appears once subscriptions report their limits." : "Pacing is off, so there is no rotation to show. Turn it on to plan one.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    .padding(.vertical, PerpetoSpacing.x(6))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func projections(_ pacing: Pacing) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Projected at reset", detail: pacing.isAdvisory ? "Session · weekly · room" : "Session · weekly")
                .padding(.bottom, PerpetoSpacing.x(2))
            if pacing.accounts.isEmpty {
                Text("No subscriptions reported yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            }
            RowList(pacing.accounts) { account in
                let track = PacingText.track(account)
                let meta = pacing.isAdvisory ? [account.plan, store.machine(account.machineId)?.name, track == .over ? "runs out early" : nil].compactMap { $0 }.joined(separator: " · ") : [account.plan, track == .under ? "under target" : track == .over ? "runs out early" : nil,
                            account.idleForecastMins > 0 ? "\(Int(account.idleForecastMins)) min idle forecast" : nil].compactMap { $0 }.joined(separator: " · ")
                HStack(spacing: PerpetoSpacing.x(4)) {
                    RowText(account.label, meta: meta.isEmpty ? Format.provider(account.provider) : meta)
                    Spacer(minLength: PerpetoSpacing.x(2))
                    if !compact && !pacing.isAdvisory {
                        StatusLabel(PacingText.stateLabel(account.state), tone: account.state.tone).frame(width: 110, alignment: .leading)
                    }
                    HStack(spacing: PerpetoSpacing.x(4)) {
                        percent(account.windows.first { $0.kind == .session })
                        percent(account.windows.first { $0.kind == .weekly })
                        if pacing.isAdvisory {
                            Text(account.headroomAgents.map { "+\($0)" } ?? "—")
                                .font(PerpetoType.text(PerpetoType.text14, weight: .medium).monospacedDigit())
                                .foregroundStyle(account.headroomAgents == nil ? PerpetoColor.muted : PerpetoColor.ink)
                                .frame(width: 44, alignment: .trailing)
                                .accessibilityLabel(PacingText.headroom(account.headroomAgents) ?? "Room not reported")
                        }
                    }
                }
            }
        }
    }

    private func percent(_ window: PacingWindow?) -> some View {
        Text(window.map { "\(Int($0.projectedPercentAtReset.rounded()))%" } ?? "—")
            .font(PerpetoType.text(PerpetoType.text14, weight: window?.onTrack == .over ? .medium : .regular).monospacedDigit())
            .foregroundStyle(window?.onTrack == .on || window?.onTrack == .over ? PerpetoColor.ink : PerpetoColor.muted)
            .frame(width: 44, alignment: .trailing)
            .accessibilityLabel(window.map { "\($0.label) \(Int($0.projectedPercentAtReset.rounded()))% at reset" } ?? "No limit reported")
    }
}

/// Lanes per subscription: burn turns in ink, rest in a quiet grey, the past
/// a step lighter, a line at now, and the live dot where it crosses the
/// subscription burning now.
struct PacingTimelineView: View {
    var pacing: Pacing
    var now = Date()
    var hoursAhead: Double = 10
    @Environment(\.compactLayout) private var compact

    private let laneHeight: CGFloat = 36
    private let barHeight: CGFloat = 10

    var body: some View {
        let layout = PacingTimelineLayout(pacing, now: now, hoursAhead: hoursAhead)
        let labelWidth: CGFloat = compact ? 104 : 150
        let gap = PerpetoSpacing.x(compact ? 3 : 6)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(layout.groups.enumerated()), id: \.element.id) { index, group in
                    HStack(spacing: gap) {
                        Text(Format.provider(group.provider))
                            .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                            .padding(.top, index == 0 ? 0 : PerpetoSpacing.x(6))
                            .padding(.bottom, PerpetoSpacing.x(2))
                            .frame(width: labelWidth, alignment: .leading)
                        nowLine(layout.now)
                    }
                    ForEach(group.lanes) { lane in
                        HStack(spacing: gap) {
                            Text(lane.account.label)
                                .font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                                .lineLimit(1).truncationMode(.tail)
                                .frame(width: labelWidth, alignment: .leading)
                            track(lane, now: layout.now)
                        }
                        .frame(height: laneHeight)
                    }
                }
            }
            axis(layout, labelWidth: labelWidth, gap: gap)
                .padding(.top, -PerpetoSpacing.x(5))
            HStack(spacing: PerpetoSpacing.x(6)) {
                legend(PerpetoColor.ink, "Burning")
                legend(PerpetoColor.chartQuiet, "Resting until its limit resets")
            }
            .padding(.leading, labelWidth + gap)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary(layout))
    }

    private func track(_ lane: PacingTimelineLayout.Lane, now nowAt: Double) -> some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                ForEach(Array(lane.segments.enumerated()), id: \.offset) { _, segment in
                    // Split at now: what already happened is drawn a step lighter.
                    if segment.end <= nowAt || segment.start >= nowAt {
                        bar(segment.phase, past: segment.end <= nowAt, from: segment.start, to: segment.end, width: width, joinedLeading: false, joinedTrailing: false)
                    } else {
                        bar(segment.phase, past: true, from: segment.start, to: nowAt, width: width, joinedLeading: false, joinedTrailing: true)
                        bar(segment.phase, past: false, from: nowAt, to: segment.end, width: width, joinedLeading: true, joinedTrailing: false)
                    }
                }
                Rectangle().fill(PerpetoColor.ink).frame(width: 1.5).offset(x: width * nowAt - 0.75)
                if lane.account.state == .burning && lane.segments.contains(where: { $0.phase == .burn && $0.start <= nowAt && $0.end > nowAt }) {
                    LiveDot().position(x: width * nowAt, y: proxy.size.height / 2).zIndex(2)
                }
            }
            .frame(height: proxy.size.height)
        }
    }

    private func bar(_ phase: PacingSegment.Phase, past: Bool, from: Double, to: Double, width: CGFloat, joinedLeading: Bool, joinedTrailing: Bool) -> some View {
        let color = phase == .rest ? PerpetoColor.chartQuiet : past ? PerpetoColor.chart : PerpetoColor.ink
        // A sliver of card between neighbouring turns.
        let inset: CGFloat = 1.5
        let x0 = width * from + (joinedLeading ? 0 : inset)
        let x1 = width * to - (joinedTrailing ? 0 : inset)
        let r = barHeight / 2
        return UnevenRoundedRectangle(topLeadingRadius: joinedLeading ? 0 : r, bottomLeadingRadius: joinedLeading ? 0 : r,
                                      bottomTrailingRadius: joinedTrailing ? 0 : r, topTrailingRadius: joinedTrailing ? 0 : r, style: .continuous)
            .fill(color)
            .frame(width: max(x1 - x0, 1), height: barHeight)
            .offset(x: x0)
    }

    /// Clock times every two hours, and "Now" under the line, which runs on down to it.
    private func axis(_ layout: PacingTimelineLayout, labelWidth: CGFloat, gap: CGFloat) -> some View {
        GeometryReader { proxy in
            let trackWidth = proxy.size.width - labelWidth - gap
            let nowX = labelWidth + gap + trackWidth * layout.now
            ZStack(alignment: .topLeading) {
                Rectangle().fill(PerpetoColor.ink).frame(width: 1.5, height: 10).position(x: nowX, y: 5)
                ForEach(Array(layout.ticks.enumerated()), id: \.offset) { _, tick in
                    Text(tick.date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute()))
                        .font(PerpetoFont.small.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                        .fixedSize()
                        .position(x: labelWidth + gap + trackWidth * tick.at, y: 20)
                }
                Text("Now").font(PerpetoType.text(PerpetoType.text12, weight: .medium)).foregroundStyle(PerpetoColor.ink)
                    .fixedSize()
                    .position(x: nowX, y: 20)
            }
        }
        .frame(height: 28)
    }

    /// The now line through a row without segments, such as a provider heading.
    private func nowLine(_ at: Double) -> some View {
        GeometryReader { proxy in
            Rectangle().fill(PerpetoColor.ink).frame(width: 1.5, height: proxy.size.height).offset(x: proxy.size.width * at - 0.75)
        }
    }

    private func legend(_ color: Color, _ title: String) -> some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            Capsule().fill(color).frame(width: 16, height: 6)
            Text(title).font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted)
        }
    }

    private func summary(_ layout: PacingTimelineLayout) -> String {
        let lanes = layout.groups.flatMap(\.lanes).map { lane -> String in
            guard let next = lane.segments.first(where: { $0.phase == .burn && $0.to > now }) else { return "\(lane.account.label): no turn in the next \(Int(hoursAhead)) hours" }
            let time = { (d: Date) in d.formatted(date: .omitted, time: .shortened) }
            return next.from <= now ? "\(lane.account.label): burning until \(time(next.to))" : "\(lane.account.label): next turn \(time(next.from)) to \(time(next.to))"
        }
        return "Rotation for the next \(Int(hoursAhead)) hours. " + lanes.joined(separator: ". ")
    }
}

/// Pacing on or off, the strategy and the target use, plus agent limits when the hub reports them.
struct PacingSettingsCard: View {
    var pacing: Pacing
    var save: (PacingSettings) async -> Void
    @State private var limitsOpen = false
    @State private var lowest = ""
    @State private var highest = ""

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(7)) {
            SectionTitle("Settings")
            Toggle(isOn: Binding(get: { pacing.enabled }, set: { on in Task { await save(PacingSettings(enabled: on)) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pacing").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    Text("Scale agents to each subscription’s limits. Off, every machine fills its own slots.")
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            .tint(PerpetoColor.ink)

            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                Text("Strategy").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                PillPicker([(Pacing.Strategy.rotation, "Rotation"), (.parallel, "Parallel")],
                           selection: Binding(get: { pacing.strategy == .parallel ? .parallel : .rotation }, set: { s in Task { await save(PacingSettings(strategy: s)) } }))
                Text(pacing.strategy == .parallel
                     ? "Every subscription runs at once, each at the pace its own limits allow."
                     : "One subscription burns at a time, so the first has reset by the time the last one finishes.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                Text("Target use").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                PillPicker(targets.map { ($0, "\($0)%") },
                           selection: Binding(get: { pacing.targetUsePercent }, set: { t in Task { await save(PacingSettings(targetUsePercent: t)) } }))
                Text("How much of each limit to use by its reset. A little headroom absorbs turns that run longer than estimated.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            }

            if let min = pacing.minAgents {
                let max = pacing.maxAgents
                Disclosure(max.map { "Agent limits · \(min) to \($0)" } ?? "Agent limits · at least \(min)", isExpanded: $limitsOpen) {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                        HStack(spacing: PerpetoSpacing.x(4)) {
                            limitField("Fewest agents", text: $lowest, example: "1")
                            limitField("Most agents", text: $highest, example: "No limit")
                        }
                        let a = Int(lowest.trimmingCharacters(in: .whitespaces))
                        let noCap = highest.trimmingCharacters(in: .whitespaces).isEmpty
                        let b = Int(highest.trimmingCharacters(in: .whitespaces))
                        let valid = a.map { $0 >= 0 && (noCap || (b.map { $0 >= 1 && $0 >= a! } ?? false)) } ?? false
                        Text(valid ? "Pacing stays within these across every machine. Leave the most empty for no limit." : "Use whole numbers, with the fewest no more than the most.")
                            .font(PerpetoFont.caption).foregroundStyle(valid ? PerpetoColor.muted : PerpetoColor.error)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Save limits") { Task { await save(PacingSettings(minAgents: a, maxAgents: noCap ? nil : b, removeMaxAgents: noCap)) } }
                            .buttonStyle(.perpetoSecondary).controlSize(.small)
                            .disabled(!valid || (a == min && (noCap ? max == nil : b == max)))
                    }
                }
                .onAppear {
                    lowest = String(min)
                    highest = max.map(String.init) ?? ""
                }
                .onChange(of: pacing.minAgents) { lowest = pacing.minAgents.map(String.init) ?? lowest }
                .onChange(of: pacing.maxAgents) { highest = pacing.maxAgents.map(String.init) ?? "" }
            }
        }
    }

    private var targets: [Int] {
        let base = [90, 95, 100]
        return base.contains(pacing.targetUsePercent) ? base : (base + [pacing.targetUsePercent]).sorted()
    }

    private func limitField(_ title: String, text: Binding<String>, example: String) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            Text(title).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
            TextField(title, text: text, prompt: Text(example)).perpetoField().frame(width: 110).accessibilityLabel(title)
        }
    }
}
