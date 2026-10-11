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
import type { SessionState } from '../../../store/types';
import { useLayoutTreeStore } from '../../../store/storeAccess';
import styles from '../SidebarSessionList.module.css';
import type { SidebarDragItem } from './sessionListTypes';
import {
  resolveCrossDomainTarget,
  type CrossDomainTarget,
} from '../../shell/drag-engine/crossDomainDropRouter';
import { commitSidebarSessionDrop } from '../../shell/sidebarSessionDropCommit';
import { paneDropIndicatorRect } from '../../shell/sessionTabDragFeel';
import { createIndicator } from '../../shell/sessionTabDragDom';
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

function previewToInsertBeforeId(
  sectionIds: string[],
  overSessionId: string | null,
  place: DropPlace
): string | null {
  if (!overSessionId) return null;
  const idx = sectionIds.indexOf(overSessionId);
  if (idx === -1) return overSessionId;
  if (place === 'before') return overSessionId;
  const next = sectionIds[idx + 1];
  return next ?? null;
}

function isGeneralFolderName(folder: string | null | undefined): boolean {
  const f = (folder || '').trim();
  return (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  );
}

function resolveDropTarget(
  clientX: number,
  clientY: number,
  selfSessionId: string,
  pinnedZone: HTMLElement | null,
  fallbackFolder: string,
  lastPlace: DropPlace,
  instantDy: number
): {
  overPinned: boolean;
  targetSessionId: string | null;
  place: DropPlace;
  folder: string;
} {
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(clientX, clientY) as Element[])
      : ([document.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[]);

  let hovered: Element | null = null;
  const ghostClass = styles.sidebarDragGhost || 'sidebar-drag-ghost';
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    if (
      node.classList.contains(ghostClass) ||
      node.classList.contains('sidebar-drag-ghost') ||
      node.closest(`.${ghostClass}`) ||
      node.closest('.sidebar-drag-ghost')
    ) {
      continue;
    }
    // 关键防抖：穿透正在被拖拽的源项自身（杜绝将自身识别为落点而引发跳跃到末尾）
    const row = node.closest('[data-session-id]') as HTMLElement | null;
    if (row?.getAttribute('data-session-id') === selfSessionId) {
      continue;
    }
    hovered = node;
    break;
  }

  if (!hovered) {
    return {
      overPinned: false,
      targetSessionId: null,
      place: lastPlace,
      folder: fallbackFolder,
    };
  }

  const overPinned = Boolean(
    hovered.closest('[data-drop-zone="pinned"]') ||
      (styles.pinnedDropZone && hovered.closest(`.${styles.pinnedDropZone}`)) ||
      (styles.pinnedList && hovered.closest(`.${styles.pinnedList}`) && pinnedZone?.contains(hovered)) ||
      (pinnedZone && (hovered === pinnedZone || pinnedZone.contains(hovered as Node)))
  );

  const sessionWrap = hovered.closest('[data-session-id]') as HTMLElement | null;
  let targetSessionId: string | null =
    sessionWrap?.getAttribute('data-session-id') || null;
  if (targetSessionId === selfSessionId) {
    targetSessionId = null;
  }

  let place: DropPlace = lastPlace;

  // 1. 命中具体会话行时的滞后死区防抖（Hysteresis Deadband 35% ~ 65%）
  if (sessionWrap && targetSessionId) {
    const rect = sessionWrap.getBoundingClientRect();
    if (rect.height > 0) {
      const relY = clientY - rect.top;
      const ratio = relY / rect.height;

      if (ratio < 0.35) {
        place = 'before';
      } else if (ratio > 0.65) {
        place = 'after';
      } else {
        // 处于 35% ~ 65% 的黄金死区：根据明确运动趋势切换；微动或静止时绝对保持上一帧状态，消除震荡
        if (instantDy > 1.5) {
          place = 'after';
        } else if (instantDy < -1.5) {
          place = 'before';
        } else {
          place = lastPlace;
        }
      }
    }
  }

  const folderEl = hovered.closest('[data-folder-name]') as HTMLElement | null;
  const generalZone = hovered.closest('[data-drop-zone="general"]') as HTMLElement | null;
  let folder = fallbackFolder;

  if (overPinned) {
    folder = fallbackFolder || GENERAL_FOLDER;
  } else if (folderEl) {
    folder = folderEl.getAttribute('data-folder-name') || fallbackFolder || GENERAL_FOLDER;
  } else if (generalZone) {
    folder = GENERAL_FOLDER;
  } else if (isGeneralFolderName(fallbackFolder)) {
    folder = GENERAL_FOLDER;
  }

  // 2. 容器边缘与间隙投影兜底：当未精准命中具体 li 时，吸附到该容器的最近项或首尾
  if (!targetSessionId) {
    const activeZone = overPinned
      ? pinnedZone
      : (folderEl?.querySelector('ul') || generalZone?.querySelector('ul') || folderEl || generalZone);

    if (activeZone) {
      const candidateRows = Array.from(
        activeZone.querySelectorAll<HTMLElement>('li[data-session-id]')
      ).filter(
        (r) =>
          r.getAttribute('data-session-id') !== selfSessionId &&
          r.offsetParent !== null &&
          r.getBoundingClientRect().height > 0
      );

      if (candidateRows.length > 0) {
        const first = candidateRows[0]!;
        const last = candidateRows[candidateRows.length - 1]!;
        const firstRect = first.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();

        if (clientY < firstRect.top + firstRect.height * 0.5) {
          targetSessionId = first.getAttribute('data-session-id');
          place = 'before';
        } else if (clientY > lastRect.bottom - lastRect.height * 0.5) {
          targetSessionId = last.getAttribute('data-session-id');
          place = 'after';
        } else {
          let closest = candidateRows[0]!;
          let minDist = Infinity;
          for (const r of candidateRows) {
            const b = r.getBoundingClientRect();
            const dist = Math.abs(clientY - (b.top + b.height / 2));
            if (dist < minDist) {
              minDist = dist;
              closest = r;
            }
          }
          targetSessionId = closest.getAttribute('data-session-id');
          const cRect = closest.getBoundingClientRect();
          place = clientY < cRect.top + cRect.height / 2 ? 'before' : 'after';
        }
      }
    }
  }

  return { overPinned, targetSessionId, place, folder };
}

export function useSessionListDrag(
  opts: UseSessionListDragOpts
): UseSessionListDragResult {
  const { pinnedZoneRef, renamingSessionId, onMoveSessionRealtime } = opts;

  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [dragPreview, setDragPreview] = useState<SessionDragPreview | null>(null);

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
      let pendingPointer: { x: number; y: number; dx: number; dy: number } | null = null;
      let lastCommit: LastCommit | null = null;
      let lastPreviewKey = '';
      let lastAppliedTarget: CrossDomainTarget | null = null;
      let currentStripInsertIdx = 0;
      let lastPlace: DropPlace = 'before';
      let lastClientY = startY;
      let shiftedElements: HTMLElement[] = [];

      const rowLi = (e.currentTarget as HTMLElement).closest('li') as HTMLElement | null;
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
      const rowRect = rowLi?.getBoundingClientRect() ?? ({
        left: startX,
        top: startY,
        width: 240,
        height: 28,
      } as DOMRect);

      const grabOffsetX = startX - rowRect.left;
      const grabOffsetY = startY - rowRect.top;

      const hideIndicator = () => {
        if (indicatorEl) {
          indicatorEl.style.display = 'none';
        }
      };

      const showPaneIndicator = (
        rect: { left: number; top: number; width: number; height: number },
        region: 'left' | 'right' | 'top' | 'bottom' | 'center'
      ) => {
        if (!indicatorEl) {
          indicatorEl = createIndicator('分屏');
        }
        const indRect = paneDropIndicatorRect(region, rect);
        indicatorEl.style.display = 'block';
        indicatorEl.style.left = `${indRect.left}px`;
        indicatorEl.style.top = `${indRect.top}px`;
        indicatorEl.style.width = `${indRect.width}px`;
        indicatorEl.style.height = `${indRect.height}px`;
      };

      const applyPointer = (clientX: number, clientY: number, dx: number, dy: number) => {
        if (!dragging) return;

        // 1. 同步 Ghost 物理位置（GPU translate3d）
        if (ghostEl) {
          ghostEl.style.transform = `translate3d(${clientX - grabOffsetX}px, ${clientY - grabOffsetY}px, 0)`;
        }

        // 2. 空间跨域落点探测（分屏优先）
        const tree = useLayoutTreeStore.getState().tree;
        const target = resolveCrossDomainTarget(clientX, clientY, dx, dy, sessionId, tree);
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

        let insertBeforeId: string | null = overId;
        if (overId && hit.place === 'after') {
          const listRoot =
            (document.querySelector(
              isPinned
                ? '[data-drop-zone="pinned"]'
                : isGeneralFolderName(folder)
                  ? '[data-drop-zone="general"]'
                  : `[data-folder-name="${CSS.escape ? CSS.escape(folder) : folder.replace(/"/g, '\\"')}"]`
            ) as HTMLElement | null) || null;
          const ids = listRoot
            ? Array.from(
                listRoot.querySelectorAll<HTMLElement>('[data-session-id]')
              )
                .map((n) => n.getAttribute('data-session-id') || '')
                .filter((id) => id && id !== sessionId)
            : [];
          insertBeforeId = previewToInsertBeforeId(ids, overId, 'after');
        }

        lastCommit = {
          targetSessionId: insertBeforeId,
          folder,
          isPinned,
        };

        // 4. 在当前活动容器内驱动平滑 1D 滑动让位动效 (140ms cubic-bezier)
        const activeContainer = (
          isPinned
            ? pinnedZoneRefStable.current.current
            : (document.querySelector(
                isGeneralFolderName(folder)
                  ? '[data-drop-zone="general"]'
                  : `[data-folder-name="${CSS.escape ? CSS.escape(folder) : folder.replace(/"/g, '\\"')}"]`
              ) as HTMLElement | null)
        );

        if (activeContainer) {
          const allTargetRows = Array.from(
            activeContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
          ).filter((r) => r.offsetParent !== null && r.getBoundingClientRect().height > 0);

          const isSameContainer = Boolean(
            sourceContainer && activeContainer.contains(sourceContainer)
          );

          const otherRows = allTargetRows.filter(
            (r) => r.getAttribute('data-session-id') !== sessionId
          );
          const srcIdx = isSameContainer
            ? allTargetRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId)
            : -1;

          let targetIdx = otherRows.length;
          if (overId) {
            const matchIdx = otherRows.findIndex(
              (r) => r.getAttribute('data-session-id') === overId
            );
            if (matchIdx >= 0) {
              targetIdx = hit.place === 'before' ? matchIdx : matchIdx + 1;
            }
          }

          const stepPx = DEFAULT_ROW_STEP_PX;
          const nextShifted: HTMLElement[] = [];

          for (let i = 0; i < otherRows.length; i++) {
            const row = otherRows[i]!;
            let offset = 0;

            if (isSameContainer && srcIdx >= 0) {
              if (targetIdx > srcIdx) {
                if (i >= srcIdx && i < targetIdx) offset = -stepPx;
              } else if (targetIdx < srcIdx) {
                if (i >= targetIdx && i < srcIdx) offset = stepPx;
              }
            } else {
              if (i >= targetIdx) {
                offset = stepPx;
              }
            }

            row.style.transition = 'transform 120ms cubic-bezier(0.2, 0, 0, 1)';
            row.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
            nextShifted.push(row);
          }

          for (const el of shiftedElements) {
            if (!nextShifted.includes(el)) {
              el.style.transform = '';
              el.style.transition = '';
            }
          }
          shiftedElements = nextShifted;
        }
      };

      const scheduleApply = (clientX: number, clientY: number, dx: number, dy: number) => {
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
          applyPointer(ue.clientX, ue.clientY, ue.clientX - startX, ue.clientY - startY);

          if (lastAppliedTarget) {
            if (lastAppliedTarget.domain === 'pane-split') {
              commitSidebarSessionDrop({
                sessionId,
                target: {
                  kind: 'pane',
                  targetLeafId: lastAppliedTarget.targetLeafId,
                  region: lastAppliedTarget.region,
                },
              });
            } else if (lastAppliedTarget.domain === 'tab-strip') {
              commitSidebarSessionDrop({
                sessionId,
                target: {
                  kind: 'strip',
                  targetLeafId: lastAppliedTarget.targetLeafId,
                  insertIdx: currentStripInsertIdx,
                },
              });
            } else if (lastAppliedTarget.domain === 'sidebar') {
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
