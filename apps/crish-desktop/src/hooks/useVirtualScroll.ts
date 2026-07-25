import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  VirtualScrollManager,
  type VisibleRange,
} from '../api/VirtualScrollManager';

export interface UseVirtualScrollOptions {
  /** 消息 ID 序列 */
  ids?: string[];
  /** 总项数 */
  itemCount: number;
  /** overscan 条数（默认 6，与 MESSAGE_VIEWPORT_OVERSCAN 对齐） */
  overscan?: number;
  /** 兜底行高（默认 120） */
  fallbackHeight?: number;
}

export interface UseVirtualScrollResult {
  /** 可视范围区间 */
  visibleRange: VisibleRange;
  /** 挂载到 scroll 容器的 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 滚动回调 */
  onScroll: React.UIEventHandler<HTMLDivElement>;
  /** 更新当前 order（窗口内的 messageId 列表，按展示顺序） */
  syncOrder: (ids: string[]) => void;
  /** 设置预测量（按 messageId） */
  setEstimated: (id: string, height: number) => void;
  /** 设置实际高度（按 messageId） */
  setActual: (id: string, height: number) => void;
  /** 清空高度数据（切会话时调用） */
  clearHeights: () => void;
  /** 访问底层 VirtualScrollManager（高级场景） */
  manager: VirtualScrollManager;
  /** 当前 scrollTop */
  scrollTop: number;
  /** 容器可视高度 */
  viewportHeight: number;
  /** 总滚动内容高度 */
  totalHeight: number;
}

const DEFAULT_OVERSCAN = 6;

export function useVirtualScroll(
  options: UseVirtualScrollOptions,
): UseVirtualScrollResult {
  const { itemCount, overscan = DEFAULT_OVERSCAN, fallbackHeight } = options;

  const managerRef = useRef<VirtualScrollManager>(null);
  if (!managerRef.current) {
    managerRef.current = new VirtualScrollManager(fallbackHeight);
  }
  const manager = managerRef.current;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [actualTick, setActualTick] = useState(0);

  // container 尺寸变化时更新 viewportHeight
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateHeight = () => setViewportHeight(el.clientHeight || 600);
    updateHeight();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height || 600);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ids = options.ids;
  useLayoutEffect(() => {
    if (ids) {
      manager.syncOrder(ids);
    }
  }, [manager, ids]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const overscanSafe = useMemo(
    () => (Number.isFinite(overscan) && overscan >= 0 ? Math.floor(overscan) : DEFAULT_OVERSCAN),
    [overscan],
  );

  const visibleRange = useMemo(
    () => manager.computeVisibleRange(scrollTop, viewportHeight, itemCount, overscanSafe),
    // actualTick 变化时重算，使 setActual 回写即时生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, scrollTop, viewportHeight, itemCount, overscanSafe, actualTick],
  );

  const totalHeight = useMemo(
    () => manager.getTotalHeight(itemCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, itemCount, actualTick],
  );

  const rafRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);

  const onScroll = useCallback<React.UIEventHandler<HTMLDivElement>>((e) => {
    latestScrollTopRef.current = e.currentTarget.scrollTop;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setScrollTop(latestScrollTopRef.current);
      });
    }
  }, []);

  const syncOrder = useCallback(
    (ids: string[]) => manager.syncOrder(ids),
    [manager],
  );

  const setEstimated = useCallback(
    (id: string, height: number) => manager.setEstimated(id, height),
    [manager],
  );

  /** 待刷入的 id→height 映射，由 rAF 批量 flush */
  const pendingActualRef = useRef<Map<string, number>>(new Map());
  const actualRafRef = useRef<number | null>(null);

  const setActual = useCallback(
    (id: string, height: number) => {
      pendingActualRef.current.set(id, height);
      if (actualRafRef.current == null) {
        actualRafRef.current = requestAnimationFrame(() => {
          actualRafRef.current = null;
          for (const [msgId, h] of pendingActualRef.current) {
            manager.setActual(msgId, h);
          }
          pendingActualRef.current.clear();
          setActualTick((t) => t + 1);
        });
      }
    },
    [manager],
  );

  const clearHeights = useCallback(() => manager.clear(), [manager]);

  return {
    visibleRange,
    containerRef,
    onScroll,
    syncOrder,
    setEstimated,
    setActual,
    clearHeights,
    manager,
    scrollTop,
    viewportHeight,
    totalHeight,
  };
}
