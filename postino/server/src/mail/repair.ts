import { db, getSetting, setSetting } from '../db.js';
import { htmlToText, sanitizeEmailHtml } from './sanitize.js';
import { looksLikeHtml, makeSnippet, splitQuoted } from './parse.js';
import { recomputeThread } from './store.js';

/**
 * Mail stored before HTML code in the plain-text part was recognised: it showed as code in the
 * app and reached Claude as code. Once: turn each into its words (text, preview, search) and
 * show it as the email it is.
 */
export function fixHtmlInTextOnce(): number {
  if (getSetting<boolean>('migr.htmlInText', false)) return 0;
  const rows = db
    .prepare("SELECT b.message_row AS id, b.text, m.thread_id FROM bodies b JOIN messages m ON m.id = b.message_row WHERE b.text IS NOT NULL AND substr(ltrim(b.text), 1, 1) = '<'")
    .all() as { id: number; text: string; thread_id: number }[];
  let fixed = 0;
  const threads = new Set<number>();
  const upBody = db.prepare('UPDATE bodies SET text = ?, html = ?, quoted = ?, has_remote_images = ? WHERE message_row = ?');
  const upMsg = db.prepare('UPDATE messages SET snippet = ? WHERE id = ?');
  const upFts = db.prepare('UPDATE fts SET body = ? WHERE rowid = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!looksLikeHtml(r.text)) continue;
      const text = htmlToText(r.text);
      const split = splitQuoted(text);
      const s = sanitizeEmailHtml(r.text, new Map());
      upBody.run(text, s.html, split.quoted, s.hasRemoteImages ? 1 : 0, r.id);
      upMsg.run(makeSnippet(split.visible), r.id);
      upFts.run(text.slice(0, 200_000), r.id);
      threads.add(r.thread_id);
      fixed++;
    }
  });
  tx();
  for (const t of threads) recomputeThread(t);
  setSetting('migr.htmlInText', true);
  return fixed;
}
