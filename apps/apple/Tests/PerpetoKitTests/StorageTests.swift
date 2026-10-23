import Foundation
import Testing
@testable import PerpetoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try HubCoding.decoder().decode(T.self, from: Data(json.utf8))
}

private let fleetJSON = """
{ "machines": [
    { "machineId": "mch_mini", "name": "Mac mini", "status": "online", "online": true, "state": "critical",
      "storage": { "scannedAt": "2026-10-23T03:00:00.000Z", "state": "critical", "disk": { "totalBytes": 494000000000, "freeBytes": "19800000000" },
        "truncated": false, "reclaimableBytes": 6300000000, "reclaimableByKind": { "perpeto-worktree": 2600000000, "build-artifact": 1580000000, "ci-workspace": 1100000000, "mystery": 5, "bad": "x" },
        "advisoryBytes": 79600000000, "attentionCount": 1, "staleProcesses": 3, "items": 22,
        "top": [{ "id": "sti_0123456789abcdef0000", "kind": "perpeto-worktree", "path": "~/.perpeto/runtime/worktrees/perpeto/wi-x", "bytes": 2600000000, "reclaimable": true },
                { "kind": "ci-workspace" }] },
      "lastCleanup": { "id": "auto_x1", "mode": "execute", "status": "completed", "source": "auto", "freedBytes": 1200, "at": "2026-10-23T02:00:00Z" } },
    { "machineId": "mch_new", "name": "Fresh box", "online": false, "storage": null },
    { "name": "no id, dropped" }
  ],
  "totals": { "totalBytes": 494000000000, "freeBytes": 19800000000, "reclaimableBytes": 6300000000, "advisoryBytes": 79600000000, "attentionCount": 1,
              "reclaimableByKind": { "perpeto-worktree": 2600000000 } },
  "alerts": [{ "machineId": "mch_mini", "name": "Mac mini", "state": "critical", "severity": "critical", "evidence": "4% free; new agent work is paused on this machine", "freePercent": 4 }],
  "policy": { "autoClean": true } }
"""

private let machineJSON = """
{ "machineId": "mch_mini", "name": "Mac mini", "online": true, "state": "low",
  "inventory": { "scannedAt": "2026-10-23T03:00:00Z", "truncated": true, "disk": { "totalBytes": 100, "freeBytes": 10 }, "state": "low", "aggressive": true,
    "items": [
      { "id": "sti_aaaaaaaaaaaaaaaaaaaa", "kind": "perpeto-worktree", "path": "~/w/merged", "bytes": 50, "lastModifiedAt": "2026-10-21T00:00:00Z", "owner": { "runId": "run_1" },
        "gitState": { "branch": "merged", "dirty": false, "unpushedCommits": 0, "merged": true }, "reclaimable": true, "action": "delete", "reason": "Merged." },
      { "id": "sti_bbbbbbbbbbbbbbbbbbbb", "kind": "build-artifact", "path": "~/w/merged/node_modules", "bytes": 30, "reclaimable": true, "action": "strip", "parentId": "sti_aaaaaaaaaaaaaaaaaaaa", "reason": "Ignored." },
      { "id": "sti_cccccccccccccccccccc", "kind": "perpeto-worktree", "path": "~/w/unpushed", "bytes": 20, "gitState": { "dirty": false, "unpushedCommits": "2" }, "reclaimable": false, "attention": true, "reason": "Has 2 unpushed commits." },
      { "id": "sti_dddddddddddddddddddd", "kind": "global-cache", "path": "~/.npm/_cacache", "bytes": 9, "approximate": true, "reclaimable": false, "advisory": true, "hint": "npm cache clean --force", "name": "npm cache", "reason": "Shared." },
      { "id": "sti_eeeeeeeeeeeeeeeeeeee", "kind": "quantum-cache", "path": "~/q", "bytes": 1, "reclaimable": false, "reason": "?" },
      { "id": "sti_missing_path" }
    ],
    "processes": [{ "kind": "dev-server", "name": "vite", "pid": 4821, "elapsedSec": 360000, "cwd": "~/gone", "cwdMissing": true, "reason": "Orphaned.", "hint": "kill 4821" },
                  { "kind": "simulator", "name": "iPhone 17", "udid": "U-1", "reason": "Booted." }, { "kind": "toaster" }] },
  "cleanups": [{ "id": "scl_1", "machineId": "mch_mini", "mode": "dry-run", "status": "completed", "source": "owner", "requestedAt": "2026-10-23T03:01:00Z",
                 "result": { "dryRun": true, "freedBytes": 50, "actions": [{ "itemId": "sti_aaaaaaaaaaaaaaaaaaaa", "kind": "perpeto-worktree", "path": "~/w/merged", "action": "delete", "bytes": 50, "status": "would-delete" },
                   { "itemId": "sti_cccccccccccccccccccc", "bytes": 20, "status": "needs-attention", "reason": "Changed since the scan." }, { "status": "deleted" }] } }] }
"""

@Suite("Storage decoding")
struct StorageDecodingTests {
    @Test func readsTheFleet() throws {
        let fleet = try decode(FleetStorage.self, fleetJSON)
        #expect(fleet.machines.map(\.machineId) == ["mch_mini", "mch_new"])
        let mini = fleet.machines[0]
        #expect(mini.state == .critical)
        let summary = try #require(mini.storage)
        #expect(summary.disk?.freeBytes == 19_800_000_000)
        #expect(abs((summary.disk?.freeFraction ?? 0) - 0.04) < 0.001)
        #expect(summary.reclaimableByKind.bytes[.perpetoWorktree] == 2_600_000_000)
        #expect(summary.reclaimableByKind.bytes[.other] == 5)
        #expect(summary.reclaimableByKind.sorted.first?.kind == .perpetoWorktree)
        #expect(summary.top.count == 1)
        #expect(summary.staleProcesses == 3)
        #expect(mini.lastCleanup?.source == "auto")
        #expect(fleet.machines[1].storage == nil)
        #expect(fleet.machines[1].state == .ok)
        #expect(fleet.alerts.first?.state == .critical)
        #expect(fleet.totals.reclaimableBytes == 6_300_000_000)
        #expect(fleet.byUrgency.first?.name == "Mac mini")
    }

    @Test func totalsFallBackToTheMachines() throws {
        let fleet = try decode(FleetStorage.self, #"{"machines":[{"machineId":"m","name":"m","storage":{"scannedAt":"2026-10-23T03:00:00Z","disk":{"totalBytes":100,"freeBytes":40},"reclaimableBytes":7,"reclaimableByKind":{"ci-workspace":7}}}]}"#)
        #expect(fleet.totals.totalBytes == 100)
        #expect(fleet.totals.freeBytes == 40)
        #expect(fleet.totals.reclaimableByKind.bytes[.ciWorkspace] == 7)
        #expect(fleet.alerts.isEmpty)
    }

    @Test func readsAMachineInventory() throws {
        let machine = try decode(MachineStorage.self, machineJSON)
        let inventory = try #require(machine.inventory)
        #expect(inventory.items.count == 5, "an item without a path is dropped")
        #expect(inventory.items[4].kind == .other)
        #expect(inventory.truncated)
        #expect(inventory.reclaimable.map(\.id) == ["sti_aaaaaaaaaaaaaaaaaaaa"], "artifacts inside a deleted worktree fold into it")
        #expect(inventory.reclaimableBytes == 50)
        #expect(inventory.needsAttention.first?.gitState?.unpushedCommits == 2)
        #expect(inventory.advisory.first?.hint == "npm cache clean --force")
        #expect(inventory.advisory.first?.title == "npm cache")
        #expect(inventory.items[0].owner.runId == "run_1")
        #expect(inventory.items[0].gitState?.merged == true)
        #expect(inventory.processes.count == 3)
        #expect(inventory.processes[2].kind == .other)
        #expect(inventory.processes[0].cwdMissing)
        let cleanup = try #require(machine.cleanups.first)
        #expect(cleanup.mode == .dryRun)
        #expect(cleanup.isDone)
        let result = try #require(cleanup.result)
        #expect(result.actions.count == 2)
        #expect(result.freeing.map(\.status) == [.wouldDelete])
        #expect(result.held.first?.status == .needsAttention)
    }

    @Test func formatsBytesLikeTheFinder() {
        #expect(StorageText.bytes(0) == "0 B")
        #expect(StorageText.bytes(999) == "999 B")
        #expect(StorageText.bytes(29_400_000_000) == "29.4 GB")
        #expect(StorageText.bytes(812_000_000) == "812 MB")
        #expect(StorageText.bytes(4_000) == "4 KB")
        #expect(StorageText.percent(0.04) == "4%")
        #expect(StorageText.percent(0.038) == "3.8%")
        #expect(StorageText.gitLine(StorageGitState(branch: "x", dirty: true, unpushedCommits: 1)) == "x · uncommitted changes · 1 unpushed commit")
    }
}

@Suite("Storage client")
struct StorageClientTests {
    let token = "secret-owner-token-123"

    @Test func fleetIsOptionalOnOlderHubs() async throws {
        let stub = StubTransport { _ in (404, #"{"error":{"code":"NOT_FOUND","message":"Route not found."}}"#) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        #expect(try await client.fleetStorage() == nil)
        #expect(stub.requests.first?.url?.path == "/api/v1/storage")
    }

    @Test func requestsAndFollowsACleanup() async throws {
        let stub = StubTransport { request in
            if request.httpMethod == "POST" {
                return (202, #"{"cleanup":{"id":"scl_9","machineId":"mch_1","mode":"execute","status":"pending","itemIds":["sti_aaaaaaaaaaaaaaaaaaaa"]}}"#)
            }
            return (200, #"{"cleanup":{"id":"scl_9","machineId":"mch_1","mode":"execute","status":"completed","result":{"dryRun":false,"freedBytes":50,"actions":[]}}}"#)
        }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        let cleanup = try await client.requestCleanup(machineId: "mch_1", mode: .execute, itemIds: ["sti_aaaaaaaaaaaaaaaaaaaa"], idempotencyKey: "k-1")
        #expect(cleanup.status == .pending)
        let request = try #require(stub.requests.first)
        #expect(request.url?.path == "/api/v1/machines/mch_1/storage/cleanup")
        let body = try #require(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        #expect(body["mode"] as? String == "execute")
        #expect(body["itemIds"] as? [String] == ["sti_aaaaaaaaaaaaaaaaaaaa"])
        #expect(body["idempotencyKey"] as? String == "k-1")
        let done = try await client.storageCleanup(machineId: "mch_1", cleanupId: "scl_9")
        #expect(done.isDone)
        #expect(stub.requests.last?.url?.path == "/api/v1/machines/mch_1/storage/cleanups/scl_9")
    }

    @Test func dryRunWithoutItemsSendsOnlyTheMode() async throws {
        let stub = StubTransport { _ in (202, #"{"cleanup":{"id":"scl_1","machineId":"m","mode":"dry-run","status":"pending"}}"#) }
        let client = try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: token, transport: stub)
        _ = try await client.requestCleanup(machineId: "m", mode: .dryRun)
        let body = try #require(JSONSerialization.jsonObject(with: stub.requests.first?.httpBody ?? Data()) as? [String: Any])
        #expect(body["mode"] as? String == "dry-run")
        #expect(body["itemIds"] == nil)
    }
}

@Suite("Storage demo")
struct StorageDemoTests {
    let now = HubCoding.parseDate("2026-10-23T03:00:00Z")!

    @Test func fleetLeadsWithTheFullMacMini() {
        let fleet = DemoStorage.fleet(now: now)
        #expect(fleet.byUrgency.map(\.state) == [.critical, .low, .ok])
        let mini = fleet.byUrgency[0]
        #expect(mini.name == "Mac mini")
        #expect((mini.storage?.disk?.freeFraction ?? 1) < 0.05)
        #expect(fleet.alerts.map(\.state) == [.critical, .low])
        let machines = DemoStorage.machines(now: now)
        let inventory = machines[0].inventory!
        let t3 = inventory.items.filter { $0.kind == .t3Worktree }.reduce(0) { $0 + $1.bytes }
        #expect(abs(t3 - 29_000_000_000) < 1_000_000_000, "about 29 GB of T3 worktrees")
        #expect(inventory.items.filter { $0.kind == .t3Worktree }.allSatisfy { !$0.reclaimable })
        #expect(inventory.needsAttention.count == 1)
        #expect(inventory.advisory.contains { $0.hint == "xcrun simctl delete unavailable" })
        #expect(inventory.processes.contains { $0.name == "vite" && $0.cwdMissing })
        #expect(inventory.items.allSatisfy { $0.id.range(of: #"^sti_[a-f0-9]{20}$"#, options: .regularExpression) != nil })
    }

    @Test func previewThenExecute() {
        let mini = DemoStorage.machines(now: now)[0]
        let before = mini.inventory!.reclaimableBytes
        let (previewed, preview) = DemoStorage.clean(mini, id: "scl_a", mode: .dryRun, itemIds: nil, now: now)
        #expect(previewed.inventory == mini.inventory, "a dry run changes nothing")
        #expect(preview.result?.freedBytes == before)
        #expect(preview.result?.freeing.allSatisfy { $0.status == .wouldDelete || $0.status == .wouldStrip } == true)

        let ids = preview.result!.freeing.map(\.itemId) + [mini.inventory!.needsAttention[0].id]
        let (cleaned, done) = DemoStorage.clean(previewed, id: "scl_b", mode: .execute, itemIds: ids, now: now)
        #expect(done.result?.freedBytes == before)
        #expect(done.result?.held.first?.status == .skipped, "work needing attention is never deleted")
        #expect(cleaned.inventory!.reclaimable.isEmpty)
        #expect(cleaned.inventory!.needsAttention.count == 1)
        #expect(cleaned.inventory!.disk!.freeBytes == mini.inventory!.disk!.freeBytes + before)
        #expect(cleaned.cleanups.map(\.id) == ["scl_b", "scl_a"])
    }

    @Test @MainActor func storeRunsACleanupThroughTheDemoSource() async throws {
        let store = FactoryStore(source: DemoDataSource(stageDelay: .zero))
        await store.refresh()
        let fleet = try #require(store.factory.storage)
        let mini = try #require(fleet.byUrgency.first)
        await store.loadMachineStorage(mini.machineId)
        #expect(store.machineStorage[mini.machineId]?.inventory != nil)
        let preview = await store.cleanStorage(machineId: mini.machineId, mode: .dryRun, pollInterval: .milliseconds(1))
        #expect(preview?.result?.dryRun == true)
        let executed = await store.cleanStorage(machineId: mini.machineId, mode: .execute, itemIds: preview?.result?.freeing.map(\.itemId), pollInterval: .milliseconds(1))
        #expect(executed?.isDone == true)
        #expect(store.factory.storage?.totals.reclaimableBytes ?? 1 < fleet.totals.reclaimableBytes)
        #expect(store.machineStorage[mini.machineId]?.inventory?.reclaimable.isEmpty == true)
        #expect(store.lastError == nil)
    }
}
