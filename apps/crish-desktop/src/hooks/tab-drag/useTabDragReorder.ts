import React from 'react';
import {
  getWorkspaceStoreState,
  setDropPreview,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import type { DropPreviewState } from '../../store/types';
import { DEFAULT_TAB_BAR_H } from '../../store/layoutHelpers';
import {
  canCommitTabDrop,
  dropPreviewEquals,
  dropTypeToDetachPlacement,
  findCardSnapshotAtPoint,
  findGroupIndicesInWorkspace,
  isChatGroupTarget,
  isMergeLikeDropType,
  isOnlyCardInSourceColumn,
  resolveTabBarHeight,
  resolveTabDrop,
  type DropType,
  type TabDropResolveResult,
} from './tabDragGeometry';
import { removeInsertLine, showTabInsertLine } from './tabDragGhost';

export interface CardSnapshot {
  element: HTMLElement;
  rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  colIdx: number;
  groupIdx: number;
  groupId: string;
}

export function safeSetDropPreview(nextPreview: DropPreviewState | null): void {
  const currentPreview = getWorkspaceStoreState().dropPreview;
  if (!nextPreview) {
    if (currentPreview !== null) {
      setDropPreview(null);
    }
    return;
  }
  if (!dropPreviewEquals(currentPreview, nextPreview)) {
    setDropPreview(nextPreview);
  }
}

export function useTabDragReorder() {
  const setDraggedTab = useWorkspaceStore((s) => s.setDraggedTab);
  const mergeTab = useWorkspaceStore((s) => s.mergeTab);
  const detachTabToStandalone = useWorkspaceStore(
    (s) => s.detachTabToStandalone
  );
  const closeTabInGroup = useWorkspaceStore((s) => s.closeTabInGroup);

  const evaluateMoveDrop = React.useCallback(
    (params: {
      mouseX: number;
      mouseY: number;
      cardSnapshots: readonly CardSnapshot[];
      wsId: string;
      sourceGroupId: string;
      cardsLength: number;
      isDragFromTabButton: boolean;
      cardId: string;
    }): TabDropResolveResult | null => {
      const {
        mouseX,
        mouseY,
        cardSnapshots,
        wsId,
        sourceGroupId,
        cardsLength,
        isDragFromTabButton,
        cardId,
      } = params;

      const matchedSnapshot = findCardSnapshotAtPoint(
        cardSnapshots,
        mouseX,
        mouseY
      );

      if (!matchedSnapshot) {
        safeSetDropPreview(null);
        return null;
      }

      const targetRect = matchedSnapshot.rect;
      const relX = mouseX - targetRect.left;
      const relY = mouseY - targetRect.top;

      const targetColIdx = matchedSnapshot.colIdx;
      const targetGroupIdx = matchedSnapshot.groupIdx;
      const targetGroupId = matchedSnapshot.groupId;

      const currentDraggedTab = getWorkspaceStoreState().draggedTab;
      const currentSourceGroupId =
        currentDraggedTab?.sourceGroupId ?? sourceGroupId;

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
      const tabsBarCandidate =
        matchedSnapshot.element.querySelector('.tabs-bar');
      const tabsBar =
        tabsBarCandidate instanceof HTMLElement ? tabsBarCandidate : null;
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

      safeSetDropPreview(resolved.preview);
      return resolved;
    },
    []
  );

  const commitTabDrop = React.useCallback(
    (params: {
      wsId: string;
      cardId: string;
      sourceGroupId: string;
      lastDropType: DropType | null;
      cancelled: boolean;
      lastTargetGroupId: string | null;
      lastTargetColIdx: number;
      lastTargetGroupIdx: number | undefined;
      lastTabInsertIdx: number | undefined;
    }): { destGroupId: string | null } => {
      const {
        wsId,
        cardId,
        sourceGroupId,
        lastDropType,
        cancelled,
        lastTargetGroupId,
        lastTargetColIdx,
        lastTargetGroupIdx,
        lastTabInsertIdx,
      } = params;

      let destGroupId: string | null = sourceGroupId;

      const commit = canCommitTabDrop({
        dropType: lastDropType,
        cancelled,
        sourceGroupId,
        targetGroupId: lastTargetGroupId,
        tabInsertIdx: lastTabInsertIdx,
      });

      if (commit && lastDropType) {
        if (lastDropType === 'merge' && lastTargetGroupId) {
          mergeTab(
            wsId,
            cardId,
            sourceGroupId,
            lastTargetGroupId,
            lastTabInsertIdx
          );
          destGroupId = lastTargetGroupId;
        } else if (lastDropType === 'self-reorder') {
          mergeTab(
            wsId,
            cardId,
            sourceGroupId,
            sourceGroupId,
            lastTabInsertIdx
          );
          destGroupId = sourceGroupId;
        } else {
          const placement = dropTypeToDetachPlacement(lastDropType);
          if (placement === 'top' || placement === 'bottom') {
            detachTabToStandalone(
              wsId,
              cardId,
              sourceGroupId,
              lastTargetColIdx,
              placement,
              lastTargetGroupIdx
            );
            destGroupId = null;
          } else if (placement === 'new-col') {
            detachTabToStandalone(
              wsId,
              cardId,
              sourceGroupId,
              lastTargetColIdx,
              'new-col'
            );
            destGroupId = null;
          }
        }
      }

      return { destGroupId };
    },
    [mergeTab, detachTabToStandalone]
  );

  return {
    setDraggedTab,
    mergeTab,
    detachTabToStandalone,
    closeTabInGroup,
    evaluateMoveDrop,
    commitTabDrop,
  };
}
