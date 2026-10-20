import { fetchFactoryMessaging, type FactoryMessagingRequest } from "@t3tools/client-runtime/state/factory-messaging";
import { createRuntimeCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

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
export interface MessagePage { messages: FactoryMessage[]; nextCursor: string | null; hasMore: boolean }

/** Cursor order comes from the server. Never append send responses ahead of unseen pages. */
export function appendMessagePage(current: FactoryMessage[], incoming: FactoryMessage[]): FactoryMessage[] {
  const seen = new Set(current.map((message) => message.id));
  return [...current, ...incoming.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  })];
}
