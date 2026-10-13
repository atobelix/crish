/**
 * 侧边栏会话列表虚拟化与真实滚动宿主直连引擎 (Stage 06 — Sidebar Windowing & Scroll Host)。
 *
 * 核心原则：
 * 1. 彻底废除 Object.defineProperties 原型劫持黑魔法，确立外层真实滚动容器 .sidebarScroll
 *    ([data-sidebar-scroll-host="true"]) 为唯一权威滚动宿主；
 * 2. 视口绝对优先约束算法 (computeWindowWithConstraint)：刚性锁定活跃挂载 DOM 节点恒定 <= 45 行；
 * 3. EnsureIndex 防溢出屏障：当目标项距离当前视口过远（合并后 > 45 行）时，无条件保护当前可视视口不白屏；
 * 4. 全子树严格 0 MutationObserver，尺寸感知统一归口至单例 ResizeObserverManager。
 */

import { useEffect, useState } from 'react';
import {
  clampSessionListWindowRange,
  computeSessionListWindow,
  expandWindowToIndex,
  measureListOffsetTop,
  sessionListWindowRangeEqual,
  SIDEBAR_SESSION_ROW_HEIGHT,
  SIDEBAR_WINDOW_OVERSCAN,
  type HeightGetter,
  type SessionListWindowRange,
} from '../../api/sessionListWindow';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import sidebarStyles from './Sidebar.module.css';

export const FULL_RANGE = (count: number): SessionListWindowRange => ({
  start: 0,
  end: count,
  topPad: 0,
  bottomPad: 0,
  windowed: false,
});

/**
 * 侧边栏长列表活跃 DOM 节点刚性上限：<= 45 行。
 * 即使在 4K 巨屏视口或 1000+ 会话规模下，活跃挂载节点严格收敛在此预算内。
 */
export const MAX_SIDEBAR_WINDOW_ROWS = 45;

/**
 * 校验 DOM 容器节点是否保持原生纯净（零 Object.defineProperties 篡改 scrollTop / clientHeight）。
 */
export function isCleanNativeScrollNode(node: HTMLElement | null): boolean {
  if (!node) return true;
  return (
    Object.getOwnPropertyDescriptor(node, 'scrollTop') === undefined &&
    Object.getOwnPropertyDescriptor(node, 'clientHeight') === undefined
  );
}

/**
 * 解析外层真实滚动宿主（.sidebarScroll / [data-sidebar-scroll-host="true"] / [data-sidebar-chrome="scroll"]）。
 */
export function resolveActualScrollHost(
  rawEl: HTMLElement | null,
  listEl?: HTMLElement | null
): HTMLElement | null {
  const candidate = rawEl || listEl;
  if (!candidate) return null;

  // 1. 优先使用自身已是真实滚动宿主的元素
  if (
    candidate.getAttribute?.('data-sidebar-scroll-host') === 'true' ||
    candidate.getAttribute?.('data-sidebar-chrome') === 'scroll' ||
    candidate.classList?.contains('sidebarScroll') ||
    (sidebarStyles?.sidebarScroll &&
      candidate.classList?.contains(sidebarStyles.sidebarScroll))
  ) {
    return candidate;
  }

  // 2. 通过最近的宿主选择器向上寻踪到外层 .sidebarScroll
  const host = candidate.closest?.(
    '[data-sidebar-scroll-host="true"], [data-sidebar-chrome="scroll"], .sidebarScroll'
  ) as HTMLElement | null;
  if (host) {
    return host;
  }

  // 3. 回退策略：遍历父级寻找具备实际 overflow-y 滚动能力的容器
  let cur = candidate.parentElement;
  while (cur && cur !== document.body) {
    const style =
      typeof window !== 'undefined' ? window.getComputedStyle?.(cur) : null;
    if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      return cur;
    }
    cur = cur.parentElement;
  }

  return rawEl;
}

/**
 * 视口绝对优先约束算法 (Viewport Window First)：
 * 1. 根据视口高度动态反推剩余 overscan 预算，计算纯视口范围 viewportRange；
 * 2. 刚性硬顶截断：保证纯视口窗口活跃 DOM 节点数严格 <= 45 行；
 * 3. EnsureIndex 防溢出屏障：仅当扩展后总行数 <= 45 时才合并 ensureIndex，严禁挤占当前视口引发白屏。
 */
export function computeWindowWithConstraint(opts: {
  count: number;
  scrollEl: HTMLElement | null;
  listEl: HTMLElement | null;
  ensureIndex?: number | null;
  getHeight?: HeightGetter;
}): SessionListWindowRange {
  const { count, scrollEl, listEl, ensureIndex, getHeight } = opts;
  const vh = scrollEl ? scrollEl.clientHeight || 400 : 400;
  const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
  const listOffsetTop =
    scrollEl && listEl ? measureListOffsetTop(scrollEl, listEl) : 0;

  // 1. 动态 overscan 反推：根据视口高度计算剩余行数配额，确保总行数严格 <= 45
  const estimatedRowH = getHeight
    ? getHeight(0) || SIDEBAR_SESSION_ROW_HEIGHT
    : SIDEBAR_SESSION_ROW_HEIGHT;
  const visibleInView = Math.ceil(vh / estimatedRowH);
  const remainingBudget = MAX_SIDEBAR_WINDOW_ROWS - visibleInView;
  const dynamicOverscan =
    remainingBudget > 0
      ? Math.max(
          1,
          Math.min(SIDEBAR_WINDOW_OVERSCAN, Math.floor(remainingBudget / 2))
        )
      : 0;

  let viewportRange = computeSessionListWindow({
    count,
    scrollTop,
    viewportHeight: vh,
    listOffsetTop,
    overscan: dynamicOverscan,
    ...(getHeight !== undefined ? { getHeight } : {}),
  });

  // 2. 刚性硬顶截断：纯视口窗口活跃 DOM 节点严格 <= 45 行
  if (
    viewportRange.windowed &&
    viewportRange.end - viewportRange.start > MAX_SIDEBAR_WINDOW_ROWS
  ) {
    viewportRange = clampSessionListWindowRange(
      {
        start: viewportRange.start,
        end: viewportRange.start + MAX_SIDEBAR_WINDOW_ROWS,
      },
      count,
      undefined,
      getHeight
    );
  }

  // 3. EnsureIndex 防溢出屏障：仅当扩展后总行数 <= 45 时才合并，绝不裁剪当前可视视口
  if (
    viewportRange.windowed &&
    ensureIndex !== null &&
    ensureIndex !== undefined
  ) {
    const expanded = expandWindowToIndex(
      viewportRange,
      ensureIndex,
      count,
      undefined,
      getHeight
    );
    if (expanded.end - expanded.start <= MAX_SIDEBAR_WINDOW_ROWS) {
      return expanded;
    }
  }

  return viewportRange;
}

export type UseSessionListWindowOptions = {
  count?: number;
  totalCount?: number;
  scrollParentRef: React.RefObject<HTMLElement | null>;
  scrollHostRef?: React.RefObject<HTMLElement | null>;
  listRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  ensureIndex?: number | null;
  getHeight?: HeightGetter;
};

export function useSessionListWindow(
  options: UseSessionListWindowOptions
): SessionListWindowRange;
export function useSessionListWindow(
  count: number,
  scrollParentRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  ensureIndex?: number | null,
  getHeight?: HeightGetter,
  scrollHostRef?: React.RefObject<HTMLElement | null>
): SessionListWindowRange;
export function useSessionListWindow(
  countOrOptions: number | UseSessionListWindowOptions,
  posScrollParentRef?: React.RefObject<HTMLElement | null>,
  posListRef?: React.RefObject<HTMLElement | null>,
  posEnabled?: boolean,
  posEnsureIndex?: number | null,
  posGetHeight?: HeightGetter,
  posScrollHostRef?: React.RefObject<HTMLElement | null>
): SessionListWindowRange {
  const isOptions =
    typeof countOrOptions === 'object' && countOrOptions !== null;
  const count = isOptions
    ? (countOrOptions.count ?? countOrOptions.totalCount ?? 0)
    : countOrOptions;
  const scrollParentRef = isOptions
    ? countOrOptions.scrollParentRef
    : posScrollParentRef!;
  const scrollHostRef = isOptions
    ? countOrOptions.scrollHostRef
    : posScrollHostRef;
  const listRef = isOptions ? countOrOptions.listRef : posListRef!;
  const enabled = isOptions ? countOrOptions.enabled : (posEnabled ?? false);
  const ensureIndex = isOptions
    ? (countOrOptions.ensureIndex ?? null)
    : (posEnsureIndex ?? null);
  const getHeight = isOptions ? countOrOptions.getHeight : posGetHeight;

  const [range, setRange] = useState<SessionListWindowRange>(() => {
    if (!enabled) return FULL_RANGE(count);
    return computeWindowWithConstraint({
      count,
      scrollEl: null,
      listEl: null,
      ensureIndex,
      getHeight,
    });
  });

  useEffect(() => {
    if (!enabled) {
      setRange(FULL_RANGE(count));
      return;
    }

    const rawEl = scrollHostRef?.current || scrollParentRef?.current || null;
    const scrollEl = resolveActualScrollHost(rawEl, listRef?.current || null);
    if (!scrollEl) {
      setRange(
        computeWindowWithConstraint({
          count,
          scrollEl: null,
          listEl: null,
          ensureIndex,
          getHeight,
        })
      );
      return;
    }

    let raf = 0;
    const roManager = ResizeObserverManager.getInstance();
    const observedElements = new Set<HTMLElement>();

    const syncObservedElements = (
      hostEl: HTMLElement,
      currentListEl: HTMLElement | null
    ) => {
      const candidates: (HTMLElement | null | undefined)[] = [
        hostEl,
        currentListEl,
      ];
      for (const el of candidates) {
        if (el && !observedElements.has(el)) {
          observedElements.add(el);
          roManager.observe(el, handleRo);
        }
      }
    };

    const update = () => {
      const currentRaw =
        scrollHostRef?.current || scrollParentRef?.current || null;
      const currentListEl = listRef?.current || null;
      const actualHost =
        resolveActualScrollHost(currentRaw, currentListEl) || scrollEl;
      syncObservedElements(actualHost, currentListEl);
      const next = computeWindowWithConstraint({
        count,
        scrollEl: actualHost,
        listEl: currentListEl,
        ensureIndex,
        getHeight,
      });
      setRange((prev) =>
        sessionListWindowRangeEqual(prev, next) ? prev : next
      );
    };

    const handleRo = () => {
      update();
    };

    update();
    raf = requestAnimationFrame(() => {
      update();
    });
    scrollEl.addEventListener('scroll', update, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      scrollEl.removeEventListener('scroll', update);
      observedElements.forEach((el) => {
        roManager.unobserve(el, handleRo);
      });
    };
  }, [
    count,
    enabled,
    ensureIndex,
    scrollParentRef,
    listRef,
    getHeight,
    scrollHostRef,
  ]);

  return range;
}
