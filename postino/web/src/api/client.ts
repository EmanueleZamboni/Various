import type {
  Account,
  AccountInput,
  Address,
  BackupStatus,
  GoogleTask,
  RsvpResponse,
  BlockedSender,
  PendingMailbox,
  Draft,
  Folder,
  Me,
  Message,
  ReplyPrefill,
  ServerPreset,
  Settings,
  ThreadAction,
  ThreadDetail,
  ThreadsResponse,
  ThreadSummary,
 Signature, Passkey, DeepPartial, OutboxItem, Template, UpcomingItem } from './types';

export type WaTranscription = { enabled: boolean; source: 'settings' | 'env' | null; done: number; failed: number; lastError: string | null; lastAt: string | null };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...init });
  if (res.status === 204 || res.status === 202) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'bad_response', message: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? err.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const get = <T,>(path: string) => request<T>('GET', path);
const post = <T,>(path: string, body?: unknown) => request<T>('POST', path, body);
const put = <T,>(path: string, body?: unknown) => request<T>('PUT', path, body);
const patch = <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body);
const del = <T,>(path: string, body?: unknown) => request<T>('DELETE', path, body);

const qs = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  setup: {
    status: () => get<{ needsSetup: boolean }>('/api/setup'),
    create: (password: string, code?: string) => post<void>('/api/setup', { password, code }),
  },
  auth: {
    login: (password: string, totp?: string) => post<void>('/api/login', { password, totp }),
    logout: () => post<void>('/api/logout'),
    me: () => get<Me>('/api/me'),
    changePassword: (current: string, next: string) => post<void>('/api/me/password', { current, next }),
    totpStart: () => post<{ secret: string; otpauthUrl: string; qrDataUrl: string }>('/api/me/totp/start'),
    totpEnable: (code: string) => post<void>('/api/me/totp/enable', { code }),
    totpDisable: (password: string) => post<void>('/api/me/totp/disable', { password }),
  },
  passkeys: {
    list: () => get<{ passkeys: Passkey[] }>('/api/passkeys'),
    registerOptions: (password?: string) => post<any>('/api/passkeys/register/options', password ? { password } : undefined),
    registerVerify: (response: unknown, name: string) => post<{ ok: true; passkeys: Passkey[] }>('/api/passkeys/register/verify', { response, name }),
    remove: (id: string) => del<void>(`/api/passkeys/${encodeURIComponent(id)}`),
    loginOptions: () => post<any>('/api/passkeys/login/options'),
    loginVerify: (response: unknown) => post<void>('/api/passkeys/login/verify', { response }),
  },
  accounts: {
    list: () => get<Account[]>('/api/accounts'),
    create: (input: AccountInput) => post<Account>('/api/accounts', input),
    test: (input: AccountInput) => post<{ ok: true }>('/api/accounts/test', input),
    update: (id: string, patchBody: Partial<AccountInput> & { signature?: string; order?: number; aliases?: string[]; folders?: Record<string, string>; notify?: string }) =>
      patch<Account>(`/api/accounts/${id}`, patchBody),
    remove: (id: string) => del<void>(`/api/accounts/${id}`),
    resync: (id: string) => post<void>(`/api/accounts/${id}/resync`),
    presets: (email: string) => get<ServerPreset | null>(`/api/presets${qs({ email })}`),
  },
  folders: { list: () => get<Folder[]>('/api/folders') },
  threads: {
    list: (params: {
      view?: string;
      account?: string;
      category?: string;
      unread?: '1';
      group?: string;
      before?: string;
      limit?: number;
    }) => get<ThreadsResponse>(`/api/threads${qs(params)}`),
    get: (id: string) => get<ThreadDetail>(`/api/threads/${id}`),
    message: (threadId: string, messageId: string) => get<Message>(`/api/threads/${threadId}/messages/${messageId}`),
    act: (body: { threadIds: string[]; action: ThreadAction; folderId?: string; scope?: 'view' | 'all'; view?: string }) =>
      post<{ ok: true; affected: number }>('/api/threads/actions', body),
  },
  messages: {
    act: (body: { messageIds: string[]; action: ThreadAction; folderId?: string }) =>
      post<{ ok: true; affected: number }>('/api/messages/actions', body),
    replyPrefill: (id: string, mode: 'reply' | 'replyAll' | 'forward') =>
      get<ReplyPrefill>(`/api/messages/${id}/reply${qs({ mode })}`),
    unsubscribe: (id: string) => post<{ ok: true; method: 'mailto' | 'http' | 'none'; url?: string }>(`/api/messages/${id}/unsubscribe`),
    invite: (id: string) => get<{ rsvp: RsvpResponse | null; calendarConnected: boolean; conflicts: { summary: string; start: string | null }[] | null }>(`/api/messages/${id}/invite`),
    rsvp: (id: string, response: RsvpResponse) => post<{ ok: true; response: RsvpResponse; calendar: boolean; organizerTold: boolean }>(`/api/messages/${id}/rsvp`, { response }),
  },
  ai: {
    status: () => get<AiStatus>('/api/ai/status'),
    setKey: (key: string) => put<AiStatus>('/api/ai/key', { key }),
    removeKey: () => del<AiStatus>('/api/ai/key'),
    setCap: (capUsd: number) => put<AiStatus>('/api/ai/cap', { capUsd }),
    triage: () => get<TriageSettings>('/api/ai/triage'),
    setTriage: (patch: Partial<Pick<TriageSettings, 'enabled' | 'model'>>) => put<TriageSettings>('/api/ai/triage', patch),
    verdict: (threadId: string) => get<{ verdict: SpamVerdict | null }>(`/api/ai/spam-check/${encodeURIComponent(threadId)}`),
    spamCheck: (threadId: string, fresh = false) => post<SpamVerdict & { cached: boolean }>('/api/ai/spam-check', { threadId, fresh }),
    search: (q: string, account?: string) => get<ThreadsResponse & { highlights: Record<string, string>; answer: string; queries: string[] }>(`/api/ai/search${qs({ q, account })}`),
  },
  smart: {
    upcoming: () => get<{ packages: UpcomingItem[]; trips: UpcomingItem[] }>('/api/smart/upcoming'),
    hide: (key: string, hidden = true) => post<{ ok: true }>('/api/smart/hide', { key, hidden }),
  },
  groups: {
    list: () => get<{ groups: { name: string; senders: string[]; notify: boolean; lastUsed?: string }[] }>('/api/groups'),
    add: (email: string, group: string) => post<{ ok: true }>('/api/groups', { email, group }),
    removeSender: (email: string) => del<{ ok: true }>(`/api/groups/sender/${encodeURIComponent(email)}`),
    update: (name: string, body: { newName?: string; notify?: boolean }) => patch<{ ok: true }>('/api/groups', { name, ...body }),
    suggestions: () => get<{ suggestions: { name: string; senders: { email: string; count: number }[] }[] }>('/api/groups/suggestions'),
    bulk: (groups: { name: string; senders: string[] }[]) => post<{ added: number }>('/api/groups/bulk', { groups }),
    summary: (account?: string) => get<{ groups: GroupSummary[] }>(`/api/groups/summary${qs({ account })}`),
    seen: (name: string) => post<{ ok: true }>('/api/groups/seen', { name }),
    important: (account?: string) => get<{ threads: ThreadSummary[]; more: number }>(`/api/groups/important${qs({ account })}`),
    read: (name?: string, account?: string) => post<{ affected: number }>('/api/groups/read', { name, account }),
    done: (name: string, account?: string) => post<{ affected: number }>('/api/groups/done', { name, account }),
  },
  calls: {
    setup: () => get<{ hookUrl: string; count: number; last: string | null; lastHook: { at: string; fields: Record<string, string> } | null }>('/api/calls/setup'),
    list: (q?: string) => get<{ total: number; calls: { name: string; number: string; type: string; at: string; duration: string }[] }>(`/api/calls${qs({ q, limit: '30' })}`),
    import: (file: File) => {
      const f = new FormData();
      f.append('file', file);
      return post<{ added: number; skipped: number }>('/api/calls/import', f);
    },
    newLink: () => post<{ ok: true }>('/api/calls/token'),
    clear: () => del<{ ok: true }>('/api/calls'),
  },
  whatsapp: {
    status: () => get<{ state: 'off' | 'connecting' | 'qr' | 'open' | 'logged_out'; qr: string | null; code: string | null; me: string | null; chats: number; messages: number }>('/api/whatsapp/status'),
    link: (phone?: string) => post<{ ok: true }>('/api/whatsapp/link', phone ? { phone } : {}),
    unlink: (forget: boolean) => post<{ ok: true }>('/api/whatsapp/unlink', { forget }),
    transcription: () => get<WaTranscription>('/api/whatsapp/transcription'),
    setTranscriptionKey: (key: string) => post<WaTranscription>('/api/whatsapp/transcription', { key }),
  },
  ops: {
    keep: () => get<{ installed: boolean; stage: string | null; detail: string; email: string; urlReady: boolean }>('/api/ops/keep'),
    keepCookie: (cookie: string) => post<{ ok: true }>('/api/ops/keep/cookie', { cookie }),
    keepUrl: () => get<{ url: string }>('/api/ops/keep/url'),
    forgetKeepUrl: () => del<{ ok: true }>('/api/ops/keep/url'),
  },
  mcp: {
    connections: () => get<{ connections: { name: string; since: string; lastUsed: string | null }[] }>('/api/mcp/connections'),
    disconnect: () => del<{ ok: true }>('/api/mcp/connections'),
  },
  tasks: {
    list: () => get<{ tasks: GoogleTask[] }>('/api/tasks'),
    add: (body: { title?: string; threadId?: string }) => post<{ id: string; title: string }>('/api/tasks', body),
    update: (id: string, body: { done?: boolean; title?: string }) => patch<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, body),
    remove: (id: string) => del<void>(`/api/tasks/${encodeURIComponent(id)}`),
  },
  blocked: {
    list: () => get<{ senders: BlockedSender[] }>('/api/blocked'),
    add: (pattern: string, note?: string) => post<BlockedSender>('/api/blocked', { pattern, note }),
    remove: (id: string) => del<void>(`/api/blocked/${id}`),
    restore: (id: string) => post<{ moved: number }>(`/api/blocked/${id}/restore`),
    importCandidates: () => get<{ candidates: { email: string; count: number }[] }>('/api/blocked/import'),
    importRun: () => post<{ added: number }>('/api/blocked/import'),
  },
  search: {
    run: (params: { q: string; account?: string; limit?: number; before?: string }) =>
      get<ThreadsResponse & { highlights: Record<string, string> }>(`/api/search${qs(params)}`),
    suggest: (q: string) => get<{ contacts: Address[]; recent: string[] }>(`/api/search/suggest${qs({ q })}`),
  },
  send: (form: FormData) => post<{ ok: true; messageId?: string; threadId: string | null; queued?: boolean; outboxId?: string; sendAt?: string }>('/api/send', form),
  drafts: {
    list: () => get<Draft[]>('/api/drafts'),
    create: (d: Partial<Draft>) => post<Draft>('/api/drafts', d),
    update: (id: string, d: Partial<Draft>) => put<Draft>(`/api/drafts/${id}`, d),
    remove: (id: string) => del<void>(`/api/drafts/${id}`),
  },
  signatures: {
    list: () => get<Signature[]>('/api/signatures'),
    create: (s: { accountId: string; name: string; html: string; isDefault?: boolean }) => post<Signature>('/api/signatures', s),
    update: (id: string, s: { name?: string; html?: string; isDefault?: boolean }) => put<Signature>(`/api/signatures/${id}`, s),
    remove: (id: string) => del<void>(`/api/signatures/${id}`),
  },
  templates: {
    list: () => get<Template[]>('/api/templates'),
    create: (t: { name: string; subject: string; text: string }) => post<Template>('/api/templates', t),
    update: (id: string, t: { name: string; subject: string; text: string }) => put<Template>(`/api/templates/${id}`, t),
    remove: (id: string) => del<void>(`/api/templates/${id}`),
  },
  contacts: (q: string, limit = 8) => get<Address[]>(`/api/contacts${qs({ q, limit })}`),
  settings: {
    get: () => get<Settings>('/api/settings'),
    update: (s: DeepPartial<Settings>) => put<Settings>('/api/settings', s),
  },
  google: {
    status: () => get<{ configured: boolean; managed?: boolean; connected: boolean; email: string | null; clientId: string | null; features?: { drive: boolean; calendar: boolean; contacts: boolean; tasks: boolean } }>('/api/google/status'),
    contactsSync: () => post<{ count: number }>('/api/google/contacts/sync'),
    contactsStatus: () => get<{ at: string; count: number } | null>('/api/google/contacts/status'),
    credentials: (clientId: string, clientSecret: string) => post<{ ok: true; redirectUri: string }>('/api/google/credentials', { clientId, clientSecret }),
    redirectUri: () => get<{ redirectUri: string }>('/api/google/redirect-uri'),
    connect: (back?: string) => post<{ url: string }>('/api/google/connect', { back }),
    gmail: (back: string, email?: string) => post<{ url: string }>('/api/google/gmail', { back, email }),
    disconnect: () => post<void>('/api/google/disconnect'),
    save: (attachmentId: string, convertTo?: string) => post<{ ok: true; id: string; webViewLink: string; converted: boolean }>('/api/google/save', { attachmentId, convertTo }),
  },
  backup: {
    status: () => get<BackupStatus>('/api/backup/status'),
    driveNow: () => post<{ ok: true }>('/api/backup/drive-now'),
    restore: (file: unknown) => post<{ mailboxes: PendingMailbox[] }>('/api/backup/restore', file),
    forgetPending: () => post<{ ok: true }>('/api/backup/forget-pending'),
  },
  outbox: {
    list: () => get<{ items: OutboxItem[] }>('/api/outbox'),
    cancel: (id: string) => del<{ ok: true; draft: Draft }>(`/api/outbox/${id}`),
  },
  push: {
    subscribe: (subscription: PushSubscriptionJSON) => post<void>('/api/push/subscribe', { subscription }),
    unsubscribe: (endpoint: string) => del<void>('/api/push/subscribe', { endpoint }),
    test: (endpoint?: string) => post<{ registered: boolean; devices: number; sent: number; failed: { status: number | null; message: string }[]; removed: number }>('/api/push/test', { endpoint }),
  },
};

/** One sender group as a line in the inbox. */
export type GroupSummary = { name: string; latestDate: string; latestThreadId: string; latestFrom: { name: string; email: string }; latestSubject: string; total: number; fresh: number; important?: number };

export type AiStatus = { configured: boolean; model: string; month: string; spentUsd: number; calls: number; capUsd: number };
export type SpamVerdict = { verdict: 'safe' | 'spam' | 'phishing' | 'scam' | 'suspicious'; confidence: 'low' | 'medium' | 'high'; summary: string; reasons: string[]; messageId: number };
export type TriageSettings = { enabled: boolean; model: 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5'; today?: number; dailyLimit?: number };
