import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Account, Address, Category } from './types';
import { useUI } from '../store';
import { displayName } from '../util/format';

const EVENT_NAMES = [
  'thread.updated',
  'thread.removed',
  'message.updated',
  'account.updated',
  'folder.updated',
  'sync.progress',
  'action.failed',
  'new.mail',
] as const;

/** Keeps react-query caches fresh from the server's SSE stream. */
export function useServerEvents(enabled: boolean) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry = 1000;
    let closed = false;
    let timer: number | undefined;
    // Events arrive in bursts (hundreds per second during a first sync); refetch at most every 600 ms.
    let listsDirty = false;
    const dirtyThreads = new Set<string>();
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (listsDirty) {
        listsDirty = false;
        qc.invalidateQueries({ queryKey: ['threads'] });
        qc.invalidateQueries({ queryKey: ['search'] });
      }
      for (const id of dirtyThreads) qc.invalidateQueries({ queryKey: ['thread', id] });
      dirtyThreads.clear();
    };
    const schedule = () => {
      if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 600);
    };
    const invalidateLists = () => {
      listsDirty = true;
      schedule();
    };
    const invalidateThread = (id: string) => {
      if (id) dirtyThreads.add(String(id));
      schedule();
    };
    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        retry = 1000;
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      };
      for (const name of EVENT_NAMES) {
        es.addEventListener(name, (ev) => {
          let data: any = {};
          try {
            data = JSON.parse((ev as MessageEvent).data);
          } catch {
            /* ignore */
          }
          switch (name) {
            case 'thread.updated':
              invalidateLists();
              invalidateThread(data.threadId);
              break;
            case 'thread.removed':
              invalidateLists();
              qc.removeQueries({ queryKey: ['thread', data.threadId] });
              break;
            case 'message.updated':
              invalidateThread(data.threadId);
              break;
            case 'account.updated': {
              const a = data as Account;
              qc.setQueryData<Account[]>(['accounts'], (old) => (old ? old.map((x) => (x.id === a.id ? a : x)) : old));
              qc.invalidateQueries({ queryKey: ['accounts'] });
              break;
            }
            case 'folder.updated':
              qc.invalidateQueries({ queryKey: ['folders'] });
              break;
            case 'sync.progress':
              qc.invalidateQueries({ queryKey: ['accounts'] });
              if (data.done) invalidateLists();
              break;
            case 'action.failed':
              toast({ text: data.message ?? 'An action could not be completed.', kind: 'error' });
              invalidateLists();
              break;
            case 'new.mail': {
              const from = data.from as Address;
              const cat = data.category as Category;
              if (cat === 'person' && !document.hasFocus()) {
                toast({ text: `${displayName(from)}: ${data.subject}` });
              } else if (cat === 'person') {
                toast({ text: `New from ${displayName(from)}` });
              }
              invalidateLists();
              break;
            }
          }
        });
      }
    };
    connect();
    return () => {
      closed = true;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      if (timer) window.clearTimeout(timer);
      es?.close();
    };
  }, [enabled, qc, toast]);
}
