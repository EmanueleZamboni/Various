import { Link } from 'react-router-dom';
import { useAccounts, useBlocked, useFolders } from '../api/hooks';
import { Icon, type IconName } from '../icons';
import { useNav, VIEW_LABEL } from '../nav';
import { useUI } from '../store';

const FOLDER_NAV: { view: string; icon: IconName }[] = [
  { view: 'inbox', icon: 'inbox' },
  { view: 'pinned', icon: 'pin' },
  { view: 'sent', icon: 'send' },
  { view: 'drafts', icon: 'draft' },
  { view: 'archive', icon: 'archive' },
  { view: 'junk', icon: 'spam' },
  { view: 'trash', icon: 'trash' },
  { view: 'blocked', icon: 'block' },
];

export function Sidebar() {
  const nav = useNav();
  const { data: accounts } = useAccounts();
  const { data: folders } = useFolders();
  const { data: blocked } = useBlocked();
  const openCompose = useUI((s) => s.openCompose);
  const setDrawer = useUI((s) => s.setDrawer);

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

  return (
    <aside className="sidebar" aria-label="Mailboxes">
      <Link to="/inbox" className="brand" onClick={() => setDrawer(false)}>
        <span className="brand-mark"><img src={`${import.meta.env.BASE_URL}mascot.svg`} alt="" width={34} height={34} /></span>
        <span className="brand-name">Postino</span>
      </Link>
      <button className="compose-btn" onClick={() => openCompose({ mode: 'new', accountId: nav.accountId ?? undefined })}>
        <Icon name="pen" size={18} />
        New email
      </button>
      <nav className="nav" aria-label="Folders">
        {FOLDER_NAV.map((f) => {
          const n = count(f.view);
          const on = nav.view === f.view && !nav.isSettings;
          return (
            <Link key={f.view} to={nav.build(f.view, null)} className={`nav-item${on ? ' on' : ''}`} onClick={() => setDrawer(false)} aria-current={on ? 'page' : undefined}>
              <Icon name={f.icon} size={18} />
              <span>{VIEW_LABEL[f.view]}</span>
              {n > 0 && <span className={`n${f.view === 'inbox' ? ' strong' : ''}`}>{n}</span>}
            </Link>
          );
        })}
        {otherFolders.map((f) => {
          const v = `folder:${f.id}`;
          const on = nav.view === v;
          return (
            <Link key={f.id} to={nav.build(v, null)} className={`nav-item${on ? ' on' : ''}`} onClick={() => setDrawer(false)}>
              <Icon name="folder" size={18} />
              <span>{f.name}</span>
              {f.unread > 0 && <span className="n">{f.unread}</span>}
            </Link>
          );
        })}
      </nav>
      <nav className="nav" aria-label="Accounts">
        <div className="nav-title">
          <span>Accounts</span>
          <Link to="/settings/accounts" className="ib" style={{ width: 24, height: 24 }} aria-label="Manage accounts" onClick={() => setDrawer(false)}>
            <Icon name="plus" size={14} />
          </Link>
        </div>
        <button className={`nav-item${!nav.accountId ? ' on' : ''}`} onClick={() => { nav.setAccount(null); setDrawer(false); }}>
          <Icon name="people" size={18} />
          <span>All accounts</span>
          {totalUnread > 0 && <span className="n">{totalUnread}</span>}
        </button>
        {(accounts ?? []).map((a) => (
          <button key={a.id} className={`nav-item${nav.accountId === a.id ? ' on' : ''}`} onClick={() => { nav.setAccount(a.id); setDrawer(false); }} title={a.error ?? a.email}>
            <i className="dot" style={{ ['--c' as string]: a.color }} />
            <span className="acct">
              <span className="email">{a.email}</span>
            </span>
            {a.status === 'error' && <i className="acct-status err" aria-label="Connection problem" />}
            {a.status === 'syncing' && <i className="acct-status sync" aria-label="Syncing" />}
            {a.unread > 0 && <span className="n">{a.unread}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <Link to="/settings" className={`nav-item${nav.isSettings ? ' on' : ''}`} onClick={() => setDrawer(false)}>
          <Icon name="settings" size={18} />
          <span>Settings</span>
        </Link>
      </div>
    </aside>
  );
}
