import type { Address } from '../api/types';

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function formatListDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatFullDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dayGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 7 * 86400000) return 'This week';
  if (now.getTime() - d.getTime() < 31 * 86400000) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function displayName(a: Address | undefined | null): string {
  if (!a) return '';
  if (a.name && a.name.trim()) return a.name.trim();
  return a.email;
}

const TITLES = new Set(['avv', 'dott', 'dr', 'ing', 'sig', 'sig.ra', 'prof', 'arch', 'geom', 'rag', 'mr', 'mrs', 'ms', 'miss', 'studio']);

export function firstName(a: Address | undefined | null): string {
  const n = displayName(a);
  if (n.includes('@') && !n.includes(' ')) return n.split('@')[0];
  const tokens = n.split(/[\s(,|·]+/).filter(Boolean);
  const first = tokens.find((t) => !TITLES.has(t.replace(/\.$/, '').toLowerCase()));
  return first ?? tokens[0] ?? n;
}

/** Short, unambiguous label for an account among its siblings: "collab", or "info@stostudio" when the local part repeats. */
export function accountLabel(email: string, all: { email: string }[]): string {
  const [local, domain = ''] = email.split('@');
  const dupes = all.filter((x) => x.email.split('@')[0] === local).length;
  if (dupes <= 1) return local;
  return `${local}@${domain.replace(/\.[^.]+$/, '')}`;
}

export function initials(a: Address | string): string {
  const n = typeof a === 'string' ? a : displayName(a);
  const parts = n.replace(/[^\p{L}\p{N}\s@.]/gu, ' ').trim().split(/[\s.@]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function participantsLabel(list: Address[], me: Set<string>, max = 3): string {
  const names = list.filter((a) => !me.has(a.email.toLowerCase())).map(firstName);
  const pool = names.length ? names : list.map(() => 'Me');
  const uniq = Array.from(new Set(pool));
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')} +${uniq.length - max}`;
}

export function parseAddressList(s: string): Address[] {
  const out: Address[] = [];
  const re = /\s*(?:"?([^"<,]*?)"?\s*<([^>]+)>|([^\s,<>]+@[^\s,<>]+))\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2]) out.push({ name: (m[1] ?? '').trim(), email: m[2].trim() });
    else if (m[3]) out.push({ name: '', email: m[3].trim() });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

export function formatAddress(a: Address): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

export function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
