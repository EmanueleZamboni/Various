import { InviteActions, useAddToTasks } from './GoogleApps';
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
  const addToTasks = useAddToTasks();
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
  const pos = order.indexOf(thread.id);

  return (
    <section className="reader" aria-label="Conversation">
      <div className="r-bar" role="toolbar" aria-label="Conversation actions">
        {backBtn}
        {!isDraft && (
          <>
            <button className="ib" onClick={() => doAct('archive')} title="Archive (e)" aria-label="Archive"><Icon name="archive" /></button>
            <button className="ib wide-only" onClick={() => doAct(inJunk ? 'notjunk' : 'junk')} title={inJunk ? 'Not spam' : 'Report spam'} aria-label={inJunk ? 'Not spam' : 'Report spam'}><Icon name="spam" /></button>
            <button className="ib" onClick={() => doAct(inTrash ? 'inbox' : 'trash')} title={inTrash ? 'Move to Inbox' : 'Delete (#)'} aria-label={inTrash ? 'Move to Inbox' : 'Delete'}><Icon name={inTrash ? 'moveInbox' : 'trash'} /></button>
            {inTrash && (
              <button className="ib" onClick={() => doAct('delete')} title="Delete forever" aria-label="Delete forever"><Icon name="deleteForever" /></button>
            )}
            <span className="div wide-only" />
            <button className="ib" onClick={() => { doAct('unread'); nav.closeThread(); }} title="Mark as unread (u)" aria-label="Mark as unread"><Icon name="mail" /></button>
            <button className="ib wide-only" onClick={() => ui.setMoveTarget({ threadIds: [thread.id], accountId: thread.accountId })} title="Move to" aria-label="Move to"><Icon name="move" /></button>
            <button className="ib" onClick={() => void addToTasks(thread.id)} title="Add to Tasks" aria-label="Add to Tasks"><Icon name="addTask" /></button>
            <button className={`ib star-btn${thread.pinned ? ' on' : ''}`} onClick={() => doAct(thread.pinned ? 'unpin' : 'pin')} title={thread.pinned ? 'Remove star (s)' : 'Add star (s)'} aria-label={thread.pinned ? 'Remove star' : 'Add star'}><Icon name={thread.pinned ? 'starFilled' : 'star'} /></button>
            {canBlock && (
              <button className="ib wide-only" onClick={() => ui.setPendingBlock({ email: lastIncoming!.from.email, name: displayName(lastIncoming!.from), threadId: thread.id })} title={`Block ${lastIncoming!.from.email}`} aria-label="Block sender"><Icon name="block" /></button>
            )}
          </>
        )}
        <span className="sp" />
        {pos >= 0 && order.length > 1 && (
          <span className="pager wide-only">
            <span className="range">{`${pos + 1} of ${order.length}`}</span>
            <button className="ib" disabled={pos <= 0} onClick={() => nav.openThread(order[pos - 1])} aria-label="Newer" title="Newer (k)"><Icon name="chevronLeft" /></button>
            <button className="ib" disabled={pos >= order.length - 1} onClick={() => nav.openThread(order[pos + 1])} aria-label="Older" title="Older (j)"><Icon name="chevronRight" /></button>
          </span>
        )}
      </div>
      <div className="r-scroll" ref={scrollRef}>
        <div className="r-inner">
          <div className="r-head">
            <h2 className="r-subj">
              {thread.subject || '(no subject)'}
              {account && (
                <span className="acct-tag" style={{ ['--c' as string]: account.color }}>{account.email}</span>
              )}
            </h2>
            {lastIncoming && (
              <button className="ib wide-only" onClick={() => printMessage(lastIncoming, true)} aria-label="Print" title="Print"><Icon name="print" /></button>
            )}
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
              <div className="reply-pills">
                <button className="pill-btn" onClick={() => startReply('reply')}><Icon name="reply" size={20} />Reply</button>
                {lastIncoming.to.length + lastIncoming.cc.length > 1 && (
                  <button className="pill-btn" onClick={() => startReply('replyAll')}><Icon name="replyAll" size={20} />Reply all</button>
                )}
                <button className="pill-btn" onClick={() => startReply('forward')}><Icon name="forward" size={20} />Forward</button>
              </div>
            )
          )}
        </div>
      </div>
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
  const [unsub, setUnsub] = useState<'idle' | 'busy' | 'done'>('idle');
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
    setUnsub('busy');
    try {
      const r = await api.messages.unsubscribe(m.id);
      if (r.method === 'http' && r.url) window.open(r.url, '_blank', 'noopener');
      if (r.method === 'none') {
        toast({ text: 'This sender gives no unsubscribe link. Block them instead.' });
        setUnsub('idle');
      } else setUnsub('done');
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
      setUnsub('idle');
    }
  };

  return (
    <article className="msg">
      <div className="msg-head" style={{ cursor: single ? 'default' : 'pointer' }} onClick={() => !single && onToggle()}>
        <Avatar who={m.from} color={accountColor} small me={me} />
        <div className="msg-who">
          <span className="msg-from">
            <b>{me ? 'me' : displayName(m.from)}</b>
            {!me && m.from.name && <span className="msg-email">&lt;{m.from.email}&gt;</span>}
          </span>
          <button className="to-line" onClick={(e) => { e.stopPropagation(); setDetails((d) => !d); }} aria-expanded={details} aria-label="Show details">
            {`to ${toLine || 'me'}`}
            <Icon name="dropDown" size={18} />
          </button>
        </div>
        <span className="msg-time"><span className="t-long">{formatFullDate(m.date)}{agoText(m.date)}</span><span className="t-short">{formatListDate(m.date)}</span></span>
        <div className="msg-tools" onClick={(e) => e.stopPropagation()}>
          {m.draft ? (
            <button className="btn btn-ghost btn-sm" onClick={onEditDraft}>Edit draft</button>
          ) : (
            <>
              <button className={`ib star-btn wide-only${m.flagged ? ' on' : ''}`} aria-label={m.flagged ? 'Starred' : 'Not starred'} title={m.flagged ? 'Starred' : 'Not starred'} onClick={() => void act({ threadIds: [m.threadId], action: m.flagged ? 'unpin' : 'pin', view: 'inbox' })}><Icon name={m.flagged ? 'starFilled' : 'star'} size={20} /></button>
              <button className="ib" aria-label="Reply" title="Reply (r)" onClick={() => onReply('reply')}><Icon name="reply" size={20} /></button>
              <div style={{ position: 'relative' }}>
                <button className="ib" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon name="more" size={20} /></button>
                {menu && (
                  <div className="menu-pop right" role="menu" onMouseLeave={() => setMenu(false)}>
                    <button className="sug" onClick={() => { setMenu(false); onReply('replyAll'); }}><Icon name="replyAll" size={16} />Reply all</button>
                    <button className="sug" onClick={() => { setMenu(false); onReply('forward'); }}><Icon name="forward" size={16} />Forward</button>
                    <button className="sug" onClick={() => { setMenu(false); printMessage(m, showImages); }}><Icon name="print" size={16} />Print</button>
                    <button className="sug" onClick={() => { setMenu(false); void act({ threadIds: [m.threadId], action: m.flagged ? 'unpin' : 'pin', view: 'inbox' }); }}><Icon name={m.flagged ? 'starFilled' : 'star'} size={16} />{m.flagged ? 'Remove star' : 'Add star'}</button>
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
        {m.listUnsubscribe && !me && expanded && (
          <div className={`unsub-bar${unsub === 'done' ? ' done' : ''}`}>
            {unsub === 'done' ? (
              <>
                <Icon name="check" size={16} />
                <span>Unsubscribed. Some senders take a few days; block them to stop it right now.</span>
                <button className="btn btn-ghost btn-sm" onClick={onBlock}>Block sender</button>
              </>
            ) : (
              <>
                <Icon name="news" size={16} />
                <span>Mailing list from <b>{displayName(m.from)}</b></span>
                <button className="btn btn-primary btn-sm" onClick={() => void unsubscribe()} disabled={unsub === 'busy'}>{unsub === 'busy' ? 'Unsubscribing…' : 'Unsubscribe'}</button>
              </>
            )}
          </div>
        )}
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
            {m.calendar && <EventCard ev={m.calendar} attachments={m.attachments} messageId={m.id} mine={m.mine} />}
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
  :root{color-scheme:light;scrollbar-width:thin;scrollbar-color:#cdd3dc transparent}
  ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#cdd3dc;border-radius:10px;border:3px solid #fff}::-webkit-scrollbar-thumb:hover{background:#aab2be}
  html,body{margin:0;padding:0;background:#fff;color:#1f1f1f}
  html{overflow-y:hidden}body{overflow-x:auto}
  body{font:14px/1.5 Arial,Helvetica,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:2px 0 4px}
  img{max-width:100%!important;height:auto}
  table{max-width:100%}
  a{color:#0b57d0}
  blockquote{margin:0 0 0 .6em;padding-left:.9em;border-left:2px solid #cfd6d2;color:#6b7571}
  pre{white-space:pre-wrap}
`;
/**
 * An email's HTML in a sandboxed frame, always shown at its full height (never a box that scrolls).
 * The frame may not run scripts at all (no allow-scripts, and its CSP says script-src 'none'),
 * so it is safe to let it share our origin: that only lets the app read its size from outside.
 */
export function HtmlBody({ id, html, showImages }: { id: string; html: string; showImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const doc = useMemo(() => {
    let body = html;
    if (showImages) body = body.replace(/\ssrc=""/g, '').replace(/data-remote-src=/g, 'src=');
    const csp = `default-src 'none'; img-src data: blob: ${showImages ? 'https: http:' : ''} ${location.origin === 'null' ? '' : location.origin}; style-src 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'none'; form-action 'none'`;
    return `<!doctype html><html data-id="${id}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${body}</body></html>`;
  }, [html, id, showImages]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    let timers: number[] = [];
    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.body) return;
      // The body's own height, not the document's: that one never shrinks below the frame.
      const h = Math.ceil(Math.max(d.body.scrollHeight, d.body.getBoundingClientRect().height));
      setHeight(Math.min(Math.max(h, 24), 30000));
    };
    const attach = () => {
      const d = frame.contentDocument;
      if (!d?.body) return;
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      ro.observe(d.body);
      // Images and web fonts can change the size after load.
      for (const img of Array.from(d.images)) if (!img.complete) img.addEventListener('load', measure, { once: true });
      timers = [150, 600, 1500].map((t) => window.setTimeout(measure, t));
    };
    frame.addEventListener('load', attach);
    if (frame.contentDocument?.readyState === 'complete') attach();
    return () => {
      frame.removeEventListener('load', attach);
      ro?.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      className="html-frame"
      title="Message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={{ height }}
    />
  );
}


/** Invitation card for a text/calendar part, with a one-click add to Google Calendar. */
function EventCard({ ev, attachments, messageId, mine }: { ev: NonNullable<Message['calendar']>; attachments: Attachment[]; messageId: string; mine: boolean }) {
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
        {ev.method === 'REQUEST' && !mine && <InviteActions messageId={messageId} organizer={ev.organizer?.email} />}
        <div className="row-inline" style={{ marginTop: 6 }}>
          {ev.googleLink && !cancelled && <a className="btn btn-primary btn-sm" href={ev.googleLink} target="_blank" rel="noopener"><Icon name="plus" size={14} />Add to Google Calendar</a>}
          {ics && <a className="btn btn-ghost btn-sm" href={ics.url} download={ics.filename}><Icon name="download" size={14} />.ics file</a>}
        </div>
      </div>
    </div>
  );
}

/** Gmail's " (2 days ago)" after the full date. */
function agoText(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 1) return ' (now)';
  if (mins < 60) return ` (${mins} minute${mins === 1 ? '' : 's'} ago)`;
  const h = Math.round(mins / 60);
  if (h < 24) return ` (${h} hour${h === 1 ? '' : 's'} ago)`;
  const d = Math.round(h / 24);
  if (d < 31) return ` (${d} day${d === 1 ? '' : 's'} ago)`;
  return '';
}
