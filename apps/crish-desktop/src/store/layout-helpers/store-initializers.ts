import type {
  CardGroupState,
  CardState,
  ColumnState,
  SessionState,
  SettingsTabType,
  WorkspaceState,
} from '../types';
import { isDemoMode } from '../../api/appMode';
import {
  DEFAULT_SHELL_CHROME,
  type ShellChromeMode,
} from '../../api/shellChrome';
import { loadStoredPermissionMode } from '../../api/permissionModes';
import {
  createDefaultWorkspace,
  resolveWorkspacePanelKey,
} from './ui-selectors';
import { seedSessions } from './session-selectors';
import { buildSessionsById } from '../sessionIndex';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from '../draftSession';
import {
  DEFAULT_SETTINGS_TAB,
  DEFAULT_TOKEN_USAGE,
  DEFAULT_UI_SIZE,
  DEFAULT_WORKSPACE_ID,
  DEMO_TOKEN_USAGE,
  SETTINGS_TAB_SET,
  type ActiveWorkerState,
  type TokenUsageState,
  type UiSize,
} from './store-types';

/** 有限数字；NaN/Infinity/非数字 → fallback */
export function finiteNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * T-47：4D 可选字段宽容清洗——非负有限才透出，非法值回落 fallback；
 * fallback 为 undefined 时非法值 → undefined（键省略，UI 隐藏而非显示 0）。
 */
function optionalNonNegative(
  raw: unknown,
  fallback: number | undefined
): number | undefined {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

/** 未知值 → 合法 UiSize；损坏存储 / 越界一律 medium */
export function parseUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
  return DEFAULT_UI_SIZE;
}

export function isSettingsTabType(v: unknown): v is SettingsTabType {
  return typeof v === 'string' && SETTINGS_TAB_SET.has(v);
}

/** 未知 tab → fallback（默认 profile）；不静默落到非法 id */
export function parseSettingsTab(
  raw: unknown,
  fallback: SettingsTabType = DEFAULT_SETTINGS_TAB
): SettingsTabType {
  return isSettingsTabType(raw) ? raw : fallback;
}

/**
 * 清洗 token 用量：非负、有限；缺失字段回落 base。
 * T-47：4D 可选字段（cacheRead/cacheWrite/savedCost）宽容处理——
 * 双端均缺失则键省略（undefined），任意一端提供则取合法非负值。
 */
export function sanitizeTokenUsage(
  raw: Partial<TokenUsageState> | TokenUsageState | null | undefined,
  base: TokenUsageState = DEFAULT_TOKEN_USAGE
): TokenUsageState {
  if (!raw || typeof raw !== 'object') {
    return {
      input: base.input,
      inputMax: base.inputMax,
      output: base.output,
      outputMax: base.outputMax,
      costStatus: base.costStatus,
      cost: base.cost,
    };
  }
  const cacheRead = optionalNonNegative(raw.cacheRead, base.cacheRead);
  const cacheWrite = optionalNonNegative(raw.cacheWrite, base.cacheWrite);
  const savedCost = optionalNonNegative(raw.savedCost, base.savedCost);
  const costStatus =
    raw.costStatus === 'priced' ||
    raw.costStatus === 'free' ||
    raw.costStatus === 'unpriced'
      ? raw.costStatus
      : base.costStatus;
  return {
    input: Math.max(0, finiteNumber(raw.input, base.input)),
    inputMax: Math.max(1, finiteNumber(raw.inputMax, base.inputMax)),
    output: Math.max(0, finiteNumber(raw.output, base.output)),
    outputMax: Math.max(1, finiteNumber(raw.outputMax, base.outputMax)),
    costStatus,
    cost: Math.max(0, finiteNumber(raw.cost, base.cost)),
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
    ...(savedCost !== undefined && { savedCost }),
    ...(raw.currency ? { currency: raw.currency } : {}),
    ...(raw.costMicros !== undefined ? { costMicros: raw.costMicros } : {}),
    ...(raw.formattedCost ? { formattedCost: raw.formattedCost } : {}),
  };
}

function isWorkerLike(
  w: unknown
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

/**
 * 去掉浮层/别名幽灵卡（settings、runtime 不进列；browser→preview；plan→tasks）。
 * 空 group / 空工具列剪掉；始终保证至少一列 chat，否则回落 createDefaultWorkspace。
 */
export function stripGhostPanelsFromWorkspace(
  ws: WorkspaceState
): WorkspaceState {
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
    col.groups.some((g) => g.cards.some((c) => c.id === 'chat'))
  );
  if (!hasChatCard) {
    return createDefaultWorkspace(ws.id || DEFAULT_WORKSPACE_ID);
  }
  return { id: ws.id || DEFAULT_WORKSPACE_ID, columns: nextColumns };
}

/** 非空工作区种子：默认 id + 去 ghost 面板 */
export function seedInitialWorkspaces(
  id: string = DEFAULT_WORKSPACE_ID
): WorkspaceState[] {
  return [stripGhostPanelsFromWorkspace(createDefaultWorkspace(id))];
}

/** 空数组 / null → 重种；否则逐区 strip ghost 后若仍空则重种 */
export function ensureNonEmptyWorkspaces(
  workspaces: WorkspaceState[] | null | undefined,
  id: string = DEFAULT_WORKSPACE_ID
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
  index: number
): number {
  if (workspaces.length === 0) return 0;
  const i = finiteNumber(index, 0);
  return Math.min(Math.max(0, Math.trunc(i)), workspaces.length - 1);
}

/**
 * 会话种子后处理：sessionsById 对齐、active 仅在存在时保留、
 * folderOrder 去空串。
 *
 * 不变量（系统级）：activeSessionId 在稳态下绝不允许为空字符串。
 * 必须始终是有效会话 ID 或 PENDING_DRAFT_SESSION_ID（草稿态）。
 * - 若 active 无效但 sessions 非空：取首个 session 作后备
 * - 若 sessions 为空或 active 仍无效：进入草稿态
 * - 草稿哨兵不落盘：持久化层在写入时应剥离，但读取时若遇到则归一为草稿态
 *
 * 这样确保应用启动 / 持久化恢复 / 会话删除后绝不会触发"暂无会话"空屏。
 */
export function sanitizeSessionSeed(seed: {
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
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
  // 草稿哨兵：保持草稿态（不归一为空，避免触发 no-session 空屏）
  if (isPendingDraft(activeSessionId)) {
    activeSessionId = PENDING_DRAFT_SESSION_ID;
  }
  // active 指向不存在的会话：优先取首个 session 作后备，否则进入草稿态
  if (!activeSessionId || !sessionsById[activeSessionId]) {
    activeSessionId =
      sessions.length > 0
        ? (sessions[0]?.id ?? PENDING_DRAFT_SESSION_ID)
        : PENDING_DRAFT_SESSION_ID;
  }
  // sessions 为空时强制草稿态（覆盖 active 指向首个 session 但 sessions 已清空的边界）
  if (sessions.length === 0) {
    activeSessionId = PENDING_DRAFT_SESSION_ID;
  }
  const folderOrder = Array.isArray(seed.folderOrder)
    ? seed.folderOrder.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  return { sessions, sessionsById, activeSessionId, folderOrder };
}

/** 工厂：生成 store 初始状态中可计算的默认字段 */
export function createInitialLayoutDefaults() {
  const sessionSeed = sanitizeSessionSeed(seedSessions());
  const initialPermissionMode = loadStoredPermissionMode();
  const initialWorkspaces = seedInitialWorkspaces(DEFAULT_WORKSPACE_ID);
  // 初始值使用 DEFAULT 常量：zustand persist (crish-layout-v1) rehydrate 后
  // 覆盖为持久化值。独立 key 读取已删除（维度 2 收敛到 persist 唯一持久化面）。
  const initialUiSize: UiSize = DEFAULT_UI_SIZE;
  const initialTabMode = true; // 合并标签默认开（persist rehydrate 覆盖）
  const initialShellChrome: ShellChromeMode = DEFAULT_SHELL_CHROME;
  const initialTokenUsage = isDemoMode()
    ? { ...DEMO_TOKEN_USAGE }
    : { ...DEFAULT_TOKEN_USAGE };
  const initialTerminalLines: string[] = isDemoMode()
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

  return {
    sessionSeed,
    initialPermissionMode,
    initialWorkspaces,
    initialUiSize,
    initialTabMode,
    initialShellChrome,
    initialTokenUsage,
    initialTerminalLines,
  };
}
