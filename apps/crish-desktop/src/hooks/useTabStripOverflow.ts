/**
 * apps/crish-desktop/src/hooks/useTabStripOverflow.ts
 *
 * 标签栏横向溢出检测与双态加号控制（Dock Split System Architecture V2）
 *
 * 遵循原则：
 * 1. 利用 ResizeObserverManager 单例统一监听尺寸变化，杜绝重复创建 ResizeObserver；
 * 2. 测量 scrollWidth > clientWidth + 2 判定溢出；
 * 3. 标签数量与尺寸变化时即时重新测量。
 */

import { useCallback, useLayoutEffect, useState } from 'react';
import { ResizeObserverManager } from '../utils/ResizeObserverManager';

export interface UseTabStripOverflowReturn {
  /** 当前标签轨道是否发生横向溢出 */
  hasOverflow: boolean;
  /** 手动触发一次溢出检测 */
  checkOverflow: () => void;
}

export function useTabStripOverflow(
  trackRef: React.RefObject<HTMLDivElement | null>,
  tabCount: number
): UseTabStripOverflowReturn {
  const [hasOverflow, setHasOverflow] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 当可滚动内容宽度超出可视宽度 2px 时认定为溢出
    setHasOverflow(el.scrollWidth > el.clientWidth + 2);
  }, [trackRef]);

  useLayoutEffect(() => {
    checkOverflow();
    const el = trackRef.current;
    if (!el) return;

    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, checkOverflow);
    return () => {
      ro.unobserve(el, checkOverflow);
    };
  }, [checkOverflow, tabCount]);

  return { hasOverflow, checkOverflow };
}
