/**
 * 工作区 / 标签 DnD / 面板相关 action 实现。
 * 仍挂在同一 useLayoutStore，不单独建 zustand store。
 *
 * 面板开合/收尾委托 layoutHelpers 纯 API，避免 ghost chat 列与空壳布局。
 */

import type {
  CardState,
  CardGroupState,
  ColumnState,
  DropPreviewState,
  WorkspaceState,
} from './types';
import type { LayoutSnapshot } from '../api/workspaceLayoutStore';
import {
  adjustSameGroupReorderIndex,
  afterCardRemovedFromGroup,
  clampToolTargetColIdx,
  createDefaultWorkspace,
  ensureChatColumn,
  ensureToolColumn,
  extractCardFromGroup,
  findGroupInWorkspace,
  insertCardIntoGroup,
  isChatColumn,
  makePanelCard,
  makePanelGroup,
  normalizeColumnWidths,
  placePanelCard,
  collapseToolColumnToTabs,
  pruneEmptyWorkspaceLayout,
  rebalanceGroupHeights,
  removePanelCard,
  resolveWorkspacePanelKey,
} from './layoutHelpers';

/** 拖拽中的标签状态（与 LayoutStore.draggedTab 形状一致） */
export interface DraggedTabState {
  cardId: string;
  sourceGroupId: string;
  workspaceId: string;
  isTabDrag?: boolean;
}

/**
 * 工作区域 action 需要读写的 store 切片（避免与 layoutStore 循环 import）。
 * 字段名/形状须与 LayoutStore 对齐；LayoutStore 必须 extends 本切片。
 */
export interface WorkspaceStoreSlice {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
}

/** 工作区 / DnD / 面板域 action 签名（与 LayoutStore 同名方法一致） */
export interface WorkspaceActions {
  setDropPreview: (preview: DropPreviewState | null) => void;
  togglePanel: (wsId: string, key: string, isVisible: boolean) => void;
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void;
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void;
  setDraggedTab: (dragged: DraggedTabState | null) => void;
  mergeTab: (wsId: string, cardId: string, sourceGroupId: string, targetGroupId: string, targetIndex?: number) => void;
  detachTabToStandalone: (wsId: string, cardId: string, sourceGroupId: string, colIdx: number, direction: 'top' | 'bottom' | 'new-col', targetGroupIdx?: number) => void;
  moveTabOrGroupRealtime: (wsId: string, cardId: string, sourceGroupId: string, targetColIdx: number, targetGroupIdx: number) => void;
  closeTabInGroup: (wsId: string, groupId: string, cardId: string) => void;
  splitScreenWorkspace: (sessionId: string) => void;
  closeWorkspace: (wsId: string) => void;
  applyLayoutPreset: (preset: 'developer-split' | 'full-chat' | 'telemetry-focus') => void;
  /** 从项目布局快照还原活动工作区 columns（卡片 id / 宽高比 / active） */
  applyWorkspaceLayout: (snapshot: LayoutSnapshot) => void;
}

/**
 * immer set / get：泛型 T extends WorkspaceStoreSlice，避免 layoutStore 侧 `as any`。
 */
export type WorkspaceImmerSet<T extends WorkspaceStoreSlice = WorkspaceStoreSlice> = (
  recipe: (state: T) => void,
) => void;
export type WorkspaceStoreGet<T extends WorkspaceStoreSlice = WorkspaceStoreSlice> = () => T;

/** 定位工作区；缺失或空切片时返回 null（empty workspace guard） */
function findWorkspace(
  state: WorkspaceStoreSlice,
  wsId: string,
): WorkspaceState | null {
  if (!state.workspaces.length) return null;
  return state.workspaces.find((w) => w.id === wsId) ?? null;
}

/** 活动工作区；越界 / 空列表 → null */
function activeWorkspace(state: WorkspaceStoreSlice): WorkspaceState | null {
  if (!state.workspaces.length) return null;
  const idx = Math.min(
    Math.max(0, state.activeWorkspaceIndex),
    state.workspaces.length - 1,
  );
  return state.workspaces[idx] ?? null;
}

/**
 * 创建工作区域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 */
export function createWorkspaceActions<T extends WorkspaceStoreSlice>(
  set: WorkspaceImmerSet<T>,
  _get: WorkspaceStoreGet<T>,
): WorkspaceActions {
  return {
    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),

    togglePanel: (wsId, key, isVisible) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;

      // 浮层 / 空 key / chat 关：不进列；仅 ensure chat 锁列（无 ghost）
      if (isVisible) {
        placePanelCard(ws, key, { tabMode: state.tabModeEnabled });
        ensureChatColumn(ws);
        return;
      }

      // chat 不可关；settings/runtime 等浮层 remove 也会 skipped
      removePanelCard(ws, key);
      ensureChatColumn(ws);
    }),

    resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws || ws.columns.length < 2) return;
      if (!Number.isFinite(containerWidth) || containerWidth <= 0) return;
      if (colIdx < 0 || colIdx >= ws.columns.length - 1) return;

      const colLeft = ws.columns[colIdx];
      const colRight = ws.columns[colIdx + 1];
      if (!colLeft || !colRight) return;

      const ratioDelta = dx / containerWidth;
      const newLeft = colLeft.widthRatio + ratioDelta;
      const newRight = colRight.widthRatio - ratioDelta;

      // 侧栏/主列最小约 12%：过窄时 Diff 容器查询仍可读，但禁止拖到不可用宽度
      if (newLeft > 0.12 && newRight > 0.12) {
        colLeft.widthRatio = newLeft;
        colRight.widthRatio = newRight;
      }
    }),

    resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length) return;
      if (!Number.isFinite(containerHeight) || containerHeight <= 0) return;

      const col = ws.columns[colIdx];
      if (!col || col.groups.length < 2) return;
      if (groupIdx < 0 || groupIdx >= col.groups.length - 1) return;

      const groupTop = col.groups[groupIdx];
      const groupBottom = col.groups[groupIdx + 1];
      if (!groupTop || !groupBottom) return;

      const ratioDelta = dy / containerHeight;
      const newTop = groupTop.heightRatio + ratioDelta;
      const newBottom = groupBottom.heightRatio - ratioDelta;

      if (newTop > 0.1 && newBottom > 0.1) {
        groupTop.heightRatio = newTop;
        groupBottom.heightRatio = newBottom;
      }
    }),

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

    splitScreenWorkspace: (_sessionId) => set((state) => {
      // empty workspace guard：无工作区时先落默认再分屏
      if (!state.workspaces.length) {
        state.workspaces.push(createDefaultWorkspace('ws-0'));
        state.activeWorkspaceIndex = 0;
      }
      const newWsId = `ws-${Date.now()}`;
      state.workspaces.push(createDefaultWorkspace(newWsId));
      state.activeWorkspaceIndex = state.workspaces.length - 1;
    }),

    closeWorkspace: (wsId) => set((state) => {
      if (state.workspaces.length <= 1) {
        // 唯一工作区：不删；夹紧 index + ensure chat
        if (state.workspaces.length === 1) {
          state.activeWorkspaceIndex = 0;
          ensureChatColumn(state.workspaces[0]!);
        } else if (state.workspaces.length === 0) {
          state.workspaces.push(createDefaultWorkspace('ws-0'));
          state.activeWorkspaceIndex = 0;
        }
        return;
      }
      const idx = state.workspaces.findIndex((w) => w.id === wsId);
      if (idx === -1) return;
      state.workspaces.splice(idx, 1);
      // 关闭当前或左侧：落到前一个；关闭右侧：index 夹紧
      if (state.activeWorkspaceIndex >= state.workspaces.length) {
        state.activeWorkspaceIndex = state.workspaces.length - 1;
      } else if (state.activeWorkspaceIndex > idx) {
        state.activeWorkspaceIndex -= 1;
      } else if (state.activeWorkspaceIndex === idx) {
        state.activeWorkspaceIndex = Math.max(0, idx - 1);
      }
      state.activeWorkspaceIndex = Math.min(
        Math.max(0, state.activeWorkspaceIndex),
        state.workspaces.length - 1,
      );
    }),

    applyLayoutPreset: (preset) => set((state) => {
      const ws = activeWorkspace(state);
      if (!ws) return;

      const chatCol = (widthRatio: number): ColumnState => ({
        id: `col-chat-${ws.id}`,
        widthRatio,
        groups: [
          makePanelGroup('chat', ws.id, {
            groupId: `group-chat-${ws.id}`,
            heightRatio: 1,
          }),
        ],
      });
      const toolCol = (
        panelId: string,
        widthRatio: number,
        colKey: string,
      ): ColumnState => ({
        id: `col-${colKey}-${ws.id}`,
        widthRatio,
        groups: [
          makePanelGroup(panelId, ws.id, {
            groupId: `group-${panelId}-${ws.id}`,
            heightRatio: 1,
          }),
        ],
      });

      if (preset === 'developer-split') {
        ws.columns = [
          chatCol(0.38),
          toolCol('preview', 0.31, '1'),
          toolCol('diff', 0.31, '2'),
        ];
      } else if (preset === 'full-chat') {
        ws.columns = [chatCol(1.0)];
      } else if (preset === 'telemetry-focus') {
        // runtime 为浮层，禁止写入列（避免 ghost runtime 列）
        // 遥测焦点：对话 + 终端并排
        ws.columns = [
          chatCol(0.5),
          toolCol('terminal', 0.5, 'terminal'),
        ];
      }

      // 单一 chat 列 + 无空壳
      ensureChatColumn(ws);
      pruneEmptyWorkspaceLayout(ws, true);
      normalizeColumnWidths(ws);
    }),

    applyWorkspaceLayout: (snapshot) => set((state) => {
      const ws = activeWorkspace(state);
      if (!ws || !snapshot?.columns?.length) return;

      const stamp = Date.now();
      const nextColumns: ColumnState[] = [];

      snapshot.columns.forEach((colSnap, ci) => {
        const groups: CardGroupState[] = [];
        (colSnap.groups || []).forEach((gSnap, gi) => {
          const rawIds = (gSnap.cards || []).filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          );
          if (rawIds.length === 0) return;

          // 归一 key；浮层（settings/runtime）丢弃；browser→preview
          const seen = new Set<string>();
          const cards: CardState[] = [];
          for (const raw of rawIds) {
            const id = resolveWorkspacePanelKey(raw);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            cards.push(makePanelCard(id));
          }
          if (cards.length === 0) return;

          const activeResolved = resolveWorkspacePanelKey(gSnap.activeCardId);
          const activeCardId = cards.some((c) => c.id === activeResolved)
            ? (activeResolved as string)
            : cards![0]!.id;
          groups.push({
            id: `group-snap-${ci}-${gi}-${stamp}-${ws.id}`,
            activeCardId,
            cards,
            heightRatio:
              typeof gSnap.heightRatio === 'number' && gSnap.heightRatio > 0
                ? gSnap.heightRatio
                : 1,
          });
        });
        if (groups.length === 0) return;

        const hasChat = groups.some((g) => g.cards.some((c) => c.id === 'chat'));
        const hSum = groups.reduce((a, g) => a + g.heightRatio, 0) || 1;
        groups.forEach((g) => {
          g.heightRatio /= hSum;
        });

        nextColumns.push({
          id: hasChat ? `col-chat-${ws.id}` : `col-snap-${ci}-${stamp}-${ws.id}`,
          widthRatio:
            typeof colSnap.widthRatio === 'number' && colSnap.widthRatio > 0
              ? colSnap.widthRatio
              : 1,
          groups,
        });
      });

      if (nextColumns.length === 0) {
        ensureChatColumn(ws);
        return;
      }

      // 保证最多一列 chat，且 chat 列在前（无 ghost 多 chat 列）
      const chatCols = nextColumns.filter((c) => isChatColumn(c));
      const toolCols = nextColumns.filter((c) => !isChatColumn(c));
      if (chatCols.length > 1) {
        // 治理防线 #3（noUncheckedIndexedAccess）：chatCols[0] 在 noUncheckedIndexedAccess 下为 T | undefined
        // length > 1 已保证 [0] 存在，但需显式守卫
        const primary = chatCols[0];
        if (!primary) {
          ws.columns = toolCols;
          return;
        }
        for (let i = 1; i < chatCols.length; i++) {
          const secondary = chatCols[i];
          if (!secondary) continue;
          // 合并时去掉重复 chat 卡
          for (const g of secondary.groups) {
            g.cards = g.cards.filter((c) => c.id !== 'chat');
            if (g.cards.length === 0) continue;
            if (g.activeCardId === 'chat') {
              const firstCard = g.cards[0];
              if (firstCard) g.activeCardId = firstCard.id;
            }
            primary.groups.push(g);
          }
        }
        primary.groups = primary.groups.filter((g) => g.cards.length > 0);
        const hSum = primary.groups.reduce((a, g) => a + g.heightRatio, 0) || 1;
        primary.groups.forEach((g) => {
          g.heightRatio /= hSum;
        });
        ws.columns = [primary, ...toolCols];
      } else if (chatCols.length === 1) {
        const chatCol = chatCols[0];
        if (chatCol) {
          ws.columns = [chatCol, ...toolCols];
        } else {
          ws.columns = toolCols;
        }
      } else {
        ws.columns = toolCols;
      }

      ensureChatColumn(ws);
      pruneEmptyWorkspaceLayout(ws, true);
      normalizeColumnWidths(ws);
      // 合并标签默认：还原布局后折叠工具列堆叠 group
      if (state.tabModeEnabled) {
        collapseToolColumnToTabs(ws);
      }
    }),
  };
}
