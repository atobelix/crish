import React from 'react';
import type { ToastItem } from '../hooks/useToastQueue';

type Props = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
};

/** Bottom-stacked toast notifications (Chinese UI). */
export const ToastStack: React.FC<Props> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast-alert">
          <span>{toast.message}</span>
          {toast.onUndo ? (
            <button
              type="button"
              className="toast-undo-btn"
              onClick={() => {
                toast.onUndo?.();
                onDismiss(toast.id);
              }}
            >
              撤销
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};
