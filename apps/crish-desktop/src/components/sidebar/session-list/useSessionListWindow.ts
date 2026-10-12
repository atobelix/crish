import { useEffect, useState } from 'react';
import {
  computeSessionListWindow,
  clampSessionListWindowRange,
  measureListOffsetTop,
  sessionListWindowRangeEqual,
  SIDEBAR_SESSION_ROW_HEIGHT,
  SIDEBAR_WINDOW_OVERSCAN,
  type HeightGetter,
  type SessionListWindowRange,
} from '../../../api/sessionListWindow';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';
import sidebarStyles from '../Sidebar.module.css';

export const FULL_RANGE = (count: number): SessionListWindowRange => ({
  start: 0,
  end: count,
  topPad: 0,
  bottomPad: 0,
  windowed: false,
});

/**
 * 侧栏长列表活跃 DOM 节点严格上限：<= 45 个。
 * 即使视口高度超大或包含 1000+ 对话，活跃挂载节点严格收敛在此预算内。
 */
export const MAX_SIDEBAR_WINDOW_ROWS = 45;

/**
 * 双保险宿主对齐：从传入的 rawEl 或 listEl 向上寻踪，
 * 优先绑定到带有 `.sidebarScroll` 或 `[data-sidebar-chrome="scroll"]`、`[data-sidebar-scroll-host="true"]`
 * 的真实滚动容器。
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

  // 2. 双保险防御式自动提升：通过最近的宿主选择器向上寻踪
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
 * 根据窗口高度 + 动态 overscan 计算窗口范围，并严格约束渲染节点数 <= 45。
 */
export function computeWindowWithConstraint(opts: {
  count: number;
  scrollEl: HTMLElement | null;
  listEl: HTMLElement | null;
  ensureIndex?: number | null;
  getHeight?: HeightGetter;
}): SessionListWindowRange {
  const { count, scrollEl, listEl, ensureIndex, getHeight } = opts;
  if (!scrollEl) {
    let initial = computeSessionListWindow({
      count,
      scrollTop: 0,
      viewportHeight: 400,
      listOffsetTop: 0,
      ...(ensureIndex !== null && ensureIndex !== undefined
        ? { ensureIndex }
        : {}),
      ...(getHeight !== undefined ? { getHeight } : {}),
    });
    if (
      initial.windowed &&
      initial.end - initial.start > MAX_SIDEBAR_WINDOW_ROWS
    ) {
      initial = clampSessionListWindowRange(
        {
          start: initial.start,
          end: initial.start + MAX_SIDEBAR_WINDOW_ROWS,
        },
        count,
        undefined,
        getHeight
      );
    }
    return initial;
  }

  const vh = scrollEl.clientHeight || 400;
  const listOffsetTop = listEl ? measureListOffsetTop(scrollEl, listEl) : 0;

  // 动态 overscan：根据视口高度反推剩余行数配额，在保障总渲染行 <= 45 的前提下分配 overscan
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

  let next = computeSessionListWindow({
    count,
    scrollTop: scrollEl.scrollTop,
    viewportHeight: vh,
    listOffsetTop,
    overscan: dynamicOverscan,
    ...(ensureIndex !== null && ensureIndex !== undefined
      ? { ensureIndex }
      : {}),
    ...(getHeight !== undefined ? { getHeight } : {}),
  });

  // 严格约束活跃 DOM 节点 <= 45 行
  if (next.windowed && next.end - next.start > MAX_SIDEBAR_WINDOW_ROWS) {
    let start = next.start;
    let end = next.end;
    if (
      ensureIndex !== null &&
      ensureIndex !== undefined &&
      ensureIndex >= start &&
      ensureIndex <= start + MAX_SIDEBAR_WINDOW_ROWS
    ) {
      end = start + MAX_SIDEBAR_WINDOW_ROWS;
    } else if (
      ensureIndex !== null &&
      ensureIndex !== undefined &&
      ensureIndex >= end - MAX_SIDEBAR_WINDOW_ROWS &&
      ensureIndex < end
    ) {
      start = end - MAX_SIDEBAR_WINDOW_ROWS;
    } else {
      end = start + MAX_SIDEBAR_WINDOW_ROWS;
    }
    next = clampSessionListWindowRange(
      { start, end },
      count,
      undefined,
      getHeight
    );
  }

  return next;
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
    const update = () => {
      const currentRaw =
        scrollHostRef?.current || scrollParentRef?.current || null;
      const actualHost =
        resolveActualScrollHost(currentRaw, listRef?.current || null) ||
        scrollEl;
      const next = computeWindowWithConstraint({
        count,
        scrollEl: actualHost,
        listEl: listRef?.current || null,
        ensureIndex,
        getHeight,
      });
      setRange((prev) =>
        sessionListWindowRangeEqual(prev, next) ? prev : next
      );
    };

    update();
    raf = requestAnimationFrame(() => {
      update();
    });
    scrollEl.addEventListener('scroll', update, { passive: true });
    const roManager = ResizeObserverManager.getInstance();
    const handleRo = () => {
      update();
    };
    const observedElements: HTMLElement[] = [scrollEl];
    const listEl = listRef?.current;
    if (listEl) {
      observedElements.push(listEl);
      if (listEl.parentElement && listEl.parentElement !== scrollEl) {
        observedElements.push(listEl.parentElement);
      }
    }
    observedElements.forEach((el) => {
      roManager.observe(el, handleRo);
    });

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
