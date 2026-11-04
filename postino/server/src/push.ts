import { groupedSenderNotifies } from './groups.js';
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

/** Who the push services can contact about this sender: a real address or URL, never localhost. */
function vapidSubject(): string {
  if (config.baseUrl && /^https:\/\//.test(config.baseUrl)) return config.baseUrl;
  const acc = db.prepare('SELECT email FROM accounts ORDER BY id LIMIT 1').get() as { email: string } | undefined;
  return acc ? `mailto:${acc.email}` : 'mailto:postino@example.com';
}

export async function sendPush(payload: { title: string; body: string; threadId?: string; accountId?: string; tag?: string }, onlyEndpoint?: string): Promise<PushResult> {
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
    if (!s.enabled) return;
    const acct = db.prepare('SELECT email, name, notify FROM accounts WHERE id = ?').get(Number(ev.accountId)) as { email: string; name: string; notify: string } | undefined;
    // Per-account level: "default" follows the global categories, "all" everything, "people" only people, "none" silent.
    const level = acct?.notify || 'default';
    if (level === 'none') return;
    // Senders you grouped still notify (that is the point of grouping instead of filtering).
    const grouped = Boolean(ev.from?.email) && groupedSenderNotifies(ev.from.email);
    if (!grouped && level === 'people' && ev.category !== 'person') return;
    if (!grouped && level === 'default' && !s.categories.includes(ev.category as never)) return;
    const who = ev.from.name || ev.from.email;
    void sendPush({
      title: who,
      body: ev.subject || '(no subject)',
      threadId: ev.threadId,
      accountId: ev.accountId,
      tag: `thread-${ev.threadId}`,
      ...(acct ? { account: acct.email } : {}),
    } as never);
  });
}
