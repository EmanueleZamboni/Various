import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { useUI } from './store';

type SendResult = { ok: true; queued?: boolean; outboxId?: string; sendAt?: string; threadId: string | null };

/**
 * After a send: "Sent" right away, or "Sending in 10 s · Undo" while the
 * outbox holds it. Undo pulls it back as a draft and reopens the composer.
 */
export function useSendFeedback() {
  const toast = useUI((s) => s.toast);
  const dismiss = useUI((s) => s.dismissToast);
  const openCompose = useUI((s) => s.openCompose);
  const qc = useQueryClient();
  return useCallback(
    (r: SendResult, fromEmail: string) => {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['outbox'] });
      if (!r.queued || !r.outboxId) {
        toast({ text: `Sent from ${fromEmail}`, kind: 'success' });
        return;
      }
      const secs = r.sendAt ? Math.max(1, Math.round((new Date(r.sendAt).getTime() - Date.now()) / 1000)) : 10;
      const later = secs > 120;
      const when = later ? new Date(r.sendAt as string).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : `${secs} s`;
      const id = toast({
        text: later ? `Scheduled for ${when}` : `Sending in ${when}`,
        ttl: later ? 6000 : secs * 1000 + 500,
        undo: async () => {
          try {
            const res = await api.outbox.cancel(r.outboxId as string);
            qc.invalidateQueries({ queryKey: ['drafts'] });
            qc.invalidateQueries({ queryKey: ['outbox'] });
            openCompose({ mode: 'new', draft: res.draft, accountId: res.draft.accountId });
          } catch {
            toast({ text: 'Too late, it was already sent.', kind: 'error' });
          }
        },
      });
      void id;
      void dismiss;
    },
    [toast, dismiss, openCompose, qc],
  );
}

/** "Send later" presets, like Spark's. */
export function sendLaterOptions(): { label: string; at: Date }[] {
  const now = new Date();
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  const inOneHour = new Date(now.getTime() + 3600_000);
  const out: { label: string; at: Date }[] = [{ label: 'In 1 hour', at: inOneHour }];
  if (now.getHours() < 17) out.push({ label: 'This evening (18:00)', at: at(now, 18) });
  out.push({ label: 'Tomorrow morning (9:00)', at: at(tomorrow, 9) });
  out.push({ label: 'Monday morning (9:00)', at: at(monday, 9) });
  return out;
}
