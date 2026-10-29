import { useRef, useState, type PointerEvent } from 'react';
import type { Account, ThreadAction, ThreadSummary } from '../api/types';
import { Icon } from '../icons';
import { displayName, formatListDate, participantsLabel } from '../util/format';
import { Avatar } from './Avatar';

type Props = {
  thread: ThreadSummary;
  account?: Account;
  myEmails: Set<string>;
  selected: boolean;
  focused: boolean;
  highlight?: string;
  compact?: boolean;
  previewLines?: 0 | 1 | 2;
  showAvatar?: boolean;
  showAccount: boolean;
  accountLabel: string;
  onOpen: () => void;
  onSwipe: (dir: 'left' | 'right') => void;
  onAction: (a: ThreadAction) => void;
  onPrefetch: () => void;
};

const THRESHOLD = 88;

export function ThreadRow({ thread: t, account, myEmails, selected, focused, highlight, compact, previewLines = 1, showAvatar = true, showAccount, accountLabel, onOpen, onSwipe, onAction, onPrefetch }: Props) {
  const [dx, setDx] = useState(0);
  const [dir, setDir] = useState<'left' | 'right' | null>(null);
  const start = useRef<{ x: number; y: number; active: boolean; id: number } | null>(null);
  const suppress = useRef(0);

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, y: e.clientY, active: false, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const ddx = e.clientX - s.x;
    const ddy = e.clientY - s.y;
    if (!s.active) {
      if (Math.abs(ddx) > 12 && Math.abs(ddx) > Math.abs(ddy) * 1.3) {
        s.active = true;
        (e.currentTarget as HTMLElement).setPointerCapture(s.id);
      } else {
        if (Math.abs(ddy) > 12) start.current = null;
        return;
      }
    }
    setDx(ddx);
    setDir(ddx > 0 ? 'right' : 'left');
  };
  const end = () => {
    const s = start.current;
    start.current = null;
    if (!s?.active) return;
    suppress.current = Date.now() + 350;
    if (Math.abs(dx) > THRESHOLD) {
      const d = dx > 0 ? 'right' : 'left';
      if (d === 'left') {
        setDx(-window.innerWidth);
        window.setTimeout(() => {
          onSwipe(d);
          setDx(0);
          setDir(null);
        }, 160);
        return;
      }
      onSwipe(d);
    }
    setDx(0);
    setDir(null);
  };

  const who = t.folderRoles.includes('sent') && !t.folderRoles.includes('inbox') && t.participants.length
    ? `To: ${participantsLabel(t.participants, myEmails)}`
    : t.count > 1
      ? participantsLabel(t.participants, myEmails)
      : displayName(t.lastFrom);
  const avatarSource = t.participants.find((p) => !myEmails.has(p.email.toLowerCase())) ?? t.lastFrom;
  const armed = Math.abs(dx) > THRESHOLD;

  return (
    <div className="row-wrap" role="listitem">
      {dir && (
        <div className={`swipe-bg ${dir}`} aria-hidden="true">
          <span style={{ transform: armed ? 'scale(1.08)' : undefined }}>
            {dir === 'right' ? (
              <>
                <Icon name="pin" size={18} />
                {t.pinned ? 'Unpin' : 'Pin'}
              </>
            ) : (
              <>
                Archive
                <Icon name="archive" size={18} />
              </>
            )}
          </span>
        </div>
      )}
      <div
        className={`row${t.unread ? ' unread' : ''}${selected ? ' sel' : ''}${focused ? ' focus' : ''}${start.current?.active ? ' swiping' : ''}${showAvatar ? '' : ' no-avatar'}`}
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onClick={() => {
          if (Date.now() < suppress.current) return;
          onOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <Avatar who={avatarSource} color={account?.color} small={compact} />
        <div className="row-main">
          <div className="row-top">
            {t.unread && <i className="udot" title="Unread" />}
            <span className="who">{who}</span>
            {t.count > 1 && <span className="cnt">{t.count}</span>}
            <span className="when">{formatListDate(t.lastDate)}</span>
          </div>
          <div className="subj">{t.subject || '(no subject)'}</div>
          {highlight ? (
            <div className="snip" dangerouslySetInnerHTML={{ __html: highlight }} />
          ) : previewLines > 0 ? (
            <div className={`snip${previewLines === 2 ? ' lines-2' : ''}`}>{t.snippet}</div>
          ) : null}
          {!compact && (
            <div className="row-meta">
              {showAccount && account && (
                <span className="tag">
                  <i className="dot" style={{ ['--c' as string]: account.color }} />
                  {accountLabel}
                </span>
              )}
              {t.hasAttachments && (
                <span className="tag" title="Has attachments">
                  <Icon name="clip" size={13} />
                </span>
              )}
              {t.pinned && (
                <span className="tag pin">
                  <Icon name="pin" size={13} />
                  Pinned
                </span>
              )}
              {t.answered && (
                <span className="tag" title="You replied">
                  <Icon name="reply" size={13} />
                </span>
              )}
              {t.draft && <span className="tag draft">Draft</span>}
            </div>
          )}
        </div>
        {!compact && (
          <div className="row-hover" onClick={(e) => e.stopPropagation()}>
            <button className={`ib${t.pinned ? ' on' : ''}`} aria-label={t.pinned ? 'Unpin' : 'Pin'} title={t.pinned ? 'Unpin' : 'Pin'} onClick={() => onAction(t.pinned ? 'unpin' : 'pin')}>
              <Icon name="pin" size={16} />
            </button>
            <button className="ib" aria-label="Archive" title="Archive (e)" onClick={() => onAction('archive')}>
              <Icon name="archive" size={16} />
            </button>
            <button className="ib danger" aria-label="Delete" title="Delete (#)" onClick={() => onAction('trash')}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
