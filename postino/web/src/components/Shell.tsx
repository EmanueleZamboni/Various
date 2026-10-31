import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '../api/types';
import { useThreadActions } from '../api/hooks';
import { Icon } from '../icons';
import { useNav } from '../nav';
import { useUI } from '../store';
import { useSettings } from '../api/hooks';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { TasksPanel } from './GoogleApps';
import { ThreadList } from './ThreadList';
import { Reader } from './Reader';
import { Compose } from './Compose';
import { BlockConfirm, MovePicker, ShortcutsSheet } from './Sheets';
import { AttachmentViewer } from './AttachmentViewer';
import { SettingsPage } from './Settings';

export function Shell({ me, forcedView, onLogout }: { me?: Me; forcedView?: string; onLogout: () => void }) {
  const nav = useNav();
  const navigate = useNavigate();
  const ui = useUI();
  const { data: settings } = useSettings();
  // The Smart/All choice is stored on the server so every device agrees.
  useEffect(() => {
    if (settings && settings.inbox.smart !== ui.smart) ui.setSmart(settings.inbox.smart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.inbox.smart]);
  const afterKeyAction = (id: string) => {
    const pref = settings?.reading.afterAction ?? 'next';
    const order = ui.order;
    const i = order.indexOf(id);
    const next = pref === 'next' ? order[i + 1] ?? order[i - 1] : pref === 'previous' ? order[i - 1] ?? order[i + 1] : undefined;
    if (next && pref !== 'list' && !window.matchMedia('(max-width: 760px)').matches) nav.openThread(next);
    else nav.closeThread();
  };
  const act = useThreadActions();
  const view = forcedView ?? nav.view;

  // Global keyboard shortcuts (Spark-like, Gmail-compatible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
      if (ui.viewer) return; // the attachment viewer owns the keyboard while open
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
          if (sel) {
            void act({ threadIds: [sel], action: 'archive', view });
            afterKeyAction(sel);
          }
          return;
        case '#':
          if (sel) {
            void act({ threadIds: [sel], action: 'trash', view });
            afterKeyAction(sel);
          }
          return;
        case 'p':
        case 's':
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

  const online = useOnline();
  const sideBySide = (settings?.appearance.readingPane ?? 'full') === 'side';
  const [listW, setListW] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('postino.listW')) || 400;
    } catch {
      return 400;
    }
  });
  const [resizing, setResizing] = useState(false);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const card = (e.currentTarget as HTMLElement).parentElement!;
    setResizing(true);
    let last = listW;
    const move = (ev: PointerEvent) => {
      const box = card.getBoundingClientRect();
      last = Math.round(Math.min(Math.max(ev.clientX - box.left, 280), Math.min(900, box.width - 360)));
      setListW(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      try {
        localStorage.setItem('postino.listW', String(last));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [mini, setMiniState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('postino.navMini') === '1';
    } catch {
      return false;
    }
  });
  // Gmail's menu button: folds the sidebar to icons on a computer, opens the drawer on smaller screens.
  const onMenu = () => {
    if (window.matchMedia('(max-width: 1100px)').matches) return ui.setDrawer(true);
    setMiniState((v) => {
      try {
        localStorage.setItem('postino.navMini', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };
  return (
    <div className={`shell${resizing ? ' resizing' : ''}`} data-mini={mini ? 'on' : 'off'} data-tasks={ui.tasksOpen ? 'open' : 'closed'} style={sideBySide ? ({ ['--list-w' as string]: `${listW}px` } as React.CSSProperties) : undefined} data-view={phoneView} data-reading={settings?.appearance.readingPane ?? 'full'} data-open={nav.threadId ? 'thread' : 'list'} data-drawer={ui.drawerOpen ? 'open' : 'closed'} data-density={settings?.appearance.density ?? 'comfortable'} data-text={settings?.appearance.textSize ?? 'normal'}>
      {!online && (
        <div className="offline-bar" role="status">
          <Icon name="alert" size={16} />
          You're offline. Showing the last synced mail; changes will fail until the connection is back.
        </div>
      )}
      <TopBar me={me} onMenu={onMenu} onLogout={onLogout} />
      <Sidebar />
      <div className="drawer-scrim" onClick={() => ui.setDrawer(false)} />
      <main className="main-card">
        {nav.isSettings ? (
          <SettingsPage me={me} onLogout={onLogout} />
        ) : (
          <>
            <ThreadList view={view} />
            {sideBySide && (
              <div className={`pane-resizer${resizing ? ' dragging' : ''}`} role="separator" aria-orientation="vertical" aria-label="Resize the list" title="Drag to resize" onPointerDown={startResize} onDoubleClick={() => { setListW(400); try { localStorage.removeItem('postino.listW'); } catch { /* ignore */ } }} />
            )}
            <Reader view={view} />
          </>
        )}
      </main>
      {!nav.isSettings && (
        <button className="fab" onClick={() => ui.openCompose({ mode: 'new', accountId: nav.accountId ?? undefined })} aria-label="Compose">
          <Icon name="pen" size={24} />
          <span>Compose</span>
        </button>
      )}
      {ui.tasksOpen && <TasksPanel onClose={() => ui.setTasksOpen(false)} />}
      {ui.compose && !ui.compose.inline && <Compose key={ui.composeSeq} />}
      {ui.pendingBlock && <BlockConfirm />}
      {ui.moveTarget && <MovePicker view={view} />}
      {ui.shortcutsOpen && <ShortcutsSheet />}
      <AttachmentViewer />
    </div>
  );
}

/** Browser connectivity, so the shell can say why nothing refreshes. */
function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
