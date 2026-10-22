/**
 * useSessionListDrag.ts — 侧栏会话拖拽重排序与跨域分屏引擎
 *
 * 架构规范（对齐 02a3e75d 纯 React 状态驱动模型 + 跨域分屏）：
 * 1. 彻底清退 DOM 级 style.transform 强行突变，所有会话行保持自然文档流；
 * 2. 拖拽过程中仅通过 dragPreview 触发 React 乐观重排，零物理震荡、零多区域抽搐；
 * 3. 仅当 previewKey 实质变更时才更新状态，避免无谓重渲染；
 * 4. 完美融合右侧跨域分屏探测（resolveCrossDomainTarget 与 commitSidebarSessionDrop）；
 * 5. 松手时原子提交 Store 持久化，平滑无缝衔接。
 */

import React, { useCallback, useRef, useState } from 'react';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import { useLayoutTreeStore } from '../../../store/storeAccess';
import styles from '../SidebarSessionList.module.css';
import type { SidebarDragItem } from './sessionListTypes';
import {
  resolveCrossDomainTarget,
  type CrossDomainTarget,
} from '../../shell/drag-engine/crossDomainDropRouter';
import { commitSidebarSessionDrop } from '../../shell/sidebarSessionDropCommit';
import { paneDropIndicatorRect } from '../../shell/sessionTabDragFeel';
import {
  concealIndicator,
  createIndicator,
  indicatorClasses,
  posIndicator,
} from '../../shell/sessionTabDragDom';
import {
  type DropPlace,
  type DropIndicator,
  type SessionDragPreview,
  DRAG_THRESHOLD_PX,
  DEFAULT_ROW_STEP_PX,
  DEFAULT_TAB_STEP_PX,
  applyDragPreview,
  isPreviewTargetSection,
  createSidebarSessionGhost,
  swallowNextClick,
} from './useSessionListDragHelpers';
import {
  folderContainerSelector,
  isGeneralFolderName,
  resolveDropTarget,
  resolveInsertBeforeIdAfter,
} from './sessionListDropTarget';
import { shiftRowsForDrag } from './sessionListDragShift';

export {
  type DropPlace,
  type DropIndicator,
  type SessionDragPreview,
  DRAG_THRESHOLD_PX,
  DEFAULT_ROW_STEP_PX,
  DEFAULT_TAB_STEP_PX,
  applyDragPreview,
  isPreviewTargetSection,
  createSidebarSessionGhost,
  swallowNextClick,
};

export type UseSessionListDragOpts = {
  pinnedZoneRef: React.RefObject<HTMLElement | null>;
  sessionListRef: React.RefObject<HTMLElement | null>;
  renamingSessionId: string | null;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
};

export type UseSessionListDragResult = {
  activeDragItem: SidebarDragItem | null;
  dragOverPinned: boolean;
  dropIndicator: DropIndicator | null;
  dragPreview: SessionDragPreview | null;
  startSessionDrag: (
    e: React.PointerEvent,
    sessionId: string,
    folderName?: string
  ) => void;
};

type LastCommit = {
  targetSessionId: string | null;
  folder: string;
  isPinned: boolean;
};

/** 分屏 / 标签条落点的跨域提交（侧栏内部落点由调用方走乐观重排提交）。 */
function commitCrossDomainDrop(
  sessionId: string,
  target: CrossDomainTarget,
  stripInsertIdx: number
): void {
  if (target.domain === 'pane-split') {
    commitSidebarSessionDrop({
      sessionId,
      target: {
        kind: 'pane',
        targetLeafId: target.targetLeafId,
        region: target.region,
      },
    });
    return;
  }
  if (target.domain === 'tab-strip') {
    commitSidebarSessionDrop({
      sessionId,
      target: {
        kind: 'strip',
        targetLeafId: target.targetLeafId,
        insertIdx: stripInsertIdx,
      },
    });
  }
}

export function useSessionListDrag(
  opts: UseSessionListDragOpts
): UseSessionListDragResult {
  const { pinnedZoneRef, renamingSessionId, onMoveSessionRealtime } = opts;

  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(
    null
  );
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null
  );
  const [dragPreview, setDragPreview] = useState<SessionDragPreview | null>(
    null
  );

  const onMoveRef = useRef(onMoveSessionRealtime);
  onMoveRef.current = onMoveSessionRealtime;
  const pinnedZoneRefStable = useRef(pinnedZoneRef);
  pinnedZoneRefStable.current = pinnedZoneRef;

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0 || renamingSessionId === sessionId) return;

      const targetEl = e.currentTarget as HTMLElement;
      const pointerId = e.pointerId;
      try {
        targetEl.setPointerCapture?.(pointerId);
      } catch {
        /* ignore */
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const originFolder = (folderName && folderName.trim()) || GENERAL_FOLDER;

      let dragging = false;
      let ghostEl: HTMLDivElement | null = null;
      let indicatorEl: HTMLDivElement | null = null;
      let raf = 0;
      let pendingPointer: {
        x: number;
        y: number;
        dx: number;
        dy: number;
      } | null = null;
      let lastCommit: LastCommit | null = null;
      let lastPreviewKey = '';
      let lastAppliedTarget: CrossDomainTarget | null = null;
      let currentStripInsertIdx = 0;
      let lastPlace: DropPlace = 'before';
      let lastClientY = startY;
      let shiftedElements: HTMLElement[] = [];

      const rowLi = (e.currentTarget as HTMLElement).closest(
        'li'
      ) as HTMLElement | null;
      const sourceContainer =
        rowLi?.closest('[data-drop-zone="pinned"]') ||
        rowLi?.closest('[data-folder-name]') ||
        rowLi?.closest('[data-drop-zone="general"]') ||
        null;

      const clearAllShifts = () => {
        for (const el of shiftedElements) {
          el.style.transform = '';
          el.style.transition = '';
        }
        shiftedElements = [];
      };
      const rowRect =
        rowLi?.getBoundingClientRect() ??
        ({
          left: startX,
          top: startY,
          width: 240,
          height: 28,
        } as DOMRect);

      const grabOffsetX = startX - rowRect.left;
      const grabOffsetY = startY - rowRect.top;

      const hideIndicator = () => {
        concealIndicator(indicatorEl);
      };

      const showPaneIndicator = (
        rect: { left: number; top: number; width: number; height: number },
        region: 'left' | 'right' | 'top' | 'bottom' | 'center'
      ) => {
        if (!indicatorEl) {
          indicatorEl = createIndicator('分屏');
          if (indicatorClasses.pane) {
            indicatorEl.classList.add(indicatorClasses.pane);
          }
        }
        posIndicator(indicatorEl, paneDropIndicatorRect(region, rect));
      };

      const applyPointer = (
        clientX: number,
        clientY: number,
        dx: number,
        dy: number
      ) => {
        if (!dragging) return;

        // 1. 同步 Ghost 物理位置（GPU translate3d）
        if (ghostEl) {
          ghostEl.style.transform = `translate3d(${clientX - grabOffsetX}px, ${clientY - grabOffsetY}px, 0)`;
        }

        // 2. 空间跨域落点探测（分屏优先）
        const tree = useLayoutTreeStore.getState().tree;
        const target = resolveCrossDomainTarget(
          clientX,
          clientY,
          dx,
          dy,
          sessionId,
          tree
        );
        lastAppliedTarget = target;

        if (target.domain === 'pane-split') {
          clearAllShifts();
          setDragOverPinned(false);
          setDragPreview(null);
          setDropIndicator(null);
          lastPreviewKey = '';
          showPaneIndicator(target.paneRect, target.region);
          if (ghostEl) ghostEl.style.opacity = '0.95';
          return;
        }

        if (target.domain === 'tab-strip') {
          clearAllShifts();
          setDragOverPinned(false);
          setDragPreview(null);
          setDropIndicator(null);
          lastPreviewKey = '';
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.95';
          currentStripInsertIdx = target.insertIndex;
          return;
        }

        // 3. 侧栏内部基于 dragPreview 的纯净 React 乐观重排
        hideIndicator();
        if (ghostEl) ghostEl.style.opacity = '0.95';

        const instantDy = clientY - lastClientY;
        lastClientY = clientY;

        const hit = resolveDropTarget(
          clientX,
          clientY,
          sessionId,
          pinnedZoneRefStable.current.current,
          originFolder,
          lastPlace,
          instantDy
        );
        lastPlace = hit.place;

        const overId = hit.targetSessionId;

        const isPinned = hit.overPinned;
        const folder = isPinned
          ? originFolder
          : isGeneralFolderName(hit.folder)
            ? GENERAL_FOLDER
            : hit.folder;

        setDragOverPinned(isPinned);

        const preview: SessionDragPreview = {
          sessionId,
          overSessionId: overId,
          place: hit.place,
          isPinned,
          folder,
        };

        const previewKey = `${preview.overSessionId ?? ''}|${preview.place}|${preview.isPinned}|${preview.folder}`;
        if (previewKey !== lastPreviewKey) {
          lastPreviewKey = previewKey;
          setDropIndicator(
            overId ? { sessionId: overId, place: hit.place } : null
          );
        }

        const insertBeforeId =
          overId && hit.place === 'after'
            ? resolveInsertBeforeIdAfter(sessionId, overId, isPinned, folder)
            : overId;

        lastCommit = {
          targetSessionId: insertBeforeId,
          folder,
          isPinned,
        };

        // 4. 在当前活动容器内驱动平滑 1D 滑动让位动效 (140ms cubic-bezier)
        const activeContainer = isPinned
          ? pinnedZoneRefStable.current.current
          : (document.querySelector(
              folderContainerSelector(folder)
            ) as HTMLElement | null);

        if (activeContainer) {
          const nextShifted = shiftRowsForDrag({
            activeContainer,
            sourceContainer,
            sessionId,
            overId,
            place: hit.place,
            stepPx: DEFAULT_ROW_STEP_PX,
            foldToggleClass: styles.foldToggleRow,
          });

          for (const el of shiftedElements) {
            if (!nextShifted.includes(el)) {
              el.style.transform = '';
              el.style.transition = '';
            }
          }
          shiftedElements = nextShifted;
        }
      };

      const scheduleApply = (
        clientX: number,
        clientY: number,
        dx: number,
        dy: number
      ) => {
        pendingPointer = { x: clientX, y: clientY, dx, dy };
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const p = pendingPointer;
          pendingPointer = null;
          if (p) applyPointer(p.x, p.y, p.dx, p.dy);
        });
      };

      const move = (me: PointerEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          dragging = true;
          try {
            me.preventDefault?.();
          } catch {
            /* ignore */
          }
          document.body.classList.add('sidebar-dragging');

          if (rowLi) {
            ghostEl = createSidebarSessionGhost(rowLi, rowRect);
            rowLi.classList.add(styles.isDraggingSource || 'isDraggingSource');
          }

          setActiveDragItem({
            type: 'session',
            sessionId,
            ...(folderName !== undefined ? { folderName } : {}),
          });

          applyPointer(me.clientX, me.clientY, dx, dy);
        }

        if (!dragging) return;
        scheduleApply(me.clientX, me.clientY, dx, dy);
      };

      const cleanup = () => {
        try {
          targetEl.releasePointerCapture?.(pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', handleKeyDown);

        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }
        if (indicatorEl) {
          indicatorEl.remove();
          indicatorEl = null;
        }
        if (rowLi) {
          rowLi.classList.remove(styles.isDraggingSource || 'isDraggingSource');
        }
        document.body.classList.remove('sidebar-dragging');
        clearAllShifts();
        setActiveDragItem(null);
        setDragOverPinned(false);
        setDropIndicator(null);
        setDragPreview(null);
      };

      const cancel = () => {
        cleanup();
      };

      const handleKeyDown = (ke: KeyboardEvent) => {
        if (ke.key === 'Escape') {
          cancel();
        }
      };

      const up = (ue: PointerEvent) => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }

        if (dragging) {
          swallowNextClick();
          applyPointer(
            ue.clientX,
            ue.clientY,
            ue.clientX - startX,
            ue.clientY - startY
          );

          if (lastAppliedTarget?.domain === 'sidebar') {
            if (lastCommit) {
              onMoveRef.current(
                sessionId,
                lastCommit.targetSessionId,
                lastCommit.folder,
                lastCommit.isPinned
              );
            }

            if (ghostEl) {
              ghostEl.style.transition = 'opacity 80ms ease-out';
              ghostEl.style.opacity = '0';
            }

            requestAnimationFrame(() => {
              cleanup();
            });
            return;
          }
          if (lastAppliedTarget) {
            commitCrossDomainDrop(
              sessionId,
              lastAppliedTarget,
              currentStripInsertIdx
            );
          }
        }

        cleanup();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', handleKeyDown);
    },
    [renamingSessionId]
  );

  return {
    activeDragItem,
    dragOverPinned,
    dropIndicator,
    dragPreview,
    startSessionDrag,
  };
}
