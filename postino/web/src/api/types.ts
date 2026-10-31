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
  aliases?: string[];
  folders?: Record<string, string>;
  notify?: 'default' | 'all' | 'people' | 'none';
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
  knownSender?: boolean;
  calendar?: CalendarEvent | null;
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
  forwardOf?: string | null;
  fromAddress?: string | null;
  attachments?: { id: string; filename: string; size: number }[];
  threadId: string | null;
  updatedAt: string;
};

export type Template = { id: string; name: string; subject: string; text: string; updatedAt: string };

export type Signature = {
  id: string;
  accountId: string;
  name: string;
  html: string;
  text: string;
  isDefault: boolean;
  updatedAt: string;
};

export type ReplyPrefill = {
  fromAddress?: string | null;
  to: string;
  cc: string;
  subject: string;
  quotedText: string;
  quotedHtml: string;
  accountId: string;
};

export type SwipeAction = 'archive' | 'pin' | 'trash' | 'read' | 'junk';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type Settings = {
  notifications: { enabled: boolean; categories: Category[]; sound: boolean };
  inbox: { smart: boolean; groupNotifications: boolean; groupNewsletters: boolean; previewLines: 0 | 1 | 2; showAvatars: boolean; showAccountTag: boolean; pinnedOnTop: boolean };
  reading: { markRead: 'open' | 'delay' | 'manual'; markReadDelay: number; remoteImages: 'ask' | 'always' | 'contacts'; afterAction: 'next' | 'previous' | 'list'; confirmDelete: boolean; showQuoted: boolean };
  compose: { defaultAccount: string; replyFromRecipient: boolean; defaultReply: 'reply' | 'replyAll'; includeQuote: boolean; undoSendSec: 0 | 5 | 10 | 20 | 30; sendAndArchive: boolean; bccMyself: boolean; confirmNoSubject: boolean };
  swipe: { left: SwipeAction; right: SwipeAction };
  appearance: { density: 'comfortable' | 'compact'; textSize: 'normal' | 'large'; readingPane: 'full' | 'side' };
  smartInbox: boolean;
  signaturePerAccount: boolean;
};

export type OutboxItem = { id: string; accountId: string; to: string; cc: string; subject: string; text: string; sendAt: string; status: string; error: string | null; threadId: string | null; createdAt: string };

export type Me = { ok: true; totpEnabled: boolean; passkeys: number; vapidPublicKey: string };

export type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; syncedToCloud: boolean };

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

export type CalendarEvent = {
  method: string;
  summary: string;
  description: string;
  location: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  organizer: { name: string; email: string } | null;
  attendees: { name: string; email: string; status: string }[];
  uid: string;
  url: string;
  googleLink: string | null;
};

export type PendingMailbox = {
  email: string;
  name: string;
  color: string;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
};
export type BackupStatus = { driveConnected: boolean; lastDrive: string | null; lastDriveError: string | null; pendingMailboxes: PendingMailbox[] };
