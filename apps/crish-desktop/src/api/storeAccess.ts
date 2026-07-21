/**
 * Store 跨域编排层。
 *
 * 三域 facade（session / workspace / settingsUi）与 `useLayoutStore` **同一实例**。
 * 本文件提供跨域操作、StoreTransaction，以及对下兼容的命令式门面。
 *
 * ## 初始化
 * 应用启动时由 bootstrapStores 调用 initStoreAccess 注入 store 引用：
 * ```ts
 * import { initStoreAccess } from './api/storeAccess';
 * initStoreAccess(useLayoutStore, useLayoutStore, useLayoutStore);
 * ```
 * 注入前所有方法降级到现有 facade 模块（保持兼容）。
 *
 * ## 域归属
 * - 会话 → sessionStore facade（同 layout）
 * - 工作区/面板 → workspaceStore facade（同 layout）
 * - 设置 UI/权限 → settingsUiStore facade（同 layout）
 * - 跨域编排 → 本文件
 */
import { useLayoutStore } from '../store/layoutStore';
import type {
  LayoutStore,
  TelemetrySyncPayload,
  UiSize,
} from '../store/layoutStore';
import type {
  DiffChange,
  DropPreviewState,
  FileDiff,
  MessageToolCall,
  SessionAgent,
  SessionGoalMode,
  SessionMessage,
  SessionState,
  SettingsTabType,
  WorkspaceState,
} from '../store/types';
import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
} from '../store/draftSession';

export { PENDING_DRAFT_SESSION_ID, isPendingDraft };
import type { PermissionMode } from './permissionModes';
import type { ShellChromeMode } from './shellChrome';
import type { CronJob, Settings } from './clientApi';
import {
  getActiveSession as getActiveSessionFromFacade,
  getActiveSessionId as getActiveSessionIdFromFacade,
  getSessionAgent as getSessionAgentFromFacade,
  getSessionById,
  getSessionStoreState,
} from '../store/sessionStore';
import {
  getPermissionMode as getPermissionModeFromFacade,
  getSettingsUiState,
  openSettings as openSettingsUi,
  closeSettings as closeSettingsUi,
  toggleSettingsOverlay as toggleSettingsOverlayUi,
  setShowSettingsOverlay as setShowSettingsOverlayUi,
  setPermissionMode as setPermissionModeUi,
  setPlanModeEnabled as setPlanModeEnabledUi,
  setPlanApproved as setPlanApprovedUi,
  setSettingsActiveTab as setSettingsActiveTabUi,
} from '../store/settingsUiStore';
import {
  focusExistingPanelCard,
  getActiveWorkspace,
  getDropPreview as getDropPreviewFromFacade,
  getWorkspaceStoreState,
  setDraggedTab as setDraggedTabWs,
  setDropPreview as setDropPreviewWs,
  setGroupActiveCard as setGroupActiveCardWs,
  togglePanel as togglePanelWs,
  type DraggedTabState,
} from '../store/workspaceStore';
import { sessionRuntimeRegistry } from './SessionRuntimeRegistry';

export {
  getSessionById,
  getSessionStoreState,
  getActiveSessionFromFacade as getActiveSession,
  getActiveSessionIdFromFacade as getActiveSessionId,
  getSessionAgentFromFacade as getSessionAgent,
  openSettingsUi as openSettings,
  closeSettingsUi as closeSettings,
  toggleSettingsOverlayUi as toggleSettingsOverlay,
  getSettingsUiState,
  getPermissionModeFromFacade as getPermissionMode,
  getWorkspaceStoreState,
  getActiveWorkspace,
  getDropPreviewFromFacade as getDropPreview,
  setDropPreviewWs as setDropPreview,
  setDraggedTabWs as setDraggedTab,
  setGroupActiveCardWs as setGroupActiveCard,
  togglePanelWs as togglePanel,
};

export type {
  DraggedTabState,
  DropPreviewState,
  SessionState,
  SessionAgent,
  FileDiff,
  DiffChange,
  CronJob,
  WorkspaceState,
};

// ── Store 引用（初始化时注入；三门面与 layout 同实例）─────────────────────────

/** 与 useLayoutStore 同形的 bound store hook */
export type LayoutStoreHook = typeof useLayoutStore;

let _sessionStore: LayoutStoreHook | null = null;
let _workspaceStore: LayoutStoreHook | null = null;
let _settingsUiStore: LayoutStoreHook | null = null;

/**
 * 注入 store 实例（三参数均为 layout 同引用 facade）。
 * 应用启动时调用一次；调用后跨域编排方法使用注入的 store 而非降级路径。
 */
export function initStoreAccess(
  session: LayoutStoreHook,
  workspace: LayoutStoreHook,
  settingsUi: LayoutStoreHook
): void {
  _sessionStore = session;
  _workspaceStore = workspace;
  _settingsUiStore = settingsUi;
}

/** 是否已完成 store 注入 */
export function isStoreAccessInitialized(): boolean {
  return _sessionStore !== null;
}

// ── 完整 layout 快照（跨域写唯一 getState 入口）──────────────────────────────

/** 完整 layout 快照（跨域写；优先窄域 get*StoreState） */
export function getLayoutState(): LayoutStore {
  return useLayoutStore.getState();
}

// ── 内部状态解析（优先注入 store，否则降级到 getLayoutState）────────────────

function resolveSessionState(): LayoutStore {
  if (_sessionStore) return _sessionStore.getState();
  return getLayoutState();
}

function resolveWorkspaceState(): LayoutStore {
  if (_workspaceStore) return _workspaceStore.getState();
  return getLayoutState();
}

function resolveSettingsUiState(): LayoutStore {
  if (_settingsUiStore) return _settingsUiStore.getState();
  return getLayoutState();
}

// ── 跨域操作方法 ─────────────────────────────────────────────────────────────

/**
 * 创建新会话并切换到聊天主界面。
 * 跨域编排：createSession + setChatMainSurface。
 * 返回新会话 id。
 */
export function createSessionAndOpenChat(folder?: string): string {
  const sessionId = resolveSessionState().createSession({ folder });
  if (sessionId) {
    resolveWorkspaceState().setChatMainSurface('chat');
  }
  return sessionId;
}

/**
 * 删除会话并清理运行时状态。
 * 跨域编排：deleteSession + SessionRuntimeRegistry.remove。
 * 返回是否成功删除。
 */
export function deleteSessionWithCleanup(sessionId: string): boolean {
  const removed = resolveSessionState().deleteSession(sessionId);
  if (removed) {
    sessionRuntimeRegistry.remove(sessionId);
  }
  return removed;
}

/**
 * 跨域：删除会话、清理运行时、切换到其他会话（如果有）。
 * 相比 deleteSessionWithCleanup 额外处理会话切换。
 */
export function deleteSessionAndSwitch(sessionId: string): boolean {
  const state = resolveSessionState();
  const removed = state.deleteSession(sessionId);
  if (removed) {
    sessionRuntimeRegistry.remove(sessionId);
    const sessions: SessionState[] = state.sessions ?? [];
    if (sessions.length > 0 && state.activeSessionId === sessionId) {
      const nextIdx = Math.min(
        sessions.findIndex((s: SessionState) => s.id === sessionId) + 1,
        sessions.length - 1
      );
      const fallback = sessions[nextIdx] ?? sessions[sessions.length - 1];
      if (fallback) {
        state.setActiveSessionId(fallback.id);
      }
    }
  }
  return removed;
}

// ── StoreTransaction ────────────────────────────────────────────────────────

/** 会话域事务快照（浅克隆关键字段） */
export type SessionsSnapshot = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  terminalBySession: Record<string, string[]>;
};

/** 工作区域事务快照 */
export type WorkspacesSnapshot = {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
};

/** 设置 UI 域事务快照 */
export type SettingsUiSnapshot = {
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
};

export interface StoreSnapshot {
  sessions: SessionsSnapshot;
  workspaces: WorkspacesSnapshot;
  settingsUi: SettingsUiSnapshot;
}

/**
 * 跨域原子操作事务（同一 layout 实例上的字段快照）。
 *
 * 保存域切片快照，支持 commit / rollback。
 *
 * @example
 * ```ts
 * const tx = new StoreTransaction();
 * tx.begin();
 * try {
 *   createSessionAndOpenChat();
 *   setShowSettingsOverlay(true);
 *   tx.commit();
 * } catch {
 *   tx.rollback();
 * }
 * ```
 */
export class StoreTransaction {
  private snapshots: StoreSnapshot[] = [];

  /** 保存当前域切片快照（压栈）。可嵌套调用。 */
  begin(): void {
    this.snapshots.push({
      sessions: this.cloneSessions(),
      workspaces: this.cloneWorkspaces(),
      settingsUi: this.cloneSettingsUi(),
    });
  }

  /** 提交：丢弃最近一次快照。 */
  commit(): void {
    this.snapshots.pop();
  }

  /** 回滚：从最近一次快照恢复域字段。 */
  rollback(): void {
    const snapshot = this.snapshots.pop();
    if (!snapshot) return;
    this.restoreSessions(snapshot.sessions);
    this.restoreWorkspaces(snapshot.workspaces);
    this.restoreSettingsUi(snapshot.settingsUi);
  }

  /**
   * 在事务中执行回调。回调抛异常时自动回滚。
   * 返回回调的返回值。
   */
  run<T>(fn: () => T): T {
    this.begin();
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  /** 当前快照栈深度（嵌套事务层级） */
  get depth(): number {
    return this.snapshots.length;
  }

  // ── 私有：克隆 / 恢复 ──────────────────────────────────────────────────

  private cloneSessions(): SessionsSnapshot {
    const state = resolveSessionState();
    return {
      sessions: cloneArray(state.sessions),
      sessionsById: { ...(state.sessionsById ?? {}) },
      folderOrder: cloneArray(state.folderOrder),
      activeSessionId: state.activeSessionId,
      activeAgentId: state.activeAgentId,
      panelAgentId: state.panelAgentId,
      composerDrafts: { ...(state.composerDrafts ?? {}) },
      terminalBySession: { ...(state.terminalBySession ?? {}) },
    };
  }

  private cloneWorkspaces(): WorkspacesSnapshot {
    const state = resolveWorkspaceState();
    return {
      workspaces: cloneArray(state.workspaces),
      activeWorkspaceIndex: state.activeWorkspaceIndex,
      tabModeEnabled: state.tabModeEnabled,
      uiSize: state.uiSize,
      shellChromeMode: state.shellChromeMode,
      chatMainSurface: state.chatMainSurface,
      sidebarCollapsed: state.sidebarCollapsed,
      draggedTab: state.draggedTab ? { ...state.draggedTab } : null,
      dropPreview: state.dropPreview ? { ...state.dropPreview } : null,
    };
  }

  private cloneSettingsUi(): SettingsUiSnapshot {
    const state = resolveSettingsUiState();
    return {
      showSettingsOverlay: state.showSettingsOverlay,
      settingsActiveTab: state.settingsActiveTab,
      permissionMode: state.permissionMode,
      planModeEnabled: state.planModeEnabled,
      planApproved: state.planApproved,
    };
  }

  private restoreSessions(snapshot: SessionsSnapshot): void {
    const store = _sessionStore;
    if (store) {
      store.setState(snapshot);
    } else {
      useLayoutStore.setState(snapshot);
    }
  }

  private restoreWorkspaces(snapshot: WorkspacesSnapshot): void {
    const store = _workspaceStore;
    if (store) {
      store.setState(snapshot);
    } else {
      useLayoutStore.setState(snapshot);
    }
  }

  private restoreSettingsUi(snapshot: SettingsUiSnapshot): void {
    const store = _settingsUiStore;
    if (store) {
      store.setState(snapshot);
    } else {
      useLayoutStore.setState(snapshot);
    }
  }
}

// ── 纯工具：id / 对象形态 ───────────────────────────────────────────────────

/** 非空会话 id（排除 null / undefined / 空白） */
export function isNonEmptySessionId(
  sessionId: string | null | undefined
): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0;
}

/** 修剪后的会话 id；无效时 undefined */
export function normalizeSessionId(
  sessionId: string | null | undefined
): string | undefined {
  if (typeof sessionId !== 'string') return undefined;
  const id = sessionId.trim();
  return id.length > 0 ? id : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneArray<T>(arr: T[]): T[] {
  return arr
    ? arr.map((item) =>
        typeof item === 'object' && item !== null ? ({ ...item } as T) : item
      )
    : [];
}

// ── Safe selectors（纯 / 可对快照使用，不强制 mock zustand）────────────────

/** 纯选择：从 sessions 数组 + 可选索引按 id 取会话 */
export function selectSessionById(
  sessions: readonly SessionState[],
  sessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (sessionsById) {
    const hit = sessionsById[id];
    if (hit) return hit;
  }
  return sessions.find((s) => s.id === id);
}

/** 纯选择：活动会话（activeSessionId 空或缺席 → undefined） */
export function selectActiveSession(
  sessions: readonly SessionState[],
  activeSessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  return selectSessionById(sessions, activeSessionId, sessionsById);
}

/** 纯选择：会话内 agent */
export function selectSessionAgent(
  session: SessionState | null | undefined,
  agentId: string | null | undefined
): SessionAgent | undefined {
  if (!session?.agents?.length) return undefined;
  const id = normalizeSessionId(agentId);
  if (!id) return undefined;
  return session.agents.find((a) => a.id === id);
}

/**
 * 解析会话：id 空 / 不存在 → undefined（永不抛）。
 * 命令式热路径优先用此代替手写 find。
 */
export function resolveSession(
  sessionId: string | null | undefined
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  return getSessionById(id);
}

/** 当前活动会话；activeSessionId 空或未映射时 undefined */
export function resolveActiveSession(): SessionState | undefined {
  const id = getActiveSessionIdFromFacade();
  return resolveSession(id);
}

/** 会话是否存在于 store（空 id → false） */
export function hasSession(sessionId: string | null | undefined): boolean {
  return resolveSession(sessionId) !== undefined;
}

/**
 * 守卫：仅当 session 存在时执行 fn，返回 fn 结果；否则返回 undefined。
 * 用于事件回调避免对 null 会话散落 if。
 */
export function withSession<T>(
  sessionId: string | null | undefined,
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveSession(sessionId);
  if (!session) return undefined;
  return fn(session);
}

/**
 * 守卫：对活动会话执行；无活动会话时 undefined。
 */
export function withActiveSession<T>(
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveActiveSession();
  if (!session) return undefined;
  return fn(session);
}

/** 会话写路径共用：空 id 或不存在则跳过（不抛） */
function requireExistingSessionId(
  sessionId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (!getSessionById(id)) return undefined;
  return id;
}

// ── 纯函数：工作区查找 ──────────────────────────────────────────────────────

/** 纯：按 id 找工作区 */
export function findWorkspaceById(
  workspaces: readonly WorkspaceState[],
  wsId: string | null | undefined
): WorkspaceState | undefined {
  const id = normalizeSessionId(wsId);
  if (!id) return undefined;
  return workspaces.find((w) => w.id === id);
}

/** 面板卡在工作区内的列/组坐标 */
export type PanelCardLocation = {
  colIdx: number;
  groupIdx: number;
  cardId: string;
};

/** 纯：在单个工作区内定位 cardId（首个匹配） */
export function findPanelCardLocation(
  workspace: WorkspaceState | null | undefined,
  cardId: string | null | undefined
): PanelCardLocation | undefined {
  if (!workspace?.columns?.length) return undefined;
  const id = normalizeSessionId(cardId);
  if (!id) return undefined;
  for (let colIdx = 0; colIdx < workspace.columns.length; colIdx++) {
    const col = workspace.columns[colIdx];
    if (!col?.groups?.length) continue;
    for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
      const group = col.groups[groupIdx];
      if (group?.cards?.some((card) => card.id === id)) {
        return { colIdx, groupIdx, cardId: id };
      }
    }
  }
  return undefined;
}

/** 纯：工作区是否已有该面板卡 */
export function workspaceHasCard(
  workspace: WorkspaceState | null | undefined,
  cardId: string | null | undefined
): boolean {
  return findPanelCardLocation(workspace, cardId) !== undefined;
}

/**
 * 死面板 id 映射（与 focusOrOpenPanel 一致）：
 * - settings → 不映射到侧栏卡（由设置浮层处理）
 * - plan → tasks
 * 其它原样返回；空 id → undefined
 */
export function resolvePanelCardId(
  cardId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(cardId);
  if (!id) return undefined;
  if (id === 'settings') return undefined;
  if (id === 'plan') return 'tasks';
  return id;
}

/** 命令式：当前 store 中按 id 取工作区 */
export function getWorkspaceById(
  wsId: string | null | undefined
): WorkspaceState | undefined {
  return findWorkspaceById(getWorkspaceStoreState().workspaces, wsId);
}

// ── FileDiff 形态保真 ───────────────────────────────────────────────────────

const DIFF_CHANGE_TYPES = new Set(['addition', 'deletion', 'normal']);

/** 纯：单行 diff change 是否合法 */
export function isDiffChange(value: unknown): value is DiffChange {
  if (!isPlainRecord(value)) return false;
  if (!DIFF_CHANGE_TYPES.has(String(value.type))) return false;
  if (typeof value.content !== 'string') return false;
  if (value.lineNum !== undefined && typeof value.lineNum !== 'number')
    return false;
  return true;
}

/**
 * 纯：值是否为完整 FileDiff（路径非空、增减为 number、changes 为 DiffChange[]）。
 * 与 store/types.FileDiff 对齐，供 push 前过滤。
 */
export function isFileDiff(value: unknown): value is FileDiff {
  if (!isPlainRecord(value)) return false;
  if (
    typeof value.filePath !== 'string' ||
    value.filePath.trim().length === 0
  ) {
    return false;
  }
  if (typeof value.additions !== 'number' || Number.isNaN(value.additions)) {
    return false;
  }
  if (typeof value.deletions !== 'number' || Number.isNaN(value.deletions)) {
    return false;
  }
  if (!Array.isArray(value.changes)) return false;
  for (const c of value.changes) {
    if (!isDiffChange(c)) return false;
  }
  return true;
}

/** 纯：规范化 FileDiff；非法 → null（不抛） */
export function normalizeFileDiff(value: unknown): FileDiff | null {
  if (!isFileDiff(value)) return null;
  const changes: DiffChange[] = value.changes.map((c) => {
    const out: DiffChange = {
      type: c.type,
      content: c.content,
    };
    if (typeof c.lineNum === 'number') out.lineNum = c.lineNum;
    return out;
  });
  return {
    filePath: value.filePath.trim(),
    additions: value.additions,
    deletions: value.deletions,
    changes,
  };
}

// ── CronJob 形态保真 ────────────────────────────────────────────────────────

const CRON_TARGET = new Set(['current-session', 'new-session']);
const CRON_STATUS = new Set(['active', 'paused']);

/**
 * 纯：值是否为完整 CronJob（与 clientApi.CronJob 字段一致）。
 */
export function isCronJob(value: unknown): value is CronJob {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.trim().length === 0)
    return false;
  if (typeof value.cronExpression !== 'string') return false;
  if (typeof value.prompt !== 'string') return false;
  if (!CRON_TARGET.has(String(value.targetSession))) return false;
  if (!CRON_STATUS.has(String(value.status))) return false;
  if (typeof value.nextRun !== 'string') return false;
  return true;
}

/** 纯：规范化单条 CronJob；非法 → null */
export function normalizeCronJob(value: unknown): CronJob | null {
  if (!isCronJob(value)) return null;
  return {
    id: value.id.trim(),
    cronExpression: value.cronExpression,
    prompt: value.prompt,
    targetSession: value.targetSession,
    status: value.status,
    nextRun: value.nextRun,
  };
}

/** 纯：过滤/规范化任务列表；非数组 → [] */
export function filterCronJobs(tasks: unknown): CronJob[] {
  if (!Array.isArray(tasks)) return [];
  const out: CronJob[] = [];
  for (const t of tasks) {
    const n = normalizeCronJob(t);
    if (n) out.push(n);
  }
  return out;
}

// ── 会话域 ──────────────────────────────────────────────────────────────────

export function createSession(opts?: {
  title?: string;
  folder?: string;
  id?: string;
  /** 默认 true；定时占位传 false，不抢走当前对话 */
  activate?: boolean;
}): string {
  return getSessionStoreState().createSession(opts);
}

/** 进入草稿态（sessions 不增条目）；可选绑定 folder */
export function enterDraftMode(folder?: string): void {
  getSessionStoreState().enterDraftMode(folder);
}

/** 更新草稿绑定 folder */
export function setDraftFolder(folder: string): void {
  getSessionStoreState().setDraftFolder(folder);
}

/** 退出草稿态 */
export function clearDraft(): void {
  getSessionStoreState().clearDraft();
}

/**
 * 若 active 为草稿则 mint 真会话并返回 id；
 * 否则返回当前真实 active 或 ''。
 */
export function commitDraftIfNeeded(opts?: {
  title?: string;
  folder?: string;
}): string {
  return getSessionStoreState().commitDraftIfNeeded(opts);
}

export function setActiveSessionId(id: string): void {
  const sid = normalizeSessionId(id);
  if (!sid) return;
  getSessionStoreState().setActiveSessionId(sid);
}

export function setActiveAgentId(id: string | null): void {
  getSessionStoreState().setActiveAgentId(id);
}

export function setPanelAgentId(id: string | null): void {
  getSessionStoreState().setPanelAgentId(id);
}

export function patchSession(
  sessionId: string,
  patch: { goalMode?: SessionGoalMode | null }
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSession(sid, patch);
}

export function branchSession(sessionId: string, newTitle: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().branchSession(sid, newTitle);
}

export function archiveSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().archiveSession(sid);
}

export function unarchiveSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().unarchiveSession(sid);
}

export function pinSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().pinSession(sid);
}

export function unpinSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().unpinSession(sid);
}

export function renameSession(sessionId: string, title: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().renameSession(sid, title);
}

export function setSessions(sessions: SessionState[]): void {
  getSessionStoreState().setSessions(sessions);
}

export function addMessage(
  wsId: string,
  sessionId: string,
  message: SessionMessage
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().addMessage(wsId, sid, message);
}

export function withdrawMessage(
  wsId: string,
  sessionId: string,
  messageId: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().withdrawMessage(wsId, sid, messageId);
}

export function updateMessageText(
  sessionId: string,
  messageId: string,
  text: string,
  precomputedHtml?: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageText(
    sid,
    messageId,
    text,
    precomputedHtml
  );
}

export function updateMessageThinking(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageThinking(sid, messageId, thinking);
}

export function addMessageToolCall(
  sessionId: string,
  messageId: string,
  toolCall: MessageToolCall
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().addMessageToolCall(sid, messageId, toolCall);
}

export function updateMessageToolCall(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  updates: Partial<MessageToolCall>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageToolCall(
    sid,
    messageId,
    toolCallId,
    updates
  );
}

export function setSessionMessageStatus(
  sessionId: string,
  messageId: string,
  status: 'queued' | 'processing' | 'completed',
  thinkingTime?: number
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().setSessionMessageStatus(
    sid,
    messageId,
    status,
    thinkingTime
  );
}

export function respondToApproval(
  wsId: string,
  sessionId: string,
  messageId: string,
  toolCallId: string,
  status: 'success' | 'error'
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().respondToApproval(
    wsId,
    sid,
    messageId,
    toolCallId,
    status
  );
}

export function pinMessage(sessionId: string, messageId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().pinMessage(sid, messageId);
}

export function unpinMessage(sessionId: string, messageId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().unpinMessage(sid, messageId);
}

export function upsertSessionAgent(
  sessionId: string,
  agent: SessionAgent
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().upsertSessionAgent(sid, agent);
}

export function patchSessionAgent(
  sessionId: string,
  agentId: string,
  patch: Partial<SessionAgent>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSessionAgent(sid, agentId, patch);
}

export function appendSessionAgentMessage(
  sessionId: string,
  agentId: string,
  message: SessionMessage
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().appendSessionAgentMessage(sid, agentId, message);
}

// ── 工作区域 ────────────────────────────────────────────────────────────────

/** 工作区命令式快照（与 getWorkspaceStoreState 同引用语义） */
export function getWorkspaceState() {
  return getWorkspaceStoreState();
}

/**
 * 聚焦已有工具面板，或 togglePanel 打开后再聚焦。
 * 替代组件内散落的 workspaces.find + setState 双路径。
 *
 * 死面板映射：
 * - settings → 全屏设置覆盖（不在侧栏开占位卡）
 * - plan → tasks（计划进度统一走任务板）
 *
 * 编排：设置 UI facade + workspace facade（不直写 layout setState）。
 * 空 wsId / 未知工作区 / 空 cardId 安全 no-op。
 */
export function focusOrOpenPanel(wsId: string, cardId: string): void {
  const workspaceId = normalizeSessionId(wsId);
  if (!workspaceId) return;

  if (normalizeSessionId(cardId) === 'settings') {
    openSettingsUi();
    return;
  }

  const resolvedId = resolvePanelCardId(cardId);
  if (!resolvedId) return;

  if (!getWorkspaceById(workspaceId)) return;

  if (focusExistingPanelCard(workspaceId, resolvedId)) return;

  togglePanelWs(workspaceId, resolvedId, true);
  focusExistingPanelCard(workspaceId, resolvedId);
}

// ── 设置 UI 域 ──────────────────────────────────────────────────────────────

export function setShowSettingsOverlay(show: boolean): void {
  setShowSettingsOverlayUi(show);
}

export function setSettingsActiveTab(tab: SettingsTabType): void {
  setSettingsActiveTabUi(tab);
}

export function setPermissionMode(mode: PermissionMode): void {
  setPermissionModeUi(mode);
}

export function setPlanModeEnabled(enabled: boolean): void {
  setPlanModeEnabledUi(enabled);
}

export function setPlanApproved(approved: boolean): void {
  setPlanApprovedUi(approved);
}

// ── 跨域：diff / 遥测 / 设置数据 / 命令白名单 ──────────────────────────────

/**
 * 推入 diff 列表。仅接受形态合法的 FileDiff；非法输入静默丢弃（类型保真）。
 */
export function pushDiffFile(diff: FileDiff): void {
  const normalized = normalizeFileDiff(diff);
  if (!normalized) return;
  getLayoutState().pushDiffFile(normalized);
}

/**
 * 设置当前查看的 diff。null 清空；非法非 null 输入静默忽略。
 */
export function setActiveDiffSource(diff: FileDiff | null): void {
  if (diff === null) {
    getLayoutState().setActiveDiffSource(null);
    return;
  }
  const normalized = normalizeFileDiff(diff);
  if (!normalized) return;
  getLayoutState().setActiveDiffSource(normalized);
}

/** 变更列表快照（只读语义；返回 store 当前数组引用） */
export function getDiffFiles(): FileDiff[] {
  return getLayoutState().diffFiles;
}

/** 当前激活的 diff；无则 null */
export function getActiveDiffSource(): FileDiff | null {
  return getLayoutState().activeDiffSource;
}

export function syncTelemetryData(data: TelemetrySyncPayload): void {
  getLayoutState().syncTelemetryData(data);
}

export function setAppSettings(settings: Settings | null): void {
  getLayoutState().setAppSettings(settings);
}

export function getAppSettings(): Settings | null {
  return getLayoutState().appSettings;
}

/**
 * 写入定时任务列表。会过滤非法项，保证 store 内仅有完整 CronJob。
 * 传入非数组时当作清空（防御）。
 */
export function setScheduledTasks(tasks: CronJob[]): void {
  const list = filterCronJobs(tasks);
  getLayoutState().setScheduledTasks(list);
}

export function getScheduledTasks(): CronJob[] {
  return getLayoutState().scheduledTasks;
}

export function addCommandPermission(cmd: string): void {
  getLayoutState().addCommandPermission(cmd);
}

/** 命令白名单快照（bridge 审批热路径；避免组件/bridge 直摸 layout） */
export function getCommandPermissions(): string[] {
  return getLayoutState().commandPermissions ?? [];
}
