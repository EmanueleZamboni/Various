import { useRef, type PointerEvent, type MouseEvent } from 'react';

/**
 * Long-press on touch screens and right-click with a mouse open the same menu, like the rows.
 * Moving the finger (scrolling) cancels the press; a long press swallows the click that follows.
 */
export function useLongPress(open: (x: number, y: number) => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(0);
  const start = useRef({ x: 0, y: 0 });
  const cancel = () => window.clearTimeout(timer.current);
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      cancel();
      timer.current = window.setTimeout(() => {
        fired.current = Date.now();
        navigator.vibrate?.(10);
        open(clientX, clientY);
      }, 500);
    },
    onPointerMove: (e: PointerEvent) => {
      if (Math.abs(e.clientX - start.current.x) > 8 || Math.abs(e.clientY - start.current.y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    },
    /** True right after a long press: ignore that click. */
    justFired: () => Date.now() - fired.current < 700,
  };
}
