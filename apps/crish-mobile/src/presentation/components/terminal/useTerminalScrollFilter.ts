/**
 * useTerminalScrollFilter — 终端双门限滞后滤波与吸底防死锁 Hook
 *
 * 彻底解决高频输出流（如编译/日志）与用户手势交互时的吸底死锁与震荡：
 * 1. 双门限滞后滤波（Hysteresis Filter）：
 *    - 进入跟随阈值：距底部 ≤ 24dp（SNAP_THRESHOLD）
 *    - 释放跟随阈值：距底部 > 64dp（RELEASE_THRESHOLD）
 *    - 消除单阈值临界点由于亚像素舍入或布局更新引起的死锁振荡；
 * 2. 触控手势意图锁（Drag Intent Lock）：
 *    - 当用户触摸拖拽（onScrollBeginDrag）时，刚性冻结自动滚底，绝不抢夺用户手势；
 *    - 拖拽结束（onScrollEndDrag / onMomentumScrollEnd）后才重新评估吸底状态；
 * 3. 编程式滚动静默门锁（Programmatic Scroll Lock）：
 *    - 调用 scrollToEnd 时标记锁，忽略由该滚动引发的滚动事件回响，防止虚假状态翻转；
 * 4. RAF 帧聚合流控：
 *    - 高频流式输出到达时，合并在单帧内执行滚底，避免 JS 线程事件风暴。
 */

import { useRef, useCallback, useEffect } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, FlatList } from 'react-native';

export const SNAP_BOTTOM_THRESHOLD_DP = 24;
export const RELEASE_BOTTOM_THRESHOLD_DP = 64;

export interface UseTerminalScrollFilterProps {
  follow: boolean;
  onFollowChange?: (following: boolean) => void;
  listRef: React.RefObject<FlatList<string> | null>;
  lineCount: number;
}

export function useTerminalScrollFilter({
  follow,
  onFollowChange,
  listRef,
  lineCount,
}: UseTerminalScrollFilterProps) {
  const isUserDraggingRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const rafIdRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);

  // 当跟随开启且有新行到达时，调度滚底
  useEffect(() => {
    if (!follow || lineCount === 0 || isUserDraggingRef.current) {
      return;
    }

    if (rafIdRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafIdRef.current as number);
      } else {
        clearTimeout(rafIdRef.current);
      }
      rafIdRef.current = null;
    }

    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0);

    rafIdRef.current = schedule(() => {
      rafIdRef.current = null;
      if (!isUserDraggingRef.current && listRef.current) {
        isProgrammaticScrollRef.current = true;
        try {
          listRef.current.scrollToEnd({ animated: false });
        } finally {
          setTimeout(() => {
            isProgrammaticScrollRef.current = false;
          }, 50);
        }
      }
    });

    return () => {
      if (rafIdRef.current !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafIdRef.current as number);
        } else {
          clearTimeout(rafIdRef.current);
        }
        rafIdRef.current = null;
      }
    };
  }, [follow, lineCount, listRef]);

  const handleScrollBeginDrag = useCallback(() => {
    isUserDraggingRef.current = true;
  }, []);

  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      isUserDraggingRef.current = false;
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromEnd =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromEnd <= SNAP_BOTTOM_THRESHOLD_DP && !follow) {
        onFollowChange?.(true);
      }
    },
    [follow, onFollowChange]
  );

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      isUserDraggingRef.current = false;
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromEnd =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromEnd <= SNAP_BOTTOM_THRESHOLD_DP && !follow) {
        onFollowChange?.(true);
      } else if (distanceFromEnd > RELEASE_BOTTOM_THRESHOLD_DP && follow) {
        onFollowChange?.(false);
      }
    },
    [follow, onFollowChange]
  );

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isProgrammaticScrollRef.current) {
        return;
      }

      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromEnd =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);

      // 双门限滞后判定
      if (follow && distanceFromEnd > RELEASE_BOTTOM_THRESHOLD_DP) {
        onFollowChange?.(false);
      } else if (!follow && distanceFromEnd <= SNAP_BOTTOM_THRESHOLD_DP) {
        onFollowChange?.(true);
      }
    },
    [follow, onFollowChange]
  );

  return {
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollEnd,
  };
}
