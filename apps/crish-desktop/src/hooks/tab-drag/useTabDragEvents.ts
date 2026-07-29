import React from 'react';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { getWorkspaceStoreState, setDropPreview } from '../../store/workspaceStore';
import { exceedsDragThreshold, resolveTabBarHeight, type DropType } from './tabDragGeometry';
import {
  animateOverlayAway,
  clearDropIndicator,
  createCardDragOverlay,
  createTabDragOverlay,
  setDragOverlayPosition,
} from './tabDragGhost';
import {
  useTabDragReorder,
  type CardSnapshot,
} from './useTabDragReorder';
import type { TabBarTabRect } from './tabDragTypes';

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}

function snapshotTabBarGeometry(cardEl: HTMLElement): {
  tabBarH: number;
  tabsBar: HTMLElement | null;
  tabRects: TabBarTabRect[];
  barRight: number;
} {
  const header = cardEl.querySelector('.card-header');
  const tabsBarCandidate = cardEl.querySelector('.tabs-bar');
  const tabsBar =
    tabsBarCandidate instanceof HTMLElement ? tabsBarCandidate : null;

  let measuredH: number | null = null;
  if (header instanceof HTMLElement) {
    measuredH = header.getBoundingClientRect().height;
  } else if (tabsBar) {
    measuredH = tabsBar.getBoundingClientRect().height;
  }
  const tabBarH = resolveTabBarHeight(measuredH);

  let tabRects: TabBarTabRect[] = [];
  let barRight = 0;
  if (tabsBar) {
    barRight = tabsBar.getBoundingClientRect().right;
    const tabs = Array.from(
      tabsBar.querySelectorAll(
        '.card-tab:not(.dragging-tab-hidden):not(.tab-placeholder-indicator)'
      )
    ).filter((el): el is HTMLElement => el instanceof HTMLElement);
    tabRects = tabs.map((t) => {
      const tr = t.getBoundingClientRect();
      return { left: tr.left, width: tr.width };
    });
  }

  return { tabBarH, tabsBar, tabRects, barRight };
}

export function useTabDragEvents({
  wsId,
  groupId,
  cardsLength,
}: UseTabDragOptions) {
  const { setDraggedTab, closeTabInGroup, evaluateMoveDrop, commitTabDrop } =
    useTabDragReorder();

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent, cardId: string) => {
      if (e.button === 1) {
        // Middle click: close tab / active card in group
        if (cardId !== 'chat') {
          e.preventDefault();
          e.stopPropagation();
          if (cardId === 'agent') {
            closeAgentSidePanel(wsId, groupId);
          } else {
            closeTabInGroup(wsId, groupId, cardId);
          }
        }
        return;
      }
      if (e.button !== 0) return;
      const eventTarget = e.target;
      if (
        eventTarget instanceof HTMLElement &&
        eventTarget.closest('.tab-close-btn')
      )
        return;

      if (!(e.currentTarget instanceof HTMLElement)) return;
      const targetEl = e.currentTarget;
      const isDragFromTabButton = targetEl.classList.contains('card-tab');
      const sourceCardCandidate = targetEl.closest('.workspace-card');
      const sourceCard =
        sourceCardCandidate instanceof HTMLElement
          ? sourceCardCandidate
          : null;
      const pointerId = e.pointerId;

      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* fallback to window listener */
      }

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let finished = false;
      let dragOverlay: HTMLDivElement | null = null;

      let lastDropType: DropType | null = null;
      let lastTargetColIdx = 0;
      let lastTargetGroupIdx: number | undefined = undefined;
      let lastTargetGroupId: string | null = null;
      let lastTabInsertIdx: number | undefined = undefined;

      const cardRect = sourceCard ? sourceCard.getBoundingClientRect() : null;
      const tabRect = targetEl ? targetEl.getBoundingClientRect() : null;
      const startWidth = cardRect ? cardRect.width : 0;
      const startHeight = cardRect ? cardRect.height : 0;
      const clickOffsetX =
        isDragFromTabButton && tabRect
          ? startX - tabRect.left
          : cardRect
            ? startX - cardRect.left
            : 0;
      const clickOffsetY =
        isDragFromTabButton && tabRect
          ? startY - tabRect.top
          : cardRect
            ? startY - cardRect.top
            : 0;

      // pointerdown 时一次性快照卡片/tab 栏几何，move 路径只读缓存
      const cardElements = Array.from(
        document.querySelectorAll(
          '.workspace-card:not(.placeholder-card-group)'
        )
      ).filter((el): el is HTMLElement => el instanceof HTMLElement);
      const cardSnapshots: CardSnapshot[] = cardElements.map((el) => {
        const r = el.getBoundingClientRect();
        const barGeom = snapshotTabBarGeometry(el);
        return {
          element: el,
          rect: {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          },
          colIdx: parseInt(el.getAttribute('data-col-idx') || '0', 10),
          groupIdx: parseInt(el.getAttribute('data-group-idx') || '0', 10),
          groupId: el.getAttribute('data-group-id') || '',
          tabBarH: barGeom.tabBarH,
          tabsBar: barGeom.tabsBar,
          tabRects: barGeom.tabRects,
          barRight: barGeom.barRight,
        };
      });

      let rafId: number | null = null;
      let pendingClientX = 0;
      let pendingClientY = 0;
      let hasPendingMove = false;

      const processMove = (clientX: number, clientY: number) => {
        if (finished) return;
        const dx = clientX - startX;
        const dy = clientY - startY;

        if (!isDragging && exceedsDragThreshold(dx, dy)) {
          isDragging = true;
          setDraggedTab({
            cardId,
            sourceGroupId: groupId,
            workspaceId: wsId,
            isTabDrag: isDragFromTabButton,
          });

          if (isDragFromTabButton) {
            dragOverlay = createTabDragOverlay(targetEl);
          } else if (sourceCard) {
            dragOverlay = createCardDragOverlay(
              sourceCard,
              startWidth,
              startHeight
            );
          }
        }

        if (!isDragging || !dragOverlay) return;

        // compositor 友好：transform，不写 left/top
        setDragOverlayPosition(
          dragOverlay,
          clientX - clickOffsetX,
          clientY - clickOffsetY
        );

        const resolved = evaluateMoveDrop({
          mouseX: clientX,
          mouseY: clientY,
          cardSnapshots,
          wsId,
          sourceGroupId: groupId,
          cardsLength,
          isDragFromTabButton,
          cardId,
        });

        if (!resolved) {
          clearDropIndicator(wsId);
          lastDropType = null;
          return;
        }

        lastDropType = resolved.dropType;
        lastTargetColIdx = resolved.targetColIdx;
        lastTargetGroupIdx = resolved.targetGroupIdx;
        lastTargetGroupId = resolved.targetGroupId;
        lastTabInsertIdx = resolved.tabInsertIdx;
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (finished) return;
        if (moveEvent.pointerId !== pointerId) return;
        pendingClientX = moveEvent.clientX;
        pendingClientY = moveEvent.clientY;
        hasPendingMove = true;
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!hasPendingMove || finished) return;
          hasPendingMove = false;
          processMove(pendingClientX, pendingClientY);
        });
      };

      const cancelPendingRaf = () => {
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      const detachListeners = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', finishPointer);
        window.removeEventListener('pointercancel', finishPointer);
        targetEl.removeEventListener('lostpointercapture', finishPointer);
        try {
          if (targetEl.hasPointerCapture?.(pointerId)) {
            targetEl.releasePointerCapture(pointerId);
          }
        } catch {
          /* ignore */
        }
      };

      const finishPointer = (ev?: Event) => {
        if (finished) return;
        if (
          ev &&
          'pointerId' in ev &&
          (ev as PointerEvent).pointerId !== pointerId
        )
          return;

        // 提交前取消 rAF；若有未刷帧或已在拖，用最终坐标再评估一次
        cancelPendingRaf();
        const endX =
          ev && 'clientX' in ev
            ? (ev as PointerEvent).clientX
            : pendingClientX;
        const endY =
          ev && 'clientY' in ev
            ? (ev as PointerEvent).clientY
            : pendingClientY;
        if (isDragging || hasPendingMove) {
          hasPendingMove = false;
          processMove(endX, endY);
        }

        finished = true;
        detachListeners();

        clearDropIndicator(wsId);
        setDropPreview(null);

        if (!isDragging) {
          if (dragOverlay) dragOverlay.remove();
          document.body.classList.remove('dragging-card');
          return;
        }

        const latestDraggedTab = getWorkspaceStoreState().draggedTab;
        const latestSourceGroupId = latestDraggedTab?.sourceGroupId ?? groupId;

        setDraggedTab(null);

        const cancelled =
          ev?.type === 'pointercancel' || ev?.type === 'lostpointercapture';

        const { destGroupId } = commitTabDrop({
          wsId,
          cardId,
          sourceGroupId: latestSourceGroupId,
          lastDropType,
          cancelled,
          lastTargetGroupId,
          lastTargetColIdx,
          lastTargetGroupIdx,
          lastTabInsertIdx,
        });

        if (dragOverlay) {
          const overlay = dragOverlay;
          dragOverlay = null;
          animateOverlayAway(overlay, cardId, destGroupId);
        } else {
          document.body.classList.remove('dragging-card');
        }
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', finishPointer);
      window.addEventListener('pointercancel', finishPointer);
      targetEl.addEventListener('lostpointercapture', finishPointer);
    },
    [
      wsId,
      groupId,
      cardsLength,
      setDraggedTab,
      closeTabInGroup,
      evaluateMoveDrop,
      commitTabDrop,
    ]
  );

  return { handleTabPointerDown };
}
