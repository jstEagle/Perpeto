import PerpetoKit
import SwiftUI

// Observe-only screens: the T3 Code sessions on each machine and a home that
// is about the factory. Perpeto only watches here; nothing changes a session.

extension ObservedSession.Status {
    /// Running is the live dot; waiting for the owner is the filled triangle in
    /// medium weight; failures are red; idle is a quiet outline.
    var tone: StatusTone {
        switch self {
        case .running: .running
        case .waiting: .approval
        case .error: .error
        case .idle, .unknown: .neutral
        }
    }
}

/// "This Mac" beside the machine the app runs on. Demo machines carry a
/// `this-mac` label; a hub's machines match by host name.
enum ThisMachine {
    static func matches(name: String, labels: [String]) -> Bool {
        if labels.contains("this-mac") { return true }
        #if os(macOS)
        let host = normalized(ProcessInfo.processInfo.hostName.replacingOccurrences(of: ".local", with: ""))
        let local = normalized(Host.current().localizedName ?? "")
        let candidate = normalized(name)
        return !candidate.isEmpty && (candidate == host || candidate == local)
        #else
        return false
        #endif
    }

    private static func normalized(_ s: String) -> String {
        s.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
            .split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
    }
}

// MARK: Rows

/// One session: status, title and where it runs, how long, and its size.
struct SessionRow: View {
    var session: ObservedSession
    var nested = false
    var showMachine = false
    var now = Date()
    @Environment(\.compactLayout) private var compact

    var body: some View {
        if compact {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
                    title
                    Spacer(minLength: PerpetoSpacing.x(2))
                    tokens
                }
                meta
                HStack(spacing: PerpetoSpacing.x(3)) {
                    StatusLabel(SessionText.statusLabel(session.status), tone: session.status.tone)
                    Text(SessionText.time(session, now: now) + " · " + SessionText.plural(session.turns, "turn"))
                        .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                }
            }
        } else {
            HStack(alignment: .center, spacing: PerpetoSpacing.x(6)) {
                VStack(alignment: .leading, spacing: 3) {
                    title
                    meta
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 3) {
                    StatusLabel(SessionText.statusLabel(session.status), tone: session.status.tone)
                    Text(SessionText.time(session, now: now)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                        .lineLimit(1).padding(.leading, PerpetoIcon.small + PerpetoSpacing.x(2))
                }
                .frame(width: 168, alignment: .leading)
                VStack(alignment: .trailing, spacing: 3) {
                    tokens
                    Text(SessionText.plural(session.turns, "turn")).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                }
                .frame(width: 84, alignment: .trailing)
            }
        }
    }

    private var title: some View {
        Text(SessionText.title(session))
            .font(PerpetoType.text(nested ? PerpetoType.text13 : PerpetoType.text14, weight: .medium))
            .foregroundStyle(session.title == nil ? PerpetoColor.muted : PerpetoColor.ink)
            .lineLimit(1)
    }

    private var tokens: some View {
        Text(Format.tokens(session.tokens.total))
            .font(PerpetoType.text(PerpetoType.text14, weight: .medium).monospacedDigit())
            .foregroundStyle(PerpetoColor.ink)
            .accessibilityLabel("\(Format.tokens(session.tokens.total)) tokens")
    }

    private var meta: some View {
        let parts = SessionText.metaParts(session)
        return HStack(spacing: 0) {
            if showMachine {
                Mono(session.machineName, size: PerpetoType.text12)
                if parts.project != nil || parts.branch != nil || parts.model != nil { dot }
            }
            if let project = parts.project {
                Text(project).foregroundStyle(PerpetoColor.inkSoft)
                if parts.branch != nil || parts.model != nil { dot }
            }
            if let branch = parts.branch, !showMachine, !compact || parts.project == nil {
                Mono(branch, size: PerpetoType.text12)
                if parts.model != nil { dot }
            }
            if let model = parts.model { Text(model) }
            if parts.project == nil && parts.branch == nil && parts.model == nil && !showMachine { Text(Format.provider(session.provider)) }
        }
        .font(PerpetoFont.caption)
        .foregroundStyle(PerpetoColor.muted)
        .lineLimit(1)
    }

    private var dot: some View { Text(" · ") }
}

/// A session with its subagents behind a disclosure.
struct SessionTreeRow: View {
    var node: SessionNode
    var showMachine = false
    var now = Date()
    @State private var open: Bool

    /// Subagents that are working or waiting start expanded; finished ones stay folded.
    init(node: SessionNode, showMachine: Bool = false, now: Date = Date()) {
        self.node = node
        self.showMachine = showMachine
        self.now = now
        _open = State(initialValue: node.children.contains { $0.status == .running || $0.status == .waiting })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SessionRow(session: node.session, showMachine: showMachine, now: now)
            if node.subagents > 0 {
                if node.children.isEmpty {
                    Text(SessionText.plural(node.subagents, "subagent")).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                } else {
                    Disclosure(label, isExpanded: $open) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(node.children.enumerated()), id: \.element.id) { index, child in
                                if index > 0 { Rule() }
                                SessionRow(session: child, nested: true, now: now).padding(.vertical, PerpetoSpacing.x(3))
                            }
                        }
                        .padding(.leading, PerpetoSpacing.x(5))
                        .overlay(alignment: .leading) {
                            Rectangle().fill(PerpetoColor.border).frame(width: PerpetoStroke.hairline * 2)
                        }
                    }
                }
            }
        }
    }

    private var label: String {
        let running = node.children.filter { $0.status == .running }.count
        let waiting = node.children.filter { $0.status == .waiting }.count
        var text = SessionText.plural(node.subagents, "subagent")
        if waiting > 0 { text += " · \(waiting) waiting" } else if running > 0 { text += " · \(running) running" }
        return text
    }
}

/// One machine: name, whether its node is watching T3 Code, when it was last seen, and its counts.
struct ObservedMachineRow: View {
    var machine: ObservedMachine
    var labels: [String] = []
    var now = Date()
    /// For narrow cards: the status joins the meta lines instead of taking a column.
    var stacked = false
    @Environment(\.compactLayout) private var compact

    var body: some View {
        if stacked {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                IconTile(machine.name.lowercased().contains("mini") ? "macmini" : "laptopcomputer")
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: PerpetoSpacing.x(2)) {
                        Mono(machine.name, color: PerpetoColor.ink, size: PerpetoType.text14)
                        if ThisMachine.matches(name: machine.name, labels: labels) { Tag("This Mac") }
                    }
                    StatusLabel(status).padding(.vertical, 2)
                    Text(counts + " · " + (machine.lastObservedAt.map { "seen " + Format.relative($0, now: now) } ?? "not seen yet"))
                        .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .center, spacing: PerpetoSpacing.x(4)) {
            IconTile(machine.name.lowercased().contains("mini") ? "macmini" : "laptopcomputer")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Mono(machine.name, color: PerpetoColor.ink, size: PerpetoType.text14)
                    if ThisMachine.matches(name: machine.name, labels: labels) { Tag("This Mac") }
                }
                Text(meta).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
            Spacer(minLength: PerpetoSpacing.x(2))
            if !compact {
                Text(counts).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.inkSoft).lineLimit(1)
                    .frame(minWidth: 120, alignment: .trailing)
            }
            StatusLabel(status).frame(minWidth: 110, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private var status: (String, StatusTone) {
        if !machine.online { return ("Offline", .stopped) }
        return machine.observing ? ("Observing", .ok) : ("Not observing", .warning)
    }

    private var meta: String {
        let seen = machine.lastObservedAt.map { "seen " + Format.relative($0, now: now) } ?? "not seen yet"
        let what = !machine.online ? "Node offline" : machine.observing ? "Watching T3 Code" : "T3 Code not found"
        return compact ? [what, seen, counts].joined(separator: " · ") : what + " · " + seen
    }

    private var counts: String {
        var parts = ["\(machine.running) running"]
        if machine.waiting > 0 { parts.append("\(machine.waiting) waiting") }
        return parts.joined(separator: " · ")
    }
}

// MARK: Sessions

struct SessionsScreen: View {
    var store: FactoryStore
    @State private var filter: Filter = .all
    @State private var machineFilter: String?
    @Environment(\.compactLayout) private var compact

    enum Filter: Hashable {
        case all, status(ObservedSession.Status)
        var status: ObservedSession.Status? {
            if case .status(let s) = self { return s }
            return nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Sessions", subtitle: "Every T3 Code session on your machines. Perpeto only watches; nothing here changes a session.")
                if let observed = store.factory.sessions {
                    content(observed)
                } else {
                    EmptyState("This hub doesn’t observe sessions yet", message: "Update the hub and the node on each machine to a version that watches T3 Code.",
                               systemImage: FactorySection.sessions.systemImage)
                        .card()
                }
            }
            .screenPadding()
        }
    }

    @ViewBuilder
    private func content(_ observed: ObservedSessions) -> some View {
        let now = Date()
        let machines = observed.machines
        summary(observed, machines: machines, now: now).card()
        filters(observed, machines: machines)
        let scoped = observed.sessions.filter { machineFilter == nil || $0.machineId == machineFilter }
        let nodes = SessionTree.build(scoped).filter { $0.matches(filter.status) }
        let order = machines.map(\.machineId) + Set(scoped.map(\.machineId)).subtracting(machines.map(\.machineId)).sorted()
        let groups = order.compactMap { id -> (id: String, name: String, nodes: [SessionNode])? in
            let list = nodes.filter { $0.session.machineId == id }
            guard !list.isEmpty else { return nil }
            return (id, machines.first { $0.machineId == id }?.name ?? list[0].session.machineName, list)
        }
        if groups.isEmpty {
            EmptyState(observed.sessions.isEmpty ? "No sessions yet" : "No sessions match",
                       message: observed.sessions.isEmpty ? "Sessions appear here as soon as T3 Code opens a thread on a machine Perpeto watches." : "Try another status or machine.",
                       systemImage: FactorySection.sessions.systemImage)
                .card()
        }
        ForEach(groups, id: \.id) { group in
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
                    Mono(group.name, color: PerpetoColor.ink, size: PerpetoType.text16)
                        .fontWeight(.semibold)
                    if ThisMachine.matches(name: group.name, labels: store.machine(group.id)?.labels ?? []) { Tag("This Mac") }
                    Spacer(minLength: PerpetoSpacing.x(2))
                    Text(SessionText.plural(group.nodes.count, "session")).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
                .padding(.bottom, PerpetoSpacing.x(2))
                RowList(group.nodes) { node in SessionTreeRow(node: node, now: now) }
            }
            .card()
        }
    }

    private func summary(_ observed: ObservedSessions, machines: [ObservedMachine], now: Date) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
            FigureStrip([
                Figure("Running", value: "\(observed.running)"),
                Figure("Waiting for you", value: "\(observed.waiting)"),
                Figure("Tokens in the last hour", value: observed.summary(.hour).map { Format.tokens($0.tokens.total) } ?? "—"),
            ])
            if !machines.isEmpty {
                RowList(machines) { machine in
                    ObservedMachineRow(machine: machine, labels: store.machine(machine.machineId)?.labels ?? [], now: now)
                }
                .padding(.bottom, -PerpetoSpacing.x(4))
            }
        }
    }

    @ViewBuilder
    private func filters(_ observed: ObservedSessions, machines: [ObservedMachine]) -> some View {
        let picker = PillPicker(filterOptions(observed), selection: $filter)
        let menu = machineMenu(machines)
        if compact {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                ScrollView(.horizontal) { picker }.scrollIndicators(.never)
                if machines.count > 1 { menu }
            }
        } else {
            HStack(spacing: PerpetoSpacing.x(4)) {
                picker
                Spacer(minLength: 0)
                if machines.count > 1 { menu }
            }
        }
    }

    /// Errors appear only when there are some, so a calm factory shows a calm control.
    private func filterOptions(_ observed: ObservedSessions) -> [(value: Filter, title: String, count: Int?)] {
        let scoped = observed.sessions.filter { machineFilter == nil || $0.machineId == machineFilter }
        let counts = SessionTree.counts(scoped)
        var options: [(value: Filter, title: String, count: Int?)] = [
            (.all, "All", scoped.count),
            (.status(.running), "Running", counts[.running] ?? 0),
            (.status(.waiting), "Waiting", counts[.waiting] ?? 0),
            (.status(.idle), "Idle", counts[.idle] ?? 0),
        ]
        if (counts[.error] ?? 0) > 0 || filter == .status(.error) { options.append((.status(.error), "Errors", counts[.error] ?? 0)) }
        return options
    }

    private func machineMenu(_ machines: [ObservedMachine]) -> some View {
        Menu {
            Button("All machines") { machineFilter = nil }
            Divider()
            ForEach(machines) { m in
                Button(m.name) { machineFilter = m.machineId }
            }
        } label: {
            HStack(spacing: PerpetoSpacing.x(2)) {
                Image(systemName: "desktopcomputer").font(.system(size: 12, weight: .regular)).foregroundStyle(PerpetoColor.muted)
                Text(machines.first { $0.machineId == machineFilter }?.name ?? "All machines")
                    .font(machineFilter == nil ? PerpetoFont.captionMedium : PerpetoFont.mono(PerpetoType.text13))
                    .foregroundStyle(PerpetoColor.ink)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(PerpetoColor.muted)
            }
            .padding(.horizontal, PerpetoSpacing.x(4))
            .frame(height: 34)
            .background(Capsule(style: .continuous).fill(PerpetoColor.surface))
            .pillElevation(.card, height: 34)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Machine")
    }
}

// MARK: Home

/// The observe-only home: the advice line, machines, what is running,
/// subscriptions with their meters, and tokens over the last day.
struct ObserveHomeScreen: View {
    var store: FactoryStore
    var navigator: Navigator
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let observed = store.factory.sessions
        let now = Date()
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Home", subtitle: subtitle(observed)) {
                    Button("Open sessions") { navigator.route = .factory(.sessions) }
                        .buttonStyle(.perpetoPrimary)
                        .fullWidthButtons(compact)
                }
                .padding(.bottom, PerpetoSpacing.x(compact ? 0 : 4))
                hero(observed).card()
                AdaptiveColumns(sideWidth: 380) {
                    liveCard(observed, now: now).card()
                    tokensCard(observed).card()
                } side: {
                    machinesCard(observed, now: now).card()
                    subscriptionsCard(now: now).card()
                }
            }
            .screenPadding()
        }
    }

    private func subtitle(_ observed: ObservedSessions?) -> String {
        guard let observed else { return "Sessions, machines, subscriptions and usage across your factory." }
        let count = observed.machines.count
        return "T3 Code on \(SessionText.plural(count, "machine")), watched read-only. Nothing here changes a session."
    }

    private func hero(_ observed: ObservedSessions?) -> some View {
        let running = observed?.running
        let advice: PacingText.Advice = store.factory.pacing.map { PacingText.advice($0, sessionsRunning: running) }
            ?? PacingText.Advice(lead: SessionText.plural(running ?? 0, "session") + " running", clauses: [])
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
        let machines = observed?.machines ?? []
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(7)) {
            HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
                if (running ?? 0) > 0 { LiveDot().alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 } }
                Text(text)
                    .tracking(PerpetoType.tracking(forHeading: size))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 760, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
            }
            FigureStrip([
                Figure("Waiting for you", value: "\(observed?.waiting ?? 0)"),
                Figure("Tokens in the last 24 hours", value: observed?.summary(.day).map { Format.tokens($0.tokens.total) } ?? "—"),
                Figure("Machines observing", value: "\(machines.filter { $0.online && $0.observing }.count)", unit: "of \(machines.count)"),
            ])
            .frame(maxWidth: 760, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func liveCard(_ observed: ObservedSessions?, now: Date) -> some View {
        let nodes = SessionTree.build(observed?.sessions ?? []).filter { $0.matches(.waiting) || $0.matches(.running) }
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Running now") { CardLink("All sessions") { navigator.route = .factory(.sessions) } }
                .padding(.bottom, PerpetoSpacing.x(2))
            if nodes.isEmpty {
                Text(observed == nil ? "This hub doesn’t observe sessions yet." : "Nothing is running. Sessions appear here as soon as T3 Code starts a turn.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.vertical, PerpetoSpacing.x(3))
            }
            RowList(Array(nodes.prefix(5))) { node in
                SessionRow(session: node.session, showMachine: true, now: now)
            }
            if nodes.count > 5 {
                CardLink("\(nodes.count - 5) more") { navigator.route = .factory(.sessions) }.padding(.top, PerpetoSpacing.x(2))
            }
        }
    }

    private func tokensCard(_ observed: ObservedSessions?) -> some View {
        let summary = observed?.summary(.day)
        let values = (summary?.tokens.series ?? []).map { Double($0.total) }
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            SectionTitle("Tokens over 24 hours", detail: summary.map { Format.tokens($0.tokens.total) + " input and output" })
            if values.isEmpty {
                Text("No tokens reported yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            } else {
                TrendBars(values, start: "24 h ago", unit: "tokens").frame(height: 148)
            }
        }
    }

    private func machinesCard(_ observed: ObservedSessions?, now: Date) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Machines") { CardLink("Machines") { navigator.route = .factory(.machines) } }
                .padding(.bottom, PerpetoSpacing.x(2))
            let machines = observed?.machines ?? []
            if machines.isEmpty {
                Text("No machine reports T3 Code yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.vertical, PerpetoSpacing.x(3))
            }
            RowList(machines) { machine in
                ObservedMachineRow(machine: machine, labels: store.machine(machine.machineId)?.labels ?? [], now: now, stacked: true)
            }
        }
    }

    private func subscriptionsCard(now: Date) -> some View {
        let accounts = store.factory.accounts
        let pacing = store.factory.pacing
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Subscriptions") { CardLink("Accounts") { navigator.route = .factory(.accounts) } }
                .padding(.bottom, PerpetoSpacing.x(2))
            if accounts.isEmpty {
                Text("No subscription reported yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.vertical, PerpetoSpacing.x(3))
            }
            RowList(AccountsScreen.groups(accounts, pacing: pacing).flatMap(\.accounts)) { account in
                let paced = pacing?.accounts.first { $0.accountId == account.id }
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(account.label).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Spacer(minLength: PerpetoSpacing.x(2))
                        Text(account.plan ?? Format.provider(account.provider)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                    }
                    ForEach(Array(MeterWindow.merge(account, paced).prefix(2))) { UsageMeterView(window: $0, now: now) }
                    if let room = PacingText.headroom(paced?.headroomAgents) {
                        Text(room).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.inkSoft)
                    }
                }
            }
        }
    }
}
