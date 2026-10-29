import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAccountMap, useFolders, useThreadActions } from '../api/hooks';
import { Icon } from '../icons';
import { useNav } from '../nav';
import { useUI } from '../store';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
}

export function BlockConfirm() {
  const pb = useUI((s) => s.pendingBlock)!;
  const setPB = useUI((s) => s.setPendingBlock);
  const toast = useUI((s) => s.toast);
  const qc = useQueryClient();
  const nav = useNav();
  const [scope, setScope] = useState<'address' | 'domain'>('address');
  const [busy, setBusy] = useState(false);
  const domain = `@${pb.email.split('@')[1] ?? ''}`;
  const close = () => setPB(null);
  useEscape(close);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['blocked'] });
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
  };

  const block = async () => {
    setBusy(true);
    const pattern = scope === 'domain' ? domain : pb.email;
    try {
      const entry = await api.blocked.add(pattern, pb.name);
      invalidate();
      if (nav.threadId === pb.threadId) nav.closeThread();
      toast({
        text: `Blocked ${pattern}`,
        undo: async () => {
          await api.blocked.restore(entry.id).catch(() => undefined);
          await api.blocked.remove(entry.id);
          invalidate();
        },
      });
      close();
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet small" role="dialog" aria-modal="true" aria-labelledby="block-title">
        <h2 id="block-title">Block {pb.name || pb.email}?</h2>
        <p>
          Their mail will skip your inbox and land in the Blocked folder on every device, even when Postino is closed. You can unblock them any time from Blocked senders.
        </p>
        <div className="folder-list" role="radiogroup" aria-label="What to block">
          <button className={`sug${scope === 'address' ? ' on' : ''}`} role="radio" aria-checked={scope === 'address'} onClick={() => setScope('address')}>
            <Icon name={scope === 'address' ? 'check' : 'mail'} size={16} />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span>Only this address</span>
              <small>{pb.email}</small>
            </span>
          </button>
          <button className={`sug${scope === 'domain' ? ' on' : ''}`} role="radio" aria-checked={scope === 'domain'} onClick={() => setScope('domain')}>
            <Icon name={scope === 'domain' ? 'check' : 'block'} size={16} />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span>Everyone at {domain}</span>
              <small>Use this for agencies that write from many addresses</small>
            </span>
          </button>
        </div>
        <div className="sheet-actions">
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn btn-danger" onClick={() => void block()} disabled={busy} autoFocus>
            {busy ? 'Blocking' : 'Block sender'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MovePicker({ view }: { view: string }) {
  const mt = useUI((s) => s.moveTarget)!;
  const setMT = useUI((s) => s.setMoveTarget);
  const { data: folders } = useFolders();
  const accountMap = useAccountMap();
  const act = useThreadActions();
  const nav = useNav();
  const close = () => setMT(null);
  useEscape(close);
  const list = (folders ?? []).filter((f) => f.accountId === mt.accountId && f.role !== 'drafts');
  const account = accountMap.get(mt.accountId);
  const label = (role: string, name: string) => ({ inbox: 'Inbox', sent: 'Sent', archive: 'Archive', junk: name.toLowerCase().includes('spam') ? name : 'Spam', trash: 'Trash', blocked: 'Blocked' })[role] ?? name;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet small" role="dialog" aria-modal="true" aria-labelledby="move-title">
        <h2 id="move-title">Move to</h2>
        <p>Folders in {account?.email}</p>
        <div className="folder-list">
          {list.map((f) => (
            <button
              key={f.id}
              className="sug"
              onClick={() => {
                void act({ threadIds: mt.threadIds, action: 'move', folderId: f.id, view });
                if (nav.threadId && mt.threadIds.includes(nav.threadId)) nav.closeThread();
                close();
              }}
            >
              <Icon name={f.role === 'inbox' ? 'inbox' : f.role === 'archive' ? 'archive' : f.role === 'junk' ? 'spam' : f.role === 'trash' ? 'trash' : f.role === 'sent' ? 'send' : f.role === 'blocked' ? 'block' : 'folder'} size={16} />
              <span>{label(f.role, f.name)}</span>
              {f.role === 'other' && <small>{f.path}</small>}
            </button>
          ))}
        </div>
        <div className="sheet-actions">
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous conversation'],
  ['Enter', 'Open the highlighted conversation'],
  ['e', 'Archive'],
  ['#', 'Delete'],
  ['p', 'Pin or unpin'],
  ['u', 'Mark as unread and go back'],
  ['r', 'Reply'],
  ['a', 'Reply all'],
  ['f', 'Forward'],
  ['c', 'New email'],
  ['/', 'Search'],
  ['Esc', 'Back, close, or clear'],
  ['⌘ Enter', 'Send'],
  ['?', 'This list'],
];

export function ShortcutsSheet() {
  const setOpen = useUI((s) => s.setShortcuts);
  const close = () => setOpen(false);
  useEscape(close);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet small" role="dialog" aria-modal="true" aria-labelledby="keys-title" style={{ width: 'min(480px, 100%)' }}>
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', alignItems: 'center' }}>
          {SHORTCUTS.map(([k, d]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="kbd">{k}</span>
              <span>{d}</span>
            </span>
          ))}
        </div>
        <div className="sheet-actions">
          <button className="btn btn-ghost" onClick={close} autoFocus>Close</button>
        </div>
      </div>
    </div>
  );
}
