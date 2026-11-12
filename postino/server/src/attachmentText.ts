import { htmlToText } from './mail/sanitize.js';

/** Plain text of a PDF (text layer only: a scan has none). */
export async function pdfText(bytes: Buffer, maxChars = 60_000): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    let text = '';
    for (let i = 1; i <= doc.numPages && text.length < maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        line += item.str ?? '';
        if (item.hasEOL) line += '\n';
        else if (item.str) line += ' ';
      }
      text += (doc.numPages > 1 ? `\n--- page ${i} ---\n` : '') + line.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim() + '\n';
      page.cleanup();
    }
    return { text: text.trim().slice(0, maxChars), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

const TEXTISH = /^(text\/|application\/(json|xml|csv|x-csv|javascript|ics)|message\/rfc822)/i;

export type AttachmentReading =
  | { kind: 'text'; text: string; pages?: number; truncated: boolean }
  | { kind: 'image'; data: string; mimeType: string }
  | { kind: 'unreadable'; reason: string };

/** What Claude can be given for an attachment: its text, or the image itself. */
export async function readAttachment(bytes: Buffer, contentType: string, filename: string, maxChars = 60_000): Promise<AttachmentReading> {
  const type = (contentType || '').toLowerCase();
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') {
    const r = await pdfText(bytes, maxChars + 1);
    if (!r.text.replace(/--- page \d+ ---/g, '').trim()) return { kind: 'unreadable', reason: `This PDF (${r.pages} pages) has no text layer: it is a scan or a picture.` };
    return { kind: 'text', text: r.text.slice(0, maxChars), pages: r.pages, truncated: r.text.length > maxChars };
  }
  if (/^image\/(png|jpe?g|gif|webp)$/.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    if (bytes.length > 4_500_000) return { kind: 'unreadable', reason: 'The image is too big to show here (over 4.5 MB).' };
    const mimeType = type.startsWith('image/') ? type.replace('image/jpg', 'image/jpeg') : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { kind: 'image', data: bytes.toString('base64'), mimeType };
  }
  if (TEXTISH.test(type) || ['txt', 'csv', 'md', 'json', 'xml', 'ics', 'vcf', 'eml', 'log', 'html', 'htm'].includes(ext)) {
    let text = bytes.toString('utf8');
    if (/html/.test(type) || ['html', 'htm'].includes(ext)) text = htmlToText(text);
    return { kind: 'text', text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  return { kind: 'unreadable', reason: `Postino cannot read ${ext ? `.${ext}` : type || 'this kind of'} files yet; it can read PDFs, images and text files.` };
}
