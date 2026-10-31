import { create } from 'zustand';
import type { Draft, ThreadAction, Attachment } from './api/types';

export type Toast = {
  id: number;
  text: string;
  kind?: 'info' | 'error' | 'success';
  undo?: () => void | Promise<void>;
  ttl?: number;
};

export type ComposeState =
  | null
  | {
      mode: 'new' | 'reply' | 'replyAll' | 'forward';
      accountId?: string;
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      text?: string;
      quotedText?: string;
      fromAddress?: string;
      quotedHtml?: string;
      inReplyTo?: string;
      forwardOf?: string;
      threadId?: string;
      draft?: Draft;
      /** An IMAP draft (saved by another app) being edited: deleted from the server once sent. */
      imapDraftId?: string;
      /** Reply box sits inline under the thread instead of a modal */
      inline?: boolean;
    };

type UIState = {
  smart: boolean;
  setSmart: (v: boolean) => void;
  drawerOpen: boolean;
  setDrawer: (v: boolean) => void;
  selectedId: string | null;
  setSelected: (id: string | null) => void;
  /** ordered thread ids as currently rendered, for j/k */
  order: string[];
  setOrder: (ids: string[]) => void;
  bundlesOpen: Record<string, boolean>;
  toggleBundle: (k: string) => void;
  compose: ComposeState;
  /** Bumped on every openCompose so the composer remounts with the new content. */
  composeSeq: number;
  openCompose: (c: NonNullable<ComposeState>) => void;
  closeCompose: () => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  /** An inline reply box is open (so an app update must not reload the page). */
  replyOpen: boolean;
  setReplyOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcuts: (v: boolean) => void;
  viewer: { attachments: Attachment[]; index: number } | null;
  openViewer: (attachments: Attachment[], index: number) => void;
  closeViewer: () => void;
  setViewerIndex: (i: number) => void;
  pendingBlock: { email: string; name: string; threadId: string } | null;
  setPendingBlock: (v: UIState['pendingBlock']) => void;
  moveTarget: { threadIds: string[]; accountId: string } | null;
  setMoveTarget: (v: UIState['moveTarget']) => void;
  lastAction: { action: ThreadAction; threadIds: string[] } | null;
};

let toastSeq = 0;

export const useUI = create<UIState>((set, get) => ({
  smart: (() => {
    try {
      return localStorage.getItem('postino.smart') === '1';
    } catch {
      return true;
    }
  })(),
  setSmart: (v) => {
    try {
      localStorage.setItem('postino.smart', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ smart: v });
  },
  drawerOpen: false,
  setDrawer: (v) => set({ drawerOpen: v }),
  selectedId: null,
  setSelected: (id) => set({ selectedId: id }),
  order: [],
  setOrder: (ids) => {
    const prev = get().order;
    if (prev.length === ids.length && prev.every((x, i) => x === ids[i])) return;
    set({ order: ids });
  },
  bundlesOpen: {},
  toggleBundle: (k) => set((s) => ({ bundlesOpen: { ...s.bundlesOpen, [k]: !s.bundlesOpen[k] } })),
  compose: null,
  composeSeq: 0,
  replyOpen: false,
  setReplyOpen: (v) => set({ replyOpen: v }),
  openCompose: (c) => set((s) => ({ compose: c, composeSeq: s.composeSeq + 1 })),
  closeCompose: () => set({ compose: null }),
  toasts: [],
  toast: (t) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }));
    const ttl = t.ttl ?? (t.undo ? 6000 : 3500);
    window.setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  shortcutsOpen: false,
  setShortcuts: (v) => set({ shortcutsOpen: v }),
  pendingBlock: null,
  viewer: null,
  openViewer: (attachments, index) => set({ viewer: { attachments, index } }),
  closeViewer: () => set({ viewer: null }),
  setViewerIndex: (index) => set((s) => (s.viewer ? { viewer: { ...s.viewer, index } } : {})),
  setPendingBlock: (v) => set({ pendingBlock: v }),
  moveTarget: null,
  setMoveTarget: (v) => set({ moveTarget: v }),
  lastAction: null,
}));
