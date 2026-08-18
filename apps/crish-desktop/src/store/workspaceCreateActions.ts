/**
 * 工作区创建/关闭/布局预设域 actions（T4-7 拆分）。
 * 包含：splitScreenWorkspace / closeWorkspace / applyLayoutPreset / applyWorkspaceLayout。
 */
import type {
  CardState,
  CardGroupState,
  ColumnState,
} from './types';
import {
  createDefaultWorkspace,
  ensureChatColumn,
  isChatColumn,
  makePanelCard,
  makePanelGroup,
  normalizeColumnWidths,
  pruneEmptyWorkspaceLayout,
  resolveWorkspacePanelKey,
  collapseToolColumnToTabs,
} from './layoutHelpers';
import type {
  WorkspaceImmerSet,
  WorkspaceStoreGet,
  WorkspaceStoreSlice,
} from './workspaceActionsCore';
import { activeWorkspace } from './workspaceActionsCore';

/** 工作区创建/关闭/预设/布局还原域 actions 签名 */
export interface WorkspaceCreateActionsSlice {
  splitScreenWorkspace: (sessionId: string) => void;
  closeWorkspace: (wsId: string) => void;
  applyLayoutPreset: (preset: 'developer-split' | 'full-chat' | 'telemetry-focus') => void;
  /** 从项目布局快照还原活动工作区 columns（卡片 id / 宽高比 / active） */
  applyWorkspaceLayout: (snapshot: import('./workspaceActionsCore').LayoutSnapshot) => void;
}

/**
 * 创建工作区创建/关闭/预设/布局还原域 actions。
 * 供 createWorkspaceActions 展开（T4-7 拆分）。
 */
export function createWorkspaceCreateActions<T extends WorkspaceStoreSlice>(
  set: WorkspaceImmerSet<T>,
  get: WorkspaceStoreGet<T>,
): WorkspaceCreateActionsSlice {
  return {
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
