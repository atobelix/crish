/**
 * 右坞内部分割线高性能拖拽引擎（DockResizeSash.tsx）
 *
 * 遵循系统性重构与零补丁原则：
 * 1. 采用 RAF 节流 + 百分比 DOM 直写（top/left/width/height %），拖拽中零 React 重渲染、零 Zustand 写状态；
 * 2. 严格落实 >= 16px 物理防碰撞死区缓冲（与外层 LeafDockResizer 保持物理安全距离）；
 * 3. 严格落实 [0.2, 0.8] 比例安全钳制与窗格最小像素保护（宽 >= 120px，高 >= 80px）；
 * 4. 拖拽期间挂载全局透明遮罩与 iframe 指针事件屏蔽，派发 dock-split-resizing-changed 事件；
 * 5. 支持双击 50/50 均分与键盘 Arrow 方向键微调。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FlatDockBranch } from './flattenDockTree';
import type { NormalizedRect, SpatialDirection } from '../../store/layout-tree';
import {
  createDragOverlay,
  disableIframePointerEvents,
  removeDragOverlay,
} from '../../utils/dragOverlay';
import { useI18n } from '../../i18n';
import styles from './DockResizeSash.module.css';

export interface DockResizeSashProps {
  branch: FlatDockBranch;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCommitRatio: (branchId: string, newRatio: number) => void;
}

export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const MIN_PANE_WIDTH = 120;
export const MIN_PANE_HEIGHT = 80;
export const DEADZONE_BUFFER_PX = 16;

export interface CalculateRatioParams {
  direction: SpatialDirection;
  deltaPx: number;
  initialRatio: number;
  branchRect: NormalizedRect;
  containerRect: { width: number; height: number };
  minChildPx?: number;
  deadzoneBufferPx?: number;
  minRatio?: number;
  maxRatio?: number;
}

/**
 * 纯数学几何比例计算与双重安全钳制函数（导出供单元测试直接断言）
 */
export function calculateClampedRatio({
  direction,
  deltaPx,
  initialRatio,
  branchRect,
  containerRect,
  minChildPx,
  deadzoneBufferPx = DEADZONE_BUFFER_PX,
  minRatio = MIN_SPLIT_RATIO,
  maxRatio = MAX_SPLIT_RATIO,
}: CalculateRatioParams): number {
  const isHorizontal = direction === 'horizontal';
  const containerW =
    Number.isFinite(containerRect.width) && containerRect.width > 0
      ? containerRect.width
      : 500;
  const containerH =
    Number.isFinite(containerRect.height) && containerRect.height > 0
      ? containerRect.height
      : 400;

  const branchW = branchRect.width * containerW;
  const branchH = branchRect.height * containerH;
  const axisPx = isHorizontal ? branchW : branchH;
  const effectiveAxisPx =
    Number.isFinite(axisPx) && axisPx > 0
      ? axisPx
      : isHorizontal
        ? containerW
        : containerH;

  // 1. 基础位移转换
  const deltaRatio = deltaPx / effectiveAxisPx;
  const rawRatio = initialRatio + deltaRatio;

  // 2. 窗格最小像素保护（宽 >= 120px，高 >= 80px）
  const defaultMinChildPx = isHorizontal ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  const requiredMinPx = minChildPx ?? defaultMinChildPx;
  const effectiveMinPx = Math.min(requiredMinPx, effectiveAxisPx / 2);
  const pixelMinRatio = effectiveMinPx / effectiveAxisPx;
  const pixelMaxRatio = 1 - pixelMinRatio;

  let lowerBound = Math.max(minRatio, pixelMinRatio);
  let upperBound = Math.min(maxRatio, pixelMaxRatio);

  // 3. 物理死区防碰撞缓冲（左右分屏下垂直分割线距容器左边缘 >= 16px）
  if (isHorizontal) {
    const deadzoneRatio =
      (deadzoneBufferPx - branchRect.x * containerW) / effectiveAxisPx;
    if (deadzoneRatio > 0) {
      lowerBound = Math.max(lowerBound, deadzoneRatio);
    }
  }

  // 边界安全收敛（当极端容器尺寸导致下限大于上限时，优雅折半锁定）
  if (lowerBound > upperBound) {
    lowerBound = upperBound = 0.5;
  }

  const clamped = Math.max(lowerBound, Math.min(upperBound, rawRatio));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * 分支属性按值相等比较，供 React.memo 性能优化
 */
export function flatDockBranchEqual(
  a: FlatDockBranch,
  b: FlatDockBranch
): boolean {
  if (a === b) return true;
  return (
    a.branchId === b.branchId &&
    a.direction === b.direction &&
    a.splitRatio === b.splitRatio &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height &&
    a.sash.x === b.sash.x &&
    a.sash.y === b.sash.y &&
    a.sash.length === b.sash.length
  );
}

export function sashPropsEqual(
  prev: DockResizeSashProps,
  next: DockResizeSashProps
): boolean {
  return (
    flatDockBranchEqual(prev.branch, next.branch) &&
    prev.containerRef === next.containerRef &&
    prev.onCommitRatio === next.onCommitRatio
  );
}

/**
 * 查找当前分割线前后关联的两个窗格 DOM 元素
 */
export function findAssociatedPanes(
  container: HTMLElement | null,
  branch: FlatDockBranch,
  sashEl: HTMLElement | null
): { first: HTMLElement | null; second: HTMLElement | null } {
  if (!container) return { first: null, second: null };

  // 1. 显式契约属性优先
  const firstByAttr = container.querySelector<HTMLElement>(
    `[data-dock-branch-first="${branch.branchId}"], [data-branch-child-first="${branch.branchId}"]`
  );
  const secondByAttr = container.querySelector<HTMLElement>(
    `[data-dock-branch-second="${branch.branchId}"], [data-branch-child-second="${branch.branchId}"]`
  );
  if (firstByAttr && secondByAttr) {
    return { first: firstByAttr, second: secondByAttr };
  }

  // 2. 匹配叶子标识
  let panes = Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-dock-leaf-id], [data-leaf-id], [data-pane-id]'
    )
  );

  // 3. 回退为容器内的窗格子元素
  if (panes.length === 0) {
    panes = Array.from(container.children).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el !== sashEl &&
        !el.hasAttribute('data-dock-branch-id') &&
        !el.classList.contains(styles.sash || '')
    );
  }

  if (panes.length === 0) return { first: null, second: null };

  const isH = branch.direction === 'horizontal';
  const getCoord = (el: HTMLElement) => {
    const leftStyle = parseFloat(el.style.left);
    const topStyle = parseFloat(el.style.top);
    if (isH && Number.isFinite(leftStyle)) return leftStyle;
    if (!isH && Number.isFinite(topStyle)) return topStyle;
    const r = el.getBoundingClientRect();
    return isH ? r.left : r.top;
  };

  if (panes.length === 2) {
    panes.sort((a, b) => getCoord(a) - getCoord(b));
    return { first: panes[0] ?? null, second: panes[1] ?? null };
  }

  // 超过 2 个窗格时，按几何贴合度精准匹配
  const sashTarget = isH ? branch.sash.x : branch.sash.y;
  let first: HTMLElement | null = null;
  let second: HTMLElement | null = null;
  let minDiffFirst = Infinity;
  let minDiffSecond = Infinity;

  for (const pane of panes) {
    const left = parseFloat(pane.style.left) / 100;
    const top = parseFloat(pane.style.top) / 100;
    const width = parseFloat(pane.style.width) / 100;
    const height = parseFloat(pane.style.height) / 100;

    if (isH) {
      const right = left + width;
      const diff1 = Math.abs(right - sashTarget);
      if (diff1 < minDiffFirst && left <= sashTarget + 0.01) {
        minDiffFirst = diff1;
        first = pane;
      }
      const diff2 = Math.abs(left - sashTarget);
      if (diff2 < minDiffSecond && right >= sashTarget - 0.01) {
        minDiffSecond = diff2;
        second = pane;
      }
    } else {
      const bottom = top + height;
      const diff1 = Math.abs(bottom - sashTarget);
      if (diff1 < minDiffFirst && top <= sashTarget + 0.01) {
        minDiffFirst = diff1;
        first = pane;
      }
      const diff2 = Math.abs(top - sashTarget);
      if (diff2 < minDiffSecond && bottom >= sashTarget - 0.01) {
        minDiffSecond = diff2;
        second = pane;
      }
    }
  }

  return { first, second };
}

export const DockResizeSash: React.FC<DockResizeSashProps> = React.memo(
  ({ branch, containerRef, onCommitRatio }) => {
    const { t } = useI18n();
    const sashRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const startCoordsRef = useRef({ x: 0, y: 0 });
    const startRatioRef = useRef(branch.splitRatio);
    const currentRatioRef = useRef(branch.splitRatio);
    const containerRectRef = useRef({ left: 0, top: 0, width: 0, height: 0 });
    const pendingPointerEventRef = useRef<
      PointerEvent | React.PointerEvent | null
    >(null);
    const rafIdRef = useRef<number | null>(null);
    const activePointerIdRef = useRef<number | null>(null);
    const overlayRef = useRef<HTMLElement | null>(null);
    const restoreIframesRef = useRef<(() => void) | null>(null);
    const associatedPanesRef = useRef<{
      first: HTMLElement | null;
      second: HTMLElement | null;
    }>({ first: null, second: null });

    const isHorizontal = branch.direction === 'horizontal';

    // 1. 非拖拽态几何定位（拖拽期间由 RAF 直接操控 DOM，避免 React 重渲染冲刷）
    useLayoutEffect(() => {
      const el = sashRef.current;
      if (!el || document.body.classList.contains('dock-split-resizing'))
        return;

      if (isHorizontal) {
        el.style.left = `${branch.sash.x * 100}%`;
        el.style.top = `${branch.sash.y * 100}%`;
        el.style.height = `${branch.sash.length * 100}%`;
        el.style.width = '';
      } else {
        el.style.top = `${branch.sash.y * 100}%`;
        el.style.left = `${branch.sash.x * 100}%`;
        el.style.width = `${branch.sash.length * 100}%`;
        el.style.height = '';
      }
    }, [isHorizontal, branch.sash.x, branch.sash.y, branch.sash.length]);

    // 同步外部稳态 splitRatio
    useEffect(() => {
      if (!isDraggingRef.current) {
        currentRatioRef.current = branch.splitRatio;
      }
    }, [branch.splitRatio]);

    // 组件卸载时安全回收全局状态与看门狗
    useEffect(() => {
      return () => {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        if (overlayRef.current) {
          removeDragOverlay(overlayRef.current);
          overlayRef.current = null;
        }
        if (restoreIframesRef.current) {
          restoreIframesRef.current();
          restoreIframesRef.current = null;
        }
        document.body.classList.remove('dock-split-resizing');
      };
    }, []);

    // 2. DOM 直写关联窗格
    const updateAssociatedPanesDom = useCallback(
      (ratio: number) => {
        const { first, second } = associatedPanesRef.current;
        const { rect } = branch;

        if (isHorizontal) {
          if (first) {
            first.style.width = `${rect.width * ratio * 100}%`;
          }
          if (second) {
            second.style.left = `${(rect.x + rect.width * ratio) * 100}%`;
            second.style.width = `${rect.width * (1 - ratio) * 100}%`;
          }
        } else {
          if (first) {
            first.style.height = `${rect.height * ratio * 100}%`;
          }
          if (second) {
            second.style.top = `${(rect.y + rect.height * ratio) * 100}%`;
            second.style.height = `${rect.height * (1 - ratio) * 100}%`;
          }
        }

        if (containerRef.current) {
          containerRef.current.style.setProperty(
            `--dock-live-ratio-${branch.branchId}`,
            String(ratio)
          );
        }
      },
      [branch, isHorizontal, containerRef]
    );

    // 3. onPointerDown 启动拖拽
    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const sashEl = sashRef.current;
        if (!sashEl) return;

        // Pointer Capture 锁死
        try {
          sashEl.setPointerCapture(e.pointerId);
          activePointerIdRef.current = e.pointerId;
        } catch {
          /* jsdom 或环境降级 */
        }

        isDraggingRef.current = true;
        startCoordsRef.current = { x: e.clientX, y: e.clientY };
        startRatioRef.current = branch.splitRatio;
        currentRatioRef.current = branch.splitRatio;

        const container = containerRef.current;
        if (container) {
          const cRect = container.getBoundingClientRect();
          containerRectRef.current = {
            left: cRect.left,
            top: cRect.top,
            width: cRect.width || container.clientWidth || 0,
            height: cRect.height || container.clientHeight || 0,
          };
        } else {
          containerRectRef.current = { left: 0, top: 0, width: 0, height: 0 };
        }

        // 查找关联窗格
        associatedPanesRef.current = findAssociatedPanes(
          container,
          branch,
          sashEl
        );

        // 挂载激活态标记与全局透明遮罩
        sashEl.setAttribute('data-resizing', 'true');
        document.body.classList.add('dock-split-resizing');

        const cursor = isHorizontal ? 'col-resize' : 'row-resize';
        overlayRef.current = createDragOverlay(cursor);
        restoreIframesRef.current = disableIframePointerEvents();

        // 广播看门狗事件（通知 Webview 禁用 Hit-Test）
        window.dispatchEvent(
          new CustomEvent('dock-split-resizing-changed', {
            detail: { resizing: true, branchId: branch.branchId },
          })
        );
      },
      [branch, isHorizontal, containerRef]
    );

    // 4. onPointerMove RAF 节流直写
    const handlePointerMove = useCallback(
      (e: PointerEvent | React.PointerEvent) => {
        if (!isDraggingRef.current) return;

        pendingPointerEventRef.current = e;

        const deltaX = e.clientX - startCoordsRef.current.x;
        const deltaY = e.clientY - startCoordsRef.current.y;
        const deltaPx = isHorizontal ? deltaX : deltaY;

        const newRatio = calculateClampedRatio({
          direction: branch.direction,
          deltaPx,
          initialRatio: startRatioRef.current,
          branchRect: branch.rect,
          containerRect: containerRectRef.current,
        });

        // 同步更新 ratio 引用（确保 pointerup 瞬时提交准确）
        currentRatioRef.current = newRatio;

        // RAF 调度更新 DOM 样式（零 React 状态，零 Zustand 写入）
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            if (!isDraggingRef.current) return;

            const ratio = currentRatioRef.current;
            const sashEl = sashRef.current;
            if (sashEl) {
              if (isHorizontal) {
                const sashX = (branch.rect.x + branch.rect.width * ratio) * 100;
                sashEl.style.left = `${sashX}%`;
              } else {
                const sashY =
                  (branch.rect.y + branch.rect.height * ratio) * 100;
                sashEl.style.top = `${sashY}%`;
              }
            }

            updateAssociatedPanesDom(ratio);
            window.dispatchEvent(new Event('crish:layout-live-resize'));
          });
        }
      },
      [branch, isHorizontal, updateAssociatedPanesDom]
    );

    // 5. onPointerUp / onPointerCancel 结束并提交
    const handlePointerEnd = useCallback(
      (e?: PointerEvent | React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingPointerEventRef.current = null;

        const sashEl = sashRef.current;
        const pointerId =
          activePointerIdRef.current ??
          (e && 'pointerId' in e ? e.pointerId : null);

        // 释放 PointerCapture
        if (sashEl && pointerId !== null) {
          try {
            if (typeof sashEl.hasPointerCapture === 'function') {
              if (sashEl.hasPointerCapture(pointerId)) {
                sashEl.releasePointerCapture(pointerId);
              }
            } else if (typeof sashEl.releasePointerCapture === 'function') {
              sashEl.releasePointerCapture(pointerId);
            }
          } catch {
            /* ignore */
          }
        }
        activePointerIdRef.current = null;

        if (sashEl) {
          sashEl.removeAttribute('data-resizing');
        }
        document.body.classList.remove('dock-split-resizing');

        if (overlayRef.current) {
          removeDragOverlay(overlayRef.current);
          overlayRef.current = null;
        }
        if (restoreIframesRef.current) {
          restoreIframesRef.current();
          restoreIframesRef.current = null;
        }

        window.dispatchEvent(
          new CustomEvent('dock-split-resizing-changed', {
            detail: { resizing: false, branchId: branch.branchId },
          })
        );
        window.dispatchEvent(new Event('crish:layout-live-resize'));

        const finalRatio = currentRatioRef.current;
        onCommitRatio(branch.branchId, finalRatio);
      },
      [branch.branchId, onCommitRatio]
    );

    // 6. 全局 Window 事件兜底（防失焦、防丢失 pointerup）
    useEffect(() => {
      const onWindowPointerMove = (ev: PointerEvent) => {
        if (isDraggingRef.current) {
          handlePointerMove(ev);
        }
      };
      const onWindowPointerUp = (ev: PointerEvent) => {
        if (isDraggingRef.current) {
          handlePointerEnd(ev);
        }
      };
      const onWindowPointerCancel = (ev: PointerEvent) => {
        if (isDraggingRef.current) {
          handlePointerEnd(ev);
        }
      };
      const onWindowBlur = () => {
        if (isDraggingRef.current) {
          handlePointerEnd();
        }
      };

      window.addEventListener('pointermove', onWindowPointerMove);
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerCancel);
      window.addEventListener('blur', onWindowBlur);

      return () => {
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerCancel);
        window.removeEventListener('blur', onWindowBlur);
      };
    }, [handlePointerMove, handlePointerEnd]);

    // 7. 双击快速均分 50/50
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onCommitRatio(branch.branchId, 0.5);
      },
      [branch.branchId, onCommitRatio]
    );

    // 8. 键盘微调（ArrowLeft/Right/Up/Down）
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const step = 0.02;
        let delta = 0;
        if (isHorizontal) {
          if (e.key === 'ArrowLeft') delta = -step;
          else if (e.key === 'ArrowRight') delta = step;
          else if (e.key === 'Home') delta = -1;
          else if (e.key === 'End') delta = 1;
        } else {
          if (e.key === 'ArrowUp') delta = -step;
          else if (e.key === 'ArrowDown') delta = step;
          else if (e.key === 'Home') delta = -1;
          else if (e.key === 'End') delta = 1;
        }

        if (delta !== 0) {
          e.preventDefault();
          const container = containerRef.current;
          const cWidth = container?.clientWidth || 500;
          const cHeight = container?.clientHeight || 400;
          const deltaPx =
            delta === -1 || delta === 1
              ? delta * 1000
              : delta * (isHorizontal ? cWidth : cHeight);

          const newRatio = calculateClampedRatio({
            direction: branch.direction,
            deltaPx,
            initialRatio: branch.splitRatio,
            branchRect: branch.rect,
            containerRect: { width: cWidth, height: cHeight },
          });

          onCommitRatio(branch.branchId, newRatio);
        }
      },
      [branch, isHorizontal, containerRef, onCommitRatio]
    );

    return (
      <div
        ref={sashRef}
        className={`${styles.sash} ${
          isHorizontal ? styles.horizontal : styles.vertical
        }`}
        data-dock-branch-id={branch.branchId}
        data-direction={branch.direction}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label={t(
          isHorizontal
            ? 'workspace.dock.adjustHorizontalRatio'
            : 'workspace.dock.adjustVerticalRatio',
          { ratio: (branch.splitRatio * 100).toFixed(0) }
        )}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(branch.splitRatio * 100)}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />
    );
  },
  sashPropsEqual
);

DockResizeSash.displayName = 'DockResizeSash';
