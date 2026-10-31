import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Me } from '../api/types';
import { useAccounts } from '../api/hooks';
import { Icon } from '../icons';
import { useUI } from '../store';
import { SearchBar } from './SearchBar';

/** Gmail's top bar: menu, logo, search, then help, settings and the account circle. */
export function TopBar({ onMenu, onLogout }: { me?: Me; onMenu: () => void; onLogout: () => void }) {
  const setShortcuts = useUI((s) => s.setShortcuts);
  const { data: accounts } = useAccounts();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  const first = accounts?.[0]?.email ?? '';
  const letter = (first[0] ?? 'P').toUpperCase();
  return (
    <header className="topbar">
      <button className="ib top-menu" onClick={onMenu} aria-label="Main menu" title="Main menu">
        <Icon name="menu" size={24} />
      </button>
      <Link to="/inbox" className="brand" aria-label="Postino inbox">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={36} height={36} />
        <span className="brand-name">Postino</span>
      </Link>
      <SearchBar />
      <div className="top-right">
        <button className="ib" onClick={() => setShortcuts(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
          <Icon name="help" size={24} />
        </button>
        <Link to="/settings" className="ib" aria-label="Settings" title="Settings">
          <Icon name="settings" size={24} />
        </Link>
        <div className="me-wrap" ref={box}>
          <button className="me-btn" onClick={() => setOpen((v) => !v)} aria-label="Your accounts" aria-expanded={open} title={first}>
            <span>{letter}</span>
          </button>
          {open && (
            <div className="me-pop" role="menu">
              <div className="me-head">
                <span className="me-big">{letter}</span>
                <b>Postino</b>
                <small>{accounts?.length ?? 0} mailboxes connected</small>
              </div>
              <div className="me-list">
                {(accounts ?? []).map((a) => (
                  <div key={a.id} className="me-acct">
                    <Icon name="labelFilled" size={18} style={{ color: a.color }} />
                    <span>{a.email}</span>
                  </div>
                ))}
              </div>
              <div className="me-actions">
                <Link to="/welcome" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                  <Icon name="plus" size={18} />
                  Add mailbox
                </Link>
                <button className="btn btn-ghost btn-sm" onClick={onLogout}>
                  <Icon name="logout" size={18} />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
