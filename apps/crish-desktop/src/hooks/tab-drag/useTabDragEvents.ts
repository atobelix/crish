import React from 'react';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { getWorkspaceStoreState, setDropPreview } from '../../store/workspaceStore';
import { exceedsDragThreshold, type DropType } from './tabDragGeometry';
import {
  animateOverlayAway,
  clearDropIndicator,
  createCardDragOverlay,
  createTabDragOverlay,
} from './tabDragGhost';
import {
  useTabDragReorder,
  type CardSnapshot,
} from './useTabDragReorder';

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}

export function useTabDragEvents({
  wsId,
  groupId,
  cardsLength,
}: UseTabDragOptions) {
  const { setDraggedTab, closeTabInGroup, evaluateMoveDrop, commitTabDrop } =
    useTabDragReorder();

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cardId: string) => {
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

      const cardElements = Array.from(
        document.querySelectorAll(
          '.workspace-card:not(.placeholder-card-group)'
        )
      ).filter((el): el is HTMLElement => el instanceof HTMLElement);
      const cardSnapshots: CardSnapshot[] = cardElements.map((el) => {
        const r = el.getBoundingClientRect();
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
        };
      });

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (finished) return;
        if (moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

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

        dragOverlay.style.left = `${moveEvent.clientX - clickOffsetX}px`;
        dragOverlay.style.top = `${moveEvent.clientY - clickOffsetY}px`;

        const mouseX = moveEvent.clientX;
        const mouseY = moveEvent.clientY;

        const resolved = evaluateMoveDrop({
          mouseX,
          mouseY,
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
