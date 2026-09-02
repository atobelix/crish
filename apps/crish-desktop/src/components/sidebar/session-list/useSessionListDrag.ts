/**
 * useSessionListDrag.ts — 侧栏会话与项目文件夹拖拽动力学与跨域分屏统一引擎 (Master Magnum Opus Edition)
 * 
 * 核心特性：
 * 1. 真实网格步长自适应解算 (31px = 28px + gap 3px)，消除尺寸阶跃与卡顿；
 * 2. 实数域全连续中值分割方程，消灭 1.5px 缝隙死区，彻底根治整体微抖动；
 * 3. 跨域顶栏 TabStrip 1D 水平平滑让位动力学 (translateX 154px) 与指定下标精准插排；
 * 4. 三 Store 原子同步协议：分屏与插入后 Zero-Click 自动激活新叶节点与会话；
 * 5. 跨分组空洞自闭合：拖入其他分区时，原分组下方项目自动向上平移 (-31px) 补齐空洞；
 * 6. 业务约束守门：项目内部会话仅限当前项目内排序或置顶，严禁流出到未绑定项目的常规区；
 * 7. 纯 Ref 驱动与 GPU 合成层：拖拽全过程零 setState、零 React 重绘，全局静音 Tooltip。
 */

import React, { useCallback, useRef, useState } from 'react';
import { GENERAL_FOLDER, canonicalSessionFolder } from '../../../api/projectStore';
import type { SessionState } from '../../../store/types';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import styles from '../SidebarSessionList.module.css';
import type { SidebarDragItem } from './sessionListTypes';
import {
  compute1DInsertIndex,
  compute1DShiftOffsets,
  readTranslateY,
  readTranslateX,
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
const DEFAULT_ROW_STEP_PX = 31; // 28px height + 3px gap
const DEFAULT_TAB_STEP_PX = 154; // 150px tab max-width + 4px gap

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
 * 原汁原味克隆当前会话行的真实 DOM 外观，并进行深层事件脱敏（杜绝 pointer-events 遮挡穿透）
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
    'pointer-events: none !important',
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

  // 深度禁用内部所有子元素的指针响应与焦点
  ghost.querySelectorAll('*').forEach((n) => {
    if (n instanceof HTMLElement) {
      n.style.pointerEvents = 'none';
      n.tabIndex = -1;
    }
  });

  document.body.appendChild(ghost);
  return ghost;
}

/** 吞噬拖拽松手后的紧跟 click 事件，防止误触发列表项选中 */
function swallowNextClick(): void {
  const handler = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', handler, true);
  };
  window.addEventListener('click', handler, true);
  setTimeout(() => {
    window.removeEventListener('click', handler, true);
  }, 300);
}

export function useSessionListDrag(
  opts: UseSessionListDragOpts
): UseSessionListDragResult {
  const { sessionListRef, renamingSessionId, onMoveSessionRealtime } = opts;

  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned] = useState(false);
  const [dropIndicator] = useState<DropIndicator | null>(null);
  const [dragPreview] = useState<SessionDragPreview | null>(null);

  const onMoveRef = useRef(onMoveSessionRealtime);
  onMoveRef.current = onMoveSessionRealtime;

  const sessionListRefStable = useRef(sessionListRef);
  sessionListRefStable.current = sessionListRef;

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0 || renamingSessionId === sessionId) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const originFolder = canonicalSessionFolder(folderName);
      const isProjectSession = originFolder !== GENERAL_FOLDER;

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

      // 抓取偏移量
      const grabOffsetX = startX - rowRect.left;
      const grabOffsetY = startY - rowRect.top;

      let lastAppliedTarget: CrossDomainTarget | null = null;
      let shiftedElements: HTMLElement[] = [];
      let currentInsertSessionId: string | null = null;
      let currentTargetFolder = originFolder;
      let currentIsPinned = false;
      let currentStripInsertIdx = 0;

      // 找到源项所在的原生分组容器
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

        // 2. 空间索引跨域落点探测（几何优先 + 多重兜底）
        const tree = useLayoutTreeStore.getState().tree;
        const target = resolveCrossDomainTarget(clientX, clientY, dx, dy, sessionId, tree);
        lastAppliedTarget = target;

        // 3. 分域响应动力学
        if (target.domain === 'pane-split') {
          clearAllShifts();
          showPaneIndicator(target.paneRect, target.region);
          if (ghostEl) ghostEl.style.opacity = '0.95';
        } else if (target.domain === 'tab-strip') {
          // 跨域进入顶栏 TabStrip：执行 1D 水平让位动力学
          hideIndicator();
          if (ghostEl) ghostEl.style.opacity = '0.95';

          const strip = target.stripEl;
          const allTabs = Array.from(
            strip.querySelectorAll<HTMLElement>('[role="tab"], .tabItem, [data-tab-id]')
          ).filter((t) => t.offsetParent !== null);

          const tabSpans: Axis1DItemSpan[] = allTabs.map((t) => {
            const rect = t.getBoundingClientRect();
            const tx = readTranslateX(t);
            return {
              id: t.getAttribute('data-tab-id') || t.getAttribute('data-session-id') || '',
              start: rect.left - tx,
              end: rect.right - tx,
              size: rect.width,
              el: t,
            };
          });

          const insertIdx = compute1DInsertIndex(tabSpans, clientX, dx);
          currentStripInsertIdx = insertIdx;

          const offsets = compute1DShiftOffsets({
            itemCount: allTabs.length,
            sourceIndex: null, // 跨域拖入，目标条中无源项占位
            insertIndex: insertIdx,
            shiftStep: DEFAULT_TAB_STEP_PX,
          });

          const nextShifted: HTMLElement[] = [];
          for (let i = 0; i < allTabs.length; i++) {
            const tabEl = allTabs[i]!;
            const offset = offsets[i] ?? 0;
            tabEl.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
            tabEl.style.transform = offset !== 0 ? `translateX(${offset}px)` : '';
            nextShifted.push(tabEl);
          }

          // 跨分组时原侧栏分组空洞也向上收缩补齐
          if (sourceContainer) {
            const allSourceRows = Array.from(
              sourceContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
            ).filter((r) => r.offsetParent !== null);

            const origIdx = allSourceRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId);
            if (origIdx >= 0) {
              for (let i = 0; i < allSourceRows.length; i++) {
                const sRow = allSourceRows[i]!;
                if (sRow.getAttribute('data-session-id') === sessionId) continue;
                if (i > origIdx) {
                  sRow.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
                  sRow.style.transform = `translateY(-${DEFAULT_ROW_STEP_PX}px)`;
                  nextShifted.push(sRow);
                }
              }
            }
          }

          for (const el of shiftedElements) {
            if (!nextShifted.includes(el)) {
              el.style.transform = '';
              el.style.transition = '';
            }
          }
          shiftedElements = nextShifted;
        } else if (target.domain === 'sidebar') {
          hideIndicator();

          // 移回侧栏时无条件清除可能残留在 TabStrip DOM 上的水平位移
          for (const el of shiftedElements) {
            el.style.transform = '';
            el.style.transition = '';
          }
          shiftedElements = [];

          // 探测光标命中的具体侧栏分区（置顶 / 项目文件夹 / 常规区）
          const hit = document.elementFromPoint(clientX, clientY);
          const pinnedZone = hit?.closest('[data-drop-zone="pinned"]') as HTMLElement | null;
          const folderEl = hit?.closest('[data-folder-name]') as HTMLElement | null;
          const generalZone = hit?.closest('[data-drop-zone="general"]') as HTMLElement | null;

          const isPinnedTarget = Boolean(pinnedZone);
          const rawTargetFolder = folderEl?.getAttribute('data-folder-name') || GENERAL_FOLDER;
          const targetFolderName = isPinnedTarget
            ? originFolder
            : canonicalSessionFolder(rawTargetFolder);

          // 业务硬约束守门：项目内的会话只能在项目内排序或放在置顶区域，禁止放在常规未绑定项目的对话列表中
          if (isProjectSession && !isPinnedTarget && targetFolderName !== originFolder) {
            clearAllShifts();
            if (ghostEl) ghostEl.style.opacity = '0.35';
            currentInsertSessionId = null;
            return;
          }

          if (ghostEl) ghostEl.style.opacity = '0.95';

          const activeContainer = pinnedZone || folderEl || generalZone;

          if (activeContainer) {
            const nextShifted: HTMLElement[] = [];

            // A. 处理当前目标容器中的项（腾位或同列表位移）
            const allTargetRows = Array.from(
              activeContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
            ).filter((r) => {
              if (r.offsetParent === null) return false;
              const b = r.getBoundingClientRect();
              return b.height > 0;
            });

            const isSameContainer = activeContainer === sourceContainer;
            const sourceIndex = isSameContainer
              ? allTargetRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId)
              : -1;
            const otherTargetRows = allTargetRows.filter((r) => r.getAttribute('data-session-id') !== sessionId);

            // 采集未位移时的静态物理几何坐标
            const targetSpans: Axis1DItemSpan[] = otherTargetRows.map((r) => {
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

            // 测量真实物理步长 (自适应采样或 31px)
            let effectiveStepPx = DEFAULT_ROW_STEP_PX;
            if (targetSpans.length >= 2) {
              const s0 = targetSpans[0];
              const s1 = targetSpans[1];
              if (s0 && s1) {
                effectiveStepPx = Math.abs(s1.start - s0.start) || effectiveStepPx;
              }
            }

            const insertIdx = compute1DInsertIndex(targetSpans, clientY, dy);
            const targetOffsets = compute1DShiftOffsets({
              itemCount: otherTargetRows.length,
              sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
              insertIndex: insertIdx,
              shiftStep: effectiveStepPx,
            });

            for (let i = 0; i < otherTargetRows.length; i++) {
              const row = otherTargetRows[i]!;
              const offset = targetOffsets[i] ?? 0;
              row.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
              row.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
              nextShifted.push(row);
            }

            // B. 跨分组拖拽时：原分组容器下的列表项向上补位收缩空洞！
            if (!isSameContainer && sourceContainer) {
              const allSourceRows = Array.from(
                sourceContainer.querySelectorAll<HTMLElement>('li[data-session-id]')
              ).filter((r) => {
                if (r.offsetParent === null) return false;
                const b = r.getBoundingClientRect();
                return b.height > 0;
              });

              const origIdx = allSourceRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId);
              if (origIdx >= 0) {
                for (let i = 0; i < allSourceRows.length; i++) {
                  const sRow = allSourceRows[i]!;
                  if (sRow.getAttribute('data-session-id') === sessionId) continue;
                  if (i > origIdx) {
                    sRow.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
                    sRow.style.transform = `translateY(-${effectiveStepPx}px)`;
                    nextShifted.push(sRow);
                  }
                }
              }
            }

            // C. 清除不再处于位移状态的其余 DOM 元素
            for (const el of shiftedElements) {
              if (!nextShifted.includes(el)) {
                el.style.transform = '';
                el.style.transition = '';
              }
            }
            shiftedElements = nextShifted;

            const overId = targetSpans[insertIdx]?.id || null;
            currentInsertSessionId = overId;
            currentTargetFolder = targetFolderName;
            currentIsPinned = isPinnedTarget;
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

          // 先克隆原汁原味的 Ghost，再标记原行占位态
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
                  insertIdx: currentStripInsertIdx,
                },
              });
            } else if (lastAppliedTarget.domain === 'sidebar') {
              // 约束守门：若项目会话被拖入非法区域则不提交
              if (isProjectSession && !currentIsPinned && currentTargetFolder !== originFolder) {
                // 非法落点：NO-OP
              } else {
                onMoveRef.current(
                  sessionId,
                  currentInsertSessionId,
                  currentTargetFolder,
                  currentIsPinned
                );
              }
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
