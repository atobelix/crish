/**
 * apps/crish-desktop/src/components/binary-tree/dockTabDragContext.tsx
 *
 * 右坞专属拖拽上下文控制器（Dock Split System Phase 3 架构）
 *
 * 核心机制：
 * 1. 挂载于每个会话的 DockSplitWorkspace 内部，绑定当前会话的右坞根容器 (.leafDockDrawer / .dockSplitWorkspace)；
 * 2. 复用底层纯数学几何与无状态 DOM 原语（sessionTabDragDom / sessionTabDragFeel）；
 * 3. 严格遵循物理包围盒硬围栏（Physical Bounding Fence）：移出右坞边界判定为 null，绝不触碰顶栏；
 * 4. 受控双阶段 Spring Snapback（180ms 弹簧回弹 + 250ms 兜底保险丝）；
 * 5. 放置成功时调用 commitDockDrop 执行不可变树结构更新。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  collectStripTabs,
  concealIndicator,
  createGhostPill,
  createIndicator,
  leaveStrip,
  posIndicator,
  shiftStripTabs,
  type CollectedStripData,
} from '../shell/sessionTabDragDom';
import {
  computeStripTabOffsets,
  exceedsSessionTabDragThresholdL1,
} from '../shell/sessionTabDragFeel';
import { detectDockDropZone, type DockDropTarget } from './detectDockDropZone';
import {
  moveDockTab,
  splitDockWithTab,
  type DockTree,
} from '../../store/storeAccess';

export interface StartDockDragArgs {
  readonly sourceLeafId: string;
  readonly tabId: string;
  readonly title: string;
  readonly e: React.PointerEvent;
}

export interface UseDockTabDragResult {
  readonly isDragging: boolean;
  readonly startDockDrag: (args: StartDockDragArgs) => void;
}

export interface DockTabDragProviderProps {
  readonly dockRootRef: React.RefObject<HTMLElement | null>;
  readonly dockTree?: DockTree;
  readonly onCommitTree?: (newTree: DockTree) => void;
  readonly children: ReactNode;
}

const NOOP_DOCK_DRAG: UseDockTabDragResult = {
  isDragging: false,
  startDockDrag: () => {},
};

const DockTabDragContext = createContext<UseDockTabDragResult | null>(null);

/**
 * 吞掉随后 click，避免源 tab 释放时触发激活
 */
function swallowNextClick(): void {
  const eat = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener('click', eat, { capture: true, once: true });
  window.setTimeout(() => {
    window.removeEventListener('click', eat, { capture: true });
  }, 0);
}

/**
 * 纯函数：应用落点变迁至 DockTree
 */
export function commitDockDrop(
  tree: DockTree,
  sourceLeafId: string,
  tabId: string,
  drop: DockDropTarget
): DockTree {
  if (drop.kind === 'tab-strip') {
    return moveDockTab(
      tree,
      sourceLeafId,
      tabId,
      drop.targetDockLeafId,
      drop.insertIndex
    );
  }

  return splitDockWithTab(
    tree,
    sourceLeafId,
    tabId,
    drop.targetDockLeafId,
    drop.kind
  );
}

export const DockTabDragProvider: React.FC<DockTabDragProviderProps> = ({
  dockRootRef,
  dockTree,
  onCommitTree,
  children,
}) => {
  const [isDragging, setIsDragging] = useState(false);

  // 全局逃逸清理句柄：组件卸载或异常中断时确保无 DOM 与监听残留
  const activeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      activeCleanupRef.current?.();
      activeCleanupRef.current = null;
    };
  }, []);

  // 使用 ref 保持树与提交回调最新引用，避免拖拽过程中的闭包陈旧问题
  const dockTreeRef = useRef<DockTree | undefined>(dockTree);
  dockTreeRef.current = dockTree;

  const onCommitTreeRef = useRef<((newTree: DockTree) => void) | undefined>(
    onCommitTree
  );
  onCommitTreeRef.current = onCommitTree;

  const startDockDrag = useCallback(
    ({ sourceLeafId, tabId, title, e }: StartDockDragArgs) => {
      if (e.button !== 0) return;
      if (!sourceLeafId || !tabId) return;

      // 排除点击关闭按钮或非标签主体的事件
      const closeBtn = (e.target as HTMLElement | null)?.closest?.(
        '[data-tab-close], button'
      );
      if (closeBtn) return;

      const sourceEl = (e.currentTarget as HTMLElement | null) ?? null;
      if (!sourceEl) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      // 抓取瞬间采集原始几何快照（用于 Spring Snapback 弹簧归巢）
      const sourceRect = sourceEl.getBoundingClientRect();
      const grabOffsetX = Math.max(
        10,
        Math.min(e.clientX - sourceRect.left, sourceRect.width - 10)
      );
      const grabOffsetY = Math.max(
        5,
        Math.min(e.clientY - sourceRect.top, sourceRect.height - 5)
      );

      try {
        sourceEl.setPointerCapture(pointerId);
      } catch {
        // 捕获失败由全局 window 监听保障
      }

      let dragging = false;
      let ghost: HTMLDivElement | null = null;
      let indicator: HTMLDivElement | null = null;
      let activeStrip: HTMLElement | null = null;
      let cachedStripData: CollectedStripData | null = null;
      let target: DockDropTarget | null = null;
      let rafId = 0;
      let pending: { x: number; y: number } | null = null;

      const flush = () => {
        rafId = 0;
        const p = pending;
        pending = null;
        if (!p || !ghost) return;

        // 更新 Ghost 随身胶囊位置
        ghost.style.transform = `translate3d(${p.x - grabOffsetX}px, ${p.y - grabOffsetY}px, 0)`;

        // 核心：在物理硬围栏内检测落点（超出边界立即返回 null）
        const nextTarget = detectDockDropZone(p, dockRootRef.current, {
          sourceLeafId,
          tabId,
        });

        target = nextTarget;

        if (!nextTarget) {
          // 越界态：隐藏指示器，标签复位，Ghost 挂载禁用光标与越界属性
          concealIndicator(indicator);
          leaveStrip(activeStrip);
          activeStrip = null;
          cachedStripData = null;
          ghost.setAttribute('data-out-of-bounds', 'true');
          ghost.style.cursor = 'not-allowed';
          return;
        }

        ghost.removeAttribute('data-out-of-bounds');
        ghost.style.cursor = '';

        if (nextTarget.kind === 'tab-strip') {
          // 查找目标窗格的标签栏
          const stripEl = dockRootRef.current?.querySelector(
            `[data-dock-tab-strip="true"][data-dock-leaf-id="${nextTarget.targetDockLeafId}"], [data-leaf-tool-tab-strip="true"][data-tab-strip-leaf-id="${nextTarget.targetDockLeafId}"]`
          ) as HTMLElement | null;

          if (stripEl && nextTarget.insertIndex !== undefined) {
            concealIndicator(indicator);
            if (activeStrip !== stripEl) {
              leaveStrip(activeStrip);
              activeStrip = stripEl;
              cachedStripData = null;
            }
            if (!cachedStripData) {
              cachedStripData = collectStripTabs(stripEl, tabId, 'data-tab-id');
            }
            const offsets = computeStripTabOffsets({
              tabCount: cachedStripData.tabs.length,
              sourceIndex: cachedStripData.sourceIndex,
              insertIndex: nextTarget.insertIndex,
              shiftPx: 120,
            });
            shiftStripTabs(cachedStripData.tabs, offsets);
          } else if (nextTarget.indicatorRect) {
            // 中心合并指示器
            leaveStrip(activeStrip);
            activeStrip = null;
            cachedStripData = null;
            if (indicator) {
              posIndicator(indicator, nextTarget.indicatorRect);
            }
          }
        } else if (nextTarget.indicatorRect) {
          // 分屏切分指示器
          leaveStrip(activeStrip);
          activeStrip = null;
          cachedStripData = null;
          if (indicator) {
            posIndicator(indicator, nextTarget.indicatorRect);
          }
        }
      };

      const onPointerMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (!dragging && exceedsSessionTabDragThresholdL1(dx, dy)) {
          dragging = true;
          setIsDragging(true);
          sourceEl.classList.add('is-dragging');
          ghost = createGhostPill(title, sourceRect.width, sourceRect.height);
          ghost.setAttribute('data-dock-drag-ghost', 'true');
          indicator = createIndicator(title);
          indicator.setAttribute('data-dock-drag-indicator', 'true');
        }

        if (!dragging) return;

        pending = { x: me.clientX, y: me.clientY };
        if (!rafId) {
          rafId = requestAnimationFrame(flush);
        }
      };

      // 阶段 1：即时解绑（Immediate Unbind）
      const detachImmediate = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('blur', onBlur);

        try {
          sourceEl.releasePointerCapture(pointerId);
        } catch {
          // 容错
        }

        sourceEl.classList.remove('is-dragging');
        leaveStrip(activeStrip);
        activeStrip = null;
        cachedStripData = null;
        concealIndicator(indicator);
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        setIsDragging(false);
      };

      // 阶段 2：受控 Spring Snapback 弹簧回弹动画（双保险看门狗销毁）
      let watchdogTimer = 0;
      const snapbackAndCleanup = () => {
        detachImmediate();
        if (!ghost) {
          activeCleanupRef.current = null;
          return;
        }

        const g = ghost;
        ghost = null;

        g.style.transition =
          'transform 180ms cubic-bezier(0.175, 0.885, 0.32, 1.15), opacity 180ms ease-out';
        g.style.transform = `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(0.96)`;
        g.style.opacity = '0';

        let removed = false;
        const finalize = () => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = 0;
          }
          if (removed) return;
          removed = true;
          activeCleanupRef.current = null;
          g.remove();
        };

        g.addEventListener('transitionend', finalize, { once: true });
        watchdogTimer = window.setTimeout(finalize, 250); // 250ms 兜底看门狗
      };

      // 注册卸载与异常断裂自愈逃逸句柄
      activeCleanupRef.current = () => {
        detachImmediate();
        if (ghost) {
          ghost.remove();
          ghost = null;
        }
      };

      const onPointerUp = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const drop = target;
        const wasDragging = dragging;

        if (wasDragging) {
          swallowNextClick();
        }

        if (!wasDragging || !drop) {
          // 无效落点 / 越界至顶栏：触发 Spring Snapback
          snapbackAndCleanup();
          return;
        }

        // 有效落点：立即解绑清理 DOM 并提交本地右坞事务
        detachImmediate();
        if (ghost) {
          ghost.remove();
          ghost = null;
        }
        activeCleanupRef.current = null;

        const currentTree = dockTreeRef.current;
        const commitFn = onCommitTreeRef.current;
        if (currentTree && commitFn) {
          const nextTree = commitDockDrop(
            currentTree,
            sourceLeafId,
            tabId,
            drop
          );
          commitFn(nextTree);
        }
      };

      const onPointerCancel = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        snapbackAndCleanup();
      };

      const onBlur = () => {
        snapbackAndCleanup();
      };

      const onKeyDown = (ke: KeyboardEvent) => {
        if (ke.key === 'Escape') {
          snapbackAndCleanup();
        }
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('blur', onBlur);
    },
    [dockRootRef]
  );

  const value = useMemo(
    () => ({ isDragging, startDockDrag }),
    [isDragging, startDockDrag]
  );

  return (
    <DockTabDragContext.Provider value={value}>
      {children}
    </DockTabDragContext.Provider>
  );
};

export function useDockTabDrag(): UseDockTabDragResult {
  const ctx = useContext(DockTabDragContext);
  return ctx ?? NOOP_DOCK_DRAG;
}
