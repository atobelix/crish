import { type RefObject, useEffect, useRef } from 'react';

/** 容差阈值：高分屏 DPI 缩放与触控板滞后缓冲带 (8px) */
export const BOTTOM_THRESHOLD_PX = 8;

export interface UsePinnedScrollOptions {
  /** 当前是否处于流式传输中 */
  isActive: boolean;
  /** 是否启用滚动吸底限制（存在 maxHeight 或表格处于活动态时生效） */
  enabled: boolean;
  /** 内容增长触发器（随着数据变化传递不同的 key / hash / textLength / children） */
  contentKey?: unknown;
}

/**
 * 解析 maxHeight 属性为标准 CSS 字符串
 */
export function resolveMaxHeight(
  maxHeight: number | string | undefined
): string | undefined {
  if (
    maxHeight === undefined ||
    maxHeight === 0 ||
    maxHeight === Number.POSITIVE_INFINITY
  ) {
    return undefined;
  }
  if (typeof maxHeight === 'number') {
    if (!(Number.isFinite(maxHeight) && maxHeight > 0)) {
      return undefined;
    }
    return `${maxHeight}px`;
  }
  if (
    maxHeight === '0' ||
    maxHeight === 'none' ||
    maxHeight === 'Infinity' ||
    maxHeight === ''
  ) {
    return undefined;
  }
  return maxHeight;
}

/**
 * 局部视口双向吸底滚动 Hook
 *
 * 核心机制：
 * 1. 8px 容差吸底：精确吸收高分屏亚像素浮点抖动与触控板微滞后；
 * 2. 物理输入同步拦截 (Capture Phase)：在 wheel / touchmove / touchstart 事件捕获阶段同步解除吸底，彻底消灭视口锁死；
 * 3. instant 瞬时物理定位：严禁在流式中使用 smooth，消除动画帧积压；
 * 4. 意图保护：用户滑回底部恢复吸底，停留上方保持绝对静止。
 */
export function usePinnedScroll(
  options: UsePinnedScrollOptions
): RefObject<HTMLDivElement | null> {
  const { isActive, enabled, contentKey } = options;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<boolean>(true);
  const wasActiveRef = useRef<boolean>(false);
  const touchStartYRef = useRef<number>(0);

  // 1. 同步物理输入拦截器 (Capture 阶段立即解锁吸底)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const handleWheel = (e: WheelEvent) => {
      // 用户滚轮向上滚动（deltaY < 0），立即解除吸底
      if (e.deltaY < 0) {
        pinnedRef.current = false;
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      // 手指往下滑动（currentY > touchStartYRef.current），内容往上滚，解除吸底
      if (currentY > touchStartYRef.current) {
        pinnedRef.current = false;
      }
    };

    el.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    el.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });

    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
      el.removeEventListener('touchstart', handleTouchStart, { capture: true });
      el.removeEventListener('touchmove', handleTouchMove, { capture: true });
    };
  }, [enabled]);

  // 2. 监听真实滚动事件计算吸附状态 (8px 容差)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const handleScroll = () => {
      const distanceToBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      // 距离底部小于 8px 视为处于底部，保持/恢复锁定；否则解锁
      pinnedRef.current = distanceToBottom < BOTTOM_THRESHOLD_PX;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [enabled]);

  // 3. 流式状态生命周期切换管理
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      // 新一轮流式开始：重置为自动吸底
      pinnedRef.current = true;
    }
    if (!isActive) {
      // 流式结束：复位标记
      pinnedRef.current = true;
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  // 4. 内容增长触发瞬时定位
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled || !isActive || !pinnedRef.current) {
      return;
    }

    // 采用 instant 瞬时定位，杜绝 smooth 延迟与帧积压
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'instant',
      });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [isActive, enabled, contentKey]);

  return scrollRef;
}
