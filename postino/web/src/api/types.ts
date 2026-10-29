// Types mirror docs/API.md exactly.

export type Address = { name: string; email: string };

export type AccountStatus = 'idle' | 'syncing' | 'connected' | 'error' | 'disabled';

export type Account = {
  id: string;
  email: string;
  name: string;
  color: string;
  order: number;
  signature: string;
  status: AccountStatus;
  error: string | null;
  unread: number;
  initialSync: { done: boolean; fetched: number; total: number } | null;
};

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'blocked' | 'other';

export type Folder = {
  id: string;
  accountId: string;
  path: string;
  name: string;
  role: FolderRole;
  unread: number;
  total: number;
};

export type Category = 'person' | 'notification' | 'newsletter';

export type ThreadSummary = {
  id: string;
  accountId: string;
  subject: string;
  snippet: string;
  participants: Address[];
  lastFrom: Address;
  lastDate: string;
  firstDate: string;
  count: number;
  unread: boolean;
  pinned: boolean;
  answered: boolean;
  hasAttachments: boolean;
  draft: boolean;
  category: Category;
  folderRoles: FolderRole[];
};

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  url: string;
};

export type MessageBody = {
  html: string | null;
  text: string | null;
  hasRemoteImages: boolean;
  quoted: string | null;
  fetched: boolean;
};

export type Message = {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  folderRole: FolderRole;
  messageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  mine: boolean;
  category: Category;
  snippet: string;
  attachments: Attachment[];
  listUnsubscribe: string | null;
  body: MessageBody;
};

export type ThreadsResponse = {
  threads: ThreadSummary[];
  nextCursor: string | null;
  counts: { unread: number; total: number };
  highlights?: Record<string, string>;
};

export type ThreadDetail = { thread: ThreadSummary; messages: Message[] };

export type ThreadAction =
  | 'read'
  | 'unread'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'trash'
  | 'junk'
  | 'notjunk'
  | 'inbox'
  | 'delete'
  | 'move';

export type BlockedSender = { id: string; pattern: string; note: string; createdAt: string; count: number };

export type Draft = {
  id: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  threadId: string | null;
  updatedAt: string;
};

export type ReplyPrefill = {
  to: string;
  cc: string;
  subject: string;
  quotedText: string;
  quotedHtml: string;
  accountId: string;
};

export type SwipeAction = 'archive' | 'pin' | 'trash' | 'read' | 'junk';

export type Settings = {
  notifications: { enabled: boolean; categories: Category[] };
  smartInbox: boolean;
  swipe: { left: SwipeAction; right: SwipeAction };
  signaturePerAccount: boolean;
};

export type Me = { ok: true; totpEnabled: boolean; vapidPublicKey: string };

export type ServerPreset = {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username: string;
};

export type AccountInput = {
  email: string;
  name: string;
  password: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username?: string;
  color?: string;
};

export type View =
  | 'inbox'
  | 'pinned'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'junk'
  | 'trash'
  | 'blocked'
  | 'all'
  | `folder:${string}`;

export type ServerEvent =
  | { type: 'thread.updated'; threadId: string; accountId: string }
  | { type: 'thread.removed'; threadId: string }
  | { type: 'message.updated'; messageId: string; threadId: string }
  | { type: 'account.updated'; account: Account }
  | { type: 'folder.updated'; folder: Folder }
  | { type: 'sync.progress'; accountId: string; fetched: number; total: number; done: boolean }
  | { type: 'action.failed'; message: string }
  | { type: 'new.mail'; threadId: string; accountId: string; from: Address; subject: string; category: Category };
