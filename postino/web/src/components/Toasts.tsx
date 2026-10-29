import { useUI } from '../store';
import { Icon } from '../icons';

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`}>
          <span>{t.text}</span>
          {t.undo && (
            <button
              onClick={() => {
                dismiss(t.id);
                void t.undo?.();
              }}
            >
              Undo
            </button>
          )}
          <button className="ib" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
