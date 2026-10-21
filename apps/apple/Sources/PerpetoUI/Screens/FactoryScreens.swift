import PerpetoKit
import SwiftUI

/// Native table inside a white ruled panel.
struct TablePanel<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            #if os(macOS)
            .tableStyle(.inset(alternatesRowBackgrounds: false))
            #endif
            .scrollContentBackground(.hidden)
            .background(PerpetoColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous).strokeBorder(PerpetoColor.border))
    }
}

struct MachinesScreen: View {
    var store: FactoryStore
    @Environment(\.compactLayout) private var compact
    @State private var selection: Machine.ID?
    @State private var enrollment: EnrollmentCode?
    @State private var confirmDrain: Machine?

    var body: some View {
        let machines = store.factory.machines
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            ScreenHeader("Machines", subtitle: "Enrolled machines run agents through T3 and CI jobs on hardware you own.") {
                Button("Enroll machine") {
                    Task { enrollment = await store.enrollmentCode() }
                }
                .buttonStyle(.perpetoPrimary)
            }
            FigureStrip([
                Figure("Online", value: "\(machines.filter { $0.status == .online }.count) of \(machines.count)"),
                Figure("Agents running", value: "\(machines.reduce(0) { $0 + $1.running.agents })", detail: "capacity \(machines.reduce(0) { $0 + $1.capacity.maxAgents })"),
                Figure("CI jobs running", value: "\(machines.reduce(0) { $0 + $1.running.jobs })", detail: "capacity \(machines.reduce(0) { $0 + $1.capacity.maxJobs })"),
            ])
            if machines.isEmpty {
                EmptyState("Enroll your first machine", message: "Create a one-time code, then run perpeto enroll on the machine.") {
                    Button("Enroll machine") { Task { enrollment = await store.enrollmentCode() } }.buttonStyle(.perpetoPrimary)
                }
                .panel()
            } else if compact {
                // Stacked rows instead of a table squeezed to one column.
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
                            if index > 0 { Rule() }
                            MachineRow(machine: machine) { confirmDrain = machine }
                                .padding(.vertical, PerpetoSpacing.x(3))
                        }
                    }
                    .panel()
                }
            } else {
                TablePanel {
                    Table(machines, selection: $selection) {
                        TableColumn("Machine") { m in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                                Mono("\(m.os) · \(m.arch) · \(m.id)")
                            }
                            .padding(.vertical, PerpetoSpacing.x(1))
                        }
                        .width(min: 180, ideal: 220)
                        TableColumn("Status") { m in StatusLabel(m.status.label) }.width(90)
                        TableColumn("Agents") { m in
                            CapacityCell(used: m.running.agents, capacity: m.capacity.maxAgents)
                        }
                        .width(min: 110, ideal: 130)
                        TableColumn("CI jobs") { m in
                            CapacityCell(used: m.running.jobs, capacity: m.capacity.maxJobs)
                        }
                        .width(min: 90, ideal: 110)
                        TableColumn("Providers") { m in Text(m.providers.map(Format.provider).joined(separator: ", ")).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink) }
                        TableColumn("Labels") { m in Mono(m.labels.joined(separator: " ")) }
                        TableColumn("Heartbeat") { m in Text(Format.relative(m.lastHeartbeatAt)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted) }.width(90)
                        TableColumn("Version") { m in Mono(m.version) }.width(60)
                    }
                    .contextMenu(forSelectionType: Machine.ID.self) { ids in
                        if let id = ids.first, let machine = machines.first(where: { $0.id == id }), machine.status == .online {
                            Button("Drain \(machine.name)…") { confirmDrain = machine }
                        }
                    }
                }
            }
        }
        .screenPadding()
        .sheet(item: Binding(get: { enrollment.map(EnrollmentSheet.Item.init) }, set: { enrollment = $0?.code })) { item in
            EnrollmentSheet(code: item.code, isDemo: store.isDemo)
        }
        .confirmationDialog("Drain \(confirmDrain?.name ?? "")?", isPresented: Binding(get: { confirmDrain != nil }, set: { if !$0 { confirmDrain = nil } })) {
            Button("Drain machine") { if let m = confirmDrain { Task { await store.drain(m) } } }
        } message: {
            Text("It stops taking new assignments and jobs. Work already running finishes first.")
        }
    }
}

/// One machine as a stacked row for narrow screens.
struct MachineRow: View {
    var machine: Machine
    var drain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            HStack(alignment: .firstTextBaseline) {
                Text(machine.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Spacer()
                StatusLabel(machine.status.label)
            }
            Mono("\(machine.os) · \(machine.arch) · v\(machine.version)")
            Grid(alignment: .leading, horizontalSpacing: PerpetoSpacing.x(4), verticalSpacing: PerpetoSpacing.x(1.5)) {
                GridRow {
                    Text("Agents").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    CapacityCell(used: machine.running.agents, capacity: machine.capacity.maxAgents)
                }
                GridRow {
                    Text("CI jobs").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    CapacityCell(used: machine.running.jobs, capacity: machine.capacity.maxJobs)
                }
                GridRow {
                    Text("Providers").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    Text(machine.providers.map(Format.provider).joined(separator: ", ")).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                }
                GridRow {
                    Text("Heartbeat").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    Text(Format.relative(machine.lastHeartbeatAt)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                }
            }
        }
        .contextMenu {
            if machine.status == .online { Button("Drain \(machine.name)…", action: drain) }
        }
    }
}

struct CapacityCell: View {
    var used: Int
    var capacity: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(used) of \(capacity)").font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
            Meter(capacity > 0 ? Double(used) / Double(capacity) : 0).frame(width: 72)
        }
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
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            Text("Enroll a machine").font(PerpetoFont.title()).foregroundStyle(PerpetoColor.ink)
            Text("Run this on the machine you want to add. The code works once\(code.expiresAt.map { " and expires " + Format.relative($0) } ?? "").")
                .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            Text("perpeto enroll --code \(code.code)")
                .font(PerpetoFont.mono(PerpetoType.text14))
                .foregroundStyle(PerpetoColor.ink)
                .textSelection(.enabled)
                .padding(PerpetoSpacing.x(3))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PerpetoColor.canvas, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
                .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control).strokeBorder(PerpetoColor.border))
            if isDemo {
                Text("Demo data: this code is a placeholder and does not enroll anything.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.warning)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(.perpetoPrimary).keyboardShortcut(.defaultAction)
            }
        }
        .padding(PerpetoSpacing.x(6))
        .frame(width: 460)
        .background(PerpetoColor.surface)
    }
}

struct AccountsScreen: View {
    var store: FactoryStore

    var body: some View {
        let accounts = store.factory.accounts
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            ScreenHeader("Accounts", subtitle: "Subscription accounts each machine can use. A rate-limited account cools down and the next eligible one takes over.")
            FigureStrip([
                Figure("Active", value: "\(accounts.filter { $0.status == .active }.count)"),
                Figure("Cooling down", value: "\(accounts.filter { $0.status == .cooling }.count)", tone: accounts.contains { $0.status == .cooling } ? .warning : nil),
                Figure("Need sign-in", value: "\(accounts.filter { $0.status == .invalid }.count)", tone: accounts.contains { $0.status == .invalid } ? .error : nil),
            ])
            TablePanel {
                Table(accounts) {
                    TableColumn("Account") { a in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.label).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                            Mono(a.id)
                        }
                        .padding(.vertical, PerpetoSpacing.x(1))
                    }
                    TableColumn("Provider") { a in Text(Format.provider(a.provider)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink) }.width(90)
                    TableColumn("Machine") { a in Text(store.machine(a.machineId)?.name ?? a.machineId).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink) }
                    TableColumn("Status") { a in StatusLabel(a.status.label) }.width(120)
                    TableColumn("Cooldown") { a in
                        Text(a.cooldownUntil.map { "Ready " + Format.relative($0) } ?? "—").font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                    }
                    TableColumn("Last used") { a in
                        Text(a.lastUsedAt.map { Format.relative($0) } ?? "Never").font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                    }
                }
            }
            Text("Credentials stay on the machine that owns them. Perpeto never copies them between machines.")
                .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
        }
        .padding(PerpetoSpacing.x(6))
    }
}
