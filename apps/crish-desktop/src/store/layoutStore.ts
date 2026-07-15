import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Settings, CronJob, McpServer, ProviderInfo } from '../api/clientApi';
import { isDemoMode } from '../api/appMode';
import { persistAllSessions } from '../api/sessionPersistence';
import { normalizePermissionMode, type PermissionMode } from '../api/permissionModes';
import {
  addCommandPermission as persistAddCommandPermission,
  loadCommandPermissions,
  removeCommandPermission as persistRemoveCommandPermission,
  saveCommandPermissions,
} from '../api/commandPermissions';
import type {
  CardState,
  CardGroupState,
  ColumnState,
  WorkspaceState,
  FileDiff,
  SessionState,
  DropPreviewState,
} from './types';
import {
  ensureChatColumn,
  createDefaultWorkspace,
  seedSessions,
  getPanelTitle,
  normalizeColumnWidths,
  rebalanceGroupHeights,
  filterEmptyColumnsKeepingChat,
} from './layoutHelpers';
import { createSessionActions, type SessionActions } from './sessionActions';

// 保持旧 import 路径可用：`from '../store/layoutStore'`
export type {
  CardState,
  CardGroupState,
  ColumnState,
  WorkspaceState,
  DiffChange,
  FileDiff,
  MessageToolCall,
  SessionMessage,
  SessionAgent,
  SessionState,
  DropPreviewState,
} from './types';

interface DraggedTabState {
  cardId: string;
  sourceGroupId: string;
  workspaceId: string;
  isTabDrag?: boolean;
}

/** 工作区 + UI + 遥测 + 会话域（会话 actions 见 SessionActions） */
interface LayoutStore extends SessionActions {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: 'small' | 'medium' | 'large';
  sidebarCollapsed: boolean;
  sessions: SessionState[];
  folderOrder: string[];
  activeSessionId: string;
  /** 当前聚焦的子 agent（null = 看主对话） */
  activeAgentId: string | null;
  /** 右侧「协作 agent」面板要展示的 agent id */
  panelAgentId: string | null;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  showSettingsOverlay: boolean;
  settingsActiveTab: string;
  permissionMode: PermissionMode;

  // UI Settings
  setDropPreview: (preview: DropPreviewState | null) => void;
  setUiSize: (size: 'small' | 'medium' | 'large') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: string) => void;
  openSettings: (tab?: string) => void;

  // Workspace / DnD
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

  // Diff
  activeDiffSource: FileDiff | null;
  /** 本轮工具产生的多文件 diff（H2）；H3 可接 git-diff */
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (files: FileDiff[]) => void;
  pushDiffFile: (diff: FileDiff) => void;

  // Plan Mode & Permissions
  planModeEnabled: boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  planApproved: boolean;
  setPlanApproved: (approved: boolean) => void;
  commandPermissions: string[];
  addCommandPermission: (cmd: string) => void;
  removeCommandPermission: (cmd: string) => void;
  setCommandPermissions: (list: string[]) => void;

  // App Settings & Telemetry
  appSettings: Settings | null;
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  activeWorkers: { id: string; taskName: string; elapsedSeconds: number }[];
  tokenUsage: { input: number; inputMax: number; output: number; outputMax: number; cost: number };
  killedWorkerIds: string[];
  providers: ProviderInfo[];
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  syncTelemetryData: (data: any) => void;

  /** 兼容：当前活动会话的终端行 */
  terminalLines: string[];
  /** 按会话隔离的终端缓冲（H2） */
  terminalBySession: Record<string, string[]>;
  addTerminalLine: (line: string, sessionId?: string) => void;
  clearTerminalLines: (sessionId?: string) => void;
  manuallyTriggeredWorkers: { id: string; taskName: string; elapsedSeconds: number }[];
  triggerCronJobNow: (prompt: string) => void;
  killWorker: (id: string, taskName: string) => void;
  applyLayoutPreset: (preset: 'developer-split' | 'full-chat' | 'telemetry-focus') => void;
}

const _seed = seedSessions();

export const useLayoutStore = create<LayoutStore>()(
  immer((set, get) => ({
    workspaces: [createDefaultWorkspace('ws-0')],
    activeWorkspaceIndex: 0,
    tabModeEnabled: false,
    uiSize: 'medium',
    sidebarCollapsed: false,
    sessions: _seed.sessions,
    folderOrder: _seed.folderOrder,
    activeSessionId: _seed.activeSessionId,
    activeAgentId: null,
    panelAgentId: null,
    draggedTab: null,
    dropPreview: null,

    showSettingsOverlay: false,
    settingsActiveTab: 'profile',
    permissionMode: (() => {
      try {
        const v = localStorage.getItem('crish_permission_mode');
        return normalizePermissionMode(v);
      } catch {
        /* ignore */
      }
      return 'ask' as PermissionMode;
    })(),

    activeDiffSource: null,
    diffFiles: [],
    setActiveDiffSource: (diff) => set((state) => {
      state.activeDiffSource = diff;
      if (diff) {
        // 同步进列表（去重 path）
        const i = state.diffFiles.findIndex((f) => f.filePath === diff.filePath);
        if (i >= 0) state.diffFiles[i] = diff;
        else state.diffFiles.unshift(diff);
        if (state.diffFiles.length > 40) state.diffFiles.length = 40;
      }
    }),
    setDiffFiles: (files) => set((state) => {
      state.diffFiles = files;
      state.activeDiffSource = files[0] || null;
    }),
    pushDiffFile: (diff) => set((state) => {
      const i = state.diffFiles.findIndex((f) => f.filePath === diff.filePath);
      if (i >= 0) state.diffFiles[i] = diff;
      else state.diffFiles.unshift(diff);
      state.activeDiffSource = diff;
      if (state.diffFiles.length > 40) state.diffFiles.length = 40;
    }),
    planModeEnabled: false,
    setPlanModeEnabled: (enabled) => set((state) => {
      state.planModeEnabled = enabled;
    }),
    planApproved: false,
    setPlanApproved: (approved) => set((state) => {
      state.planApproved = approved;
    }),
    commandPermissions: loadCommandPermissions(),
    addCommandPermission: (cmd) =>
      set((state) => {
        state.commandPermissions = persistAddCommandPermission(state.commandPermissions, cmd);
      }),
    removeCommandPermission: (cmd: string) =>
      set((state) => {
        state.commandPermissions = persistRemoveCommandPermission(state.commandPermissions, cmd);
      }),
    setCommandPermissions: (list: string[]) =>
      set((state) => {
        state.commandPermissions = list;
        saveCommandPermissions(list);
      }),
    appSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    activeWorkers: [],
    tokenUsage: isDemoMode()
      ? { input: 115482, inputMax: 160000, output: 24930, outputMax: 40000, cost: 0.345 }
      : { input: 0, inputMax: 160000, output: 0, outputMax: 40000, cost: 0 },
    killedWorkerIds: [],

    terminalLines: isDemoMode()
      ? [
          'orange@Windows-PC MINGW64 /c/Software/conex',
          '$ npm run dev',
          '> zennav-server@1.0.0 dev',
          '> node server.js',
          '',
          '[ready] Server started on http://localhost:3000',
          '[ready] Database connection established.',
        ]
      : [],
    terminalBySession: {},
    manuallyTriggeredWorkers: [],

    setProviders: (providers) => set((state) => {
      state.providers = providers;
    }),
    setAppSettings: (settings) => set((state) => {
      state.appSettings = settings;
    }),
    setScheduledTasks: (tasks) => set((state) => {
      state.scheduledTasks = tasks;
    }),
    setMcpServers: (servers) => set((state) => {
      state.mcpServers = servers;
    }),
    syncTelemetryData: (data: any) => set((state) => {
      if (data.tokenUsage) {
        state.tokenUsage = data.tokenUsage;
      }

      // Increment elapsedSeconds for manual workers by 2 seconds on every sync
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map(w => ({
        ...w,
        elapsedSeconds: w.elapsedSeconds + 2
      }));

      if (data.activeWorkers) {
        state.activeWorkers = [
          ...data.activeWorkers.filter((w: any) => !state.killedWorkerIds.includes(w.id)),
          ...state.manuallyTriggeredWorkers
        ];
      }
      if (data.mcpServers) {
        state.mcpServers = data.mcpServers;
      }
      if (data.cronJobs) {
        state.scheduledTasks = data.cronJobs;
      }
    }),
    addTerminalLine: (line: string, sessionId?: string) => set((state) => {
      const sid = sessionId || state.activeSessionId || '_global';
      if (!state.terminalBySession[sid]) state.terminalBySession[sid] = [];
      state.terminalBySession[sid].push(line);
      // 仅当前会话同步到兼容字段
      if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
        state.terminalLines = state.terminalBySession[sid];
      }
      // 限长，避免撑爆 localStorage 视图
      if (state.terminalBySession[sid].length > 800) {
        state.terminalBySession[sid] = state.terminalBySession[sid].slice(-600);
        if (sid === state.activeSessionId || !state.activeSessionId) {
          state.terminalLines = state.terminalBySession[sid];
        }
      }
    }),
    clearTerminalLines: (sessionId?: string) => set((state) => {
      const sid = sessionId || state.activeSessionId || '_global';
      state.terminalBySession[sid] = [];
      if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
        state.terminalLines = [];
      }
    }),
    triggerCronJobNow: (prompt: string) => set((state) => {
      const newWorker = {
        id: `worker-manual-${Date.now()}`,
        taskName: `Cron: ${prompt}`,
        elapsedSeconds: 0
      };
      state.manuallyTriggeredWorkers.push(newWorker);
      state.activeWorkers.push(newWorker);
    }),
    killWorker: (id: string, _taskName: string) => set((state) => {
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter(w => w.id !== id);
      state.activeWorkers = state.activeWorkers.filter(w => w.id !== id);
      if (!state.killedWorkerIds.includes(id)) {
        state.killedWorkerIds.push(id);
      }
      // Deduct token usage as a simulated result of termination
      state.tokenUsage.input = Math.max(0, state.tokenUsage.input - 1500);
      state.tokenUsage.cost = Math.max(0, parseFloat((state.tokenUsage.cost - 0.0045).toFixed(4)));
    }),

    // 会话 / 消息 / agent 域（实现见 sessionActions.ts）
    ...createSessionActions(set as any, get as any),

    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),
    setUiSize: (size) => set((state) => { state.uiSize = size; }),
    setSidebarCollapsed: (collapsed) => set((state) => { state.sidebarCollapsed = collapsed; }),
    setTabModeEnabled: (enabled) => set((state) => { state.tabModeEnabled = enabled; }),
    setShowSettingsOverlay: (show) => set((state) => { state.showSettingsOverlay = show; }),
    setSettingsActiveTab: (tab) => set((state) => { state.settingsActiveTab = tab; }),
    openSettings: (tab) => set((state) => {
      if (tab) state.settingsActiveTab = tab;
      state.showSettingsOverlay = true;
    }),

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
  }))
);

if (typeof window !== 'undefined') {
  (window as any).useLayoutStore = useLayoutStore;

  // Product: debounce-persist session index + JSONL bodies (demo keeps ephemeral mock)
  if (!isDemoMode()) {
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let diskTimer: ReturnType<typeof setTimeout> | null = null;
    useLayoutStore.subscribe((state) => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        try {
          persistAllSessions(state.sessions, state.activeSessionId, state.folderOrder);
        } catch (e) {
          console.warn('[sessionPersistence] save failed', e);
        }
      }, 350);
      // H3：磁盘镜像更低频，避免每键写文件
      if (diskTimer) clearTimeout(diskTimer);
      diskTimer = setTimeout(() => {
        void import('../api/sessionDiskMirror').then(({ mirrorSessionsToDisk }) => {
          void mirrorSessionsToDisk(
            useLayoutStore.getState().sessions,
            useLayoutStore.getState().activeSessionId,
            useLayoutStore.getState().folderOrder,
          );
        });
      }, 2500);
    });
  }
}
