import { gmailAccessToken } from '../google.js';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import type { AccountRow } from '../views.js';
import { manager } from './manager.js';
// (plain-text bodies are converted with textToMailHtml below)

const escHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * The typed text as email-safe HTML: real paragraphs and <br> line breaks.
 * (white-space: pre-wrap is ignored by Outlook on Windows, which would run the
 * whole email together on one line.)
 */
export function textToMailHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((para) => {
      const body = escHtml(para)
        .replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g, (m) => `<a href="${m}">${m}</a>`)
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 1em 0">${body || '&nbsp;'}</p>`;
    })
    .join('');
}

/** One font and size for every client (Gmail, Outlook and Apple Mail otherwise each pick their own). */
const wrapMail = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${inner}</div>`;

/** Pixel width of a PNG, GIF or JPEG, so Outlook (which ignores CSS max-width) shows it at the right size. */
export function imageWidth(buf: Buffer): number | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return buf.readUInt16LE(6);
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buf.readUInt16BE(i + 7);
      i += 2 + len;
    }
  }
  return null;
}
import type { Address } from './parse.js';

export type OutgoingAttachment = { filename: string; contentType: string; path?: string; content?: Buffer; cid?: string };

export type Outgoing = {
  account: AccountRow;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: { messageId: string; references: string[] } | null;
  attachments: OutgoingAttachment[];
  /** Rich signature placed after the message and before any quoted mail. */
  signature?: { html: string; text: string } | null;
  /** The quoted original for replies and forwards, built by the server. */
  onDelivered?: () => void;
  quote?: { html: string | null; text: string; inline?: OutgoingAttachment[] } | null;
  /** Send as one of the account's aliases instead of its main address. */
  fromAddress?: string;
  /** An iCalendar part (e.g. an invitation reply) sent as text/calendar alongside the text. */
  icalEvent?: { method: string; content: string };
};

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const safe = a.name.replace(/"/g, '');
  return /[,<>@"]/.test(safe) ? `"${safe}" <${a.email}>` : `${safe} <${a.email}>`;
}

export function parseAddressList(s: string): Address[] {
  const out: Address[] = [];
  if (!s) return out;
  // Split on commas/semicolons that are not inside quotes.
  const parts = s.match(/(?:[^,;"]|"[^"]*")+/g) || [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/);
    if (m) out.push({ name: (m[1] || '').trim(), email: m[2].toLowerCase() });
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) out.push({ name: '', email: p.toLowerCase() });
  }
  return out;
}

export async function smtpTransport(account: AccountRow) {
  const auth = account.auth_type === 'google'
    ? { type: 'OAuth2' as const, user: account.username, accessToken: await gmailAccessToken(account) }
    : { user: account.username, pass: decrypt(account.password_enc) };
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: Boolean(account.smtp_secure),
    auth,
    tls: { rejectUnauthorized: process.env.POSTINO_TLS_INSECURE !== '1' },
    connectionTimeout: 20_000,
    // Plain ports (587/25) must upgrade to TLS before the login is sent.
    requireTLS: !account.smtp_secure && process.env.POSTINO_TLS_INSECURE !== '1',
  });
}

/** Build the MIME message, send it over SMTP, and append a copy to the account's Sent folder. */
export async function sendMail(msg: Outgoing): Promise<{ messageId: string; raw: Buffer }> {
  const fromEmail = msg.fromAddress || msg.account.email;
  const from = formatAddress({ name: msg.account.name, email: fromEmail });
  const sig = msg.signature && (msg.signature.html.trim() || msg.signature.text.trim()) ? msg.signature : null;
  const text = [msg.text, sig ? `-- \n${sig.text}` : '', msg.quote ? msg.quote.text : ''].filter((p) => p && p.trim()).join('\n\n');
  const html = msg.html || wrapMail([
    textToMailHtml(msg.text),
    sig ? `<div style="margin-top:16px">${sig.html}</div>` : '',
    msg.quote ? `<div style="margin-top:16px">${msg.quote.html || textToMailHtml(msg.quote.text)}</div>` : '',
  ].filter(Boolean).join(''));
  // Inline data: images (signature logos) become cid: attachments; mail clients do not render data URLs.
  const inline: OutgoingAttachment[] = [];
  let n = 0;
  const htmlWithCids = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /src=(["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\1/i.exec(tag);
    if (!m) return tag;
    const [, q, type, b64] = m;
    const content = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    const cid = `img${++n}.${Date.now()}@postino`;
    inline.push({ filename: `image${n}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`, contentType: type, content, cid });
    let out = tag.replace(m[0], `src=${q}cid:${cid}${q}`);
    // Outlook ignores CSS sizes: give the image an explicit width (its CSS max-width, else its own, at most 600).
    if (!/\swidth=/i.test(out)) {
      const cssMax = /max-width:\s*(\d+)px/i.exec(out)?.[1];
      const natural = imageWidth(content);
      const w = Math.min(...[cssMax ? Number(cssMax) : Infinity, natural ?? Infinity, 600]);
      if (Number.isFinite(w)) out = out.replace(/^<img/i, `<img width="${Math.round(w)}"`);
    }
    return out;
  });
  const headers: Record<string, string> = {};
  const mail = {
    from,
    to: msg.to,
    cc: msg.cc || undefined,
    bcc: msg.bcc || undefined,
    subject: msg.subject,
    text,
    html: htmlWithCids,
    headers,
    inReplyTo: msg.inReplyTo ? `<${msg.inReplyTo.messageId}>` : undefined,
    references: msg.inReplyTo ? [...msg.inReplyTo.references, msg.inReplyTo.messageId].map((r) => `<${r}>`).join(' ') : undefined,
    attachments: [...msg.attachments, ...(msg.quote?.inline ?? []), ...inline].map((a) => ({ filename: a.filename, contentType: a.contentType, path: a.path, content: a.content, cid: a.cid })),
    date: new Date(),
    icalEvent: msg.icalEvent ? { method: msg.icalEvent.method, content: msg.icalEvent.content, filename: 'invite.ics' } : undefined,
  };
  const composer = new MailComposer(mail as never);
  const compiled = composer.compile();
  const raw = await compiled.build();
  const messageId = (compiled.messageId() as string).replace(/^<|>$/g, '');
  const transport = await smtpTransport(msg.account);
  try {
    await transport.sendMail({ envelope: { from: fromEmail, to: [...parseAddressList(msg.to), ...parseAddressList(msg.cc || ''), ...parseAddressList(msg.bcc || '')].map((a) => a.email) }, raw });
    msg.onDelivered?.();
  } finally {
    transport.close();
  }
  // Keep a copy in Sent (vhosting's SMTP does not do it for us). Gmail stores sent mail by itself.
  const sync = manager.get(msg.account.id);
  const providerSavesSent = /gmail\.com$|googlemail\.com$|google\.com$/i.test(msg.account.smtp_host);
  if (sync && !providerSavesSent) {
    try {
      await sync.appendMessage('sent', raw, ['\\Seen']);
    } catch (err) {
      db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(`Sent, but saving to Sent failed: ${(err as Error).message}`, msg.account.id);
    }
  }
  return { messageId, raw };
}

export async function verifySmtp(account: AccountRow): Promise<void> {
  const t = await smtpTransport(account);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}
