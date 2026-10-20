/**
 * ui/Dialog 目录内私有动画基元（PE-05 T05.1.3）
 *
 * 从 `hooks/useAnimatedPresence.ts` 提炼：ui 原子层禁止依赖 `hooks/`，
 * 因此由 Dialog 作为三件套锚点持有本实现，ui/Tooltip 等复用。
 *
 * 动画状态机与并发竞态消除（02-分维详案）：
 * 1. 严格跟踪排队的双重 rAF 句柄，组件卸载或 visible=false 时无条件同步取消；
 * 2. rAF 回调执行时具备闭包守卫与实时状态守卫，严禁在关闭/退出期重新置为 open；
 * 3. exitDurationMs <= 0 且 !visible 时立即同步收敛为 closed。
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export type TransitionState = 'entering' | 'open' | 'exiting' | 'closed';

export interface UseAnimatedPresenceOptions {
  visible: boolean;
  /** 退出动画时长：与 --duration-exit / --transition-popover-exit 对齐 */
  exitDurationMs?: number;
}

/**
 * 挂载/卸载双阶段状态机：visible 切 true 走 entering→open（双 rAF 保证
 * 样式类先落位再播放动画）；切 false 走 exiting→closed（超时卸载）。
 */
export function useAnimatedPresence({
  visible,
  exitDurationMs = 250,
}: UseAnimatedPresenceOptions) {
  const [state, setState] = useState<TransitionState>(
    visible ? 'open' : 'closed'
  );
  const stateRef = useRef<TransitionState>(state);
  stateRef.current = state;

  const prevVisibleRef = useRef(visible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const rafHandlesRef = useRef<number[]>([]);

  const cancelAllRafs = useCallback(() => {
    for (const handle of rafHandlesRef.current) {
      cancelAnimationFrame(handle);
    }
    rafHandlesRef.current = [];
  }, []);

  const clearExitTimeout = useCallback(() => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    let isCancelled = false;

    if (visible) {
      if (!prevVisibleRef.current) {
        clearExitTimeout();
        cancelAllRafs();

        setState('entering');

        let handle2: number | undefined;

        // rAF 恒返回 number，句柄直接绑定（无需 undefined 兜底）
        const handle1 = requestAnimationFrame(() => {
          rafHandlesRef.current = rafHandlesRef.current.filter(
            (h) => h !== handle1
          );
          if (isCancelled || !visible || !visibleRef.current) {
            return;
          }

          handle2 = requestAnimationFrame(() => {
            if (handle2 !== undefined) {
              rafHandlesRef.current = rafHandlesRef.current.filter(
                (h) => h !== handle2
              );
            }
            if (isCancelled || !visible || !visibleRef.current) {
              return;
            }

            setState((current) => {
              if (
                isCancelled ||
                !visibleRef.current ||
                current === 'closed' ||
                current === 'exiting'
              ) {
                return current;
              }
              return 'open';
            });
          });

          if (handle2 !== undefined) {
            rafHandlesRef.current.push(handle2);
          }
        });

        rafHandlesRef.current.push(handle1);
      }
    } else {
      // 当 visible 变为 false 时，无条件同步取消所有正在等待的 rAF 句柄
      cancelAllRafs();
      clearExitTimeout();

      if (exitDurationMs <= 0) {
        // 当 exitDurationMs <= 0 且 !visible 时，必须立即同步收敛为 'closed'
        setState('closed');
      } else if (prevVisibleRef.current) {
        setState('exiting');
        timeoutRef.current = setTimeout(() => {
          setState('closed');
          timeoutRef.current = undefined;
        }, exitDurationMs);
      } else if (
        stateRef.current !== 'closed' &&
        stateRef.current !== 'exiting'
      ) {
        setState('closed');
      }
    }

    prevVisibleRef.current = visible;

    return () => {
      isCancelled = true;
      cancelAllRafs();
      clearExitTimeout();
    };
  }, [visible, exitDurationMs, cancelAllRafs, clearExitTimeout]);

  const isMounted = state !== 'closed';

  return { state, isMounted };
}
