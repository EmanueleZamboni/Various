# Postino web app

React 19 + TypeScript + Vite. One stylesheet, no component library, no Tailwind.
The UI talks only to the API described in `../docs/API.md`.

## Run

```sh
# against the real server (expects it on http://127.0.0.1:8025, proxied under /api)
npm run dev -w web

# with the built-in mock API (no server needed; login password is "password")
VITE_MOCK=1 npm run dev -w web

npm run build -w web     # typecheck + production build into web/dist (served by the server)
```

## Structure

```
src/
  main.tsx            boots mock mode (VITE_MOCK=1), registers the service worker, mounts the app
  App.tsx             auth gate (setup / login / app) and routes
  nav.ts              URL state: /:view(/t/:threadId)?account=&q=   (views: inbox, pinned, sent, drafts,
                      archive, junk, trash, blocked, all, folder:<id>, search, settings)
  store.ts            zustand UI state: smart/all, drawer, keyboard order, compose, toasts, sheets
  api/types.ts        the API contract types (mirror of docs/API.md)
  api/client.ts       fetch wrapper (`api.*`), ApiError
  api/hooks.ts        react-query hooks; useThreadActions = optimistic actions + Undo toast
  api/events.ts       SSE subscription → cache invalidation + new-mail toasts
  mock/               in-app mock API (fetch interceptor + fake EventSource + realistic data)
  components/
    Shell.tsx         3-pane layout, keyboard shortcuts, FAB, mounts overlays
    Sidebar.tsx       compose button, folders, accounts, settings (drawer on tablet/phone)
    ThreadList.tsx    list pane: title, Smart/All, search, account chips, People / bundles / day groups,
                      infinite scroll, search results with highlights
    ThreadRow.tsx     a conversation row: unread, count, attachment, pin, account tag, hover actions,
                      touch swipe (left = archive, right = pin)
    SearchBar.tsx     operator hints, from:/to: contact suggestions, recent searches
    Reader.tsx        thread view: action bar, message cards (collapsed/expanded), sandboxed HTML
                      iframe (HtmlBody), Load images, quoted text, attachments, unsubscribe, phone bottom bar
    ReplyBox.tsx      inline Reply / Reply all / Forward with prefill, attachments, draft autosave
    Compose.tsx       full compose modal (From picker, To/Cc/Bcc with suggestions, drag-drop files,
                      draft autosave, ⌘Enter to send)
    AddressInput.tsx  comma-separated address field with /api/contacts suggestions
    Sheets.tsx        Block sender confirm (address or whole domain), Move to folder, Shortcuts
    BlockedList.tsx   the Blocked senders view (unblock, restore mail)
    Settings.tsx      accounts (add with /api/presets autofill + test), notifications (web push),
                      preferences (smart inbox, swipe actions), security (password, 2FA)
    Auth.tsx          first-run setup and login (password + optional TOTP)
    Toasts.tsx
  push.ts             web push subscribe/unsubscribe helpers
  sw.ts               service worker (workbox): app-shell precache, network-first /api reads,
                      push + notificationclick → /t/<threadId>
  icons.tsx           inline SVG icon set
  util/format.ts      dates, names, initials, sizes, address parsing, accountLabel()
  styles/app.css      design tokens + all styles (light theme only); design plan in the header comment
```

## Screens → API

| Screen | Endpoints |
|---|---|
| Inbox (Smart) | `GET /api/threads?view=inbox&category=person`, `…&category=notification`, `…&category=newsletter` |
| Inbox (All) / folders | `GET /api/threads?view=<view>&account=<id>&before=<cursor>` |
| Search | `GET /api/search?q=…`, `GET /api/search/suggest?q=…` |
| Thread | `GET /api/threads/:id`, `POST /api/threads/actions`, `GET /api/messages/:id/reply?mode=…`, `POST /api/messages/:id/unsubscribe` |
| Compose / reply | `POST /api/send` (multipart), `GET /api/contacts?q=…`, `POST/PUT/DELETE /api/drafts` |
| Block sender | `POST /api/blocked`, `DELETE /api/blocked/:id`, `POST /api/blocked/:id/restore` |
| Sidebar counts | `GET /api/accounts`, `GET /api/folders`, `GET /api/blocked` |
| Live updates | `GET /api/events` (SSE) |
| Settings | `/api/accounts*`, `/api/presets`, `/api/settings`, `/api/push/*`, `/api/me/*` |
| Auth | `GET/POST /api/setup`, `POST /api/login`, `POST /api/logout`, `GET /api/me` |

## Mock mode

`VITE_MOCK=1` replaces `window.fetch` for `/api/*` and `window.EventSource` with an in-memory
implementation (`src/mock/router.ts`) that follows API.md: pagination, actions, search operators,
blocking, drafts, sending, settings. A fake "new mail" arrives every 90 s to exercise live updates.

## Keyboard

`j`/`k` move, `Enter` open, `e` archive, `#` delete, `p` pin, `u` unread, `r`/`a`/`f` reply / reply all /
forward, `c` compose, `/` search, `Esc` back/close, `⌘Enter` send, `?` list.
