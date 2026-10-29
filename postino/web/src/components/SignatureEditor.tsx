import { useEffect, useRef, useState } from 'react';
import type { Signature } from '../api/types';
import { Icon } from '../icons';

/** Shrinks an image to a mail-friendly size and returns it as a data URL. */
async function imageToDataUrl(file: File, maxWidth = 480): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read the image'));
      i.src = url;
    });
    const scale = Math.min(1, maxWidth / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/svg+xml';
    let out = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
    // Signatures travel in every email: keep a logo under ~200 KB.
    for (const q of [0.75, 0.6, 0.45]) {
      if (out.length < 200_000) break;
      out = canvas.toDataURL('image/jpeg', q);
    }
    if (out.length >= 300_000) throw new Error('That image is too large for a signature; use a smaller logo.');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A small rich-text editor for signatures: bold, italic, underline, links,
 * images and plain text. It edits HTML directly (contenteditable), the server
 * cleans it on save.
 */
export function SignatureEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');

  // Set the initial HTML once; afterwards the element owns its content.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value && document.activeElement !== ref.current) ref.current.innerHTML = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange(ref.current?.innerHTML ?? '');
  };

  const addLink = () => {
    const sel = window.getSelection();
    const current = sel && sel.anchorNode ? (sel.anchorNode.parentElement?.closest('a') as HTMLAnchorElement | null) : null;
    const entered = promptUrl(current?.href || '');
    if (entered === null) return;
    if (!entered) exec('unlink');
    else exec('createLink', /^(https?:|mailto:|tel:)/i.test(entered) ? entered : `https://${entered}`);
  };

  const addImage = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setErr('Choose an image file.');
    if (file.size > 4 * 1024 * 1024) return setErr('Use an image under 4 MB.');
    try {
      const data = await imageToDataUrl(file);
      exec('insertHTML', `<img src="${data}" alt="" style="max-width:100%;height:auto">`);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="sig-editor">
      <div className="sig-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')} title="Bold" aria-label="Bold"><b>B</b></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')} title="Italic" aria-label="Italic"><i>I</i></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')} title="Underline" aria-label="Underline"><u>U</u></button>
        <span className="sig-sep" />
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addLink} title="Link" aria-label="Insert link"><Icon name="external" size={16} /></button>
        <label className="sig-tool" title="Insert image" aria-label="Insert image">
          <Icon name="image" size={16} />
          <input type="file" accept="image/*" hidden onChange={(e) => void addImage(e.target.files?.[0])} />
        </label>
        <span className="sig-sep" />
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')} title="Clear formatting" aria-label="Clear formatting">Clear</button>
      </div>
      <div
        ref={ref}
        className="sig-area"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Signature"
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
        onPaste={(e) => {
          // A pasted image is resized like a picked one; text is pasted plain so foreign styles do not sneak in.
          const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
          if (file) {
            e.preventDefault();
            void addImage(file);
            return;
          }
          const text = e.clipboardData.getData('text/plain');
          if (text) {
            e.preventDefault();
            document.execCommand('insertText', false, text);
          }
        }}
      />
      {err && <p className="error-text" role="alert">{err}</p>}
    </div>
  );
}

// Some hosts (embedded previews) have no prompt dialog; then the link tool does nothing.
function promptUrl(initial: string): string | null {
  try {
    return window.prompt('Link address', initial);
  } catch {
    return null;
  }
}

/** Picker used by the composer: the account's signatures plus "No signature". */
export function SignaturePicker({ signatures, accountId, value, onChange, compact }: { signatures: Signature[]; accountId: string; value: string; onChange: (id: string) => void; compact?: boolean }) {
  const mine = signatures.filter((s) => s.accountId === accountId);
  if (!mine.length) return null;
  return (
    <label className={`sig-pick${compact ? ' compact' : ''}`}>
      <Icon name="pen" size={14} />
      <span className="sr-only">Signature</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Signature">
        {mine.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
        <option value="none">No signature</option>
      </select>
    </label>
  );
}

export function SignaturePreview({ signature }: { signature: Signature | undefined }) {
  if (!signature) return null;
  return <div className="sig-preview" aria-label="Signature preview" dangerouslySetInnerHTML={{ __html: signature.html }} />;
}

/** Which signature id to start with for an account: its default, or "none". */
export function defaultSignatureId(signatures: Signature[] | undefined, accountId: string): string {
  const mine = (signatures ?? []).filter((s) => s.accountId === accountId);
  return mine.find((s) => s.isDefault)?.id ?? mine[0]?.id ?? 'none';
}
