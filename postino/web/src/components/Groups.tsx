import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useGroups } from '../api/hooks';
import { Icon } from '../icons';
import { useUI } from '../store';

/** "Group emails from …": pick a group (or make one) for exactly this sender address. */
export function GroupDialog() {
  const target = useUI((s) => s.groupTarget)!;
  const setTarget = useUI((s) => s.setGroupTarget);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  const { data } = useGroups();
  const groups = data?.groups ?? [];
  const [choice, setChoice] = useState<string>('__new');
  const [name, setName] = useState(target.name || target.email.split('@')[0]);
  const [busy, setBusy] = useState(false);
  const close = () => setTarget(null);
  const save = async () => {
    const group = choice === '__new' ? name.trim() : choice;
    if (!group) return;
    setBusy(true);
    try {
      await api.groups.add(target.email, group);
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['threads'] });
      toast({ text: `Emails from ${target.email} now go in “${group}”` , kind: 'success' });
      close();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="sheet small group-dialog" role="dialog" aria-modal="true" aria-labelledby="group-title" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2 id="group-title">Group emails from this sender</h2>
        <p className="help">
          Only emails from exactly <b>{target.email}</b> go in the group, shown as one line at the top of your inbox. Conversations where anyone else wrote, you included, stay in the inbox. You still get notifications.
        </p>
        <div className="group-choices" role="radiogroup">
          {groups.map((g) => (
            <label key={g.name} className="group-choice">
              <input type="radio" name="group" checked={choice === g.name} onChange={() => setChoice(g.name)} />
              <span>{g.name}</span>
              <small>{g.senders.length} sender{g.senders.length === 1 ? '' : 's'}</small>
            </label>
          ))}
          <label className="group-choice">
            <input type="radio" name="group" checked={choice === '__new'} onChange={() => setChoice('__new')} />
            <span>New group</span>
            {choice === '__new' && <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" autoFocus maxLength={60} />}
          </label>
        </div>
        <div className="sheet-actions">
          <button type="button" className="btn btn-quiet" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (choice === '__new' && !name.trim())}>Group</button>
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
export function GroupSuggestions({ force = false, onDone }: { force?: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
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
  if (dismissed && !force && !open) return null;
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
      {!force && (
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
      {open && (
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
        </div>
      )}
    </>
  );
}
