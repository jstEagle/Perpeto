import PerpetoKit
import SwiftUI

struct MachinesScreen: View {
    var store: FactoryStore
    @State private var enrollment: EnrollmentCode?
    @State private var confirmDrain: Machine?
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let machines = store.factory.machines
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Machines", subtitle: "Machines you own that run agents and CI jobs.") {
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
                    FigureStrip([
                        Figure("Online", value: "\(machines.filter { $0.status == .online }.count) of \(machines.count)"),
                        Figure("Agents running", value: "\(machines.reduce(0) { $0 + $1.running.agents })", unit: "of \(machines.reduce(0) { $0 + $1.capacity.maxAgents })"),
                        Figure("CI jobs running", value: "\(machines.reduce(0) { $0 + $1.running.jobs })", unit: "of \(machines.reduce(0) { $0 + $1.capacity.maxJobs })"),
                    ])
                    .card()
                    RowList(machines) { machine in
                        MachineRow(machine: machine) { confirmDrain = machine }
                    }
                    .card()
                }
            }
            .screenPadding()
        }
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

/// One machine: name, platform and providers, status, and slot meters.
struct MachineRow: View {
    var machine: Machine
    var drain: () -> Void
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let meters = VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            slots("agent", used: machine.running.agents, capacity: machine.capacity.maxAgents)
            if machine.capacity.maxJobs > 0 { slots("CI", used: machine.running.jobs, capacity: machine.capacity.maxJobs) }
        }
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                IconTile("desktopcomputer")
                VStack(alignment: .leading, spacing: 3) {
                    Mono(machine.name, color: PerpetoColor.ink, size: PerpetoType.text14)
                    Text([platform, "v\(machine.version)", machine.providers.map(Format.provider).joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
                    Text("Heartbeat \(Format.relative(machine.lastHeartbeatAt))").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
                Spacer(minLength: PerpetoSpacing.x(2))
                if !compact { meters.frame(width: 220) }
                StatusLabel(machine.status.label)
                Menu {
                    Button("Drain \(machine.name)…", action: drain).disabled(machine.status != .online)
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(PerpetoColor.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("Actions for \(machine.name)")
            }
            if compact { meters }
        }
    }

    private var platform: String {
        let os = ["darwin": "macOS", "linux": "Linux", "windows": "Windows"][machine.os] ?? machine.os
        return [os, machine.arch].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func slots(_ kind: String, used: Int, capacity: Int) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
            Text("\(used) of \(capacity) \(kind) slots").font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
            Meter(capacity > 0 ? Double(used) / Double(capacity) : 0)
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
