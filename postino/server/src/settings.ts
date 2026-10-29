import { getSetting, setSetting } from './db.js';

/** Everything the user can tune, with the defaults a new install starts from. */
export type UiSettings = {
  notifications: { enabled: boolean; categories: ('person' | 'notification' | 'newsletter')[]; sound: boolean };
  inbox: {
    smart: boolean;
    groupNotifications: boolean;
    groupNewsletters: boolean;
    previewLines: 0 | 1 | 2;
    showAvatars: boolean;
    showAccountTag: boolean;
    pinnedOnTop: boolean;
  };
  reading: {
    markRead: 'open' | 'delay' | 'manual';
    markReadDelay: number; // seconds, for "delay"
    remoteImages: 'ask' | 'always' | 'contacts';
    afterAction: 'next' | 'previous' | 'list';
    confirmDelete: boolean;
    showQuoted: boolean;
  };
  compose: {
    defaultAccount: string; // "lastUsed" | account id
    replyFromRecipient: boolean; // reply from the address the mail was sent to
    defaultReply: 'reply' | 'replyAll';
    includeQuote: boolean;
    undoSendSec: 0 | 5 | 10 | 20 | 30;
    sendAndArchive: boolean;
    bccMyself: boolean;
    confirmNoSubject: boolean;
  };
  swipe: { left: string; right: string };
  appearance: { density: 'comfortable' | 'compact'; textSize: 'normal' | 'large' };
  // kept for older clients
  smartInbox: boolean;
  signaturePerAccount: boolean;
};

export const defaults: UiSettings = {
  notifications: { enabled: true, categories: ['person'], sound: true },
  inbox: { smart: true, groupNotifications: true, groupNewsletters: true, previewLines: 1, showAvatars: true, showAccountTag: true, pinnedOnTop: true },
  reading: { markRead: 'open', markReadDelay: 2, remoteImages: 'ask', afterAction: 'next', confirmDelete: false, showQuoted: false },
  compose: { defaultAccount: 'lastUsed', replyFromRecipient: true, defaultReply: 'reply', includeQuote: true, undoSendSec: 10, sendAndArchive: false, bccMyself: false, confirmNoSubject: true },
  swipe: { left: 'archive', right: 'pin' },
  appearance: { density: 'comfortable', textSize: 'normal' },
  smartInbox: true,
  signaturePerAccount: true,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Merge a partial update into defaults + stored, only accepting keys that exist in the defaults. */
function merge<T>(base: T, patch: unknown): T {
  if (!isObj(patch) || !isObj(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in (base as Record<string, unknown>))) continue;
    const cur = (base as Record<string, unknown>)[k];
    if (isObj(cur)) out[k] = merge(cur, v);
    else if (Array.isArray(cur)) out[k] = Array.isArray(v) ? v : cur;
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

export function uiSettings(): UiSettings {
  const stored = getSetting<Partial<UiSettings>>('ui2', {});
  const s = merge(defaults, stored);
  // Older single-key settings still win if the new ones were never saved.
  const legacyN = getSetting<{ enabled: boolean; categories: string[] } | null>('notifications', null);
  if (legacyN && !stored.notifications) s.notifications = { ...s.notifications, enabled: legacyN.enabled, categories: legacyN.categories as never };
  s.smartInbox = s.inbox.smart;
  return s;
}

export function updateUiSettings(patch: unknown): UiSettings {
  const current = uiSettings();
  const next = merge(current, patch);
  if (isObj(patch) && typeof patch.smartInbox === 'boolean') next.inbox.smart = patch.smartInbox;
  next.smartInbox = next.inbox.smart;
  setSetting('ui2', next);
  setSetting('notifications', { enabled: next.notifications.enabled, categories: next.notifications.categories });
  return next;
}
