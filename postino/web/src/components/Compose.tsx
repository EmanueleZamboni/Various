import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAccounts } from '../api/hooks';
import type { Draft } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';
import { formatBytes, isValidEmail, parseAddressList } from '../util/format';
import { AddressInput } from './AddressInput';

const MAX_TOTAL = 25 * 1024 * 1024;

export function Compose() {
  const c = useUI((s) => s.compose)!;
  const close = useUI((s) => s.closeCompose);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const [accountId, setAccountId] = useState(c.accountId ?? c.draft?.accountId ?? '');
  const [to, setTo] = useState(c.to ?? c.draft?.to ?? '');
  const [cc, setCc] = useState(c.cc ?? c.draft?.cc ?? '');
  const [bcc, setBcc] = useState(c.bcc ?? c.draft?.bcc ?? '');
  const [showCc, setShowCc] = useState(!!(c.cc || c.draft?.cc));
  const [showBcc, setShowBcc] = useState(!!(c.bcc || c.draft?.bcc));
  const [subject, setSubject] = useState(c.subject ?? c.draft?.subject ?? '');
  const [text, setText] = useState(c.text ?? c.draft?.text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const draft = useRef<Draft | null>(c.draft ?? null);
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountId && accounts?.length) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const account = accounts?.find((a) => a.id === accountId);

  // Signature on first pick of account for a new message.
  useEffect(() => {
    if (c.mode !== 'new' || c.draft || !account?.signature || text) return;
    setText(`\n\n${account.signature}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const saveDraft = async () => {
    if (!dirty.current || !accountId) return;
    const body = { accountId, to, cc, bcc, subject, text, inReplyTo: c.inReplyTo ?? null, threadId: c.threadId ?? null };
    try {
      draft.current = draft.current ? await api.drafts.update(draft.current.id, body) : await api.drafts.create(body);
      setSaved(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
      qc.invalidateQueries({ queryKey: ['drafts'] });
    } catch {
      /* keep going */
    }
  };

  useEffect(() => {
    dirty.current = !!(to || cc || bcc || subject || text.trim());
    if (!dirty.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveDraft(), 1500);
    return () => window.clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, text, accountId]);

  const hasContent = !!(to.trim() || subject.trim() || text.trim() || files.length);

  const closeAndKeep = async () => {
    window.clearTimeout(saveTimer.current);
    if (hasContent && dirty.current) {
      await saveDraft();
      toast({ text: 'Draft saved' });
    }
    close();
  };
  const discard = async () => {
    window.clearTimeout(saveTimer.current);
    if (draft.current) {
      try {
        await api.drafts.remove(draft.current.id);
        qc.invalidateQueries({ queryKey: ['drafts'] });
      } catch {
        /* ignore */
      }
    }
    close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void closeAndKeep();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, text, files.length]);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)];
    const total = next.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL) {
      setErr(`Attachments are limited to ${formatBytes(MAX_TOTAL)} per email.`);
      return;
    }
    setErr('');
    setFiles(next);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const send = async () => {
    setErr('');
    const recipients = parseAddressList(to);
    if (!recipients.length || !recipients.every((a) => isValidEmail(a.email))) {
      setErr('Add a valid email address in To.');
      document.getElementById('c-to')?.focus();
      return;
    }
    if (!subject.trim() && !window.confirm_) {
      // no browser confirm in the app; send with "(no subject)" and say so
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('accountId', accountId);
      fd.set('to', to);
      if (cc.trim()) fd.set('cc', cc);
      if (bcc.trim()) fd.set('bcc', bcc);
      fd.set('subject', subject.trim() || '(no subject)');
      fd.set('text', c.quotedText ? `${text}\n\n${c.quotedText}` : text);
      if (c.inReplyTo) fd.set('inReplyTo', c.inReplyTo);
      if (c.forwardOf) fd.set('forwardOf', c.forwardOf);
      if (draft.current) fd.set('draftId', draft.current.id);
      for (const f of files) fd.append('attachments', f, f.name);
      await api.send(fd);
      window.clearTimeout(saveTimer.current);
      dirty.current = false;
      toast({ text: `Sent from ${account?.email ?? 'your account'}`, kind: 'success' });
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['drafts'] });
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = c.mode === 'forward' ? 'Forward' : c.mode === 'new' ? (c.draft ? 'Draft' : 'New email') : 'Reply';

  return (
    <div className="scrim full" role="dialog" aria-modal="true" aria-labelledby="compose-title" onMouseDown={(e) => { if (e.target === e.currentTarget) void closeAndKeep(); }}>
      <form
        ref={sheetRef as never}
        className={`sheet compose${drag ? ' drop' : ''}`}
        onSubmit={(e) => { e.preventDefault(); void send(); }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(); }}
      >
        <div className="compose-top">
          <h2 id="compose-title">{subject.trim() ? subject : title}</h2>
          <button type="button" className="ib" aria-label="Close" onClick={() => void closeAndKeep()}><Icon name="x" /></button>
        </div>
        <div className="cfield">
          <label htmlFor="c-from">From</label>
          <div className="from-pick">
            <i className="dot" style={{ ['--c' as string]: account?.color }} />
            <select id="c-from" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <AddressInput id="c-to" label="To" value={to} onChange={setTo} autoFocus={!c.to} />
          <div className="links" style={{ position: 'absolute', right: 14, top: 6, display: 'flex', gap: 2 }}>
            {!showCc && <button type="button" onClick={() => setShowCc(true)} className="btn btn-quiet btn-sm">Cc</button>}
            {!showBcc && <button type="button" onClick={() => setShowBcc(true)} className="btn btn-quiet btn-sm">Bcc</button>}
          </div>
        </div>
        {showCc && <AddressInput id="c-cc" label="Cc" value={cc} onChange={setCc} />}
        {showBcc && <AddressInput id="c-bcc" label="Bcc" value={bcc} onChange={setBcc} />}
        <div className="cfield">
          <label htmlFor="c-subject">Subject</label>
          <input id="c-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} autoComplete="off" />
        </div>
        <label htmlFor="c-body" className="sr-only">Message</label>
        <textarea id="c-body" className="compose-body" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your message" autoFocus={!!c.to} />
        {c.quotedText && <div className="compose-quote">{c.quotedText}</div>}
        {files.length > 0 && (
          <div className="compose-atts">
            {files.map((f, i) => (
              <span className="compose-att" key={`${f.name}-${i}`}>
                <span>{f.name}</span>
                <small>{formatBytes(f.size)}</small>
                <button type="button" className="ib" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="compose-foot">
          <label className="ib" title="Attach files" aria-label="Attach files">
            <Icon name="clip" size={18} />
            <input type="file" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </label>
          {hasContent && (
            <button type="button" className="ib danger" title="Discard" aria-label="Discard draft" onClick={() => void discard()}><Icon name="trash" size={18} /></button>
          )}
          <span className={`status${err ? ' err' : ''}`} role={err ? 'alert' : undefined}>{err || (saved ? `Draft saved ${saved}` : drag ? 'Drop files to attach' : '')}</span>
          <button type="submit" className="btn btn-primary" disabled={busy || !accounts?.length}>
            {busy ? 'Sending' : 'Send'}
            <Icon name="send" size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}

declare global {
  interface Window {
    confirm_?: undefined;
  }
}
