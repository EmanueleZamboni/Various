import type { FastifyInstance } from 'fastify';
import sanitizeHtml from 'sanitize-html';
import { db } from '../db.js';
import { htmlToText } from '../mail/sanitize.js';

export type SignatureRow = { id: number; account_id: number; name: string; html: string; text: string; is_default: number; sort_order: number; updated_at: string };

const view = (s: SignatureRow) => ({
  id: String(s.id),
  accountId: String(s.account_id),
  name: s.name,
  html: s.html,
  text: s.text,
  isDefault: Boolean(s.is_default),
  updatedAt: s.updated_at,
});

/** Signature HTML is written by the user, but it is still kept to safe, mail-friendly markup. */
export function cleanSignatureHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'img', 'table', 'tbody', 'tr', 'td', 'ul', 'ol', 'li', 'font', 'small', 'hr'],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      '*': ['style', 'align', 'width', 'height', 'color', 'size', 'face', 'cellpadding', 'cellspacing', 'border'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedStyles: {
      '*': {
        color: [/^.*$/],
        'background-color': [/^.*$/],
        'font-size': [/^.*$/],
        'font-weight': [/^.*$/],
        'font-style': [/^.*$/],
        'font-family': [/^.*$/],
        'text-decoration': [/^.*$/],
        'text-align': [/^.*$/],
        width: [/^.*$/],
        height: [/^.*$/],
        'max-width': [/^.*$/],
        margin: [/^.*$/],
        padding: [/^.*$/],
        'border-radius': [/^.*$/],
        display: [/^.*$/],
        'vertical-align': [/^.*$/],
      },
    },
    transformTags: {
      a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, target: '_blank', rel: 'noopener' } }),
    },
  });
}

export function defaultSignature(accountId: number): SignatureRow | undefined {
  return db.prepare('SELECT * FROM signatures WHERE account_id = ? AND is_default = 1 LIMIT 1').get(accountId) as SignatureRow | undefined;
}

export function signatureById(id: number): SignatureRow | undefined {
  return db.prepare('SELECT * FROM signatures WHERE id = ?').get(id) as SignatureRow | undefined;
}

type In = { accountId?: string; name?: string; html?: string; isDefault?: boolean };

export function registerSignatureRoutes(app: FastifyInstance): void {
  app.get('/api/signatures', async () => {
    const rows = db.prepare('SELECT * FROM signatures ORDER BY account_id, sort_order, id').all() as SignatureRow[];
    return rows.map(view);
  });

  app.post<{ Body: In }>('/api/signatures', async (req, reply) => {
    const b = req.body || {};
    const accountId = Number(b.accountId);
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) return reply.code(400).send({ error: 'no_account', message: 'Pick an account for this signature.' });
    const html = cleanSignatureHtml(String(b.html || ''));
    if (html.length > 400_000) return reply.code(400).send({ error: 'too_big', message: 'Keep the signature under 400 KB; use a smaller image.' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM signatures WHERE account_id = ?').get(accountId) as { n: number }).n;
    const makeDefault = b.isDefault || count === 0;
    const tx = db.transaction(() => {
      if (makeDefault) db.prepare('UPDATE signatures SET is_default = 0 WHERE account_id = ?').run(accountId);
      const info = db.prepare('INSERT INTO signatures(account_id, name, html, text, is_default, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(accountId, String(b.name || 'Signature').slice(0, 60), html, htmlToText(html), makeDefault ? 1 : 0, count);
      return db.prepare('SELECT * FROM signatures WHERE id = ?').get(info.lastInsertRowid) as SignatureRow;
    });
    return reply.code(201).send(view(tx()));
  });

  app.put<{ Params: { id: string }; Body: In }>('/api/signatures/:id', async (req, reply) => {
    const row = signatureById(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const html = b.html !== undefined ? cleanSignatureHtml(String(b.html)) : row.html;
    if (html.length > 400_000) return reply.code(400).send({ error: 'too_big', message: 'Keep the signature under 400 KB; use a smaller image.' });
    const tx = db.transaction(() => {
      if (b.isDefault) db.prepare('UPDATE signatures SET is_default = 0 WHERE account_id = ?').run(row.account_id);
      db.prepare("UPDATE signatures SET name = ?, html = ?, text = ?, is_default = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
        b.name !== undefined ? String(b.name).slice(0, 60) : row.name,
        html,
        htmlToText(html),
        b.isDefault ? 1 : b.isDefault === false ? 0 : row.is_default,
        row.id,
      );
    });
    tx();
    return view(signatureById(row.id) as SignatureRow);
  });

  app.delete<{ Params: { id: string } }>('/api/signatures/:id', async (req, reply) => {
    const row = signatureById(Number(req.params.id));
    if (row) {
      db.prepare('DELETE FROM signatures WHERE id = ?').run(row.id);
      if (row.is_default) db.prepare('UPDATE signatures SET is_default = 1 WHERE id = (SELECT id FROM signatures WHERE account_id = ? ORDER BY sort_order, id LIMIT 1)').run(row.account_id);
    }
    return reply.code(204).send();
  });
}
