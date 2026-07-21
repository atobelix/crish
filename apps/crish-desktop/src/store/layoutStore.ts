import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import type { Settings, CronJob, McpServer, ProviderInfo } from '../api/clientApi';
import { isDemoMode } from '../api/appMode';
import { persistAllSessions } from '../api/sessionPersistence';
import {
  mirrorSessionsToDisk,
  restoreSessionsFromDiskMirror,
} from '../api/sessionDiskMirror';
import {
  pickSessionDomain,
  sessionDomainChanged,
  type SessionDomainSlice,
} from '../api/sessionPersistGate';
import {
  loadStoredPermissionMode,
  permissionModeAfterPlanToggle,
  persistPermissionMode,
  planModeEnabledFor,
  type PermissionMode,
} from '../api/permissionModes';
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
  CardState,
  ColumnState,
  CardGroupState,
  SettingsTabType,
} from './types';
import { MAX_TERMINAL_SESSIONS, MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import {
  appendTerminalLine,
  collapseToolColumnToTabs,
  createDefaultWorkspace,
  resolveWorkspacePanelKey,
  seedSessions,
  upsertDiffFile,
} from './layoutHelpers';
import {
  DEFAULT_SHELL_CHROME,
  parseShellChromeMode,
  SHELL_CHROME_STORAGE_KEY,
  type ShellChromeMode,
} from '../api/shellChrome';
import { createSessionActions, type SessionActions } from './sessionActions';
import {
  createWorkspaceActions,
  type WorkspaceActions,
  type DraggedTabState,
} from './workspaceActions';
import { buildSessionsById } from './sessionIndex';

// ── Type fidelity: named state shapes (no inline litter / drift) ─────────────

/** UI 密度三档 — 与 tokens `[data-ui-size]` / 设置外观一致 */
export type UiSize = 'small' | 'medium' | 'large';

export const UI_SIZE_IDS = ['small', 'medium', 'large'] as const satisfies readonly UiSize[];

export const DEFAULT_UI_SIZE: UiSize = 'medium';

export type {
  ShellChromeMode,
} from '../api/shellChrome';
export {
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
} from '../api/shellChrome';

/** 设置侧栏合法 tab（与 SettingsTabType 同步；openSettings 白名单） */
export const SETTINGS_TAB_IDS = [
  'profile',
  'appearance',
  'personalize',
  'models',
  'usage',
  'schedule',
  'rules',
  'shortcuts',
  'skills',
  'mcp',
  'plugins',
  'security',
] as const satisfies readonly SettingsTabType[];

export const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';

const SETTINGS_TAB_SET: ReadonlySet<string> = new Set(SETTINGS_TAB_IDS);

/** 遥测 / 用量条 token 计数 */
export type TokenUsageState = {
  input: number;
  inputMax: number;
  output: number;
  outputMax: number;
  cost: number;
};

/** 产品态安全默认（全 0；上限与历史 demo 一致） */
export const DEFAULT_TOKEN_USAGE: TokenUsageState = {
  input: 0,
  inputMax: 160000,
  output: 0,
  outputMax: 40000,
  cost: 0,
};

/** demo 展示用假数据（仅 isDemoMode） */
export const DEMO_TOKEN_USAGE: TokenUsageState = {
  input: 115482,
  inputMax: 160000,
  output: 24930,
  outputMax: 40000,
  cost: 0.345,
};

/** 后台 worker / cron 触发条目 */
export type ActiveWorkerState = {
  id: string;
  taskName: string;
  elapsedSeconds: number;
};

/** 首个工作区稳定 id（empty seed / close 重种共用） */
export const DEFAULT_WORKSPACE_ID = 'ws-0';

/** localStorage keys（集中，避免字面量漂移） */
export const UI_SIZE_STORAGE_KEY = 'crish_ui_size';
export const TAB_MODE_STORAGE_KEY = 'crish_tab_mode';

/** syncTelemetryData 入参（去掉 data: any） */
export type TelemetrySyncPayload = {
  tokenUsage?: Partial<TokenUsageState> | TokenUsageState;
  activeWorkers?: ActiveWorkerState[];
  mcpServers?: McpServer[];
  cronJobs?: CronJob[];
};

// 保持旧 import 路径可用：`from '../store/layoutStore'`
// 会话域请优先 `from '../store/sessionStore'`（useSessionStore 为同 store 门面，见 sessionStore.ts）
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
  SessionGoalMode,
  SessionGoalTask,
  SessionState,
  DropPreviewState,
  SettingsTabType,
} from './types';

// ── Safe defaults / parsers ─────────────────────────────────────────────────

/** 有限数字；NaN/Infinity/非数字 → fallback */
export function finiteNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** 未知值 → 合法 UiSize；损坏存储 / 越界一律 medium */
export function parseUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
  return DEFAULT_UI_SIZE;
}

function readStoredShellChromeMode(): ShellChromeMode {
  try {
    return parseShellChromeMode(localStorage.getItem(SHELL_CHROME_STORAGE_KEY));
  } catch {
    return DEFAULT_SHELL_CHROME;
  }
}

export function isSettingsTabType(v: unknown): v is SettingsTabType {
  return typeof v === 'string' && SETTINGS_TAB_SET.has(v);
}

/** 未知 tab → fallback（默认 profile）；不静默落到非法 id */
export function parseSettingsTab(
  raw: unknown,
  fallback: SettingsTabType = DEFAULT_SETTINGS_TAB,
): SettingsTabType {
  return isSettingsTabType(raw) ? raw : fallback;
}

/** 清洗 token 用量：非负、有限；缺失字段回落 base */
export function sanitizeTokenUsage(
  raw: Partial<TokenUsageState> | TokenUsageState | null | undefined,
  base: TokenUsageState = DEFAULT_TOKEN_USAGE,
): TokenUsageState {
  if (!raw || typeof raw !== 'object') {
    return {
      input: base.input,
      inputMax: base.inputMax,
      output: base.output,
      outputMax: base.outputMax,
      cost: base.cost,
    };
  }
  return {
    input: Math.max(0, finiteNumber(raw.input, base.input)),
    inputMax: Math.max(1, finiteNumber(raw.inputMax, base.inputMax)),
    output: Math.max(0, finiteNumber(raw.output, base.output)),
    outputMax: Math.max(1, finiteNumber(raw.outputMax, base.outputMax)),
    cost: Math.max(0, finiteNumber(raw.cost, base.cost)),
  };
}

function isWorkerLike(
  w: unknown,
): w is { id: string; taskName?: unknown; elapsedSeconds?: unknown } {
  if (w == null || typeof w !== 'object') return false;
  if (!('id' in w)) return false;
  const id = (w as { id: unknown }).id;
  return typeof id === 'string' && id.length > 0;
}

/** 过滤无 id worker；elapsed 非负有限 */
export function sanitizeActiveWorkers(list: unknown): ActiveWorkerState[] {
  if (!Array.isArray(list)) return [];
  const out: ActiveWorkerState[] = [];
  for (const w of list) {
    if (!isWorkerLike(w)) continue;
    out.push({
      id: w.id,
      taskName: typeof w.taskName === 'string' ? w.taskName : '',
      elapsedSeconds: Math.max(0, finiteNumber(w.elapsedSeconds, 0)),
    });
  }
  return out;
}

function readStoredUiSize(): UiSize {
  try {
    return parseUiSize(localStorage.getItem(UI_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_SIZE;
  }
}

/**
 * 合并标签默认开：
 * - 无键 / 非法 → true（产品默认右侧工具并入同列标签）
 * - 仅显式 '0' / 'false' → false
 */
function readStoredTabModeEnabled(): boolean {
  try {
    const raw = localStorage.getItem(TAB_MODE_STORAGE_KEY);
    if (raw == null || raw === '') return true;
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
    return true;
  } catch {
    return true;
  }
}

// ── Empty workspace seed + no ghost panels ──────────────────────────────────

/**
 * 去掉浮层/别名幽灵卡（settings、runtime 不进列；browser→preview；plan→tasks）。
 * 空 group / 空工具列剪掉；始终保证至少一列 chat，否则回落 createDefaultWorkspace。
 */
export function stripGhostPanelsFromWorkspace(ws: WorkspaceState): WorkspaceState {
  const nextColumns: ColumnState[] = [];

  for (const col of ws.columns) {
    const nextGroups: CardGroupState[] = [];
    for (const g of col.groups) {
      const seen = new Set<string>();
      const cards: CardState[] = [];
      for (const c of g.cards) {
        const key = resolveWorkspacePanelKey(c.id);
        if (!key) continue; // settings / runtime / 空串 → ghost，丢弃
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(key === c.id ? c : { id: key, title: c.title });
      }
      if (cards.length === 0) continue;
      let active = resolveWorkspacePanelKey(g.activeCardId) ?? cards[0]!.id;
      if (!cards.some((c) => c.id === active)) {
        active = cards[0]!.id;
      }
      nextGroups.push({
        id: g.id,
        activeCardId: active,
        cards,
        heightRatio: g.heightRatio > 0 ? g.heightRatio : 1,
      });
    }

    const isChat = col.id.includes('chat');
    if (nextGroups.length === 0 && !isChat) continue;
    // chat 列若被掏空则补回对话卡（防 ghost 空 chat 壳）
    if (nextGroups.length === 0 && isChat) {
      nextGroups.push({
        id: `group-chat-${ws.id}`,
        activeCardId: 'chat',
        cards: [{ id: 'chat', title: '对话' }],
        heightRatio: 1,
      });
    }
    nextColumns.push({
      id: col.id,
      widthRatio: col.widthRatio > 0 ? col.widthRatio : 1,
      groups: nextGroups,
    });
  }

  if (nextColumns.length === 0) {
    return createDefaultWorkspace(ws.id || DEFAULT_WORKSPACE_ID);
  }
  // 保证至少一列含 chat 卡
  const hasChatCard = nextColumns.some((col) =>
    col.groups.some((g) => g.cards.some((c) => c.id === 'chat')),
  );
  if (!hasChatCard) {
    return createDefaultWorkspace(ws.id || DEFAULT_WORKSPACE_ID);
  }
  return { id: ws.id || DEFAULT_WORKSPACE_ID, columns: nextColumns };
}

/** 非空工作区种子：默认 id + 去 ghost 面板 */
export function seedInitialWorkspaces(
  id: string = DEFAULT_WORKSPACE_ID,
): WorkspaceState[] {
  return [stripGhostPanelsFromWorkspace(createDefaultWorkspace(id))];
}

/** 空数组 / null → 重种；否则逐区 strip ghost 后若仍空则重种 */
export function ensureNonEmptyWorkspaces(
  workspaces: WorkspaceState[] | null | undefined,
  id: string = DEFAULT_WORKSPACE_ID,
): WorkspaceState[] {
  if (!workspaces || workspaces.length === 0) {
    return seedInitialWorkspaces(id);
  }
  const cleaned = workspaces.map((ws) => stripGhostPanelsFromWorkspace(ws));
  return cleaned.length > 0 ? cleaned : seedInitialWorkspaces(id);
}

/** activeWorkspaceIndex 夹到 [0, len-1]；空切片视为 0 */
export function clampActiveWorkspaceIndex(
  workspaces: readonly WorkspaceState[],
  index: number,
): number {
  if (workspaces.length === 0) return 0;
  const i = finiteNumber(index, 0);
  return Math.min(Math.max(0, Math.trunc(i)), workspaces.length - 1);
}

/**
 * 会话种子后处理：sessionsById 对齐、active 仅在存在时保留、
 * 空列表无 ghost active；folderOrder 去空串。
 */
export function sanitizeSessionSeed(seed: {
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
}): {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  activeSessionId: string;
  folderOrder: string[];
} {
  const sessions = Array.isArray(seed.sessions) ? seed.sessions : [];
  const sessionsById = buildSessionsById(sessions);
  let activeSessionId =
    typeof seed.activeSessionId === 'string' ? seed.activeSessionId : '';
  if (!activeSessionId || !sessionsById[activeSessionId]) {
    activeSessionId = '';
  }
  if (sessions.length === 0) {
    activeSessionId = '';
  }
  const folderOrder = Array.isArray(seed.folderOrder)
    ? seed.folderOrder.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  return { sessions, sessionsById, activeSessionId, folderOrder };
}

// ── LayoutStore interface ───────────────────────────────────────────────────

/** 工作区 + UI + 遥测 + 会话域 + 工作区域（actions 见 SessionActions / WorkspaceActions） */
export interface LayoutStore extends SessionActions, WorkspaceActions {
  setPermissionMode: (mode: PermissionMode) => void;
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: UiSize;
  /** 壳层形态：classic 扁平 / inset 嵌套圆角内容卡 */
  shellChromeMode: ShellChromeMode;
  /**
   * 主对话列表面：chat | scheduled。
   * scheduled 时隐藏会话面包屑，避免「对话标题 + 定时任务」叠两套壳。
   */
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  sessions: SessionState[];
  /** 会话 id → 引用，热路径 O(1)；与 sessions 同步 */
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  /** 当前聚焦的子 agent（null = 看主对话） */
  activeAgentId: string | null;
  /** 右侧「协作 agent」面板要展示的 agent id */
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  permissionMode: PermissionMode;

  // UI Settings
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;

  // Diff
  activeDiffSource: FileDiff | null;
  /** 本轮工具产生的多文件 diff（H2）；H3 可接 git-diff */
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) => void;
  pushDiffFile: (diff: FileDiff) => void;
  /** 从变更列表移除（拒绝 / 已应用后清理） */
  removeDiffFile: (filePath: string) => void;

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
  activeWorkers: ActiveWorkerState[];
  tokenUsage: TokenUsageState;
  killedWorkerIds: string[];
  providers: ProviderInfo[];
  /** true 当会话磁盘镜像恢复完成（无论是否找到数据） */
  hydrationComplete: boolean;
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;

  /** 兼容：当前活动会话的终端行 */
  terminalLines: string[];
  /** 按会话隔离的终端缓冲（H2） */
  terminalBySession: Record<string, string[]>;
  addTerminalLine: (line: string, sessionId?: string) => void;
  clearTerminalLines: (sessionId?: string) => void;
  manuallyTriggeredWorkers: ActiveWorkerState[];
  triggerCronJobNow: (prompt: string) => void;
  killWorker: (id: string, taskName: string) => void;
}

// ── Initial state (safe defaults + seed) ────────────────────────────────────

const _sessionSeed = sanitizeSessionSeed(seedSessions());
/** 权限模式只读一次：permissionMode 与 planModeEnabled 同源，避免双次 localStorage 分叉 */
const _initialPermissionMode = loadStoredPermissionMode();
const _initialWorkspaces = seedInitialWorkspaces(DEFAULT_WORKSPACE_ID);
const _initialUiSize = readStoredUiSize();
const _initialTabMode = readStoredTabModeEnabled();
const _initialShellChrome = readStoredShellChromeMode();
const _initialTokenUsage = isDemoMode()
  ? { ...DEMO_TOKEN_USAGE }
  : { ...DEFAULT_TOKEN_USAGE };
const _initialTerminalLines: string[] = isDemoMode()
  ? [
      'user@Windows-PC MINGW64 /c/workspace/crish',
      '$ npm run dev',
      '> zennav-server@1.0.0 dev',
      '> node server.js',
      '',
      '[ready] Server started on http://localhost:3000',
      '[ready] Database connection established.',
    ]
  : [];

export const useLayoutStore = create<LayoutStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer((set, get) => ({
    workspaces: _initialWorkspaces,
    activeWorkspaceIndex: clampActiveWorkspaceIndex(_initialWorkspaces, 0),
    tabModeEnabled: _initialTabMode,
    uiSize: _initialUiSize,
    shellChromeMode: _initialShellChrome,
    chatMainSurface: 'chat',
    sidebarCollapsed: false,
    hydrationComplete: false,
    sessions: _sessionSeed.sessions,
    sessionsById: _sessionSeed.sessionsById,
    folderOrder: _sessionSeed.folderOrder,
    activeSessionId: _sessionSeed.activeSessionId,
    // 无活动会话时绝不挂 ghost agent 焦点
    activeAgentId: null,
    panelAgentId: null,
    draggedTab: null,
    dropPreview: null,

    showSettingsOverlay: false,
    settingsActiveTab: DEFAULT_SETTINGS_TAB,
    // 与设置页 / Composer 共用；hydrate 时 planModeEnabled 必须与之一致
    permissionMode: _initialPermissionMode,

    activeDiffSource: null,
    diffFiles: [],
    setActiveDiffSource: (diff) => set((state) => {
      state.activeDiffSource = diff;
      if (diff) {
        // 同步进列表（去重 path）
        upsertDiffFile(state.diffFiles, diff);
      }
    }),
    setDiffFiles: (files) => set((state) => {
      const next = typeof files === 'function'
        ? (files as (prev: FileDiff[]) => FileDiff[])(state.diffFiles)
        : files;
      state.diffFiles = Array.isArray(next) ? next : [];
      state.activeDiffSource = state.diffFiles[0] || null;
    }),
    pushDiffFile: (diff) => set((state) => {
      upsertDiffFile(state.diffFiles, diff);
      state.activeDiffSource = diff;
    }),
    removeDiffFile: (filePath) => set((state) => {
      const path = filePath || '';
      state.diffFiles = state.diffFiles.filter((f) => f.filePath !== path);
      if (state.activeDiffSource?.filePath === path) {
        state.activeDiffSource = state.diffFiles[0] || null;
      }
    }),
    // 刷新后若 permissionMode=plan，ribbon 与引擎需同步点亮（与 permissionMode 同源）
    planModeEnabled: planModeEnabledFor(_initialPermissionMode),
    setPermissionMode: (mode) => {
      set((state) => {
        state.permissionMode = mode;
        state.planModeEnabled = planModeEnabledFor(mode);
        state.planApproved = false;
      });
      persistPermissionMode(mode);
    },
    setPlanModeEnabled: (enabled) => {
      let nextMode: PermissionMode = 'ask';
      set((state) => {
        // 双向对齐：侧栏/ribbon 开关不得与 permissionMode 分叉
        nextMode = permissionModeAfterPlanToggle(state.permissionMode, enabled);
        state.permissionMode = nextMode;
        state.planModeEnabled = planModeEnabledFor(nextMode);
        // 与 setPermissionMode 一致：切换时重置「批准执行」
        state.planApproved = false;
      });
      // 与 setPermissionMode 同一持久化入口，保证设置页 ↔ daemon 读同一 key
      persistPermissionMode(nextMode);
    },
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
        const next = Array.isArray(list)
          ? list.filter((c) => typeof c === 'string')
          : [];
        state.commandPermissions = next;
        saveCommandPermissions(next);
      }),
    appSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    activeWorkers: [],
    tokenUsage: _initialTokenUsage,
    killedWorkerIds: [],

    terminalLines: _initialTerminalLines,
    terminalBySession: {},
    composerDrafts: {},
    manuallyTriggeredWorkers: [],

    setProviders: (providers) => set((state) => {
      state.providers = Array.isArray(providers) ? providers : [];
    }),
    setAppSettings: (settings) => set((state) => {
      state.appSettings = settings;
    }),
    setScheduledTasks: (tasks) => set((state) => {
      state.scheduledTasks = Array.isArray(tasks) ? tasks : [];
    }),
    setMcpServers: (servers) => set((state) => {
      state.mcpServers = Array.isArray(servers) ? servers : [];
    }),
    syncTelemetryData: (data: TelemetrySyncPayload) => set((state) => {
      if (data.tokenUsage) {
        state.tokenUsage = sanitizeTokenUsage(data.tokenUsage, state.tokenUsage);
      }

      // Increment elapsedSeconds for manual workers by 2 seconds on every sync
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map((w) => ({
        id: w.id,
        taskName: w.taskName,
        elapsedSeconds: Math.max(0, finiteNumber(w.elapsedSeconds, 0) + 2),
      }));

      if (data.activeWorkers) {
        const live = sanitizeActiveWorkers(data.activeWorkers).filter(
          (w) => !state.killedWorkerIds.includes(w.id),
        );
        state.activeWorkers = [...live, ...state.manuallyTriggeredWorkers];
      }
      if (data.mcpServers) {
        state.mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : state.mcpServers;
      }
      if (data.cronJobs) {
        state.scheduledTasks = Array.isArray(data.cronJobs) ? data.cronJobs : state.scheduledTasks;
      }
    }),
    addTerminalLine: (line: string, sessionId?: string) => set((state) => {
      const text = typeof line === 'string' ? line : String(line ?? '');
      const sid = sessionId || state.activeSessionId || '_global';
      if (!state.terminalBySession[sid]) state.terminalBySession[sid] = [];
      appendTerminalLine(state.terminalBySession[sid], text);
      // 仅当前会话同步到兼容字段
      if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
        state.terminalLines = state.terminalBySession[sid];
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
      const label = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'task';
      const newWorker: ActiveWorkerState = {
        id: `worker-manual-${Date.now()}`,
        taskName: `Cron: ${label}`,
        elapsedSeconds: 0,
      };
      if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS) state.manuallyTriggeredWorkers.push(newWorker);
      if (state.activeWorkers.length < MAX_DIFF_FILES * 2) state.activeWorkers.push(newWorker);
    }),
    killWorker: (id: string, _taskName: string) => set((state) => {
      if (!id) return;
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter((w) => w.id !== id);
      state.activeWorkers = state.activeWorkers.filter((w) => w.id !== id);
      if (!state.killedWorkerIds.includes(id) && state.killedWorkerIds.length < MAX_TERMINAL_SESSIONS * 4) {
        state.killedWorkerIds.push(id);
      }
      // Deduct token usage as a simulated result of termination
      state.tokenUsage.input = Math.max(0, finiteNumber(state.tokenUsage.input, 0) - 1500);
      const nextCost = finiteNumber(state.tokenUsage.cost, 0) - 0.0045;
      state.tokenUsage.cost = Math.max(0, parseFloat(nextCost.toFixed(4)));
    }),

    // 会话 / 消息 / agent 域（实现见 sessionActions.ts）—— 泛型切片，无 as any
    ...createSessionActions(set, get),

    // 工作区 / 标签 DnD / 面板域（实现见 workspaceActions.ts）
    ...createWorkspaceActions(set, get),

    setUiSize: (size) => {
      const next = parseUiSize(size);
      set((state) => {
        state.uiSize = next;
      });
      try {
        localStorage.setItem(UI_SIZE_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setShellChromeMode: (mode) => {
      const next = parseShellChromeMode(mode);
      set((state) => {
        state.shellChromeMode = next;
      });
      try {
        localStorage.setItem(SHELL_CHROME_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setChatMainSurface: (surface) =>
      set((state) => {
        state.chatMainSurface = surface === 'scheduled' ? 'scheduled' : 'chat';
      }),
    setSidebarCollapsed: (collapsed) => set((state) => {
      state.sidebarCollapsed = !!collapsed;
    }),
    setTabModeEnabled: (enabled) => {
      const on = !!enabled;
      set((state) => {
        state.tabModeEnabled = on;
        // 打开合并标签时：把已有右侧堆叠 group 折成同一标签栏（功能做实）
        if (on) {
          for (const ws of state.workspaces) {
            collapseToolColumnToTabs(ws);
          }
        }
      });
      try {
        localStorage.setItem(TAB_MODE_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
    setShowSettingsOverlay: (show) => set((state) => {
      state.showSettingsOverlay = !!show;
    }),
    setSettingsActiveTab: (tab) => set((state) => {
      // 非法 tab 不写入，避免设置页空白 ghost
      if (isSettingsTabType(tab)) {
        state.settingsActiveTab = tab;
      }
    }),
    openSettings: (tab) => set((state) => {
      if (tab !== undefined) {
        state.settingsActiveTab = parseSettingsTab(tab, state.settingsActiveTab);
      }
      state.showSettingsOverlay = true;
    }),
      })),
        {
          name: 'crish-layout-v1',
          partialize: (s) => ({
            workspaces: s.workspaces,
            sidebarCollapsed: s.sidebarCollapsed,
            activeWorkspaceIndex: s.activeWorkspaceIndex,
            tabModeEnabled: s.tabModeEnabled,
          }),
        },
      ),
    ),
    'LayoutStore',
  ),
);

// ── Layout state shape (state-only, excludes actions) ─────────────────────────

export type LayoutStoreState = Pick<LayoutStore,
  | 'workspaces' | 'activeWorkspaceIndex' | 'tabModeEnabled' | 'uiSize'
  | 'shellChromeMode' | 'chatMainSurface' | 'sidebarCollapsed'
  | 'sessions' | 'sessionsById' | 'folderOrder' | 'activeSessionId'
  | 'activeAgentId' | 'panelAgentId' | 'composerDrafts'
  | 'draggedTab' | 'dropPreview'
  | 'showSettingsOverlay' | 'settingsActiveTab' | 'permissionMode'
  | 'activeDiffSource' | 'diffFiles'
  | 'planModeEnabled' | 'planApproved' | 'commandPermissions'
  | 'appSettings' | 'providers' | 'scheduledTasks' | 'mcpServers'
  | 'activeWorkers' | 'tokenUsage' | 'killedWorkerIds'
  | 'terminalLines' | 'terminalBySession' | 'manuallyTriggeredWorkers'
  | 'hydrationComplete'
>;

// ── Workspace layout snapshot (serialization) ────────────────────────────────

export interface WorkspaceLayoutSnapshot {
  version: number;
  workspaces: Array<{
    id: string;
    columns: ColumnState[];
  }>;
  sidebarCollapsed: boolean;
  activeWorkspaceIndex: number;
}

export function serializeWorkspaceLayout(state: LayoutStoreState): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    workspaces: state.workspaces.map(ws => ({
      id: ws.id,
      columns: ws.columns,
    })),
    sidebarCollapsed: state.sidebarCollapsed,
    activeWorkspaceIndex: state.activeWorkspaceIndex,
  };
}

export function deserializeWorkspaceLayout(snapshot: WorkspaceLayoutSnapshot, state: LayoutStoreState): void {
  const index = clampActiveWorkspaceIndex(snapshot.workspaces, snapshot.activeWorkspaceIndex);
  state.workspaces = snapshot.workspaces.map((ws, i) => ({
    id: ws.id,
    columns: ws.columns,
  }));
  state.activeWorkspaceIndex = index;
  state.sidebarCollapsed = snapshot.sidebarCollapsed;
}

/** 等待 store 会话回灌完成 */
export function waitForHydration(): Promise<void> {
  return new Promise((resolve) => {
    if (useLayoutStore.getState().hydrationComplete) {
      resolve();
      return;
    }
    const unsub = useLayoutStore.subscribe((state) => {
      if (state.hydrationComplete) {
        unsub();
        resolve();
      }
    });
  });
}

/**
 * 挂载会话持久化订阅（session index + 磁盘镜像）与空会话磁盘回灌。
 * demo 模式不持久化，直接返回 no-op cleanup。
 * 由 App 在 mount 时调用一次，unmount 时执行返回的 cleanup。
 * （window.useLayoutStore 由 App.tsx 以 CrishWindow 类型挂载，此处不再重复 attach）
 */
export function initLayoutStorePersistence(): () => void {
  // Product: debounce-persist session index + JSONL bodies（demo 保持内存假数据，不写盘）
  if (isDemoMode()) {
    return () => undefined;
  }

  const abortController = new AbortController();

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let diskTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一份会话域切片：遥测等字段变更时引用不变 → 跳过落盘 */
  let lastDomain: SessionDomainSlice | null = pickSessionDomain(useLayoutStore.getState());

  const unsub = useLayoutStore.subscribe((state) => {
    const domain = pickSessionDomain(state);
    // 仅 sessions / activeSessionId / folderOrder 变化时调度写入
    if (!sessionDomainChanged(lastDomain, domain)) {
      return;
    }
    lastDomain = domain;

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const cur = useLayoutStore.getState();
        persistAllSessions(cur.sessions, cur.activeSessionId, cur.folderOrder);
      } catch (e) {
        console.warn('[sessionPersistence] save failed', e);
      }
    }, 350);
    // H3：磁盘镜像更低频，避免每键写文件
    if (diskTimer) clearTimeout(diskTimer);
    diskTimer = setTimeout(() => {
      const cur = useLayoutStore.getState();
      void mirrorSessionsToDisk(cur.sessions, cur.activeSessionId, cur.folderOrder);
    }, 2500);
  });

  // localStorage 空时尝试从磁盘镜像回灌（compare-and-swap：写入前再次确认仍为空）
  if (useLayoutStore.getState().sessions.length === 0) {
    void restoreSessionsFromDiskMirror().then((restored) => {
      if (abortController.signal.aborted) return;

      if (restored?.sessions?.length) {
        const cur = useLayoutStore.getState();
        // 用户已新建会话则不覆盖
        if (cur.sessions.length > 0) return;

        let applied = false;
        useLayoutStore.setState((state) => {
          // 二次检查：recipe 内仍空才写入
          if (state.sessions.length > 0) return;

          const sanitized = sanitizeSessionSeed({
            sessions: restored.sessions,
            activeSessionId: restored.activeSessionId,
            folderOrder: restored.folderOrder,
          });
          state.sessions = sanitized.sessions;
          state.sessionsById = sanitized.sessionsById;
          state.activeSessionId = sanitized.activeSessionId;
          state.folderOrder = sanitized.folderOrder.length
            ? sanitized.folderOrder
            : state.folderOrder;
          // 回灌后清 ghost agent 焦点（会话集合已变）
          state.activeAgentId = null;
          state.panelAgentId = null;
          // empty workspace seed：若被外部掏空则重种
          state.workspaces = ensureNonEmptyWorkspaces(state.workspaces);
          state.activeWorkspaceIndex = clampActiveWorkspaceIndex(
            state.workspaces,
            state.activeWorkspaceIndex,
          );
          applied = true;
        });

        // 仅在真正写入后落盘；避免旧逻辑用 activeSessionId 巧合匹配误 persist
        if (!applied) return;
        try {
          const after = useLayoutStore.getState();
          persistAllSessions(
            after.sessions,
            after.activeSessionId,
            after.folderOrder,
          );
        } catch {
          /* ignore */
        }
      }
    }).finally(() => {
      if (!abortController.signal.aborted) {
        useLayoutStore.setState((state) => {
          state.hydrationComplete = true;
        });
      }
    });
  } else {
    useLayoutStore.setState((state) => {
      state.hydrationComplete = true;
    });
  }

  return () => {
    abortController.abort();
    if (persistTimer) clearTimeout(persistTimer);
    if (diskTimer) clearTimeout(diskTimer);
    unsub();
  };
}
