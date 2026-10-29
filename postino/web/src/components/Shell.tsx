import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '../api/types';
import { useThreadActions } from '../api/hooks';
import { Icon } from '../icons';
import { useNav } from '../nav';
import { useUI } from '../store';
import { Sidebar } from './Sidebar';
import { ThreadList } from './ThreadList';
import { Reader } from './Reader';
import { Compose } from './Compose';
import { BlockConfirm, MovePicker, ShortcutsSheet } from './Sheets';
import { SettingsPage } from './Settings';

export function Shell({ me, forcedView, onLogout }: { me?: Me; forcedView?: string; onLogout: () => void }) {
  const nav = useNav();
  const navigate = useNavigate();
  const ui = useUI();
  const act = useThreadActions();
  const view = forcedView ?? nav.view;

  // Global keyboard shortcuts (Spark-like, Gmail-compatible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (ui.shortcutsOpen) return ui.setShortcuts(false);
        if (ui.pendingBlock) return ui.setPendingBlock(null);
        if (ui.moveTarget) return ui.setMoveTarget(null);
        if (ui.compose && !ui.compose.inline) return; // compose handles its own Esc
        if (ui.drawerOpen) return ui.setDrawer(false);
        if (typing) return (target as HTMLElement).blur();
        if (nav.threadId) return nav.closeThread();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (ui.compose && !ui.compose.inline) return;
      const sel = nav.threadId;
      const order = ui.order;
      switch (e.key) {
        case 'j':
        case 'k': {
          if (!order.length) return;
          e.preventDefault();
          const i = order.indexOf(sel ?? '');
          const next = i < 0 ? order[0] : order[Math.min(Math.max(i + (e.key === 'j' ? 1 : -1), 0), order.length - 1)];
          if (next && next !== sel) nav.openThread(next);
          return;
        }
        case 'Enter':
          if (ui.selectedId && !sel) nav.openThread(ui.selectedId);
          return;
        case 'e':
          if (sel) void act({ threadIds: [sel], action: 'archive', view });
          return;
        case '#':
          if (sel) void act({ threadIds: [sel], action: 'trash', view });
          return;
        case 'p':
          if (sel) void act({ threadIds: [sel], action: 'pin', view });
          return;
        case 'u':
          if (sel) {
            void act({ threadIds: [sel], action: 'unread', view });
            nav.closeThread();
          }
          return;
        case 'c':
          e.preventDefault();
          ui.openCompose({ mode: 'new', accountId: nav.accountId ?? undefined });
          return;
        case '/':
          e.preventDefault();
          document.getElementById('search-input')?.focus();
          return;
        case '?':
          ui.setShortcuts(true);
          return;
        case 'r':
        case 'a':
        case 'f':
          if (sel) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('postino:reply', { detail: e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward' }));
          }
          return;
        case 'g':
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, nav, ui, view, navigate]);

  const phoneView = nav.threadId ? 'reader' : 'list';

  return (
    <div className="shell" data-view={phoneView} data-drawer={ui.drawerOpen ? 'open' : 'closed'}>
      <Sidebar />
      <div className="drawer-scrim" onClick={() => ui.setDrawer(false)} />
      {nav.isSettings ? (
        <SettingsPage me={me} onLogout={onLogout} />
      ) : (
        <>
          <ThreadList view={view} />
          <Reader view={view} />
        </>
      )}
      {!nav.isSettings && (
        <button className="fab" onClick={() => ui.openCompose({ mode: 'new', accountId: nav.accountId ?? undefined })} aria-label="New email">
          <Icon name="pen" size={18} />
          New email
        </button>
      )}
      {ui.compose && !ui.compose.inline && <Compose />}
      {ui.pendingBlock && <BlockConfirm />}
      {ui.moveTarget && <MovePicker view={view} />}
      {ui.shortcutsOpen && <ShortcutsSheet />}
    </div>
  );
}
