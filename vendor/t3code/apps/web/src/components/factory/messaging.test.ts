import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ createRuntimeCommand: () => ({}), squashAtomCommandFailure: vi.fn() }));
import { appendMessagePage, applyMessageWindow, emptyMessageWindow, windowMessages, MESSAGE_WINDOW_LIMIT, type MessagePage, type FactoryMessage } from "./messaging";
const message = (id: string): FactoryMessage => ({ id, projectId: "project", channelId: "channel", senderRoleId: "user", recipientRoleId: null, body: id, createdAt: "2026-10-20T00:00:00Z" });
describe("factory message history", () => {
  it("keeps cursor order and deduplicates overlapping and repeated page deliveries", () => {
    const original = [message("one"), message("two")];
    expect(appendMessagePage(original, [message("two"), message("three"), message("three")]).map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(original).toHaveLength(2);
  });
});

const page = (start: number, count = 100, hasMore = true): MessagePage => ({
  messages: Array.from({ length: count }, (_, index) => message(String(start + index))),
  previousCursor: `cursor-${start}`, nextCursor: `cursor-${start + count - 1}`, hasMore,
});
describe("bounded message windows", () => {
  it("starts with the newest page and retains an older boundary", () => {
    const window = applyMessageWindow(emptyMessageWindow(), page(900), "latest");
    expect(windowMessages(window)).toHaveLength(100);
    expect(window.blocks[0]?.previousCursor).toBe("cursor-900");
    expect(window.hasOlder).toBe(true);
  });
  it("bounds thousands of forward messages while preserving exact page cursors", () => {
    let window = applyMessageWindow(emptyMessageWindow(), page(0, 100, false), "latest");
    for (let index = 100; index < 3000; index += 100) window = applyMessageWindow(window, page(index), "newer");
    expect(windowMessages(window)).toHaveLength(MESSAGE_WINDOW_LIMIT);
    expect(windowMessages(window)[0]?.id).toBe("2500");
    expect(window.blocks[0]?.previousCursor).toBe("cursor-2500");
    expect(window.hasOlder).toBe(true);
  });
  it("bounds backward browsing by removing newest pages, never losing older cursor ownership", () => {
    let window = applyMessageWindow(emptyMessageWindow(), page(900), "latest");
    for (let index = 800; index >= 0; index -= 100) window = applyMessageWindow(window, page(index, 100, index > 0), "older");
    expect(windowMessages(window)).toHaveLength(MESSAGE_WINDOW_LIMIT);
    expect(windowMessages(window)[0]?.id).toBe("0");
    expect(windowMessages(window).at(-1)?.id).toBe("499");
    expect(window.blocks[0]?.previousCursor).toBe("cursor-0");
    expect(window.hasOlder).toBe(false);
  });
  it("repeated pages and empty polls preserve the existing window and its boundaries", () => {
    const window = applyMessageWindow(emptyMessageWindow(), page(100), "latest");
    expect(applyMessageWindow(window, page(100), "newer")).toBe(window);
    expect(applyMessageWindow(window, page(200, 0, false), "newer")).toBe(window);
    expect(windowMessages(window)).toHaveLength(100);
  });
});
