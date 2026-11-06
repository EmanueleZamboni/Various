import { groupedSenderNotifies } from './groups.js';
import { getAvatar } from './avatars.js';
import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';
import { bus } from './events.js';
import { log } from './log.js';
import { config } from './config.js';

type Vapid = { publicKey: string; privateKey: string };

export function vapidKeys(): Vapid {
  let keys = getSetting<Vapid | null>('vapid', null);
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    setSetting('vapid', keys);
  }
  return keys;
}

export type NotificationSettings = { enabled: boolean; categories: ('person' | 'notification' | 'newsletter')[] };

export function notificationSettings(): NotificationSettings {
  return getSetting<NotificationSettings>('notifications', { enabled: true, categories: ['person'] });
}

export type PushResult = { sent: number; failed: { status: number | null; message: string }[]; removed: number };

/** The last notification decisions, newest first: what was pushed, what was skipped and why. For diagnosis only. */
type PushLogEntry = { at: string; kind: 'mail' | 'test'; title: string; outcome: string; sent?: number; failed?: { status: number | null; message: string }[] };
export function pushLog(): PushLogEntry[] {
  return getSetting<PushLogEntry[]>('push.log', []);
}
function logPush(e: Omit<PushLogEntry, 'at'>): void {
  const list = pushLog();
  list.unshift({ at: new Date().toISOString(), ...e, title: e.title.slice(0, 80) });
  setSetting('push.log', list.slice(0, 40));
}
export function logTestPush(r: PushResult): void {
  logPush({ kind: 'test', title: 'Test notification', outcome: r.sent ? 'sent' : r.failed.length ? 'failed' : 'no devices', sent: r.sent, failed: r.failed });
}

/** Devices that will get notifications, without their secret keys. */
export function pushDevices(): { id: number; service: string; userAgent: string; since: string }[] {
  const rows = db.prepare('SELECT id, endpoint, user_agent, created_at FROM push_subscriptions ORDER BY id').all() as { id: number; endpoint: string; user_agent: string | null; created_at: string }[];
  return rows.map((r) => {
    let service = '?';
    try {
      service = new URL(r.endpoint).host;
    } catch {
      /* keep ? */
    }
    return { id: r.id, service, userAgent: r.user_agent || '', since: r.created_at };
  });
}

/** Who the push services can contact about this sender: a real address or URL, never localhost. */
function vapidSubject(): string {
  if (config.baseUrl && /^https:\/\//.test(config.baseUrl)) return config.baseUrl;
  const acc = db.prepare('SELECT email FROM accounts ORDER BY id LIMIT 1').get() as { email: string } | undefined;
  return acc ? `mailto:${acc.email}` : 'mailto:postino@example.com';
}

export type PushPayload = { title: string; body: string; threadId?: string; accountId?: string; tag?: string; from?: string; account?: string; at?: number };

export async function sendPush(payload: PushPayload, onlyEndpoint?: string): Promise<PushResult> {
  const keys = vapidKeys();
  webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
  const all = db.prepare('SELECT id, endpoint, subscription_json FROM push_subscriptions').all() as { id: number; endpoint: string; subscription_json: string }[];
  const subs = onlyEndpoint ? all.filter((s) => s.endpoint === onlyEndpoint) : all;
  const result: PushResult = { sent: 0, failed: [], removed: 0 };
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(JSON.parse(s.subscription_json), JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
        result.sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? null;
        const body = String((err as { body?: string }).body || (err as Error).message || '').slice(0, 200);
        result.failed.push({ status: code, message: body });
        // Gone for good: the browser dropped this subscription.
        if (code === 404 || code === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
          result.removed++;
        }
        log.warn({ status: code, err: body }, 'push failed');
      }
    }),
  );
  return result;
}

/** Push a notification for new inbox mail that matches the user's settings. */
export function startPushBridge(): void {
  bus.on('event', (ev) => {
    if (ev.type !== 'new.mail') return;
    const s = notificationSettings();
    const who = ev.from?.name || ev.from?.email || '?';
    const skip = (why: string) => logPush({ kind: 'mail', title: who, outcome: `skipped: ${why}` });
    if (!s.enabled) return skip('notifications are off in Settings');
    const acct = db.prepare('SELECT email, name, notify FROM accounts WHERE id = ?').get(Number(ev.accountId)) as { email: string; name: string; notify: string } | undefined;
    // Per-account level: "default" follows the global categories, "all" everything, "people" only people, "none" silent.
    const level = acct?.notify || 'default';
    if (level === 'none') return skip('this mailbox is set to silent');
    // Senders you grouped still notify (that is the point of grouping instead of filtering).
    const grouped = Boolean(ev.from?.email) && groupedSenderNotifies(ev.from.email);
    if (!grouped && level === 'people' && ev.category !== 'person') return skip(`mailbox notifies people only, this is ${ev.category}`);
    if (!grouped && level === 'default' && !s.categories.includes(ev.category as never)) return skip(`category ${ev.category} is not chosen in Settings`);
    void (async () => {
      // Wait a few seconds for the body, so the notification can show the first lines like Gmail does,
      // and start fetching the sender's picture meanwhile.
      if (ev.from?.email) void getAvatar(ev.from.email).catch(() => null);
      const snip = db.prepare('SELECT snippet FROM messages WHERE thread_id = ? AND mine = 0 ORDER BY date DESC, id DESC LIMIT 1');
      let snippet = '';
      for (let i = 0; i < 12 && !snippet; i++) {
        snippet = ((snip.get(Number(ev.threadId)) as { snippet: string } | undefined)?.snippet || '').trim();
        if (!snippet) await new Promise((r) => setTimeout(r, 1000));
      }
      const many = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n > 1;
      const r = await sendPush({
        title: who,
        body: [ev.subject || '(no subject)', snippet.replace(/\[image:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 160)].filter(Boolean).join('\n'),
        threadId: ev.threadId,
        accountId: ev.accountId,
        tag: `thread-${ev.threadId}`,
        from: ev.from?.email || '',
        account: many && acct ? acct.email : '',
        at: Date.now(),
      });
      logPush({ kind: 'mail', title: who, outcome: r.sent ? 'sent' : r.failed.length ? 'failed' : 'no devices', sent: r.sent, failed: r.failed });
    })().catch((err: Error) => logPush({ kind: 'mail', title: who, outcome: `error: ${err.message}` }));
  });
}
