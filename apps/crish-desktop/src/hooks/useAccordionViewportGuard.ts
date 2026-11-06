/**
 * apps/crish-desktop/src/hooks/useAccordionViewportGuard.ts
 *
 * 折叠手风琴视口保护 Hook。
 * 当长折叠组件收拢时，若其顶部已滚出视口（top < offsetPx），
 * 自动平滑滚动将其起始锚点拉回视口可见区域，彻底消灭“视口跳跃丢失”。
 *
 * 【判底豁免（S9 高度族 · 底部折叠案，用户 2026-11-06 点名）】
 * 若触发瞬间滚动容器已判定在底部（距底 ≤ BOTTOM_STICK_EPSILON_PX，
 * 与消息列表自身的贴底判定同口径），守卫不得介入：判底折叠的视口
 * 底边由折叠自身的同钟回收负责（虚拟滚动层在手风琴锁内逐帧落高、
 * 滚动随折叠同步回收，规格见 S9 报告），守卫若再以 scrollIntoView
 * 另起一条浏览器时钟的平滑滚动，只会与折叠动画竞速出第二段位移
 * （先上移、再被拉回的两步弹跳）。非底部场景行为与既往完全一致。
 */

import { useCallback, useRef } from 'react';
import { BOTTOM_STICK_EPSILON_PX } from './virtualScrollConstants';

/**
 * 向上查找目标元素所属的滚动容器（首个 overflow-y 可滚动且内容
 * 确实溢出的祖先）。找不到时返回 null（回落 scrollIntoView 路径）。
 */
export function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    if (node.scrollHeight - node.clientHeight > 1) {
      let overflowY = '';
      try {
        overflowY =
          typeof window !== 'undefined' &&
          typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(node).overflowY
            : '';
      } catch {
        overflowY = '';
      }
      if (
        overflowY === 'auto' ||
        overflowY === 'scroll' ||
        overflowY === 'overlay'
      ) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 容器判底：可滚动空间 > 1px 且距底 ≤ BOTTOM_STICK_EPSILON_PX
 * （与 messageVirtualizerScrollState 的贴底判定同口径）。
 */
export function isContainerAtBottom(container: HTMLElement): boolean {
  const maxScroll = container.scrollHeight - container.clientHeight;
  if (maxScroll <= 1) return false;
  return maxScroll - container.scrollTop <= BOTTOM_STICK_EPSILON_PX;
}

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

    // 判底豁免：已在底部时折叠走底边同钟回收，守卫不另起滚动竞速
    const container = scrollContainer ?? findScrollableAncestor(el);
    if (container && isContainerAtBottom(container)) {
      return;
    }

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
