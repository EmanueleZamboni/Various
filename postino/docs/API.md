# Postino API contract (v1)

All endpoints are under `/api`. JSON in, JSON out. Auth is a session cookie
(`postino_session`, HttpOnly). Unauthenticated calls get `401 {"error":"unauthorized"}`.
Errors are `{ "error": "<code>", "message": "<human text>" }` with 4xx/5xx.

Times are ISO-8601 strings in UTC. IDs are strings.

## Shared types

```ts
type Address = { name: string; email: string };

type Account = {
  id: string;
  email: string;
  name: string;            // display name used in From
  color: string;           // hex, chosen by user or auto-assigned
  order: number;
  signature: string;       // plain text, may be ""
  status: "idle" | "syncing" | "connected" | "error" | "disabled";
  error: string | null;    // last error text
  unread: number;          // unread in inbox
  initialSync: { done: boolean; fetched: number; total: number } | null;
};

type Folder = {
  id: string;
  accountId: string;
  path: string;            // IMAP path e.g. "INBOX.spam"
  name: string;            // display name
  role: "inbox"|"sent"|"drafts"|"archive"|"junk"|"trash"|"blocked"|"other";
  unread: number;
  total: number;
};

type Category = "person" | "notification" | "newsletter";

type ThreadSummary = {
  id: string;
  accountId: string;
  subject: string;
  snippet: string;           // from newest message, plain text, <= 200 chars
  participants: Address[];   // unique, newest first, excludes own address when others exist
  lastFrom: Address;         // sender of the newest message
  lastDate: string;
  firstDate: string;
  count: number;             // messages in the thread (all folders)
  unread: boolean;
  pinned: boolean;           // any message \Flagged
  answered: boolean;
  hasAttachments: boolean;
  draft: boolean;            // has a local draft
  category: Category;        // of the newest incoming message
  folderRoles: Folder["role"][]; // roles the thread's messages are in
};

type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;              // bytes
  inline: boolean;           // referenced by cid in the html
  url: string;               // "/api/attachments/:id" (download), add "?inline=1" to view
};

type Message = {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  folderRole: Folder["role"];
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
  mine: boolean;             // sent from one of my accounts
  category: Category;
  snippet: string;
  attachments: Attachment[];
  listUnsubscribe: string | null; // mailto: or https: URL
  body: {
    html: string | null;     // sanitized, safe to put in a sandboxed iframe; remote images replaced (see below)
    text: string | null;     // plain text
    hasRemoteImages: boolean;
    quoted: string | null;   // the quoted/previous-reply part, split off from text when detectable
    fetched: boolean;        // false while the body is still being downloaded
  };
};
```

Remote images: in `body.html`, every remote `<img src>` is rewritten to
`<img data-remote-src="https://…" src="">` and `hasRemoteImages` is true. The client
swaps `data-remote-src` into `src` when the user chooses "Load images". `cid:` images
already point at `/api/attachments/:id?inline=1`.

## Setup and auth

- `GET /api/setup` → `{ needsSetup: boolean }` (true until a password exists). No auth.
- `POST /api/setup` `{ password }` → `204`. Only works while `needsSetup`. Sets the session cookie.
- `POST /api/login` `{ password, totp?: string }` → `204` and cookie; `401 {error:"bad_credentials"}`;
  `401 {error:"totp_required"}` when 2FA is on and `totp` is missing/wrong. Rate limited.
- `POST /api/logout` → `204`.
- `GET /api/me` → `{ ok: true, totpEnabled: boolean, vapidPublicKey: string }`.
- `POST /api/me/password` `{ current, next }` → `204`.
- `POST /api/me/totp/start` → `{ secret, otpauthUrl, qrDataUrl }`.
- `POST /api/me/totp/enable` `{ code }` → `204`.
- `POST /api/me/totp/disable` `{ password }` → `204`.

## Accounts and folders

- `GET /api/accounts` → `Account[]` (ordered).
- `POST /api/accounts` `{ email, name, password, imap: {host, port, secure}, smtp: {host, port, secure}, username?, color? }`
  → `Account`. Tests IMAP + SMTP login before saving; on failure `400 {error:"imap_login_failed"|"smtp_login_failed", message}`.
  Sync starts right away.
- `POST /api/accounts/test` same body → `{ ok: true }` or the same 400 errors (nothing saved).
- `PATCH /api/accounts/:id` `{ name?, color?, signature?, order?, password?, imap?, smtp? }` → `Account`.
- `DELETE /api/accounts/:id` → `204` (removes local data only; the mailbox is untouched).
- `POST /api/accounts/:id/resync` → `202` (full re-sync in the background).
- `GET /api/folders` → `Folder[]` for all accounts.
- `GET /api/presets?email=x@y.it` → `{ imap: {host,port,secure}, smtp: {host,port,secure}, username } | null`
  (known providers: vhosting servers, Gmail, iCloud, Outlook… guessed from the domain's MX when unknown).

## Threads (the list)

`GET /api/threads` query params:

| param | meaning |
|---|---|
| `view` | `inbox` (default), `pinned`, `sent`, `drafts`, `archive`, `junk` (= Junk + INBOX.spam), `trash`, `blocked`, `all`, or `folder:<folderId>` |
| `account` | account id, omit for all accounts |
| `category` | `person`, `notification`, `newsletter` (inbox only) |
| `unread` | `1` to only list unread |
| `before` | cursor from the previous page (`nextCursor`) |
| `limit` | default 50, max 200 |

→ `{ threads: ThreadSummary[], nextCursor: string | null, counts: { unread: number, total: number } }`.
Sorted by `lastDate` desc. For `view=inbox` the `counts` are for the whole view, not the page.

- `GET /api/threads/:id` → `{ thread: ThreadSummary, messages: Message[] }` oldest first.
  Bodies of messages not yet fetched come with `body.fetched=false`; the server fetches
  them right away and emits a `message.updated` event.
- `GET /api/threads/:id/messages/:messageId` → `Message` (same shape, used to refetch one).

## Actions

All actions are optimistic on the server (the local DB updates at once, the IMAP change
runs in the background; a failure emits `action.failed` with the reversed state).

`POST /api/threads/actions` body:

```ts
{
  threadIds: string[];
  action: "read" | "unread" | "pin" | "unpin" | "archive" | "trash" | "junk" | "notjunk"
        | "inbox" | "delete" /* permanent, only from trash/junk */ | "move";
  folderId?: string;        // for "move"
  scope?: "view" | "all";   // which messages of the thread: those in the current view's folder role (default) or all
  view?: string;            // the view the user is looking at, needed for scope "view"
}
```
→ `{ ok: true, affected: number }`.

`POST /api/messages/actions` same but `messageIds: string[]` (acts on single messages).

## Blocking

- `GET /api/blocked` → `{ senders: { id, pattern, note, createdAt, count }[] }`.
  `pattern` is an email (`x@y.com`) or a domain (`@y.com`).
- `POST /api/blocked` `{ pattern, note? }` → the new entry. Existing inbox mail from that
  sender, in every account, moves to the `Blocked` folder right away (created on the server when missing).
  New mail from the sender is moved there on arrival, even when the app is closed.
- `DELETE /api/blocked/:id` → `204` (the mail stays where it is).
- `POST /api/blocked/:id/restore` → `{ moved: number }` moves that sender's mail from Blocked back to Inbox.

## Search

`GET /api/search?q=<query>&account=<id>&limit=50&before=<cursor>` → same shape as `/api/threads`,
plus `highlights: { [threadId]: string }` (snippet with `<mark>` around hits, HTML-escaped otherwise).

Query syntax (all optional, combinable, like Gmail):
`from:anna`, `to:info@`, `subject:fattura`, `has:attachment`, `is:unread`, `is:pinned`,
`in:inbox|sent|archive|junk|trash|blocked`, `account:stostudio`, `before:2026-10-01`,
`after:2026-09-01`, `newer_than:7d`, `"exact phrase"`, `-excluded`. Free words match
subject, sender, recipients and body, with prefix matching (`fatt` finds `fattura`),
accent-insensitive, ranked (subject and sender hits rank higher).

`GET /api/search/suggest?q=an` → `{ contacts: Address[], recent: string[] }` for the search box.

## Compose and send

- `POST /api/send` multipart/form-data or JSON:
  ```ts
  {
    accountId: string;
    to: string;            // comma separated, "Name <a@b>" allowed
    cc?: string; bcc?: string;
    subject: string;
    text: string;          // plain text body
    html?: string;         // optional rich body; when absent the server builds html from text
    inReplyTo?: string;    // message id (our id, not RFC) being replied to → sets In-Reply-To/References, marks \Answered
    forwardOf?: string;    // message id being forwarded → original attachments are included
    draftId?: string;      // delete this draft after sending
    attachments?: File[];  // multipart files (field name "attachments")
  }
  ```
  → `{ ok: true, messageId: string, threadId: string }`. The sent copy is appended to the account's Sent folder.
- `GET /api/messages/:id/reply?mode=reply|replyAll|forward` → `{ to, cc, subject, quotedText, quotedHtml, accountId }` prefilled values.
- `GET /api/drafts` → `Draft[]`; `POST /api/drafts` → `Draft`; `PUT /api/drafts/:id` → `Draft`; `DELETE /api/drafts/:id` → `204`.
  `Draft = { id, accountId, to, cc, bcc, subject, text, inReplyTo, threadId, updatedAt }`.
- `GET /api/contacts?q=ann&limit=8` → `Address[]` (people you've exchanged mail with, most frequent first).

## Attachments

- `GET /api/attachments/:id` → the file (Content-Disposition: attachment).
- `GET /api/attachments/:id?inline=1` → inline (images, PDFs).
- `POST /api/messages/:id/unsubscribe` → `{ ok: true, method: "mailto" | "http" | "none", url? }`.
  Uses the List-Unsubscribe header (sends the mailto or opens the URL via the client).

## Settings and notifications

- `GET /api/settings` → `{ notifications: { enabled: boolean, categories: Category[] }, smartInbox: boolean, swipe: { left: Action, right: Action }, signaturePerAccount: boolean }`.
- `PUT /api/settings` partial object → full object.
- `POST /api/push/subscribe` `{ subscription: PushSubscription }` → `204`.
- `DELETE /api/push/subscribe` `{ endpoint }` → `204`.
- `POST /api/push/test` → `204` (sends a test notification to every subscription).

## Live updates

`GET /api/events` is Server-Sent Events. Events (`event:` name, JSON `data`):

- `thread.updated` `{ threadId, accountId }` (list rows should refetch)
- `thread.removed` `{ threadId }`
- `message.updated` `{ messageId, threadId }`
- `account.updated` `Account`
- `folder.updated` `Folder`
- `sync.progress` `{ accountId, fetched, total, done }`
- `action.failed` `{ message }`
- `new.mail` `{ threadId, accountId, from: Address, subject, category }`

Clients reconnect on close; the server sends `: ping` every 25 s.

## Push payload

Web push sends `{ title, body, threadId, accountId, tag }`. The service worker shows a
notification and opens `/t/<threadId>` on click.

## Health

- `GET /api/health` → `{ ok: true, accounts: number, uptime: number }` (no auth).
