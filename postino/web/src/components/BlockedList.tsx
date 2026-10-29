import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useBlocked } from '../api/hooks';
import { Icon } from '../icons';
import { useUI } from '../store';
import { formatListDate, initials, pluralize } from '../util/format';

export function BlockedList() {
  const { data, isLoading } = useBlocked();
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['blocked'] });
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
  };
  const unblock = useMutation({
    mutationFn: (id: string) => api.blocked.remove(id),
    onSuccess: (_d, id) => {
      const entry = data?.senders.find((s) => s.id === id);
      invalidate();
      toast({
        text: `Unblocked ${entry?.pattern ?? 'sender'}`,
        undo: entry ? async () => { await api.blocked.add(entry.pattern, entry.note); invalidate(); } : undefined,
      });
    },
    onError: (e) => toast({ text: (e as Error).message, kind: 'error' }),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.blocked.restore(id),
    onSuccess: (r) => {
      invalidate();
      toast({ text: r.moved ? `Moved ${pluralize(r.moved, 'message')} back to Inbox` : 'Nothing to restore' });
    },
    onError: (e) => toast({ text: (e as Error).message, kind: 'error' }),
  });

  if (isLoading) return <div className="note">Loading</div>;
  const senders = data?.senders ?? [];
  return (
    <>
      <p className="note">Mail from these senders skips your inbox and lands in the Blocked folder, on every device, even when Postino is closed.</p>
      {senders.length === 0 && (
        <div className="empty">
          <div className="big"><Icon name="block" size={24} /></div>
          <h2>No blocked senders</h2>
          <p>Open an email and choose Block sender. Blocking an address like @example.com blocks the whole domain.</p>
        </div>
      )}
      {senders.map((s) => (
        <div className="blocked-row" key={s.id}>
          <div className="av" style={{ ['--c' as string]: 'var(--rose)' }}>{initials(s.pattern.replace(/^@/, ''))}</div>
          <div className="acct">
            <span style={{ fontWeight: 500 }}>{s.pattern}</span>
            <small>
              {s.pattern.startsWith('@') ? 'Whole domain' : 'Address'} · {pluralize(s.count, 'message')} blocked · since {formatListDate(s.createdAt)}
              {s.note ? ` · ${s.note}` : ''}
            </small>
          </div>
          {s.count > 0 && (
            <button className="btn btn-quiet btn-sm" onClick={() => restore.mutate(s.id)} disabled={restore.isPending}>
              Restore mail
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => unblock.mutate(s.id)} disabled={unblock.isPending}>
            Unblock
          </button>
        </div>
      ))}
    </>
  );
}
