import { useEffect, useRef, useState } from 'react';

/**
 * Rich previews, each loaded only when such a file is opened:
 * PDF with Mozilla's pdf.js (works on phones too), Word with docx-preview inside a
 * script-less frame, Excel with read-excel-file as a table.
 */

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`Could not load the file (${r.status})`);
  return r.arrayBuffer();
}

function Status({ text }: { text: string }) {
  return <div className="pv-status">{text}</div>;
}

// ---------- PDF ----------

export function PdfPreview({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ data: await fetchBytes(url) }).promise;
        if (cancelled || !box.current) return;
        setPages(doc.numPages);
        setState('ready');
        const width = Math.min(box.current.clientWidth - 16, 1000);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= Math.min(doc.numPages, 60); n++) {
          if (cancelled || !box.current) return;
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.className = 'pv-page';
          box.current.appendChild(canvas);
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
        }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      if (box.current) box.current.innerHTML = '';
    };
  }, [url]);
  return (
    <div className="pv-scroll">
      {state === 'loading' && <Status text="Opening the PDF…" />}
      {state === 'error' && <Status text="This PDF could not be shown. Download it instead." />}
      <div className="pv-pages" ref={box} />
      {pages > 60 && <Status text={`Showing the first 60 of ${pages} pages. Download for the rest.`} />}
    </div>
  );
}

// ---------- Word (.docx) ----------

const DOC_FRAME = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><style>html,body{margin:0;background:#eef0f4}.docx-wrapper{background:#eef0f4!important;padding:16px!important}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.15);margin-bottom:16px!important;max-width:100%}</style></head><body></body></html>`;

export function DocxPreview({ url }: { url: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    const el = frame.current;
    if (!el) return;
    const run = async () => {
      try {
        const [{ renderAsync }, bytes] = await Promise.all([import('docx-preview'), fetchBytes(url)]);
        const doc = el.contentDocument;
        if (cancelled || !doc) return;
        // The frame is same-origin so we can write into it, but has no allow-scripts: nothing in the document can run.
        await renderAsync(new Blob([bytes]), doc.body, doc.head, { inWrapper: true, ignoreLastRenderedPageBreak: true, experimental: false, useBase64URL: true });
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    };
    if (el.contentDocument?.readyState === 'complete' && el.contentDocument.body) void run();
    else el.addEventListener('load', () => void run(), { once: true });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="pv-doc">
      {state === 'loading' && <Status text="Opening the document…" />}
      {state === 'error' && <Status text="This document could not be shown. Open it in Google Docs or download it." />}
      <iframe ref={frame} className="pv-doc-frame" title="Document preview" sandbox="allow-same-origin" srcDoc={DOC_FRAME} />
    </div>
  );
}

// ---------- Excel (.xlsx) ----------

type Cell = string | number | boolean | Date | null;

function show(c: Cell): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return c.toLocaleDateString();
  return String(c);
}

export function SheetPreview({ url }: { url: string }) {
  const [sheets, setSheets] = useState<{ sheet: string; data: Cell[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ default: readXlsxFile }, bytes] = await Promise.all([import('read-excel-file/browser'), fetchBytes(url)]);
        const all = (await readXlsxFile(new Blob([bytes]))) as { sheet: string; data: Cell[][] }[];
        if (!cancelled) setSheets(all);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error) return <Status text="This spreadsheet could not be shown. Open it in Google Sheets or download it." />;
  if (!sheets) return <Status text="Opening the spreadsheet…" />;
  const rows = (sheets[active]?.data ?? []).slice(0, 2000);
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return (
    <div className="pv-sheet">
      {sheets.length > 1 && (
        <div className="pv-tabs" role="tablist">
          {sheets.map((s, i) => (
            <button key={s.sheet} role="tab" aria-selected={i === active} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>{s.sheet}</button>
          ))}
        </div>
      )}
      <div className="pv-table-wrap">
        <table className="pv-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th>{i + 1}</th>
                {Array.from({ length: cols }, (_, j) => <td key={j}>{show(r[j] ?? null)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(sheets[active]?.data.length ?? 0) > 2000 && <Status text="Showing the first 2,000 rows." />}
    </div>
  );
}
