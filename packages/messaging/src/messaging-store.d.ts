export interface Receipt {
  state: 'stored' | 'delivered' | 'acked';
  deliveredAt: string | null;
  deliveredVia: 'prompt' | 'steer' | 'read' | null;
  /** Assignment that took delivery, when the host recorded one. */
  deliveredTo: string | null;
  ackedAt: string | null;
  ackNote: string | null;
}
export interface Message {
  id: string;
  projectId: string;
  channelId: string;
  senderRoleId: string;
  recipientRoleId: string | null;
  body: string;
  createdAt: string;
  /** Root message id; a root is its own thread. */
  threadId: string;
  parentId: string | null;
  senderKind: 'owner' | 'agent' | null;
  senderAssignmentId: string | null;
  /** Sent outside the run's messages edges under a `flag` messaging policy. */
  unplanned: boolean;
  /** Present for addressed messages; broadcasts have none. */
  receipt: Receipt | null;
}
export interface Channel { projectId: string; id: string; name: string }
export interface MessagePage { messages: Message[]; previousCursor: string | null; nextCursor: string | null; hasMore: boolean }
export interface Unread { roleId: string; messages: Message[]; unreadCount: number; lastReadMessageId: string | null }
export class MessagingError extends Error { code: string }
export class MessagingStore {
  constructor(filename: string, options?: { busyTimeoutMs?: number });
  close(): void;
  createProject(input: { id: string; name: string }): { id: string; name: string };
  createChannel(input: { projectId: string; id: string; name: string }): Channel;
  listChannels(input: { projectId: string }): Channel[];
  getMessage(input: { projectId: string; channelId: string; messageId: string }): Message;
  send(input: { projectId: string; channelId: string; senderRoleId: string; recipientRoleId?: string | null; body: string; idempotencyKey: string;
    parentId?: string | null; senderKind?: 'owner' | 'agent' | null; senderAssignmentId?: string | null; targetAssignmentId?: string | null; unplanned?: boolean }): { message: Message; duplicate: boolean };
  readMessages(input: { projectId: string; channelId: string; recipientRoleId?: string | null; threadId?: string | null; after?: string | null; before?: string | null; latest?: boolean; limit?: number }): MessagePage;
  claimPending(input: { projectId: string; channelId: string; roleId: string; assignmentId: string; activeAssignmentIds?: string[]; limit?: number }): Message[];
  markDelivered(input: { projectId: string; channelId: string; roleId: string; messageIds: string[]; via: 'prompt' | 'steer' | 'read'; assignmentId?: string | null }): Message[];
  ack(input: { projectId: string; channelId: string; messageId: string; roleId: string; note?: string | null }): { message: Message; changed: boolean };
  unread(input: { projectId: string; channelId: string; roleId: string; limit?: number }): Unread;
  markRead(input: { projectId: string; channelId: string; roleId: string; messageId: string }): { roleId: string; lastReadMessageId: string; unreadCount: number };
  countSentSince(input: { projectId: string; channelId: string; senderRoleId: string; since: string }): number;
}
