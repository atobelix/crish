import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  m,
  AnimatePresence,
  useIsPresent,
  useReducedMotion,
} from 'motion/react';
import type { HTMLMotionProps, Transition } from 'motion/react';

import type { AppToast } from '../../services/toast/types';
import type { StackTarget } from './toastStackMath';
import { useSwipeDismissMotion } from './useSwipeDismissMotion';
import styles from './ToastStackModern.module.css';
import { Button } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

const standardEase = [0.2, 0, 0, 1] as [number, number, number, number];

export const morphTokens = {
  textIn: {
    opacity: 0,
    y: '0.3em',
    filter: 'blur(4px)',
  },
  textOut: {
    opacity: 0,
    y: '-0.3em',
    filter: 'blur(2px)',
    transition: { duration: 0.16, ease: standardEase },
  },
  iconIn: {
    opacity: 0,
    scale: 0.6,
    filter: 'blur(2px)',
  },
  shown: {
    opacity: 1,
    y: '0em',
    scale: 1,
    filter: 'blur(0px)',
  },
};

// 图标变身编排：Scale 走弹簧，Blur/Opacity 走补间（防负值过冲铁律）
export const iconSwapTransition: Transition = {
  type: 'spring',
  visualDuration: 0.26,
  bounce: 0,
  opacity: { duration: 0.16, ease: standardEase },
  filter: { duration: 0.16, ease: standardEase },
};

/**
 * Swap 组件：退场元素脱模并对读屏器隐藏，杜绝无障碍连读
 */
export function Swap(props: HTMLMotionProps<'span'>) {
  const isPresent = useIsPresent();
  return (
    <m.span {...props} aria-hidden={isPresent ? props['aria-hidden'] : true} />
  );
}

export interface ToastCardProps {
  toast: AppToast;
  index?: number;
  target?: StackTarget;
  expanded?: boolean;
  front?: boolean;
  frontmostHeight?: number;
  offsetY?: number;
  /** 悬停中：冻结倒计时（与是否扇形展开无关，单条通知同样生效） */
  isPaused?: boolean;
  onHeightMeasure?: (el: HTMLElement | null) => void;
  onDismiss: () => void;
}

export const ToastCard: React.FC<ToastCardProps> = ({
  toast,
  index = 0,
  target,
  expanded = false,
  front,
  frontmostHeight,
  offsetY,
  isPaused = false,
  onHeightMeasure,
  onDismiss,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [swipedOut, setSwipedOut] = useState(false);
  const remainingTimeRef = useRef<number>(toast.duration ?? 5000);
  const startTimeRef = useRef<number | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reduceMotion = Boolean(useReducedMotion());

  // 组件卸载时彻底清退残余退场定时器，杜绝内存泄漏与脱轨更新
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  const handleDismissAnimation = useCallback(() => {
    setExiting(true);
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
    }
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      onDismiss();
    }, 260);
  }, [onDismiss]);

  const handleSwipeDismiss = useCallback(() => {
    setSwipedOut(true);
    onDismiss();
  }, [onDismiss]);

  const {
    x,
    swipeFade,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useSwipeDismissMotion({
    id: toast.id,
    onDismiss: handleSwipeDismiss,
    reduceMotion,
  });

  // 当 duration 或 updateKey 变更时重置总倒计时
  useEffect(() => {
    remainingTimeRef.current = toast.duration ?? 5000;
  }, [toast.duration, toast.updateKey]);

  // 毫秒级倒计时（支持悬停暂停与恢复）
  useEffect(() => {
    if (!toast.duration || toast.duration === Infinity) return;

    if (isPaused) {
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
  }, [toast.duration, toast.updateKey, isPaused, handleDismissAnimation]);

  const setNodeRef = useCallback(
    (el: HTMLDivElement | null) => {
      cardRef.current = el;
      onHeightMeasure?.(el);
    },
    [onHeightMeasure]
  );

  const effectiveFrontmostHeight =
    frontmostHeight ?? (target ? target.height : 56);
  const effectiveOffsetY = offsetY ?? (target ? target.y : 0);
  const isFrontCard = front ?? index === 0;

  const styleVariables: React.CSSProperties = {
    ['--toast-index' as string]: index,
    ['--toast-frontmost-height' as string]: `${effectiveFrontmostHeight}px`,
    ['--toast-height' as string]: target
      ? `${target.height}px`
      : cardRef.current
        ? `${Math.min(cardRef.current.offsetHeight || 48, 84)}px`
        : 'auto',
    ['--toast-offset-y' as string]: `${effectiveOffsetY}px`,
    ['--toast-swipe-movement-x' as string]: '0px',
    ['--toast-swipe-movement-y' as string]: '0px',
    transformOrigin: target?.origin,
  };

  const getIcon = () => {
    if (toast.icon) return toast.icon;
    switch (toast.type) {
      case 'success':
        return (
          <AppIcon
            name="check-circle"
            size={18}
            style={{ color: 'var(--color-success, var(--brand-deep))' }}
            aria-hidden="true"
          />
        );
      case 'error':
        return (
          <AppIcon
            name="alert-circle"
            size={18}
            style={{ color: 'var(--color-error)' }}
            aria-hidden="true"
          />
        );
      case 'warning':
        return (
          <AppIcon
            name="alert-triangle"
            size={18}
            style={{ color: 'var(--color-warning)' }}
            aria-hidden="true"
          />
        );
      case 'loading':
        return (
          <AppIcon
            name="loader"
            size={18}
            className="animate-spin"
            style={{ color: 'var(--brand)' }}
            aria-hidden="true"
          />
        );
      default:
        return (
          <AppIcon
            name="info"
            size={18}
            style={{ color: 'var(--accent-color, var(--text-primary))' }}
            aria-hidden="true"
          />
        );
    }
  };

  const stateAttr = swipedOut
    ? 'swiping-dismiss'
    : exiting
      ? 'exiting'
      : 'idle';

  const textSwapMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: morphTokens.textIn,
        animate: morphTokens.shown,
        exit: morphTokens.textOut,
        transition: { duration: 0.16, ease: standardEase },
      };

  const iconSwapMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: morphTokens.iconIn,
        animate: morphTokens.shown,
        exit: {
          ...morphTokens.iconIn,
          transition: { duration: 0.16, ease: standardEase },
        },
        transition: iconSwapTransition,
      };

  const contentOpacity = target ? target.content : 1;

  return (
    <m.div
      ref={setNodeRef}
      role="status"
      data-toast-id={toast.id}
      data-type={toast.type}
      data-toast-type={toast.type}
      data-state={stateAttr}
      data-expanded={expanded}
      data-front={isFrontCard}
      aria-live={
        toast.ariaLive ?? (toast.type === 'error' ? 'assertive' : 'polite')
      }
      style={{
        ...styleVariables,
        x,
        opacity: swipeFade,
      }}
      className={styles.toastCard}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <div
        className={styles.cardBody}
        style={{
          opacity: contentOpacity,
        }}
      >
        <span className={styles.iconWrapper} aria-hidden="true">
          <AnimatePresence mode="popLayout" initial={false}>
            <Swap key={toast.type} className={styles.glyph} {...iconSwapMotion}>
              {getIcon()}
            </Swap>
          </AnimatePresence>
        </span>

        <div className={styles.contentWrapper}>
          {toast.title && (
            <div className={styles.title}>
              <AnimatePresence mode="popLayout" initial={false}>
                <Swap
                  key={
                    typeof toast.title === 'string' ||
                    typeof toast.title === 'number'
                      ? toast.title
                      : 'toast-title'
                  }
                  className={styles.line}
                  {...textSwapMotion}
                >
                  {toast.title}
                </Swap>
              </AnimatePresence>
            </div>
          )}
          <div className={styles.message}>
            <AnimatePresence mode="popLayout" initial={false}>
              <Swap
                key={
                  typeof toast.message === 'string' ||
                  typeof toast.message === 'number'
                    ? toast.message
                    : 'toast-msg'
                }
                className={styles.line}
                {...textSwapMotion}
              >
                {toast.message}
              </Swap>
            </AnimatePresence>
          </div>
          {toast.description && (
            <div className={styles.description}>
              <AnimatePresence mode="popLayout" initial={false}>
                <Swap
                  key={
                    typeof toast.description === 'string' ||
                    typeof toast.description === 'number'
                      ? toast.description
                      : 'toast-desc'
                  }
                  className={styles.line}
                  {...textSwapMotion}
                >
                  {toast.description}
                </Swap>
              </AnimatePresence>
            </div>
          )}
        </div>

        <div className={styles.actionsRow}>
          {toast.onUndo && (
            <Button
              type="button"
              variant="ghost"
              className={styles.undoButton}
              onClick={(e) => {
                e.stopPropagation();
                toast.onUndo?.();
                handleDismissAnimation();
              }}
            >
              撤销
            </Button>
          )}

          <AnimatePresence initial={false}>
            {toast.action ? (
              <m.div
                key="action"
                className={styles.actionSlot}
                initial={
                  reduceMotion ? { opacity: 0 } : { width: 0, opacity: 0 }
                }
                animate={{ width: 'auto', opacity: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
                transition={{
                  width: { type: 'spring', visualDuration: 0.32, bounce: 0 },
                  opacity: { duration: 0.16 },
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  data-variant={toast.action.variant ?? 'primary'}
                  className={styles.actionButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    toast.action?.onClick(e);
                  }}
                >
                  {toast.action.label}
                </Button>
              </m.div>
            ) : null}
          </AnimatePresence>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="关闭通知"
            className={styles.closeButton}
            onClick={(e) => {
              e.stopPropagation();
              handleDismissAnimation();
            }}
          >
            <AppIcon name="x" size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </m.div>
  );
};
