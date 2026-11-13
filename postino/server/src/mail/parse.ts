import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import EmailReplyParser from 'email-reply-parser';
import { sanitizeEmailHtml, htmlToText, textToHtml } from './sanitize.js';
import { parseIcs } from './ics.js';

export type Address = { name: string; email: string };
export type Category = 'person' | 'notification' | 'newsletter';

export type ParsedHeaders = {
  messageId: string;
  inReplyTo: string;
  references: string[];
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: Date | null;
  listUnsubscribe: string | null;
  isBulk: boolean; // List-Id / Precedence: bulk / Auto-Submitted / Feedback-ID
  autoSubmitted: boolean;
};

export type ParsedBody = {
  calendar?: import('./ics.js').CalendarEvent | null;
  text: string | null;
  html: string | null; // sanitized
  quoted: string | null;
  hasRemoteImages: boolean;
  snippet: string;
  attachments: {
    filename: string;
    contentType: string;
    size: number;
    contentId: string | null;
    inline: boolean;
    content: Buffer;
  }[];
};

export function normalizeSubject(subject: string): string {
  // Collapse whitespace first: it keeps the prefix regex linear on a hostile subject.
  let s = (subject || '').replace(/\s+/g, ' ').trim().slice(0, 998);
  // Strip reply/forward prefixes in several languages, repeatedly.
  const prefix = /^((re|r|aw|wg|fw|fwd|tr|rif|i|vs|sv|ref|res)\s*(\[\d+\])?\s*:\s*|\[[^\]]{1,40}\]\s*)+/i;
  s = s.replace(prefix, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function hasReplyPrefix(subject: string): boolean {
  return /^(re|r|aw|wg|fw|fwd|tr|rif|i|vs|sv|ref|res) ?(\[\d+\])? ?:/i.test((subject || '').replace(/\s+/g, ' ').trim().slice(0, 998));
}

export function normalizeMsgId(id: string | undefined | null): string {
  if (!id) return '';
  return id.trim().replace(/^<|>$/g, '').trim();
}

export function parseReferences(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const m of raw.matchAll(/<([^<>\s]+)>/g)) out.push(m[1]);
  if (!out.length) for (const part of raw.split(/\s+/)) if (part) out.push(normalizeMsgId(part));
  return out.filter(Boolean);
}

function addr(a?: AddressObject | AddressObject[]): Address[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  const out: Address[] = [];
  for (const obj of list) {
    for (const v of obj.value || []) {
      if (v.group) {
        for (const g of v.group) if (g.address) out.push({ name: g.name || '', email: g.address.toLowerCase() });
      } else if (v.address) {
        out.push({ name: v.name || '', email: v.address.toLowerCase() });
      }
    }
  }
  return out;
}

const bulkSenderRe = /^(no-?reply|noreply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounce|newsletter|news|info@.*\.(shopify|mailchimp)|support|hello|updates?|team|digest|billing|receipts?|orders?|invoice|account|security|system|automated?|robot|bot)([-+_.].*)?@/i;
const notificationDomains = /(google\.com|googlemail\.com|dropbox\.com|wetransfer\.com|notion\.so|slack\.com|github\.com|gitlab\.com|atlassian\.net|trello\.com|asana\.com|linkedin\.com|facebookmail\.com|instagram\.com|tiktok\.com|youtube\.com|paypal\.(com|it)|stripe\.com|amazon\.(com|it)|shopify\.com|apple\.com|icloud\.com|microsoft\.com|zoom\.us|calendly\.com|canva\.com|figma\.com|adobe\.com|vimeo\.com|spotify\.com|netflix\.com|booking\.com|airbnb\.com|uber\.com|ryanair\.com|trenitalia\.it|italo\.it|poste\.it|intesasanpaolo\.com|unicredit\.it|fineco\.it|satispay\.com|nexi\.it|aruba\.it|register\.it|vhosting-it\.com|vhostingcloud\.com)$/i;

/**
 * Smart-inbox category. Newsletters are bulk mail with an unsubscribe option;
 * notifications are automated mail (receipts, shares, alerts); everything else
 * is a person.
 */
export function categorize(h: ParsedHeaders, override?: Category | null): Category {
  if (override) return override;
  const email = h.from.email || '';
  const domain = email.split('@')[1] || '';
  if (h.listUnsubscribe && h.isBulk) return 'newsletter';
  if (h.listUnsubscribe) return 'newsletter';
  if (h.autoSubmitted) return 'notification';
  if (bulkSenderRe.test(email)) return 'notification';
  if (notificationDomains.test(domain)) return 'notification';
  if (h.isBulk) return 'newsletter';
  return 'person';
}

/** Keep cid: links in the HTML so we can rewrite them to our attachment URLs. */
export const parserOptions = { skipImageLinks: true, keepCidLinks: true } as const;

/** Parse a raw RFC822 message fully (headers + body + attachments). */
export async function parseRaw(source: Buffer): Promise<{ headers: ParsedHeaders; mail: ParsedMail }> {
  const mail = await simpleParser(source, parserOptions);
  return { headers: headersFromParsed(mail), mail };
}

export function headersFromParsed(mail: ParsedMail): ParsedHeaders {
  const get = (k: string): string => {
    const v = mail.headers.get(k.toLowerCase());
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(' ');
    if (typeof v === 'object' && v && 'text' in v) return String((v as { text: string }).text);
    return String(v);
  };
  const from = addr(mail.from)[0] || { name: '', email: '' };
  const listUnsub = get('list-unsubscribe');
  return {
    messageId: normalizeMsgId(mail.messageId),
    inReplyTo: normalizeMsgId(mail.inReplyTo),
    references: parseReferences(typeof mail.references === 'string' ? mail.references : (mail.references || []).join(' ')),
    subject: mail.subject || '',
    from,
    to: addr(mail.to),
    cc: addr(mail.cc),
    bcc: addr(mail.bcc),
    replyTo: addr(mail.replyTo),
    date: mail.date || null,
    listUnsubscribe: pickUnsubscribe(listUnsub),
    isBulk: Boolean(get('list-id') || /bulk|list|junk/i.test(get('precedence')) || get('feedback-id') || get('x-mailgun-sid') || get('x-campaign') || get('x-mailchimp-id') || get('x-sg-eid')),
    autoSubmitted: /^auto-/i.test(get('auto-submitted')) || Boolean(get('x-auto-response-suppress')),
  };
}

/** Prefer https links over mailto: in List-Unsubscribe. */
export function pickUnsubscribe(raw: string): string | null {
  if (!raw) return null;
  const urls = [...raw.matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim());
  const https = urls.find((u) => /^https?:/i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  return https || mailto || null;
}

/**
 * Preview text the way Gmail shows it: words only. Link addresses ("Orders ( https://… )",
 * "<https://…>", bare URLs), [image: …] labels and the invisible padding newsletters put after
 * their preheader are left out.
 */
export function cleanSnippet(text: string): string {
  return stripCss(repairEmbeddedMime(text))
    .replace(/[\u00ad\u200b-\u200d\u2060-\u2064\ufeff]/g, '')
    .replace(/[\u034f\u200e\u200f\u2007\u2800]/g, ' ')
    .replace(/\[(?:image|cid):[^\]]*\]/gi, ' ')
    .replace(/\s*[(<\[]\s*(?:https?:\/\/|mailto:|tel:|www\.)[^\s)>\]]*\s*[)>\]]/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()\[\]]+/gi, ' ')
    .replace(/(?:\s[|·•]\s*){2,}/g, ' ')
    .replace(/\(\s*\)|<\s*>|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeSnippet(text: string, max = 200): string {
  const s = cleanSnippet(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Split the fresh reply from the quoted previous messages in plain text. */
export function splitQuoted(text: string): { visible: string; quoted: string | null } {
  try {
    const parser = new EmailReplyParser();
    const email = parser.read(text);
    const visible = email.getVisibleText().trim();
    if (visible && visible.length < text.trim().length - 20) {
      const quoted = text.trim().slice(visible.length).trim();
      return { visible, quoted: quoted || null };
    }
  } catch {
    // fall through
  }
  return { visible: text, quoted: null };
}

export function bodyFromParsed(mail: ParsedMail, cidUrl: (contentId: string) => string | undefined): ParsedBody {
  const attachments = (mail.attachments || []).map((a) => ({
    filename: a.filename || defaultFilename(a.contentType),
    contentType: a.contentType || 'application/octet-stream',
    size: a.size || a.content?.length || 0,
    contentId: a.contentId ? normalizeMsgId(a.contentId) : null,
    inline: a.contentDisposition === 'inline' && Boolean(a.contentId),
    content: a.content as Buffer,
  }));
  const cidMap = new Map<string, string>();
  for (const a of attachments) {
    if (!a.contentId) continue;
    const url = cidUrl(a.contentId);
    if (url) {
      cidMap.set(a.contentId, url);
      cidMap.set(a.contentId.toLowerCase(), url);
    }
  }
  let rawHtml = typeof mail.html === 'string' ? mail.html : null;
  let text = mail.text ? mail.text.replace(/\r\n/g, '\n') : null;
  // Some senders (airline itineraries, for one) put the page's HTML code in the "plain text"
  // part: read it as HTML, and take the words out of it.
  if (text && looksLikeHtml(text)) {
    if (!rawHtml) rawHtml = text;
    text = null;
  }
  if (!text && rawHtml) text = htmlToText(rawHtml);
  const split = text ? splitQuoted(text) : { visible: '', quoted: null };
  let html: string | null = null;
  let hasRemoteImages = false;
  if (rawHtml) {
    const r = sanitizeEmailHtml(rawHtml, cidMap);
    html = r.html;
    hasRemoteImages = r.hasRemoteImages;
  } else if (text) {
    // Plain-text mail: show only the fresh part; the quoted part is available separately.
    html = textToHtml(split.quoted ? split.visible : text);
  }
  const quoted = split.quoted;
  const snippet = makeSnippet(split.visible);
  // Invitations: a text/calendar part (attached or inline) becomes an event card.
  let calendar: import('./ics.js').CalendarEvent | null = null;
  const ics = attachments.find((a) => /text\/calendar|application\/ics/i.test(a.contentType) || /\.ics$/i.test(a.filename));
  if (ics && ics.content?.length) {
    try {
      calendar = parseIcs(ics.content.toString('utf8'));
    } catch {
      calendar = null;
    }
  }
  return { text, html, quoted, hasRemoteImages, snippet, attachments, calendar };
}

/** Bytes written as quoted-printable (=E2=80=99 …) back to text. */
export function decodeQuotedPrintable(s: string): string {
  const flat = s.replace(/=\r?\n/g, '').replace(/= (?=[0-9A-F]{2})/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === '=' && /^[0-9A-F]{2}$/i.test(flat.slice(i + 1, i + 3))) {
      bytes.push(parseInt(flat.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const MIME_HEADER = /(?:Content-(?:Type|Transfer-Encoding|Disposition|ID)|MIME-Version):[ \t]*[\w./+<>@-]+(?:;\s*[\w-]+=(?:"[^"]*"|[^\s;]+))*/gi;

/**
 * A badly built email can carry one of its parts raw inside the text: MIME headers
 * ("Content-Transfer-Encoding: quoted-printable") followed by encoded bytes. Drop the headers and
 * decode what follows, so previews and Claude get words.
 */
export function repairEmbeddedMime(text: string): string {
  if (!/(?:Content-Transfer-Encoding|Content-Type):/i.test(text)) return text;
  const qp = /Content-Transfer-Encoding:\s*quoted-printable/i.test(text);
  let out = text.replace(MIME_HEADER, ' ').replace(/^--[\w'()+_,./:=?-]{8,}(?:--)?\s*$/gm, ' ');
  if (qp && (out.match(/=[0-9A-F]{2}/gi) || []).length >= 3) out = decodeQuotedPrintable(out).replace(/\uFFFD+|=(?=\s|$)/g, '');
  return out;
}

/** Style rules that leaked into a plain-text part ("body { font-family: Arial; … }"). */
const CSS_TAGS = 'html|body|p|a|div|span|table|tbody|thead|tr|td|th|img|h[1-6]|ul|ol|li|strong|b|em|i|u|center|font|blockquote|pre|code|hr|br|\\*';
const CSS_TOKEN = `(?:(?:${CSS_TAGS})|[.#][A-Za-z_][\\w-]*)(?:\\[[^\\]]*\\])?(?:::?[\\w-]+(?:\\([^)]*\\))?)?`;
const CSS_RULE = new RegExp(`(?<![\\w.#-])${CSS_TOKEN}(?:\\s*[,>+~]?\\s*${CSS_TOKEN}){0,5}\\s*\\{\\s*[\\w-]+\\s*:[^{}]*\\}`, 'g');
// A rule cut off by the end of a short preview.
const CSS_CUT = new RegExp(`(?<![\\w.#-])${CSS_TOKEN}(?:\\s*[,>+~]?\\s*${CSS_TOKEN}){0,5}\\s*\\{\\s*[\\w-]+\\s*:[^{}]*$`);


/** Style rules that leaked into a plain-text part ("body { font-family: Arial; … }"). */
export function stripCss(text: string): string {
  if (!text.includes('{')) return text;
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(CSS_RULE, ' ').replace(CSS_CUT, ' ').replace(/@media[^{}]{0,200}\{\s*\}/gi, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** HTML code where plain text was expected (a whole page, or text full of tags). */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2000).trimStart();
  if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<!--\[if|<table[\s>]|<div[\s>])/i.test(head)) return true;
  const tags = text.slice(0, 50_000).match(/<\/?(table|tbody|tr|td|div|span|p|br|img|a|style|center|font)\b[^>]*>/gi);
  return !!tags && tags.length >= 15 && tags.join('').length > text.slice(0, 50_000).length * 0.2;
}

export function defaultFilename(contentType?: string): string {
  const ext = (contentType || '').split('/')[1]?.split(';')[0] || 'bin';
  return `attachment.${ext}`;
}
