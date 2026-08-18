/**
 * ui/Dialog 目录内私有动画基元（PE-05 T05.1.3）
 *
 * 从 `hooks/useAnimatedPresence.ts` 提炼：ui 原子层禁止依赖 `hooks/`，
 * 因此由 Dialog 作为三件套锚点持有本实现，ui/Tooltip 等复用。
 */
import { useState, useEffect, useRef } from 'react';

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
  const prevVisibleRef = useRef(visible);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      setState('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setState('open');
        });
      });
    } else if (!visible && prevVisibleRef.current) {
      if (exitDurationMs <= 0) {
        setState('closed');
      } else {
        setState('exiting');
        timeoutRef.current = setTimeout(() => {
          setState('closed');
        }, exitDurationMs);
      }
    }
    prevVisibleRef.current = visible;
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [visible, exitDurationMs]);

  const isMounted = state !== 'closed';

  return { state, isMounted };
}
