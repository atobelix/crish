/**
 * apps/crish-desktop/src/hooks/useAccordionViewportGuard.ts
 *
 * 折叠手风琴视口保护 Hook。
 * 当长折叠组件收拢时，若其顶部已滚出视口（top < offsetPx），
 * 自动平滑滚动将其起始锚点拉回视口可见区域，彻底消灭“视口跳跃丢失”。
 */

import { useCallback, useRef } from 'react';

export interface AccordionViewportGuardOptions {
  /** 视口顶部安全保护边距（像素，默认 16px，防止元素死贴浏览器边缘） */
  offsetPx?: number;
  /** 滚动行为：'smooth' 或 'auto'（自动检测 reduced-motion 时降级为 auto） */
  behavior?: ScrollBehavior;
  /** 可选：显式指定的滚动宿主容器（缺省时使用原生 element.scrollIntoView） */
  scrollContainer?: HTMLElement | null;
  /** 滚动前回调钩子（可用于日志追踪或外部锁定） */
  onBeforeScroll?: (deltaY: number) => void;
}

export function useAccordionViewportGuard<T extends HTMLElement = HTMLElement>(
  targetRef: React.RefObject<T | null>,
  options: AccordionViewportGuardOptions = {}
) {
  const {
    offsetPx = 16,
    behavior = 'smooth',
    scrollContainer,
    onBeforeScroll,
  } = options;

  const isGuardingRef = useRef(false);

  const triggerViewportRecovery = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;

    // 读取元素在当前视口中的几何包围盒
    const rect = el.getBoundingClientRect();

    // 判定条件：顶部已经脱离视口上方（rect.top < offsetPx）
    if (rect.top < offsetPx) {
      isGuardingRef.current = true;
      const deltaY = rect.top - offsetPx;
      onBeforeScroll?.(deltaY);

      // 检测系统无障碍减弱动态偏好
      const prefersReduced = Boolean(
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
      );
      const finalBehavior: ScrollBehavior = prefersReduced ? 'auto' : behavior;

      if (scrollContainer) {
        // 自定义滚动宿主场景
        const currentScroll = scrollContainer.scrollTop;
        scrollContainer.scrollTo({
          top: Math.max(0, currentScroll + deltaY),
          behavior: finalBehavior,
        });
      } else {
        // 原生视口滚动场景（对齐 arc-library ExpandableText）
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({
            block: 'start',
            behavior: finalBehavior,
          });
        }
      }

      // 微任务后释放保护锁
      queueMicrotask(() => {
        isGuardingRef.current = false;
      });
    }
  }, [targetRef, offsetPx, behavior, scrollContainer, onBeforeScroll]);

  return {
    triggerViewportRecovery,
    isGuardingRef,
  };
}
