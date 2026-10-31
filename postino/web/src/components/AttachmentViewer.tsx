import { useEffect, useState } from 'react';
import type { Attachment } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';
import { formatBytes } from '../util/format';
import { DriveActions } from './DriveActions';
import { DocxPreview, PdfPreview, SheetPreview } from './Previews';

export type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'docx' | 'xlsx' | 'none';
// Chrome on Android (and iOS Safari in an iframe) has no inline PDF viewer.
const pdfInline = typeof navigator === 'undefined' ? true : (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false && !/Android|iPhone|iPad/i.test(navigator.userAgent);

export function previewKind(a: Attachment): PreviewKind {
  const t = a.contentType.toLowerCase();
  const ext = (a.filename.split('.').pop() ?? '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/.test(t) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('text/') || ['txt', 'md', 'csv', 'log', 'json'].includes(ext)) return 'text';
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(t) || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (/^audio\//.test(t) || ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus'].includes(ext)) return 'audio';
  if (ext === 'docx' || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'xlsx' || t === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return 'none';
}

/**
 * Full-screen viewer for a message's attachments: images and PDFs inline,
 * text files as text, everything else offers download / Google Drive.
 * Arrow keys move between files, Escape closes.
 */
export function AttachmentViewer() {
  const viewer = useUI((s) => s.viewer);
  const close = useUI((s) => s.closeViewer);
  const setIndex = useUI((s) => s.setViewerIndex);
  const [text, setText] = useState<string | null>(null);
  const a = viewer ? viewer.attachments[viewer.index] : null;
  const kind = a ? previewKind(a) : 'none';

  useEffect(() => {
    if (!viewer) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setIndex(Math.min(viewer.index + 1, viewer.attachments.length - 1));
      if (e.key === 'ArrowLeft') setIndex(Math.max(viewer.index - 1, 0));
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [viewer, close, setIndex]);

  useEffect(() => {
    setText(null);
    if (!a || kind !== 'text') return;
    let alive = true;
    fetch(`${a.url}?inline=1`)
      .then((r) => r.text())
      .then((t) => alive && setText(t.slice(0, 200_000)))
      .catch(() => alive && setText('Could not load this file.'));
    return () => {
      alive = false;
    };
  }, [a, kind]);

  if (!viewer || !a) return null;
  const many = viewer.attachments.length > 1;
  // Nothing to show: a small "download it?" prompt instead of a full-screen viewer.
  if (kind === 'none') {
    return (
      <div className="viewer compact" role="dialog" aria-modal="true" aria-label={a.filename} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="viewer-ask">
          <span className="att-ico big">{(a.filename.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}</span>
          <b className="ask-name">{a.filename}</b>
          <small>{formatBytes(a.size)}</small>
          <p>No preview for this file. Download it?</p>
          <div className="ask-actions">
            <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
            <a className="btn btn-primary" href={a.url} download={a.filename} onClick={() => window.setTimeout(close, 100)}><Icon name="download" size={15} />Download</a>
          </div>
          <DriveActions attachment={a} />
        </div>
      </div>
    );
  }
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={a.filename} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="viewer-top">
        <div className="viewer-title">
          <b>{a.filename}</b>
          <small>{formatBytes(a.size)}{many ? ` · ${viewer.index + 1} of ${viewer.attachments.length}` : ''}</small>
        </div>
        <div className="viewer-actions">
          <DriveActions attachment={a} compact />
          <a className="btn btn-ghost btn-sm" href={a.url} download={a.filename}><Icon name="download" size={15} />Download</a>
          <a className="btn btn-ghost btn-sm" href={`${a.url}?inline=1`} target="_blank" rel="noopener"><Icon name="external" size={15} />Open in tab</a>
          <button className="ib" aria-label="Close" onClick={close}><Icon name="x" /></button>
        </div>
      </div>
      <div className="viewer-body" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        {many && <button className="viewer-nav prev" aria-label="Previous file" disabled={viewer.index === 0} onClick={() => setIndex(viewer.index - 1)}><Icon name="chevronRight" size={22} style={{ transform: 'rotate(180deg)' }} /></button>}
        {kind === 'image' && <img className="viewer-img" src={`${a.url}?inline=1`} alt={a.filename} />}
        {kind === 'pdf' && pdfInline && <iframe className="viewer-frame" src={`${a.url}?inline=1#toolbar=1`} title={a.filename} />}
        {kind === 'pdf' && !pdfInline && <PdfPreview url={a.url} />}
        {kind === 'video' && <video className="viewer-media" src={`${a.url}?inline=1`} controls playsInline preload="metadata" />}
        {kind === 'audio' && <audio className="viewer-audio" src={`${a.url}?inline=1`} controls preload="metadata" />}
        {kind === 'docx' && <DocxPreview url={a.url} />}
        {kind === 'xlsx' && <SheetPreview url={a.url} />}
        {kind === 'text' && <pre className="viewer-text">{text ?? 'Loading'}</pre>}
        {many && <button className="viewer-nav next" aria-label="Next file" disabled={viewer.index === viewer.attachments.length - 1} onClick={() => setIndex(viewer.index + 1)}><Icon name="chevronRight" size={22} /></button>}
      </div>
    </div>
  );
}
