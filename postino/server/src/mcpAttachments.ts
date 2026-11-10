import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { randomToken } from './crypto.js';
import { safeFetch } from './avatars.js';
import { manager } from './mail/manager.js';
import { attachmentPath } from './mail/store.js';

/**
 * Attachments for emails written through the connector. Each one is either the file itself
 * (base64), an attachment of an email already in Postino (attachment_id from read_thread), or a
 * public link (a Google Drive "anyone with the link" file works too). They are stored like files
 * uploaded in the app, so drafts keep them and sending works the same way.
 */

export type ConnectorAttachment = { filename?: string; content_base64?: string; content_type?: string; attachment_id?: string; url?: string };
export type Staged = { id: string; filename: string; size: number };

export const MAX_FILES = 10;
export const MAX_TOTAL = 25 * 1024 * 1024;

export const attachmentsSchema = {
  type: 'array',
  maxItems: MAX_FILES,
  description:
    'Files to attach (25 MB in all). Each item is ONE of: {attachment_id} from read_thread to reuse a file of an email already in Postino; {url} of a public file (a Google Drive file shared with "anyone with the link" works); {filename, content_base64, content_type?} for a file you have the bytes of.',
  items: {
    type: 'object',
    properties: {
      attachment_id: { type: 'string' },
      url: { type: 'string' },
      filename: { type: 'string', description: 'Name shown to the recipient. Required with content_base64; optional otherwise.' },
      content_base64: { type: 'string' },
      content_type: { type: 'string', description: 'e.g. application/pdf. Guessed from the name when missing.' },
    },
    additionalProperties: false,
  },
} as const;

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const typeFor = (name: string) => TYPES[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([e, t]) => [t, e]));

function cleanName(name: string): string {
  const n = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f"<>|]/g, '').trim();
  return n.slice(0, 200) || 'attachment';
}

/** Turn a Drive or Docs sharing link into a link that downloads the file. */
export function downloadUrl(raw: string): string {
  const u = new URL(raw);
  if (u.hostname === 'drive.google.com') {
    const id = u.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || u.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (u.hostname === 'docs.google.com') {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
    if (m) return `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=${m[1] === 'spreadsheets' ? 'xlsx' : m[1] === 'presentation' ? 'pptx' : 'pdf'}`;
  }
  if (u.hostname.endsWith('dropbox.com')) {
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return raw;
}

async function fromUrl(raw: string, left: number): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  let url: string;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    url = downloadUrl(u.toString());
  } catch {
    throw new Error(`Not a web link: ${raw.slice(0, 100)}`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await safeFetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Postino)' } });
    if (!res.ok) throw new Error(`The link answered ${res.status}: is it shared publicly?`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    if (contentType === 'text/html') throw new Error('The link opens a web page, not a file. For Google Drive, share the file with "anyone with the link".');
    if (Number(res.headers.get('content-length') || 0) > left) throw new Error('The file is too big (25 MB in all).');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > left) throw new Error('The file is too big (25 MB in all).');
    const cd = res.headers.get('content-disposition') || '';
    const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
    let filename = star ? decodeURIComponent(star.replace(/"/g, '')) : cd.match(/filename="?([^";]+)"?/i)?.[1] || '';
    if (!filename) filename = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || '');
    if (!/\.\w{2,5}$/.test(filename) && EXT[contentType]) filename = `${filename || 'file'}.${EXT[contentType]}`;
    return { bytes, filename: filename || 'file', contentType };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('The link took too long to download.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fromEmail(id: string): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  const a = db
    .prepare('SELECT a.id, a.filename, a.content_type, m.account_id FROM attachments a JOIN messages m ON m.id = a.message_row WHERE a.id = ?')
    .get(Number(id)) as { id: number; filename: string; content_type: string; account_id: number } | undefined;
  if (!a) throw new Error(`No attachment with id ${id}. Take the ids from read_thread.`);
  const sync = manager.get(a.account_id);
  const file = sync ? await sync.cacheAttachment(a.id) : attachmentPath(a.id);
  return { bytes: await fs.promises.readFile(file), filename: a.filename, contentType: a.content_type || typeFor(a.filename) };
}

/** Store the files as uploads; returns them in the drafts' attachments_json shape. */
export async function stageAttachments(list: unknown): Promise<Staged[]> {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('attachments must be a list.');
  if (list.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments.`);
  const out: Staged[] = [];
  let total = 0;
  try {
    for (const raw of list as ConnectorAttachment[]) {
      const given = [raw?.attachment_id, raw?.url, raw?.content_base64].filter((x) => x !== undefined && x !== '').length;
      if (given !== 1) throw new Error('Each attachment needs exactly one of attachment_id, url or content_base64.');
      let file: { bytes: Buffer; filename: string; contentType: string };
      if (raw.attachment_id) file = await fromEmail(String(raw.attachment_id));
      else if (raw.url) file = await fromUrl(String(raw.url), MAX_TOTAL - total);
      else {
        if (!raw.filename) throw new Error('An attachment sent as content_base64 needs a filename.');
        const b64 = String(raw.content_base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new Error(`${raw.filename}: content_base64 is not valid base64.`);
        file = { bytes: Buffer.from(b64, 'base64'), filename: raw.filename, contentType: '' };
        if (!file.bytes.length) throw new Error(`${raw.filename} is empty.`);
      }
      const filename = cleanName(raw.filename || file.filename);
      const contentType = String(raw.content_type || '').trim().toLowerCase() || file.contentType || typeFor(filename);
      total += file.bytes.length;
      if (total > MAX_TOTAL) throw new Error('The attachments are too big (25 MB in all).');
      const id = randomToken(12);
      fs.mkdirSync(config.uploadsDir, { recursive: true });
      await fs.promises.writeFile(path.join(config.uploadsDir, id), file.bytes);
      await fs.promises.writeFile(path.join(config.uploadsDir, id + '.json'), JSON.stringify({ id, filename, size: file.bytes.length, contentType }));
      out.push({ id, filename, size: file.bytes.length });
    }
  } catch (e) {
    for (const s of out) for (const f of [s.id, s.id + '.json']) fs.promises.unlink(path.join(config.uploadsDir, f)).catch(() => undefined);
    throw e;
  }
  return out;
}
