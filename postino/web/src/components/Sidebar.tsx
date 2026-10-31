import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccounts, useBlocked, useFolders } from '../api/hooks';
import { Icon, type IconName } from '../icons';
import { useNav, VIEW_LABEL } from '../nav';
import { useUI } from '../store';

// Gmail's order: the everyday folders first, the rest behind "More".
const MAIN_NAV: { view: string; icon: IconName }[] = [
  { view: 'inbox', icon: 'inbox' },
  { view: 'pinned', icon: 'star' },
  { view: 'sent', icon: 'send' },
  { view: 'drafts', icon: 'draft' },
];
const MORE_NAV: { view: string; icon: IconName }[] = [
  { view: 'archive', icon: 'archive' },
  { view: 'junk', icon: 'spam' },
  { view: 'trash', icon: 'trash' },
  { view: 'blocked', icon: 'block' },
];

function readMore(): boolean {
  try {
    return localStorage.getItem('postino.navMore') === '1';
  } catch {
    return false;
  }
}

export function Sidebar() {
  const nav = useNav();
  const { data: accounts } = useAccounts();
  const { data: folders } = useFolders();
  const { data: blocked } = useBlocked();
  const openCompose = useUI((s) => s.openCompose);
  const setDrawer = useUI((s) => s.setDrawer);
  const [more, setMoreState] = useState(readMore);
  const setMore = (v: boolean) => {
    setMoreState(v);
    try {
      localStorage.setItem('postino.navMore', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const totalUnread = (accounts ?? []).reduce((n, a) => n + a.unread, 0);
  const draftCount = (folders ?? []).filter((f) => f.role === 'drafts').reduce((n, f) => n + f.total, 0);
  const otherFolders = (folders ?? []).filter((f) => f.role === 'other' && (!nav.accountId || f.accountId === nav.accountId));

  const count = (view: string) => {
    if (view === 'inbox') return nav.accountId ? accounts?.find((a) => a.id === nav.accountId)?.unread ?? 0 : totalUnread;
    if (view === 'drafts') return draftCount;
    if (view === 'blocked') return blocked?.senders.length ?? 0;
    if (view === 'junk') return (folders ?? []).filter((f) => f.role === 'junk' && (!nav.accountId || f.accountId === nav.accountId)).reduce((n, f) => n + f.unread, 0);
    return 0;
  };
  const close = () => setDrawer(false);
  // Keep "More" open while one of its folders is showing.
  const moreOn = more || MORE_NAV.some((f) => f.view === nav.view) || nav.view.startsWith('folder:');

  const item = (f: { view: string; icon: IconName }) => {
    const n = count(f.view);
    const on = nav.view === f.view && !nav.isSettings;
    return (
      <Link key={f.view} to={nav.build(f.view, null)} className={`nav-item${on ? ' on' : ''}${n > 0 && f.view === 'inbox' ? ' bold' : ''}`} onClick={close} aria-current={on ? 'page' : undefined} title={VIEW_LABEL[f.view]}>
        <Icon name={f.icon} size={20} />
        <span className="nav-label">{VIEW_LABEL[f.view]}</span>
        {n > 0 && <span className="n">{n.toLocaleString()}</span>}
      </Link>
    );
  };

  return (
    <aside className="sidebar" aria-label="Mailboxes">
      <div className="drawer-brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={30} height={30} />
        <span>Postino</span>
      </div>
      <div className="compose-wrap">
        <button className="compose-btn" onClick={() => { close(); openCompose({ mode: 'new', accountId: nav.accountId ?? undefined }); }} title="Compose">
          <Icon name="pen" size={24} />
          <span className="nav-label">Compose</span>
        </button>
      </div>
      <nav className="nav" aria-label="Folders">
        {MAIN_NAV.map(item)}
        <button className="nav-item" onClick={() => setMore(!moreOn)} aria-expanded={moreOn} title={moreOn ? 'Less' : 'More'}>
          <Icon name="chevronDown" size={20} style={{ transform: moreOn ? 'rotate(180deg)' : undefined }} />
          <span className="nav-label">{moreOn ? 'Less' : 'More'}</span>
        </button>
        {moreOn && (
          <>
            {MORE_NAV.map(item)}
            {otherFolders.map((f) => {
              const v = `folder:${f.id}`;
              const on = nav.view === v;
              return (
                <Link key={f.id} to={nav.build(v, null)} className={`nav-item${on ? ' on' : ''}`} onClick={close} title={f.name}>
                  <Icon name="folder" size={20} />
                  <span className="nav-label">{f.name}</span>
                  {f.unread > 0 && <span className="n">{f.unread}</span>}
                </Link>
              );
            })}
          </>
        )}
      </nav>
      <nav className="nav labels" aria-label="Accounts">
        <div className="nav-title">
          <span className="nav-label">Accounts</span>
          <Link to="/settings/accounts" className="ib" aria-label="Add a mailbox" title="Add a mailbox" onClick={close}>
            <Icon name="plus" size={20} />
          </Link>
        </div>
        {(accounts ?? []).map((a) => {
          const on = nav.accountId === a.id;
          return (
            <button key={a.id} className={`nav-item${on ? ' on' : ''}`} onClick={() => { nav.setAccount(on ? null : a.id); close(); }} title={a.error ?? a.email} aria-pressed={on}>
              <Icon name="labelFilled" size={20} style={{ color: a.color }} />
              <span className="nav-label acct-email">{a.email}</span>
              {a.status === 'error' && <i className="acct-status err" aria-label="Connection problem" />}
              {a.status === 'syncing' && <i className="acct-status sync" aria-label="Syncing" />}
              {a.unread > 0 && <span className="n">{a.unread}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <Link to="/settings" className={`nav-item${nav.isSettings ? ' on' : ''}`} onClick={close}>
          <Icon name="settings" size={20} />
          <span className="nav-label">Settings</span>
        </Link>
      </div>
    </aside>
  );
}
