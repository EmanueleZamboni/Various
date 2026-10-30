import type {
  Account,
  AccountInput,
  Address,
  BlockedSender,
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
 Signature, Passkey, DeepPartial, OutboxItem } from './types';

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
  contacts: (q: string, limit = 8) => get<Address[]>(`/api/contacts${qs({ q, limit })}`),
  settings: {
    get: () => get<Settings>('/api/settings'),
    update: (s: DeepPartial<Settings>) => put<Settings>('/api/settings', s),
  },
  google: {
    status: () => get<{ configured: boolean; connected: boolean; email: string | null; clientId: string | null }>('/api/google/status'),
    credentials: (clientId: string, clientSecret: string) => post<{ ok: true; redirectUri: string }>('/api/google/credentials', { clientId, clientSecret }),
    redirectUri: () => get<{ redirectUri: string }>('/api/google/redirect-uri'),
    connect: () => post<{ url: string }>('/api/google/connect'),
    disconnect: () => post<void>('/api/google/disconnect'),
    save: (attachmentId: string, convertTo?: string) => post<{ ok: true; id: string; webViewLink: string; converted: boolean }>('/api/google/save', { attachmentId, convertTo }),
  },
  outbox: {
    list: () => get<{ items: OutboxItem[] }>('/api/outbox'),
    cancel: (id: string) => del<{ ok: true; draft: Draft }>(`/api/outbox/${id}`),
  },
  push: {
    subscribe: (subscription: PushSubscriptionJSON) => post<void>('/api/push/subscribe', { subscription }),
    unsubscribe: (endpoint: string) => del<void>('/api/push/subscribe', { endpoint }),
    test: () => post<void>('/api/push/test'),
  },
};
