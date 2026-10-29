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

/** Enum and range checks on top of the type-preserving merge. */
function clampSettings(s: UiSettings): UiSettings {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  s.inbox.previewLines = num(s.inbox.previewLines, 0, 2, 1) as 0 | 1 | 2;
  s.reading.markRead = pick(s.reading.markRead, ['open', 'delay', 'manual'] as const, 'open');
  s.reading.markReadDelay = num(s.reading.markReadDelay, 0, 60, 2);
  s.reading.remoteImages = pick(s.reading.remoteImages, ['ask', 'always', 'contacts'] as const, 'ask');
  s.reading.afterAction = pick(s.reading.afterAction, ['next', 'previous', 'list'] as const, 'next');
  s.compose.undoSendSec = ([0, 5, 10, 20, 30] as const).find((n) => n === s.compose.undoSendSec) ?? 10;
  s.compose.defaultReply = pick(s.compose.defaultReply, ['reply', 'replyAll'] as const, 'reply');
  s.notifications.categories = s.notifications.categories.filter((c) => ['person', 'notification', 'newsletter'].includes(c));
  s.appearance.density = pick(s.appearance.density, ['comfortable', 'compact'] as const, 'comfortable');
  s.appearance.textSize = pick(s.appearance.textSize, ['normal', 'large'] as const, 'normal');
  return s;
}

export function uiSettings(): UiSettings {
  const stored = getSetting<Partial<UiSettings>>('ui2', {});
  const s = clampSettings(merge(defaults, stored));
  // Older single-key settings still win if the new ones were never saved.
  const legacyN = getSetting<{ enabled: boolean; categories: string[] } | null>('notifications', null);
  if (legacyN && !stored.notifications) s.notifications = { ...s.notifications, enabled: legacyN.enabled, categories: legacyN.categories as never };
  s.smartInbox = s.inbox.smart;
  return s;
}

export function updateUiSettings(patch: unknown): UiSettings {
  const current = uiSettings();
  const next = clampSettings(merge(current, patch));
  if (isObj(patch) && typeof patch.smartInbox === 'boolean') next.inbox.smart = patch.smartInbox;
  next.smartInbox = next.inbox.smart;
  setSetting('ui2', next);
  setSetting('notifications', { enabled: next.notifications.enabled, categories: next.notifications.categories });
  return next;
}
