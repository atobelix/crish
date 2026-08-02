import { useState, useCallback } from 'react';
import type { AppToast } from '../../services/ToastBus';
import styles from './ToastStack.module.css';

type Props = {
  toasts: AppToast[];
  onDismiss: (id: string) => void;
};

/** Bottom-stacked toast notifications (Chinese UI). */
export const ToastStack = ({ toasts, onDismiss }: Props) => {
  const [exitingToasts, setExitingToasts] = useState<Map<string, AppToast>>(new Map());

  const handleDismiss = useCallback((toast: AppToast) => {
    setExitingToasts((prev) => {
      const next = new Map(prev);
      next.set(toast.id, toast);
      return next;
    });
    setTimeout(() => {
      setExitingToasts((prev) => {
        const next = new Map(prev);
        next.delete(toast.id);
        return next;
      });
      onDismiss(toast.id);
    }, 250);
  }, [onDismiss]);

  const allToasts = toasts.slice();
  for (const [id, toast] of exitingToasts) {
    if (!allToasts.some((t) => t.id === id)) {
      allToasts.push(toast);
    }
  }

  if (allToasts.length === 0) return null;

  return (
    <div className={styles.toastStack}>
      {allToasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          aria-live={toast.ariaLive ?? 'polite'}
          className={`${styles.toastAlert}${exitingToasts.has(toast.id) ? ` ${styles.toastAlertExiting}` : ''}`}
        >
          <span>{toast.message}</span>
          {toast.onUndo ? (
            <button
              type="button"
              className={styles.toastUndoBtn}
              onClick={() => {
                toast.onUndo?.();
                handleDismiss(toast);
              }}
            >
              撤销
            </button>
          ) : null}
          <button
            type="button"
            className={styles.toastDismissBtn}
            aria-label="关闭通知"
            onClick={() => handleDismiss(toast)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
};
