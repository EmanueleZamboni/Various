import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';
import { bus } from './events.js';
import { log } from './log.js';

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

export async function sendPush(payload: { title: string; body: string; threadId?: string; accountId?: string; tag?: string }): Promise<void> {
  const keys = vapidKeys();
  webpush.setVapidDetails('mailto:postino@localhost', keys.publicKey, keys.privateKey);
  const subs = db.prepare('SELECT id, subscription_json FROM push_subscriptions').all() as { id: number; subscription_json: string }[];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(JSON.parse(s.subscription_json), JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else {
          log.warn({ err: (err as Error).message }, 'push failed');
        }
      }
    }),
  );
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
    if (level === 'people' && ev.category !== 'person') return;
    if (level === 'default' && !s.categories.includes(ev.category as never)) return;
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
