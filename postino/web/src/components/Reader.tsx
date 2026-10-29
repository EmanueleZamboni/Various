import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSettings, useAccountMap, useMyEmails, useThread, useThreadActions } from '../api/hooks';
import type { Attachment, Message, ThreadSummary } from '../api/types';
import { Icon } from '../icons';
import { useNav } from '../nav';
import { useUI } from '../store';
import { displayName, firstName, formatBytes, formatFullDate, formatListDate } from '../util/format';
import { Avatar } from './Avatar';
import { ReplyBox, type ReplyMode } from './ReplyBox';

export function Reader({ view }: { view: string }) {
  const nav = useNav();
  const { data: settings } = useSettings();
  const order = useUI((u) => u.order);
  // After archive/delete: open the next conversation, the previous one, or go back to the list.
  const afterAction = (id: string) => {
    const pref = settings?.reading.afterAction ?? 'next';
    const i = order.indexOf(id);
    const next = pref === 'next' ? order[i + 1] ?? order[i - 1] : pref === 'previous' ? order[i - 1] ?? order[i + 1] : undefined;
    const phone = window.matchMedia('(max-width: 760px)').matches;
    if (next && !phone && pref !== 'list') nav.openThread(next);
    else nav.closeThread();
  };
  const ui = useUI();
  const act = useThreadActions();
  const accountMap = useAccountMap();
  const myEmails = useMyEmails();
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useThread(nav.threadId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null);
  const setReplyOpen = useUI((s) => s.setReplyOpen);
  useEffect(() => {
    setReplyOpen(replyMode !== null);
    return () => setReplyOpen(false);
  }, [replyMode, setReplyOpen]);
  const [replyFor, setReplyFor] = useState<string | null>(null);

  const thread = data?.thread;
  const messages = data?.messages ?? [];
  const lastIncoming = useMemo(() => [...messages].reverse().find((m) => !m.mine) ?? messages[messages.length - 1], [messages]);
  const account = thread ? accountMap.get(thread.accountId) : undefined;

  // When a thread opens: expand the newest message (and unread ones), scroll to top, mark read.
  useEffect(() => {
    if (!data) return;
    const ids = new Set<string>();
    const last = data.messages[data.messages.length - 1];
    if (last) ids.add(last.id);
    for (const m of data.messages) if (!m.seen && !m.mine) ids.add(m.id);
    setExpanded(ids);
    setReplyMode(null);
    setReplyFor(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // Mark as read: when opened, after a delay, or never automatically.
    const mode = settings?.reading.markRead ?? 'open';
    if (data.thread.unread && mode !== 'manual') {
      const delay = mode === 'delay' ? Math.max(0, settings?.reading.markReadDelay ?? 2) * 1000 : 0;
      const t = window.setTimeout(() => void act({ threadIds: [data.thread.id], action: 'read', view, scope: 'all', silent: true }), delay);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.thread.id]);

  // Bodies still downloading: poll until fetched (the server also pushes message.updated).
  useEffect(() => {
    if (!data || !data.messages.some((m) => !m.body.fetched)) return;
    const t = window.setTimeout(() => void refetch(), 2000);
    return () => window.clearTimeout(t);
  }, [data, refetch]);

  // Keyboard r / a / f from the shell.
  useEffect(() => {
    const on = (e: Event) => {
      const mode = (e as CustomEvent<ReplyMode>).detail;
      if (lastIncoming) {
        setReplyFor(lastIncoming.id);
        setReplyMode(mode);
      }
    };
    window.addEventListener('postino:reply', on);
    return () => window.removeEventListener('postino:reply', on);
  }, [lastIncoming]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) {
        if (n.size > 1) n.delete(id);
      } else n.add(id);
      return n;
    });

  const startReply = (mode: ReplyMode, messageId?: string) => {
    setReplyFor(messageId ?? lastIncoming?.id ?? null);
    setReplyMode(mode);
    window.setTimeout(() => document.getElementById('reply-text')?.focus(), 50);
  };

  const backBtn = (
    <button className="ib back" onClick={() => nav.closeThread()} aria-label="Back to list">
      <Icon name="back" />
    </button>
  );

  if (!nav.threadId || view === 'blocked') {
    return (
      <section className="reader blank" aria-label="Conversation">
        <div className="empty">
          <div className="big"><Icon name={view === 'blocked' ? 'block' : 'mailOpen'} size={24} /></div>
          {view === 'blocked' ? (
            <>
              <h2>Blocked senders</h2>
              <p>Your block list lives on the server, so a sender you block on your phone is blocked on your computer too.</p>
            </>
          ) : (
            <>
              <h2>Pick a conversation</h2>
              <p>Choose an email from the list to read it here.</p>
              <div className="keys">
                <span><span className="kbd">j</span> <span className="kbd">k</span> move</span>
                <span><span className="kbd">e</span> archive</span>
                <span><span className="kbd">p</span> pin</span>
                <span><span className="kbd">r</span> reply</span>
                <span><span className="kbd">c</span> new</span>
                <span><span className="kbd">?</span> all shortcuts</span>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  if (isLoading || !thread) {
    return (
      <section className="reader" aria-busy="true">
        <div className="r-bar">{backBtn}</div>
        <div className="r-scroll">
          <div className="r-inner">
            <div className="skel-line" style={{ width: '60%', height: 22 }} />
            <div className="skel-line" style={{ width: '35%' }} />
            <div className="skel" style={{ border: 0, padding: '12px 0' }}>
              <div className="skel-av" />
              <div style={{ flex: 1 }}>
                <div className="skel-line" style={{ width: '40%' }} />
                <div className="skel-line" style={{ width: '90%' }} />
                <div className="skel-line" style={{ width: '80%' }} />
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="reader">
        <div className="r-bar">{backBtn}</div>
        <div className="empty">
          <div className="big"><Icon name="alert" size={24} /></div>
          <h2>Could not open this conversation</h2>
          <p>{(error as Error).message}</p>
          <button className="btn btn-ghost" onClick={() => void refetch()}>Try again</button>
        </div>
      </section>
    );
  }

  const inTrash = thread.folderRoles.includes('trash') && !thread.folderRoles.includes('inbox');
  const inJunk = thread.folderRoles.includes('junk') || thread.folderRoles.includes('blocked');
  const canBlock = !!lastIncoming && !lastIncoming.mine;
  const doAct = (action: Parameters<typeof act>[0]['action']) => {
    if (action === 'trash' && settings?.reading.confirmDelete && !window.confirm('Move this conversation to Trash?')) return;
    void act({ threadIds: [thread.id], action, view });
    if (['archive', 'trash', 'junk', 'notjunk', 'inbox', 'delete'].includes(action)) afterAction(thread.id);
  };
  const isDraft = thread.folderRoles.includes('drafts') && messages.every((m) => m.draft);

  return (
    <section className="reader" aria-label="Conversation">
      <div className="r-bar">
        {backBtn}
        <span className="desk">
          {!isDraft && (
            <>
              <button className="ib" onClick={() => doAct('archive')} title="Archive (e)" aria-label="Archive"><Icon name="archive" /></button>
              <button className="ib" onClick={() => doAct(inTrash ? 'inbox' : 'trash')} title={inTrash ? 'Move to Inbox' : 'Delete (#)'} aria-label={inTrash ? 'Move to Inbox' : 'Delete'}><Icon name={inTrash ? 'inbox' : 'trash'} /></button>
              <button className="ib" onClick={() => doAct(inJunk ? 'notjunk' : 'junk')} title={inJunk ? 'Not spam' : 'Mark as spam'} aria-label={inJunk ? 'Not spam' : 'Mark as spam'}><Icon name="spam" /></button>
              <span className="div" />
              <button className={`ib${thread.pinned ? ' on' : ''}`} onClick={() => doAct(thread.pinned ? 'unpin' : 'pin')} title={`${thread.pinned ? 'Unpin' : 'Pin'} (p)`} aria-label={thread.pinned ? 'Unpin' : 'Pin'}><Icon name="pin" /></button>
              <button className="ib" onClick={() => { doAct('unread'); nav.closeThread(); }} title="Mark as unread (u)" aria-label="Mark as unread"><Icon name="unread" /></button>
              <button className="ib" onClick={() => ui.setMoveTarget({ threadIds: [thread.id], accountId: thread.accountId })} title="Move to folder" aria-label="Move to folder"><Icon name="move" /></button>
              {inTrash && (
                <button className="ib danger" onClick={() => doAct('delete')} title="Delete forever" aria-label="Delete forever"><Icon name="x" /></button>
              )}
            </>
          )}
        </span>
        <span className="sp" />
        {canBlock && !isDraft && (
          <button className="btn btn-quiet btn-sm" onClick={() => ui.setPendingBlock({ email: lastIncoming!.from.email, name: displayName(lastIncoming!.from), threadId: thread.id })}>
            <Icon name="block" size={16} />
            <span className="block-label">Block sender</span>
          </button>
        )}
      </div>
      <div className="r-scroll" ref={scrollRef}>
        <div className="r-inner">
          <div className="r-head">
            <h2 className="r-subj">{thread.subject || '(no subject)'}</h2>
            <div className="r-meta">
              {account && (
                <span className="acct-chip" style={{ ['--c' as string]: account.color }}>
                  <i className="dot" />
                  {account.email}
                </span>
              )}
              <span>{messages.length > 1 ? `${messages.length} messages` : formatFullDate(messages[0]?.date ?? thread.lastDate)}</span>
              {thread.pinned && <span className="tag pin"><Icon name="pin" size={13} />Pinned</span>}
            </div>
          </div>
          {messages.map((m) => (
            <MessageCard
              key={m.id}
              message={m}
              thread={thread}
              accountColor={account?.color}
              myEmails={myEmails}
              expanded={expanded.has(m.id)}
              single={messages.length === 1}
              onToggle={() => toggle(m.id)}
              onReply={(mode) => startReply(mode, m.id)}
              onEditDraft={() => ui.openCompose({ mode: 'new', accountId: m.accountId, imapDraftId: m.id, to: m.to.map((a) => a.email).join(', '), cc: m.cc.map((a) => a.email).join(', '), subject: m.subject, text: m.body.text ?? '' })}
              onBlock={() => ui.setPendingBlock({ email: m.from.email, name: displayName(m.from), threadId: thread.id })}
              onRefetch={() => qc.invalidateQueries({ queryKey: ['thread', thread.id] })}
            />
          ))}
          {!isDraft && lastIncoming && (
            replyMode && replyFor ? (
              <ReplyBox
                key={replyFor}
                message={messages.find((m) => m.id === replyFor) ?? lastIncoming}
                mode={replyMode}
                onModeChange={setReplyMode}
                onClose={() => setReplyMode(null)}
                onSent={() => {
                  setReplyMode(null);
                  void refetch();
                  window.setTimeout(() => scrollRef.current?.scrollTo({ top: 1e6, behavior: 'smooth' }), 150);
                }}
              />
            ) : (
              <button className="reply-collapsed" onClick={() => startReply(settings?.compose.defaultReply ?? 'reply')}>
                <Icon name="reply" size={18} />
                Reply to {firstName(lastIncoming.mine ? lastIncoming.to[0] : lastIncoming.from)}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12, fontSize: 13 }}>
                  <span onClick={(e) => { e.stopPropagation(); startReply('replyAll'); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && startReply('replyAll')}>Reply all</span>
                  <span onClick={(e) => { e.stopPropagation(); startReply('forward'); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && startReply('forward')}>Forward</span>
                </span>
              </button>
            )
          )}
        </div>
      </div>
      {!isDraft && (
        <nav className="r-actions" aria-label="Conversation actions">
          <button onClick={() => doAct('archive')}><Icon name="archive" />Archive</button>
          <button onClick={() => doAct(inTrash ? 'inbox' : 'trash')}><Icon name={inTrash ? 'inbox' : 'trash'} />{inTrash ? 'Restore' : 'Delete'}</button>
          <button className={thread.pinned ? 'on' : ''} onClick={() => doAct(thread.pinned ? 'unpin' : 'pin')}><Icon name="pin" />{thread.pinned ? 'Unpin' : 'Pin'}</button>
          <button onClick={() => doAct(inJunk ? 'notjunk' : 'junk')}><Icon name="spam" />{inJunk ? 'Not spam' : 'Spam'}</button>
          <button onClick={() => startReply(settings?.compose.defaultReply ?? 'reply')}><Icon name="reply" />Reply</button>
        </nav>
      )}
    </section>
  );
}

function MessageCard({ message: m, thread, accountColor, myEmails, expanded, single, onToggle, onReply, onEditDraft, onBlock, onRefetch }: {
  message: Message;
  thread: ThreadSummary;
  accountColor?: string;
  myEmails: Set<string>;
  expanded: boolean;
  single: boolean;
  onToggle: () => void;
  onReply: (mode: ReplyMode) => void;
  onEditDraft: () => void;
  onBlock: () => void;
  onRefetch: () => void;
}) {
  const [details, setDetails] = useState(false);
  const { data: rs } = useSettings();
  const imagesPolicy = rs?.reading.remoteImages ?? 'ask';
  const [showImages, setShowImages] = useState(imagesPolicy === 'always' || (imagesPolicy === 'contacts' && !!m.knownSender));
  const [showQuoted, setShowQuoted] = useState(rs?.reading.showQuoted ?? false);
  useEffect(() => {
    if (imagesPolicy === 'always' || (imagesPolicy === 'contacts' && m.knownSender)) setShowImages(true);
  }, [imagesPolicy, m.knownSender, m.id]);
  const [menu, setMenu] = useState(false);
  const toast = useUI((s) => s.toast);
  const act = useThreadActions();
  void thread;
  const me = m.mine;
  const toLine = [...m.to, ...m.cc].map((a) => (myEmails.has(a.email.toLowerCase()) ? 'me' : firstName(a))).join(', ');

  if (!expanded) {
    return (
      <div className="msg collapsed" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}>
        <div className="msg-head">
          <Avatar who={m.from} color={accountColor} small me={me} />
          <div className="msg-who">
            <b>{me ? 'You' : displayName(m.from)}</b>
            <span className="msg-snip">{m.snippet}</span>
          </div>
          <span className="msg-time">{formatListDate(m.date)}</span>
        </div>
      </div>
    );
  }

  const unsubscribe = async () => {
    try {
      const r = await api.messages.unsubscribe(m.id);
      if (r.method === 'http' && r.url) window.open(r.url, '_blank', 'noopener');
      toast({ text: r.method === 'none' ? 'This sender gives no unsubscribe link' : 'Unsubscribe request sent' });
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };

  return (
    <article className="msg">
      <div className="msg-head" style={{ cursor: single ? 'default' : 'pointer' }} onClick={() => !single && onToggle()}>
        <Avatar who={m.from} color={accountColor} small me={me} />
        <div className="msg-who">
          <b>{me ? 'You' : displayName(m.from)}</b>
          <small>
            <button className="to-line" onClick={(e) => { e.stopPropagation(); setDetails((d) => !d); }} aria-expanded={details}>
              {me ? `to ${toLine}` : `${m.from.email} · to ${toLine || 'me'}`}
              <Icon name="chevronDown" size={12} />
            </button>
          </small>
        </div>
        <span className="msg-time"><span className="t-long">{formatFullDate(m.date)}</span><span className="t-short">{formatListDate(m.date)}</span></span>
        <div className="msg-tools" onClick={(e) => e.stopPropagation()}>
          {m.draft ? (
            <button className="btn btn-ghost btn-sm" onClick={onEditDraft}>Edit draft</button>
          ) : (
            <>
              <button className="ib" aria-label="Reply" title="Reply (r)" onClick={() => onReply('reply')}><Icon name="reply" size={18} /></button>
              <div style={{ position: 'relative' }}>
                <button className="ib" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon name="more" size={18} /></button>
                {menu && (
                  <div className="search-pop" style={{ left: 'auto', right: 0, width: 200 }} onMouseLeave={() => setMenu(false)}>
                    <button className="sug" onClick={() => { setMenu(false); onReply('replyAll'); }}><Icon name="replyAll" size={16} />Reply all</button>
                    <button className="sug" onClick={() => { setMenu(false); onReply('forward'); }}><Icon name="forward" size={16} />Forward</button>
                    <button className="sug" onClick={() => { setMenu(false); printMessage(m, showImages); }}><Icon name="draft" size={16} />Print</button>
                    <button className="sug" onClick={() => { setMenu(false); void act({ threadIds: [m.threadId], action: m.flagged ? 'unpin' : 'pin', view: 'inbox' }); }}><Icon name="pin" size={16} />{m.flagged ? 'Unpin' : 'Pin'}</button>
                    {!me && (
                      <button className="sug" onClick={() => { setMenu(false); onBlock(); }}><Icon name="block" size={16} />Block {m.from.email}</button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {details && (
        <div className="msg-details">
          <b>From</b><span>{m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}</span>
          <b>To</b><span>{m.to.map((a) => a.email).join(', ') || '—'}</span>
          {m.cc.length > 0 && (<><b>Cc</b><span>{m.cc.map((a) => a.email).join(', ')}</span></>)}
          {m.replyTo.length > 0 && (<><b>Reply to</b><span>{m.replyTo.map((a) => a.email).join(', ')}</span></>)}
          <b>Date</b><span>{formatFullDate(m.date)}</span>
        </div>
      )}
      <div className="msg-body">
        {!m.body.fetched ? (
          <div className="help">Downloading this message</div>
        ) : (
          <>
            {m.body.hasRemoteImages && !showImages && (
              <div className="images-bar">
                <Icon name="image" size={16} />
                Images from the sender are hidden to protect your privacy.
                <button className="btn btn-ghost btn-sm" onClick={() => setShowImages(true)}>Load images</button>
              </div>
            )}
            {m.calendar && <EventCard ev={m.calendar} attachments={m.attachments} />}
            {m.body.html ? <HtmlBody id={m.id} html={m.body.html} showImages={showImages} /> : <div className="msg-body text" style={{ padding: 0 }}>{m.body.text}</div>}
            {m.body.quoted && (
              <>
                <button className="quoted-toggle" onClick={() => setShowQuoted((v) => !v)} aria-expanded={showQuoted}>
                  <Icon name={showQuoted ? 'chevronDown' : 'chevronRight'} size={14} />
                  {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
                </button>
                {showQuoted && <div className="quoted">{m.body.quoted}</div>}
              </>
            )}
          </>
        )}
        {m.attachments.filter((a) => !a.inline).length > 0 && (
          <div className="atts">
            {m.attachments.filter((a) => !a.inline && !(m.calendar && /calendar|\/ics$/i.test(a.contentType))).map((a, _i, list) => <AttachmentChip key={a.id} a={a} all={list} />)}
          </div>
        )}
        {m.listUnsubscribe && !me && (
          <div style={{ marginTop: 14, display: 'flex', gap: 14, alignItems: 'center' }}>
            <button className="unsub" onClick={unsubscribe}><Icon name="x" size={14} />Unsubscribe</button>
            <button className="unsub" onClick={onRefetch} hidden><Icon name="refresh" size={14} /></button>
          </div>
        )}
      </div>
    </article>
  );
}

export function AttachmentChip({ a, all }: { a: Attachment; all?: Attachment[] }) {
  const openViewer = useUI((s) => s.openViewer);
  const ext = (a.filename.split('.').pop() ?? '').toLowerCase();
  const cls = ext === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext) ? 'img' : ['doc', 'docx', 'odt'].includes(ext) ? 'doc' : ['xls', 'xlsx', 'csv'].includes(ext) ? 'xls' : '';
  const list = all ?? [a];
  return (
    <button type="button" className="att" title={a.filename} onClick={() => openViewer(list, Math.max(0, list.findIndex((x) => x.id === a.id)))}>
      <span className={`att-ico ${cls}`}>{ext.slice(0, 4).toUpperCase() || 'FILE'}</span>
      <span className="att-name">
        <span>{a.filename}</span>
        <small>{formatBytes(a.size)}</small>
      </span>
      <Icon name="eye" size={15} style={{ color: 'var(--faint)', flex: 'none' }} />
    </button>
  );
}

/** Print one message: its header plus the sanitized body, in a plain page. */
export function printMessage(m: Message, showImages = false) {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  // Remote images only when the reader shows them too; the page gets the same CSP as the viewer and no scripts.
  const body = showImages ? (m.body.html || '').replace(/\ssrc=""/g, '').replace(/data-remote-src=/g, 'src=') : m.body.html || '';
  const csp = `default-src 'none'; img-src data: blob: ${showImages ? 'https: http:' : ''} ${location.origin}; style-src 'unsafe-inline'; script-src 'none'`;
  const who = (a: { name: string; email: string }) => (a.name ? `${esc(a.name)} <${esc(a.email)}>` : esc(a.email));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(m.subject || '(no subject)')}</title>
    <style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 12px}table.h td{padding:2px 10px 2px 0;color:#555;vertical-align:top}table.h td:first-child{font-weight:600;color:#222}hr{border:0;border-top:1px solid #ddd;margin:16px 0}img{max-width:100%}blockquote{border-left:2px solid #ccc;margin:0;padding-left:1ex;color:#555}</style></head>
    <body><h1>${esc(m.subject || '(no subject)')}</h1>
    <table class="h"><tr><td>From</td><td>${who(m.from)}</td></tr><tr><td>To</td><td>${m.to.map(who).join(', ')}</td></tr>${m.cc.length ? `<tr><td>Cc</td><td>${m.cc.map(who).join(', ')}</td></tr>` : ''}<tr><td>Date</td><td>${esc(new Date(m.date).toLocaleString())}</td></tr>${m.attachments.length ? `<tr><td>Attachments</td><td>${m.attachments.map((a) => esc(a.filename)).join(', ')}</td></tr>` : ''}</table>
    <hr>${body || `<pre style="white-space:pre-wrap">${esc(m.body.text || '')}</pre>`}</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  // Same origin is needed for print(); scripts are blocked by the CSP above and the sandbox.
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.srcdoc = html;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      window.setTimeout(() => frame.remove(), 60_000);
    }
  };
  document.body.appendChild(frame);
}

const FRAME_CSS = `
  html,body{margin:0;padding:0;background:#fff;color:#17201c}
  body{font:15px/1.6 'Instrument Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:2px 0 4px}
  img{max-width:100%!important;height:auto}
  table{max-width:100%}
  a{color:#157a5b}
  blockquote{margin:0 0 0 .6em;padding-left:.9em;border-left:2px solid #cfd6d2;color:#6b7571}
  pre{white-space:pre-wrap}
`;
/** The frame's script lives in public/frame.js: the app's CSP allows only files from its own origin. */
const frameScriptUrl = () => new URL(`${import.meta.env.BASE_URL}frame.js`, location.href).href;

export function HtmlBody({ id, html, showImages }: { id: string; html: string; showImages: boolean }) {
  const [height, setHeight] = useState(80);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.postino === 'h' && d.id === id && typeof d.h === 'number') setHeight(Math.min(Math.max(d.h, 24), 20000));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [id]);
  const doc = useMemo(() => {
    let body = html;
    if (showImages) body = body.replace(/\ssrc=""/g, '').replace(/data-remote-src=/g, 'src=');
    // Only scripts from our own origin may run (the mail body cannot reference any: the sanitizer drops script tags).
    const script = frameScriptUrl();
    const csp = `default-src 'none'; img-src data: blob: ${showImages ? 'https: http:' : ''} ${location.origin}; style-src 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src ${location.origin}`;
    return `<!doctype html><html data-id="${id}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${body}<script src="${script}"></script></body></html>`;
  }, [html, id, showImages]);
  return (
    <iframe
      className="html-frame"
      title="Message"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={{ height }}
    />
  );
}


/** Invitation card for a text/calendar part, with a one-click add to Google Calendar. */
function EventCard({ ev, attachments }: { ev: NonNullable<Message['calendar']>; attachments: Attachment[] }) {
  const start = ev.start ? new Date(ev.start) : null;
  const end = ev.end ? new Date(ev.end) : null;
  const when = !start
    ? ''
    : ev.allDay
      ? start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + (end && end.getTime() - start.getTime() > 86400_000 ? ` – ${new Date(end.getTime() - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` : '')
      : start.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + (end ? ` – ${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '');
  const ics = attachments.find((a) => /\.ics$/i.test(a.filename) || /calendar/i.test(a.contentType));
  const cancelled = ev.method === 'CANCEL';
  return (
    <div className={`event-card${cancelled ? ' cancelled' : ''}`}>
      <div className="event-date">
        <b>{start ? start.getDate() : '—'}</b>
        <small>{start ? start.toLocaleDateString(undefined, { month: 'short' }) : ''}</small>
      </div>
      <div className="event-body">
        <b>{cancelled ? 'Cancelled: ' : ''}{ev.summary || 'Event'}</b>
        {when && <span>{when}</span>}
        {ev.location && <span className="help">{ev.location}</span>}
        {ev.organizer && <span className="help">Organised by {ev.organizer.name || ev.organizer.email}</span>}
        <div className="row-inline" style={{ marginTop: 6 }}>
          {ev.googleLink && !cancelled && <a className="btn btn-primary btn-sm" href={ev.googleLink} target="_blank" rel="noopener"><Icon name="plus" size={14} />Add to Google Calendar</a>}
          {ics && <a className="btn btn-ghost btn-sm" href={ics.url} download={ics.filename}><Icon name="download" size={14} />.ics file</a>}
        </div>
      </div>
    </div>
  );
}
