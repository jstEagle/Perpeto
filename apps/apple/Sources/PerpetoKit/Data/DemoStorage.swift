import Foundation

/// Demo storage for three machines: a Mac mini that is critically full (T3
/// worktrees, unavailable simulators, node_modules, a stale vite server), a
/// MacBook that is low on space and a Linux build box that is fine. Cleanups
/// run locally against these fixtures and are lost on quit.
public enum DemoStorage {
    public static let miniId = "mch_demo_mini"
    public static let macbookId = "mch_demo_macbook"
    public static let linuxId = "mch_demo_linux"

    private static let gb = 1_000_000_000.0
    private static let mb = 1_000_000.0

    public static func machines(now: Date) -> [MachineStorage] {
        [mini(now: now), macbook(now: now), linux(now: now)]
    }

    public static func fleet(now: Date) -> FleetStorage { fleet(machines(now: now)) }

    /// The fleet view built the way the hub builds it from each machine's summary.
    public static func fleet(_ machines: [MachineStorage]) -> FleetStorage {
        let rows = machines.map { machine in
            StorageMachine(machineId: machine.machineId, name: machine.name, online: machine.online, state: machine.state, storage: machine.storage,
                           lastCleanup: machine.cleanups.first.map { StorageCleanupBrief(id: $0.id, mode: $0.mode, status: $0.status, source: $0.source,
                                                                                         freedBytes: $0.result?.freedBytes, at: $0.completedAt ?? $0.requestedAt) })
        }
        let alerts = rows.filter { $0.state != .ok }.map { row -> StorageAlert in
            let percent = row.storage?.disk.map { ($0.freeFraction * 1000).rounded() / 10 }
            return StorageAlert(machineId: row.machineId, name: row.name, state: row.state, severity: row.state == .critical ? "critical" : "warning",
                                evidence: "\(percent.map { "\($0)" } ?? "?")% free; " + (row.state == .critical ? "new agent work is paused on this machine" : "aggressive retention is on"),
                                freePercent: percent)
        }
        return FleetStorage(machines: rows, alerts: alerts)
    }

    /// Disk state from free space, with the default 15% and 5% thresholds.
    public static func state(_ disk: StorageDisk) -> StorageState {
        disk.freeFraction < 0.05 ? .critical : disk.freeFraction < 0.15 ? .low : .ok
    }

    /// The heartbeat summary of an inventory.
    public static func summary(_ inventory: StorageInventory, at: Date?) -> StorageSummary {
        var byKind: [StorageKind: Double] = [:]
        for item in inventory.reclaimable { byKind[item.kind, default: 0] += item.bytes }
        let top = (inventory.reclaimable + inventory.needsAttention).sorted { $0.bytes > $1.bytes }.prefix(5)
            .map { StorageTopItem(id: $0.id, kind: $0.kind, path: $0.path, bytes: $0.bytes, reclaimable: $0.reclaimable, attention: $0.attention) }
        return StorageSummary(scannedAt: at, state: inventory.state, disk: inventory.disk, truncated: inventory.truncated, reclaimableBytes: inventory.reclaimableBytes,
                              reclaimableByKind: StorageByKind(byKind), advisoryBytes: inventory.advisory.reduce(0) { $0 + $1.bytes },
                              attentionCount: inventory.needsAttention.count, staleProcesses: inventory.processes.count, items: inventory.items.count, top: Array(top))
    }

    /// Runs a cleanup against a demo machine: a dry run lists what would go; execute removes it and frees the disk.
    public static func clean(_ machine: MachineStorage, id: String, mode: StorageCleanup.Mode, itemIds: [String]?, now: Date) -> (MachineStorage, StorageCleanup) {
        var machine = machine
        guard var inventory = machine.inventory else {
            let cleanup = StorageCleanup(id: id, machineId: machine.machineId, mode: mode, status: .completed, itemIds: itemIds, requestedAt: now, completedAt: now,
                                         result: StorageCleanupResult(dryRun: mode == .dryRun, freedBytes: 0, actions: []))
            return (machine, cleanup)
        }
        let reclaimable = inventory.reclaimable
        let wanted = itemIds.map(Set.init)
        var actions: [StorageCleanupAction] = []
        for item in reclaimable where wanted?.contains(item.id) ?? true {
            let status: StorageCleanupAction.Status = mode == .dryRun ? (item.action == .strip ? .wouldStrip : .wouldDelete) : (item.action == .strip ? .stripped : .deleted)
            actions.append(StorageCleanupAction(itemId: item.id, kind: item.kind, path: item.path, action: item.action, bytes: item.bytes, status: status))
        }
        for id in itemIds ?? [] where !reclaimable.contains(where: { $0.id == id }) {
            let item = inventory.items.first { $0.id == id }
            actions.append(StorageCleanupAction(itemId: id, kind: item?.kind, path: item?.path, bytes: item?.bytes ?? 0, status: .skipped,
                                                reason: item?.reason ?? "Not in the latest inventory; scan again."))
        }
        let freed = actions.filter(\.status.frees).reduce(0) { $0 + $1.bytes }
        if mode == .execute {
            let removed = Set(actions.filter(\.status.frees).map(\.itemId))
            inventory.items.removeAll { removed.contains($0.id) || ($0.parentId.map(removed.contains) ?? false) }
            if var disk = inventory.disk {
                disk.freeBytes = min(disk.totalBytes, disk.freeBytes + freed)
                inventory.disk = disk
                inventory.state = state(disk)
                inventory.aggressive = inventory.state != .ok
            }
            inventory.scannedAt = now
            machine.inventory = inventory
            machine.state = inventory.state
            machine.storage = summary(inventory, at: now)
        }
        let cleanup = StorageCleanup(id: id, machineId: machine.machineId, mode: mode, status: .completed, itemIds: itemIds, requestedAt: now, completedAt: now,
                                     result: StorageCleanupResult(dryRun: mode == .dryRun, freedBytes: freed, actions: actions))
        machine.cleanups.insert(cleanup, at: 0)
        return (machine, cleanup)
    }

    // MARK: Machines

    private static func id(_ seed: String) -> String {
        var hash: UInt64 = 1469598103934665603
        for byte in seed.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return "sti_" + String(format: "%016llx", hash) + "0000"
    }

    private static func make(_ machineId: String, name: String, disk: StorageDisk, items: [StorageItem], processes: [StorageProcess], now: Date) -> MachineStorage {
        let state = state(disk)
        let inventory = StorageInventory(scannedAt: now.addingTimeInterval(-6 * 60), disk: disk, state: state, aggressive: state != .ok, items: items, processes: processes)
        return MachineStorage(machineId: machineId, name: name, state: state, storage: summary(inventory, at: inventory.scannedAt), inventory: inventory)
    }

    static func mini(now: Date) -> MachineStorage {
        let day = 86_400.0
        var items: [StorageItem] = []
        // The operator's own T3 worktrees: 29 GB, inventory only, since foreign cleanup is off.
        let t3 = [("lumin-products", "feature-onboarding", 6.8), ("lumin-products", "fix-billing-race", 5.9), ("perpeto", "web-storage-screen", 4.7),
                  ("perpeto", "apple-pacing", 4.2), ("lumin-api", "search-v2", 3.9), ("lumin-api", "rate-limits", 3.5)]
        for (repo, branch, size) in t3 {
            let path = "~/.t3/worktrees/\(repo)/\(branch)"
            let parent = id(path)
            items.append(StorageItem(id: parent, kind: .t3Worktree, path: path, bytes: size * gb, lastModifiedAt: now.addingTimeInterval(-9 * day),
                                     gitState: StorageGitState(branch: branch, dirty: false, unpushedCommits: 0, merged: branch != "search-v2"), reclaimable: false,
                                     reason: "Not created by Perpeto; inventory only (cleanupForeignWorktrees is off).", repo: repo, ownedBy: "foreign"))
            items.append(StorageItem(id: id(path + "/node_modules"), kind: .buildArtifact, path: path + "/node_modules", bytes: size * 0.7 * gb,
                                     lastModifiedAt: now.addingTimeInterval(-9 * day), reclaimable: false, reason: "Inside a foreign worktree; stripForeignArtifacts is off.",
                                     parentId: parent, name: "node_modules", ownedBy: "foreign"))
        }
        // Perpeto's own worktrees: one merged and finished, one with unpushed work, one in use.
        let merged = "~/.perpeto/runtime/worktrees/perpeto/wi-queue-batching"
        items.append(StorageItem(id: id(merged), kind: .perpetoWorktree, path: merged, bytes: 2.6 * gb, lastModifiedAt: now.addingTimeInterval(-30 * 3600),
                                 owner: StorageOwner(runId: "run_live01", workItemId: "wi_03"), gitState: StorageGitState(branch: "wi-queue-batching", merged: true),
                                 reclaimable: true, action: .delete, reason: "Work is merged and no active work item uses it; idle 30 h.", repo: "perpeto", ownedBy: "perpeto"))
        let unpushed = "~/.perpeto/runtime/worktrees/perpeto/wi-session-warning"
        items.append(StorageItem(id: id(unpushed), kind: .perpetoWorktree, path: unpushed, bytes: 1.9 * gb, lastModifiedAt: now.addingTimeInterval(-52 * 3600),
                                 owner: StorageOwner(runId: "run_live01", workItemId: "wi_05"), gitState: StorageGitState(branch: "wi-session-warning", dirty: false, unpushedCommits: 2),
                                 reclaimable: false, reason: "Has 2 unpushed commits; review before deleting.", attention: true, repo: "perpeto", ownedBy: "perpeto"))
        items.append(StorageItem(id: id(unpushed + "/node_modules"), kind: .buildArtifact, path: unpushed + "/node_modules", bytes: 1.4 * gb,
                                 lastModifiedAt: now.addingTimeInterval(-52 * 3600), reclaimable: true, action: .strip, reason: "Git-ignored build output in a worktree idle for 52 h.",
                                 parentId: id(unpushed), name: "node_modules", ownedBy: "perpeto"))
        items.append(StorageItem(id: id(unpushed + "/dist"), kind: .buildArtifact, path: unpushed + "/dist", bytes: 180 * mb,
                                 lastModifiedAt: now.addingTimeInterval(-52 * 3600), reclaimable: true, action: .strip, reason: "Git-ignored build output in a worktree idle for 52 h.",
                                 parentId: id(unpushed), name: "dist", ownedBy: "perpeto"))
        let active = "~/.perpeto/runtime/worktrees/perpeto/wi-live-map"
        items.append(StorageItem(id: id(active), kind: .perpetoWorktree, path: active, bytes: 2.2 * gb, lastModifiedAt: now.addingTimeInterval(-120),
                                 owner: StorageOwner(runId: "run_live01", workItemId: "wi_07"), gitState: StorageGitState(branch: "wi-live-map", dirty: true),
                                 reclaimable: false, reason: "Its work item is still active.", repo: "perpeto", ownedBy: "perpeto"))
        let workspace = "~/.perpeto/node/assignments/asg_7f2c--a1--3be0a1c9"
        items.append(StorageItem(id: id(workspace), kind: .perpetoWorkspace, path: workspace, bytes: 840 * mb, lastModifiedAt: now.addingTimeInterval(-40 * 3600),
                                 owner: StorageOwner(runId: "run_live01", assignmentId: "asg_7f2c"), reclaimable: true, action: .delete,
                                 reason: "No running assignment uses it; idle 40 h.", ownedBy: "perpeto"))
        let ci = "$TMPDIR/perpeto-ci-Xk3P2a"
        items.append(StorageItem(id: id(ci), kind: .ciWorkspace, path: ci, bytes: 1.1 * gb, lastModifiedAt: now.addingTimeInterval(-26 * 3600), reclaimable: true,
                                 action: .delete, reason: "Left by a finished CI job; idle 26 h.", ownedBy: "perpeto"))
        // Shared caches: advisory, with the command that clears them.
        items.append(StorageItem(id: id("simulators"), kind: .globalCache, path: "~/Library/Developer/CoreSimulator/Devices", bytes: 55 * gb, approximate: true,
                                 lastModifiedAt: now.addingTimeInterval(-60 * day), reclaimable: false, reason: "Simulators for runtimes that are no longer installed.",
                                 advisory: true, hint: "xcrun simctl delete unavailable", name: "14 unavailable simulators", ownedBy: "system"))
        items.append(StorageItem(id: id("derived"), kind: .globalCache, path: "~/Library/Developer/Xcode/DerivedData", bytes: 18.4 * gb,
                                 lastModifiedAt: now.addingTimeInterval(-2 * day), reclaimable: false, reason: "Shared cache; clearing it is your call.", advisory: true,
                                 hint: "Remove folders in ~/Library/Developer/Xcode/DerivedData while Xcode is closed", name: "Xcode DerivedData", ownedBy: "system"))
        items.append(StorageItem(id: id("npm"), kind: .globalCache, path: "~/.npm/_cacache", bytes: 6.2 * gb, lastModifiedAt: now.addingTimeInterval(-3600),
                                 reclaimable: false, reason: "Shared cache; clearing it is your call.", advisory: true, hint: "npm cache clean --force", name: "npm cache", ownedBy: "system"))
        let processes = [
            StorageProcess(kind: .devServer, name: "vite", pid: 48211, elapsedSec: 4 * day + 3 * 3600, cwd: "~/.t3/worktrees/perpeto/old-landing", cwdMissing: true,
                           reason: "Its working directory no longer exists; it is likely orphaned.", hint: "kill 48211"),
            StorageProcess(kind: .devServer, name: "esbuild", pid: 48230, elapsedSec: 4 * day + 3 * 3600, cwd: "~/.t3/worktrees/perpeto/old-landing", cwdMissing: true,
                           reason: "Its working directory no longer exists; it is likely orphaned.", hint: "kill 48230"),
            StorageProcess(kind: .simulator, name: "iPhone 17 Pro", udid: "5C1A2B3D-0000-4E5F-8A9B-DEMO00000001", reason: "Booted simulator; each holds memory and disk while running.",
                           hint: "xcrun simctl shutdown 5C1A2B3D-0000-4E5F-8A9B-DEMO00000001"),
        ]
        return make(miniId, name: "Mac mini", disk: StorageDisk(totalBytes: 494 * gb, freeBytes: 19.8 * gb), items: items, processes: processes, now: now)
    }

    static func macbook(now: Date) -> MachineStorage {
        let base = "~/.perpeto/runtime/worktrees/lumin-products/wi-export-csv"
        let items = [
            StorageItem(id: id(base), kind: .perpetoWorktree, path: base, bytes: 3.1 * gb, lastModifiedAt: now.addingTimeInterval(-7 * 3600),
                        gitState: StorageGitState(branch: "wi-export-csv", merged: true), reclaimable: true, action: .delete,
                        reason: "Work is merged and no active work item uses it; idle 7 h.", repo: "lumin-products", ownedBy: "perpeto"),
            StorageItem(id: id("macbook-npm"), kind: .globalCache, path: "~/.npm/_cacache", bytes: 4.4 * gb, lastModifiedAt: now.addingTimeInterval(-2 * 3600),
                        reclaimable: false, reason: "Shared cache; clearing it is your call.", advisory: true, hint: "npm cache clean --force", name: "npm cache", ownedBy: "system"),
        ]
        return make(macbookId, name: "MacBook Pro", disk: StorageDisk(totalBytes: 994 * gb, freeBytes: 108 * gb), items: items, processes: [], now: now)
    }

    static func linux(now: Date) -> MachineStorage {
        let ci = "$TMPDIR/perpeto-ci-q8LmZt"
        let items = [
            StorageItem(id: id(ci), kind: .ciWorkspace, path: ci, bytes: 620 * mb, lastModifiedAt: now.addingTimeInterval(-25 * 3600), reclaimable: true, action: .delete,
                        reason: "Left by a finished CI job; idle 25 h.", ownedBy: "perpeto"),
        ]
        return make(linuxId, name: "build-linux-01", disk: StorageDisk(totalBytes: 1_000 * gb, freeBytes: 618 * gb), items: items, processes: [], now: now)
    }
}
