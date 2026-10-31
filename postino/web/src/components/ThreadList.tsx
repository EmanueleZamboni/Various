import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { InfiniteData } from '@tanstack/react-query';
import { useAccountMap, useAccounts, useBlocked, useDrafts, useMyEmails, useOutbox, useSearch, useSettings, useThreadList, useThreadActions } from '../api/hooks';
import { api } from '../api/client';
import type { ThreadSummary, ThreadsResponse } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useNav, VIEW_LABEL } from '../nav';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../store';
import { accountLabel, dayGroup, pluralize } from '../util/format';
import { ThreadRow } from './ThreadRow';
import { SearchBar } from './SearchBar';
import { BlockedList } from './BlockedList';
import { useQueryClient } from '@tanstack/react-query';

const flat = (d?: InfiniteData<ThreadsResponse>) => d?.pages.flatMap((p) => p.threads) ?? [];

export function ThreadList({ view }: { view: string }) {
  const nav = useNav();
  const ui = useUI();
  const { data: accounts } = useAccounts();
  const accountMap = useAccountMap();
  const myEmails = useMyEmails();
  const act = useThreadActions();
  const qc = useQueryClient();
  const account = nav.accountId ? accountMap.get(nav.accountId) : undefined;

  const isSearch = view === 'search';
  const smart = view === 'inbox' && ui.smart;
  const base = { view, account: nav.accountId ?? undefined };
  const { data: settings } = useSettings();
  const groupNotif = settings?.inbox.groupNotifications ?? true;
  const groupNews = settings?.inbox.groupNewsletters ?? true;
  // Groups the user switched off fall back into the People list.
  const peopleCats = ['person', ...(groupNotif ? [] : ['notification']), ...(groupNews ? [] : ['newsletter'])].join(',');

  const people = useThreadList({ ...base, category: smart ? peopleCats : undefined }, !isSearch && view !== 'blocked');
  const notifs = useThreadList({ ...base, category: 'notification' }, smart && groupNotif);
  const news = useThreadList({ ...base, category: 'newsletter' }, smart && groupNews);
  const outbox = useOutbox();
  const cancelOutbox = async (id: string) => {
    try {
      const r = await api.outbox.cancel(id);
      qc.invalidateQueries({ queryKey: ['outbox'] });
      qc.invalidateQueries({ queryKey: ['drafts'] });
      ui.openCompose({ mode: 'new', draft: r.draft, accountId: r.draft.accountId });
    } catch {
      ui.toast({ text: 'Too late, it was already sent.', kind: 'error' });
      qc.invalidateQueries({ queryKey: ['outbox'] });
    }
  };
  const search = useSearch(nav.q, nav.accountId ?? undefined);

  const main = isSearch ? search : people;
  const rows = flat(main.data);
  const notifRows = flat(notifs.data);
  const newsRows = flat(news.data);
  const highlights = useMemo(() => {
    const h: Record<string, string> = {};
    for (const p of search.data?.pages ?? []) Object.assign(h, p.highlights ?? {});
    return h;
  }, [search.data]);

  const pinnedOnTop = settings?.inbox.pinnedOnTop ?? true;
  const pinnedRows = smart && pinnedOnTop ? rows.filter((t) => t.pinned) : [];
  const peopleRows = smart && pinnedOnTop ? rows.filter((t) => !t.pinned) : rows;
  const scheduled = view === 'drafts' ? (outbox.data?.items ?? []) : [];
  // Drafts saved by Postino itself (replies and new mail) live on the server, not in IMAP.
  const localDrafts = useDrafts(view === 'drafts');
  const drafts = view === 'drafts' ? (localDrafts.data ?? []) : [];
  const removeDraft = async (id: string) => {
    try {
      await api.drafts.remove(id);
    } finally {
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['threads'] });
    }
  };
  const draftsBlock = drafts.length > 0 && (
    <>
      <div className="sec">Drafts <span className="n">{drafts.length}</span></div>
      {drafts.map((d) => (
        <div className="outbox-card" key={`d-${d.id}`}>
          <Icon name="draft" size={16} />
          <div className="t">
            <span><b>{d.subject || (d.inReplyTo ? 'Reply' : d.forwardOf ? 'Forward' : '(no subject)')}</b>{d.to ? ` to ${d.to}` : ''}</span>
            <small>{d.text.replace(/\s+/g, ' ').trim().slice(0, 90) || 'Empty'} · {new Date(d.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => ui.openCompose({ mode: 'new', draft: d, accountId: d.accountId })}>Edit</button>
          <button className="ib" aria-label="Delete draft" onClick={() => void removeDraft(d.id)}><Icon name="trash" size={16} /></button>
        </div>
      ))}
    </>
  );
  const scheduledBlock = (scheduled.length > 0 || drafts.length > 0) && (
    <>
      {draftsBlock}
      {scheduled.length > 0 && <div className="sec">Scheduled <span className="n">{scheduled.length}</span></div>}
      {scheduled.map((o) => (
        <div className="outbox-card" key={o.id}>
          <Icon name="send" size={16} />
          <div className="t">
            <span><b>{o.subject || '(no subject)'}</b> to {o.to}</span>
            <small>{o.status === 'failed' ? `Failed: ${o.error}` : `Sends ${new Date(o.sendAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}</small>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void cancelOutbox(o.id)}>{o.status === 'failed' ? 'Edit' : 'Cancel'}</button>
        </div>
      ))}
    </>
  );

  // Keyboard order follows what is on screen.
  useEffect(() => {
    const ids = [
      ...pinnedRows.map((t) => t.id),
      ...(smart && ui.bundlesOpen.notif ? notifRows.map((t) => t.id) : []),
      ...(smart && ui.bundlesOpen.news ? newsRows.map((t) => t.id) : []),
      ...peopleRows.map((t) => t.id),
    ];
    ui.setOrder(ids);
  });

  // Infinite scroll
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && main.hasNextPage && !main.isFetchingNextPage) void main.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [main]);

  const counts = main.data?.pages[0]?.counts;
  const title = isSearch ? 'Search' : view === 'inbox' && account ? accountLabel(account.email, accounts ?? []) : view.startsWith('folder:') ? 'Folder' : VIEW_LABEL[view] ?? 'Mail';
  const subtitle = isSearch
    ? nav.q
      ? counts
        ? `${pluralize(counts.total, 'result')} for “${nav.q}”`
        : 'Searching'
      : 'Type to search all your mail'
    : view === 'blocked'
      ? ''
      : account && view === 'inbox'
        ? `${account.email} · ${counts?.unread ?? 0} unread`
        : counts
          ? `${counts.unread ? `${counts.unread} unread · ` : ''}${pluralize(counts.total, 'conversation')}`
          : '';

  const open = (t: ThreadSummary) => {
    ui.setSelected(t.id);
    nav.openThread(t.id);
  };
  const swipe = (t: ThreadSummary, dir: 'left' | 'right') => {
    const pref = (dir === 'left' ? settings?.swipe.left : settings?.swipe.right) ?? (dir === 'left' ? 'archive' : 'pin');
    const action = pref === 'pin' ? (t.pinned ? 'unpin' : 'pin') : pref === 'read' ? (t.unread ? 'read' : 'unread') : pref;
    void act({ threadIds: [t.id], action, view });
  };

  const renderRow = (t: ThreadSummary, compact = false) => (
    <ThreadRow
      key={t.id}
      thread={t}
      account={accountMap.get(t.accountId)}
      myEmails={myEmails}
      selected={nav.threadId === t.id}
      focused={ui.selectedId === t.id && !nav.threadId}
      highlight={highlights[t.id]}
      compact={compact}
      previewLines={settings?.inbox.previewLines ?? 1}
      showAvatar={settings?.inbox.showAvatars ?? true}
      showAccount={!nav.accountId && (settings?.inbox.showAccountTag ?? true)}
      accountLabel={accountMap.get(t.accountId) ? accountLabel(accountMap.get(t.accountId)!.email, accounts ?? []) : ''}
      onOpen={() => open(t)}
      onSwipe={(dir) => swipe(t, dir)}
      swipeActions={{ left: settings?.swipe.left ?? 'archive', right: settings?.swipe.right ?? 'pin' }}
      onAction={(action) => void act({ threadIds: [t.id], action, view })}
      onMove={() => ui.setMoveTarget({ threadIds: [t.id], accountId: t.accountId })}
      onBlock={t.lastFrom?.email && !myEmails.has(t.lastFrom.email.toLowerCase()) ? () => ui.setPendingBlock({ email: t.lastFrom.email, name: t.lastFrom.name || t.lastFrom.email, threadId: t.id }) : undefined}
      onPrefetch={() => void qc.prefetchQuery({ queryKey: ['thread', t.id], queryFn: () => api.threads.get(t.id), staleTime: 10_000 })}
    />
  );

  let body: ReactNode;
  if (view === 'blocked') body = <BlockedList />;
  else if (main.isLoading) body = <Skeletons />;
  else if (main.isError)
    body = (
      <div className="empty">
        <div className="big"><Icon name="alert" size={24} /></div>
        <h2>Could not load mail</h2>
        <p>{(main.error as Error).message}</p>
        <button className="btn btn-ghost" onClick={() => void main.refetch()}>Try again</button>
      </div>
    );
  else if (!rows.length && !notifRows.length && !newsRows.length) body = scheduled.length || drafts.length ? scheduledBlock : <Empty view={view} q={nav.q} />;
  else if (smart) {
    body = (
      <>
        {pinnedRows.length > 0 && (
          <>
            <div className="sec"><Icon name="pin" size={14} />Pinned</div>
            {pinnedRows.map((t) => renderRow(t))}
          </>
        )}
        {/* Bundles sit above People so they stay reachable in a long inbox; closed, they are one line each. */}
        <Bundle k="notif" label="Notifications" icon="bell" rows={notifRows} query={notifs} render={(t) => renderRow(t, true)} />
        <Bundle k="news" label="Newsletters" icon="news" rows={newsRows} query={news} render={(t) => renderRow(t, true)} />
        {peopleRows.length > 0 && (
          <>
            <div className="sec">People <span className="n">{counts?.total ?? peopleRows.length}</span></div>
            {peopleRows.map((t) => renderRow(t))}
          </>
        )}
      </>
    );
  } else {
    let group = '';
    const list = rows.map((t) => {
      const g = isSearch ? '' : dayGroup(t.lastDate);
      const header = g && g !== group ? <div className="sec">{g}</div> : null;
      group = g;
      return (
        <Fragment key={t.id}>
          {header}
          {renderRow(t)}
        </Fragment>
      );
    });
    body = (
      <>
        {scheduledBlock}
        {list}
      </>
    );
  }

  return (
    <section className="list-pane" aria-label="Conversations">
      <header className="list-head">
        <div className="list-head-row">
          <button className="ib menu-btn" onClick={() => ui.setDrawer(true)} aria-label="Open mailboxes">
            <Icon name="menu" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="list-title">{title}</h1>
            {subtitle && <div className="list-sub">{subtitle}</div>}
          </div>
        </div>
        {view !== 'blocked' && <SearchBar />}
        {isSearch && nav.q && (
          <div className="scope">
            {account ? (
              <>
                Searching in {account.email}
                <button onClick={() => nav.search(nav.q, null)}>Search all accounts</button>
              </>
            ) : (
              <>Searching all accounts</>
            )}
          </div>
        )}
        {!isSearch && view !== 'blocked' && (accounts?.length ?? 0) > 1 && (
          <div className="chips" role="group" aria-label="Filter by account">
            <button className={`chip${!nav.accountId ? ' on' : ''}`} onClick={() => nav.setAccount(null)}>All</button>
            {accounts!.map((a) => (
              <button key={a.id} className={`chip acct-chip${nav.accountId === a.id ? ' on' : ''}`} style={{ ['--c' as string]: a.color }} onClick={() => nav.setAccount(a.id)}>
                {accountLabel(a.email, accounts!)}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="list" role="list">
        {body}
        {main.hasNextPage && <div ref={sentinel} style={{ height: 1 }} />}
        {main.isFetchingNextPage && <div className="load-more">Loading more</div>}
      </div>
    </section>
  );
}

function Bundle({ k, label, icon, rows, query, render }: { k: string; label: string; icon: IconName; rows: ThreadSummary[]; query: ReturnType<typeof useThreadList>; render: (t: ThreadSummary) => ReactNode }) {
  const open = useUI((s) => !!s.bundlesOpen[k]);
  const toggle = useUI((s) => s.toggleBundle);
  const { data: blocked } = useBlocked();
  void blocked;
  if (!rows.length) return null;
  const unread = query.data?.pages[0]?.counts.unread ?? rows.filter((t) => t.unread).length;
  const total = query.data?.pages[0]?.counts.total ?? rows.length;
  const shown = open ? rows : [];
  const latest = rows[0];
  return (
    <section className={`bundle${open ? ' open' : ''}`} aria-label={label}>
      <button className="bundle-head" onClick={() => toggle(k)} aria-expanded={open}>
        <span className="bundle-ico"><Icon name={icon} size={16} /></span>
        <span className="bundle-title">
          <span>{label}</span>
          <small>{open ? pluralize(total, 'conversation') : `${latest.lastFrom.name || latest.lastFrom.email}: ${latest.subject}`}</small>
        </span>
        {unread > 0 && <span className="pill">{unread} new</span>}
        <Icon name="chevronDown" size={16} className="bundle-chev" />
      </button>
      {shown.map(render)}
      {open && query.hasNextPage && (
        <button className="bundle-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading' : 'Load more'}
        </button>
      )}
    </section>
  );
}

function Skeletons() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skel" key={i}>
          <div className="skel-av" />
          <div style={{ flex: 1 }}>
            <div className="skel-line" style={{ width: `${45 + (i % 3) * 12}%` }} />
            <div className="skel-line" style={{ width: `${70 + (i % 2) * 15}%` }} />
            <div className="skel-line" style={{ width: '55%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ view, q }: { view: string; q: string }) {
  const openCompose = useUI((s) => s.openCompose);
  const { data: accounts } = useAccounts();
  const navigate = useNavigate();
  // Brand-new install: the only useful thing to do is connect a mailbox.
  if (accounts && accounts.length === 0 && view !== 'search')
    return (
      <div className="empty">
        <div className="big"><Icon name="people" size={24} /></div>
        <h2>Connect your first mailbox</h2>
        <p>Add each address once (Gmail, your own domains…). They all land in this one inbox.</p>
        <button className="btn btn-primary" onClick={() => navigate('/welcome')}>Set up Postino</button>
      </div>
    );
  if (view === 'search')
    return (
      <div className="empty">
        <div className="big"><Icon name="search" size={24} /></div>
        <h2>{q ? 'No results' : 'Search your mail'}</h2>
        <p>{q ? `Nothing matches “${q}”. Try fewer words, or search by sender with from:.` : 'Search by words, sender (from:), attachments (has:attachment) or date (after:2026-01-01).'}</p>
      </div>
    );
  const map: Record<string, { icon: IconName; title: string; text: string }> = {
    inbox: { icon: 'inbox', title: 'All caught up', text: 'No new mail across your accounts.' },
    pinned: { icon: 'pin', title: 'Nothing pinned', text: 'Pin a conversation to keep it here until you are done with it.' },
    sent: { icon: 'send', title: 'Nothing sent yet', text: 'Messages you send show up here.' },
    drafts: { icon: 'draft', title: 'No drafts', text: 'Unsent messages are saved here automatically.' },
    archive: { icon: 'archive', title: 'Archive is empty', text: 'Archived conversations stay searchable.' },
    junk: { icon: 'spam', title: 'No spam', text: 'Messages marked as spam, by you or by the mail server, land here.' },
    trash: { icon: 'trash', title: 'Trash is empty', text: 'Deleted messages stay here until you empty them.' },
  };
  const e = map[view] ?? { icon: 'folder' as IconName, title: 'Nothing here', text: 'This folder is empty.' };
  return (
    <div className="empty">
      <div className="big"><Icon name={e.icon} size={24} /></div>
      <h2>{e.title}</h2>
      <p>{e.text}</p>
      {view === 'inbox' && (
        <button className="btn btn-ghost" onClick={() => openCompose({ mode: 'new' })}>Write an email</button>
      )}
    </div>
  );
}
