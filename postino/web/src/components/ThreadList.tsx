import { useAddToTasks } from './GoogleApps';
import { GroupSuggestions } from './Groups';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InfiniteData } from '@tanstack/react-query';
import { useAccountMap, useAccounts, useBlocked, useDrafts, useGroups, useGroupSummary, useMyEmails, useOutbox, useAiSearch, useSearch, useSettings, useThreadList, useThreadActions } from '../api/hooks';
import { api, type GroupSummary } from '../api/client';
import type { ThreadSummary, ThreadsResponse } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useNav, VIEW_LABEL } from '../nav';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../store';
import { accountLabel, formatListDate, pluralize } from '../util/format';
import { UpcomingBlock } from './Smart';
import { ThreadRow } from './ThreadRow';
import { BlockedList } from './BlockedList';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const flat = (d?: InfiniteData<ThreadsResponse>) => d?.pages.flatMap((p) => p.threads) ?? [];

export function ThreadList({ view }: { view: string }) {
  const nav = useNav();
  const ui = useUI();
  const { data: accounts } = useAccounts();
  const accountMap = useAccountMap();
  const myEmails = useMyEmails();
  const act = useThreadActions();
  const addToTasks = useAddToTasks();
  const qc = useQueryClient();
  // Pull down at the top of the list to refresh, like the Gmail app. The circle follows the
  // finger through direct style updates on one element: the list itself never re-renders
  // or moves while pulling, so it stays smooth on a phone.
  const listRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  refreshRef.current = () => Promise.all([qc.refetchQueries({ queryKey: ['threads'], type: 'active' }), qc.refetchQueries({ queryKey: ['accounts'] }), qc.refetchQueries({ queryKey: ['groupSummary'] })]);
  useEffect(() => {
    const list = listRef.current;
    const ptr = ptrRef.current;
    if (!list || !ptr) return;
    const THRESHOLD = 72;
    let startY: number | null = null;
    let dist = 0;
    let busy = false;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const p = Math.min(dist / THRESHOLD, 1);
      ptr.style.transform = `translate3d(-50%, ${Math.min(dist, 120) - 48}px, 0) rotate(${dist * 2.4}deg)`;
      ptr.style.opacity = String(Math.min(1, dist / 30));
      ptr.classList.toggle('ready', p >= 1);
    };
    const settle = (cls: string, transform: string) => {
      ptr.className = cls;
      ptr.style.transform = transform;
    };
    const onStart = (e: TouchEvent) => {
      if (busy || list.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dist = 0;
      ptr.style.top = `${list.offsetTop}px`; // just under the list's header
      ptr.className = 'ptr pulling';
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || list.scrollTop > 0) {
        dist = 0;
      } else {
        dist = dy * 0.55;
      }
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (dist >= THRESHOLD) {
        busy = true;
        settle('ptr spinning', 'translate3d(-50%, 20px, 0)');
        ptr.style.opacity = '1';
        void refreshRef.current().finally(() => {
          settle('ptr done', 'translate3d(-50%, 20px, 0) scale(0)');
          window.setTimeout(() => {
            busy = false;
            settle('ptr', 'translate3d(-50%, -48px, 0)');
            ptr.style.opacity = '0';
          }, 220);
        });
      } else {
        settle('ptr back', 'translate3d(-50%, -48px, 0)');
        ptr.style.opacity = '0';
      }
      dist = 0;
    };
    list.addEventListener('touchstart', onStart, { passive: true });
    list.addEventListener('touchmove', onMove, { passive: true });
    list.addEventListener('touchend', onEnd);
    list.addEventListener('touchcancel', onEnd);
    return () => {
      list.removeEventListener('touchstart', onStart);
      list.removeEventListener('touchmove', onMove);
      list.removeEventListener('touchend', onEnd);
      list.removeEventListener('touchcancel', onEnd);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const account = nav.accountId ? accountMap.get(nav.accountId) : undefined;

  const isSearch = view === 'search';
  const smart = view === 'inbox' && ui.smart;
  const base = { view, account: nav.accountId ?? undefined };
  const { data: settings } = useSettings();
  const groupNotif = settings?.inbox.groupNotifications ?? true;
  const groupNews = settings?.inbox.groupNewsletters ?? true;
  // Groups the user switched off fall back into the People list.
  const peopleCats = ['person', ...(groupNotif ? [] : ['notification']), ...(groupNews ? [] : ['newsletter'])].join(',');

  // Sender groups: one line each, placed in the timeline at their newest email (like Inbox bundles).
  const { data: groupsData } = useGroups();
  const groupsOn = view === 'inbox' && !isSearch && (groupsData?.groups ?? []).length > 0;
  const groupSum = useGroupSummary(nav.accountId, groupsOn);
  const groupLines = groupsOn ? [...(groupSum.data?.groups ?? [])].sort((a, b) => (a.latestDate < b.latestDate ? 1 : -1)) : [];
  const people = useThreadList({ ...base, category: smart ? peopleCats : undefined, group: groupsOn ? 'none' : undefined }, !isSearch && view !== 'blocked');
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
  const search = useSearch(nav.q, nav.accountId ?? undefined, !nav.ai);
  const aiSearch = useAiSearch(nav.q, nav.accountId ?? undefined, isSearch && nav.ai);
  // Gmail-style checkboxes: a set of picked conversations for bulk actions, cleared when the list changes.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selMenu, setSelMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  useEffect(() => setChecked(new Set()), [view, nav.accountId, nav.q]);
  const toggleCheck = (id: string) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const main = isSearch ? (nav.ai ? aiSearch : search) : people;
  const aiAnswer = isSearch && nav.ai ? aiSearch.data?.pages[0]?.answer ?? '' : '';
  const rows = flat(main.data);
  const notifRows = flat(notifs.data);
  const newsRows = flat(news.data);
  const highlights = useMemo(() => {
    const h: Record<string, string> = {};
    for (const p of (nav.ai ? aiSearch.data?.pages : search.data?.pages) ?? []) Object.assign(h, p.highlights ?? {});
    return h;
  }, [search.data, aiSearch.data, nav.ai]);

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
      thread={view === 'sent' && t.unread ? { ...t, unread: false } : t /* what I sent is never "to read" */}
      account={accountMap.get(t.accountId)}
      myEmails={myEmails}
      selected={nav.threadId === t.id}
      focused={ui.selectedId === t.id && !nav.threadId}
      highlight={highlights[t.id]}
      compact={compact}
      previewLines={settings?.inbox.previewLines ?? 1}
      showAvatar={settings?.inbox.showAvatars ?? true}
      showAccount={!nav.accountId && (settings?.inbox.showAccountTag ?? false)}
      accountLabel={accountMap.get(t.accountId) ? accountLabel(accountMap.get(t.accountId)!.email, accounts ?? []) : ''}
      checked={checked.has(t.id)}
      onCheck={() => toggleCheck(t.id)}
      onOpen={() => open(t)}
      onSwipe={(dir) => swipe(t, dir)}
      swipeActions={{ left: settings?.swipe.left ?? 'archive', right: settings?.swipe.right ?? 'pin' }}
      onAction={(action) => void act({ threadIds: [t.id], action, view })}
      onMove={() => ui.setMoveTarget({ threadIds: [t.id], accountId: t.accountId })}
      onAddTask={() => void addToTasks(t.id)}
      onGroup={t.lastFrom?.email && !myEmails.has(t.lastFrom.email.toLowerCase()) ? () => ui.setGroupTarget({ email: t.lastFrom.email, name: t.lastFrom.name || '' }) : undefined}
      onBlock={t.lastFrom?.email && !myEmails.has(t.lastFrom.email.toLowerCase()) ? () => ui.setPendingBlock({ email: t.lastFrom.email, name: t.lastFrom.name || t.lastFrom.email, threadId: t.id }) : undefined}
      onPrefetch={() => void qc.prefetchQuery({ queryKey: ['thread', t.id], queryFn: () => api.threads.get(t.id), staleTime: 10_000 })}
    />
  );

  const visible = smart ? [...pinnedRows, ...peopleRows] : rows;
  const visibleIds = visible.map((t) => t.id);
  const checkedRows = visible.filter((t) => checked.has(t.id));
  const checkedIds = checkedRows.map((t) => t.id);
  const allChecked = visibleIds.length > 0 && checkedIds.length === visibleIds.length;
  const someChecked = checkedIds.length > 0 && !allChecked;
  const oneAccount = checkedRows.length > 0 && checkedRows.every((t) => t.accountId === checkedRows[0].accountId);
  const bulk = (action: Parameters<typeof act>[0]['action'], ids = checkedIds) => {
    if (!ids.length) return;
    void act({ threadIds: ids, action, view });
    setChecked(new Set());
  };

  // All sender groups fold into ONE row at the top (like Gmail's Promotions row); open it to see each group.
  const groupBlock = (
    <>
      {view === 'inbox' && !isSearch && !nav.accountId && <GroupSuggestions />}
      {view === 'inbox' && !isSearch && <UpcomingBlock onOpen={(id) => nav.openThread(id)} />}
      {groupLines.length > 0 && <GroupsRow lines={groupLines} base={base} render={(t) => renderRow(t, true)} />}
    </>
  );
  const weave = (list: ThreadSummary[]): ReactNode[] => list.map((t) => renderRow(t));

  let body: ReactNode;
  if (view === 'blocked') body = <BlockedList />;
  else if (main.isLoading && isSearch && nav.ai)
    body = (
      <div className="ai-verdict loading ai-answer" role="status">
        <span className="ai-spin" aria-hidden="true" />
        <span>Claude is looking through your mail…</span>
      </div>
    );
  else if (main.isLoading) body = <Skeletons />;
  else if (main.isError)
    body = (
      <div className="empty">
        <div className="big"><Icon name="alert" size={24} /></div>
        <h2>{isSearch && nav.ai ? 'Claude could not search' : 'Could not load mail'}</h2>
        <p>{(main.error as Error).message}</p>
        <button className="btn btn-ghost" onClick={() => void main.refetch()}>Try again</button>
      </div>
    );
  else if (!rows.length && !notifRows.length && !newsRows.length && !groupLines.length) body = <>{groupBlock}{scheduled.length || drafts.length ? scheduledBlock : <Empty view={view} q={nav.q} />}</>;
  else if (smart) {
    body = (
      <>
        {pinnedRows.length > 0 && (
          <>
            <div className="sec"><Icon name="starFilled" size={16} />Starred</div>
            {pinnedRows.map((t) => renderRow(t))}
          </>
        )}
        {groupBlock}
        {/* Bundles sit above People so they stay reachable in a long inbox; closed, they are one line each. */}
        <Bundle k="notif" label="Notifications" icon="bell" rows={notifRows} query={notifs} render={(t) => renderRow(t, true)} />
        <Bundle k="news" label="Newsletters" icon="news" rows={newsRows} query={news} render={(t) => renderRow(t, true)} />
        {peopleRows.length > 0 && (
          <>
            <div className="sec">People <span className="n">{counts?.total ?? peopleRows.length}</span></div>
            {weave(peopleRows)}
          </>
        )}
      </>
    );
  } else {
    const list = weave(rows);
    body = (
      <>
        {groupBlock}
        {scheduledBlock}
        {list}
      </>
    );
  }

  return (
    <section className="list-pane" aria-label="Conversations">
      <header className={`list-head${checkedIds.length ? ' checking' : ''}`}>
        <div className="list-title-row">
          <h1 className="list-title">{title}</h1>
          {subtitle && <span className="list-sub">{subtitle}</span>}
        </div>
        {view !== 'blocked' && (
          <div className="toolbar" role="toolbar" aria-label="List actions">
            <div className="sel-wrap">
              <button className="ib sel-box" onClick={() => setChecked(allChecked || someChecked ? new Set() : new Set(visibleIds))} aria-label={allChecked ? 'Deselect all' : 'Select all'} title="Select">
                <Icon name={allChecked ? 'checkboxOn' : someChecked ? 'checkboxSome' : 'checkbox'} size={20} />
              </button>
              <button className="ib sel-drop" onClick={() => setSelMenu((v) => !v)} aria-label="Select options" aria-expanded={selMenu}>
                <Icon name="dropDown" size={20} />
              </button>
              {selMenu && (
                <div className="menu-pop" role="menu" onMouseLeave={() => setSelMenu(false)}>
                  {([
                    ['All', () => true],
                    ['None', () => false],
                    ['Read', (t: ThreadSummary) => !t.unread],
                    ['Unread', (t: ThreadSummary) => t.unread],
                    ['Starred', (t: ThreadSummary) => t.pinned],
                    ['Unstarred', (t: ThreadSummary) => !t.pinned],
                  ] as [string, (t: ThreadSummary) => boolean][]).map(([label, fn]) => (
                    <button key={label} role="menuitem" onClick={() => { setChecked(new Set(visible.filter(fn).map((t) => t.id))); setSelMenu(false); }}>{label}</button>
                  ))}
                </div>
              )}
            </div>
            {checkedIds.length === 0 ? (
              <>
                <button className="ib" onClick={() => void qc.invalidateQueries({ queryKey: ['threads'] })} aria-label="Refresh" title="Refresh">
                  <Icon name="refresh" size={20} />
                </button>
                <div className="sel-wrap">
                  <button className="ib" onClick={() => setMoreMenu((v) => !v)} aria-label="More" title="More" aria-expanded={moreMenu}>
                    <Icon name="more" size={20} />
                  </button>
                  {moreMenu && (
                    <div className="menu-pop" role="menu" onMouseLeave={() => setMoreMenu(false)}>
                      <button role="menuitem" disabled={!visible.some((t) => t.unread)} onClick={() => { setMoreMenu(false); bulk('read', visible.filter((t) => t.unread).map((t) => t.id)); }}>Mark all as read</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {!['archive', 'trash', 'sent', 'drafts'].includes(view) && (
                  <button className="ib" onClick={() => bulk('archive')} aria-label="Archive" title="Archive"><Icon name="archive" size={20} /></button>
                )}
                <button className="ib" onClick={() => bulk(view === 'junk' ? 'notjunk' : 'junk')} aria-label={view === 'junk' ? 'Not spam' : 'Report spam'} title={view === 'junk' ? 'Not spam' : 'Report spam'}><Icon name="spam" size={20} /></button>
                <button className="ib" onClick={() => bulk(view === 'trash' ? 'inbox' : 'trash')} aria-label={view === 'trash' ? 'Move to Inbox' : 'Delete'} title={view === 'trash' ? 'Move to Inbox' : 'Delete'}><Icon name={view === 'trash' ? 'moveInbox' : 'trash'} size={20} /></button>
                <span className="tb-div" />
                {checkedRows.some((t) => t.unread) ? (
                  <button className="ib" onClick={() => bulk('read')} aria-label="Mark as read" title="Mark as read"><Icon name="mailOpen" size={20} /></button>
                ) : (
                  <button className="ib" onClick={() => bulk('unread')} aria-label="Mark as unread" title="Mark as unread"><Icon name="mail" size={20} /></button>
                )}
                {oneAccount && (
                  <button className="ib" onClick={() => { ui.setMoveTarget({ threadIds: checkedIds, accountId: checkedRows[0].accountId }); setChecked(new Set()); }} aria-label="Move to" title="Move to"><Icon name="move" size={20} /></button>
                )}
                <button className="ib" onClick={() => bulk(checkedRows.every((t) => t.pinned) ? 'unpin' : 'pin')} aria-label="Star" title={checkedRows.every((t) => t.pinned) ? 'Remove star' : 'Add star'}><Icon name={checkedRows.every((t) => t.pinned) ? 'starFilled' : 'star'} size={20} /></button>
                <span className="tb-count">{checkedIds.length} selected</span>
              </>
            )}
            <span className="sp" />
            {counts && rows.length > 0 && (
              <span className="range">{`1–${rows.length.toLocaleString()} of ${counts.total.toLocaleString()}`}</span>
            )}
          </div>
        )}
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
      </header>
      <div className="ptr" ref={ptrRef} aria-hidden="true">
        <Icon name="refresh" size={20} />
      </div>
      <div className="list" role="list" ref={listRef}>
        {aiAnswer && !main.isLoading && (
          <div className="ai-answer" role="note">
            <div className="ai-top"><Icon name="sparkle" size={18} /><b>Claude</b></div>
            <p>{aiAnswer}</p>
            <small>From the emails below. Check the email before relying on it.</small>
          </div>
        )}
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

function GroupsRow({ lines, base, render }: { lines: GroupSummary[]; base: { view: string; account?: string }; render: (t: ThreadSummary) => ReactNode }) {
  const open = useUI((s) => !!s.bundlesOpen.groups);
  const toggle = useUI((s) => s.toggleBundle);
  const fresh = lines.filter((g) => g.fresh > 0);
  const newCount = fresh.reduce((n, g) => n + g.fresh, 0);
  const importantCount = lines.reduce((n, g) => n + (g.important ?? 0), 0);
  const names = (fresh.length ? fresh : lines).map((g) => g.name);
  const summary = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
  // Important grouped mail (sales, codes, failed payments…) shows right here while unread.
  const important = useQuery({
    queryKey: ['groupSummary', 'important', base.account ?? 'all'],
    queryFn: () => api.groups.important(base.account),
    enabled: importantCount > 0,
    staleTime: 30_000,
  });
  const imp = importantCount > 0 ? important.data?.threads ?? [] : [];
  return (
    <section className={`bundle groups-row${open ? ' open' : ''}${newCount ? ' fresh' : ''}`} aria-label="Groups">
      <button className="bundle-head" onClick={() => toggle('groups')} aria-expanded={open}>
        <span className="bundle-ico"><Icon name="labelFilled" size={18} /></span>
        <span className="bundle-title">
          <span>Groups <small className="group-count">{lines.length}</small></span>
          <small>{summary}</small>
        </span>
        {importantCount > 0 && <span className="pill pill-imp">{importantCount} important</span>}
        {newCount > 0 && <span className="pill">{newCount} new</span>}
        <Icon name="chevronDown" size={18} className="bundle-chev" />
      </button>
      {!open && imp.length > 0 && <div className="groups-important" aria-label="Important in groups">{imp.map(render)}</div>}
      {open && <div className="groups-list">{lines.map((g) => <GroupBundle key={g.name} summary={g} base={base} render={render} />)}</div>}
    </section>
  );
}

function GroupBundle({ summary: g, base, render }: { summary: GroupSummary; base: { view: string; account?: string }; render: (t: ThreadSummary) => ReactNode }) {
  const k = `group:${g.name}`;
  const open = useUI((s) => !!s.bundlesOpen[k]);
  const toggle = useUI((s) => s.toggleBundle);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  const q = useThreadList({ ...base, group: g.name }, open);
  const rows = open ? flat(q.data) : [];
  const flip = () => {
    toggle(k);
    // Opening it counts as having seen what is in it.
    if (!open && g.fresh > 0) void api.groups.seen(g.name).then(() => qc.invalidateQueries({ queryKey: ['groupSummary'] }));
  };
  const done = async () => {
    // Gone from the list at once; the server archives in the background.
    const key = ['groupSummary', base.account ?? 'all'];
    const before = qc.getQueryData<{ groups: GroupSummary[] }>(key);
    qc.setQueryData<{ groups: GroupSummary[] }>(key, (d) => (d ? { groups: d.groups.filter((x) => x.name !== g.name) } : d));
    if (open) toggle(k);
    try {
      const r = await api.groups.done(g.name, base.account);
      toast({ text: `Archiving ${pluralize(r.affected, 'conversation')} from ${g.name}`, kind: 'success' });
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['groupSummary'] });
        qc.invalidateQueries({ queryKey: ['threads'] });
      }, 4000);
    } catch (e) {
      qc.setQueryData(key, before);
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };
  const who = g.latestFrom.name || g.latestFrom.email;
  return (
    <section className={`bundle group-line${open ? ' open' : ''}${g.fresh ? ' fresh' : ''}`} aria-label={g.name}>
      <div className="bundle-head-row">
        <button className="bundle-head" onClick={flip} aria-expanded={open}>
          <span className="bundle-ico"><Icon name="labelFilled" size={16} /></span>
          <span className="bundle-title">
            <span>{g.name} <small className="group-count">{g.total}</small></span>
            <small>{open ? pluralize(g.total, 'conversation') : `${who}: ${g.latestSubject}`}</small>
          </span>
          {(g.important ?? 0) > 0 && <span className="pill pill-imp">{g.important} important</span>}
          {g.fresh > 0 && <span className="pill">{g.fresh} new</span>}
          <span className="group-date">{formatListDate(g.latestDate)}</span>
        </button>
        <button className="ib group-done" onClick={() => void done()} aria-label={`Archive everything from ${g.name}`} title="Done: archive the whole group">
          <Icon name="check" size={20} />
        </button>
      </div>
      {rows.map(render)}
      {open && q.hasNextPage && (
        <button className="bundle-more" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading' : 'Load more'}
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
