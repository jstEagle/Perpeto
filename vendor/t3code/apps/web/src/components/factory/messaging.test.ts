import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ createRuntimeCommand: () => ({}), squashAtomCommandFailure: vi.fn() }));
import { appendMessagePage, type FactoryMessage } from "./messaging";
const message = (id: string): FactoryMessage => ({ id, projectId: "project", channelId: "channel", senderRoleId: "user", recipientRoleId: null, body: id, createdAt: "2026-10-20T00:00:00Z" });
describe("factory message history", () => {
  it("keeps cursor order and deduplicates overlapping and repeated page deliveries", () => {
    const original = [message("one"), message("two")];
    expect(appendMessagePage(original, [message("two"), message("three"), message("three")]).map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(original).toHaveLength(2);
  });
});
