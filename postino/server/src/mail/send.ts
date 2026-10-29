import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import type { AccountRow } from '../views.js';
import { manager } from './manager.js';
import { textToHtml } from './sanitize.js';
import type { Address } from './parse.js';

export type OutgoingAttachment = { filename: string; contentType: string; path?: string; content?: Buffer };

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
  const from = formatAddress({ name: msg.account.name, email: msg.account.email });
  const signature = msg.account.signature ? `\n\n-- \n${msg.account.signature}` : '';
  const text = msg.text + (msg.text.includes('-- \n') ? '' : signature);
  const html = msg.html || textToHtml(text);
  const headers: Record<string, string> = {};
  const mail = {
    from,
    to: msg.to,
    cc: msg.cc || undefined,
    bcc: msg.bcc || undefined,
    subject: msg.subject,
    text,
    html,
    headers,
    inReplyTo: msg.inReplyTo ? `<${msg.inReplyTo.messageId}>` : undefined,
    references: msg.inReplyTo ? [...msg.inReplyTo.references, msg.inReplyTo.messageId].map((r) => `<${r}>`).join(' ') : undefined,
    attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, path: a.path, content: a.content })),
    date: new Date(),
  };
  const composer = new MailComposer(mail as never);
  const compiled = composer.compile();
  const raw = await compiled.build();
  const messageId = (compiled.messageId() as string).replace(/^<|>$/g, '');
  const transport = smtpTransport(msg.account);
  try {
    await transport.sendMail({ envelope: { from: msg.account.email, to: [...parseAddressList(msg.to), ...parseAddressList(msg.cc || ''), ...parseAddressList(msg.bcc || '')].map((a) => a.email) }, raw });
  } finally {
    transport.close();
  }
  // Keep a copy in Sent (vhosting's SMTP does not do it for us).
  const sync = manager.get(msg.account.id);
  if (sync) {
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
