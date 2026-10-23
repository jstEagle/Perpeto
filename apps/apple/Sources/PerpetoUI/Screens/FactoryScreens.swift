import PerpetoKit
import SwiftUI

/// Fleet: every machine, whether it takes new work right now and why not,
/// its health, and cordon, uncordon and drain. Reads the same with two
/// machines or fifty: a summary first, a filter, and the machines that
/// aren't accepting work at the top.
struct MachinesScreen: View {
    var store: FactoryStore
    @State private var enrollment: EnrollmentCode?
    @State private var confirmDrain: Machine?
    @State private var filter: FleetFilter = .all
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let machines = store.factory.machines
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                let observing = store.isObserveOnly
                let observed = store.factory.sessions?.machines ?? []
                ScreenHeader(FactorySection.machines.title, subtitle: observing
                             ? "Machines you own whose node watches T3 Code and reports its sessions."
                             : "Machines you own, what each can take on right now, and why not.") {
                    Button("Enroll machine") { Task { enrollment = await store.enrollmentCode() } }
                        .buttonStyle(.perpetoPrimary)
                        .fullWidthButtons(compact)
                }
                if machines.isEmpty {
                    EmptyState("Enroll your first machine", message: "Create a one-time code, then run perpeto enroll on the machine.", systemImage: "desktopcomputer") {
                        Button("Enroll machine") { Task { enrollment = await store.enrollmentCode() } }.buttonStyle(.perpetoPrimary)
                    }
                    .card()
                } else {
                    if observing {
                        FigureStrip([
                            Figure("Online", value: "\(machines.filter { $0.status == .online }.count)", unit: "of \(machines.count)"),
                            Figure("Observing T3 Code", value: "\(observed.filter { $0.online && $0.observing }.count)", unit: "of \(machines.count)"),
                            Figure("Sessions running", value: "\(store.factory.sessions?.running ?? 0)"),
                        ])
                        .card()
                    } else {
                        FleetSummaryCard(summary: FleetSummary(machines)).card()
                    }
                    let rows = FleetPresentation.rows(machines, filter: filter)
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                        if machines.count > 1 {
                            let counts = FleetPresentation.counts(machines)
                            PillPicker(FleetFilter.allCases.map { (value: $0, title: $0.title, count: counts[$0]) }, selection: $filter)
                        }
                        if rows.isEmpty {
                            Text(filter == .accepting ? "No machine is accepting work right now." : "Every machine is accepting work.")
                                .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, PerpetoSpacing.x(2))
                                .card()
                        } else {
                            RowList(rows) { machine in
                                FleetRow(machine: machine, observed: observed.first { $0.machineId == machine.id }) { action in
                                    if action.needsConfirmation { confirmDrain = machine } else { Task { await store.apply(action, to: machine) } }
                                }
                            }
                            .card()
                        }
                    }
                }
            }
            .screenPadding()
        }
        .sheet(item: Binding(get: { enrollment.map(EnrollmentSheet.Item.init) }, set: { enrollment = $0?.code })) { item in
            EnrollmentSheet(code: item.code, isDemo: store.isDemo)
        }
        .confirmationDialog("Drain \(confirmDrain?.name ?? "")?", isPresented: Binding(get: { confirmDrain != nil }, set: { if !$0 { confirmDrain = nil } })) {
            Button("Drain \(confirmDrain?.name ?? "machine")") { if let m = confirmDrain { Task { await store.apply(.drain, to: m) } } }
        } message: {
            Text(drainMessage(confirmDrain))
        }
    }

    private func drainMessage(_ machine: Machine?) -> String {
        guard let machine else { return "" }
        let held = FleetText.slots(machine).held
        let running = [held.agents > 0 ? Format.plural(held.agents, "agent") : nil, held.jobs > 0 ? Format.plural(held.jobs, "CI job") : nil].compactMap { $0 }
        let finish = running.isEmpty ? "Nothing is running there now." : "The \(running.joined(separator: " and ")) running there now finish first."
        return "It stops taking new agents and CI jobs. \(finish) Uncordon it to take work again."
    }
}

/// Accepting machines, slots in use against what the fleet can take right
/// now, and the machines that need a look.
struct FleetSummaryCard: View {
    var summary: FleetSummary

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
            FigureStrip([
                Figure("Accepting work", value: "\(summary.accepting)", unit: "of \(summary.total)"),
                Figure("Agent slots in use", value: "\(summary.agentsHeld)", unit: "of \(summary.agentsEffective)",
                       detail: summary.agentsConfigured != summary.agentsEffective ? "\(summary.agentsConfigured) configured" : nil),
            ] + (summary.jobsConfigured > 0 ? [
                Figure("CI slots in use", value: "\(summary.jobsHeld)", unit: "of \(summary.jobsEffective)",
                       detail: summary.jobsConfigured != summary.jobsEffective ? "\(summary.jobsConfigured) configured" : nil),
            ] : []))
            if summary.attention == nil {
                StatusLabel("Every machine is healthy and taking work", tone: .ok)
            } else {
                FleetFlow(spacing: PerpetoSpacing.x(6), lineSpacing: PerpetoSpacing.x(2)) {
                    if summary.overloaded > 0 { StatusLabel("\(summary.overloaded) overloaded", tone: .warning) }
                    if summary.limited > 0 { StatusLabel("\(summary.limited) limited", tone: .blocked) }
                    if summary.cordoned > 0 { StatusLabel("\(summary.cordoned) cordoned or draining", tone: .paused) }
                    if summary.offline > 0 { StatusLabel("\(summary.offline) offline", tone: .error) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension MachinePlacement.Status {
    /// Offline is the only failure, so the only red. Overloaded wants a look; holds the owner set are quiet.
    var tone: StatusTone {
        switch self {
        case .online: .ok
        case .limited: .blocked
        case .overloaded: .warning
        case .cordoned: .paused
        case .draining: .waiting
        case .drained: .stopped
        case .offline: .error
        case .unknown: .neutral
        }
    }
}

/// One machine: name and platform, status, slots in use, health in one
/// wrapping line, the reasons it isn't taking work, and its actions.
struct FleetRow: View {
    var machine: Machine
    /// What its node reports about T3 Code, when the hub observes sessions.
    var observed: ObservedMachine?
    var perform: (FleetAction) -> Void
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let status = FleetText.status(machine)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                IconTile(icon)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: PerpetoSpacing.x(2)) {
                        Mono(machine.name, color: PerpetoColor.ink, size: PerpetoType.text14)
                        if ThisMachine.matches(name: machine.name, labels: machine.labels) { Tag("This Mac") }
                    }
                    Text(meta).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
                    if compact { StatusLabel(FleetText.statusLabel(status), tone: status.tone).padding(.top, 2) }
                }
                Spacer(minLength: PerpetoSpacing.x(2))
                if !compact {
                    slots.frame(width: 200, alignment: .leading)
                    StatusLabel(FleetText.statusLabel(status), tone: status.tone).frame(width: 112, alignment: .leading)
                }
                actions
            }
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                if compact { slots }
                let facts = FleetText.health(machine)
                if !facts.isEmpty {
                    Text(healthLine(facts)).fixedSize(horizontal: false, vertical: true)
                }
                let reasons = FleetText.reasons(machine)
                if !reasons.isEmpty {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                        ForEach(reasons) { ReasonLine(reason: $0) }
                    }
                }
                if let observed {
                    Text(observed.observing
                         ? "Watching T3 Code · \(observed.running) running · \(observed.waiting) waiting · \(observed.idle) idle"
                         : "T3 Code not found")
                        .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                }
            }
            .padding(.leading, compact ? 0 : PerpetoIcon.tile + PerpetoSpacing.x(4))
        }
    }

    private var icon: String {
        if machine.os == "linux" { return "server.rack" }
        return machine.health?.power?.percent != nil ? "laptopcomputer" : "desktopcomputer"
    }

    private var meta: String {
        let heartbeat = FleetText.status(machine) == .offline ? "last seen \(Format.relative(machine.lastHeartbeatAt))" : nil
        return [FleetText.platform(machine), machine.version.isEmpty ? nil : "v\(machine.version)",
                machine.providers.map(Format.provider).joined(separator: ", ").nilIfEmpty, heartbeat]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var slots: some View {
        let s = FleetText.slots(machine)
        // Nothing is known to be running on a machine that stopped reporting.
        let reporting = FleetText.status(machine) != .offline
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            if let line = FleetText.agentsLine(machine) {
                meter(line, held: s.held.agents, of: s.effective.agents > 0 ? s.effective.agents : s.configured.agents, live: reporting && s.held.agents > 0)
            }
            if let line = FleetText.jobsLine(machine) {
                meter(line, held: s.held.jobs, of: s.effective.jobs > 0 ? s.effective.jobs : s.configured.jobs, live: reporting && s.held.jobs > 0)
            }
        }
    }

    /// The bar measures against the slots open now, or the configured ones
    /// when the hub has closed them all.
    private func meter(_ line: String, held: Int, of capacity: Int, live: Bool) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
            HStack(spacing: PerpetoSpacing.x(1.5)) {
                if live { LiveDot(size: 6) }
                Text(line).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(live ? PerpetoColor.inkSoft : PerpetoColor.muted).lineLimit(1)
            }
            Meter(capacity > 0 ? Double(held) / Double(capacity) : 0)
        }
    }

    /// "Load 13.0 per core 130 · 118 · 96 on 10 cores   Memory 4.6 GB free of 32 GB …",
    /// the facts holding the machine back in ink.
    private func healthLine(_ facts: [FleetFact]) -> AttributedString {
        var text = AttributedString()
        for (index, fact) in facts.enumerated() {
            if index > 0 {
                var gap = AttributedString("   ")
                gap.font = PerpetoFont.caption
                text += gap
            }
            var label = AttributedString(fact.label + " ")
            label.font = PerpetoFont.caption
            label.foregroundColor = PerpetoColor.muted
            var value = AttributedString(fact.value)
            value.font = fact.concern ? PerpetoFont.captionMedium.monospacedDigit() : PerpetoFont.caption.monospacedDigit()
            value.foregroundColor = fact.concern ? PerpetoColor.ink : PerpetoColor.inkSoft
            text += label + value
            if let detail = fact.detail {
                var rest = AttributedString(", " + detail)
                rest.font = PerpetoFont.caption.monospacedDigit()
                rest.foregroundColor = PerpetoColor.muted
                text += rest
            }
        }
        return text
    }

    private var actions: some View {
        let available = FleetText.actions(machine)
        return Menu {
            ForEach(available) { action in
                Button(FleetText.title(action, for: machine) + (action.needsConfirmation ? "…" : "")) { perform(action) }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(PerpetoColor.muted)
                .frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .disabled(available.isEmpty)
        .accessibilityLabel("Actions for \(machine.name)")
    }
}

/// One reason a machine isn't taking work: the hub's own words, with an
/// icon for how hard it holds the machine back.
struct ReasonLine: View {
    var reason: MachinePlacement.Reason

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .regular))
                .foregroundStyle(reason.effect == .info ? PerpetoColor.faint : PerpetoColor.inkSoft)
                .frame(width: 14)
            Text(reason.message)
                .font(reason.effect == .blocks ? PerpetoFont.captionMedium : PerpetoFont.caption)
                .foregroundStyle(reason.effect == .info ? PerpetoColor.muted : PerpetoColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch reason.effect {
        case .blocks: "nosign"
        case .blocksAgents, .blocksJobs: "minus.circle"
        case .reduces: "arrow.down.circle"
        case .info: "info.circle"
        }
    }
}

/// Lays children out left to right, wrapping onto new lines.
struct FleetFlow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width && !current.indices.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.indices + [index], needed, max(current.height, size.height))
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

struct EnrollmentSheet: View {
    struct Item: Identifiable {
        var code: EnrollmentCode
        var id: String { code.code }
    }

    var code: EnrollmentCode
    var isDemo: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            Text("Enroll a machine").font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
            Text("Run this on the machine you want to add. The code works once\(code.expiresAt.map { " and expires " + Format.relative($0) } ?? "").")
                .perpetoBody(PerpetoType.text14, color: PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            Text("perpeto enroll --code \(code.code)")
                .font(PerpetoFont.mono(PerpetoType.text14))
                .foregroundStyle(PerpetoColor.ink)
                .textSelection(.enabled)
                .padding(PerpetoSpacing.x(4))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            if isDemo {
                Text("Demo data: this code is a placeholder and does not enroll anything.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(.perpetoPrimary).keyboardShortcut(.defaultAction)
            }
        }
        .padding(PerpetoSpacing.x(8))
        .frame(minWidth: 420, idealWidth: 480)
        .background(PerpetoColor.surface)
        .presentationCornerRadius(PerpetoRadius.sheet)
    }
}
