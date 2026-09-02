import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import type { AppToast } from '../../services/toast/types';
import { useSwipeDismiss } from './useSwipeDismiss';
import styles from './ToastStackModern.module.css';

export interface ToastCardProps {
  toast: AppToast;
  index: number;
  frontmostHeight: number;
  offsetY: number;
  isExpanded: boolean;
  onHeightMeasure: (el: HTMLElement | null) => void;
  onDismiss: () => void;
}

export const ToastCard: React.FC<ToastCardProps> = ({
  toast,
  index,
  frontmostHeight,
  offsetY,
  isExpanded,
  onHeightMeasure,
  onDismiss,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [swipedOut, setSwipedOut] = useState(false);
  const remainingTimeRef = useRef<number>(toast.duration ?? 5000);
  const startTimeRef = useRef<number | null>(null);

  const handleDismissAnimation = useCallback(() => {
    setExiting(true);
    const timer = setTimeout(() => {
      onDismiss();
    }, 260);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const handleSwipeDismiss = useCallback(() => {
    setSwipedOut(true);
    setTimeout(() => {
      onDismiss();
    }, 260);
  }, [onDismiss]);

  const { onPointerDown, onPointerMove, onPointerUp, movement, swiping } =
    useSwipeDismiss({
      onDismiss: handleSwipeDismiss,
      allowedAxes: ['down', 'right'],
      threshold: 60,
    });

  // 当 duration 或 updateKey 变更时重置总倒计时
  useEffect(() => {
    remainingTimeRef.current = toast.duration ?? 5000;
  }, [toast.duration, toast.updateKey]);

  // 毫秒级倒计时（支持悬停展开暂停与恢复）
  useEffect(() => {
    if (!toast.duration || toast.duration === Infinity) return;

    if (isExpanded) {
      if (startTimeRef.current !== null) {
        const elapsed = performance.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(
          0,
          remainingTimeRef.current - elapsed
        );
        startTimeRef.current = null;
      }
      return;
    }

    startTimeRef.current = performance.now();
    const timer = setTimeout(() => {
      handleDismissAnimation();
    }, remainingTimeRef.current);

    return () => {
      clearTimeout(timer);
      if (startTimeRef.current !== null) {
        const elapsed = performance.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(
          0,
          remainingTimeRef.current - elapsed
        );
        startTimeRef.current = null;
      }
    };
  }, [toast.duration, toast.updateKey, isExpanded, handleDismissAnimation]);

  const setNodeRef = useCallback(
    (el: HTMLDivElement | null) => {
      cardRef.current = el;
      onHeightMeasure(el);
    },
    [onHeightMeasure]
  );

  const styleVariables: React.CSSProperties = {
    ['--toast-index' as string]: index,
    ['--toast-frontmost-height' as string]: `${frontmostHeight}px`,
    ['--toast-height' as string]: cardRef.current
      ? `${cardRef.current.scrollHeight || cardRef.current.offsetHeight}px`
      : 'auto',
    ['--toast-offset-y' as string]: `${offsetY}px`,
    ['--toast-swipe-movement-x' as string]: `${movement.x}px`,
    ['--toast-swipe-movement-y' as string]: `${movement.y}px`,
  };

  const getIcon = () => {
    if (toast.icon) return toast.icon;
    switch (toast.type) {
      case 'success':
        return (
          <Lucide.CheckCircle2
            size={16}
            strokeWidth={2}
            style={{ color: 'var(--text-success-strong, #059669)' }}
            aria-hidden="true"
          />
        );
      case 'error':
        return (
          <Lucide.AlertCircle
            size={16}
            strokeWidth={2}
            style={{ color: 'var(--text-danger, #dc2626)' }}
            aria-hidden="true"
          />
        );
      case 'warning':
        return (
          <Lucide.AlertTriangle
            size={16}
            strokeWidth={2}
            style={{ color: 'var(--text-warning-strong, #c2410c)' }}
            aria-hidden="true"
          />
        );
      case 'loading':
        return (
          <Lucide.Loader2
            size={16}
            strokeWidth={2}
            className="animate-spin"
            style={{ color: 'var(--brand, #10b981)' }}
            aria-hidden="true"
          />
        );
      default:
        return (
          <Lucide.Info
            size={16}
            strokeWidth={2}
            style={{ color: 'var(--text-secondary, #555555)' }}
            aria-hidden="true"
          />
        );
    }
  };

  const stateAttr = swipedOut
    ? 'swiping-dismiss'
    : exiting
    ? 'exiting'
    : swiping
    ? 'swiping'
    : 'idle';

  return (
    <div
      ref={setNodeRef}
      role="status"
      data-toast-id={toast.id}
      data-type={toast.type}
      data-toast-type={toast.type}
      data-state={stateAttr}
      aria-live={
        toast.ariaLive ?? (toast.type === 'error' ? 'assertive' : 'polite')
      }
      style={styleVariables}
      className={styles.toastCard}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className={styles.cardBody}>
        <span className={styles.iconWrapper}>{getIcon()}</span>
        <div className={styles.contentWrapper}>
          {toast.title && <div className={styles.title}>{toast.title}</div>}
          <div className={styles.message}>{toast.message}</div>
          {toast.description && (
            <div className={styles.description}>{toast.description}</div>
          )}
        </div>

        <div className={styles.actionsRow}>
          {toast.onUndo && (
            <button
              type="button"
              className={styles.undoButton}
              onClick={(e) => {
                e.stopPropagation();
                toast.onUndo?.();
                handleDismissAnimation();
              }}
            >
              撤销
            </button>
          )}

          {toast.action && (
            <button
              type="button"
              data-variant={toast.action.variant ?? 'primary'}
              className={styles.actionButton}
              onClick={(e) => {
                e.stopPropagation();
                toast.action?.onClick(e);
              }}
            >
              {toast.action.label}
            </button>
          )}

          <button
            type="button"
            aria-label="关闭通知"
            className={styles.closeButton}
            onClick={(e) => {
              e.stopPropagation();
              handleDismissAnimation();
            }}
          >
            <Lucide.X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      {toast.duration && toast.duration !== Infinity && (
        <div className={styles.progressTrack}>
          <div
            key={toast.updateKey ?? toast.timestamp}
            className={styles.progressBar}
            style={{ animationDuration: `${toast.duration}ms` }}
          />
        </div>
      )}
    </div>
  );
};
