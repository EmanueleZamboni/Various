import { describe, it, expect } from 'vitest';
import { readAttachment } from './attachmentText.js';

/** A tiny one-page PDF with a line of text (made up). */
function samplePdf(line: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('reading attachments for Claude', () => {
  it('extracts the text of a PDF', async () => {
    const r = await readAttachment(samplePdf('Invoice 42 total 123.45 EUR'), 'application/pdf', 'invoice.pdf');
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toContain('Invoice 42 total 123.45 EUR');
      expect(r.pages).toBe(1);
    }
  });
  it('says when a PDF has no text (a scan)', async () => {
    const r = await readAttachment(samplePdf(''), 'application/pdf', 'scan.pdf');
    expect(r.kind).toBe('unreadable');
  });
  it('gives images as images and text files as text', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    expect(await readAttachment(png, 'image/png', 'a.png')).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(await readAttachment(Buffer.from('a,b\n1,2'), 'text/csv', 'a.csv')).toMatchObject({ kind: 'text', text: 'a,b\n1,2' });
    expect((await readAttachment(Buffer.from('PK'), 'application/zip', 'a.zip')).kind).toBe('unreadable');
  });
});
