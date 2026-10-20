/**
 * PagingAnchor 双径语义锚定与视口防抖引擎
 * 文件位置：apps/crish-desktop/src/components/chat-message-list/PagingAnchor.ts
 *
 * 严格对齐 DIM-02 §1.2 与评审报告 03 / 04：
 * 1. 防遮挡几何探针快路径 (Fast Path) + 零重排树状数组二分慢路径 (Slow Path) 双径算法；
 * 2. Pre-paint 阶段相对坐标差分补偿 (restorePagingAnchor)；
 * 3. 完整继承 useUndoWithScrollAnchor 撤销视口零抖动核心能力；
 * 4. 主动交互视口防抖 (usePreActionAnchor) 支撑折叠/展开预挂载补偿。
 */

import { useRef, useLayoutEffect, useCallback, useState } from 'react';
import type React from 'react';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  type PagingAnchor,
  type PreActionAnchor,
  type PreActionAnchorHookResult,
  type UndoWithScrollAnchorResult,
  SUBPIXEL_TOLERANCE_PX,
  DEFAULT_ITEM_SELECTOR,
} from './pagingAnchorTypes';

export * from './pagingAnchorTypes';

/**
 * 捕获当前视口稳定语义锚点
 * @param scroller 真实物理滚动容器（或包含 scrollTop 的视口对象）
 * @param vsm 虚拟滚动管理器单例
 * @param itemSelector 节点选择器，兼容全新 ChatNodeSeat 与已有 data-vindex
 */
export function computePagingAnchor(
  scroller: HTMLElement | { scrollTop: number; [key: string]: unknown },
  vsm: VirtualScrollManager,
  itemSelector: string = DEFAULT_ITEM_SELECTOR
): PagingAnchor | null {
  if (!scroller) return null;

  const htmlScroller = scroller as HTMLElement;
  const isHtmlElement =
    typeof htmlScroller.getBoundingClientRect === 'function' &&
    typeof htmlScroller.querySelector === 'function';

  // 1. 防遮挡快路径（Fast Path）：避让置顶栏（PinnedBar），通过真实 DOM 探针测量
  if (
    isHtmlElement &&
    typeof document !== 'undefined' &&
    typeof document.elementsFromPoint === 'function'
  ) {
    const scrollerRect = htmlScroller.getBoundingClientRect();
    if (scrollerRect.width > 0 && scrollerRect.height > 0) {
      const centerX = scrollerRect.left + scrollerRect.width / 2;

      // 精确避让置顶栏（PinnedBar）
      const pinnedBar = htmlScroller.querySelector(
        '[data-pinned-bar="true"], [role="region"][aria-label="已固定消息"]'
      );
      const pinnedBarHeight = pinnedBar
        ? pinnedBar.getBoundingClientRect().height
        : 0;
      // 探测线置于置顶栏下沿 2px 处，杜绝被置顶浮层截获
      const probeY = scrollerRect.top + pinnedBarHeight + 2;

      const hitElements = document.elementsFromPoint(centerX, probeY);
      for (const el of hitElements) {
        if (!htmlScroller.contains(el)) continue;
        const row = el.closest(itemSelector) as HTMLElement | null;
        if (row && htmlScroller.contains(row)) {
          const key =
            row.getAttribute('data-chat-node-key') ||
            row.getAttribute('data-vindex');
          if (key) {
            return {
              key,
              top: row.getBoundingClientRect().top - scrollerRect.top,
            };
          }
        }
      }
    }
  }

  // 2. 零重排慢路径（Slow Path）：VSM Fenwick Tree 纯内存二分（O(log N)，零 DOM Layout 触发）
  const scrollTop = scroller.scrollTop ?? 0;
  const anchorIndex = vsm.findIndexAtOffset(scrollTop);
  const order = vsm.getOrder();
  if (anchorIndex >= 0 && anchorIndex < order.length) {
    const key = order[anchorIndex]!;
    const mathTop = vsm.getOffset(anchorIndex) - scrollTop;
    return { key, top: mathTop };
  }

  return null;
}

/**
 * Pre-paint 阶段相对坐标差分补偿
 * 在 useLayoutEffect 同步调用栈中先于浏览器合成屏幕绘制执行微调
 *
 * @param scroller 滚动容器
 * @param anchor 捕获到的稳定语义锚点
 * @param vsm 虚拟滚动管理器
 * @param subpixelTolerance 亚像素容差门槛（默认 0.5px）
 */
export function restorePagingAnchor(
  scroller: HTMLElement | { scrollTop: number; [key: string]: unknown },
  anchor: PagingAnchor,
  vsm: VirtualScrollManager,
  subpixelTolerance: number = SUBPIXEL_TOLERANCE_PX
): void {
  if (!scroller || !anchor) return;

  const htmlScroller = scroller as HTMLElement;
  const isHtmlElement =
    typeof htmlScroller.getBoundingClientRect === 'function' &&
    typeof htmlScroller.querySelector === 'function';

  // 路径 A：真实 DOM 节点存在时的相对位移差分补偿 (scrollTop += ΔY)
  if (isHtmlElement) {
    const scrollerRect = htmlScroller.getBoundingClientRect();
    const targetRow = htmlScroller.querySelector<HTMLElement>(
      `[data-chat-node-key="${escapeSelector(anchor.key)}"], [data-vindex="${escapeSelector(anchor.key)}"]`
    );

    if (targetRow) {
      const currentRelativeTop =
        targetRow.getBoundingClientRect().top - scrollerRect.top;
      const delta = currentRelativeTop - anchor.top;
      // 亚像素容差门槛：绝对偏差 >= 0.5px 才调整，避免浮点震荡
      if (Math.abs(delta) >= subpixelTolerance) {
        htmlScroller.scrollTop += delta;
      }
      return;
    }
  }

  // 路径 B：若前置插入过大导致锚点行超出当前可视切片（未挂载 DOM），回退至 VSM 纯数学前缀和对齐
  const order = vsm.getOrder();
  const newIdx = order.indexOf(anchor.key);
  if (newIdx !== -1) {
    const newOffset = vsm.getOffset(newIdx);
    scroller.scrollTop = Math.max(0, newOffset - anchor.top);
  }
}

/**
 * 兼容 CSS.escape 的安全转义函数
 */
function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * 纯逻辑函数：执行撤销动作并在微任务/调用栈内通过 PagingAnchor 同步校准视口
 * 彻底平移并无损继承旧 useUndoWithScrollAnchor 核心算法
 */
export function performUndoWithPagingAnchor(
  scroller: HTMLElement | { scrollTop: number; [key: string]: unknown } | null,
  vsm: VirtualScrollManager,
  undoAction: () => UndoWithScrollAnchorResult | void
): void {
  if (!scroller) {
    undoAction();
    return;
  }

  // 1. 捕获视口顶部第一可见锚点凭据（快慢双径）
  const anchor = computePagingAnchor(scroller, vsm);

  // 2. 执行撤销动作并获取还原的 delta
  const result = undoAction();
  const restoredDelta =
    result && typeof result === 'object' && 'restoredDelta' in result
      ? (result as UndoWithScrollAnchorResult).restoredDelta
      : undefined;

  // 3. 将快照中携带的 heightMap 原子灌回 VSM
  if (restoredDelta?.heightMap) {
    vsm.hydrateHeightMap(restoredDelta.heightMap);
  }

  // 4. 同步在当前调用栈中调用 restorePagingAnchor 修正 scrollTop，绝不排入 rAF
  if (anchor) {
    restorePagingAnchor(scroller, anchor, vsm);
  }
}

/**
 * 撤销视口同步锚定 Hook（向后兼容旧 useUndoWithScrollAnchor 接口与调用契约）
 */
export function useUndoWithPagingAnchor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  vsm: VirtualScrollManager
) {
  const performUndoWithAnchor = useCallback(
    (undoAction: () => UndoWithScrollAnchorResult | void) => {
      performUndoWithPagingAnchor(containerRef.current, vsm, undoAction);
    },
    [containerRef, vsm]
  );

  return { performUndoWithAnchor };
}

/**
 * 主动交互视口防抖钩子（Pre-action Viewport Snapshot）
 * 严格对齐评审报告 03 §建议二，用于折叠展开、长文本折叠等交互前置捕获
 */
export function usePreActionAnchor(
  scrollerRef: React.RefObject<HTMLElement | null>,
  vsm: VirtualScrollManager,
  itemSelector: string = DEFAULT_ITEM_SELECTOR
): PreActionAnchorHookResult {
  const pendingAnchorRef = useRef<PreActionAnchor | null>(null);
  const [, setTick] = useState(0);

  /** 捕获当前视口稳定锚点快照 */
  const captureSnapshot = useCallback((): PreActionAnchor | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const anchor = computePagingAnchor(scroller, vsm, itemSelector);
    const snapshot: PreActionAnchor = {
      anchor,
      snapshotScrollTop: scroller.scrollTop,
      snapshotScrollHeight: scroller.scrollHeight,
      timestamp: Date.now(),
    };
    pendingAnchorRef.current = snapshot;
    return snapshot;
  }, [scrollerRef, vsm, itemSelector]);

  /** 在 Pre-paint 阶段应用微调并清除暂存 */
  const restoreSnapshot = useCallback(() => {
    const scroller = scrollerRef.current;
    const snapshot = pendingAnchorRef.current;
    if (scroller && snapshot?.anchor) {
      restorePagingAnchor(scroller, snapshot.anchor, vsm);
      pendingAnchorRef.current = null;
    }
  }, [scrollerRef, vsm, itemSelector]);

  /** 在执行任何剧烈改变高度的动作前调用 */
  const wrapAction = useCallback(
    <T>(action: () => T): T => {
      captureSnapshot();
      const res = action();
      setTick((t) => (t + 1) % 1000000);
      return res;
    },
    [captureSnapshot]
  );

  useLayoutEffect(() => {
    restoreSnapshot();
  });

  return {
    wrapAction,
    captureSnapshot,
    restoreSnapshot,
    pendingAnchorRef,
  };
}
