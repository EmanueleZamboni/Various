import { api } from './api/client';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(vapidPublicKey: string): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    });
  }
  await api.push.subscribe(sub.toJSON());
  try {
    localStorage.removeItem(PUSH_OFF);
  } catch {
    /* ignore */
  }
  return 'ok';
}

const PUSH_OFF = 'postino.pushOff';

/**
 * Keeps notifications working by themselves: if this device allowed notifications but its
 * subscription is gone (the browser dropped it, or the app's offline copy was replaced),
 * subscribe again; if it exists, remind the server of it. Never asks for permission.
 */
export async function ensurePush(vapidPublicKey: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || !vapidPublicKey) return;
    if (localStorage.getItem(PUSH_OFF) === '1') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource });
    await api.push.subscribe(sub.toJSON());
  } catch {
    /* next start will try again */
  }
}

export async function disablePush(): Promise<void> {
  try {
    localStorage.setItem(PUSH_OFF, '1');
  } catch {
    /* ignore */
  }
  const sub = await currentSubscription();
  if (!sub) return;
  await api.push.unsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
