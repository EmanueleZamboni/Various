import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAccountMap, useDrafts, useSettings, useSignatures } from '../api/hooks';
import { useSendFeedback, sendLaterOptions } from '../sendFeedback';
import { SignaturePicker, SignaturePreview, defaultSignatureId } from './SignatureEditor';
import type { Draft, Message, ReplyPrefill } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';
import { firstName, formatBytes, isValidEmail, parseAddressList } from '../util/format';
import { AddressInput } from './AddressInput';
import { TemplatePicker, fillTemplate } from './Templates';

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

export function ReplyBox({ message: m, mode, onModeChange, onClose, onSent }: {
  message: Message;
  mode: ReplyMode;
  onModeChange: (m: ReplyMode) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const accountMap = useAccountMap();
  const account = accountMap.get(m.accountId);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  void qc;
  const { data: settings } = useSettings();
  const feedback = useSendFeedback();
  const [prefill, setPrefill] = useState<ReplyPrefill | null>(null);
  // The server may answer from the alias/account the mail was sent to.
  const sendingAccount = prefill?.accountId ? accountMap.get(prefill.accountId) ?? account : account;
  const sendingAddress = prefill?.fromAddress || sendingAccount?.email;
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showQuote, setShowQuote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const draft = useRef<Draft | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<boolean> | null>(null);
  const [saved, setSaved] = useState('');
  // A reply started earlier on this conversation comes back where it was left.
  const { data: drafts } = useDrafts();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !drafts) return;
    seeded.current = true;
    // Never replace what the user already typed, or a draft this box already created.
    if (text.trim() || draft.current) return;
    const d = drafts.find((x) => x.threadId === m.threadId && (x.inReplyTo === m.id || x.forwardOf === m.id));
    if (!d) return;
    draft.current = d;
    if (d.text) setText(d.text);
    if (d.to) setTo(d.to);
    if (d.cc) setCc(d.cc);
    setSaved(new Date(d.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, m.threadId, m.id]);
  const { data: signatures } = useSignatures();
  const [signatureId, setSignatureId] = useState<string>('');
  const [sendAt, setSendAt] = useState<Date | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  useEffect(() => {
    if (signatures) setSignatureId(defaultSignatureId(signatures, prefill?.accountId ?? m.accountId));
  }, [signatures, m.accountId, prefill?.accountId]);
  const signature = (signatures ?? []).find((s) => s.id === signatureId);

  useEffect(() => {
    let alive = true;
    setPrefill(null);
    api.messages
      .replyPrefill(m.id, mode)
      .then((p) => {
        if (!alive) return;
        setPrefill(p);
        // A reopened draft keeps its own recipients; a fresh reply takes the server's.
        if (!draft.current) {
          setTo(p.to);
          setCc(p.cc);
        }
        window.setTimeout(() => document.getElementById(mode === 'forward' && !p.to ? 'reply-to' : 'reply-text')?.focus(), 30);
      })
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [m.id, mode]);

  /** Save (or update) the draft. Resolves false when the server could not be reached. */
  const saveDraft = (): Promise<boolean> => {
    if (!text.trim()) return Promise.resolve(true);
    if (saving.current) return saving.current.then(() => saveDraft());
    const body = {
      accountId: prefill?.accountId ?? m.accountId,
      fromAddress: prefill?.fromAddress ?? null,
      to,
      cc,
      bcc: '',
      subject: prefill?.subject ?? '',
      text,
      inReplyTo: mode === 'forward' ? null : m.id,
      forwardOf: mode === 'forward' ? m.id : null,
      threadId: m.threadId,
    };
    const p = (async () => {
      try {
        draft.current = draft.current ? await api.drafts.update(draft.current.id, body) : await api.drafts.create(body);
        setSaved(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        qc.invalidateQueries({ queryKey: ['drafts'] });
        return true;
      } catch {
        return false; // keep typing; the server may be briefly away
      } finally {
        saving.current = null;
      }
    })();
    saving.current = p;
    return p;
  };

  // Leaving the app (phone back gesture, switching apps) saves what was typed so far.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && text.trim()) void saveDraft();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, to, cc, mode, prefill]);

  // Autosave as a draft after a pause in typing.
  useEffect(() => {
    if (!text.trim()) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveDraft(), 1500);
    return () => window.clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, to, cc, m, mode, prefill]);

  const send = async () => {
    setErr('');
    const recipients = parseAddressList(to);
    if (!recipients.length || !recipients.every((a) => isValidEmail(a.email))) {
      setErr('Add a valid recipient first.');
      return;
    }
    if (!text.trim() && mode !== 'forward') {
      setErr('Write something before sending.');
      return;
    }
    setBusy(true);
    try {
      window.clearTimeout(saveTimer.current);
      if (saving.current) await saving.current; // a stray draft would survive the send otherwise
      const fd = new FormData();
      fd.set('accountId', prefill?.accountId ?? m.accountId);
      if (prefill?.fromAddress) fd.set('fromAddress', prefill.fromAddress);
      fd.set('to', to);
      if (cc.trim()) fd.set('cc', cc);
      fd.set('subject', prefill?.subject ?? '');
      fd.set('text', text);
      fd.set('signatureId', signatureId || 'none');
      if (mode === 'forward') fd.set('forwardOf', m.id);
      else fd.set('inReplyTo', m.id);
      if (prefill?.quotedText && (settings?.compose.includeQuote ?? true)) fd.set('quote', '1');
      if (sendAt) fd.set('sendAt', sendAt.toISOString());
      if (draft.current) fd.set('draftId', draft.current.id);
      for (const f of files) fd.append('attachments', f, f.name);
      const res = await api.send(fd);
      window.clearTimeout(saveTimer.current);
      onSent();
      feedback(res, sendingAddress ?? 'your account');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    window.clearTimeout(saveTimer.current);
    if (draft.current) {
      try {
        await api.drafts.remove(draft.current.id);
      } catch {
        /* ignore */
      }
    }
    onClose();
  };

  const target = mode === 'forward' ? null : m.mine ? m.to[0] : m.replyTo[0] ?? m.from;

  return (
    <form
      className="reply"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (text.trim()) {
            window.clearTimeout(saveTimer.current);
            void saveDraft().then((ok) => {
              if (ok) {
                toast({ text: 'Draft saved' });
                onClose();
              } else setErr('Could not save the draft: the server is not reachable. Try again in a moment.');
            });
          } else void discard();
        }
      }}
    >
      <div className="reply-from">
        <div className="reply-modes" role="group" aria-label="Reply type">
          <button type="button" className={mode === 'reply' ? 'on' : ''} onClick={() => onModeChange('reply')}>Reply</button>
          <button type="button" className={mode === 'replyAll' ? 'on' : ''} onClick={() => onModeChange('replyAll')}>Reply all</button>
          <button type="button" className={mode === 'forward' ? 'on' : ''} onClick={() => onModeChange('forward')}>Forward</button>
        </div>
        <span>
          {target ? `to ${firstName(target)} ` : ''}from <span className="acct-tag" style={{ ['--c' as string]: sendingAccount?.color }}>{sendingAddress}</span>
        </span>
        <button type="button" className="ib" style={{ marginLeft: 'auto', width: 28, height: 28 }} aria-label="Close reply" onClick={() => void discard()}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {(mode !== 'reply' || cc) && (
        <>
          <AddressInput id="reply-to" label="To" value={to} onChange={setTo} />
          <AddressInput id="reply-cc" label="Cc" value={cc} onChange={setCc} />
        </>
      )}
      <label htmlFor="reply-text" className="sr-only">Message</label>
      <textarea id="reply-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={prefill ? (mode === 'forward' ? 'Add a note (optional)' : `Reply to ${target ? firstName(target) : ''}`) : 'Preparing reply'} disabled={!prefill} autoFocus />
      {signature && <SignaturePreview signature={signature} />}
      {prefill?.quotedText && (
        <>
          <button type="button" className="quoted-toggle" onClick={() => setShowQuote((v) => !v)} aria-expanded={showQuote}>
            <Icon name={showQuote ? 'chevronDown' : 'chevronRight'} size={14} />
            {mode === 'forward' ? 'Forwarded message' : 'Quoted message'}
          </button>
          {showQuote && <div className="quoted" style={{ maxHeight: 200, overflow: 'auto' }}>{prefill.quotedText}</div>}
        </>
      )}
      {files.length > 0 && (
        <div className="compose-atts" style={{ padding: 0 }}>
          {files.map((f, i) => (
            <span className="compose-att" key={`${f.name}-${i}`}>
              <span>{f.name}</span>
              <small>{formatBytes(f.size)}</small>
              <button type="button" className="ib" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      {mode === 'forward' && m.attachments.length > 0 && (
        <div className="help">{m.attachments.length} original attachment{m.attachments.length === 1 ? '' : 's'} will be included.</div>
      )}
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="reply-actions">
        <label className="ib" title="Attach a file" aria-label="Attach a file">
          <Icon name="clip" size={18} />
          <input type="file" multiple hidden onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])])} />
        </label>
        <TemplatePicker
          current={{ subject: prefill?.subject ?? '', text }}
          onPick={(t) => {
            const body = fillTemplate(t.text, to || (m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email));
            setText((cur) => (cur.trim() ? `${body}\n\n${cur}` : body));
          }}
        />
        <SignaturePicker signatures={signatures ?? []} accountId={prefill?.accountId ?? m.accountId} value={signatureId || 'none'} onChange={setSignatureId} compact />
        <span className="help" style={{ fontSize: 12 }}>{saved ? `Draft saved ${saved}` : ''}</span>
        <span className="sp" />
        <div className="send-group">
          <button type="submit" className="btn btn-primary" disabled={busy || !prefill}>
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
  );
}
