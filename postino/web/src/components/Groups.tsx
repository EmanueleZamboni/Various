import { useState } from 'react';
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
