/**
 * 工作区标签/卡片切换 + DnD 域 actions（T4-7 拆分）。
 * 包含：setDraggedTab / mergeTab / detachTabToStandalone /
 * moveTabOrGroupRealtime / closeTabInGroup /
 * setGroupActiveCard / focusExistingPanelCard / collapseToolColumnPreserve。
 */
import type {
  CardGroupState,
  ColumnState,
} from './types';
import {
  adjustSameGroupReorderIndex,
  afterCardRemovedFromGroup,
  clampToolTargetColIdx,
  ensureChatColumn,
  ensureToolColumn,
  expandToolColumnIfCollapsed,
  extractCardFromGroup,
  findGroupInWorkspace,
  insertCardIntoGroup,
  isChatColumn,
  makePanelCard,
  makePanelGroup,
  normalizeColumnWidths,
  pruneEmptyWorkspaceLayout,
  rebalanceGroupHeights,
  collapseToolColumnPreserve as collapseToolColumnPreserveHelper,
} from './layoutHelpers';
import type {
  DraggedTabState,
  WorkspaceImmerSet,
  WorkspaceStoreGet,
  WorkspaceStoreSlice,
} from './workspaceActionsCore';
import { findWorkspace } from './workspaceActionsCore';

/** 标签/卡片切换 + DnD 域 actions 签名 */
export interface WorkspaceSwitchActionsSlice {
  setDraggedTab: (dragged: DraggedTabState | null) => void;
  mergeTab: (wsId: string, cardId: string, sourceGroupId: string, targetGroupId: string, targetIndex?: number) => void;
  detachTabToStandalone: (wsId: string, cardId: string, sourceGroupId: string, colIdx: number, direction: 'top' | 'bottom' | 'new-col', targetGroupIdx?: number) => void;
  moveTabOrGroupRealtime: (wsId: string, cardId: string, sourceGroupId: string, targetColIdx: number, targetGroupIdx: number) => void;
  closeTabInGroup: (wsId: string, groupId: string, cardId: string) => void;
  /** 置 group 活动卡（P3-4：facade 转发到本真 action） */
  setGroupActiveCard: (wsId: string, colIdx: number, groupIdx: number, cardId: string) => void;
  /** 聚焦既有面板卡（含工具列展开副作用）；返回是否找到（P3-4 转发） */
  focusExistingPanelCard: (wsId: string, cardId: string) => boolean;
  /** 折叠工具列并保留活动卡（C4：旧列壳 chrome hooks 已迁入本 action） */
  collapseToolColumnPreserve: (wsId: string) => void;
}

/**
 * 创建标签/卡片切换 + DnD 域 actions。
 * 供 createWorkspaceActions 展开（T4-7 拆分）。
 */
export function createWorkspaceSwitchActions<T extends WorkspaceStoreSlice>(
  set: WorkspaceImmerSet<T>,
  _get: WorkspaceStoreGet<T>,
): WorkspaceSwitchActionsSlice {
  return {
    setDraggedTab: (dragged) => set((state) => {
      state.draggedTab = dragged;
    }),

    mergeTab: (wsId, cardId, sourceGroupId, targetGroupId, targetIndex) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;
      // chat 锁卡不参与跨组 merge，避免 ghost 工具列塞对话
      if (cardId === 'chat' && sourceGroupId !== targetGroupId) {
        ensureChatColumn(ws);
        return;
      }

      // ── Same-group reorder ──────────────────────────────────────────────
      if (sourceGroupId === targetGroupId) {
        const loc = findGroupInWorkspace(ws, sourceGroupId);
        if (!loc) return;
        const { group } = loc;
        const fromIdx = group.cards.findIndex((c) => c.id === cardId);
        if (fromIdx === -1) return;
        // 治理防线 #3（noUncheckedIndexedAccess）：splice 返回数组，解构可能 undefined
        // fromIdx !== -1 且 splice(fromIdx, 1) 必返回单元素数组，但需显式守卫
        const [card] = group.cards.splice(fromIdx, 1);
        if (card === undefined) return;
        const toIdx = adjustSameGroupReorderIndex(
          fromIdx,
          targetIndex,
          group.cards.length,
        );
        group.cards.splice(toIdx, 0, card);
        group.activeCardId = cardId;
        return;
      }

      // ── Cross-group merge ───────────────────────────────────────────────
      const extracted = extractCardFromGroup(ws, sourceGroupId, cardId);
      const targetLoc = findGroupInWorkspace(ws, targetGroupId);
      if (!extracted || !targetLoc) {
        // 目标失效时把抽出的卡塞回源组，避免丢卡
        if (extracted) {
          insertCardIntoGroup(
            extracted.sourceGroup,
            extracted.card,
            extracted.removedIndex,
          );
        }
        ensureChatColumn(ws);
        return;
      }

      const { card: draggedCard, sourceGroup, removedIndex } = extracted;
      insertCardIntoGroup(targetLoc.group, draggedCard, targetIndex);

      afterCardRemovedFromGroup(ws, sourceGroup, sourceGroupId, cardId, removedIndex);
      pruneEmptyWorkspaceLayout(ws, true);
      ensureChatColumn(ws);

      if (
        state.draggedTab &&
        state.draggedTab.cardId === cardId &&
        state.draggedTab.sourceGroupId === sourceGroupId
      ) {
        state.draggedTab.sourceGroupId = targetGroupId;
      }
    }),

    detachTabToStandalone: (wsId, cardId, sourceGroupId, colIdx, direction, targetGroupIdx) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;
      // 禁止 detach chat（锁列）
      if (cardId === 'chat') {
        ensureChatColumn(ws);
        return;
      }

      const extracted = extractCardFromGroup(ws, sourceGroupId, cardId);
      if (!extracted) return;

      const { sourceGroup, sourceCol, removedIndex, card: extractedCard } = extracted;

      // 源列仅 1 个空 group 时即将被删除，可继承其宽度
      const isSourceColGoingToBeDeleted =
        sourceCol.groups.length === 1 && sourceCol!.groups[0]!.cards.length === 0;

      const inheritedWidth = isSourceColGoingToBeDeleted ? sourceCol.widthRatio : 0.3;
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newGroup = makePanelGroup(cardId, ws.id, {
        groupId: `group-det-${cardId}-${stamp}-${ws.id}`,
        heightRatio: 1,
      });
      // 保留 extract 出的 title（自定义标题）
      newGroup.cards[0] = extractedCard.id === cardId
        ? extractedCard
        : makePanelCard(cardId);
      newGroup.activeCardId = cardId;

      if (direction === 'new-col') {
        const insertAt = Math.min(Math.max(0, colIdx), ws.columns.length);
        // 勿插在 chat 列左侧制造「第二 chat 位」错觉：col0 已是 chat 时至少插到 1
        const safeInsert =
          insertAt === 0 && ws.columns.some((c) => isChatColumn(c))
            ? 1
            : insertAt;
        const newCol: ColumnState = {
          id: `col-new-${Date.now()}-${ws.id}`,
          widthRatio: inheritedWidth,
          groups: [newGroup],
        };
        ws.columns.splice(safeInsert, 0, newCol);
      } else {
        // 落到 chat 列则改放到工具列，避免工具卡进对话列
        let col = ws.columns[colIdx];
        if (!col || isChatColumn(col)) {
          col = ensureToolColumn(ws);
        }
        const groupsLen = col.groups.length;
        if (targetGroupIdx !== undefined && targetGroupIdx >= 0 && targetGroupIdx <= groupsLen) {
          const insertIdx = direction === 'top' ? targetGroupIdx : targetGroupIdx + 1;
          col.groups.splice(Math.min(Math.max(0, insertIdx), groupsLen), 0, newGroup);
        } else if (direction === 'top') {
          col.groups.unshift(newGroup);
        } else {
          col.groups.push(newGroup);
        }
        rebalanceGroupHeights(col);
      }

      afterCardRemovedFromGroup(ws, sourceGroup, sourceGroupId, cardId, removedIndex);
      pruneEmptyWorkspaceLayout(ws, true);
      ensureChatColumn(ws);

      if (
        state.draggedTab &&
        state.draggedTab.cardId === cardId &&
        state.draggedTab.sourceGroupId === sourceGroupId
      ) {
        state.draggedTab.sourceGroupId = newGroup.id;
      }
    }),

    moveTabOrGroupRealtime: (wsId, cardId, sourceGroupId, targetColIdx, targetGroupIdx) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;
      if (cardId === 'chat') {
        ensureChatColumn(ws);
        return;
      }

      const extracted = extractCardFromGroup(ws, sourceGroupId, cardId);
      if (!extracted) return;

      const { sourceCol, sourceGroup, removedIndex, card: extractedCard } = extracted;

      afterCardRemovedFromGroup(ws, sourceGroup, sourceGroupId, cardId, removedIndex);
      if (sourceGroup.cards.length === 0 && sourceCol.groups.length > 0) {
        rebalanceGroupHeights(sourceCol);
      }

      // 剪空壳后再保证有工具列可落（仅 chat 时 ensureToolColumn）
      pruneEmptyWorkspaceLayout(ws, false);
      ensureChatColumn(ws);
      if (ws.columns.length < 2) {
        ensureToolColumn(ws);
      }
      normalizeColumnWidths(ws);

      const colIdx = clampToolTargetColIdx(targetColIdx, ws.columns.length);
      let col = ws.columns[colIdx];
      // 仍落在 chat → 强制工具列
      if (!col || isChatColumn(col)) {
        col = ensureToolColumn(ws);
      }

      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newGroup: CardGroupState = makePanelGroup(cardId, ws.id, {
        groupId: `group-det-${cardId}-${stamp}-${ws.id}`,
        heightRatio: 1,
      });
      newGroup.cards[0] = extractedCard;
      newGroup.activeCardId = cardId;

      const insertIdx = Math.min(Math.max(targetGroupIdx, 0), col.groups.length);
      col.groups.splice(insertIdx, 0, newGroup);
      rebalanceGroupHeights(col);
      ensureChatColumn(ws);

      if (state.draggedTab && state.draggedTab.cardId === cardId) {
        state.draggedTab.sourceGroupId = newGroup.id;
      }
    }),

    closeTabInGroup: (wsId, groupId, cardId) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;

      // 关 chat 锁卡：仅 ensure，不删
      if (cardId === 'chat') {
        ensureChatColumn(ws);
        return;
      }

      const loc = findGroupInWorkspace(ws, groupId);
      if (loc) {
        const removedIndex = loc.group.cards.findIndex((c) => c.id === cardId);
        if (removedIndex !== -1) {
          loc.group.cards = loc.group.cards.filter((c) => c.id !== cardId);
          afterCardRemovedFromGroup(ws, loc.group, groupId, cardId, removedIndex);
        }
      }

      pruneEmptyWorkspaceLayout(ws, true);
      ensureChatColumn(ws);
    }),

    // ── P3-4：facade recipe 迁入的真 action（W1/W2/C4）────────────

    setGroupActiveCard: (wsId, colIdx, groupIdx, cardId) => set((state) => {
      const group = state.workspaces.find((w) => w.id === wsId)?.columns[colIdx]
        ?.groups[groupIdx];
      if (group) group.activeCardId = cardId;
    }),

    focusExistingPanelCard: (wsId, cardId) => {
      let found = false;
      set((state) => {
        const ws = findWorkspace(state, wsId);
        if (!ws) return;
        for (const c of ws.columns) {
          for (const g of c.groups) {
            if (g.cards.some((card) => card.id === cardId)) {
              g.activeCardId = cardId;
              found = true;
              expandToolColumnIfCollapsed(ws);
              return;
            }
          }
        }
      });
      return found;
    },

    collapseToolColumnPreserve: (wsId) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;
      collapseToolColumnPreserveHelper(ws);
    }),
  };
}
