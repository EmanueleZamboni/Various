import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAccounts, useSettings, useSignatures } from '../api/hooks';
import { useSendFeedback, sendLaterOptions } from '../sendFeedback';
import { SignaturePicker, SignaturePreview, defaultSignatureId } from './SignatureEditor';
import type { Draft } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';
import { formatBytes, isValidEmail, parseAddressList } from '../util/format';
import { AddressInput } from './AddressInput';
import { TemplatePicker, fillTemplate } from './Templates';

const MAX_TOTAL = 25 * 1024 * 1024;

export function Compose() {
  const c = useUI((s) => s.compose)!;
  const close = useUI((s) => s.closeCompose);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  void toast;
  const { data: accounts } = useAccounts();
  const { data: settings } = useSettings();
  const feedback = useSendFeedback();
  const [accountId, setAccountId] = useState(c.accountId ?? c.draft?.accountId ?? '');
  const [sendAt, setSendAt] = useState<Date | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [to, setTo] = useState(c.to ?? c.draft?.to ?? '');
  const [cc, setCc] = useState(c.cc ?? c.draft?.cc ?? '');
  const [bcc, setBcc] = useState(c.bcc ?? c.draft?.bcc ?? '');
  const [showCc, setShowCc] = useState(!!(c.cc || c.draft?.cc));
  const [showBcc, setShowBcc] = useState(!!(c.bcc || c.draft?.bcc));
  const [subject, setSubject] = useState(c.subject ?? c.draft?.subject ?? '');
  const [text, setText] = useState(c.text ?? c.draft?.text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  // A reopened draft (undo send, Drafts list) keeps its uploaded files, thread and sender alias.
  const [uploads, setUploads] = useState<{ id: string; filename: string; size: number }[]>(c.draft?.attachments ?? []);
  const inReplyTo = c.inReplyTo ?? c.draft?.inReplyTo ?? null;
  const forwardOf = c.forwardOf ?? c.draft?.forwardOf ?? null;
  const threadId = c.threadId ?? c.draft?.threadId ?? null;
  const fromAddress = c.fromAddress ?? c.draft?.fromAddress ?? undefined;
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const draft = useRef<Draft | null>(c.draft ?? null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<boolean> | null>(null);
  const dirty = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Default sender for a new email: the configured account, or the last one used.
  useEffect(() => {
    if (accountId || !accounts?.length) return;
    const pref = settings?.compose.defaultAccount ?? 'lastUsed';
    let pick = accounts.find((a) => a.id === pref)?.id;
    if (!pick) {
      try {
        const last = localStorage.getItem('postino.lastAccount');
        pick = accounts.find((a) => a.id === last)?.id;
      } catch {
        /* ignore */
      }
    }
    setAccountId(pick ?? accounts[0].id);
  }, [accounts, accountId, settings]);
  useEffect(() => {
    if (!accountId) return;
    try {
      localStorage.setItem('postino.lastAccount', accountId);
    } catch {
      /* ignore */
    }
  }, [accountId]);

  const account = accounts?.find((a) => a.id === accountId);
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;

  // Signature: the account's default, switchable per message.
  const { data: signatures } = useSignatures();
  const [signatureId, setSignatureId] = useState<string>('');
  useEffect(() => {
    if (accountId && signatures) setSignatureId(defaultSignatureId(signatures, accountId));
  }, [accountId, signatures]);
  const signature = (signatures ?? []).find((s) => s.id === signatureId);

  /** Save (or update) the draft. Resolves false when the server could not be reached. */
  const saveDraft = (): Promise<boolean> => {
    if (!dirty.current || !accountId) return Promise.resolve(true);
    if (saving.current) return saving.current.then(() => saveDraft()); // never two creates in flight
    const body = { accountId, to, cc, bcc, subject, text, inReplyTo, forwardOf, threadId, fromAddress: fromAddress ?? null, attachments: uploads };
    const p = (async () => {
      try {
        draft.current = draft.current ? await api.drafts.update(draft.current.id, body) : await api.drafts.create(body);
        dirty.current = false;
        setSaved(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        qc.invalidateQueries({ queryKey: ['drafts'] });
        return true;
      } catch {
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = p;
    return p;
  };

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false; // what the composer opened with is already saved (or empty)
      return;
    }
    dirty.current = !!(to || cc || bcc || subject || text.trim() || uploads.length);
    if (!dirty.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveDraft(), 1500);
    return () => window.clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, text, accountId, uploads]);

  // Leaving the app (phone back gesture, switching apps) saves what was typed so far.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && dirty.current) void saveDraft();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, text, accountId, uploads]);

  const hasContent = !!(to.trim() || subject.trim() || text.trim() || files.length || uploads.length);

  // The phone's back button closes the composer (keeping the draft) instead of leaving the page.
  const backEntry = useRef(false);
  useEffect(() => {
    const token = `compose-${Date.now()}`;
    window.history.pushState({ postinoSheet: token }, '');
    backEntry.current = true;
    const onPop = () => {
      if (!backEntry.current) return;
      backEntry.current = false;
      void closeAndKeepRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed with a button: drop the extra history entry so back goes where it should.
      // (Not when another composer replaced this one: it pushes its own entry.)
      if (backEntry.current && (window.history.state as { postinoSheet?: string } | null)?.postinoSheet === token) {
        backEntry.current = false;
        window.setTimeout(() => {
          if (!useUI.getState().compose && (window.history.state as { postinoSheet?: string } | null)?.postinoSheet === token) window.history.back();
        }, 0);
      }
    };
  }, []);
  const closeAndKeepRef = useRef<() => Promise<void>>(async () => undefined);

  const closeAndKeep = async () => {
    window.clearTimeout(saveTimer.current);
    if (hasContent && dirty.current) {
      const ok = await saveDraft();
      if (!ok) {
        setErr('Could not save the draft: the server is not reachable. Keep this open and try again in a moment.');
        return;
      }
      toast({ text: 'Draft saved' });
    }
    close();
  };
  closeAndKeepRef.current = closeAndKeep;
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
      // A save still in flight would create a stray draft after the send; let it finish first.
      window.clearTimeout(saveTimer.current);
      if (saving.current) await saving.current;
      const fd = new FormData();
      fd.set('accountId', accountId);
      fd.set('to', to);
      if (cc.trim()) fd.set('cc', cc);
      if (bcc.trim()) fd.set('bcc', bcc);
      fd.set('subject', subject.trim() || '(no subject)');
      fd.set('text', text);
      fd.set('signatureId', signatureId || 'none');
      if (inReplyTo) fd.set('inReplyTo', inReplyTo);
      if (forwardOf) fd.set('forwardOf', forwardOf);
      if ((inReplyTo || forwardOf) && (c.quotedText || c.draft) && (settings?.compose.includeQuote ?? true)) fd.set('quote', '1');
      if (fromAddress) fd.set('fromAddress', fromAddress);
      if (sendAt) fd.set('sendAt', sendAt.toISOString());
      if (draft.current) fd.set('draftId', draft.current.id);
      if (uploads.length) fd.set('uploadIds', uploads.map((u) => u.id).join(','));
      for (const f of files) fd.append('attachments', f, f.name);
      const res = await api.send(fd);
      window.clearTimeout(saveTimer.current);
      dirty.current = false;
      // The draft another app left in the IMAP Drafts folder is done with.
      if (c.imapDraftId) api.messages.act({ messageIds: [c.imapDraftId], action: 'trash' }).then(() => qc.invalidateQueries({ queryKey: ['threads'] })).catch(() => undefined);
      close();
      feedback(res, fromAddress || account?.email || 'your account');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = c.mode === 'forward' ? 'Forward' : c.mode === 'new' ? (c.draft ? (forwardOf ? 'Forward (draft)' : inReplyTo ? 'Reply (draft)' : 'Draft') : 'New email') : 'Reply';

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
                <option key={a.id} value={a.id}>{a.name && !narrow ? `${a.name} <${a.email}>` : a.email}</option>
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
          <input id="c-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('c-text')?.focus(); } }} autoComplete="off" />
        </div>
        <label htmlFor="c-body" className="sr-only">Message</label>
        <textarea id="c-body" className="compose-body" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your message" autoFocus={!!c.to} />
        {signature && <div style={{ padding: '0 18px' }}><SignaturePreview signature={signature} /></div>}
        {c.quotedText && <div className="compose-quote">{c.quotedText}</div>}
        {(files.length > 0 || uploads.length > 0) && (
          <div className="compose-atts">
            {uploads.map((u) => (
              <span className="compose-att" key={`up-${u.id}`}>
                <span>{u.filename}</span>
                <small>{formatBytes(u.size)}</small>
                <button type="button" className="ib" aria-label={`Remove ${u.filename}`} onClick={() => setUploads((us) => us.filter((x) => x.id !== u.id))}><Icon name="x" size={14} /></button>
              </span>
            ))}
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
          <TemplatePicker
            current={{ subject, text }}
            onPick={(t) => {
              if (!subject.trim() && t.subject.trim()) setSubject(t.subject);
              const body = fillTemplate(t.text, to);
              setText((cur) => (cur.trim() ? `${body}\n\n${cur}` : body));
            }}
          />
          <SignaturePicker signatures={signatures ?? []} accountId={accountId} value={signatureId || 'none'} onChange={setSignatureId} compact={narrow} />
          {hasContent && (
            <button type="button" className="ib danger" title="Discard" aria-label="Discard draft" onClick={() => void discard()}><Icon name="trash" size={18} /></button>
          )}
          <span className={`status${err ? ' err' : ''}`} role={err ? 'alert' : undefined}>{err || (saved ? `Draft saved ${saved}` : drag ? 'Drop files to attach' : '')}</span>
          <div className="send-group">
            <button type="submit" className="btn btn-primary" disabled={busy || !accounts?.length}>
              {busy ? 'Sending' : sendAt ? `Send ${sendAt.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Send'}
              <Icon name="send" size={15} />
            </button>
            <button type="button" className="btn btn-primary send-later" aria-label="Send later" aria-expanded={laterOpen} onClick={() => setLaterOpen((v) => !v)}>
              <Icon name="chevronDown" size={15} />
            </button>
            {laterOpen && (
              <div className="menu send-later-menu" role="menu">
                {sendLaterOptions().map((o) => (
                  <button type="button" role="menuitem" key={o.label} onClick={() => { setSendAt(o.at); setLaterOpen(false); }}>{o.label}</button>
                ))}
                <label className="menu-custom">
                  Pick a time
                  <input type="datetime-local" onChange={(e) => { if (e.target.value) { setSendAt(new Date(e.target.value)); setLaterOpen(false); } }} />
                </label>
                {sendAt && <button type="button" role="menuitem" onClick={() => { setSendAt(null); setLaterOpen(false); }}>Send now instead</button>}
              </div>
            )}
          </div>
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
