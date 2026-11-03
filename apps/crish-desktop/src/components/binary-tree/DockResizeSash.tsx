/**
 * 右坞内部分割线（DockResizeSash.tsx）— 分割线统一波次 R3 迁移后形态
 *
 * 架构分工（统一 hook 与坞域能力的边界）：
 * 1. 手势协议由统一 hook `useSplitResize` 托管：指针捕获、window 级 move/up、
 *    rAF 节流、Esc 取消、blur / pointercancel 按提交当前值兜底、单一 body
 *    协议（data-split-resizing + 光标锁）。本组件不再自滚手势监听。
 * 2. 坞域能力全部保留为调用方专有层，不进统一 hook：
 *    - 比例域钳制单一真源 `calculateClampedRatio`（[0.2, 0.8] + 窗格最小像素
 *      保护 + >= 16px 物理防碰撞死区），hook 只提供指针增量（px），
 *      增量经本函数换算为比例——hook 的 px 坐标原点仅作增量基准，
 *      因此容器尺寸在手势开始时实测即可，不依赖渲染期量测新鲜度；
 *    - 拖拽期关联窗格 DOM 直写（findAssociatedPanes + paintLive）、
 *      `--dock-live-ratio-{branchId}` 容器变量与 `crish:layout-live-resize` 广播；
 *    - 全局透明遮罩 + iframe 指针屏蔽 + `dock-split-resizing-changed` 事件
 *      （nativeBrowserGeometry 的同步契约）与 body.dock-split-resizing 类
 *      （本组件 CSS 的全局联动协议）；
 *    - 键盘微调与双击均分：比例域语义（±2% / 50/50）与钳制同源，
 *      由本组件在 separatorProps 之上覆写同名处理器（hook 的 px 步进
 *      对比例域无意义，理由同 TreeResizeSash 的键盘自持）。
 * 3. 结束提交契约：坞域要求任何手势结束都提交一次当前比例（含失焦 /
 *    指针取消 / 松手未移动）；统一 hook 在「钳制值未变化」时不触发
 *    onCommit，故由 onDragStateChange 兜底补提交（Esc 取消除外——
 *    Esc 经捕获期监听标记，取消不提交、几何由 hook 的恢复回调还原）。
 * 4. 呈现：8px 热区本体 + 1px 中性发丝线；激活（hover / focus-visible /
 *    拖拽）仅走灰阶台阶 --border-subtle → --border-color，无辉光、无绿色
 *    （用户 2026-11-02 裁决：全站中性灰）。
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FlatDockBranch } from './flattenDockTree';
import type { NormalizedRect, SpatialDirection } from '../../store/layout-tree';
import {
  createDragOverlay,
  disableIframePointerEvents,
  removeDragOverlay,
} from '../../utils/dragOverlay';
import { useI18n } from '../../i18n';
import { useSplitResize } from '../../hooks/useSplitResize';
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

/**
 * 统一 hook 的 px 域宽界：坞域全部钳制由 calculateClampedRatio 承担，
 * hook 侧 min/max 仅需不截断任何真实指针行程（取远超屏幕行程的宽界），
 * 其 aria / Home / End 语义均由本组件覆写，不受宽界影响。
 */
const HOOK_WIDE_BOUND = 100_000;

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

/** 一次拖拽会话的坞域状态（手势本体在统一 hook 内，这里只存域侧账本） */
interface DockDragSession {
  /** 手势开始时的 splitRatio（增量换算与取消还原的基准） */
  startRatio: number;
  /** 手势开始时实测的容器尺寸（死区/最小窗格钳制的输入） */
  containerRect: { width: number; height: number };
  /** 最近一次实时换算出的比例（兜底提交用） */
  liveRatio: number;
  /** 本次手势是否已由 hook 的 onCommit 提交过 */
  commitSeen: boolean;
  /** 本次手势是否被 Esc 取消（捕获期监听标记，先于 hook 的结束回调） */
  escCancel: boolean;
}

export const DockResizeSash: React.FC<DockResizeSashProps> = React.memo(
  ({ branch, containerRef, onCommitRatio }) => {
    const { t } = useI18n();
    const sashRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLElement | null>(null);
    const restoreIframesRef = useRef<(() => void) | null>(null);
    const associatedPanesRef = useRef<{
      first: HTMLElement | null;
      second: HTMLElement | null;
    }>({ first: null, second: null });
    const sessionRef = useRef<DockDragSession | null>(null);

    const isHorizontal = branch.direction === 'horizontal';

    // 容器实测（与迁移前手势启动时的量测口径一致：rect 优先，client 兜底）
    const measureContainer = useCallback(() => {
      const container = containerRef.current;
      if (!container) return { width: 0, height: 0 };
      const rect = container.getBoundingClientRect();
      return {
        width: rect.width || container.clientWidth || 0,
        height: rect.height || container.clientHeight || 0,
      };
    }, [containerRef]);

    /**
     * hook 的 px 坐标原点：value = splitRatio × axisPx。axisPx 仅决定增量
     * 基准的数值尺度（增量 = livePx − dragStartPx，与原点无关），故以
     * calculateClampedRatio 同口径回退（500/400）初始化、渲染后实测校正
     * 即可，不需要事件级新鲜度。
     */
    const [axisPx, setAxisPx] = useState<number>(() => {
      const fallback = isHorizontal ? 500 : 400;
      const fraction = isHorizontal ? branch.rect.width : branch.rect.height;
      return fraction * fallback;
    });
    useLayoutEffect(() => {
      const size = measureContainer();
      const axis =
        (isHorizontal ? branch.rect.width : branch.rect.height) *
        (isHorizontal ? size.width : size.height);
      if (axis > 0) {
        setAxisPx((prev) => (Math.abs(prev - axis) > 0.5 ? axis : prev));
      }
    });

    // 1. 非拖拽态几何定位（拖拽期间由 paintLive 直写，避免 React 重渲染冲刷）
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

    // 组件卸载时安全回收全局状态（遮罩 / iframe / body 类）
    useEffect(() => {
      return () => {
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

    // 2. 实时比例 → sash 自身 + 关联窗格 DOM 直写（零 React 状态，零 store 写入）
    const paintLive = useCallback(
      (ratio: number) => {
        const sashEl = sashRef.current;
        if (sashEl) {
          if (isHorizontal) {
            sashEl.style.left = `${(branch.rect.x + branch.rect.width * ratio) * 100}%`;
          } else {
            sashEl.style.top = `${(branch.rect.y + branch.rect.height * ratio) * 100}%`;
          }
        }

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
        window.dispatchEvent(new Event('crish:layout-live-resize'));
      },
      [branch, isHorizontal, containerRef]
    );

    /** 指针增量（px）→ 钳制后比例：全部域钳制收敛于 calculateClampedRatio */
    const ratioFromDelta = useCallback(
      (deltaPx: number) => {
        const session = sessionRef.current;
        return calculateClampedRatio({
          direction: branch.direction,
          deltaPx,
          initialRatio: session?.startRatio ?? branch.splitRatio,
          branchRect: branch.rect,
          containerRect: session?.containerRect ?? measureContainer(),
        });
      },
      [branch.direction, branch.rect, branch.splitRatio, measureContainer]
    );

    // 3. 统一手势 hook（px 域仅作增量信道，域语义全部在本组件换算）
    const resize = useSplitResize({
      value: branch.splitRatio * axisPx,
      min: -HOOK_WIDE_BOUND,
      max: HOOK_WIDE_BOUND,
      orientation: isHorizontal ? 'vertical' : 'horizontal',
      commitMode: 'release',
      onLiveChange: (px) => {
        if (!sessionRef.current) return;
        const ratio = ratioFromDelta(
          px - resizeRef.current.dragStartValueRef.current
        );
        sessionRef.current.liveRatio = ratio;
        paintLive(ratio);
      },
      onCommit: (px) => {
        const session = sessionRef.current;
        if (!session) return;
        session.commitSeen = true;
        const ratio = ratioFromDelta(
          px - resizeRef.current.dragStartValueRef.current
        );
        session.liveRatio = ratio;
        onCommitRatio(branch.branchId, ratio);
      },
      onDragStateChange: (nowDragging) => {
        if (nowDragging) {
          // 手势开始：建立域会话（实测容器、锁定关联窗格、挂全局服务）
          sessionRef.current = {
            startRatio: branch.splitRatio,
            containerRect: measureContainer(),
            liveRatio: branch.splitRatio,
            commitSeen: false,
            escCancel: false,
          };
          associatedPanesRef.current = findAssociatedPanes(
            containerRef.current,
            branch,
            sashRef.current
          );
          document.body.classList.add('dock-split-resizing');
          overlayRef.current = createDragOverlay(
            isHorizontal ? 'col-resize' : 'row-resize'
          );
          restoreIframesRef.current = disableIframePointerEvents();
          window.dispatchEvent(
            new CustomEvent('dock-split-resizing-changed', {
              detail: { resizing: true, branchId: branch.branchId },
            })
          );
        } else {
          // 手势结束：回收全局服务并广播，随后按坞域契约兜底提交
          const session = sessionRef.current;
          sessionRef.current = null;
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
          if (session && !session.commitSeen && !session.escCancel) {
            onCommitRatio(branch.branchId, session.liveRatio);
          }
        }
      },
    });
    const resizeRef = useRef(resize);
    resizeRef.current = resize;
    const { dragging, separatorProps } = resize;

    // Esc 取消标记：捕获期监听先于 hook 的结束回调置位，供兜底提交判别
    useEffect(() => {
      if (!dragging) return;
      const onKeyDownCapture = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && sessionRef.current) {
          sessionRef.current.escCancel = true;
        }
      };
      window.addEventListener('keydown', onKeyDownCapture, {
        capture: true,
      });
      return () => {
        window.removeEventListener('keydown', onKeyDownCapture, {
          capture: true,
        });
      };
    }, [dragging]);

    // 4. 双击快速均分 50/50（比例域常量提交，覆写 hook 的 px 复位）
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onCommitRatio(branch.branchId, 0.5);
      },
      [branch.branchId, onCommitRatio]
    );

    // 5. 键盘微调（比例域步进 ±2%，与 calculateClampedRatio 同源钳制）
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

    const setSashRef = useCallback((node: HTMLDivElement | null) => {
      sashRef.current = node;
    }, []);

    return (
      <div
        ref={setSashRef}
        {...separatorProps}
        className={`${styles.sash} ${
          isHorizontal ? styles.horizontal : styles.vertical
        }`}
        data-dock-branch-id={branch.branchId}
        data-direction={branch.direction}
        data-resizing={dragging ? 'true' : undefined}
        aria-label={t(
          isHorizontal
            ? 'workspace.dock.adjustHorizontalRatio'
            : 'workspace.dock.adjustVerticalRatio',
          { ratio: (branch.splitRatio * 100).toFixed(0) }
        )}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(branch.splitRatio * 100)}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.line} aria-hidden="true" />
      </div>
    );
  },
  sashPropsEqual
);

DockResizeSash.displayName = 'DockResizeSash';
