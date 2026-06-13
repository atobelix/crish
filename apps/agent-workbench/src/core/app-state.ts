/**
 * 应用全局状态管理
 * 使用简单的观察者模式，避免引入重量级状态库
 */

// ==================== 统一持久化层 ====================

namespace Persistence {
  const PREFIX = 'crish:';

  export function get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  export function set<T>(key: string, value: T): void {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* noop */ }
  }

  export function remove(key: string): void {
    try { localStorage.removeItem(PREFIX + key); } catch { /* noop */ }
  }

  /** 迁移旧 key（conex: 前缀）到新 key（crish: 前缀） */
  export function migrateLegacyKey(legacyKey: string, newKey: string): void {
    try {
      const legacyFull = legacyKey.startsWith('conex:') ? legacyKey : `conex:${legacyKey}`;
      const raw = localStorage.getItem(legacyFull);
      if (raw !== null && localStorage.getItem(PREFIX + newKey) === null) {
        localStorage.setItem(PREFIX + newKey, raw);
        localStorage.removeItem(legacyFull);
      }
    } catch { /* noop */ }
  }
}

// ==================== Event Cursor Persistence ====================

const CURSOR_STORAGE_KEY = 'crish:event-cursors';

interface EventCursors {
  sessions: Record<string, DaemonEventReplayCursor>;
  runs: Record<string, DaemonEventReplayCursor>;
  latestSessions: Record<string, string>;
  latestRuns: Record<string, string>;
}

type LegacyEventCursors = {
  sessions?: Record<string, number | DaemonEventReplayCursor>;
  runs?: Record<string, number | DaemonEventReplayCursor>;
  latestSessions?: Record<string, string>;
  latestRuns?: Record<string, string>;
};

function loadEventCursors(): EventCursors {
  // 迁移旧 key
  Persistence.migrateLegacyKey('conex-event-cursors', 'event-cursors');
  const raw = Persistence.get<LegacyEventCursors | null>('event-cursors', null);
  if (!raw) return emptyEventCursors();
  return normalizeEventCursors(raw);
}

function saveEventCursors(cursors: EventCursors): void {
  Persistence.set('event-cursors', cursors);
}

function persistSessionCursor(sessionId: string, eventLog: DaemonEventLogMetadata, afterSequence: number, lastEventId?: string): void {
  const cursors = loadEventCursors();
  const key = cursorNamespace(eventLog, sessionId);
  cursors.sessions[key] = buildReplayCursor(eventLog, afterSequence, lastEventId);
  cursors.latestSessions[sessionId] = key;
  saveEventCursors(cursors);
}

function persistRunCursor(runId: string, eventLog: DaemonEventLogMetadata, afterSequence: number, lastEventId?: string): void {
  const cursors = loadEventCursors();
  const key = cursorNamespace(eventLog, runId);
  cursors.runs[key] = buildReplayCursor(eventLog, afterSequence, lastEventId);
  cursors.latestRuns[runId] = key;
  saveEventCursors(cursors);
}

function readSessionCursor(sessionId: string): DaemonEventReplayCursor | null {
  const cursors = loadEventCursors();
  return replayCursorFromPointer(cursors.sessions, cursors.latestSessions[sessionId], sessionId);
}

function readRunCursor(runId: string): DaemonEventReplayCursor | null {
  const cursors = loadEventCursors();
  return replayCursorFromPointer(cursors.runs, cursors.latestRuns[runId], runId);
}

function clearEventCursors(): void {
  try { localStorage.removeItem(CURSOR_STORAGE_KEY); } catch { /* noop */ }
}

function normalizeEventCursors(raw: LegacyEventCursors): EventCursors {
  const sessions: Record<string, DaemonEventReplayCursor> = {};
  const runs: Record<string, DaemonEventReplayCursor> = {};
  normalizeCursorBucket(raw.sessions, sessions);
  normalizeCursorBucket(raw.runs, runs);
  return {
    sessions,
    runs,
    latestSessions: normalizeLatestCursorPointers(raw.latestSessions, sessions),
    latestRuns: normalizeLatestCursorPointers(raw.latestRuns, runs),
  };
}

function emptyEventCursors(): EventCursors {
  return { sessions: {}, runs: {}, latestSessions: {}, latestRuns: {} };
}

function normalizeCursorBucket(
  input: Record<string, number | DaemonEventReplayCursor> | undefined,
  output: Record<string, DaemonEventReplayCursor>
): void {
  if (!input) return;
  for (const [key, value] of Object.entries(input)) {
    if (isDaemonEventReplayCursor(value)) {
      output[key] = value;
    }
  }
}

function buildReplayCursor(
  eventLog: DaemonEventLogMetadata,
  afterSequence: number,
  lastEventId?: string
): DaemonEventReplayCursor {
  return {
    ...eventLog,
    afterSequence,
    ...(lastEventId ? { lastEventId } : {}),
  };
}

function cursorNamespace(eventLog: DaemonEventLogMetadata, id: string): string {
  return `${eventLog.eventLogId}:${eventLog.generation}:${eventLog.schemaVersion}:${eventLog.protocolVersion}:${id}`;
}

function replayCursorFromPointer(
  bucket: Record<string, DaemonEventReplayCursor>,
  pointer: string | undefined,
  id: string
): DaemonEventReplayCursor | null {
  if (pointer && bucket[pointer]) return bucket[pointer];
  const entries = Object.entries(bucket);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, cursor] = entries[index]!;
    if (key.endsWith(`:${id}`)) return cursor;
  }
  return null;
}

function normalizeLatestCursorPointers(
  input: Record<string, string> | undefined,
  bucket: Record<string, DaemonEventReplayCursor>
): Record<string, string> {
  const output: Record<string, string> = {};
  if (input) {
    for (const [id, key] of Object.entries(input)) {
      if (typeof key === 'string' && bucket[key]) {
        output[id] = key;
      }
    }
  }
  return output;
}

function isDaemonEventReplayCursor(value: unknown): value is DaemonEventReplayCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventLogId === 'string' &&
    typeof record.generation === 'number' &&
    typeof record.schemaVersion === 'number' &&
    typeof record.protocolVersion === 'number' &&
    typeof record.afterSequence === 'number'
  );
}

function normalizeWorkspacePath(value: string | null | undefined): string {
  if (!value) return '';
  let normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/^[a-z]:/i.test(normalized)) {
    normalized = `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`;
  }
  normalized = normalized.replace(/\/+$/, '');
  return normalized.toLowerCase();
}

function isSameWorkspacePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

import {
  isDaemonProviderStatusSnapshot,
  isDaemonTaskSnapshot,
  normalizeWorkbenchApprovalMetadata,
  projectDaemonProviderStatusToWorkbench,
  projectDaemonTaskSnapshotToWorkbench,
} from '../shared/workbench-contract';
import type {
  DaemonLifecycleSnapshot,
  DaemonEventLogMetadata,
  DaemonEventReplayCursor,
  DaemonEventReadDiagnostics,
  DaemonMcpStatusSnapshot,
  DaemonPendingInputRecord,
  DaemonProviderStatusSnapshot,
  DaemonRunEventsResponse,
  DaemonTaskMessageSnapshot,
  DaemonTaskSnapshot,
  DaemonTaskSnapshotToolCall,
  DaemonOrchestratorEvent,
  DaemonRunRecord,
  DaemonRunStatus,
  DaemonSessionRecord,
  DaemonSessionSummary,
  WorkbenchAcceptanceItem,
  WorkbenchBackgroundTask,
  WorkbenchChangeItem,
  WorkbenchDisclosureIssue,
  WorkbenchEvidenceItem,
  WorkbenchOutputReference,
  WorkbenchPlanItem,
  WorkbenchProviderConfigSnapshot,
  WorkbenchStatus,
  WorkbenchTaskSnapshot,
  WorkbenchTokenBudgetSnapshot,
  WorkbenchApprovalMetadata,
  WorkbenchApprovalMetadataSource,
  WorkbenchApprovalRiskLevel,
  WorkbenchMetricsQueryResult,
} from '../shared/workbench-contract';
import {
  createRuntimeEventProjectionState,
  materializeRuntimeProjectionMessages,
  projectDaemonOrchestratorEvent,
  timelineItemsFromRuntimeProjectionMessages,
  type RuntimeEventProjectionState,
  type RuntimeProjectionMessage,
  type RuntimeTimelineItem,
  type RuntimeProjectionToolCall,
} from './runtime-event-projector';
import { isBridgeDiagnostic } from './bridge-utils';
import { showToast } from '../components/ToastContainer';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  toolCalls?: ToolCall[];
  streaming?: boolean;
  /** 系统消息类型（用于特殊渲染） */
  systemType?: 'compression' | 'intervention' | 'checkpoint' | 'startup';
  /** 压缩摘要数据（用于 CompactionSummaryCard 渲染） */
  compactionData?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
  output?: string;
  status: 'pending' | 'approved' | 'denied' | 'running' | 'completed' | 'failed';
  timestamp: number;
  runId?: string;
  sessionId?: string;
  /** 风险等级（只展示后端 permissions metadata；缺失时为 unknown） */
  riskLevel?: WorkbenchApprovalRiskLevel;
  /** 命中规则（如 secret/destructive/external-side-effect） */
  riskRule?: string;
  /** 风险描述 */
  riskDetail?: string;
  riskSource?: WorkbenchApprovalMetadataSource;
  matched?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  approvalMetadata?: WorkbenchApprovalMetadata;
  checkpointId?: string;
  snapshotId?: string;
}

/** 审批历史记录 */
export interface ApprovalHistoryRecord {
  id: string;
  toolName: string;
  toolCallId: string;
  decision: 'approved' | 'denied';
  scope: 'once' | 'project' | 'always';
  riskLevel: WorkbenchApprovalRiskLevel;
  rule?: string;
  decidedAt: number;
  runId?: string;
}

export interface SubAgent {
  id: string;
  name: string;
  status: 'active' | 'idle' | 'done';
  messages: ChatMessage[];
  parentRunId?: string;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  workingDirectory?: string;
  activeRunId?: string | null;
  lastRunId?: string | null;
  daemonRecord?: DaemonSessionRecord;
  daemonSummary?: DaemonSessionSummary;
  parentSessionId?: string;
  parentRunId?: string;
  parentMessageId?: string;
  lineageKind?: 'root' | 'subagent' | 'fork';
  /** 关联的项目路径。null 表示全局对话（Chat 模式），string 表示项目关联对话（Code 模式） */
  projectId?: string | null;
}

export interface ConversationWorkspaceContext {
  workspaceMode: 'project' | 'none';
  cwd?: string;
  label: string;
  projectId: string | null;
}

export interface PendingAskQuestion {
  questionId: string;
  prompt: string;
  kind: 'text' | 'single' | 'multi';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  runId?: string;
  sessionId?: string;
}

export interface PendingInputIntent {
  id: string;
  sessionId: string | null;
  runId?: string | null;
  text: string;
  mode: 'after-current-run' | 'steer';
  createdAt: number;
}

export interface RunContext {
  runId: string;
  sessionId: string;
  prompt: string;
  mode?: string;
  model?: string;
  cwd?: string;
  permissionMode?: 'ask' | 'full-access';
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
  updatedAt: number;
}

export interface DaemonEventSlice {
  events: DaemonOrchestratorEvent[];
  nextAfterSequence: number;
  hasMore: boolean;
  nextCursor?: DaemonEventReplayCursor;
  loadedAt: number;
  sessionId?: string;
  diagnostics?: DaemonEventSliceDiagnostics;
}

export interface DaemonEventSliceDiagnostics {
  scope: 'session' | 'run';
  targetId: string;
  mode: DaemonEventReadDiagnostics['mode'] | 'frontend-cache' | 'unknown';
  requestMs?: number;
  backendQueryMs?: number;
  requestedAfterSequence?: number;
  storeReadAfterSequence?: number;
  projectedAfterSequence?: number;
  eventsFetched: number;
  eventsApplied: number;
  dedupedCount: number;
  totalEvents: number;
  hasMore?: boolean;
  maxEvents?: number;
  nextCursor?: DaemonEventReplayCursor;
  hydratedMessages?: number;
  loadedAt: number;
}

/** Checkpoint 记录（从 checkpoint-created 事件中收集） */
export interface CheckpointRecord {
  id: string;
  label: string;
  runId?: string;
  sessionId?: string;
  filePaths: string[];
  createdAt: number;
  /** 是否已恢复过 */
  restoredAt?: number;
}

export interface DaemonBrowserState {
  sessions: DaemonSessionRecord[];
  sessionSummaries: Record<string, DaemonSessionSummary>;
  runsBySessionId: Record<string, DaemonRunRecord[]>;
  selectedSessionId: string | null;
  selectedRunId: string | null;
  sessionEventsBySessionId: Record<string, DaemonEventSlice>;
  runEventsByRunId: Record<string, DaemonEventSlice>;
  loadingSessions: boolean;
  loadingRuns: boolean;
  loadingEvents: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  diagnostics?: DaemonBrowserDiagnostics;
}

export interface DaemonBrowserDiagnostics {
  lastSessionListLoad?: DaemonListLoadDiagnostics;
  lastRunListLoad?: DaemonListLoadDiagnostics;
  lastEventLoad?: DaemonEventSliceDiagnostics;
}

const DAEMON_SESSION_SWITCH_EVENT_PAGE_SIZE = 200;

export interface DaemonListLoadDiagnostics {
  scope: 'sessions' | 'runs';
  targetId?: string;
  requestMs: number;
  count: number;
  loadedAt: number;
}

export type DaemonStatusState = WorkbenchStatus & {
  lifecycle?: DaemonLifecycleSnapshot;
  mcpStatus?: DaemonMcpStatusSnapshot;
};

export interface AppStateData {
  currentSession: Session | null;
  currentSessionId: string | null;
  sessions: Session[];
  activeRunId: string | null;
  activeRunSessionId: string | null;
  runContexts: Record<string, RunContext>;
  isStreaming: boolean;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  /** 全局标签定义表 */
  rightSidebarTabs: RightSidebarTab[];
  /** 右侧面板布局树 */
  panelLayout: PanelNode;
  /** 拖拽时的实时预览布局（与落地结果一致）；非拖拽时为 null */
  panelLayoutPreview: PanelNode | null;
  /** 预览中"被拖窗口的新面板 id"，渲染为空位（真实窗口浮动跟手） */
  previewGhostPanelId: string | null;
  subAgents: SubAgent[];
  apiKey: string;
  model: string;
  providerConfig: WorkbenchProviderConfigSnapshot;
  daemonStatus: DaemonStatusState | null;
  theme: string;
  /** workMode 已改为计算属性 getter，不再存储 */
  /** 权限模式："ask" = 询问模式，"full-access" = 完全允许模式 */
  permissionMode: 'ask' | 'full-access';
  /** 当前工作目录（Code 模式下用户选择的文件夹） */
  workingDirectory: string;
  /** 已打开的项目文件夹列表（常驻在左侧 Code 模式面板） */
  openedFolders: string[];
  /** 左侧边栏布局模式：'split' = 上下分屏, 'tabs' = 标签切换 */
  leftLayout: 'split' | 'tabs';
  /** 左侧边栏当前激活标签（仅 tabs 模式生效） */
  leftTab: 'code' | 'chat';
  /** 左侧边栏分屏时代码面板占比（20-80） */
  codePaneRatio: number;
  /** 项目文件夹的自定义排序 */
  projectOrder: string[];
  /** 每个项目下会话的自定义排序 */
  sessionOrder: Record<string, string[]>;
  /** 置顶的项目文件夹 */
  pinnedProjects: string[];
  /** 文件变更列表（从 AI 事件中收集） */
  changedFiles: ChangedFile[];
  /** Checkpoint 列表（从 checkpoint-created 事件中收集） */
  checkpoints: CheckpointRecord[];
  /** 待审批队列（多个工具调用可能同时需要审批） */
  approvalQueue: ToolCall[];
  /** 审批历史记录 */
  approvalHistory: ApprovalHistoryRecord[];
  /** 待回答的交互式提问（消费 BE-16 ask-requested） */
  pendingQuestions: PendingAskQuestion[];
  /** Workbench 本地待发送输入队列；后续迁移到 daemon 事件流持久化 */
  pendingInputs: PendingInputIntent[];
  /** 当前活跃任务的快照 */
  taskSnapshot: TaskSnapshot | null;
  /** 性能快照 */
  performanceSnapshot: PerformanceSnapshot | null;
  metricsSnapshot: WorkbenchMetricsSnapshotState;
  daemonBrowser: DaemonBrowserState;
}

export interface ChangedFile {
  path: string;
  addedLines: number;
  removedLines: number;
  status: 'created' | 'modified' | 'deleted';
}

/** 右侧面板标签定义 */
export type RightSidebarTabType =
  | 'chat'         // 对话: 消息流 + 输入（合并入工作区后成为一个窗口）
  | 'project'      // 项目: 文件树 + 变更文件 + Checkpoint
  | 'runs'         // 运行: Daemon run 列表 + 事件
  | 'sessions'     // 会话: Daemon session 列表 + 事件
  | 'approvals'    // 审批: 审批队列 + 风险等级 + 历史
  | 'artifacts'    // 产物: Artifact 预览
  | 'diagnostics'  // 诊断: 任务状态 + 健康信息
  | 'tools'        // 工具: MCP + 子智能体 + 记忆
  | 'plan'         // 计划: 计划文档 + 步骤 + 风险 + 验收
  | 'settings';    // 设置: 账户 + Provider + 外观 + 权限

export interface RightSidebarTab {
  id: string;
  type: RightSidebarTabType;
  label: string;
  closable: boolean;
  /** chat 类型可绑定到特定会话（用于多对话并排窗口）；缺省则跟随当前会话 */
  sessionId?: string;
}

/** 标签面板（叶子节点） */
export interface TabPanel {
  kind: 'panel';
  id: string;
  tabIds: string[];
  activeTabId: string;
}

/** 面板分组（可嵌套） */
export interface PanelGroup {
  kind: 'group';
  id: string;
  direction: 'vertical' | 'horizontal';
  children: PanelNode[];
  sizes: number[];
}

export type PanelNode = TabPanel | PanelGroup;

/** 任务快照（来自 workbench_task_snapshot） */
export type TaskSnapshot = WorkbenchTaskSnapshot;
export type PlanItem = WorkbenchPlanItem;
export type AcceptanceItem = WorkbenchAcceptanceItem;
export type EvidenceItem = WorkbenchEvidenceItem;
export type ChangeItem = WorkbenchChangeItem;
export type BackgroundTaskInfo = WorkbenchBackgroundTask;
export type OutputRef = WorkbenchOutputReference;
export type DisclosureIssueInfo = WorkbenchDisclosureIssue;
export type TokenBudgetInfo = WorkbenchTokenBudgetSnapshot;

/** 性能快照 */
export interface PerformanceSnapshot {
  mainProcess: { pid: number; memoryMb: number; pageFileMb: number };
  runs: Array<{
    runId: string;
    pid: number;
    workingSetMb: number;
    peakWorkingSetMb: number;
    pageFileMb: number;
    processTree?: any;
  }>;
  timestamp: string;
}

export interface WorkbenchMetricsSnapshotState {
  result: WorkbenchMetricsQueryResult | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

type Listener<T = any> = (data: T) => void;

interface DaemonEventSliceDiagnosticsInput {
  requestMs?: number;
  backend?: DaemonEventReadDiagnostics;
  mode?: DaemonEventSliceDiagnostics['mode'];
  hasMore?: boolean;
  nextCursor?: DaemonEventReplayCursor;
}

// ==================== 右栏布局持久化 ====================

function saveRightLayout(tabs: RightSidebarTab[], panelLayout: PanelNode): void {
  Persistence.set('right-layout-v2', { version: 1, tabs, panelLayout });
}

function loadRightLayout(): { tabs: RightSidebarTab[]; panelLayout: PanelNode } | null {
  // 迁移旧 key
  Persistence.migrateLegacyKey('conex:right-layout-v2', 'right-layout-v2');
  const parsed = Persistence.get<{ tabs?: unknown; panelLayout?: unknown } | null>('right-layout-v2', null);
  if (!parsed) return null;
  if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0 || !parsed.panelLayout) return null;
  const tabs = parsed.tabs as RightSidebarTab[];
  if (!tabs.every(t => t && typeof t.id === 'string' && typeof t.type === 'string')) return null;
  const ids = new Set(tabs.map(t => t.id));
  // 校验布局只引用存在的标签，且每个叶子面板至少有一个有效标签
  const validate = (node: unknown): node is PanelNode => {
    if (!node || typeof node !== 'object') return false;
    const n = node as PanelNode;
    if (n.kind === 'panel') {
      return Array.isArray(n.tabIds) && n.tabIds.every(id => ids.has(id));
    }
    if (n.kind === 'group') {
      return Array.isArray(n.children) && n.children.length > 0 && n.children.every(validate);
    }
    return false;
  };
  if (!validate(parsed.panelLayout)) return null;
  return { tabs, panelLayout: parsed.panelLayout as PanelNode };
}

// ==================== 按对话隔离的工作区 ====================

interface WorkspaceState { tabs: RightSidebarTab[]; layout: PanelNode }

// 每个对话的默认工作区：左「对话」+ 右「项目/审批/工具」
function makeDefaultWorkspace(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-chat', type: 'chat', label: '对话', closable: true },
      { id: 'tab-project', type: 'project', label: '项目', closable: true },
      { id: 'tab-approvals', type: 'approvals', label: '审批', closable: true },
      { id: 'tab-tools', type: 'tools', label: '工具', closable: true },
    ],
    layout: {
      kind: 'group',
      id: 'group-root',
      direction: 'horizontal',
      sizes: [62, 38],
      children: [
        { kind: 'panel', id: 'panel-chat', tabIds: ['tab-chat'], activeTabId: 'tab-chat' },
        { kind: 'panel', id: 'panel-side', tabIds: ['tab-project', 'tab-approvals', 'tab-tools'], activeTabId: 'tab-project' },
      ],
    },
  };
}

function isValidWorkspace(ws: unknown): ws is WorkspaceState {
  if (!ws || typeof ws !== 'object') return false;
  const w = ws as WorkspaceState;
  if (!Array.isArray(w.tabs) || w.tabs.length === 0 || !w.layout) return false;
  if (!w.tabs.every(t => t && typeof t.id === 'string' && typeof t.type === 'string')) return false;
  const ids = new Set(w.tabs.map(t => t.id));
  const validate = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const n = node as PanelNode;
    if (n.kind === 'panel') return Array.isArray(n.tabIds) && n.tabIds.every(id => ids.has(id));
    if (n.kind === 'group') return Array.isArray(n.children) && n.children.length > 0 && n.children.every(validate);
    return false;
  };
  return validate(w.layout);
}

function loadWorkspaces(): Record<string, WorkspaceState> {
  // 迁移旧 key
  Persistence.migrateLegacyKey('conex:workspaces-v1', 'workspaces-v1');
  const parsed = Persistence.get<Record<string, unknown>>('workspaces-v1', {});
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, WorkspaceState> = {};
  for (const [id, ws] of Object.entries(parsed)) {
    if (isValidWorkspace(ws)) out[id] = ws as WorkspaceState;
  }
  return out;
}

function saveWorkspaces(map: Record<string, WorkspaceState>): void {
  Persistence.set('workspaces-v1', map);
}

/**
 * 状态管理类
 */
/** `appState.setState` 接受的合法 key 集合 */
export type AppStateKey = keyof AppStateData;

/** 可订阅的 key 集合（包含计算属性 workMode） */
export type SubscribableKey = AppStateKey | 'workMode';

export class AppState {
  private state: AppStateData = {
    currentSession: null,
    currentSessionId: null,
    sessions: [],
    activeRunId: null,
    activeRunSessionId: null,
    runContexts: {},
    isStreaming: false,
    leftSidebarVisible: true,
    rightSidebarVisible: false,
    rightSidebarTabs: [
      { id: 'tab-chat', type: 'chat', label: '对话', closable: true },
      { id: 'tab-project', type: 'project', label: '项目', closable: true },
      { id: 'tab-approvals', type: 'approvals', label: '审批', closable: true },
      { id: 'tab-tools', type: 'tools', label: '工具', closable: true },
    ],
    panelLayout: {
      kind: 'group',
      id: 'group-root',
      direction: 'horizontal',
      sizes: [62, 38],
      children: [
        { kind: 'panel', id: 'panel-chat', tabIds: ['tab-chat'], activeTabId: 'tab-chat' },
        { kind: 'panel', id: 'panel-side', tabIds: ['tab-project', 'tab-approvals', 'tab-tools'], activeTabId: 'tab-project' },
      ],
    },
    panelLayoutPreview: null,
    previewGhostPanelId: null,
    subAgents: [],
    apiKey: '',
    model: '',
    providerConfig: {
      baseUrl: '',
      model: '',
      hasApiKey: false,
      apiKeySource: 'unset',
      accountCenterConfigured: 'unknown',
      credentialMode: 'account-center',
      credentialStatus: 'unknown',
      statusText: 'Waiting for provider configuration',
      updatedAt: new Date(0).toISOString(),
      endpoint: 'auto',
      stream: true,
    },
    daemonStatus: null,
    theme: 'dark',
    permissionMode: 'ask',
    workingDirectory: '',
    openedFolders: [],
    leftLayout: (() => {
      Persistence.migrateLegacyKey('conex:left-layout', 'left-layout');
      Persistence.migrateLegacyKey('conex:left-tab', 'left-tab');
      Persistence.migrateLegacyKey('conex:left-split-ratio', 'left-split-ratio');
      Persistence.migrateLegacyKey('conex:project-order', 'project-order');
      Persistence.migrateLegacyKey('conex:session-order', 'session-order');
      Persistence.migrateLegacyKey('conex:pinned-projects', 'pinned-projects');
      return Persistence.get<'split' | 'tabs'>('left-layout', 'split');
    })(),
    leftTab: Persistence.get<'code' | 'chat'>('left-tab', 'code'),
    codePaneRatio: (() => { const n = Persistence.get<number>('left-split-ratio', 55); return n >= 20 && n <= 80 ? n : 55; })(),
    projectOrder: Persistence.get<string[]>('project-order', []),
    sessionOrder: Persistence.get<Record<string, string[]>>('session-order', {}),
    pinnedProjects: Persistence.get<string[]>('pinned-projects', []),
    changedFiles: [],
    checkpoints: [],
    approvalQueue: [],
    pendingQuestions: [],
    pendingInputs: [],
    approvalHistory: [],
    taskSnapshot: null,
    performanceSnapshot: null,
    metricsSnapshot: {
      result: null,
      loading: false,
      error: null,
      updatedAt: null,
    },
    daemonBrowser: {
      sessions: [],
      sessionSummaries: {},
      runsBySessionId: {},
      selectedSessionId: null,
      selectedRunId: null,
      sessionEventsBySessionId: {},
      runEventsByRunId: {},
      loadingSessions: false,
      loadingRuns: false,
      loadingEvents: false,
      error: null,
      lastLoadedAt: null,
      diagnostics: {},
    },
  };

  private listeners: Map<string, Set<Listener>> = new Map();
  private daemonProjectionBySessionId = new Map<string, RuntimeEventProjectionState>();
  private hydratedDaemonEventIdsBySessionId = new Map<string, Set<string>>();

  /**
   * 获取完整状态
   */
  getState(): Readonly<AppStateData> {
    return this.state;
  }

  /**
   * workMode 计算属性：由 currentSession.projectId 决定
   * 有 projectId → 'agent'，无 projectId → 'chat'
   */
  get workMode(): 'agent' | 'chat' {
    const session = this.state.currentSession;
    return session?.projectId ? 'agent' : 'chat';
  }

  /**
   * 订阅状态变化
   * 支持计算属性 'workMode' 的订阅，当 currentSession 变化时自动触发
   */
  subscribe<K extends SubscribableKey>(
    key: K,
    listener: Listener<any>
  ): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener);

    // 返回取消订阅函数
    return () => {
      this.listeners.get(key)?.delete(listener);
    };
  }

  /**
   * 更新状态
   */
  setState<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    if (key === 'currentSession') {
      this.setCurrentSessionValue(value as Session | null);
      return;
    }

    if (key === 'currentSessionId') {
      const sessionId = value as string | null;
      this.setCurrentSessionValue(sessionId ? this.getSession(sessionId) : null);
      return;
    }

    if (key === 'taskSnapshot') {
      this.replaceTaskSnapshot(value as TaskSnapshot | DaemonTaskSnapshot | null);
      return;
    }

    if (key === 'providerConfig') {
      this.replaceProviderConfig(value as WorkbenchProviderConfigSnapshot | DaemonProviderStatusSnapshot);
      return;
    }

    if (key === 'daemonStatus') {
      if (value === null) {
        this.state.daemonStatus = null;
        this.notify('daemonStatus', this.state.daemonStatus);
      } else {
        this.applyWorkbenchStatus(value as WorkbenchStatus);
      }
      return;
    }

    this.state[key] = value;
    this.notify(key, value);

    // 持久化侧边栏布局状态
    const persistKeys: Partial<Record<keyof AppStateData, string>> = {
      leftLayout: 'left-layout',
      leftTab: 'left-tab',
      codePaneRatio: 'left-split-ratio',
      projectOrder: 'project-order',
      sessionOrder: 'session-order',
      pinnedProjects: 'pinned-projects',
    };
    const persistKey = persistKeys[key];
    if (persistKey) Persistence.set(persistKey, value);
  }

  /**
   * 部分更新状态
   */
  patchState(patch: Partial<AppStateData>): void {
    Object.entries(patch).forEach(([key, value]) => {
      this.setState(key as keyof AppStateData, value as any);
    });
  }

  getSession(sessionId?: string | null): Session | null {
    if (!sessionId) return this.state.currentSession;
    return this.state.sessions.find((session) => session.id === sessionId) ?? null;
  }

  getCurrentSessionId(): string | null {
    return this.state.currentSessionId;
  }

  getSessionTimeline(sessionId?: string | null): RuntimeTimelineItem[] {
    const session = this.getSession(sessionId ?? this.state.currentSessionId);
    return timelineItemsFromRuntimeProjectionMessages(session?.messages ?? []);
  }

  private setCurrentSessionValue(session: Session | null): void {
    const prevId = this.state.currentSessionId;
    const prevWorkMode = this.workMode;
    if (session) {
      const index = this.state.sessions.findIndex((item) => item.id === session.id);
      if (index >= 0) {
        this.state.sessions[index] = session;
      } else {
        this.state.sessions.unshift(session);
      }
    }

    this.state.currentSession = session;
    this.state.currentSessionId = session?.id ?? null;
    // 按对话隔离工作区：切换对话时存旧、载新
    if ((session?.id ?? null) !== prevId) {
      this.switchWorkspace(prevId, session?.id ?? null);
    }
    this.notify('currentSession', this.state.currentSession);
    this.notify('currentSessionId', this.state.currentSessionId);
    if (session) {
      this.notify('sessions', this.state.sessions);
    }
    // workMode 是计算属性，当 currentSession 变化导致 workMode 变化时通知订阅者
    const newWorkMode = this.workMode;
    if (prevWorkMode !== newWorkMode) {
      this.notify('workMode', newWorkMode);
    }
  }

  /**
   * 创建新会话
   * 默认创建无项目对话；项目内对话必须显式传入项目路径。
   */
  createSession(title: string = '新对话', projectIdOverride?: string | null): Session {
    const projectId = projectIdOverride !== undefined ? projectIdOverride : null;

    const session: Session = {
      id: `session-${Date.now()}`,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(projectId ? { workingDirectory: projectId } : {}),
      projectId,
    };

    this.state.sessions.unshift(session);
    this.setState('currentSession', session);
    if (projectId) {
      if (this.state.workingDirectory !== projectId) {
        this.state.workingDirectory = projectId;
        this.notify('workingDirectory', this.state.workingDirectory);
      }
    }
    this.notify('sessions', this.state.sessions);

    return session;
  }

  /**
   * 添加项目文件夹到常驻列表
   */
  addOpenedFolder(folder: string): void {
    const normalizedFolder = folder.trim();
    if (!normalizedFolder || this.state.openedFolders.some((item) => isSameWorkspacePath(item, normalizedFolder))) return;
    this.setState('openedFolders', [...this.state.openedFolders, normalizedFolder]);
  }

  getCurrentWorkspaceContext(): ConversationWorkspaceContext {
    return this.workspaceContextForSession(this.state.currentSession);
  }

  getRunWorkspace(sessionId?: string | null): Pick<ConversationWorkspaceContext, 'workspaceMode' | 'cwd'> {
    const context = this.workspaceContextForSession(this.getSession(sessionId ?? this.state.currentSessionId));
    return context.workspaceMode === 'project'
      ? { workspaceMode: 'project', cwd: context.cwd }
      : { workspaceMode: 'none' };
  }

  setCurrentSessionWorkspace(projectId: string | null): Session {
    let session = this.state.currentSession;
    if (!session) {
      session = this.createSession('新对话', projectId);
    }

    const updated: Session = {
      ...session,
      projectId,
      workingDirectory: projectId ?? undefined,
      updatedAt: Date.now(),
    };
    this.notifySessionUpdated(updated);
    this.setCurrentSessionValue(updated);

    if (projectId) {
      this.addOpenedFolder(projectId);
      this.setState('workingDirectory', projectId);
    }

    return updated;
  }

  /**
   * 添加 Checkpoint 记录
   */
  addCheckpoint(checkpoint: CheckpointRecord): void {
    const existing = this.state.checkpoints.findIndex(cp => cp.id === checkpoint.id);
    if (existing >= 0) {
      const updated = [...this.state.checkpoints];
      updated[existing] = checkpoint;
      this.setState('checkpoints', updated);
    } else {
      this.setState('checkpoints', [checkpoint, ...this.state.checkpoints]);
    }
  }

  /**
   * 标记 Checkpoint 已恢复
   */
  markCheckpointRestored(checkpointId: string): void {
    const updated = this.state.checkpoints.map(cp =>
      cp.id === checkpointId ? { ...cp, restoredAt: Date.now() } : cp
    );
    this.setState('checkpoints', updated);
  }

  /**
   * 清空 Checkpoint 列表
   */
  clearCheckpoints(): void {
    this.setState('checkpoints', []);
  }

  /**
   * 本地工具名诊断仅用于开发排查，不能作为审批风险事实。
   */
  diagnosticToolNameHint(toolName: string, input?: any): { source: 'diagnostic'; rule?: string; detail?: string } {
    const destructiveTools = ['delete_file', 'remove_dir', 'rm', 'bash'];
    const secretTools = ['read_env', 'get_secret', 'access_key'];
    const networkTools = ['fetch', 'curl', 'wget', 'http_request'];
    const writeTools = ['edit', 'apply_workspace_edits', 'create_file', 'append_file'];
    const legacyWriteTools = ['write_file', 'edit_file'];

    const name = toolName.toLowerCase();
    if (destructiveTools.some(t => name.includes(t))) {
      return { source: 'diagnostic', rule: 'destructive-name', detail: '工具名包含破坏性操作关键词，等待后端风险元数据确认' };
    }
    if (secretTools.some(t => name.includes(t))) {
      return { source: 'diagnostic', rule: 'secret-name', detail: '工具名包含敏感信息关键词，等待后端风险元数据确认' };
    }
    if (networkTools.some(t => name.includes(t))) {
      return { source: 'diagnostic', rule: 'network-name', detail: '工具名包含网络访问关键词，等待后端风险元数据确认' };
    }
    if (writeTools.some(t => name === t) || legacyWriteTools.some(t => name.includes(t))) {
      return { source: 'diagnostic', rule: 'write-name', detail: '工具名包含写入操作关键词，等待后端风险元数据确认' };
    }
    return { source: 'diagnostic' };
  }

  /**
   * 添加审批请求到队列
   */
  enqueueApproval(toolCall: ToolCall): void {
    const metadata = normalizeWorkbenchApprovalMetadata(toolCall.approvalMetadata);
    const enriched: ToolCall = {
      ...toolCall,
      approvalMetadata: metadata,
      ...this.approvalMetadataFields(metadata),
    };
    const existing = this.state.approvalQueue.findIndex(tc => tc.id === toolCall.id);
    if (existing >= 0) {
      const updated = [...this.state.approvalQueue];
      updated[existing] = enriched;
      this.setState('approvalQueue', updated);
    } else {
      this.setState('approvalQueue', [...this.state.approvalQueue, enriched]);
    }
  }

  /**
   * 从审批队列移除并记录到历史
   */
  resolveApproval(toolCallId: string, decision: 'approved' | 'denied', scope: 'once' | 'project' | 'always' = 'once'): void {
    const toolCall = this.state.approvalQueue.find(tc => tc.id === toolCallId);
    if (!toolCall) return;
    const historyRecord: ApprovalHistoryRecord = {
      id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      decision,
      scope,
      riskLevel: toolCall.riskLevel ?? 'unknown',
      rule: toolCall.riskRule,
      decidedAt: Date.now(),
      runId: toolCall.runId,
    };
    this.setState('approvalQueue', this.state.approvalQueue.filter(tc => tc.id !== toolCallId));
    this.setState('approvalHistory', [historyRecord, ...this.state.approvalHistory]);
  }

  /** 加入待回答提问（按 questionId 去重） */
  addPendingQuestion(question: PendingAskQuestion): void {
    const existing = this.state.pendingQuestions.findIndex(q => q.questionId === question.questionId);
    if (existing >= 0) {
      const updated = [...this.state.pendingQuestions];
      updated[existing] = question;
      this.setState('pendingQuestions', updated);
    } else {
      this.setState('pendingQuestions', [...this.state.pendingQuestions, question]);
    }
  }

  /** 移除已回答 / 已取消的提问 */
  resolvePendingQuestion(questionId: string): void {
    this.setState('pendingQuestions', this.state.pendingQuestions.filter(q => q.questionId !== questionId));
  }

  enqueuePendingInput(input: Omit<PendingInputIntent, 'id' | 'createdAt'>): PendingInputIntent {
    const intent: PendingInputIntent = {
      ...input,
      id: `pending-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: input.text.trim(),
      createdAt: Date.now(),
    };
    if (!intent.text) return intent;
    this.upsertPendingInputIntent(intent);
    void this.persistPendingInputIntent(intent);
    return intent;
  }

  removePendingInput(intentId: string): void {
    const existing = this.state.pendingInputs.find(intent => intent.id === intentId);
    this.setState('pendingInputs', this.state.pendingInputs.filter(intent => intent.id !== intentId));
    if (existing) {
      void this.cancelDaemonPendingInput(existing);
    }
  }

  dispatchPendingInput(intentId: string, targetRunId?: string | null): void {
    const existing = this.state.pendingInputs.find(intent => intent.id === intentId);
    this.setState('pendingInputs', this.state.pendingInputs.filter(intent => intent.id !== intentId));
    if (existing) {
      void this.dispatchDaemonPendingInput(existing, targetRunId);
    }
  }

  getPendingInputs(sessionId: string | null | undefined = this.state.currentSessionId): PendingInputIntent[] {
    return this.state.pendingInputs.filter(intent => intent.sessionId === (sessionId ?? null));
  }

  async syncPendingInputs(sessionId: string | null | undefined = this.state.currentSessionId): Promise<void> {
    const normalizedSessionId = sessionId ?? null;
    if (!normalizedSessionId) return;
    const { tauriBridge } = await import('./tauri-bridge');
    const result = await tauriBridge.listPendingInputs(normalizedSessionId);
    if (isBridgeDiagnostic(result)) {
      this.setDaemonBrowserError((result as any).diagnostic?.message ?? '后端通信异常');
      return;
    }
    const remoteInputs = result
      .filter((record) => record.status === 'pending')
      .map((record) => this.pendingInputIntentFromDaemon(record));
    const next = [
      ...this.state.pendingInputs.filter(intent => intent.sessionId !== normalizedSessionId),
      ...remoteInputs,
    ].sort((left, right) => left.createdAt - right.createdAt);
    this.setState('pendingInputs', this.dedupePendingInputs(next));
  }

  /**
   * 从常驻列表移除项目文件夹
   */
  removeOpenedFolder(folder: string): void {
    const next = this.state.openedFolders.filter(f => !isSameWorkspacePath(f, folder));
    this.setState('openedFolders', next);
    // 如果移除的是当前工作目录，切换到列表中的下一个或清空
    if (isSameWorkspacePath(this.state.workingDirectory, folder)) {
      this.setState('workingDirectory', next[0] || '');
    }
  }

  replaceOpenedFolder(oldFolder: string, newFolder: string): void {
    const normalizedNewFolder = newFolder.trim();
    if (!oldFolder || !normalizedNewFolder || isSameWorkspacePath(oldFolder, normalizedNewFolder)) return;

    const nextFolders = this.state.openedFolders.map((folder) =>
      isSameWorkspacePath(folder, oldFolder) ? normalizedNewFolder : folder
    );
    if (!nextFolders.some((folder) => isSameWorkspacePath(folder, normalizedNewFolder))) {
      nextFolders.push(normalizedNewFolder);
    }
    this.setState(
      'openedFolders',
      this.uniqueWorkspaceFolders(nextFolders.filter((folder) => !isSameWorkspacePath(folder, oldFolder) || isSameWorkspacePath(folder, normalizedNewFolder)))
    );

    this.state.sessions = this.state.sessions.map((session) =>
      isSameWorkspacePath(typeof session.projectId === 'string' ? session.projectId : undefined, oldFolder) ||
      isSameWorkspacePath(session.workingDirectory, oldFolder)
        ? {
            ...session,
            projectId:
              typeof session.projectId === 'string' && isSameWorkspacePath(session.projectId, oldFolder)
                ? normalizedNewFolder
                : session.projectId,
            workingDirectory: isSameWorkspacePath(session.workingDirectory, oldFolder) ? normalizedNewFolder : session.workingDirectory,
          }
        : session
    );
    this.notify('sessions', this.state.sessions);

    if (
      isSameWorkspacePath(typeof this.state.currentSession?.projectId === 'string' ? this.state.currentSession.projectId : undefined, oldFolder) ||
      isSameWorkspacePath(this.state.currentSession?.workingDirectory, oldFolder)
    ) {
      this.state.currentSession =
        this.state.sessions.find((session) => session.id === this.state.currentSession?.id) ?? this.state.currentSession;
      this.notify('currentSession', this.state.currentSession);
    }

    if (isSameWorkspacePath(this.state.workingDirectory, oldFolder)) {
      this.setState('workingDirectory', normalizedNewFolder);
    }
  }

  getProjectSessions(folder: string): Session[] {
    if (!folder) return [];
    return this.sortSessions(this.state.sessions.filter((session) => this.sessionBelongsToWorkspace(session, folder)));
  }

  getChildSessions(parentSessionId: string): Session[] {
    if (!parentSessionId) return [];
    return this.sortSessions(this.state.sessions.filter((session) => session.parentSessionId === parentSessionId));
  }

  /**
   * 获取所有会话（不再按 workMode 过滤，侧边栏统一显示所有会话）
   */
  getVisibleSessions(): Session[] {
    return this.sortSessions([...this.state.sessions]);
  }

  /**
   * 添加消息到当前会话
   */
  addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>, sessionId?: string | null): ChatMessage {
    let targetSession = this.getSession(sessionId ?? this.state.currentSessionId);
    if (!targetSession) {
      targetSession = this.createSession();
    }

    const newMessage: ChatMessage = {
      ...message,
      runId: message.runId,
      sessionId: targetSession.id,
      id: `msg-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
    };

    const updatedSession: Session = {
      ...targetSession,
      messages: [...targetSession.messages, newMessage],
      updatedAt: Date.now(),
    };
    if (message.role === 'user' && this.shouldReplaceSessionTitle(targetSession.title)) {
      updatedSession.title = this.titleFromPrompt(message.content);
    }

    this.notifySessionUpdated(updatedSession);
    return newMessage;
  }

  /**
   * 更新消息内容（用于流式更新）
   */
  updateMessage(messageId: string, updates: Partial<ChatMessage>, sessionId?: string | null): void {
    const targetSession = this.getSession(sessionId ?? this.state.currentSessionId);
    if (!targetSession) return;

    const messageIndex = targetSession.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;

    const messages = [...targetSession.messages];
    messages[messageIndex] = { ...messages[messageIndex], ...updates };
    this.notifySessionUpdated({
      ...targetSession,
      messages,
      updatedAt: Date.now(),
    });
  }

  updateSession(session: Session): void {
    this.notifySessionUpdated({
      ...session,
      messages: [...session.messages],
    });
  }

  clearSessionMessages(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    this.notifySessionUpdated({
      ...session,
      messages: [],
      updatedAt: Date.now(),
    });
  }

  registerRun(context: Omit<RunContext, 'status' | 'startedAt' | 'updatedAt'> & Partial<Pick<RunContext, 'status' | 'startedAt' | 'updatedAt'>>): RunContext {
    const now = Date.now();
    const runContext: RunContext = {
      ...context,
      model: context.model ?? this.state.providerConfig.model ?? this.state.model,
      status: context.status ?? 'running',
      startedAt: context.startedAt ?? now,
      updatedAt: context.updatedAt ?? now,
    };

    this.state.runContexts = {
      ...this.state.runContexts,
      [runContext.runId]: runContext,
    };
    this.notify('runContexts', this.state.runContexts);

    this.setState('activeRunId', runContext.runId);
    this.setState('activeRunSessionId', runContext.sessionId);
    this.setState('isStreaming', true);

    const session = this.getSession(runContext.sessionId);
    if (session) {
      session.activeRunId = runContext.runId;
      session.lastRunId = runContext.runId;
      session.updatedAt = now;
      this.notifySessionUpdated(session);
    }

    return runContext;
  }

  finishRun(runId: string | null | undefined, status: RunContext['status'] = 'completed'): void {
    if (!runId) return;

    const existing = this.state.runContexts[runId];
    const updatedAt = Date.now();
    if (existing) {
      this.state.runContexts = {
        ...this.state.runContexts,
        [runId]: {
          ...existing,
          status,
          updatedAt,
        },
      };
      this.notify('runContexts', this.state.runContexts);

      const session = this.getSession(existing.sessionId);
      if (session?.activeRunId === runId) {
        session.activeRunId = null;
        session.updatedAt = updatedAt;
        this.notifySessionUpdated(session);
      }
    }

    if (this.state.activeRunId === runId) {
      this.reconcileActiveRunState();
    }
  }

  getRunContext(runId?: string | null): RunContext | null {
    if (!runId) return null;
    return this.state.runContexts[runId] ?? null;
  }

  /**
   * 取消当前活跃的运行
   */
  async cancelRun(): Promise<void> {
    const runId = this.state.activeRunId;
    if (!runId) return;
    try {
      const { tauriBridge } = await import('./tauri-bridge');
      await tauriBridge.cancelRun(runId);
    } catch (error) {
      showToast('取消运行失败', 'error', 4500);
    }
    this.finishRun(runId, 'cancelled');
  }

  async refreshDaemonSessionsAfterAction(sessionId?: string | null): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    this.patchDaemonBrowser({ loadingSessions: true, error: null });
    try {
      const sessionList = await tauriBridge.listSessions();
      if (isBridgeDiagnostic(sessionList)) {
        throw new Error((sessionList as any).diagnostic?.message ?? '后端通信异常');
      }
      const sessions = (sessionList as any).sessions as any[];
      const summaries = ((sessionList as any).summaries ?? []) as any[];
      this.setDaemonSessions(sessions, summaries);
      const selected =
        (sessionId && sessions.some((session: any) => session.id === sessionId)
          ? sessionId
          : this.preferredDaemonSessionId(sessions)) ?? sessions[0]?.id;
      if (selected) {
        await this.refreshDaemonSessionDetail(selected, { activate: this.state.currentSessionId === selected });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patchDaemonBrowser({ error: message });
      throw error;
    } finally {
      this.patchDaemonBrowser({ loadingSessions: false });
    }
  }

  resolveRunSessionId(runId?: string | null, fallbackSessionId?: string | null): string | null {
    if (runId && this.state.runContexts[runId]) {
      return this.state.runContexts[runId].sessionId;
    }
    return fallbackSessionId ?? this.state.currentSessionId;
  }

  patchDaemonBrowser(patch: Partial<DaemonBrowserState>): void {
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      ...patch,
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  private setDaemonBrowserError(message: string): void {
    this.patchDaemonBrowser({ error: message });
  }

  recordDaemonListLoad(
    scope: DaemonListLoadDiagnostics['scope'],
    requestMs: number,
    count: number,
    targetId?: string
  ): void {
    const diagnostic: DaemonListLoadDiagnostics = {
      scope,
      ...(targetId ? { targetId } : {}),
      requestMs,
      count,
      loadedAt: Date.now(),
    };
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        ...(scope === 'sessions' ? { lastSessionListLoad: diagnostic } : { lastRunListLoad: diagnostic }),
      },
      lastLoadedAt: Date.now(),
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  setDaemonSessions(records: DaemonSessionRecord[], summaries: DaemonSessionSummary[] = []): void {
    const sessionSummaries = this.mergeSessionSummaries(records, summaries);
    const sessions = [...records].sort(
      (a, b) => this.sessionSortTimestamp(b, sessionSummaries) - this.sessionSortTimestamp(a, sessionSummaries)
    );
    const recordIds = new Set(sessions.map((record) => record.id));
    const existingById = new Map(this.state.sessions.map((session) => [session.id, session]));
    const projected = sessions.map((record) =>
      this.projectDaemonSession(record, existingById.get(record.id), sessionSummaries[record.id])
    );
    const localOnly = this.state.sessions.filter((session) => !recordIds.has(session.id) && !session.daemonRecord);

    this.state.sessions = [...projected, ...localOnly];

    const nextFolders = [...this.state.openedFolders];
    for (const record of sessions) {
      if (record.cwd && !nextFolders.some((folder) => isSameWorkspacePath(folder, record.cwd))) {
        nextFolders.push(record.cwd);
      }
    }
    const uniqueFolders = this.uniqueWorkspaceFolders(nextFolders);
    if (
      uniqueFolders.length !== this.state.openedFolders.length ||
      uniqueFolders.some((folder, index) => folder !== this.state.openedFolders[index])
    ) {
      this.state.openedFolders = uniqueFolders;
      this.notify('openedFolders', this.state.openedFolders);
    }

    const selectedSessionId = this.preferredDaemonSessionId(sessions) ?? sessions[0]?.id ?? null;

    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      sessions,
      sessionSummaries,
      selectedSessionId,
      selectedRunId: this.state.daemonBrowser.selectedRunId,
      error: null,
      lastLoadedAt: Date.now(),
    };

    const selectedProjected = selectedSessionId
      ? projected.find((session) => session.id === selectedSessionId) ?? null
      : null;
    const current = this.state.currentSessionId
      ? this.state.sessions.find((session) => session.id === this.state.currentSessionId) ?? null
      : this.state.currentSession;
    const currentIsEmptyLocal =
      current && !current.daemonRecord && current.messages.length === 0 && !current.activeRunId;
    const nextCurrent = (!current || currentIsEmptyLocal) && selectedProjected ? selectedProjected : current;
    this.state.currentSession = nextCurrent;
    this.state.currentSessionId = nextCurrent?.id ?? null;
    if (!this.state.workingDirectory && nextCurrent?.workingDirectory) {
      this.state.workingDirectory = nextCurrent.workingDirectory;
      this.notify('workingDirectory', this.state.workingDirectory);
    }
    this.notify('sessions', this.state.sessions);
    this.notify('currentSession', this.state.currentSession);
    this.notify('currentSessionId', this.state.currentSessionId);
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  setDaemonRuns(sessionId: string, records: DaemonRunRecord[]): void {
    const runs = [...records].sort((a, b) => this.parseIso(b.updatedAt) - this.parseIso(a.updatedAt));
    const runContexts = { ...this.state.runContexts };
    for (const run of runs) {
      runContexts[run.id] = {
        runId: run.id,
        sessionId: run.sessionId,
        prompt: this.metadataString(run.metadata, 'prompt') ?? '',
        mode: this.metadataString(run.metadata, 'mode'),
        model: this.metadataString(run.metadata, 'model') ?? this.state.providerConfig.model ?? this.state.model,
        cwd: run.cwd,
        permissionMode: this.permissionModeFromMetadata(run.metadata),
        status: this.runContextStatus(run.status),
        startedAt: this.parseIso(run.startedAt ?? run.createdAt),
        updatedAt: this.parseIso(run.updatedAt),
      };
    }
    this.state.runContexts = runContexts;

    const selectedRunId =
      this.state.daemonBrowser.selectedSessionId === sessionId
        ? runs[0]?.id ?? null
        : this.state.daemonBrowser.selectedRunId;
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      runsBySessionId: {
        ...this.state.daemonBrowser.runsBySessionId,
        [sessionId]: runs,
      },
      selectedRunId,
      error: null,
      lastLoadedAt: Date.now(),
    };

    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (session) {
      const newestRun = runs[0];
      session.lastRunId = newestRun?.id ?? session.lastRunId ?? null;
      session.activeRunId = runs.find((run) => this.isActiveDaemonRun(run.status))?.id ?? null;
      const title = newestRun ? this.titleForDaemonRun(newestRun) : null;
      if (title && this.shouldReplaceSessionTitle(session.title)) {
        session.title = title;
      }
      session.updatedAt = Math.max(session.updatedAt, ...runs.map((run) => this.parseIso(run.updatedAt)));
    }

    this.notify('runContexts', this.state.runContexts);
    this.notify('sessions', this.state.sessions);
    if (this.state.currentSessionId === sessionId) {
      this.state.currentSession = session ?? null;
      this.notify('currentSession', this.state.currentSession);
    }
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  setDaemonSessionEvents(
    sessionId: string,
    events: DaemonOrchestratorEvent[],
    eventLog: DaemonEventLogMetadata,
    nextAfterSequence: number,
    hasMore?: boolean,
    diagnostics?: DaemonEventSliceDiagnosticsInput
  ): void {
    const hasMoreValue = hasMore ?? events.length > 0;
    const sliceDiagnostics = this.buildEventSliceDiagnostics('session', sessionId, undefined, events, events, nextAfterSequence, diagnostics);
    this.resetDaemonSessionHydration(sessionId);
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      sessionEventsBySessionId: {
        ...this.state.daemonBrowser.sessionEventsBySessionId,
        [sessionId]: {
          events,
          nextAfterSequence,
          hasMore: hasMoreValue,
          ...(diagnostics?.nextCursor ? { nextCursor: diagnostics.nextCursor } : {}),
          loadedAt: Date.now(),
          diagnostics: sliceDiagnostics,
        },
      },
      error: null,
      lastLoadedAt: Date.now(),
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        lastEventLoad: sliceDiagnostics,
      },
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
    persistSessionCursor(
      sessionId,
      eventLog,
      diagnostics?.nextCursor?.afterSequence ?? nextAfterSequence,
      diagnostics?.nextCursor?.lastEventId ?? events.at(-1)?.id
    );
  }

  appendDaemonSessionEvents(
    sessionId: string,
    events: DaemonOrchestratorEvent[],
    eventLog: DaemonEventLogMetadata,
    nextAfterSequence: number,
    hasMore?: boolean,
    diagnostics?: DaemonEventSliceDiagnosticsInput
  ): void {
    const existing = this.state.daemonBrowser.sessionEventsBySessionId[sessionId];
    const hasMoreValue = hasMore ?? events.length > 0;
    const mergedEvents = existing ? this.mergeDaemonEvents(existing.events, events) : events;
    const sliceDiagnostics = this.buildEventSliceDiagnostics('session', sessionId, existing?.events, events, mergedEvents, nextAfterSequence, diagnostics);
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      sessionEventsBySessionId: {
        ...this.state.daemonBrowser.sessionEventsBySessionId,
        [sessionId]: {
          events: mergedEvents,
          nextAfterSequence,
          hasMore: hasMoreValue,
          ...(diagnostics?.nextCursor ? { nextCursor: diagnostics.nextCursor } : existing?.nextCursor ? { nextCursor: existing.nextCursor } : {}),
          loadedAt: Date.now(),
          diagnostics: sliceDiagnostics,
        },
      },
      error: null,
      lastLoadedAt: Date.now(),
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        lastEventLoad: sliceDiagnostics,
      },
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
    persistSessionCursor(
      sessionId,
      eventLog,
      diagnostics?.nextCursor?.afterSequence ?? nextAfterSequence,
      diagnostics?.nextCursor?.lastEventId ?? events.at(-1)?.id
    );
  }

  setDaemonRunEvents(
    runId: string,
    events: DaemonOrchestratorEvent[],
    eventLog: DaemonEventLogMetadata,
    nextAfterSequence: number,
    snapshot?: DaemonTaskSnapshot | null,
    hasMore?: boolean,
    diagnostics?: DaemonEventSliceDiagnosticsInput
  ): void {
    const hasMoreValue = hasMore ?? events.length > 0;
    const sessionId = this.sessionIdForRunEvents(runId, events, snapshot);
    const sliceDiagnostics = this.buildEventSliceDiagnostics('run', runId, undefined, events, events, nextAfterSequence, diagnostics);
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      runEventsByRunId: {
        ...this.state.daemonBrowser.runEventsByRunId,
        [runId]: {
          events,
          nextAfterSequence,
          hasMore: hasMoreValue,
          ...(diagnostics?.nextCursor ? { nextCursor: diagnostics.nextCursor } : {}),
          loadedAt: Date.now(),
          sessionId,
          diagnostics: sliceDiagnostics,
        },
      },
      error: null,
      lastLoadedAt: Date.now(),
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        lastEventLoad: sliceDiagnostics,
      },
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
    persistRunCursor(
      runId,
      eventLog,
      diagnostics?.nextCursor?.afterSequence ?? nextAfterSequence,
      diagnostics?.nextCursor?.lastEventId ?? events.at(-1)?.id
    );
    if (snapshot) {
      this.applyDaemonTaskSnapshot(snapshot);
    }
    if (sessionId) {
      this.hydrateSessionFromDaemonEvents(sessionId, events);
    }
  }

  appendDaemonRunEvents(
    runId: string,
    events: DaemonOrchestratorEvent[],
    eventLog: DaemonEventLogMetadata,
    nextAfterSequence: number,
    hasMore?: boolean,
    diagnostics?: DaemonEventSliceDiagnosticsInput
  ): void {
    const existing = this.state.daemonBrowser.runEventsByRunId[runId];
    const hasMoreValue = hasMore ?? events.length > 0;
    const sessionId = this.sessionIdForRunEvents(runId, events) ?? existing?.sessionId;
    const mergedEvents = existing ? this.mergeDaemonEvents(existing.events, events) : events;
    const sliceDiagnostics = this.buildEventSliceDiagnostics('run', runId, existing?.events, events, mergedEvents, nextAfterSequence, diagnostics);
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      runEventsByRunId: {
        ...this.state.daemonBrowser.runEventsByRunId,
        [runId]: {
          events: mergedEvents,
          nextAfterSequence,
          hasMore: hasMoreValue,
          ...(diagnostics?.nextCursor ? { nextCursor: diagnostics.nextCursor } : existing?.nextCursor ? { nextCursor: existing.nextCursor } : {}),
          loadedAt: Date.now(),
          sessionId,
          diagnostics: sliceDiagnostics,
        },
      },
      error: null,
      lastLoadedAt: Date.now(),
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        lastEventLoad: sliceDiagnostics,
      },
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
    persistRunCursor(
      runId,
      eventLog,
      diagnostics?.nextCursor?.afterSequence ?? nextAfterSequence,
      diagnostics?.nextCursor?.lastEventId ?? events.at(-1)?.id
    );
    if (sessionId) {
      this.hydrateSessionFromDaemonEvents(sessionId, events);
    }
  }

  applyDaemonRunEventsResponse(response: DaemonRunEventsResponse): void {
    const hasMore = response.hasMore ?? response.diagnostics?.truncated === true;
    this.setDaemonRunEvents(response.runId, response.events, response.eventLog, response.nextAfterSequence, response.snapshot ?? null, hasMore, {
      backend: response.diagnostics,
      nextCursor: response.nextCursor,
      hasMore,
    });
  }

  replaceTaskSnapshot(snapshot: TaskSnapshot | DaemonTaskSnapshot | null): TaskSnapshot | null {
    if (!snapshot) {
      this.state.taskSnapshot = null;
      this.notify('taskSnapshot', this.state.taskSnapshot);
      return null;
    }

    if (isDaemonTaskSnapshot(snapshot)) {
      return this.applyDaemonTaskSnapshot(snapshot);
    }

    this.state.taskSnapshot = snapshot;
    this.syncRunContextFromTaskSnapshot(snapshot);
    this.notify('taskSnapshot', this.state.taskSnapshot);
    return snapshot;
  }

  mergeTaskSnapshot(patch: Partial<TaskSnapshot> | DaemonTaskSnapshot): TaskSnapshot | null {
    if (isDaemonTaskSnapshot(patch)) {
      return this.applyDaemonTaskSnapshot(patch);
    }
    const current = this.state.taskSnapshot;
    if (!current) return null;
    const next: TaskSnapshot = {
      ...current,
      ...patch,
      project: patch.project ? { ...current.project, ...patch.project } : current.project,
      health: patch.health ? { ...current.health, ...patch.health } : current.health,
      longRun: patch.longRun ? { ...current.longRun, ...patch.longRun } : current.longRun,
    };
    return this.replaceTaskSnapshot(next);
  }

  replaceProviderConfig(
    snapshot: WorkbenchProviderConfigSnapshot | DaemonProviderStatusSnapshot
  ): WorkbenchProviderConfigSnapshot {
    const next = isDaemonProviderStatusSnapshot(snapshot)
      ? projectDaemonProviderStatusToWorkbench(snapshot, this.state.providerConfig)
      : snapshot;
    this.state.providerConfig = next;
    this.notify('providerConfig', this.state.providerConfig);
    if (next.model && next.model !== this.state.model) {
      this.state.model = next.model;
      this.notify('model', this.state.model);
    }
    return next;
  }

  applyDaemonProviderStatus(status: DaemonProviderStatusSnapshot): WorkbenchProviderConfigSnapshot {
    return this.replaceProviderConfig(status);
  }

  applyWorkbenchStatus(status: WorkbenchStatus): WorkbenchProviderConfigSnapshot | null {
    this.state.daemonStatus = status;
    this.notify('daemonStatus', this.state.daemonStatus);
    if (status.providerStatus) return this.replaceProviderConfig(status.providerStatus);
    if (status.providerConfig) return this.replaceProviderConfig(status.providerConfig);
    return null;
  }

  applyDaemonTaskSnapshot(snapshot: DaemonTaskSnapshot): TaskSnapshot {
    const projected = projectDaemonTaskSnapshotToWorkbench(snapshot, {
      previous: this.state.taskSnapshot,
    });
    this.state.taskSnapshot = projected;
    this.syncRunContextFromDaemonSnapshot(snapshot);
    this.hydrateSessionFromDaemonSnapshot(snapshot);
    this.notify('taskSnapshot', this.state.taskSnapshot);
    return projected;
  }

  selectDaemonSession(sessionId: string, options: { activate?: boolean } = {}): void {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      selectedSessionId: sessionId,
      selectedRunId: this.state.daemonBrowser.runsBySessionId[sessionId]?.[0]?.id ?? null,
      error: null,
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
    if (session && options.activate) {
      if (session.workingDirectory) {
        this.addOpenedFolder(session.workingDirectory);
        this.setState('workingDirectory', session.workingDirectory);
      }
      this.setCurrentSessionValue(session);
    }
  }

  selectDaemonRun(runId: string | null): void {
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      selectedRunId: runId,
      error: null,
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  /** 读取持久化的 Session 事件游标（断线续播） */
  getPersistedSessionCursor(sessionId: string): DaemonEventReplayCursor | null {
    return readSessionCursor(sessionId);
  }

  /** 读取持久化的 Run 事件游标（断线续播） */
  getPersistedRunCursor(runId: string): DaemonEventReplayCursor | null {
    return readRunCursor(runId);
  }

  /** 清除所有事件游标 */
  clearAllEventCursors(): void {
    clearEventCursors();
  }

  hydrateSessionFromDaemonEvents(
    sessionId: string,
    events: DaemonOrchestratorEvent[],
    options: { activate?: boolean } = {}
  ): void {
    const projection = this.messagesFromDaemonEvents(sessionId, events);
    this.updateLastEventLoadHydrationDiagnostics(sessionId, projection?.messages.length, projection?.dedupedCount);
    if (!projection) return;
    const { messages } = projection;
    const existing = this.getSession(sessionId);
    const record = this.state.daemonBrowser.sessions.find((session) => session.id === sessionId);
    const session =
      existing ??
      (record
        ? this.projectDaemonSession(record, undefined, this.state.daemonBrowser.sessionSummaries[sessionId])
        : {
            id: sessionId,
            title: `Session ${this.shortId(sessionId)}`,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            projectId: null,
          });

    const projectedRunIds = new Set(messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)));
    const preservedMessages = session.messages.filter(
      (message) =>
        (message.sessionId !== undefined && message.sessionId !== sessionId) ||
        (message.runId !== undefined && !projectedRunIds.has(message.runId))
    );

    const updatedSession: Session = {
      ...session,
      messages: [...preservedMessages, ...messages].sort((a, b) => a.timestamp - b.timestamp),
      updatedAt: Date.now(),
    };
    this.notifySessionUpdated(updatedSession);
    if (options.activate) {
      this.setCurrentSessionValue(updatedSession);
    }
  }

  hydrateSessionFromDaemonSnapshot(snapshot: DaemonTaskSnapshot): void {
    const existing = this.getSession(snapshot.sessionId);
    const record = this.state.daemonBrowser.sessions.find((session) => session.id === snapshot.sessionId);
    const updatedAt = this.parseIso(snapshot.updatedAt);
    const workspaceMode = this.metadataString(snapshot.currentRun.metadata, 'workspaceMode');
    const projectId = workspaceMode === 'none' ? null : snapshot.currentRun.cwd || null;
    const session =
      existing ??
      (record
        ? this.projectDaemonSession(record, undefined, this.state.daemonBrowser.sessionSummaries[snapshot.sessionId])
        : {
            id: snapshot.sessionId,
            title: snapshot.title || `Session ${this.shortId(snapshot.sessionId)}`,
            messages: [],
            createdAt: this.parseIso(snapshot.currentRun.createdAt),
            updatedAt,
            ...(projectId ? { workingDirectory: projectId } : {}),
            projectId,
          });

    const snapshotMessages = snapshot.messages.map((message) => this.messageFromDaemonSnapshot(message, snapshot));
    const preservedMessages = session.messages.filter(
      (message) =>
        (message.sessionId !== undefined && message.sessionId !== snapshot.sessionId) ||
        (message.runId !== undefined && message.runId !== snapshot.runId)
    );
    const updatedSession: Session = {
      ...session,
      messages: [...preservedMessages, ...snapshotMessages].sort((a, b) => a.timestamp - b.timestamp),
      updatedAt,
      projectId,
    };
    if (projectId) {
      updatedSession.workingDirectory = projectId;
    } else {
      delete updatedSession.workingDirectory;
    }
    updatedSession.lastRunId = snapshot.runId;
    updatedSession.activeRunId = this.isActiveDaemonRun(snapshot.status) ? snapshot.runId : null;
    if (this.shouldReplaceSessionTitle(updatedSession.title) && snapshot.title) {
      updatedSession.title = snapshot.title;
    }

    this.notifySessionUpdated(updatedSession);
    if (!this.state.currentSessionId || this.state.currentSessionId === snapshot.sessionId) {
      this.setCurrentSessionValue(updatedSession);
    }
  }

  async ensureDaemonSessionDetail(
    sessionId: string,
    options: { activate?: boolean } = {}
  ): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    const cached = this.state.daemonBrowser.sessionEventsBySessionId[sessionId];
    if (cached?.events.length) {
      this.hydrateSessionFromDaemonEvents(sessionId, cached.events, { activate: options.activate });
    }

    const currentMessages = this.getSession(sessionId)?.messages.length ?? 0;
    const needsFullReplay = currentMessages === 0 && !cached?.events.length;
    const cursor = needsFullReplay ? null : this.getPersistedSessionCursor(sessionId);
    const response = await tauriBridge.readSessionEvents({
      sessionId,
      afterSequence: needsFullReplay ? 0 : cursor?.afterSequence ?? cached?.nextAfterSequence ?? 0,
      maxEvents: DAEMON_SESSION_SWITCH_EVENT_PAGE_SIZE,
      cursor: cursor ?? undefined,
    });
    this.applySessionEventsResponse(sessionId, response, {
      fullReplay: needsFullReplay || (response.afterSequence ?? 0) === 0 || Boolean(response.cursorDiagnostic),
      activate: options.activate,
      mode: response.cursorDiagnostic ? 'full-replay' : needsFullReplay ? 'full-replay' : 'incremental',
    });

    const hydratedMessages = this.getSession(sessionId)?.messages.length ?? 0;
    if (hydratedMessages > 0 || needsFullReplay || response.events.length > 0) return;

    const replay = await tauriBridge.readSessionEvents({
      sessionId,
      afterSequence: 0,
      maxEvents: DAEMON_SESSION_SWITCH_EVENT_PAGE_SIZE,
    });
    this.applySessionEventsResponse(sessionId, replay, {
      fullReplay: true,
      activate: options.activate,
      mode: 'full-replay',
    });
  }

  async refreshDaemonSessionDetail(
    sessionId: string,
    options: { activate?: boolean; loadRuns?: boolean } = {}
  ): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    this.selectDaemonSession(sessionId, { activate: options.activate });
    if (options.loadRuns !== false) {
      this.patchDaemonBrowser({ loadingRuns: true });
      try {
        this.setDaemonRuns(sessionId, await tauriBridge.listRuns(sessionId));
      } finally {
        this.patchDaemonBrowser({ loadingRuns: false });
      }
    }
    await this.ensureDaemonSessionDetail(sessionId, { activate: options.activate });
    await this.syncPendingInputs(sessionId);
  }

  private applySessionEventsResponse(
    sessionId: string,
    response: Awaited<ReturnType<typeof import('./tauri-bridge').tauriBridge.readSessionEvents>>,
    options: { fullReplay: boolean; activate?: boolean; mode: DaemonEventSliceDiagnostics['mode'] }
  ): void {
    const hasMore = response.hasMore ?? response.diagnostics?.truncated === true;
    const diagnostics = {
      backend: response.diagnostics,
      nextCursor: response.nextCursor,
      hasMore,
      mode: options.mode,
    };
    if (options.fullReplay) {
      this.setDaemonSessionEvents(sessionId, response.events, response.eventLog, response.nextAfterSequence, hasMore, diagnostics);
    } else {
      this.appendDaemonSessionEvents(sessionId, response.events, response.eventLog, response.nextAfterSequence, hasMore, diagnostics);
    }
    this.hydrateSessionFromDaemonEvents(sessionId, response.events, { activate: options.activate });
  }

  /**
   * 切换会话
   */
  async switchSession(sessionId: string): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (session) {
      if (session.projectId !== null) {
        const cwd = session.workingDirectory || (typeof session.projectId === 'string' ? session.projectId : '');
        if (cwd) {
          this.setState('workingDirectory', cwd);
        }
      }
      this.setCurrentSessionValue(session);
      if (session.daemonRecord) {
        try {
          await this.refreshDaemonSessionDetail(sessionId, { activate: true });
        } catch (e) {
          this.patchDaemonBrowser({ error: e instanceof Error ? e.message : String(e) });
          showToast('加载会话事件失败: ' + (e instanceof Error ? e.message : String(e)), 'error');
        }
      }
    }
  }

  /**
   * 清除当前会话
   */
  clearCurrentSession(): void {
    this.setState('currentSession', null);
  }

  private notifySessionUpdated(session: Session): void {
    const nextSession: Session = {
      ...session,
      messages: [...session.messages],
    };
    const index = this.state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) {
      this.state.sessions = this.state.sessions.map((item, itemIndex) => (itemIndex === index ? nextSession : item));
    } else {
      this.state.sessions = [nextSession, ...this.state.sessions];
    }

    if (this.state.currentSessionId === session.id) {
      this.state.currentSession = nextSession;
      this.notify('currentSession', nextSession);
    }
    this.notify('sessions', this.state.sessions);
  }

  private notify(key: SubscribableKey, value: unknown): void {
    const listeners = this.listeners.get(key);
    if (listeners) {
      listeners.forEach((listener) => listener(value));
    }
  }

  private syncRunContextFromDaemonSnapshot(snapshot: DaemonTaskSnapshot): void {
    const existing = this.state.runContexts[snapshot.runId];
    const updated: RunContext = {
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      prompt: this.metadataString(snapshot.currentRun.metadata, 'prompt') ?? existing?.prompt ?? snapshot.title,
      mode: this.metadataString(snapshot.currentRun.metadata, 'mode') ?? existing?.mode,
      model: this.metadataString(snapshot.currentRun.metadata, 'model') ?? existing?.model ?? this.state.providerConfig.model ?? this.state.model,
      cwd: snapshot.currentRun.cwd || existing?.cwd,
      permissionMode: this.permissionModeFromMetadata(snapshot.currentRun.metadata) ?? existing?.permissionMode,
      status: this.runContextStatus(snapshot.status),
      startedAt: this.parseIso(snapshot.currentRun.startedAt ?? snapshot.currentRun.createdAt),
      updatedAt: this.parseIso(snapshot.updatedAt),
    };
    this.state.runContexts = {
      ...this.state.runContexts,
      [snapshot.runId]: updated,
    };
    this.notify('runContexts', this.state.runContexts);
    this.setActiveRunFromDaemonSnapshot(snapshot);
  }

  private syncRunContextFromTaskSnapshot(snapshot: TaskSnapshot): void {
    const runId = snapshot.id;
    const existing = this.state.runContexts[runId];
    if (!existing && runId === 'local-session') return;

    const sessionId = existing?.sessionId ?? this.state.activeRunSessionId ?? this.state.currentSessionId ?? snapshot.project.id;
    if (!sessionId) return;

    const updated: RunContext = {
      runId,
      sessionId,
      prompt: snapshot.userGoal,
      mode: snapshot.mode,
      model: existing?.model ?? this.state.providerConfig.model ?? this.state.model,
      cwd: snapshot.project.path,
      permissionMode: existing?.permissionMode,
      status: this.runContextStatusFromTaskSnapshot(snapshot),
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: snapshot.project.updatedAt || Date.now(),
    };
    this.state.runContexts = {
      ...this.state.runContexts,
      [runId]: updated,
    };
    this.notify('runContexts', this.state.runContexts);

    if (updated.status === 'running') {
      this.setState('activeRunId', runId);
      this.setState('activeRunSessionId', sessionId);
      this.setState('isStreaming', true);
    } else if (this.state.activeRunId === runId) {
      this.reconcileActiveRunState();
    }
  }

  private setActiveRunFromDaemonSnapshot(snapshot: DaemonTaskSnapshot): void {
    if (this.isActiveDaemonRun(snapshot.status)) {
      this.setState('activeRunId', snapshot.runId);
      this.setState('activeRunSessionId', snapshot.sessionId);
      this.setState('isStreaming', true);
      return;
    }
    if (this.state.activeRunId === snapshot.runId) {
      this.reconcileActiveRunState();
    }
  }

  private reconcileActiveRunState(preferredRunId?: string | null): void {
    const runningContexts = Object.values(this.state.runContexts)
      .filter((context) => context.status === 'running')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const preferred = preferredRunId
      ? runningContexts.find((context) => context.runId === preferredRunId)
      : undefined;
    const currentSessionRun = this.state.currentSessionId
      ? runningContexts.find((context) => context.sessionId === this.state.currentSessionId)
      : undefined;
    const next = preferred ?? currentSessionRun ?? runningContexts[0] ?? null;

    if (next) {
      this.setState('activeRunId', next.runId);
      this.setState('activeRunSessionId', next.sessionId);
      this.setState('isStreaming', true);
      return;
    }

    this.setState('activeRunId', null);
    this.setState('activeRunSessionId', null);
    this.setState('isStreaming', false);
  }

  private runContextStatusFromTaskSnapshot(snapshot: TaskSnapshot): RunContext['status'] {
    if (snapshot.state === 'done') return 'completed';
    if (snapshot.state === 'blocked') return 'failed';
    return 'running';
  }

  private mergeSessionSummaries(
    records: DaemonSessionRecord[],
    summaries: DaemonSessionSummary[]
  ): Record<string, DaemonSessionSummary> {
    const previous = this.state.daemonBrowser.sessionSummaries;
    const output: Record<string, DaemonSessionSummary> = {};
    const recordIds = new Set(records.map((record) => record.id));
    for (const record of records) {
      const summary = summaries.find((item) => item.sessionId === record.id) ?? previous[record.id];
      output[record.id] =
        summary ??
        {
          sessionId: record.id,
          lastUpdated: record.updatedAt,
          eventCount: 0,
          runCount: 0,
        };
    }
    for (const summary of summaries) {
      if (recordIds.has(summary.sessionId)) output[summary.sessionId] = summary;
    }
    return output;
  }

  private sessionSortTimestamp(record: DaemonSessionRecord, summaries: Record<string, DaemonSessionSummary>): number {
    return this.parseIso(summaries[record.id]?.lastUpdated ?? record.updatedAt);
  }

  private preferredDaemonSessionId(records: DaemonSessionRecord[]): string | null {
    if (records.length === 0) return null;
    const ids = new Set(records.map((record) => record.id));
    if (this.workMode === 'agent' && this.state.workingDirectory) {
      const matching = records.find((record) => isSameWorkspacePath(record.cwd, this.state.workingDirectory));
      if (matching) return matching.id;
    }
    const currentSelection = this.state.daemonBrowser.selectedSessionId;
    if (currentSelection && ids.has(currentSelection)) return currentSelection;
    const currentSessionId = this.state.currentSessionId;
    if (currentSessionId && ids.has(currentSessionId)) return currentSessionId;
    if (this.state.workingDirectory) {
      const matching = records.find((record) => isSameWorkspacePath(record.cwd, this.state.workingDirectory));
      if (matching) return matching.id;
    }
    return null;
  }

  private uniqueWorkspaceFolders(folders: string[]): string[] {
    const output: string[] = [];
    for (const folder of folders) {
      const trimmed = folder.trim();
      if (!trimmed) continue;
      if (!output.some((existing) => isSameWorkspacePath(existing, trimmed))) {
        output.push(trimmed);
      }
    }
    return output;
  }

  private sessionIsNoProject(session: Session): boolean {
    const projectId = typeof session.projectId === 'string' ? session.projectId : '';
    return session.projectId === null || (!projectId && !session.workingDirectory);
  }

  private sessionBelongsToWorkspace(session: Session, folder: string): boolean {
    return (
      isSameWorkspacePath(session.workingDirectory, folder) ||
      isSameWorkspacePath(typeof session.projectId === 'string' ? session.projectId : undefined, folder) ||
      isSameWorkspacePath(session.daemonRecord?.cwd, folder)
    );
  }

  private sortSessions(sessions: Session[]): Session[] {
    return [...sessions].sort((a, b) => {
      const pa = a.daemonRecord?.metadata?.pinned === true ? 1 : 0;
      const pb = b.daemonRecord?.metadata?.pinned === true ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  }

  private projectDaemonSession(
    record: DaemonSessionRecord,
    existing?: Session,
    summary?: DaemonSessionSummary
  ): Session {
    const workspaceMode = this.metadataString(record.metadata, 'workspaceMode');
    const projectId = workspaceMode === 'none' ? null : record.cwd || null;
    const parentSessionId = this.metadataString(record.metadata, 'parentSessionId') ?? this.metadataString(record.metadata, 'parent_session_id');
    const parentRunId = this.metadataString(record.metadata, 'parentRunId') ?? this.metadataString(record.metadata, 'parent_run_id');
    const parentMessageId =
      this.metadataString(record.metadata, 'parentMessageId') ?? this.metadataString(record.metadata, 'parent_message_id');
    const lineageKind = this.lineageKindFromMetadata(record.metadata, parentSessionId);
    const summaryActiveRunId = summary?.activeRunIds?.[0] ?? null;
    const summaryLatestRunId = summary?.latestRunId ?? null;
    return {
      id: record.id,
      title: this.titleForDaemonSession(record, existing),
      messages: existing?.messages ?? [],
      createdAt: this.parseIso(record.createdAt),
      updatedAt: this.parseIso(summary?.lastUpdated ?? record.updatedAt),
      ...(projectId ? { workingDirectory: projectId } : {}),
      activeRunId: summaryActiveRunId ?? existing?.activeRunId ?? null,
      lastRunId: summaryLatestRunId ?? existing?.lastRunId ?? null,
      daemonRecord: record,
      daemonSummary: summary,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
      lineageKind,
      projectId,
    };
  }

  private lineageKindFromMetadata(
    metadata: Record<string, unknown> | undefined | null,
    parentSessionId?: string
  ): Session['lineageKind'] {
    const raw = this.metadataString(metadata, 'lineageKind') ?? this.metadataString(metadata, 'lineage_kind');
    if (raw === 'fork' || raw === 'subagent' || raw === 'root') return raw;
    return parentSessionId ? 'subagent' : 'root';
  }

  private titleForDaemonSession(record: DaemonSessionRecord, existing?: Session): string {
    const metadataTitle = this.metadataString(record.metadata, 'title');
    if (metadataTitle) return metadataTitle;
    if (existing && !this.shouldReplaceSessionTitle(existing.title)) return existing.title;
    if (this.metadataString(record.metadata, 'workspaceMode') === 'none') {
      return `Session ${this.shortId(record.id)}`;
    }
    const folder = this.basename(record.cwd);
    return folder ? `${folder} session` : `Session ${this.shortId(record.id)}`;
  }

  private titleForDaemonRun(run: DaemonRunRecord): string | null {
    const prompt = this.metadataString(run.metadata, 'prompt');
    if (prompt) return this.titleFromPrompt(prompt);
    return run.id ? `Run ${this.shortId(run.id)}` : null;
  }

  private titleFromPrompt(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    if (!normalized) return '新对话';
    return normalized.length > 42 ? `${normalized.slice(0, 42)}...` : normalized;
  }

  private shouldReplaceSessionTitle(title: string): boolean {
    return (
      !title ||
      title === 'New chat' ||
      title.startsWith('Session ') ||
      title.endsWith(' session') ||
      title.includes('\u65b0\u5bf9\u8bdd')
    );
  }

  private runContextStatus(status: DaemonRunStatus): RunContext['status'] {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      case 'failed':
        return 'failed';
      case 'queued':
      case 'running':
      case 'awaiting-approval':
      case 'cancelling':
      default:
        return 'running';
    }
  }

  private isActiveDaemonRun(status: DaemonRunStatus): boolean {
    return status === 'queued' || status === 'running' || status === 'awaiting-approval' || status === 'cancelling';
  }

  private pendingInputIntentFromDaemon(record: DaemonPendingInputRecord): PendingInputIntent {
    return {
      id: record.id,
      sessionId: record.sessionId,
      runId: record.runId ?? null,
      text: record.text,
      mode: record.mode,
      createdAt: this.parseIso(record.createdAt),
    };
  }

  private upsertPendingInputIntent(intent: PendingInputIntent): void {
    const existingIndex = this.state.pendingInputs.findIndex((item) => item.id === intent.id);
    const next = [...this.state.pendingInputs];
    if (existingIndex >= 0) {
      next[existingIndex] = intent;
    } else {
      next.push(intent);
    }
    this.setState('pendingInputs', this.dedupePendingInputs(next).sort((left, right) => left.createdAt - right.createdAt));
  }

  private dedupePendingInputs(inputs: PendingInputIntent[]): PendingInputIntent[] {
    const byId = new Map<string, PendingInputIntent>();
    for (const input of inputs) {
      byId.set(input.id, input);
    }
    return [...byId.values()];
  }

  private async persistPendingInputIntent(intent: PendingInputIntent): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    const sessionId = intent.sessionId ?? this.state.currentSessionId;
    if (!sessionId) return;
    const result = await tauriBridge.enqueuePendingInput({
      inputId: intent.id,
      sessionId,
      ...(intent.runId ? { runId: intent.runId } : {}),
      text: intent.text,
      mode: intent.mode,
      source: 'workbench',
    });
    if (isBridgeDiagnostic(result)) {
      this.setDaemonBrowserError((result as any).diagnostic?.message ?? '后端通信异常');
      return;
    }
    this.upsertPendingInputIntent(this.pendingInputIntentFromDaemon(result.input));
  }

  private async cancelDaemonPendingInput(intent: PendingInputIntent): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    const result = await tauriBridge.cancelPendingInput({
      inputId: intent.id,
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      reason: 'user-cancelled',
    });
    if (isBridgeDiagnostic(result)) {
      this.setDaemonBrowserError((result as any).diagnostic?.message ?? '后端通信异常');
      this.upsertPendingInputIntent(intent);
    }
  }

  private async dispatchDaemonPendingInput(intent: PendingInputIntent, targetRunId?: string | null): Promise<void> {
    const { tauriBridge } = await import('./tauri-bridge');
    const result = await tauriBridge.dispatchPendingInput({
      inputId: intent.id,
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(targetRunId ? { targetRunId } : {}),
    });
    if (isBridgeDiagnostic(result)) {
      this.setDaemonBrowserError((result as any).diagnostic?.message ?? '后端通信异常');
      this.upsertPendingInputIntent(intent);
    }
  }

  private workspaceContextForSession(session: Session | null | undefined): ConversationWorkspaceContext {
    if (!session) {
      return { workspaceMode: 'none', label: '无项目', projectId: null };
    }
    if (session?.projectId === null) {
      return { workspaceMode: 'none', label: '无项目', projectId: null };
    }
    const cwd =
      session?.workingDirectory ||
      (typeof session?.projectId === 'string' ? session.projectId : '') ||
      this.state.workingDirectory;
    if (cwd) {
      return {
        workspaceMode: 'project',
        cwd,
        label: this.basename(cwd) || cwd,
        projectId: cwd,
      };
    }
    return { workspaceMode: 'none', label: '无项目', projectId: null };
  }

  private sessionIdForRunEvents(
    runId: string,
    events: DaemonOrchestratorEvent[],
    snapshot?: DaemonTaskSnapshot | null
  ): string | undefined {
    const eventSessionId = events.find((event) => event.sessionId)?.sessionId;
    if (eventSessionId) return eventSessionId;
    if (snapshot?.sessionId) return snapshot.sessionId;
    const contextSessionId = this.state.runContexts[runId]?.sessionId;
    if (contextSessionId) return contextSessionId;
    for (const runs of Object.values(this.state.daemonBrowser.runsBySessionId)) {
      const run = runs.find((item) => item.id === runId);
      if (run?.sessionId) return run.sessionId;
    }
    return this.state.activeRunId === runId ? this.state.activeRunSessionId ?? undefined : undefined;
  }

  private permissionModeFromMetadata(metadata?: Record<string, unknown> | null): RunContext['permissionMode'] | undefined {
    const value = this.metadataString(metadata, 'permissionMode');
    return value === 'ask' || value === 'full-access' ? value : undefined;
  }

  private messageFromDaemonSnapshot(message: DaemonTaskMessageSnapshot, snapshot: DaemonTaskSnapshot): ChatMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: this.parseIso(message.createdAt),
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      toolCalls: message.toolCalls?.map((call) => this.toolCallFromDaemonSnapshot(call, snapshot)),
      streaming: this.isActiveDaemonRun(snapshot.status) && message.id === snapshot.messages.at(-1)?.id,
    };
  }

  private toolCallFromDaemonSnapshot(call: DaemonTaskSnapshotToolCall, snapshot: DaemonTaskSnapshot): ToolCall {
    const metadata = call.metadata ? normalizeWorkbenchApprovalMetadata(call.metadata, undefined, 'backend') : undefined;
    return {
      id: call.id,
      name: call.name,
      input: call.input,
      output: call.output,
      status: this.toolCallStatusFromDaemonSnapshot(call.status),
      timestamp: this.parseIso(call.startedAt),
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      ...(metadata ? { approvalMetadata: metadata, ...this.approvalMetadataFields(metadata) } : {}),
    };
  }

  private toolCallStatusFromDaemonSnapshot(status: DaemonTaskSnapshotToolCall['status']): ToolCall['status'] {
    switch (status) {
      case 'running':
        return 'running';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'approval-required':
      case 'pending':
      default:
        return 'pending';
    }
  }

  private messagesFromDaemonEvents(
    sessionId: string,
    events: DaemonOrchestratorEvent[]
  ): { messages: ChatMessage[]; dedupedCount: number } | null {
    const projection = this.daemonProjectionBySessionId.get(sessionId) ?? createRuntimeEventProjectionState();
    const hydratedEventIds = this.hydratedDaemonEventIdsBySessionId.get(sessionId) ?? new Set<string>();
    const incomingIds = new Set<string>();
    let duplicateInBatchCount = 0;
    for (const event of events) {
      if (incomingIds.has(event.id)) {
        duplicateInBatchCount += 1;
      }
      incomingIds.add(event.id);
    }
    const alreadyHydratedCount = [...incomingIds].filter((id) => hydratedEventIds.has(id)).length;
    const newEvents = [...events]
      .filter((event) => !hydratedEventIds.has(event.id))
      .sort((left, right) => left.sequence - right.sequence);

    if (newEvents.length === 0 && this.daemonProjectionBySessionId.has(sessionId)) {
      return {
        messages: materializeRuntimeProjectionMessages(projection).map((message) =>
          this.chatMessageFromRuntimeProjection(message)
        ),
        dedupedCount: alreadyHydratedCount + duplicateInBatchCount,
      };
    }

    for (const event of newEvents) {
      projectDaemonOrchestratorEvent(projection, event);
      hydratedEventIds.add(event.id);
    }

    this.daemonProjectionBySessionId.set(sessionId, projection);
    this.hydratedDaemonEventIdsBySessionId.set(sessionId, hydratedEventIds);
    return {
      messages: materializeRuntimeProjectionMessages(projection).map((message) =>
        this.chatMessageFromRuntimeProjection(message)
      ),
      dedupedCount: alreadyHydratedCount + duplicateInBatchCount,
    };
  }

  private resetDaemonSessionHydration(sessionId: string): void {
    this.daemonProjectionBySessionId.delete(sessionId);
    this.hydratedDaemonEventIdsBySessionId.delete(sessionId);
  }

  private mergeDaemonEvents(
    existingEvents: DaemonOrchestratorEvent[],
    incomingEvents: DaemonOrchestratorEvent[]
  ): DaemonOrchestratorEvent[] {
    if (incomingEvents.length === 0) return existingEvents;
    const byId = new Map(existingEvents.map((event) => [event.id, event]));
    for (const event of incomingEvents) {
      byId.set(event.id, event);
    }
    return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  }

  private buildEventSliceDiagnostics(
    scope: DaemonEventSliceDiagnostics['scope'],
    targetId: string,
    existingEvents: DaemonOrchestratorEvent[] | undefined,
    incomingEvents: DaemonOrchestratorEvent[],
    mergedEvents: DaemonOrchestratorEvent[],
    nextAfterSequence: number,
    input?: DaemonEventSliceDiagnosticsInput
  ): DaemonEventSliceDiagnostics {
    const existingIds = new Set((existingEvents ?? []).map((event) => event.id));
    const incomingUniqueIds = new Set(incomingEvents.map((event) => event.id));
    const duplicateInBatchCount = Math.max(0, incomingEvents.length - incomingUniqueIds.size);
    const alreadyKnownCount = [...incomingUniqueIds].filter((id) => existingIds.has(id)).length;
    return {
      scope,
      targetId,
      mode: input?.backend?.mode ?? input?.mode ?? 'unknown',
      requestMs: input?.requestMs,
      backendQueryMs: input?.backend?.queryMs,
      requestedAfterSequence: input?.backend?.requestedAfterSequence,
      storeReadAfterSequence: input?.backend?.storeReadAfterSequence,
      projectedAfterSequence: input?.backend?.projectedAfterSequence ?? nextAfterSequence,
      eventsFetched: input?.backend?.eventsFetched ?? incomingEvents.length,
      eventsApplied: incomingEvents.length - alreadyKnownCount - duplicateInBatchCount,
      dedupedCount: alreadyKnownCount + duplicateInBatchCount,
      totalEvents: mergedEvents.length,
      hasMore: input?.hasMore ?? input?.backend?.truncated,
      maxEvents: input?.backend?.maxEvents,
      nextCursor: input?.nextCursor,
      loadedAt: Date.now(),
    };
  }

  private updateLastEventLoadHydrationDiagnostics(
    sessionId: string,
    hydratedMessages?: number,
    hydrationDedupedCount = 0
  ): void {
    const last = this.state.daemonBrowser.diagnostics?.lastEventLoad;
    if (!last || (last.scope === 'session' && last.targetId !== sessionId)) return;
    const updated: DaemonEventSliceDiagnostics = {
      ...last,
      hydratedMessages: hydratedMessages ?? last.hydratedMessages,
      dedupedCount: last.dedupedCount + hydrationDedupedCount,
    };
    this.state.daemonBrowser = {
      ...this.state.daemonBrowser,
      diagnostics: {
        ...this.state.daemonBrowser.diagnostics,
        lastEventLoad: updated,
      },
    };
    this.notify('daemonBrowser', this.state.daemonBrowser);
  }

  private chatMessageFromRuntimeProjection(message: RuntimeProjectionMessage): ChatMessage {
    return {
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => this.toolCallFromRuntimeProjection(toolCall)),
    };
  }

  private toolCallFromRuntimeProjection(toolCall: RuntimeProjectionToolCall): ToolCall {
    const metadata = toolCall.approvalMetadata ? normalizeWorkbenchApprovalMetadata(toolCall.approvalMetadata) : undefined;
    return {
      ...toolCall,
      input: toolCall.input,
      ...(metadata ? { approvalMetadata: metadata, ...this.approvalMetadataFields(metadata) } : {}),
    };
  }

  private approvalMetadataFields(metadata: WorkbenchApprovalMetadata): Pick<
    ToolCall,
    | 'riskLevel'
    | 'riskRule'
    | 'riskDetail'
    | 'riskSource'
    | 'matched'
    | 'requiresDoubleConfirm'
    | 'recommendSnapshot'
    | 'checkpointId'
    | 'snapshotId'
  > {
    return {
      riskLevel: metadata.riskLevel,
      riskRule: metadata.riskRule,
      riskDetail: metadata.riskDetail,
      riskSource: metadata.source,
      matched: metadata.matched,
      requiresDoubleConfirm: metadata.requiresDoubleConfirm,
      recommendSnapshot: metadata.recommendSnapshot,
      checkpointId: metadata.checkpointId,
      snapshotId: metadata.snapshotId,
    };
  }

  private metadataString(metadata: Record<string, unknown> | undefined | null, key: string): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private parseIso(value?: string | null): number {
    if (!value) return Date.now();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private basename(path?: string | null): string {
    if (!path) return '';
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  }

  private shortId(id: string): string {
    return id.length > 10 ? id.slice(-10) : id;
  }

  // ==================== Panel Layout Utilities ====================

  private findPanelByTabId(root: PanelNode, tabId: string): TabPanel | null {
    if (root.kind === 'panel') {
      return root.tabIds.includes(tabId) ? root : null;
    }
    for (const child of root.children) {
      const found = this.findPanelByTabId(child, tabId);
      if (found) return found;
    }
    return null;
  }

  private findPanelById(root: PanelNode, panelId: string): TabPanel | null {
    if (root.kind === 'panel' && root.id === panelId) return root;
    if (root.kind === 'group') {
      for (const child of root.children) {
        const found = this.findPanelById(child, panelId);
        if (found) return found;
      }
    }
    return null;
  }

  private findParentGroup(root: PanelNode, panelId: string): PanelGroup | null {
    if (root.kind === 'panel') return null;
    for (const child of root.children) {
      if (child.kind === 'panel' && child.id === panelId) return root;
      const found = this.findParentGroup(child, panelId);
      if (found) return found;
    }
    return null;
  }

  private clonePanelNode(node: PanelNode): PanelNode {
    if (node.kind === 'panel') {
      return { ...node, tabIds: [...node.tabIds] };
    }
    return {
      ...node,
      children: node.children.map(c => this.clonePanelNode(c)),
      sizes: [...node.sizes],
    };
  }

  private updatePanelNode(root: PanelNode, panelId: string, updater: (panel: TabPanel) => TabPanel): PanelNode {
    if (root.kind === 'panel') {
      return root.id === panelId ? updater(root) : root;
    }
    return {
      ...root,
      children: root.children.map(c => this.updatePanelNode(c, panelId, updater)),
    };
  }

  private removePanel(root: PanelNode, panelId: string): PanelNode | null {
    if (root.kind === 'panel') {
      return root.id === panelId ? null : root;
    }
    const newChildren = root.children
      .map(c => this.removePanel(c, panelId))
      .filter(Boolean) as PanelNode[];
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];
    const rawSizes = root.sizes.slice(0, newChildren.length);
    const total = rawSizes.reduce((a, b) => a + b, 0) || 1;
    const sizes = rawSizes.map(s => (s / total) * 100);
    return {
      ...root,
      children: newChildren,
      sizes,
    };
  }

  private replaceNode(root: PanelNode, targetId: string, replacement: PanelNode): PanelNode {
    if (root.kind === 'panel') {
      return root.id === targetId ? replacement : root;
    }
    return {
      ...root,
      children: root.children.map(c => this.replaceNode(c, targetId, replacement)),
    };
  }

  private findFirstPanel(root: PanelNode): TabPanel | null {
    if (root.kind === 'panel') return root;
    return root.children.length > 0 ? this.findFirstPanel(root.children[0]) : null;
  }

  private updateGroupSizes(root: PanelNode, groupId: string, sizes: number[]): PanelNode {
    if (root.kind === 'panel') return root;
    if (root.id === groupId) {
      return { ...root, sizes };
    }
    return {
      ...root,
      children: root.children.map(c => this.updateGroupSizes(c, groupId, sizes)),
    };
  }

  // 按对话隔离的工作区缓存（active = 当前 rightSidebarTabs + panelLayout）
  private workspaces: Record<string, WorkspaceState> = loadWorkspaces();

  private setPanelLayout(layout: PanelNode) {
    this.setState('panelLayout', layout);
    this.persistActiveWorkspace(layout);
  }

  // 把当前激活的工作区（标签 + 布局）存入当前对话的槽位并持久化
  private persistActiveWorkspace(layout: PanelNode = this.state.panelLayout): void {
    saveRightLayout(this.state.rightSidebarTabs, layout);
    const id = this.state.currentSessionId;
    if (id) {
      this.workspaces[id] = { tabs: this.state.rightSidebarTabs, layout };
      saveWorkspaces(this.workspaces);
    }
  }

  // 切换对话时：存旧对话工作区、载入新对话工作区（无则默认）
  private switchWorkspace(prevId: string | null, nextId: string | null): void {
    if (prevId && prevId !== nextId) {
      this.workspaces[prevId] = { tabs: this.state.rightSidebarTabs, layout: this.state.panelLayout };
      saveWorkspaces(this.workspaces);
    }
    if (!nextId) return;
    const ws = this.workspaces[nextId] ?? makeDefaultWorkspace();
    this.workspaces[nextId] = ws;
    this.state.rightSidebarTabs = ws.tabs;
    this.state.panelLayout = ws.layout;
    this.notify('rightSidebarTabs', ws.tabs);
    this.notify('panelLayout', ws.layout);
  }

  /** 从持久化数据恢复右栏标签与分屏布局（启动时调用） */
  restoreRightLayout(tabs: RightSidebarTab[], panelLayout: PanelNode): void {
    this.state.rightSidebarTabs = tabs;
    this.notify('rightSidebarTabs', tabs);
    this.state.panelLayout = panelLayout;
    this.notify('panelLayout', panelLayout);
  }

  // ==================== Right Sidebar Tab Management ====================

  openRightTab(type: RightSidebarTab['type'], label?: string, targetPanelId?: string): string {
    const existing = this.state.rightSidebarTabs.find(t => t.type === type);
    if (existing) {
      const panel = this.findPanelByTabId(this.state.panelLayout, existing.id);
      if (panel) {
        const newLayout = this.updatePanelNode(this.clonePanelNode(this.state.panelLayout), panel.id, p => ({
          ...p,
          activeTabId: existing.id,
        }));
        this.setPanelLayout(newLayout);
      }
      if (label && existing.label !== label) {
        const updated = this.state.rightSidebarTabs.map(t =>
          t.id === existing.id ? { ...t, label } : t
        );
        this.setState('rightSidebarTabs', updated);
      }
      return existing.id;
    }

    const newTab: RightSidebarTab = {
      id: `tab-${type}-${Date.now()}`,
      type,
      label: label || this.getDefaultTabLabel(type),
      closable: true,
    };
    const newTabs = [...this.state.rightSidebarTabs, newTab];
    this.setState('rightSidebarTabs', newTabs);

    // 优先添加到触发 + 的那个窗口；否则退回第一个面板
    const targetPanel =
      (targetPanelId ? this.findPanelById(this.state.panelLayout, targetPanelId) : null) ??
      this.findFirstPanel(this.state.panelLayout);
    if (targetPanel) {
      const newLayout = this.updatePanelNode(this.clonePanelNode(this.state.panelLayout), targetPanel.id, p => ({
        ...p,
        tabIds: [...p.tabIds, newTab.id],
        activeTabId: newTab.id,
      }));
      this.setPanelLayout(newLayout);
    }
    return newTab.id;
  }

  // 在新窗口（横向分屏）打开某个会话的对话视图（多对话并排）
  openSessionInSplit(sessionId: string, label: string): void {
    const newTab: RightSidebarTab = {
      id: `tab-chat-${sessionId}-${Date.now()}`,
      type: 'chat',
      label: label || '对话',
      closable: true,
      sessionId,
    };
    this.setState('rightSidebarTabs', [...this.state.rightSidebarTabs, newTab]);
    const target = this.findFirstPanel(this.state.panelLayout);
    if (!target) return;
    // 先加入第一个面板，再从中拆分为右侧独立窗口
    const layout = this.updatePanelNode(this.clonePanelNode(this.state.panelLayout), target.id, p => ({
      ...p,
      tabIds: [...p.tabIds, newTab.id],
      activeTabId: newTab.id,
    }));
    this.setPanelLayout(layout);
    this.splitPanel(target.id, newTab.id, 'horizontal', false);
  }

  // 一键自动排布：主对话独占一列，其余面板各成窗口在右侧纵向堆叠
  autoArrangeWorkspace(): void {
    const tabs = this.state.rightSidebarTabs;
    if (tabs.length === 0) return;
    const ts = Date.now();
    const chatTabs = tabs.filter(t => t.type === 'chat');
    const otherTabs = tabs.filter(t => t.type !== 'chat');
    const chatPanel: TabPanel = {
      kind: 'panel',
      id: `panel-chat-${ts}`,
      tabIds: chatTabs.map(t => t.id),
      activeTabId: chatTabs[0]?.id ?? '',
    };
    let layout: PanelNode;
    if (otherTabs.length === 0) {
      layout = chatPanel;
    } else {
      const otherPanels: TabPanel[] = otherTabs.map((t, i) => ({
        kind: 'panel',
        id: `panel-o${i}-${ts}`,
        tabIds: [t.id],
        activeTabId: t.id,
      }));
      const otherCol: PanelNode = otherPanels.length === 1
        ? otherPanels[0]
        : { kind: 'group', id: `group-col-${ts}`, direction: 'vertical', children: otherPanels, sizes: otherPanels.map(() => Math.round(100 / otherPanels.length)) };
      layout = chatTabs.length === 0
        ? otherCol
        : { kind: 'group', id: `group-root-${ts}`, direction: 'horizontal', children: [chatPanel, otherCol], sizes: [60, 40] };
    }
    this.setPanelLayout(layout);
  }

  closeRightTab(tabId: string): void {
    const tab = this.state.rightSidebarTabs.find(t => t.id === tabId);
    if (!tab || !tab.closable) return;

    const newTabs = this.state.rightSidebarTabs.filter(t => t.id !== tabId);
    this.setState('rightSidebarTabs', newTabs);

    const panel = this.findPanelByTabId(this.state.panelLayout, tabId);
    if (!panel) return;

    const newTabIds = panel.tabIds.filter(id => id !== tabId);
    let newLayout: PanelNode;

    if (newTabIds.length === 0) {
      newLayout = this.removePanel(this.clonePanelNode(this.state.panelLayout), panel.id) || {
        kind: 'panel',
        id: `panel-${Date.now()}`,
        tabIds: [],
        activeTabId: '',
      };
    } else {
      const newActiveId = panel.activeTabId === tabId
        ? (newTabIds[Math.max(0, panel.tabIds.indexOf(tabId) - 1)] || newTabIds[0])
        : panel.activeTabId;
      newLayout = this.updatePanelNode(this.clonePanelNode(this.state.panelLayout), panel.id, p => ({
        ...p,
        tabIds: newTabIds,
        activeTabId: newActiveId,
      }));
    }
    this.setPanelLayout(newLayout);
  }

  switchRightTab(tabId: string): void {
    const panel = this.findPanelByTabId(this.state.panelLayout, tabId);
    if (!panel) return;
    const newLayout = this.updatePanelNode(this.clonePanelNode(this.state.panelLayout), panel.id, p => ({
      ...p,
      activeTabId: tabId,
    }));
    this.setPanelLayout(newLayout);
  }

  // ---- 纯计算布局（不提交），供拖拽预览与落地共用，保证预览=结果 ----
  private buildMoveLayout(root: PanelNode, tabId: string, targetPanelId: string, fallbackPanelId: string): PanelNode | null {
    const sourcePanel = this.findPanelByTabId(root, tabId);
    const targetPanel = this.findPanelById(root, targetPanelId);
    if (!sourcePanel || !targetPanel || sourcePanel.id === targetPanelId) return null;
    let layout = this.clonePanelNode(root);
    const sourceTabIds = sourcePanel.tabIds.filter(id => id !== tabId);
    if (sourceTabIds.length === 0) {
      layout = this.removePanel(layout, sourcePanel.id) || {
        kind: 'panel', id: fallbackPanelId, tabIds: [tabId], activeTabId: tabId,
      };
    } else {
      layout = this.updatePanelNode(layout, sourcePanel.id, p => ({
        ...p, tabIds: sourceTabIds, activeTabId: p.activeTabId === tabId ? sourceTabIds[0] : p.activeTabId,
      }));
    }
    layout = this.updatePanelNode(layout, targetPanelId, p => ({
      ...p, tabIds: [...p.tabIds, tabId], activeTabId: tabId,
    }));
    return layout;
  }

  private buildSplitLayout(
    root: PanelNode, sourcePanelId: string, tabId: string,
    direction: 'vertical' | 'horizontal', before: boolean,
    newPanelId: string, newGroupId: string
  ): PanelNode | null {
    const sourcePanel = this.findPanelById(root, sourcePanelId);
    if (!sourcePanel || !sourcePanel.tabIds.includes(tabId)) return null;
    let layout = this.clonePanelNode(root);
    const remainingTabIds = sourcePanel.tabIds.filter(id => id !== tabId);
    const newSourcePanel: TabPanel = {
      ...sourcePanel, tabIds: remainingTabIds,
      activeTabId: sourcePanel.activeTabId === tabId ? (remainingTabIds[0] || '') : sourcePanel.activeTabId,
    };
    const newSplitPanel: TabPanel = { kind: 'panel', id: newPanelId, tabIds: [tabId], activeTabId: tabId };
    if (remainingTabIds.length === 0) {
      layout = this.replaceNode(layout, sourcePanelId, newSplitPanel);
    } else {
      const newGroup: PanelGroup = {
        kind: 'group', id: newGroupId, direction,
        children: before ? [newSplitPanel, newSourcePanel] : [newSourcePanel, newSplitPanel],
        sizes: [50, 50],
      };
      layout = this.replaceNode(layout, sourcePanelId, newGroup);
    }
    return layout;
  }

  // 计算"把 tabId 投放到 targetPanel 的 zone"后的布局 + 被拖窗口的新面板 id（zone=center 时为 null）
  private computeDropLayout(
    sourcePanelId: string, tabId: string, targetPanelId: string,
    zone: 'top' | 'bottom' | 'left' | 'right' | 'center',
    newPanelId: string, newGroupId: string
  ): { layout: PanelNode; ghostPanelId: string | null } | null {
    if (zone === 'center') {
      const layout = this.buildMoveLayout(this.state.panelLayout, tabId, targetPanelId, newPanelId);
      return layout ? { layout, ghostPanelId: null } : null;
    }
    let direction: 'vertical' | 'horizontal' = (zone === 'top' || zone === 'bottom') ? 'vertical' : 'horizontal';
    let before = zone === 'top' || zone === 'left';

    // Responsive guard: if horizontal split would overcrowd, fallback to vertical
    if (direction === 'horizontal') {
      const parentGroup = this.findParentGroup(this.state.panelLayout, targetPanelId);
      const horizontalSiblings = parentGroup?.direction === 'horizontal' ? parentGroup.children.length : 1;
      if (horizontalSiblings >= 3) {
        direction = 'vertical';
        before = zone === 'top' || zone === 'left'; // keep original before semantics
      }
    }

    if (targetPanelId === sourcePanelId) {
      const layout = this.buildSplitLayout(this.state.panelLayout, sourcePanelId, tabId, direction, before, newPanelId, newGroupId);
      return layout ? { layout, ghostPanelId: newPanelId } : null;
    }
    const moved = this.buildMoveLayout(this.state.panelLayout, tabId, targetPanelId, newPanelId);
    if (!moved) return null;
    const layout = this.buildSplitLayout(moved, targetPanelId, tabId, direction, before, newPanelId, newGroupId);
    return layout ? { layout, ghostPanelId: newPanelId } : null;
  }

  setDragPreview(
    sourcePanelId: string, tabId: string, targetPanelId: string | null,
    zone: 'top' | 'bottom' | 'left' | 'right' | 'center' | null,
    newPanelId: string, newGroupId: string
  ): void {
    if (!targetPanelId || !zone) { this.clearDragPreview(); return; }
    const result = this.computeDropLayout(sourcePanelId, tabId, targetPanelId, zone, newPanelId, newGroupId);
    if (!result) { this.clearDragPreview(); return; }
    this.state.panelLayoutPreview = result.layout;
    this.state.previewGhostPanelId = result.ghostPanelId;
    this.notify('panelLayoutPreview', result.layout);
    this.notify('previewGhostPanelId', result.ghostPanelId);
  }

  clearDragPreview(): void {
    if (this.state.panelLayoutPreview === null && this.state.previewGhostPanelId === null) return;
    this.state.panelLayoutPreview = null;
    this.state.previewGhostPanelId = null;
    this.notify('panelLayoutPreview', null);
    this.notify('previewGhostPanelId', null);
  }

  commitDragPreview(): void {
    const layout = this.state.panelLayoutPreview;
    this.clearDragPreview();
    if (layout) this.setPanelLayout(layout);
  }

  moveTabToPanel(tabId: string, targetPanelId: string): void {
    const layout = this.buildMoveLayout(this.state.panelLayout, tabId, targetPanelId, `panel-${Date.now()}`);
    if (layout) this.setPanelLayout(layout);
  }

  splitPanel(sourcePanelId: string, tabId: string, direction: 'vertical' | 'horizontal', before = false): void {
    // Responsive guard: if horizontal split would overcrowd, fallback to vertical
    let actualDirection = direction;
    if (direction === 'horizontal') {
      const parentGroup = this.findParentGroup(this.state.panelLayout, sourcePanelId);
      const horizontalSiblings = parentGroup?.direction === 'horizontal' ? parentGroup.children.length : 1;
      if (horizontalSiblings >= 3) actualDirection = 'vertical';
    }
    const layout = this.buildSplitLayout(this.state.panelLayout, sourcePanelId, tabId, actualDirection, before, `panel-${Date.now()}`, `group-${Date.now()}`);
    if (layout) this.setPanelLayout(layout);
  }

  mergePanel(panelId: string): void {
    const parentGroup = this.findParentGroup(this.state.panelLayout, panelId);
    if (!parentGroup || parentGroup.children.length === 0) return;
    let layout = this.clonePanelNode(this.state.panelLayout);
    layout = this.replaceNode(layout, parentGroup.id, parentGroup.children[0]);
    this.setPanelLayout(layout);
  }

  updatePanelSizes(groupId: string, sizes: number[]): void {
    const layout = this.clonePanelNode(this.state.panelLayout);
    const newLayout = this.updateGroupSizes(layout, groupId, sizes);
    this.setPanelLayout(newLayout);
  }

  private getDefaultTabLabel(type: RightSidebarTabType): string {
    switch (type) {
      case 'chat': return '对话';
      case 'project': return '项目';
      case 'runs': return '运行';
      case 'sessions': return '会话';
      case 'approvals': return '审批';
      case 'artifacts': return '产物';
      case 'diagnostics': return '诊断';
      case 'tools': return '工具';
      case 'plan': return '计划';
      case 'settings': return '设置';
      default: return 'Tab';
    }
  }

  addRightSidebarTab(type: RightSidebarTabType, label?: string): string {
    return this.openRightTab(type, label);
  }

  removeRightSidebarTab(tabId: string): void {
    this.closeRightTab(tabId);
  }

  syncReviewTab(): void {
    // Review tab 已并入 ProjectTab，此方法保留为空以兼容
  }
}

// 全局单例
export const appState = new AppState();

// 工作区按对话隔离：启动后由首个 currentSession 触发 switchWorkspace 载入对应布局；
// 无对话时使用初始默认布局。不再做全局单一布局恢复。
