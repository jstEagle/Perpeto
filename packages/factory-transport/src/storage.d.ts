export interface Message {
  id: string;
  projectId: string;
  channelId: string;
  senderRoleId: string;
  recipientRoleId: string | null;
  body: string;
  createdAt: string;
}
export interface Channel { projectId: string; id: string; name: string }
export interface MessagePage { messages: Message[]; nextCursor: string | null; hasMore: boolean }
export class MessagingError extends Error { code: string }
export class MessagingStore {
  constructor(filename: string, options?: { busyTimeoutMs?: number });
  close(): void;
  createProject(input: { id: string; name: string }): { id: string; name: string };
  createChannel(input: { projectId: string; id: string; name: string }): Channel;
  listChannels(input: { projectId: string }): Channel[];
  send(input: { projectId: string; channelId: string; senderRoleId: string; recipientRoleId?: string | null; body: string; idempotencyKey: string }): { message: Message; duplicate: boolean };
  readMessages(input: { projectId: string; channelId: string; recipientRoleId?: string | null; after?: string | null; limit?: number }): MessagePage;
}
