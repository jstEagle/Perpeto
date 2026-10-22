import PerpetoKit
import SwiftUI

/// Subscriptions grouped by provider: label, plan and machine, the session
/// and weekly meters with their resets and projections, and the pacing state.
struct AccountsScreen: View {
    var store: FactoryStore
    @State private var editing: Account?
    @State private var adding = false
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let accounts = store.factory.accounts
        let pacing = store.factory.pacing
        let observing = store.isObserveOnly
        let advisory = observing || pacing?.isAdvisory == true
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Accounts", subtitle: observing
                             ? "The Claude and ChatGPT subscriptions T3 Code uses on your machines, and how much of each limit is used. Perpeto only reads them."
                             : "The Claude and Codex subscriptions signed in on your machines, and how much of each limit is used. Credentials stay on the machine that owns them.") {
                    // Observed subscriptions come from T3 Code on each machine; there is nothing to add here.
                    if !observing {
                        Button("Add subscription") { adding = true }
                            .buttonStyle(.perpetoSecondary)
                            .fullWidthButtons(compact)
                    }
                }
                if accounts.isEmpty && observing {
                    EmptyState("No subscriptions seen yet", message: "They appear once a machine’s node reads the Claude and ChatGPT logins in T3 Code.", systemImage: "person.2")
                        .card()
                } else if accounts.isEmpty {
                    EmptyState("No subscriptions yet", message: "Machines report the Claude and Codex logins in their account pool with each heartbeat.", systemImage: "person.2") {
                        Button("How to add one") { adding = true }.buttonStyle(.perpetoPrimary)
                    }
                    .card()
                } else {
                    ForEach(Self.groups(accounts, pacing: pacing), id: \.provider) { group in
                        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                            SectionTitle(Format.provider(group.provider), detail: Format.plural(group.accounts.count, "subscription"))
                            .padding(.bottom, PerpetoSpacing.x(2))
                            RowList(group.accounts) { account in
                                SubscriptionRow(account: account, machine: store.machine(account.machineId)?.name ?? account.machineId, pacing: pacing, advisory: advisory) {
                                    editing = account
                                }
                            }
                        }
                        .card()
                    }
                    Text(advisory
                         ? "Perpeto reads these from T3 Code and enforces nothing. Room is about how many more agents could run and still land near \(pacing?.targetUsePercent ?? 95)% by the reset."
                         : "Credentials stay on the machine that owns them. Perpeto never copies them between machines.")
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
            .screenPadding()
        }
        .sheet(item: $editing) { account in
            EditSubscriptionSheet(account: account) { label, plan in await store.updateAccount(account, label: label, plan: plan) }
        }
        .sheet(isPresented: $adding) { AddSubscriptionSheet() }
    }

    /// Providers in a fixed order; within each, the rotation order: burning, up next, then by next turn.
    static func groups(_ accounts: [Account], pacing: Pacing?) -> [(provider: String, accounts: [Account])] {
        let order = ["claudeAgent", "codex"]
        let now = Date()
        func turn(_ a: Account) -> Date {
            switch pacing?.accounts.first(where: { $0.accountId == a.id })?.state {
            case .burning: return .distantPast
            case .next: return .distantPast.addingTimeInterval(1)
            default: return pacing.flatMap { PacingText.nextTurn(a.id, in: $0, after: now) } ?? .distantFuture
            }
        }
        return Dictionary(grouping: accounts, by: \.provider)
            .map { (provider: $0.key, accounts: $0.value.sorted { (turn($0), $0.label) < (turn($1), $1.label) }) }
            .sorted { (order.firstIndex(of: $0.provider) ?? order.count, $0.provider) < (order.firstIndex(of: $1.provider) ?? order.count, $1.provider) }
    }
}

/// One subscription. Wide: identity, two meters, state and edit in a row. Compact: stacked.
struct SubscriptionRow: View {
    var account: Account
    var machine: String
    var pacing: Pacing?
    /// Observe-only: the state column reads as advice, not a rotation.
    var advisory = false
    var edit: () -> Void
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let paced = pacing?.accounts.first { $0.accountId == account.id }
        let windows = Array(MeterWindow.merge(account, paced).prefix(2))
        let meters = Group {
            if windows.isEmpty {
                Text("No limits reported yet. They appear after the machine’s next usage check.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(alignment: .top, spacing: PerpetoSpacing.x(compact ? 5 : 8)) {
                    ForEach(windows) { UsageMeterView(window: $0) }
                }
            }
        }
        if compact {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                HStack(alignment: .top) {
                    identity
                    Spacer(minLength: PerpetoSpacing.x(2))
                    if !account.isObserved { editButton }
                }
                state(paced)
                meters
            }
        } else {
            HStack(alignment: .center, spacing: PerpetoSpacing.x(6)) {
                identity.frame(width: advisory ? 220 : 190, alignment: .leading)
                meters.frame(maxWidth: .infinity)
                state(paced).frame(width: advisory ? 190 : 130, alignment: .leading)
                if !account.isObserved { editButton }
            }
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(account.label).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
            HStack(spacing: 0) {
                Text((account.plan ?? "Plan not set") + " · ").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                Mono(machine, size: PerpetoType.text12)
            }
            .lineLimit(1)
        }
    }

    private var editButton: some View {
        Button(action: edit) {
            Image(systemName: "pencil").font(.system(size: 13, weight: .medium)).foregroundStyle(PerpetoColor.inkSoft)
                .frame(width: PerpetoControl.heightSmall, height: PerpetoControl.heightSmall).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Edit \(account.label)")
        .help("Edit label and plan")
    }

    @ViewBuilder
    private func state(_ paced: PacingAccount?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            switch account.status {
            case .invalid:
                StatusLabel("Sign-in needed", tone: .error)
                Text("Sign in again on \(machine).").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            case .disabled:
                StatusLabel("Disabled", tone: .stopped)
            case .cooling where paced == nil || paced?.state == .cooling:
                StatusLabel("Cooling down", tone: .waiting)
                if let until = account.cooldownUntil { Text("Ready \(Format.relative(until))").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
            default:
                if advisory || account.isObserved {
                    StatusLabel("Observed", tone: .neutral)
                    if let room = PacingText.headroom(paced?.headroomAgents) {
                        Text(room).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.inkSoft).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(account.lastUsedAt.map { "Used \(Format.relative($0))" } ?? "Not used yet").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                } else if let paced {
                    StatusLabel(PacingText.stateLabel(paced.state), tone: paced.state.tone)
                    if let detail = detail(paced) { Text(detail).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted) }
                } else {
                    StatusLabel("Ready", tone: .ok)
                    Text(account.lastUsedAt.map { "Used \(Format.relative($0))" } ?? "Not used yet").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
        }
    }

    private func detail(_ paced: PacingAccount) -> String? {
        if paced.state == .burning { return Format.plural(paced.runningAgents, "agent") }
        guard let pacing, let next = PacingText.nextTurn(paced.accountId, in: pacing, after: Date()) else { return nil }
        return "Turn in " + PacingText.span(next.timeIntervalSinceNow)
    }
}

/// One limit window: used share in ink, the share still to come by the reset
/// in a lighter grey, and a small mark where the window is projected to end.
struct UsageMeterView: View {
    var window: MeterWindow
    var now = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let used = min(window.usedPercent, 100) / 100
        let projected = window.projectedPercentAtReset.map { min(max($0 / 100, used), 1) }
        let resets = PacingText.resetsIn(window.resetsAt, now: now)
        let projection = PacingText.projection(window)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            HStack {
                Text(window.label).foregroundStyle(PerpetoColor.inkSoft)
                Spacer()
                Text("\(Int(window.usedPercent.rounded()))%").font(PerpetoFont.captionMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
            }
            .font(PerpetoFont.caption)
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(PerpetoColor.chartQuiet).frame(height: 4)
                    if let projected, projected > used {
                        Capsule().fill(PerpetoColor.grey300).frame(width: width * (projected - used), height: 4).offset(x: width * used)
                    }
                    Capsule().fill(PerpetoColor.ink).frame(width: width * used, height: 4)
                    if let projected {
                        Capsule().fill(window.onTrack == .over ? PerpetoColor.ink : PerpetoColor.inkSoft)
                            .frame(width: 2, height: 12)
                            .offset(x: width * projected - 1)
                    }
                }
                .frame(width: width, height: proxy.size.height, alignment: .leading)
                .animation(PerpetoMotion.easeOut(reduceMotion: reduceMotion), value: projected)
            }
            .frame(height: 12)
            HStack(spacing: PerpetoSpacing.x(2)) {
                Text(resets ?? "No reset reported").lineLimit(1)
                Spacer(minLength: 0)
                if let projection {
                    Text(projection).lineLimit(1)
                        .foregroundStyle(window.onTrack == .over ? PerpetoColor.ink : PerpetoColor.muted)
                        .fontWeight(window.onTrack == .over ? .medium : .regular)
                }
            }
            .font(PerpetoFont.small.monospacedDigit())
            .foregroundStyle(PerpetoColor.muted)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([window.label, "\(Int(window.usedPercent.rounded()))% used", resets, projection].compactMap { $0 }.joined(separator: ", "))
    }
}

struct EditSubscriptionSheet: View {
    var account: Account
    var save: (String, String) async -> Bool
    @State private var label = ""
    @State private var plan = ""
    @State private var problem: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            Text("Edit subscription").font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
            field("Label", text: $label, example: "Claude · build", help: problem ?? "Shown everywhere this subscription appears.", failed: problem != nil)
            field("Plan", text: $plan, example: account.provider == "codex" ? "Pro" : "Max 20x", help: "Pacing reads the limits the harness reports; the plan is for you.", failed: false)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.perpetoGhost).keyboardShortcut(.cancelAction)
                Button("Save") {
                    guard !label.trimmingCharacters(in: .whitespaces).isEmpty else {
                        problem = "Give the subscription a label, such as “Claude · build”."
                        return
                    }
                    saving = true
                    Task {
                        if await save(label, plan) { dismiss() } else { problem = "Saving failed. Check the hub connection and try again." }
                        saving = false
                    }
                }
                .buttonStyle(.perpetoPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(saving)
            }
        }
        .padding(PerpetoSpacing.x(8))
        .frame(minWidth: 400, idealWidth: 460)
        .background(PerpetoColor.surface)
        .presentationCornerRadius(PerpetoRadius.sheet)
        .onAppear {
            label = account.label
            plan = account.plan ?? ""
        }
    }

    private func field(_ title: String, text: Binding<String>, example: String, help: String, failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            Text(title).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
            TextField(title, text: text, prompt: Text(example)).perpetoField().accessibilityLabel(title)
            HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(1.5)) {
                if failed { StatusIcon(.error, size: 14) }
                Text(help).foregroundStyle(failed ? PerpetoColor.error : PerpetoColor.muted)
            }
            .font(PerpetoFont.caption)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// How a subscription gets here. There is no CLI step for it yet, and this says so.
struct AddSubscriptionSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            Text("Add a subscription").font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
            Text("A subscription is a Claude or Codex login in the account pool of the machine that runs its agents. The login never leaves that machine; its heartbeat reports the label, plan and limits, and it appears here on its own.")
                .perpetoBody(PerpetoType.text14, color: PerpetoColor.inkSoft).fixedSize(horizontal: false, vertical: true)
            Text("The perpeto command line can’t enrol a login yet. Until it can, a login is added to a machine’s pool with importAccount from @perpeto/accounts, as described in packages/accounts/README.md.")
                .perpetoBody(PerpetoType.text14, color: PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(.perpetoPrimary).keyboardShortcut(.defaultAction)
            }
        }
        .padding(PerpetoSpacing.x(8))
        .frame(minWidth: 420, idealWidth: 500)
        .background(PerpetoColor.surface)
        .presentationCornerRadius(PerpetoRadius.sheet)
    }
}
