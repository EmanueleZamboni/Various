import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

export const VIEWS = ['inbox', 'pinned', 'sent', 'drafts', 'archive', 'junk', 'trash', 'blocked', 'all'] as const;
export type KnownView = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<string, string> = {
  inbox: 'Inbox',
  pinned: 'Starred',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  junk: 'Spam',
  trash: 'Trash',
  blocked: 'Blocked senders',
  all: 'All mail',
  search: 'Search',
};

/** Reads and writes the URL: /:view(/t/:threadId)?account=&q= */
export function useNav() {
  const params = useParams<{ view?: string; threadId?: string }>();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const loc = useLocation();
  const isSearch = loc.pathname.startsWith('/search');
  const isSettings = loc.pathname.startsWith('/settings');
  const view = isSearch ? 'search' : params.view ?? 'inbox';
  const threadId = params.threadId ?? null;
  const accountId = sp.get('account') || null;
  const q = sp.get('q') ?? '';

  const build = useCallback(
    (v: string, tid: string | null, opts?: { account?: string | null; q?: string | null }) => {
      const nsp = new URLSearchParams();
      const acc = opts?.account === undefined ? accountId : opts.account;
      const qq = opts?.q === undefined ? (v === 'search' ? q : '') : opts.q;
      if (acc) nsp.set('account', acc);
      if (qq && v === 'search') nsp.set('q', qq);
      const base = v === 'search' ? '/search' : `/${v}`;
      const path = tid ? `${base}/t/${encodeURIComponent(tid)}` : base;
      const s = nsp.toString();
      return s ? `${path}?${s}` : path;
    },
    [accountId, q],
  );

  const go = useCallback((v: string, opts?: { account?: string | null }) => navigate(build(v, null, opts)), [build, navigate]);
  const openThread = useCallback((tid: string) => navigate(build(view === 'settings' ? 'inbox' : view, tid), { state: { fromList: true } }), [build, navigate, view]);
  // Opened from the list: go back so the phone's history does not pile up; otherwise (deep link, notification) replace.
  const closeThread = useCallback(() => {
    if ((window.history.state as { usr?: { fromList?: boolean } } | null)?.usr?.fromList) navigate(-1);
    else navigate(build(view, null), { replace: true });
  }, [build, navigate, view]);
  const setAccount = useCallback(
    (acc: string | null) => navigate(build(view === 'blocked' ? 'inbox' : view, null, { account: acc })),
    [build, navigate, view],
  );
  const search = useCallback(
    (query: string, acc?: string | null) => navigate(build('search', null, { q: query, account: acc === undefined ? accountId : acc })),
    [accountId, build, navigate],
  );

  return useMemo(
    () => ({ view, threadId, accountId, q, isSearch, isSettings, go, openThread, closeThread, setAccount, search, build }),
    [view, threadId, accountId, q, isSearch, isSettings, go, openThread, closeThread, setAccount, search, build],
  );
}
