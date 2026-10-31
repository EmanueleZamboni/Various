import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { RsvpResponse } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';

const LABEL: Record<RsvpResponse, string> = { accepted: 'Yes', tentative: 'Maybe', declined: 'No' };

/** "Going? Yes / Maybe / No" on an invitation, like Gmail, plus what else is in your calendar then. */
export function InviteActions({ messageId, organizer }: { messageId: string; organizer?: string }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data } = useQuery({ queryKey: ['invite', messageId], queryFn: () => api.messages.invite(messageId), staleTime: 60_000 });
  const [busy, setBusy] = useState<RsvpResponse | null>(null);
  const answer = async (r: RsvpResponse) => {
    setBusy(r);
    try {
      const res = await api.messages.rsvp(messageId, r);
      toast({ text: `Replied ${LABEL[r]}${res.organizerTold && organizer ? ` to ${organizer}` : ''}${res.calendar ? ' · saved in Google Calendar' : ''}`, kind: 'success' });
      qc.invalidateQueries({ queryKey: ['invite', messageId] });
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const current = data?.rsvp ?? null;
  return (
    <div className="rsvp">
      <div className="rsvp-row">
        <span className="rsvp-q">Going?</span>
        {(['accepted', 'tentative', 'declined'] as RsvpResponse[]).map((r) => (
          <button key={r} type="button" className={`rsvp-btn${current === r ? ' on' : ''}`} disabled={busy !== null} onClick={() => void answer(r)} aria-pressed={current === r}>
            {current === r && <Icon name="check" size={16} />}
            {busy === r ? '…' : LABEL[r]}
          </button>
        ))}
      </div>
      {data?.conflicts && (
        <span className={`rsvp-cal${data.conflicts.length ? ' busy' : ''}`}>
          <Icon name="event" size={16} />
          {data.conflicts.length ? `Clashes with ${data.conflicts.map((c) => c.summary).slice(0, 2).join(', ')}${data.conflicts.length > 2 ? '…' : ''}` : 'You are free at that time'}
        </span>
      )}
    </div>
  );
}

/** Turn a conversation into a Google Task. */
export function useAddToTasks() {
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  return async (threadId: string) => {
    try {
      await api.tasks.add({ threadId });
      toast({ text: 'Added to Google Tasks', kind: 'success' });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };
}

/** Google Tasks on the right, like Gmail's side panel. */
export function TasksPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data, isLoading, error } = useQuery({ queryKey: ['tasks'], queryFn: api.tasks.list, staleTime: 30_000, retry: false });
  const [title, setTitle] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  const add = async () => {
    const t = title.trim();
    if (!t) return;
    setTitle('');
    try {
      await api.tasks.add({ title: t });
      refresh();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };
  const done = async (id: string) => {
    qc.setQueryData(['tasks'], (d: typeof data) => (d ? { tasks: d.tasks.filter((t) => t.id !== id) } : d));
    try {
      await api.tasks.update(id, { done: true });
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
      refresh();
    }
  };
  return (
    <aside className="side-panel" aria-label="Google Tasks">
      <div className="sp-head">
        <b>Tasks</b>
        <button className="ib" onClick={onClose} aria-label="Close tasks"><Icon name="x" size={20} /></button>
      </div>
      <form className="sp-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Icon name="addTask" size={20} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" />
      </form>
      <div className="sp-list">
        {isLoading && <p className="help">Loading…</p>}
        {error && <p className="help">{(error as Error).message}</p>}
        {data && !data.tasks.length && <p className="help">No tasks. Use “Add to Tasks” on an email to make one.</p>}
        {data?.tasks.map((t) => (
          <div className="sp-task" key={t.id}>
            <button className="sp-check" onClick={() => void done(t.id)} aria-label={`Mark “${t.title}” done`} title="Mark done" />
            <div className="sp-text">
              <span>{t.title}</span>
              {t.notes && <small>{t.notes.split('\n')[0]}</small>}
              {t.due && <small className="sp-due">{new Date(t.due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
