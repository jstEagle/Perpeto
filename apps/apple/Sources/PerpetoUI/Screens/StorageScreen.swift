import PerpetoKit
import SwiftUI

/// Storage across the fleet: one sentence on the worst disk, a bar per
/// machine, what a cleanup would reclaim by kind, then one machine's items:
/// work that needs a person, what a cleanup removes, shared caches with the
/// command that clears them, and stale processes. Cleanup always starts with a
/// dry-run preview; nothing is deleted until the owner confirms it.
struct StorageScreen: View {
    var store: FactoryStore
    @State private var selected: String?
    @Environment(\.compactLayout) private var compact

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Storage", subtitle: "Worktrees, workspaces and build output on every machine. Perpeto removes its own finished work and never touches uncommitted or unpushed changes.")
                if let fleet = store.factory.storage, !fleet.machines.isEmpty {
                    hero(fleet).card()
                    AdaptiveColumns(sideWidth: 340) {
                        disks(fleet).card()
                    } side: {
                        byKind(fleet).card()
                    }
                    if let machineId = selected ?? fleet.byUrgency.first?.machineId, let row = fleet.machines.first(where: { $0.machineId == machineId }) {
                        MachineStorageDetail(store: store, row: row)
                            .id(machineId)
                    }
                } else {
                    EmptyState("No storage reports yet", message: "Machines report their disks once the storage janitor is on (the node config’s storage section) and the hub has the storage routes.",
                               systemImage: FactorySection.storage.systemImage)
                        .card()
                }
            }
            .screenPadding()
        }
    }

    private func hero(_ fleet: FleetStorage) -> some View {
        let headline = StorageText.headline(fleet)
        let size = compact ? PerpetoType.text20 : PerpetoType.text24
        var text = AttributedString(headline.lead)
        text.foregroundColor = PerpetoColor.ink
        text.font = PerpetoType.title(size)
        var rest = AttributedString(" · " + headline.detail)
        rest.foregroundColor = PerpetoColor.muted
        rest.font = PerpetoType.text(size)
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
            Text(text + rest)
                .tracking(PerpetoType.tracking(forHeading: size))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 760, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            ForEach(fleet.alerts) { alert in
                HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
                    StatusLabel(alert.name, tone: alert.state.tone)
                    Text(alert.evidence).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            FigureStrip([
                Figure("Free across the fleet", value: StorageText.bytes(fleet.totals.freeBytes), detail: "of \(StorageText.bytes(fleet.totals.totalBytes))"),
                Figure("A cleanup would reclaim", value: StorageText.bytes(fleet.totals.reclaimableBytes)),
                Figure("Kept for a person", value: "\(fleet.totals.attentionCount)", unit: fleet.totals.attentionCount == 1 ? "item" : "items"),
            ])
            .frame(maxWidth: 760, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func disks(_ fleet: FleetStorage) -> some View {
        let current = selected ?? fleet.byUrgency.first?.machineId
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Disks", detail: "Used · reclaimable")
                .padding(.bottom, PerpetoSpacing.x(2))
            RowList(fleet.byUrgency) { row in
                Button { selected = row.machineId } label: {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                        HStack(spacing: PerpetoSpacing.x(3)) {
                            Text(row.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                            if row.machineId == current {
                                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(PerpetoColor.faint)
                            }
                            Spacer(minLength: PerpetoSpacing.x(2))
                            StatusLabel(row.online ? row.state.label : "Offline", tone: row.online ? row.state.tone : .neutral)
                        }
                        if let disk = row.storage?.disk {
                            DiskBar(disk: disk, reclaimable: row.storage?.reclaimableBytes ?? 0, state: row.state)
                            Text([StorageText.free(disk), (row.storage?.reclaimableBytes ?? 0) > 0 ? "\(StorageText.bytes(row.storage!.reclaimableBytes)) reclaimable" : nil,
                                  StorageText.consequence(row.state)].compactMap { $0 }.joined(separator: " · "))
                                .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted).lineLimit(2)
                        } else {
                            Text("Not scanned yet.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(row.machineId == current ? .isSelected : [])
            }
        }
    }

    private func byKind(_ fleet: FleetStorage) -> some View {
        let kinds = fleet.totals.reclaimableByKind.sorted
        let largest = kinds.first?.bytes ?? 0
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Reclaimable by kind")
                .padding(.bottom, PerpetoSpacing.x(2))
            if kinds.isEmpty {
                Text("Nothing to reclaim. Kept items and shared caches are listed per machine.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            }
            ForEach(kinds, id: \.kind) { entry in
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    HStack {
                        Text(entry.kind.label).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                        Spacer()
                        Text(StorageText.bytes(entry.bytes)).font(PerpetoFont.captionMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                    }
                    Meter(largest > 0 ? entry.bytes / largest : 0)
                }
                .padding(.vertical, PerpetoSpacing.x(2))
            }
            if fleet.totals.advisoryBytes > 0 {
                Text("Shared caches hold another \(StorageText.bytes(fleet.totals.advisoryBytes)). Perpeto only shows the command that clears them.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, PerpetoSpacing.x(3))
            }
        }
    }
}

/// A disk as one rounded bar: used space in ink (red when critically full),
/// the reclaimable part of it in a lighter grey, free space as the track.
struct DiskBar: View {
    var disk: StorageDisk
    var reclaimable: Double
    var state: StorageState

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let used = width * disk.usedFraction
            let reclaim = min(used, width * (disk.totalBytes > 0 ? reclaimable / disk.totalBytes : 0))
            ZStack(alignment: .leading) {
                Capsule().fill(PerpetoColor.chartQuiet)
                Capsule().fill(state == .critical ? PerpetoColor.error : PerpetoColor.ink).frame(width: max(used, 0))
                if reclaim > 1 {
                    Rectangle().fill(PerpetoColor.grey300)
                        .frame(width: reclaim)
                        .offset(x: max(0, used - reclaim))
                        .clipShape(Capsule())
                }
            }
        }
        .frame(height: 8)
        .accessibilityElement()
        .accessibilityLabel("Disk")
        .accessibilityValue("\(StorageText.percent(disk.usedFraction)) used, \(StorageText.bytes(reclaimable)) reclaimable")
    }
}

/// One machine: needs attention, what a cleanup removes, shared caches and
/// processes, and the dry-run-then-execute cleanup.
struct MachineStorageDetail: View {
    var store: FactoryStore
    var row: StorageMachine
    @State private var busy: StorageCleanup.Mode?

    var body: some View {
        let detail = store.machineStorage[row.machineId]
        let inventory = detail?.inventory
        VStack(alignment: .leading, spacing: PerpetoGap.cards) {
            AdaptiveColumns(sideWidth: 340) {
                if let inventory {
                    attention(inventory).card()
                    reclaimable(inventory).card()
                } else {
                    HStack(spacing: PerpetoSpacing.x(3)) {
                        SpindleLoader(size: 16)
                        Text(detail == nil ? "Loading \(row.name)’s inventory…" : "\(row.name) has not sent a full inventory yet.")
                            .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    }
                    .card()
                }
            } side: {
                cleanup(inventory).card()
                if let inventory, !inventory.advisory.isEmpty || !inventory.processes.isEmpty {
                    advisory(inventory).card()
                }
            }
        }
        .task(id: row.machineId) { await store.loadMachineStorage(row.machineId) }
    }

    private func attention(_ inventory: StorageInventory) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Needs attention", detail: row.name)
                .padding(.bottom, PerpetoSpacing.x(2))
            if inventory.needsAttention.isEmpty {
                Text("Nothing kept for a person. Uncommitted or unpushed work would show here instead of being deleted.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            }
            RowList(inventory.needsAttention) { item in
                HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                    StatusIcon(.warning)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Mono(item.path)
                        Text(item.reason).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                        if let git = item.gitState { Text(StorageText.gitLine(git)).font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted) }
                    }
                    Spacer(minLength: PerpetoSpacing.x(2))
                    Text(StorageText.bytes(item.bytes)).font(PerpetoFont.captionMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                }
            }
        }
    }

    private func reclaimable(_ inventory: StorageInventory) -> some View {
        let items = inventory.reclaimable
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Reclaimable", detail: "\(StorageText.bytes(inventory.reclaimableBytes)) · \(Format.plural(items.count, "item"))")
                .padding(.bottom, PerpetoSpacing.x(2))
            if items.isEmpty {
                Text("Nothing on this machine is past its retention period.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            }
            RowList(Array(items.prefix(12))) { item in
                HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                    IconTile(item.kind.systemImage, size: 32)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(item.action == .strip ? "Strip" : "Delete") \(item.title)").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Mono(item.path)
                        Text(item.reason).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: PerpetoSpacing.x(2))
                    Text(StorageText.bytes(item.bytes) + (item.approximate ? "+" : "")).font(PerpetoFont.captionMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                }
            }
            if items.count > 12 {
                Text("And \(Format.plural(items.count - 12, "smaller item")).").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(2))
            }
            let kept = inventory.kept
            if !kept.isEmpty {
                Text("Kept: \(Format.plural(kept.count, "item")), \(StorageText.bytes(kept.reduce(0) { $0 + $1.bytes })), in use, recent or not created by Perpeto.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, PerpetoSpacing.x(3))
            }
        }
    }

    private func cleanup(_ inventory: StorageInventory?) -> some View {
        let current = store.cleanups[row.machineId]
        let preview = current?.mode == .dryRun && current?.isDone == true ? current?.result : nil
        let executed = current?.mode == .execute && current?.isDone == true ? current?.result : nil
        let nothing = (inventory?.reclaimable.isEmpty ?? true)
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            SectionTitle("Clean up")
            if let busy {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    LiveDot()
                    Text(busy == .dryRun ? "Waiting for \(row.name) to preview…" : "Cleaning up on \(row.name)…")
                        .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                }
                Text("The machine runs it on its next check-in, usually within seconds.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            } else if let executed {
                StatusLabel("Freed \(StorageText.bytes(executed.freedBytes))", tone: .success)
                result(executed)
                Button("Done") { store.clearCleanup(row.machineId) }.buttonStyle(.perpetoSecondary)
            } else if let preview {
                Text(preview.freeing.isEmpty ? "Nothing would be removed." : "Would free \(StorageText.bytes(preview.freedBytes)) from \(Format.plural(preview.freeing.count, "item")).")
                    .font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                result(preview)
                HStack(spacing: PerpetoSpacing.x(3)) {
                    if !preview.freeing.isEmpty {
                        Button("Clean up \(StorageText.bytes(preview.freedBytes))") { run(.execute, itemIds: preview.freeing.map(\.itemId)) }
                            .buttonStyle(.perpetoPrimary)
                    }
                    Button("Cancel") { store.clearCleanup(row.machineId) }.buttonStyle(.perpetoGhost)
                }
                Text("Each item is checked again right before it is deleted; anything that changed is kept.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(nothing ? "Nothing to reclaim on \(row.name) right now." : "Preview what a cleanup on \(row.name) would remove. Nothing is deleted until you confirm.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                Button("Preview cleanup") { run(.dryRun, itemIds: nil) }
                    .buttonStyle(.perpetoSecondary)
                    .disabled(nothing || !row.online)
                if !row.online {
                    Text("\(row.name) is offline; cleanups wait for it to return.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
            }
        }
    }

    private func result(_ result: StorageCleanupResult) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            ForEach(result.freeing.prefix(6)) { action in
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text(action.status.label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 92, alignment: .leading)
                    Mono(action.path ?? action.itemId, color: PerpetoColor.inkSoft)
                    Spacer(minLength: PerpetoSpacing.x(1))
                    Text(StorageText.bytes(action.bytes)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                }
            }
            if result.freeing.count > 6 {
                Text("And \(Format.plural(result.freeing.count - 6, "more item")).").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            ForEach(result.held.prefix(4)) { action in
                HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
                    StatusIcon(action.status == .failed ? .error : action.status == .needsAttention ? .warning : .neutral)
                    Text([action.path, action.reason].compactMap { $0 }.joined(separator: " · "))
                        .font(PerpetoFont.caption).foregroundStyle(action.status == .failed ? PerpetoColor.error : PerpetoColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func advisory(_ inventory: StorageInventory) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("Yours to decide", detail: "Never automatic")
                .padding(.bottom, PerpetoSpacing.x(2))
            RowList(inventory.advisory) { item in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(item.title).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Spacer(minLength: PerpetoSpacing.x(2))
                        Text(StorageText.bytes(item.bytes) + (item.approximate ? "+" : "")).font(PerpetoFont.captionMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                    }
                    Text(item.reason).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                    if let hint = item.hint { HintText(hint) }
                }
            }
            if !inventory.processes.isEmpty {
                Text("Processes").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink).padding(.top, PerpetoSpacing.x(4))
                RowList(inventory.processes) { process in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(process.kind == .simulator ? process.name : "\(process.name) · pid \(process.pid.map(String.init) ?? "?")")
                                .font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                            Spacer(minLength: PerpetoSpacing.x(2))
                            if let elapsed = process.elapsedSec {
                                Text(StorageText.elapsed(elapsed)).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                            }
                        }
                        Text(process.reason).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                        if let hint = process.hint { HintText(hint) }
                    }
                }
            }
        }
    }

    private func run(_ mode: StorageCleanup.Mode, itemIds: [String]?) {
        busy = mode
        Task {
            await store.cleanStorage(machineId: row.machineId, mode: mode, itemIds: itemIds)
            busy = nil
        }
    }
}

/// The command or step that clears an advisory item, in mono, wrapping rather than truncating.
struct HintText: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(PerpetoFont.mono(PerpetoType.text12)).foregroundStyle(PerpetoColor.inkSoft)
            .lineLimit(3).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }
}

extension StorageState {
    /// Healthy reads quiet; low asks for a look; critically full is the one red state.
    public var tone: StatusTone {
        switch self {
        case .ok: .ok
        case .low: .warning
        case .critical: .error
        }
    }
}
