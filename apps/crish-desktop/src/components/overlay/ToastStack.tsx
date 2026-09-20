import { useState, useCallback } from 'react';
import type { AppToast } from '../../hooks/useToastQueue';
import styles from './ToastStack.module.css';
import { Button } from '../ui';
import { AppIcon } from '../ui/icons/index';

type Props = {
  toasts: AppToast[];
  onDismiss: (id: string) => void;
};

/** 底栏堆叠通知。关闭是发丝图标，不用 ghost sm 灰块。 */
export const ToastStack = ({ toasts, onDismiss }: Props) => {
  const [exitingToasts, setExitingToasts] = useState<Map<string, AppToast>>(
    new Map()
  );

  const handleDismiss = useCallback(
    (toast: AppToast) => {
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
    },
    [onDismiss]
  );

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
          data-toast-type={toast.type}
          aria-live={toast.ariaLive ?? 'polite'}
          className={`${styles.toastAlert}${exitingToasts.has(toast.id) ? ` ${styles.toastAlertExiting}` : ''}`}
        >
          <span className={styles.toastMessage}>{toast.message}</span>
          {toast.onUndo ? (
            <Button
              bare
              type="button"
              className={styles.toastUndoBtn}
              onClick={() => {
                toast.onUndo?.();
                handleDismiss(toast);
              }}
            >
              撤销
            </Button>
          ) : null}
          <Button
            bare
            type="button"
            className={styles.toastDismissBtn}
            aria-label="关闭通知"
            onClick={() => handleDismiss(toast)}
          >
            <AppIcon name="x" size={12} aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  );
};
