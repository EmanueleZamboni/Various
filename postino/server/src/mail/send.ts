import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import type { AccountRow } from '../views.js';
import { manager } from './manager.js';
import { textToHtml } from './sanitize.js';
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

export function smtpTransport(account: AccountRow) {
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: Boolean(account.smtp_secure),
    auth: { user: account.username, pass: decrypt(account.password_enc) },
    tls: { rejectUnauthorized: process.env.POSTINO_TLS_INSECURE !== '1' },
    connectionTimeout: 20_000,
  });
}

/** Build the MIME message, send it over SMTP, and append a copy to the account's Sent folder. */
export async function sendMail(msg: Outgoing): Promise<{ messageId: string; raw: Buffer }> {
  const fromEmail = msg.fromAddress || msg.account.email;
  const from = formatAddress({ name: msg.account.name, email: fromEmail });
  const sig = msg.signature && (msg.signature.html.trim() || msg.signature.text.trim()) ? msg.signature : null;
  const text = [msg.text, sig ? `-- \n${sig.text}` : '', msg.quote ? msg.quote.text : ''].filter((p) => p && p.trim()).join('\n\n');
  const html = msg.html || [
    textToHtml(msg.text),
    sig ? `<div style="margin-top:16px">${sig.html}</div>` : '',
    msg.quote ? `<div style="margin-top:16px">${msg.quote.html || textToHtml(msg.quote.text)}</div>` : '',
  ].filter(Boolean).join('');
  // Inline data: images (signature logos) become cid: attachments; mail clients do not render data URLs.
  const inline: OutgoingAttachment[] = [];
  let n = 0;
  const htmlWithCids = html.replace(/src=(["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\1/gi, (_m, q: string, type: string, b64: string) => {
    const cid = `img${++n}.${Date.now()}@postino`;
    inline.push({ filename: `image${n}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`, contentType: type, content: Buffer.from(b64.replace(/\s+/g, ''), 'base64'), cid });
    return `src=${q}cid:${cid}${q}`;
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
  };
  const composer = new MailComposer(mail as never);
  const compiled = composer.compile();
  const raw = await compiled.build();
  const messageId = (compiled.messageId() as string).replace(/^<|>$/g, '');
  const transport = smtpTransport(msg.account);
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
  const t = smtpTransport(account);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}
