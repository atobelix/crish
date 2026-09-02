/**
 * useSessionListDrag.ts — 侧栏会话列表拖拽动力学与跨域分屏引擎
 * 
 * 核心特性：
 * 1. 原汁原味 Ghost：完美保持会话列表行的原始 DOM 结构、图标、文字与精致卡片样式；
 * 2. 纯物理 1D 让位：基于静态几何解算消除振荡，平滑 translateY 避让腾位，绝无生硬绿线与绿框；
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
  readTranslateY,
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

const DRAG_THRESHOLD_PX = 4;

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

/**
 * 原汁原味克隆当前会话行的真实 DOM 外观（包含图标、标题、排版、卡片阴影）
 */
function createSidebarSessionGhost(rowLi: HTMLElement, rowRect: DOMRect): HTMLDivElement {
  const ghost = rowLi.cloneNode(true) as HTMLDivElement;
  ghost.className = 'sidebar-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    `width: ${Math.round(rowRect.width)}px`,
    `height: ${Math.round(rowRect.height)}px`,
    'box-sizing: border-box',
    'pointer-events: none',
    'z-index:var(--z-tooltip)',
    'opacity: 0.94',
    'border-radius: 8px',
    'background: var(--bg-card, #ffffff)',
    'box-shadow: 0 10px 28px rgba(0, 0, 0, 0.15), 0 3px 8px rgba(0, 0, 0, 0.08)',
    'border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12))',
    'will-change: transform',
    'transform: translate3d(-9999px, -9999px, 0)',
    'margin: 0',
    'list-style: none',
  ].join(';');

  // 禁用内部按钮与链接的焦点与指针
  ghost.querySelectorAll('button, input, a').forEach((n) => {
    (n as HTMLElement).tabIndex = -1;
    (n as HTMLElement).style.pointerEvents = 'none';
  });

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
      const rowRect = rowLi?.getBoundingClientRect() ?? ({
        left: startX,
        top: startY,
        width: 240,
        height: 28,
      } as DOMRect);

      const rowStepPx = rowRect.height > 0 ? rowRect.height : 28;

      // 记录抓取偏移量
      const grabOffsetX = startX - rowRect.left;
      const grabOffsetY = startY - rowRect.top;

      let lastAppliedTarget: CrossDomainTarget | null = null;
      let shiftedElements: HTMLElement[] = [];
      let currentInsertSessionId: string | null = null;
      let currentTargetFolder = originFolder;
      let currentIsPinned = false;

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

      const applyPointer = (clientX: number, clientY: number, dx: number, dy: number) => {
        if (!dragging) return;

        // 1. 同步 Ghost 物理位置（GPU translate3d）
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

          // 探测命中所属分区（置顶 / 项目文件夹 / 常规区）
          const hit = document.elementFromPoint(clientX, clientY);
          const pinnedZone = hit?.closest('[data-drop-zone="pinned"]') as HTMLElement | null;
          const folderEl = hit?.closest('[data-folder-name]') as HTMLElement | null;
          const generalZone = (hit?.closest('[data-drop-zone="general"]') || document.querySelector('[data-drop-zone="general"]')) as HTMLElement | null;

          const isPinned = Boolean(pinnedZone);
          const activeContainer = pinnedZone || folderEl || generalZone;

          if (activeContainer) {
            // 严格过滤不可见/折叠手风琴中的项
            const allRows = Array.from(
              activeContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
            ).filter((r) => {
              if (r.offsetParent === null) return false;
              const b = r.getBoundingClientRect();
              return b.height > 0;
            });

            // 区分源项与目标项
            const sourceIndex = allRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId);
            const otherRows = allRows.filter((r) => r.getAttribute('data-session-id') !== sessionId);

            // 采集未位移时的静态物理几何坐标（减去当前 translateY）
            const spans: Axis1DItemSpan[] = otherRows.map((r) => {
              const rect = r.getBoundingClientRect();
              const ty = readTranslateY(r);
              return {
                id: r.getAttribute('data-session-id') || '',
                start: rect.top - ty,
                end: rect.bottom - ty,
                size: rect.height,
                el: r,
              };
            });

            // 计算无缝插入点
            const insertIdx = compute1DInsertIndex(spans, clientY, dy);

            // 计算位移向量并应用 translateY 让位
            const offsets = compute1DShiftOffsets({
              itemCount: otherRows.length,
              sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
              insertIndex: insertIdx,
              shiftStep: rowStepPx,
            });

            // 清理不在当前容器中的其它行位移
            for (const el of shiftedElements) {
              if (!otherRows.includes(el)) {
                el.style.transform = '';
                el.style.transition = '';
              }
            }
            shiftedElements = otherRows;

            for (let i = 0; i < otherRows.length; i++) {
              const row = otherRows[i]!;
              const offset = offsets[i] ?? 0;
              row.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
              row.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
            }

            const folder = isPinned
              ? originFolder
              : folderEl?.getAttribute('data-folder-name') || GENERAL_FOLDER;

            const overId = spans[insertIdx]?.id || null;

            currentInsertSessionId = overId;
            currentTargetFolder = folder;
            currentIsPinned = isPinned;

            setDragOverPinned(isPinned);
          }
        } else {
          // 游离态
          clearAllShifts();
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.35';
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

          // 从原列表行生成原汁原味的 Ghost
          if (rowLi) {
            ghostEl = createSidebarSessionGhost(rowLi, rowRect);
          }

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

      const up = (ue: PointerEvent) => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }

        if (dragging) {
          // 同步执行最后一帧确定终态
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
                  insertIdx: lastAppliedTarget.insertIndex,
                },
              });
            } else if (lastAppliedTarget.domain === 'sidebar') {
              // 单次原子提交侧栏重排序
              onMoveRef.current(
                sessionId,
                currentInsertSessionId,
                currentTargetFolder,
                currentIsPinned
              );
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
