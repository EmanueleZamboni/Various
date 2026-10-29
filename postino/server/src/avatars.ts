import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Sender pictures: Gravatar first, then the sender's company logo (BIMI record
 * or the site's icon). Everything is fetched by the server and cached on disk,
 * so the browser never talks to Gravatar or the sender's site.
 */

const dir = path.join(config.dataDir, 'avatars');
fs.mkdirSync(dir, { recursive: true });

const POSITIVE_TTL = 14 * 86400_000;
const NEGATIVE_TTL = 3 * 86400_000;
const MAX_BYTES = 1_000_000;
const TIMEOUT = 6000;

// Domains where everybody has an address: a site icon would be wrong for the person.
const freemail = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|protonmail|proton|pm|gmx|libero|virgilio|tiscali|alice|tin|fastwebnet|email|mail|yandex|zoho|qq|163|126|wp|o2|web|t-online|orange|free|laposte|hey|duck|tutanota|tuta|posteo|inwind|iol|aruba|pec)\.(com|it|net|org|me|de|fr|pl|ru|cn|co\.uk|eu|ch)$/i;

export type AvatarResult = { file: string; contentType: string } | null;

type Meta = { contentType: string; found: boolean; at: number; source?: string };

const inflight = new Map<string, Promise<AvatarResult>>();

function key(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex');
}

function readMeta(k: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, k + '.json'), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

function writeMeta(k: string, m: Meta): void {
  fs.writeFileSync(path.join(dir, k + '.json'), JSON.stringify(m));
}

/** True for addresses that must never be fetched from a server (SSRF): loopback, LAN, link-local, cloud metadata. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) || // link-local and cloud metadata (169.254.169.254)
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}

/** Resolve a host and refuse it when any address is private. */
async function assertPublicHost(hostname: string): Promise<void> {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) {
    if (isPrivateAddress(h)) throw new Error('private address');
    return;
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('private host');
  const addrs = await dns.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private address');
}

/** fetch() that only talks to public https hosts, checking every redirect hop. */
async function safeFetch(url: string, init: RequestInit & { signal: AbortSignal }, hops = 0): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('https only');
  await assertPublicHost(u.hostname);
  const res = await fetch(u, { ...init, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (!loc || hops >= 3) throw new Error('too many redirects');
    return safeFetch(new URL(loc, u).toString(), init, hops + 1);
  }
  return res;
}

async function fetchImage(url: string, accept = 'image/*'): Promise<{ bytes: Buffer; contentType: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await safeFetch(url, { signal: ctrl.signal, headers: { accept, 'user-agent': 'Postino/0.1 (+avatar fetch)' } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    return { bytes, contentType: type };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fromGravatar(email: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return fetchImage(`https://gravatar.com/avatar/${hash}?s=160&d=404&r=g`);
}

/** BIMI (RFC draft used by Gmail/Apple Mail): default._bimi.<domain> TXT "v=BIMI1; l=<svg url>". */
async function fromBimi(domain: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const records = await dns.resolveTxt(`default._bimi.${domain}`);
    const txt = records.map((r) => r.join('')).find((r) => /^v=BIMI1/i.test(r));
    const m = txt?.match(/\bl=([^;\s]+)/i);
    if (!m || !/^https:\/\//i.test(m[1])) return null;
    const img = await fetchImage(m[1], 'image/svg+xml');
    return img && img.contentType === 'image/svg+xml' ? img : null;
  } catch {
    return null;
  }
}

/** The site's apple-touch-icon / icon from its homepage, or the usual default paths. */
async function fromSiteIcon(domain: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const bases = [`https://${domain}`, `https://www.${domain}`];
  for (const base of bases) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    let html = '';
    let finalBase = base;
    try {
      const res = await safeFetch(base, { signal: ctrl.signal, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Postino/0.1)' } });
      if (!res.ok) continue;
      finalBase = res.url || base;
      const reader = res.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          total += value.length;
          if (total > 300_000) break;
        }
        await reader.cancel().catch(() => undefined);
        html = Buffer.concat(chunks).toString('utf8');
      }
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }
    const candidates: { url: string; size: number }[] = [];
    for (const m of html.matchAll(/<link\s[^>]*>/gi)) {
      const tag = m[0];
      const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '').toLowerCase();
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      if (!/(^|\s)(apple-touch-icon(-precomposed)?|icon|shortcut icon)(\s|$)/.test(rel)) continue;
      const sizes = tag.match(/\bsizes\s*=\s*["'](\d+)x\d+["']/i)?.[1];
      let size = sizes ? Number(sizes) : rel.includes('apple-touch') ? 180 : 32;
      if (/\.svg(\?|$)/i.test(href)) size = 512;
      try {
        candidates.push({ url: new URL(href.replace(/&amp;/g, '&'), finalBase).toString(), size });
      } catch {
        // bad href
      }
    }
    candidates.sort((a, b) => b.size - a.size);
    for (const c of candidates.slice(0, 3)) {
      const img = await fetchImage(c.url);
      if (img && (c.size >= 48 || img.bytes.length > 1500)) return img;
    }
    for (const p of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
      const img = await fetchImage(new URL(p, finalBase).toString());
      if (img) return img;
    }
  }
  return null;
}

async function lookup(email: string): Promise<AvatarResult> {
  const k = key(email);
  const file = path.join(dir, k);
  const domain = email.split('@')[1] || '';
  const tries: { name: string; run: () => Promise<{ bytes: Buffer; contentType: string } | null> }[] = [{ name: 'gravatar', run: () => fromGravatar(email) }];
  if (domain && !freemail.test(domain) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    tries.push({ name: 'bimi', run: () => fromBimi(domain) });
    tries.push({ name: 'site', run: () => fromSiteIcon(domain) });
  }
  for (const t of tries) {
    const img = await t.run();
    if (img) {
      fs.writeFileSync(file, img.bytes);
      writeMeta(k, { contentType: img.contentType, found: true, at: Date.now(), source: t.name });
      log.debug({ email, source: t.name }, 'avatar found');
      return { file, contentType: img.contentType };
    }
  }
  writeMeta(k, { contentType: '', found: false, at: Date.now() });
  return null;
}

// Lookups run in the background, a few at a time, so a page of 50 senders never
// turns into 150 slow outbound requests holding up the list.
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;
const MAX_PARALLEL = 3;

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const email = queue.shift() as string;
    running++;
    const k = key(email);
    const p = lookup(email)
      .catch((err) => {
        log.debug({ email, err: (err as Error).message }, 'avatar lookup failed');
        writeMeta(k, { contentType: '', found: false, at: Date.now() });
        return null;
      })
      .finally(() => {
        running--;
        queued.delete(email);
        inflight.delete(k);
        pump();
      });
    inflight.set(k, p);
  }
}

/**
 * Cached avatar for an address. A cold cache answers "none" at once and queues
 * the lookup; the picture appears on the next load (the client retries once).
 */
export async function getAvatar(rawEmail: string): Promise<AvatarResult | 'pending'> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const k = key(email);
  const meta = readMeta(k);
  const file = path.join(dir, k);
  if (meta) {
    const fresh = Date.now() - meta.at < (meta.found ? POSITIVE_TTL : NEGATIVE_TTL);
    if (fresh) return meta.found && fs.existsSync(file) ? { file, contentType: meta.contentType } : null;
  }
  if (!queued.has(email)) {
    queued.add(email);
    queue.push(email);
    pump();
  }
  return 'pending';
}

/** Shared-domain logo lookups can be reused across senders of the same company. */
export function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() || '';
}
