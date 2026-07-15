/**
 * 工作区 / 标签 DnD / 面板相关 action 实现。
 * 仍挂在同一 useLayoutStore，不单独建 zustand store。
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
  ensureChatColumn,
  createDefaultWorkspace,
  getPanelTitle,
  normalizeColumnWidths,
  rebalanceGroupHeights,
  filterEmptyColumnsKeepingChat,
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
 * 字段名/形状须与 LayoutStore 对齐。
 */
interface WorkspaceStoreSlice {
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

/** immer set：recipe 可原地改 draft */
type ImmerSet = (recipe: (state: WorkspaceStoreSlice) => void) => void;
type StoreGet = () => WorkspaceStoreSlice;

/**
 * 创建工作区域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 */
export function createWorkspaceActions(set: ImmerSet, _get: StoreGet): WorkspaceActions {
  return {
    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),

    togglePanel: (wsId, key, isVisible) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // Runtime telemetry is a floating sheet — never a workspace column
      if (key === 'runtime') {
        ensureChatColumn(ws);
        return;
      }
      // Chat cannot be toggled off
      if (key === 'chat' && !isVisible) {
        ensureChatColumn(ws);
        return;
      }

      // browser 与 preview 同一面板
      const cardId = key === 'browser' ? 'preview' : key;
      const cardTitle = getPanelTitle(cardId);

      if (isVisible) {
        let alreadyExists = false;
        ws.columns.forEach((col) => {
          col.groups.forEach((g) => {
            if (g.cards.some((c) => c.id === cardId)) {
              alreadyExists = true;
              g.activeCardId = cardId;
            }
          });
        });
        if (alreadyExists) {
          ensureChatColumn(ws);
          return;
        }

        // Open beside chat: never put tools into the chat column
        ensureChatColumn(ws);
        let toolCol = ws.columns.find((c) => !c.id.includes('chat'));
        if (!toolCol) {
          toolCol = {
            id: `col-tools-${ws.id}`,
            widthRatio: 0.34,
            groups: [],
          };
          ws.columns.push(toolCol);
          // Give chat the rest
          const chatCol = ws.columns.find((c) => c.id.includes('chat'));
          if (chatCol) chatCol.widthRatio = 0.66;
        }

        if (state.tabModeEnabled && toolCol.groups.length > 0) {
          const targetGroup = toolCol.groups[0];
          targetGroup.cards.push({ id: cardId, title: cardTitle });
          targetGroup.activeCardId = cardId;
          ensureChatColumn(ws);
          return;
        }

        toolCol.groups.push({
          id: `group-${cardId}-${Date.now()}-${ws.id}`,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: 1,
        });
        rebalanceGroupHeights(toolCol);

        ensureChatColumn(ws);
        normalizeColumnWidths(ws);
      } else {
        ws.columns.forEach((col) => {
          // Never strip chat cards
          col.groups.forEach((group) => {
            const cardIdx = group.cards.findIndex((c) => c.id === cardId);
            if (cardIdx !== -1 && cardId !== 'chat') {
              group.cards.splice(cardIdx, 1);
              if (group.activeCardId === cardId && group.cards.length > 0) {
                group.activeCardId = group.cards[0].id;
              }
            }
          });
          col.groups = col.groups.filter((g) => g.cards.length > 0);
          rebalanceGroupHeights(col);
        });

        ensureChatColumn(ws);
        normalizeColumnWidths(ws);
      }
    }),

    resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length - 1) return;

      const colLeft = ws.columns[colIdx];
      const colRight = ws.columns[colIdx + 1];

      const ratioDelta = dx / containerWidth;
      const newLeft = colLeft.widthRatio + ratioDelta;
      const newRight = colRight.widthRatio - ratioDelta;

      if (newLeft > 0.1 && newRight > 0.1) {
        colLeft.widthRatio = newLeft;
        colRight.widthRatio = newRight;
      }
    }),

    resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length) return;

      const col = ws.columns[colIdx];
      if (groupIdx < 0 || groupIdx >= col.groups.length - 1) return;

      const groupTop = col.groups[groupIdx];
      const groupBottom = col.groups[groupIdx + 1];

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
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // ── Same-group reorder (tab drag within same card) ──────────────────
      if (sourceGroupId === targetGroupId) {
        let group: any = null;
        ws.columns.forEach((col) => col.groups.forEach((g) => {
          if (g.id === sourceGroupId) group = g;
        }));
        if (!group) return;
        const fromIdx = group.cards.findIndex((c: CardState) => c.id === cardId);
        if (fromIdx === -1) return;
        const [card] = group.cards.splice(fromIdx, 1);
        // Adjust index for the gap created by removal
        let toIdx = targetIndex !== undefined ? targetIndex : group.cards.length;
        if (toIdx > fromIdx) toIdx = Math.max(0, toIdx - 1);
        toIdx = Math.min(toIdx, group.cards.length);
        group.cards.splice(toIdx, 0, card);
        group.activeCardId = cardId;
        return;
      }

      // ── Cross-group merge ───────────────────────────────────────────────
      let sourceGroup: any = null;
      let targetGroup: any = null;
      let draggedCard: CardState | null = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
          if (g.id === targetGroupId) {
            targetGroup = g;
          }
        });
      });

      if (!targetGroup || !draggedCard) return;

      // Add to target at specific index if provided, otherwise append
      if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= targetGroup.cards.length) {
        targetGroup.cards.splice(targetIndex, 0, draggedCard);
      } else {
        targetGroup.cards.push(draggedCard);
      }
      targetGroup.activeCardId = cardId;

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            rebalanceGroupHeights(col);
          }
        });

        filterEmptyColumnsKeepingChat(ws);
      } else if (sourceGroup) {
        // Switch active tab of source if the removed tab was active
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = targetGroupId;
      }
    }),

    detachTabToStandalone: (wsId, cardId, sourceGroupId, colIdx, direction, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      const sourceCol = ws.columns.find((col) => col.groups.some((g) => g.id === sourceGroupId));

      let sourceGroup: any = null;
      let draggedCard: CardState | null = null;

      // Extract card from source group
      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // 源列仅 1 个空 group 时即将被删除，可继承其宽度
      const isSourceColGoingToBeDeleted = sourceCol
        && sourceCol.groups.length === 1
        && sourceCol.groups[0].cards.length === 0;

      const inheritedWidth = (isSourceColGoingToBeDeleted && sourceCol) ? sourceCol.widthRatio : 0.3;

      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;

      if (direction === 'new-col') {
        // Create new column at colIdx
        const newCol: ColumnState = {
          id: `col-new-${Date.now()}-${ws.id}`,
          widthRatio: inheritedWidth,
          groups: [
            {
              id: newGroupId,
              activeCardId: cardId,
              cards: [{ id: cardId, title: cardTitle }],
              heightRatio: 1.0,
            },
          ],
        };
        ws.columns.splice(colIdx, 0, newCol);
      } else {
        // Add to existing column as a split group (top or bottom relative to targetGroupIdx)
        const col = ws.columns[colIdx];
        const newGroup: CardGroupState = {
          id: newGroupId,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: 1,
        };

        if (targetGroupIdx !== undefined && targetGroupIdx >= 0 && targetGroupIdx <= col.groups.length) {
          const insertIdx = direction === 'top' ? targetGroupIdx : targetGroupIdx + 1;
          col.groups.splice(insertIdx, 0, newGroup);
        } else if (direction === 'top') {
          col.groups.unshift(newGroup);
        } else {
          col.groups.push(newGroup);
        }
        rebalanceGroupHeights(col);
      }

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            rebalanceGroupHeights(col);
          }
        });
      } else if (sourceGroup) {
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      filterEmptyColumnsKeepingChat(ws);

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    moveTabOrGroupRealtime: (wsId, cardId, sourceGroupId, targetColIdx, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // Find source group and card
      let sourceCol: any = null;
      let sourceGroup: any = null;
      let draggedCard: any = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceCol = col;
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard || !sourceCol || !sourceGroup) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // Clean up source group if empty
      if (sourceGroup.cards.length === 0) {
        sourceCol.groups = sourceCol.groups.filter((g: any) => g.id !== sourceGroupId);
        if (sourceCol.groups.length > 0) {
          const sum = sourceCol.groups.reduce((a: number, b: any) => a + b.heightRatio, 0) || 1;
          sourceCol.groups.forEach((g: any) => { g.heightRatio /= sum; });
        }
      } else {
        if (sourceGroup.activeCardId === cardId) {
          sourceGroup.activeCardId = sourceGroup.cards[0].id;
        }
      }

      // Clean up empty columns (except Chat column); only re-normalize when count changes
      const oldColCount = ws.columns.length;
      filterEmptyColumnsKeepingChat(ws, false);
      if (ws.columns.length !== oldColCount) {
        normalizeColumnWidths(ws);
      }

      // Bound targetColIdx
      const colIdx = Math.min(Math.max(targetColIdx, 1), ws.columns.length - 1);
      const col = ws.columns[colIdx];

      // Create new group
      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;
      const newGroup: CardGroupState = {
        id: newGroupId,
        activeCardId: cardId,
        cards: [{ id: cardId, title: cardTitle }],
        heightRatio: 1.0,
      };

      // Insert group at targetGroupIdx
      const insertIdx = Math.min(Math.max(targetGroupIdx, 0), col.groups.length);
      col.groups.splice(insertIdx, 0, newGroup);

      rebalanceGroupHeights(col);

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    closeTabInGroup: (wsId, groupId, cardId) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === groupId) {
            g.cards = g.cards.filter((c) => c.id !== cardId);
            if (g.activeCardId === cardId && g.cards.length > 0) {
              g.activeCardId = g.cards[0].id;
            }
          }
        });

        // Filter empty groups
        const oldGroupsLength = col.groups.length;
        col.groups = col.groups.filter((g) => g.cards.length > 0);
        if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
          rebalanceGroupHeights(col);
        }
      });

      filterEmptyColumnsKeepingChat(ws);
    }),

    splitScreenWorkspace: (_sessionId) => set((state) => {
      const newWsId = `ws-${Date.now()}`;
      state.workspaces.push(createDefaultWorkspace(newWsId));
      state.activeWorkspaceIndex = state.workspaces.length - 1;
    }),

    closeWorkspace: (wsId) => set((state) => {
      if (state.workspaces.length <= 1) return; // Keep at least one workspace
      const idx = state.workspaces.findIndex((w) => w.id === wsId);
      if (idx !== -1) {
        state.workspaces.splice(idx, 1);
        state.activeWorkspaceIndex = Math.max(0, idx - 1);
      }
    }),

    applyLayoutPreset: (preset) => set((state) => {
      const ws = state.workspaces[state.activeWorkspaceIndex];
      if (!ws) return;

      if (preset === 'developer-split') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 0.38,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-1-${ws.id}`,
            widthRatio: 0.31,
            groups: [
              {
                id: `group-preview-${ws.id}`,
                activeCardId: 'preview',
                cards: [{ id: 'preview', title: 'Preview' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-2-${ws.id}`,
            widthRatio: 0.31,
            groups: [
              {
                id: `group-diff-${ws.id}`,
                activeCardId: 'diff',
                cards: [{ id: 'diff', title: 'Diff' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      } else if (preset === 'full-chat') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 1.0,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      } else if (preset === 'telemetry-focus') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 0.5,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-runtime-${ws.id}`,
            widthRatio: 0.5,
            groups: [
              {
                id: `group-runtime-${ws.id}`,
                activeCardId: 'runtime',
                cards: [{ id: 'runtime', title: '运行状态' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      }
    }),

    applyWorkspaceLayout: (snapshot) => set((state) => {
      const ws = state.workspaces[state.activeWorkspaceIndex];
      if (!ws || !snapshot?.columns?.length) return;

      const stamp = Date.now();
      const nextColumns: ColumnState[] = [];

      snapshot.columns.forEach((colSnap, ci) => {
        const groups: CardGroupState[] = [];
        (colSnap.groups || []).forEach((gSnap, gi) => {
          const cardIds = (gSnap.cards || []).filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          );
          if (cardIds.length === 0) return;
          // runtime 为浮动面板，不进列
          const cards: CardState[] = cardIds
            .filter((id) => id !== 'runtime')
            .map((id) => ({ id, title: getPanelTitle(id) }));
          if (cards.length === 0) return;
          const activeCardId = cards.some((c) => c.id === gSnap.activeCardId)
            ? gSnap.activeCardId
            : cards[0].id;
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
        // 组内高度比归一
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

      if (nextColumns.length === 0) return;

      // 保证最多一列 chat，且 chat 列在前
      const chatCols = nextColumns.filter((c) => c.id.includes('chat'));
      const toolCols = nextColumns.filter((c) => !c.id.includes('chat'));
      if (chatCols.length > 1) {
        const primary = chatCols[0];
        for (let i = 1; i < chatCols.length; i++) {
          primary.groups.push(...chatCols[i].groups);
        }
        const hSum = primary.groups.reduce((a, g) => a + g.heightRatio, 0) || 1;
        primary.groups.forEach((g) => {
          g.heightRatio /= hSum;
        });
        ws.columns = [primary, ...toolCols];
      } else {
        ws.columns = chatCols.length ? [chatCols[0], ...toolCols] : toolCols;
      }

      ensureChatColumn(ws);
      normalizeColumnWidths(ws);
    }),
  };
}
