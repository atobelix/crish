import { useState, useRef, useCallback, useEffect } from 'react';
import type { AppToast } from '../../services/toast/types';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';

export function useToastStackMeasurement(
  toasts: readonly AppToast[],
  _expanded: boolean
) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const heightsRef = useRef<Record<string, number>>({});
  heightsRef.current = heights;

  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerNode = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      nodeRefs.current.set(id, el);
      const measuredH =
        el.offsetHeight ||
        (typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect().height
          : 0);
      if (measuredH > 0 && heightsRef.current[id] !== measuredH) {
        heightsRef.current[id] = measuredH;
      }
    } else {
      nodeRefs.current.delete(id);
    }
  }, []);

  // 监听尺寸动态变化 (通过 ResizeObserverManager 精准收集真实卡片高度)
  useEffect(() => {
    const roManager = ResizeObserverManager.getInstance();

    const handleResize = (entry: ResizeObserverEntry) => {
      const id = entry.target.getAttribute('data-toast-id');
      if (id) {
        const newH =
          entry.borderBoxSize?.[0]?.blockSize ??
          entry.contentRect.height ??
          (entry.target as HTMLElement).offsetHeight ??
          56;

        if (heightsRef.current[id] !== newH && newH > 0) {
          setHeights((prev) => ({ ...prev, [id]: newH }));
        }
      }
    };

    const elements = Array.from(nodeRefs.current.values());
    elements.forEach((el) => {
      roManager.observe(el, handleResize);
    });

    return () => {
      elements.forEach((el) => {
        roManager.unobserve(el, handleResize);
      });
    };
  }, [toasts]);

  // 计算展开态下各卡片的累加偏移量: offsetY(i) = sum(H_k, k=0..i-1) + i * gap
  const getOffsetY = useCallback(
    (index: number, gap: number = 12): number => {
      let acc = 0;
      for (let i = 0; i < index; i++) {
        const item = toasts[i];
        const h = item
          ? heights[item.id] ?? heightsRef.current[item.id] ?? 56
          : 56;
        acc += h + gap;
      }
      return acc;
    },
    [toasts, heights]
  );

  const frontmostHeight = toasts[0]
    ? heights[toasts[0].id] ?? heightsRef.current[toasts[0].id] ?? 56
    : 56;

  return {
    registerNode,
    getOffsetY,
    heights,
    frontmostHeight,
  };
}
