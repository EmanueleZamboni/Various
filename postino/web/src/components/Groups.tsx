import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useGroups } from '../api/hooks';
import { Icon } from '../icons';
import { useUI } from '../store';

/** The part of an address that names the company: info@mail.amazon.it -> amazon.it, x@foo.co.uk -> foo.co.uk. */
function baseDomain(email: string): string {
  const labels = (email.split('@')[1] || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const twoPart = /^(co|com|org|net|gov|ac|edu)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  return labels.slice(twoPart ? -3 : -2).join('.');
}

type GroupInfo = { name: string; senders: string[]; notify: boolean; lastUsed?: string };

/** "Group emails from …": pick a group (or make one) for exactly this sender address. */
export function GroupDialog() {
  const target = useUI((s) => s.groupTarget)!;
  const setTarget = useUI((s) => s.setGroupTarget);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  const { data } = useGroups();
  const groups: GroupInfo[] = data?.groups ?? [];
  const domain = baseDomain(target.email);
  // Groups that already hold mail from the same company come first, then the ones used last.
  const sameCompany = domain ? groups.filter((g) => g.senders.some((s) => baseDomain(s) === domain)) : [];
  const recent = [...groups]
    .filter((g) => !sameCompany.includes(g))
    .sort((a, b) => ((a.lastUsed || '') < (b.lastUsed || '') ? 1 : -1))
    .slice(0, 3);
  const top = [...sameCompany.slice(0, 3), ...recent];
  const [filter, setFilter] = useState('');
  const others = groups
    .filter((g) => !top.includes(g) && g.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [choice, setChoice] = useState<string | null>(null);
  const picked = choice ?? sameCompany[0]?.name ?? null;
  const [name, setName] = useState(target.name || target.email.split('@')[0]);
  const [busy, setBusy] = useState(false);
  const close = () => setTarget(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const save = async () => {
    const group = picked === '__new' ? name.trim() : picked;
    if (!group) return;
    setBusy(true);
    try {
      await api.groups.add(target.email, group);
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['groupSummary'] });
      toast({ text: `Emails from ${target.email} now go in “${group}”`, kind: 'success' });
      close();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const row = (g: GroupInfo, note?: string) => (
    <label key={g.name} className={`group-choice${picked === g.name ? ' on' : ''}`}>
      <input type="radio" name="group" checked={picked === g.name} onChange={() => setChoice(g.name)} />
      <span>{g.name}</span>
      <small>{note ?? `${g.senders.length} sender${g.senders.length === 1 ? '' : 's'}`}</small>
    </label>
  );
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="sheet small group-dialog" role="dialog" aria-modal="true" aria-labelledby="group-title" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="group-head">
          <h2 id="group-title">Group this sender</h2>
          <button type="button" className="ib" aria-label="Close" title="Close" onClick={close}><Icon name="x" size={20} /></button>
        </div>
        <p className="help">
          Mail from <b>{target.email}</b> to any of your mailboxes will show as one line at the top of the inbox. You still get notifications.
        </p>
        <div className="group-choices" role="radiogroup" aria-label="Group">
          <label className={`group-choice${picked === '__new' ? ' on' : ''}`}>
            <input type="radio" name="group" checked={picked === '__new'} onChange={() => setChoice('__new')} />
            <span>New group</span>
            {picked === '__new' && <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" autoFocus maxLength={60} />}
          </label>
          {top.length > 0 && <div className="group-sec">{sameCompany.length ? 'Suggested and recent' : 'Recent'}</div>}
          {top.map((g) => row(g, sameCompany.includes(g) ? `same company · ${g.senders.length}` : undefined))}
          {groups.length > top.length && (
            <>
              <div className="group-sec">All groups</div>
              {groups.length > 8 && (
                <input className="input group-filter" type="search" placeholder="Find a group" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a group" />
              )}
              {others.map((g) => row(g))}
              {others.length === 0 && <p className="help">No group with that name.</p>}
            </>
          )}
        </div>
        <div className="sheet-actions">
          <button type="button" className="btn btn-quiet" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !picked || (picked === '__new' && !name.trim())}>Group</button>
        </div>
      </form>
    </div>
  );
}

/** Settings → Inbox: the groups, who is in them, and whether they notify. */
export function GroupsSettings() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data } = useGroups();
  const groups = data?.groups ?? [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['threads'] });
  };
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      refresh();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };
  return (
    <div className="settings-section">
      <h2>Groups</h2>
      <p className="help">Senders that flood the inbox (shop affiliates, security alerts…) collapsed into one line each. Add one with right-click (or long-press) on an email → “Group emails from…”.</p>
      {!groups.length && <p className="help">No groups yet.</p>}
      <GroupSuggestions force />
      {groups.map((g) => (
        <div className="card group-card" key={g.name}>
          <div className="group-head">
            <b>{g.name}</b>
            <label className="row-inline group-notify">
              <input type="checkbox" checked={g.notify} onChange={(e) => void run(api.groups.update(g.name, { notify: e.target.checked }))} />
              Notify
            </label>
          </div>
          {g.senders.map((s) => (
            <div className="group-sender" key={s}>
              <span>{s}</span>
              <button className="ib" aria-label={`Remove ${s} from the group`} title="Remove from the group" onClick={() => void run(api.groups.removeSender(s))}>
                <Icon name="x" size={18} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const DISMISS_KEY = 'postino.groupSuggest.dismissed';

/** Inbox banner: "Postino found automatic emails, group them?", with a review dialog. */
export function GroupSuggestions({ force = false, onDone, asNavItem = false }: { force?: boolean; onDone?: () => void; asNavItem?: boolean }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const setDrawer = useUI((s) => s.setDrawer);
  const { data } = useQuery({ queryKey: ['group-suggestions'], queryFn: api.groups.suggestions, staleTime: 10 * 60_000 });
  const list = data?.suggestions ?? [];
  const [dismissed, setDismissed] = useState(() => {
    try {
      return Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now() - 14 * 86_400_000;
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(force);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!list.length) return force ? <p className="help">No suggestions right now: no sender writes to you often enough.</p> : null;
  if (dismissed && !force && !open && !asNavItem) return null;
  const total = list.reduce((n, g) => n + g.senders.length, 0);
  const toggle = (email: string) =>
    setOff((o) => {
      const n = new Set(o);
      if (n.has(email)) n.delete(email);
      else n.add(email);
      return n;
    });
  const create = async () => {
    setBusy(true);
    try {
      const groups = list.map((g) => ({ name: g.name, senders: g.senders.map((x) => x.email).filter((e) => !off.has(e)) })).filter((g) => g.senders.length);
      const r = await api.groups.bulk(groups);
      toast({ text: `${r.added} senders grouped`, kind: 'success' });
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group-suggestions'] });
      qc.invalidateQueries({ queryKey: ['threads'] });
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setDismissed(true);
    setOpen(false);
  };
  return (
    <>
      {asNavItem && (
        <button className="nav-item" onClick={() => { setDrawer(false); setOpen(true); }} title="Group automatic senders">
          <Icon name="labelFilled" size={20} />
          <span className="nav-label">Suggested groups</span>
          <span className="n">{total}</span>
        </button>
      )}
      {!force && !asNavItem && (
        <div className="suggest-bar">
          <Icon name="labelFilled" size={18} />
          <span>
            <b>Tidy your inbox?</b> {total} automatic senders ({list.slice(0, 3).map((g) => g.name).join(', ')}{list.length > 3 ? '…' : ''}) can each become one line.
          </span>
          <button className="btn btn-quiet btn-sm" onClick={later}>Not now</button>
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Review</button>
        </div>
      )}
      {force && !open && (
        <button className="btn btn-ghost" onClick={() => setOpen(true)}>Suggest groups ({total} senders)</button>
      )}
      {open && createPortal(
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="sheet group-dialog suggest-sheet" role="dialog" aria-modal="true" aria-labelledby="suggest-title">
            <h2 id="suggest-title">Group automatic emails</h2>
            <p className="help">These addresses wrote to you at least 3 times and you never replied. Each group becomes one line at the top of the inbox; notifications keep coming. Untick anything you want to keep in the inbox.</p>
            <div className="suggest-list">
              {list.map((g) => (
                <div key={g.name} className="suggest-group">
                  <b>{g.name}</b>
                  {g.senders.map((x) => (
                    <label key={x.email} className="suggest-sender">
                      <input type="checkbox" checked={!off.has(x.email)} onChange={() => toggle(x.email)} />
                      <span>{x.email}</span>
                      <small>{x.count} emails</small>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="sheet-actions">
              <button className="btn btn-quiet" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>{busy ? 'Grouping…' : 'Create groups'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
