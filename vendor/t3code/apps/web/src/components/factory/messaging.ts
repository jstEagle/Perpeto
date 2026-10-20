import { fetchFactoryMessaging, type FactoryMessagingRequest } from "@t3tools/client-runtime/state/factory-messaging";
import { createRuntimeCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import messagingConfig from "./messaging.config.json";
export { messagingConfig };

const requestCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:factory:messaging",
  execute: fetchFactoryMessaging,
});

export async function messagingRequest<T>(input: FactoryMessagingRequest): Promise<T> {
  const result = await requestCommand.run(appAtomRegistry, input);
  if (result._tag === "Failure") {
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error("Messaging request failed. Retry or reconnect the environment.");
  }
  return result.value as T;
}

export interface FactoryChannel { projectId: string; id: string; name: string }
export interface FactoryMessage {
  id: string;
  projectId: string;
  channelId: string;
  senderRoleId: string;
  recipientRoleId: string | null;
  body: string;
  createdAt: string;
}
export interface MessagePage { messages: FactoryMessage[]; previousCursor: string | null; nextCursor: string | null; hasMore: boolean }

export const MESSAGE_PAGE_SIZE = messagingConfig.pageSize;
export const MESSAGE_WINDOW_LIMIT = messagingConfig.renderWindowLimit;
export interface MessageWindow {
  blocks: MessagePage[];
  hasOlder: boolean;
}
export const emptyMessageWindow = (): MessageWindow => ({ blocks: [], hasOlder: false });
export const windowMessages = (window: MessageWindow): FactoryMessage[] => window.blocks.flatMap((block) => block.messages);

/** Evict whole pages so the retained oldest/newest cursors always match visible history. */
export function applyMessageWindow(current: MessageWindow, page: MessagePage, direction: "latest" | "older" | "newer"): MessageWindow {
  if (direction === "latest") return { blocks: page.messages.length ? [page] : [], hasOlder: page.hasMore };
  const seen = new Set(windowMessages(current).map((message) => message.id));
  const messages = page.messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  if (!messages.length) return current;
  const block = { ...page, messages };
  const blocks = direction === "older" ? [block, ...current.blocks] : [...current.blocks, block];
  let count = blocks.reduce((total, item) => total + item.messages.length, 0);
  let trimmed = false;
  while (count > MESSAGE_WINDOW_LIMIT && blocks.length > 1) {
    const removed = direction === "older" ? blocks.pop() : blocks.shift();
    count -= removed!.messages.length;
    trimmed = true;
  }
  return { blocks, hasOlder: direction === "older" ? page.hasMore : current.hasOlder || trimmed };
}

/** Cursor order comes from the server. Never append send responses ahead of unseen pages. */
export function appendMessagePage(current: FactoryMessage[], incoming: FactoryMessage[]): FactoryMessage[] {
  const seen = new Set(current.map((message) => message.id));
  return [...current, ...incoming.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  })];
}
