/**
 * apps/crish-desktop/src/components/ui/internal/positioner/usePositioner.ts
 *
 * React 声明式 2-Phase 真实 DOM 探测定位 Hook
 *
 * 核心特性与架构防御：
 * 1. 2-Phase Measure-Then-Show 机制：基于 useLayoutEffect 在浏览器光栅化前完成真实 DOM 尺寸测量与定位，彻底消灭首帧尺寸盲猜与跳动；
 * 2. 补丁一 (DEF-01)：自动校正 Containing Block 局部容器（如 DialogOverlayContext）偏移；
 * 3. 补丁二 (DEF-02)：通过 useStableAnchor 深度值语义防抖，阻断字面量引发的 React 185 重复渲染死循环；
 * 4. 补丁三 (DEF-03)：采用现代 CSS 独立变换属性 `el.style.translate`，不污染 CSS `@starting-style` 的 `scale` 动效；
 * 5. 补丁八 (DEF-08)：Flip 迟滞锁记忆当前方位，防止动态内容搜索过滤时上下频繁横跳；
 * 6. 多显示器高 DPI 跨屏感知 (matchMedia dppx) 与 ResizeObserver / 滚动被动侦听。
 */

import {
  useState,
  useLayoutEffect,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import type {
  UsePositionerOptions,
  UsePositionerReturn,
  PositionResult,
  PositionSide,
} from './types';
import {
  computePosition,
  normalizeAnchorToRect,
  applyPositionStyles,
} from './geometry';
import { useStableAnchor } from './useStableAnchor';
import { ResizeObserverManager } from '../../../../utils/ResizeObserverManager';

export function usePositioner(
  options: UsePositionerOptions
): UsePositionerReturn {
  const {
    open,
    anchor: rawAnchor,
    contentRef,
    portalContainer = null,
    enabled = true,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    alignOffset = 0,
    edgePadding = 8,
    avoidCollisions = true,
    alignItemWithTrigger = false,
    selectedItemOffsetY,
    viewport,
  } = options;

  // 1. 值语义防抖稳定化 (彻底消除 DEF-02 对象字面量在 useLayoutEffect 中的死循环)
  const anchor = useStableAnchor(rawAnchor);

  const [isPositioned, setIsPositioned] = useState(false);
  const [result, setResult] = useState<PositionResult | null>(null);
  const currentSideRef = useRef<PositionSide | undefined>(undefined);
  const prevResultRef = useRef<PositionResult | null>(null);

  const update = useCallback(() => {
    if (!open || !enabled) return;
    const el = contentRef.current;
    if (!el) return;

    const anchorRect = normalizeAnchorToRect(anchor);
    if (!anchorRect) return;

    const measuredW =
      el.offsetWidth > 0 ? el.offsetWidth : el.getBoundingClientRect().width;
    const measuredH =
      el.offsetHeight > 0 ? el.offsetHeight : el.getBoundingClientRect().height;

    // 若尚未完成排版布局，隐藏占位等待下一微任务测量
    if (measuredW === 0 && measuredH === 0) {
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      return;
    }

    const res = computePosition({
      anchor: anchorRect,
      floating: { width: measuredW, height: measuredH },
      side,
      align,
      currentSide: currentSideRef.current, // 融入 Flip 迟滞锁 (DEF-08)
      sideOffset,
      alignOffset,
      edgePadding,
      avoidCollisions,
      alignItemWithTrigger,
      selectedItemOffsetY,
      viewport,
    });

    currentSideRef.current = res.actualSide;

    // 纠正 Containing Block 偏移并应用现代 CSS style.translate (DEF-01, DEF-03)
    applyPositionStyles(el, res, portalContainer, anchorRect.width);

    // 避免数值相同的重复对象触发无谓的 React 重复渲染
    const prev = prevResultRef.current;
    const isSame =
      prev !== null &&
      prev.x === res.x &&
      prev.y === res.y &&
      prev.actualSide === res.actualSide &&
      prev.actualAlign === res.actualAlign &&
      prev.isFlippedSide === res.isFlippedSide &&
      prev.isFlippedAlign === res.isFlippedAlign &&
      prev.transformOrigin === res.transformOrigin &&
      prev.availableWidth === res.availableWidth &&
      prev.availableHeight === res.availableHeight;

    if (!isSame) {
      prevResultRef.current = res;
      setResult(res);
    }
    setIsPositioned(true);
  }, [
    open,
    enabled,
    anchor,
    contentRef,
    portalContainer,
    side,
    align,
    sideOffset,
    alignOffset,
    edgePadding,
    avoidCollisions,
    alignItemWithTrigger,
    selectedItemOffsetY,
    viewport,
  ]);

  // Phase 2: 真实 DOM 探测 (useLayoutEffect 绘制前微任务同步，零肉眼闪烁)
  useLayoutEffect(() => {
    if (!open || !enabled) {
      setIsPositioned(false);
      setResult(null);
      prevResultRef.current = null;
      currentSideRef.current = undefined;
      return;
    }
    update();
  }, [open, enabled, update]);

  // 动态视口、滚动、ResizeObserver 与多屏高 DPI 监听
  useEffect(() => {
    if (!open || !enabled) return;

    let rafId: number | null = null;
    const handleUpdate = () => {
      if (typeof window === 'undefined') return;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    window.addEventListener('app:window-resize-settled', handleUpdate);
    window.addEventListener('scroll', handleUpdate, {
      passive: true,
      capture: true,
    });

    // 多屏高 DPI 跨屏感知 (消除 Windows 跨屏拖拽 DPI 切换时的亚像素发白与错位)
    let dpiMedia: MediaQueryList | null = null;
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
    ) {
      try {
        dpiMedia = window.matchMedia(
          `(resolution: ${window.devicePixelRatio}dppx)`
        );
        dpiMedia.addEventListener?.('change', handleUpdate);
      } catch {
        // 环境不支持时静默忽略
      }
    }

    const roManager = ResizeObserverManager.getInstance();
    const targets: HTMLElement[] = [];
    if (contentRef.current) {
      targets.push(contentRef.current);
    }
    if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
      targets.push(anchor);
    } else if (
      anchor &&
      typeof anchor === 'object' &&
      'current' in anchor &&
      anchor.current
    ) {
      targets.push(anchor.current);
    }
    targets.forEach((t) => roManager.observe(t, handleUpdate));

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener('app:window-resize-settled', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
      dpiMedia?.removeEventListener?.('change', handleUpdate);
      targets.forEach((t) => roManager.unobserve(t, handleUpdate));
    };
  }, [open, enabled, anchor, contentRef, update]);

  return { isPositioned, result, update };
}
