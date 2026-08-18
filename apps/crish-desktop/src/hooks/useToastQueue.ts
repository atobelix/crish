/**
 * Multi-toast queue with auto-dismiss.
 * Policy: toast ONLY for errors and undoable actions (e.g. archive / branch + Undo).
 * Never for open panel / export success / copy success / routine status / tips.
 * Timers live in a ref Map so dismiss / unmount clear them;
 * showToast itself does not return a cleanup (callers ignore returns).
 *
 * 纯逻辑（类型 / 常量 / 策略 / 去重 / enqueue / trim）已提取到 toastQueueLogic.ts。
 * 本文件仅保留 React hook + re-export，保持消费方 import 路径不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

// 纯逻辑 re-export：保持消费方 `from './useToastQueue'` 路径不变
export type {
  ToastType,
  ToastPriority,
  AppToast,
  EnqueueToast,
  ToastPolicyDecision,
  ToastEnqueueResult,
  EnqueueToastOptions,
} from './toastQueueLogic';
export {
  TOAST_TTL_MS,
  TOAST_MAX_QUEUE,
  resolveToastTtlMs,
  normalizeToastMessage,
  isForbiddenSuccessToast,
  isAllowedToast,
  shouldDropSuccessToast,
  classifyToastPolicy,
  formatEngineDegradeToast,
  toastDedupeKey,
  createToastId,
  createToastItem,
  formatArchiveUndoToast,
  formatBranchUndoToast,
  isUndoToastShape,
  buildUndoToastItem,
  isErrorToastCandidate,
  filterErrorOnlyToastMessages,
  findDuplicateToastIndex,
  trimToastQueue,
  removeToastById,
  enqueueToast,
} from './toastQueueLogic';

import {
  TOAST_TTL_MS,
  resolveToastTtlMs,
  removeToastById,
  enqueueToast,
  type AppToast,
  type EnqueueToast,
} from './toastQueueLogic';

export function useToastQueue() {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** 镜像队列，便于 showToast 同步读 prev 做纯 enqueue（避免 setState 副作用）。 */
  const toastsRef = useRef<AppToast[]>([]);
  toastsRef.current = toasts;

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t != null) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const scheduleDismiss = useCallback(
    (id: string, ttlMs: number = TOAST_TTL_MS) => {
      clearTimer(id);
      const delay = resolveToastTtlMs(ttlMs);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => {
          const next = removeToastById(prev, id);
          toastsRef.current = next;
          return next;
        });
      }, delay);
      timersRef.current.set(id, timer);
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => {
        const next = removeToastById(prev, id);
        toastsRef.current = next;
        return next;
      });
    },
    [clearTimer],
  );

  const showToast: EnqueueToast = useCallback(
    (message, onUndo, options) => {
      const result = enqueueToast(toastsRef.current, message, onUndo, options);

      if (result.kind === 'drop') {
        if (import.meta.env?.DEV && result.reason === 'drop-success') {
          console.warn('[toast policy] dropped success/tip toast:', message);
        }
        return;
      }

      if (result.kind === 'dedupe') {
        // 同文案再触发：刷新 TTL，不叠层；onUndo 若更新则同步队列
        if (result.next) {
          toastsRef.current = result.next;
          setToasts(result.next);
        }
        scheduleDismiss(result.existingId, result.refreshTtlMs);
        return;
      }

      for (const id of result.evictedIds) {
        clearTimer(id);
      }
      toastsRef.current = result.next;
      setToasts(result.next);
      scheduleDismiss(result.item.id, result.ttlMs);
    },
    [clearTimer, scheduleDismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}
