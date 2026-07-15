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
  SessionState,
  DropPreviewState,
  FileDiff,
  WorkspaceState,
} from './types';
import {
  createDefaultWorkspace,
  seedSessions,
} from './layoutHelpers';
import { createSessionActions, type SessionActions } from './sessionActions';
import {
  createWorkspaceActions,
  type WorkspaceActions,
  type DraggedTabState,
} from './workspaceActions';

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

/** 工作区 + UI + 遥测 + 会话域 + 工作区域（actions 见 SessionActions / WorkspaceActions） */
interface LayoutStore extends SessionActions, WorkspaceActions {
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
  setUiSize: (size: 'small' | 'medium' | 'large') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: string) => void;
  openSettings: (tab?: string) => void;

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

    // 工作区 / 标签 DnD / 面板域（实现见 workspaceActions.ts）
    ...createWorkspaceActions(set as any, get as any),

    setUiSize: (size) => set((state) => { state.uiSize = size; }),
    setSidebarCollapsed: (collapsed) => set((state) => { state.sidebarCollapsed = collapsed; }),
    setTabModeEnabled: (enabled) => set((state) => { state.tabModeEnabled = enabled; }),
    setShowSettingsOverlay: (show) => set((state) => { state.showSettingsOverlay = show; }),
    setSettingsActiveTab: (tab) => set((state) => { state.settingsActiveTab = tab; }),
    openSettings: (tab) => set((state) => {
      if (tab) state.settingsActiveTab = tab;
      state.showSettingsOverlay = true;
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
