import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { api } from './client';
import type { Account, DeepPartial, OutboxItem, Settings, Signature, ThreadAction, ThreadDetail, ThreadSummary, ThreadsResponse, Draft } from './types';
import { useUI } from '../store';

export const useMe = (enabled = true) =>
  useQuery({ queryKey: ['me'], queryFn: api.auth.me, enabled, retry: false, staleTime: 5 * 60_000 });

export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: api.accounts.list, staleTime: 30_000 });

export const useFolders = () => useQuery({ queryKey: ['folders'], queryFn: api.folders.list, staleTime: 60_000 });

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 5 * 60_000 });

export const useBlocked = () => useQuery({ queryKey: ['blocked'], queryFn: api.blocked.list, staleTime: 30_000 });

export function useAccountMap() {
  const { data } = useAccounts();
  return useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of data ?? []) m.set(a.id, a);
    return m;
  }, [data]);
}

export function useMyEmails() {
  const { data } = useAccounts();
  return useMemo(() => new Set((data ?? []).map((a) => a.email.toLowerCase())), [data]);
}

export type ListParams = { view: string; account?: string; category?: string; unread?: boolean };

export function useThreadList(params: ListParams, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['threads', params],
    queryFn: ({ pageParam }) =>
      api.threads.list({
        view: params.view,
        account: params.account,
        category: params.category,
        unread: params.unread ? '1' : undefined,
        before: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 15_000,
  });
}

export function useSearch(q: string, account?: string) {
  return useInfiniteQuery({
    queryKey: ['search', q, account ?? ''],
    queryFn: ({ pageParam }) => api.search.run({ q, account, before: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: q.trim().length > 0,
    staleTime: 15_000,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: ['thread', id],
    queryFn: () => api.threads.get(id!),
    enabled: !!id,
    staleTime: 10_000,
  });
}

const DESTRUCTIVE: ThreadAction[] = ['archive', 'trash', 'junk', 'notjunk', 'inbox', 'delete', 'move'];
const UNDO: Partial<Record<ThreadAction, ThreadAction>> = {
  read: 'unread',
  unread: 'read',
  pin: 'unpin',
  unpin: 'pin',
  archive: 'inbox',
  trash: 'inbox',
  junk: 'inbox',
  notjunk: 'junk',
};
const LABEL: Record<ThreadAction, string> = {
  read: 'Marked as read',
  unread: 'Marked as unread',
  pin: 'Pinned',
  unpin: 'Unpinned',
  archive: 'Archived',
  trash: 'Moved to Trash',
  junk: 'Marked as spam',
  notjunk: 'Moved to Inbox',
  inbox: 'Moved to Inbox',
  delete: 'Deleted forever',
  move: 'Moved',
};

type ActVars = { threadIds: string[]; action: ThreadAction; view: string; folderId?: string; scope?: 'view' | 'all'; silent?: boolean };

/** Thread actions with optimistic list updates and an Undo toast. */
export function useThreadActions() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);

  const mutation = useMutation({
    mutationFn: (v: ActVars) =>
      api.threads.act({ threadIds: v.threadIds, action: v.action, folderId: v.folderId, scope: v.scope, view: v.view }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['threads'] });
      const snapshots = qc.getQueriesData<InfiniteData<ThreadsResponse>>({ queryKey: ['threads'] });
      const ids = new Set(v.threadIds);
      const patchRow = (t: ThreadSummary): ThreadSummary | null => {
        if (!ids.has(t.id)) return t;
        switch (v.action) {
          case 'read':
            return { ...t, unread: false };
          case 'unread':
            return { ...t, unread: true };
          case 'pin':
            return { ...t, pinned: true };
          case 'unpin':
            return { ...t, pinned: false };
          default:
            return null;
        }
      };
      for (const [key, data] of snapshots) {
        if (!data) continue;
        const p = key[1] as ListParams | undefined;
        const removeFromThisList = DESTRUCTIVE.includes(v.action) || (v.action === 'unpin' && p?.view === 'pinned');
        qc.setQueryData<InfiniteData<ThreadsResponse>>(key, {
          ...data,
          pages: data.pages.map((pg) => {
            const rows = pg.threads
              .map((t) => (removeFromThisList && ids.has(t.id) ? null : patchRow(t)))
              .filter((t): t is ThreadSummary => !!t);
            const removed = pg.threads.length - rows.length;
            const unreadDelta = pg.threads.filter((t) => ids.has(t.id) && t.unread).length;
            return {
              ...pg,
              threads: rows,
              counts: {
                total: Math.max(0, pg.counts.total - removed),
                unread:
                  v.action === 'read'
                    ? Math.max(0, pg.counts.unread - unreadDelta)
                    : v.action === 'unread'
                      ? pg.counts.unread + v.threadIds.length - unreadDelta
                      : removeFromThisList
                        ? Math.max(0, pg.counts.unread - unreadDelta)
                        : pg.counts.unread,
              },
            };
          }),
        });
      }
      for (const id of v.threadIds) {
        qc.setQueryData<ThreadDetail>(['thread', id], (old) => {
          if (!old) return old;
          const t = patchRow(old.thread) ?? old.thread;
          const messages = old.messages.map((m) =>
            v.action === 'read' ? { ...m, seen: true } : v.action === 'unread' ? { ...m, seen: false } : v.action === 'pin' ? { ...m, flagged: true } : v.action === 'unpin' ? { ...m, flagged: false } : m,
          );
          return { thread: t, messages };
        });
      }
      return { snapshots };
    },
    onError: (err, _v, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
      toast({ text: err instanceof Error ? err.message : 'Action failed', kind: 'error' });
    },
    onSuccess: (_d, v) => {
      if (v.silent) return;
      const undoAction = UNDO[v.action];
      toast({
        text: LABEL[v.action],
        undo: undoAction
          ? async () => {
              await mutation.mutateAsync({ threadIds: v.threadIds, action: undoAction, view: v.view, scope: 'all', silent: true });
            }
          : undefined,
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['search'] });
    },
  });

  const act = useCallback((v: ActVars) => mutation.mutateAsync(v), [mutation]);
  return act;
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: DeepPartial<Settings>) => api.settings.update(s),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  });
}

export function useSignatures() {
  return useQuery<Signature[]>({ queryKey: ['signatures'], queryFn: api.signatures.list, staleTime: 60_000 });
}

export function useDrafts(enabled = true) {
  return useQuery<Draft[]>({ queryKey: ['drafts'], queryFn: api.drafts.list, staleTime: 5_000, enabled });
}

export function useOutbox() {
  return useQuery<{ items: OutboxItem[] }>({ queryKey: ['outbox'], queryFn: api.outbox.list, staleTime: 5_000, refetchInterval: 15_000 });
}
