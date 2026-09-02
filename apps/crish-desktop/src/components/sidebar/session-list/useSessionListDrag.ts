/**
 * useSessionListDrag.ts — 侧栏会话列表拖拽动力学与跨域分屏引擎
 * 
 * 核心特性：
 * 1. 1D 轴向同构纯数学让位（X/Y 轴同构，垂直 translateY 顺滑过渡）；
 * 2. 彻底脱壳 GhostPill，消除原项重叠；
 * 3. 拖拽全程零 Store 污染，松手单次原子提交；
 * 4. 跨域工作区探测，支持直接向右侧二叉树工作区分屏（22% 边缘切分）与顶栏插入；
 * 5. 严格单窗口同会话互斥守门（无意义自自分裂拦截）。
 */

import React, { useCallback, useRef, useState } from 'react';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import type { SessionState } from '../../../store/types';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import styles from '../SidebarSessionList.module.css';
import type { SidebarDragItem } from './sessionListTypes';
import {
  compute1DInsertIndex,
  compute1DShiftOffsets,
  type Axis1DItemSpan,
} from '../../shell/drag-engine/sessionDrag1DGeometry';
import {
  resolveCrossDomainTarget,
  type CrossDomainTarget,
} from '../../shell/drag-engine/crossDomainDropRouter';
import { commitSidebarSessionDrop } from '../../shell/sessionTabDropCommit';
import { paneDropIndicatorRect } from '../../shell/sessionTabDragFeel';
import { createIndicator } from '../../shell/sessionTabDragDom';

export type DropPlace = 'before' | 'after';

export type DropIndicator = {
  sessionId: string;
  place: DropPlace;
};

export type SessionDragPreview = {
  sessionId: string;
  overSessionId: string | null;
  place: DropPlace;
  isPinned: boolean;
  folder: string;
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

const DRAG_THRESHOLD_PX = 5;
const ROW_STEP_PX = 36; // 行高 + 间隙标准步长

export function applyDragPreview(
  list: SessionState[],
  preview: SessionDragPreview,
  dragSession: SessionState | null,
  listIsTarget: boolean
): SessionState[] {
  const without = list.filter((s) => s.id !== preview.sessionId);
  if (!listIsTarget) return without;

  const source =
    dragSession && dragSession.id === preview.sessionId
      ? dragSession
      : list.find((s) => s.id === preview.sessionId) || null;
  if (!source) return without;

  const virtual: SessionState = {
    ...source,
    isPinned: preview.isPinned,
    folder: preview.folder,
  };

  if (!preview.overSessionId) {
    return [...without, virtual];
  }

  const idx = without.findIndex((s) => s.id === preview.overSessionId);
  if (idx === -1) return [...without, virtual];

  const insertAt = preview.place === 'before' ? idx : idx + 1;
  const next = without.slice();
  next.splice(insertAt, 0, virtual);
  return next;
}

export function isPreviewTargetSection(
  preview: SessionDragPreview,
  kind: 'pinned' | 'general' | 'project',
  projectId?: string
): boolean {
  if (kind === 'pinned') return preview.isPinned;
  if (preview.isPinned) return false;
  if (kind === 'general') {
    return (
      preview.folder === GENERAL_FOLDER ||
      preview.folder === '会话' ||
      preview.folder === '常规会话' ||
      preview.folder === 'general' ||
      !preview.folder
    );
  }
  return Boolean(projectId && preview.folder === projectId);
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

/** 统一创建精致脱壳 GhostPill（截断标题、微阴影、挂载 body） */
function createSidebarGhostPill(titleText: string): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.className = 'sidebar-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'height:26px',
    'max-width:180px',
    'min-width:60px',
    'padding:0 10px',
    'background:var(--bg-card, #ffffff)',
    'color:var(--text-primary, #1a1a1a)',
    'border:1px solid var(--border-color, rgba(0,0,0,0.12))',
    'border-radius:6px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.06)',
    'display:flex',
    'align-items:center',
    'font-size:12px',
    'font-weight:500',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'pointer-events:none',
    'z-index:var(--z-tooltip)',
    'opacity:0.95',
    'will-change:transform',
    'transition:opacity 120ms ease',
  ].join(';');
  ghost.textContent = titleText || '会话';
  document.body.appendChild(ghost);
  return ghost;
}

export function useSessionListDrag(
  opts: UseSessionListDragOpts
): UseSessionListDragResult {
  const { renamingSessionId, onMoveSessionRealtime } = opts;

  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [dragPreview, setDragPreview] = useState<SessionDragPreview | null>(null);

  const onMoveRef = useRef(onMoveSessionRealtime);
  onMoveRef.current = onMoveSessionRealtime;

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0 || renamingSessionId === sessionId) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const originFolder = (folderName && folderName.trim()) || GENERAL_FOLDER;

      let dragging = false;
      let ghostEl: HTMLDivElement | null = null;
      let indicatorEl: HTMLDivElement | null = null;
      let raf = 0;
      let pendingPointer: { x: number; y: number; dx: number; dy: number } | null = null;

      const rowLi = (e.currentTarget as HTMLElement).closest('li') as HTMLElement | null;
      const titleSpan = rowLi?.querySelector('[class*="sessionTextCol"], [class*="sessionText"]') as HTMLElement | null;
      const sessionTitle = titleSpan?.textContent?.trim() || '会话';

      // 记录抓取偏移量
      const rowRect = rowLi?.getBoundingClientRect();
      const grabOffsetX = startX - (rowRect?.left ?? startX);
      const grabOffsetY = startY - (rowRect?.top ?? startY);

      let lastAppliedTarget: CrossDomainTarget | null = null;
      let shiftedElements: HTMLElement[] = [];

      const clearAllShifts = () => {
        for (const el of shiftedElements) {
          el.style.transform = '';
          el.style.transition = '';
        }
        shiftedElements = [];
      };

      const hideIndicator = () => {
        if (indicatorEl) {
          indicatorEl.style.display = 'none';
        }
      };

      const showPaneIndicator = (rect: { left: number; top: number; width: number; height: number }, region: any) => {
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

      const apply1DShiftToSidebarSection = (
        container: HTMLElement,
        insertIndex: number,
        sourceIndex: number | null
      ) => {
        clearAllShifts();
        const rows = Array.from(
          container.querySelectorAll<HTMLElement>('li[data-session-id]')
        ).filter((el) => el.getAttribute('data-session-id') !== sessionId);

        const offsets = compute1DShiftOffsets({
          itemCount: rows.length,
          sourceIndex,
          insertIndex,
          shiftStep: ROW_STEP_PX,
        });

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const offset = offsets[i] ?? 0;
          row.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
          row.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
          shiftedElements.push(row);
        }
      };

      const applyPointer = (clientX: number, clientY: number, dx: number, dy: number) => {
        if (!dragging) return;

        // 1. 同步 Ghost 位置（GPU translate3d）
        if (ghostEl) {
          ghostEl.style.transform = `translate3d(${clientX - grabOffsetX}px, ${clientY - grabOffsetY}px, 0)`;
        }

        // 2. 空间索引跨域落点探测
        const tree = useLayoutTreeStore.getState().tree;
        const target = resolveCrossDomainTarget(clientX, clientY, dx, dy, sessionId, tree);
        lastAppliedTarget = target;

        // 3. 分域响应动力学
        if (target.domain === 'pane-split') {
          clearAllShifts();
          showPaneIndicator(target.paneRect, target.region);
          if (ghostEl) ghostEl.style.opacity = '0.95';
        } else if (target.domain === 'tab-strip') {
          clearAllShifts();
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.95';
        } else if (target.domain === 'sidebar') {
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.95';

          // 探测具体所属侧栏分区（Pinned / Project / General）
          const hit = document.elementFromPoint(clientX, clientY);
          const pinnedZone = hit?.closest('[data-drop-zone="pinned"]') as HTMLElement | null;
          const folderEl = hit?.closest('[data-folder-name]') as HTMLElement | null;
          const generalZone = (hit?.closest('[data-drop-zone="general"]') || document.querySelector('[data-drop-zone="general"]')) as HTMLElement | null;

          const isPinned = Boolean(pinnedZone);
          const activeContainer = pinnedZone || folderEl || generalZone;

          if (activeContainer) {
            const rows = Array.from(
              activeContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
            );
            const sourceIndex = rows.findIndex((r) => r.getAttribute('data-session-id') === sessionId);
            const otherRows = rows.filter((r) => r.getAttribute('data-session-id') !== sessionId);

            const spans: Axis1DItemSpan[] = otherRows.map((r) => {
              const rect = r.getBoundingClientRect();
              return {
                id: r.getAttribute('data-session-id') || '',
                start: rect.top,
                end: rect.bottom,
                size: rect.height,
              };
            });

            const insertIdx = compute1DInsertIndex(spans, clientY, dy);
            apply1DShiftToSidebarSection(activeContainer, insertIdx, sourceIndex >= 0 ? sourceIndex : null);

            const overId = spans[insertIdx]?.id || null;
            const folder = isPinned
              ? originFolder
              : folderEl?.getAttribute('data-folder-name') || GENERAL_FOLDER;

            setDragOverPinned(isPinned);
            setDragPreview({
              sessionId,
              overSessionId: overId,
              place: 'before',
              isPinned,
              folder,
            });
          }
        } else {
          // 游离或被拦截
          clearAllShifts();
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.35'; // 游离半透明
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
            (e as unknown as PointerEvent).preventDefault?.();
          } catch {
            /* ignore */
          }
          document.body.classList.add('sidebar-dragging');
          if (rowLi) {
            rowLi.classList.add(styles.isDraggingSource || 'isDraggingSource');
          }
          setActiveDragItem({
            type: 'session',
            sessionId,
            ...(folderName !== undefined ? { folderName } : {}),
          });
          ghostEl = createSidebarGhostPill(sessionTitle);
          applyPointer(me.clientX, me.clientY, dx, dy);
        }

        if (!dragging) return;
        scheduleApply(me.clientX, me.clientY, dx, dy);
      };

      const cleanup = () => {
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
        clearAllShifts();
        document.body.classList.remove('sidebar-dragging');
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

      const up = () => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }

        if (dragging && lastAppliedTarget) {
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
                insertIdx: lastAppliedTarget.insertIndex,
              },
            });
          } else if (lastAppliedTarget.domain === 'sidebar') {
            // 单次原子提交侧栏重排序
            const hit = document.elementFromPoint(startX + (pendingPointer?.dx ?? 0), startY + (pendingPointer?.dy ?? 0));
            const pinnedZone = hit?.closest('[data-drop-zone="pinned"]');
            const folderEl = hit?.closest('[data-folder-name]') as HTMLElement | null;
            const isPinned = Boolean(pinnedZone);
            const folder = isPinned
              ? originFolder
              : folderEl?.getAttribute('data-folder-name') || GENERAL_FOLDER;

            const activeContainer = pinnedZone || folderEl || document.querySelector('[data-drop-zone="general"]');
            const rows = activeContainer
              ? Array.from(activeContainer.querySelectorAll<HTMLElement>('li[data-session-id]')).filter(
                  (r) => r.getAttribute('data-session-id') !== sessionId
                )
              : [];

            const spans: Axis1DItemSpan[] = rows.map((r) => {
              const rect = r.getBoundingClientRect();
              return {
                id: r.getAttribute('data-session-id') || '',
                start: rect.top,
                end: rect.bottom,
                size: rect.height,
              };
            });

            const insertIdx = compute1DInsertIndex(spans, startY + (pendingPointer?.dy ?? 0), pendingPointer?.dy ?? 0);
            const targetSessionId = spans[insertIdx]?.id || null;

            onMoveRef.current(sessionId, targetSessionId, folder, isPinned);
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
