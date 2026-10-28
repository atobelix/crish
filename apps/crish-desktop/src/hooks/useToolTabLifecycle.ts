/**
 * apps/crish-desktop/src/hooks/useToolTabLifecycle.ts
 *
 * 工具标签关闭生命周期与超时保险丝状态机（Dock Split System Architecture V2）
 *
 * 遵循原则：
 * 1. 动效由 CSS transitionend(max-width) 驱动单一真理源；
 * 2. 真实计算 DOM transition 动画时长，3 倍时长作为防掉帧超时保险丝，根治 transitionend 丢失导致的幽灵 Tab；
 * 3. 严禁字面量毫秒定时器（对齐 tabStripMotionContract 契约）；
 * 4. 组件卸载时安全清理所有计时器，杜绝内存泄漏。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DURATION_FAST_MS, readTransitionMs } from '../utils/motionTokens';

export interface UseToolTabLifecycleOptions {
  /** 最终确认关闭标签回调 */
  onFinalizeClose: (tabId: string) => void;
}

export interface UseToolTabLifecycleReturn {
  /** 当前正处于离场动画中的标签 ID 集合 */
  closingTabIds: Set<string>;
  /** 触发关闭标签过渡动画 */
  triggerCloseTab: (
    tabId: string,
    e?: React.MouseEvent,
    tabElement?: HTMLElement | null
  ) => void;
  /** 立即最终确认关闭并清理保险丝 */
  finalizeClose: (tabId: string) => void;
  /** 判断某个标签是否正在关闭中 */
  isTabClosing: (tabId: string) => boolean;
}

export function useToolTabLifecycle({
  onFinalizeClose,
}: UseToolTabLifecycleOptions): UseToolTabLifecycleReturn {
  const closingIdsRef = useRef<Set<string>>(new Set());
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(
    () => new Set()
  );
  const fuseTimersRef = useRef<Map<string, number>>(new Map());

  // 组件卸载时清理所有超时保险丝计时器，杜绝内存泄漏
  useEffect(() => {
    return () => {
      fuseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      fuseTimersRef.current.clear();
    };
  }, []);

  const finalizeClose = useCallback(
    (tabId: string) => {
      if (!closingIdsRef.current.has(tabId)) return;
      closingIdsRef.current.delete(tabId);
      setClosingTabIds(new Set(closingIdsRef.current));

      const fuse = fuseTimersRef.current.get(tabId);
      if (fuse != null) {
        window.clearTimeout(fuse);
        fuseTimersRef.current.delete(tabId);
      }

      onFinalizeClose(tabId);
    },
    [onFinalizeClose]
  );

  const triggerCloseTab = useCallback(
    (tabId: string, e?: React.MouseEvent, tabElement?: HTMLElement | null) => {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      if (closingIdsRef.current.has(tabId)) return;

      closingIdsRef.current.add(tabId);
      setClosingTabIds(new Set(closingIdsRef.current));

      // 提取真实 DOM 的 transition 动画时长，若无则使用 DURATION_FAST_MS 兜底，3 倍时长作为防掉帧保险丝
      const ms =
        (tabElement ? readTransitionMs(tabElement, 'max-width') : 0) ||
        DURATION_FAST_MS;
      const fuse = window.setTimeout(() => finalizeClose(tabId), ms * 3);
      fuseTimersRef.current.set(tabId, fuse);
    },
    [finalizeClose]
  );

  const isTabClosing = useCallback(
    (tabId: string) => closingIdsRef.current.has(tabId),
    []
  );

  return {
    closingTabIds,
    triggerCloseTab,
    finalizeClose,
    isTabClosing,
  };
}
