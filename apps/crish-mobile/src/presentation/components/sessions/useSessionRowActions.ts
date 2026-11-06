// 会话行按压与长按的稳定回调。
// 按下立刻走现有共享值反馈。短按只进入会话。
// 长按阈值与系统按压组件默认值相同，取 500 毫秒，不调短，
// 避免列表滚动时误开菜单。手指移出滑动容差后，长按会被取消。
// 计时只记到请求相位：操作表的可见完成不在本轮可改的公共表里。
import { useCallback, useMemo, useRef } from 'react';
import {
  beginInteraction,
  type InteractionHandle,
} from '@/presentation/perf/interactionTiming';

/** 会话行长按等待。与系统按压组件默认值相同。 */
export const SESSION_ROW_LONG_PRESS_DELAY_MS = 500;

export interface SessionRowActions {
  onPress: () => void;
  onLongPress: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
  delayLongPress: number;
}

export function useSessionRowActions(options: {
  rowId: string;
  onPress: (id: string) => void;
  onLongPress?: (id: string) => void;
  timingName: string;
  onPressInVisual: () => void;
  onPressOutVisual: () => void;
}): SessionRowActions {
  const rowIdRef = useRef(options.rowId);
  rowIdRef.current = options.rowId;
  const onPressRef = useRef(options.onPress);
  onPressRef.current = options.onPress;
  const onLongPressRef = useRef(options.onLongPress);
  onLongPressRef.current = options.onLongPress;
  const timingNameRef = useRef(options.timingName);
  timingNameRef.current = options.timingName;
  const onPressInVisualRef = useRef(options.onPressInVisual);
  onPressInVisualRef.current = options.onPressInVisual;
  const onPressOutVisualRef = useRef(options.onPressOutVisual);
  onPressOutVisualRef.current = options.onPressOutVisual;
  const spanRef = useRef<InteractionHandle | null>(null);

  const onPress = useCallback(() => {
    onPressRef.current(rowIdRef.current);
  }, []);

  const onLongPress = useCallback(() => {
    const openMenu = onLongPressRef.current;
    if (!openMenu) return;
    const span = spanRef.current;
    if (span) {
      span.mark('request');
      span.end('request');
      spanRef.current = null;
    }
    openMenu(rowIdRef.current);
  }, []);

  const onPressIn = useCallback(() => {
    onPressInVisualRef.current();
    spanRef.current?.cancel();
    const span = beginInteraction(timingNameRef.current);
    span.mark('press');
    spanRef.current = span;
  }, []);

  const onPressOut = useCallback(() => {
    onPressOutVisualRef.current();
    spanRef.current?.cancel();
    spanRef.current = null;
  }, []);

  return useMemo(
    () => ({
      onPress,
      onLongPress,
      onPressIn,
      onPressOut,
      delayLongPress: SESSION_ROW_LONG_PRESS_DELAY_MS,
    }),
    [onLongPress, onPress, onPressIn, onPressOut]
  );
}
