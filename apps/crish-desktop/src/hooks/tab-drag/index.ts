import React from 'react';
import { closeAgentSidePanel } from '../../api/openAgentPanel';
import { getWorkspaceStoreState, setDropPreview, useWorkspaceStore } from '../../store/workspaceStore';
import { DEFAULT_TAB_BAR_H } from '../../store/layoutHelpers';
import {
  type DropType,
  type UseTabDragOptions,
  exceedsDragThreshold,
  findCardSnapshotAtPoint,
  findGroupIndicesInWorkspace,
  isChatGroupTarget,
  isMergeLikeDropType,
  isOnlyCardInSourceColumn,
  resolveTabBarHeight,
  canCommitTabDrop,
  dropTypeToDetachPlacement,
} from './types';
import { resolveTabDrop } from './collision';
import {
  clearIndicator,
  removeInsertLine,
  safeSetDropPreview,
  showTabInsertLine,
} from './pointer-state';
import { animateOverlayAway, detachListeners } from './drop-handlers';

export function useTabDrag({ wsId, groupId, cardsLength }: UseTabDragOptions) {
  const setDraggedTab = useWorkspaceStore((s) => s.setDraggedTab);
  const mergeTab = useWorkspaceStore((s) => s.mergeTab);
  const detachTabToStandalone = useWorkspaceStore(
    (s) => s.detachTabToStandalone
  );
  const closeTabInGroup = useWorkspaceStore((s) => s.closeTabInGroup);

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cardId: string) => {
      if (e.button === 1) {
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
      if ((e.target as HTMLElement | null)?.closest?.('.tab-close-btn')) return;

      const targetEl = e.currentTarget as HTMLElement;
      const isDragFromTabButton = targetEl.classList.contains('card-tab');
      const sourceCard = targetEl.closest(
        '.workspace-card'
      ) as HTMLElement | null;
      const pointerId = e.pointerId;

      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* some environments do not support capture, fallback to window listeners */
      }

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let finished = false;
      let dragOverlay: HTMLDivElement | null = null;

      let lastDropType: DropType | null = null;
      let lastTargetColIdx = 0;
      let lastTargetGroupIdx: number | undefined;
      let lastTargetGroupId: string | null = null;
      let lastTabInsertIdx: number | undefined;
      let rafId: number | null = null;
      let pendingMoveEvent: PointerEvent | null = null;

      const cardRect = sourceCard ? sourceCard.getBoundingClientRect() : null;
      const tabRect = targetEl.getBoundingClientRect();
      const startWidth = cardRect ? cardRect.width : 0;
      const startHeight = cardRect ? cardRect.height : 0;
      const clickOffsetX =
        isDragFromTabButton
          ? startX - tabRect.left
          : cardRect
            ? startX - cardRect.left
            : 0;
      const clickOffsetY =
        isDragFromTabButton
          ? startY - tabRect.top
          : cardRect
            ? startY - cardRect.top
            : 0;

      const snapshotElement = (el: Element) => {
        const r = el.getBoundingClientRect();
        return {
          element: el as HTMLElement,
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
      };
      let cardSnapshots = Array.from(
        document.querySelectorAll('.workspace-card:not(.placeholder-card-group)')
      ).map(snapshotElement);
      const refreshCardSnapshots = () => {
        cardSnapshots = Array.from(
          document.querySelectorAll('.workspace-card:not(.placeholder-card-group)')
        ).map(snapshotElement);
      };
      window.addEventListener('resize', refreshCardSnapshots);

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

          if (isDragFromTabButton && targetEl) {
            dragOverlay = targetEl.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = 'card-tab is-dragging-ghost';
            dragOverlay.removeAttribute('id');
            const tabR = targetEl.getBoundingClientRect();
            dragOverlay.style.width = `${tabR.width}px`;
            dragOverlay.style.height = `${tabR.height}px`;
            dragOverlay
              .querySelectorAll('.tab-close-btn')
              .forEach((btn) => btn.remove());
            document.body.appendChild(dragOverlay);
            document.body.classList.add('dragging-card');
          } else if (sourceCard) {
            dragOverlay = sourceCard.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = 'drag-overlay-preview-card';
            dragOverlay.removeAttribute('id');
            dragOverlay.style.width = `${startWidth}px`;
            dragOverlay.style.height = `${startHeight}px`;
            dragOverlay
              .querySelectorAll('input, textarea, button')
              .forEach((el) => {
                (el as HTMLInputElement).disabled = true;
              });
            dragOverlay.querySelectorAll('iframe').forEach((el) => {
              const placeholder = document.createElement('div');
              placeholder.className = 'iframe-placeholder';
              placeholder.style.width = `${(el as HTMLElement).offsetWidth || 300}px`;
              placeholder.style.height = `${(el as HTMLElement).offsetHeight || 150}px`;
              el.replaceWith(placeholder);
            });
            document.body.appendChild(dragOverlay);
            document.body.classList.add('dragging-card');
          }
        }

        if (!isDragging || !dragOverlay) return;

        dragOverlay.style.transform = `translate3d(${moveEvent.clientX - clickOffsetX}px, ${moveEvent.clientY - clickOffsetY}px, 0)`;

        const mouseX = moveEvent.clientX;
        const mouseY = moveEvent.clientY;

        const matchedSnapshot = findCardSnapshotAtPoint(
          cardSnapshots,
          mouseX,
          mouseY
        );

        if (!matchedSnapshot) {
          clearIndicator(wsId);
          lastDropType = null;
          safeSetDropPreview(null);
          return;
        }

        const targetRect = matchedSnapshot.rect;
        const relX = mouseX - targetRect.left;
        const relY = mouseY - targetRect.top;

        const targetColIdx = matchedSnapshot.colIdx;
        const targetGroupIdx = matchedSnapshot.groupIdx;
        const targetGroupId = matchedSnapshot.groupId;

        const currentDraggedTab = getWorkspaceStoreState().draggedTab;
        const currentSourceGroupId =
          currentDraggedTab?.sourceGroupId ?? groupId;

        const currentWs = getWorkspaceStoreState().workspaces.find(
          (w) => w.id === wsId
        );
        const columns = currentWs?.columns;
        const { colIdx: currentColIdx, groupIdx: currentGroupIdx } =
          findGroupIndicesInWorkspace(columns, currentSourceGroupId);

        const sourceCol = columns?.find((c) =>
          c.groups.some((g) => g.id === currentSourceGroupId)
        );
        const onlyCard = isOnlyCardInSourceColumn(
          columns,
          currentSourceGroupId
        );
        const sourceColGroupsLength = sourceCol?.groups.length ?? 0;

        const tabBarH = resolveTabBarHeight(
          matchedSnapshot.element
            .querySelector('.card-header')
            ?.getBoundingClientRect().height ??
            matchedSnapshot.element
              .querySelector('.tabs-bar')
              ?.getBoundingClientRect().height ??
            DEFAULT_TAB_BAR_H
        );

        const isSelfHover = targetGroupId === currentSourceGroupId;
        const tabsBar = matchedSnapshot.element.querySelector(
          '.tabs-bar'
        ) as HTMLElement | null;
        const hasTabsBar = !!tabsBar;

        let tabInsertIdx: number | undefined;
        const needsInsert =
          hasTabsBar &&
          isDragFromTabButton &&
          relY < tabBarH &&
          (isSelfHover || !isChatGroupTarget(targetGroupId));

        if (needsInsert && tabsBar) {
          if (isSelfHover) {
            removeInsertLine();
          }
          const shown = showTabInsertLine(tabsBar, mouseX, cardId);
          tabInsertIdx = shown.insertIdx;
        } else if (!isSelfHover) {
          removeInsertLine();
        } else {
          removeInsertLine();
        }

        const resolved = resolveTabDrop({
          relX,
          relY,
          width: targetRect.width,
          height: targetRect.height,
          tabBarH,
          isSelfHover,
          isDragFromTabButton,
          cardsLength,
          isChatColumn: isChatGroupTarget(targetGroupId),
          targetColIdx,
          targetGroupIdx,
          targetGroupId,
          sourceGroupId: currentSourceGroupId,
          sourceColIdx: currentColIdx,
          sourceGroupIdx: currentGroupIdx,
          isOnlyCardInCol: onlyCard,
          sourceColGroupsLength,
          hasTabsBar,
          tabInsertIdx,
        });

        if (!isMergeLikeDropType(resolved.dropType)) {
          removeInsertLine();
        }

        lastDropType = resolved.dropType;
        lastTargetColIdx = resolved.targetColIdx;
        lastTargetGroupIdx = resolved.targetGroupIdx;
        lastTargetGroupId = resolved.targetGroupId;
        lastTabInsertIdx = resolved.tabInsertIdx;

        safeSetDropPreview(resolved.preview);
      };

      const throttledMove = (e: PointerEvent) => {
        pendingMoveEvent = e;
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (pendingMoveEvent) {
              const ev = pendingMoveEvent;
              pendingMoveEvent = null;
              handlePointerMove(ev);
            }
          });
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
        detachListeners({
          targetEl,
          pointerId,
          handlePointerMove: throttledMove,
          finishPointer,
        });
        window.removeEventListener('resize', refreshCardSnapshots);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        pendingMoveEvent = null;

        clearIndicator(wsId);
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
        let destGroupId: string | null = latestSourceGroupId;

        const commit = canCommitTabDrop({
          dropType: lastDropType,
          cancelled,
          sourceGroupId: latestSourceGroupId,
          targetGroupId: lastTargetGroupId,
          tabInsertIdx: lastTabInsertIdx,
        });

        if (commit && lastDropType) {
          if (lastDropType === 'merge' && lastTargetGroupId) {
            mergeTab(
              wsId,
              cardId,
              latestSourceGroupId,
              lastTargetGroupId,
              lastTabInsertIdx
            );
            destGroupId = lastTargetGroupId;
          } else if (lastDropType === 'self-reorder') {
            mergeTab(
              wsId,
              cardId,
              latestSourceGroupId,
              latestSourceGroupId,
              lastTabInsertIdx
            );
            destGroupId = latestSourceGroupId;
          } else {
            const placement = dropTypeToDetachPlacement(lastDropType);
            if (placement === 'top' || placement === 'bottom') {
              detachTabToStandalone(
                wsId,
                cardId,
                latestSourceGroupId,
                lastTargetColIdx,
                placement,
                lastTargetGroupIdx
              );
              destGroupId = null;
            } else if (placement === 'new-col') {
              detachTabToStandalone(
                wsId,
                cardId,
                latestSourceGroupId,
                lastTargetColIdx,
                'new-col'
              );
              destGroupId = null;
            }
          }
        }

        if (dragOverlay) {
          const overlay = dragOverlay;
          dragOverlay = null;
          animateOverlayAway(overlay, cardId, destGroupId);
        } else {
          document.body.classList.remove('dragging-card');
        }
      };

      window.addEventListener('pointermove', throttledMove);
      window.addEventListener('pointerup', finishPointer);
      window.addEventListener('pointercancel', finishPointer);
      targetEl.addEventListener('lostpointercapture', finishPointer);
    },
    [
      wsId,
      groupId,
      cardsLength,
      setDraggedTab,
      mergeTab,
      detachTabToStandalone,
      closeTabInGroup,
    ]
  );

  return { handleTabPointerDown };
}
