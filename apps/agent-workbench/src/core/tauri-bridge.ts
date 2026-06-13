/**
 * Tauri 后端通信桥接层
 * 封装所有与 Rust 后端的交互
 * 在非 Tauri 环境中（如浏览器开发模式）提供降级处理
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  createBackendDiagnosticArrayResult,
  createBackendDiagnosticResult,
  createBackendDiagnosticTextResult,
  getBridgeViewStatus,
  createBackendNotWiredArrayResult,
  createBackendNotWiredError,
  createBackendNotWiredResult,
  createBackendNotWiredTextResult,
  createUnsupportedCommandDiagnostic,
  isBackendNotWiredCommand,
  type BackendCommandDiagnostic,
  type BackendDiagnosticArrayResult,
  type BackendDiagnosticResult,
  type BackendDiagnosticTextResult,
  type BackendNotWiredArrayResult,
  type BackendNotWiredDiagnostic,
  type BackendNotWiredResult,
  type BackendNotWiredTextResult,
  type BridgeViewStatus,
} from './tauri-command-registry';
import {
  isDaemonProviderStatusSnapshot,
  isDaemonPendingInputCancelledResponse,
  isDaemonPendingInputDispatchedResponse,
  isDaemonPendingInputQueuedResponse,
  isDaemonPendingInputsListedResponse,
  normalizeWorkbenchEvent,
  projectDaemonStatusToWorkbench,
  projectDaemonProviderStatusToWorkbench,
  projectDaemonTaskSnapshotToWorkbench,
  isWorkbenchConversationRewindAppliedResponse,
  isWorkbenchConversationRewindPreviewResult,
  isWorkbenchSessionActionReceipt,
} from '../shared/workbench-contract';
import type {
  DaemonRunEventsQuery,
  DaemonRunEventsResponse,
  DaemonRunRecord,
  DaemonRunSnapshotQuery,
  DaemonRunSnapshotResponse,
  DaemonSessionsListedResponse,
  DaemonSessionEventsResponse,
  DaemonSessionRecord,
  DaemonPendingInputCancelledResponse,
  DaemonPendingInputDispatchedResponse,
  DaemonPendingInputQueuedResponse,
  DaemonPendingInputsListedResponse,
  DaemonPendingInputRecord,
  DaemonProviderStatusSnapshot,
  WorkbenchCancelPendingInputRequest,
  WorkbenchDispatchPendingInputRequest,
  WorkbenchEnqueuePendingInputRequest,
  WorkbenchStatus,
  WorkbenchTaskSnapshot,
  WorkbenchApiKeySource,
  WorkbenchProviderConfigSnapshot,
  WorkbenchProviderConfigUpdate,
  WorkbenchProviderMode,
  WorkbenchBackgroundTask,
  WorkbenchCreatePlanDocumentRequest,
  WorkbenchCreateRequirementsAlignmentPlanRequest,
  WorkbenchPlanDocument,
  WorkbenchPlanDocumentDeletedResponse,
  WorkbenchPlanDocumentPatch,
  WorkbenchPlanDocumentResponse,
  WorkbenchPlanDocumentsListedResponse,
  WorkbenchPlanDocumentSummary,
  WorkbenchConversationRewindAppliedResponse,
  WorkbenchConversationRewindApplyRequest,
  WorkbenchConversationRewindPreviewRequest,
  WorkbenchConversationRewindPreviewResult,
  WorkbenchSessionAction,
  WorkbenchSessionActionReceipt,
  WorkbenchMetricsQuery,
  WorkbenchMetricsQueryResult,
} from '../shared/workbench-contract';
import type { CheckpointRecord, ChangedFile } from './app-state';
import { showToast } from '../components/ToastContainer';

/** 检测是否在 Tauri 环境中运行 */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 类型定义
export interface ArtifactRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  uri: string;
  mimeType?: string;
  createdAt?: number;
  sessionId?: string;
  runId?: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'failed' | 'starting' | 'ready' | 'degraded' | 'discovering' | 'reconnecting' | 'unknown';
  transport?: string;
  toolCount?: number;
  error?: string;
  startedAt?: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  tags: string[];
  scope: string;
  createdAt: number;
}

export interface GitStatusFile {
  path: string;
  status: string; // Git 轻量状态码：M/A/D/R/C/?/!
  staged?: boolean;
}
export interface GitStatusResult {
  found: boolean;
  files: GitStatusFile[];
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicted?: number;
}
export interface GitDiffResult {
  found?: boolean;
  unified?: string;
  stat?: string;
  files?: GitStatusFile[];
}

export interface RunTaskRequest {
  prompt: string;
  sessionId?: string;
  runId?: string;
  mode?: string;
  workspaceMode?: 'project' | 'none';
  visibleGoal?: string;
  budgetDifficulty?: string;
  runTokenBudget?: number;
  maxRounds?: number;
  maxStalledRounds?: number;
  backgroundDrainTimeoutMs?: number;
  cwd?: string;
  permissionMode?: 'ask' | 'full-access';
}

export interface PreparedRunTaskRequest extends RunTaskRequest {
  sessionId: string;
  runId: string;
}

export interface RunTaskStarted {
  runId: string;
  sessionId: string;
}

export interface WorkbenchEvent {
  type: string;
  runId?: string;
  sessionId?: string;
  runtimeSessionId?: string;
  [key: string]: any;
}

/** 空操作 UnlistenFn */
export type BackgroundTaskInfo = WorkbenchBackgroundTask;
export type BackgroundTaskListResult =
  | WorkbenchBackgroundTask[]
  | BackendNotWiredArrayResult<WorkbenchBackgroundTask>
  | BackendDiagnosticArrayResult<WorkbenchBackgroundTask>;
export type ArtifactListResult =
  | ArtifactRecord[]
  | BackendNotWiredArrayResult<ArtifactRecord>
  | BackendDiagnosticArrayResult<ArtifactRecord>;
export type McpServerListResult =
  | McpServerRecord[]
  | BackendNotWiredArrayResult<McpServerRecord>
  | BackendDiagnosticArrayResult<McpServerRecord>;
export type MemoryListResult =
  | MemoryRecord[]
  | BackendNotWiredArrayResult<MemoryRecord>
  | BackendDiagnosticArrayResult<MemoryRecord>;
export type SubagentStatusResult = Record<string, unknown> | BackendNotWiredResult | BackendDiagnosticResult | null;
export type CheckpointListResult =
  | CheckpointRecord[]
  | BackendNotWiredArrayResult<CheckpointRecord>
  | BackendDiagnosticArrayResult<CheckpointRecord>;
export type CheckpointDiffResult = ChangedFile[] | BackendDiagnosticArrayResult<ChangedFile>;
export type CheckpointRestoreResult = boolean | BackendDiagnosticResult;
export type PlanDocumentListResult =
  | WorkbenchPlanDocumentSummary[]
  | BackendDiagnosticArrayResult<WorkbenchPlanDocumentSummary>;
export type PlanDocumentResult = WorkbenchPlanDocument | BackendDiagnosticResult;
export type PlanDocumentDeleteResult = WorkbenchPlanDocumentDeletedResponse | BackendDiagnosticResult;
export type ConversationRewindPreviewResult = WorkbenchConversationRewindPreviewResult | BackendDiagnosticResult;
export type ConversationRewindApplyResult = WorkbenchConversationRewindAppliedResponse | BackendDiagnosticResult;
export type SessionActionResult = WorkbenchSessionActionReceipt | BackendDiagnosticResult;
export type PendingInputQueueResult = DaemonPendingInputQueuedResponse | BackendDiagnosticResult;
export type PendingInputCancelResult = DaemonPendingInputCancelledResponse | BackendDiagnosticResult;
export type PendingInputDispatchResult = DaemonPendingInputDispatchedResponse | BackendDiagnosticResult;
export type PendingInputListResult =
  | DaemonPendingInputRecord[]
  | BackendDiagnosticArrayResult<DaemonPendingInputRecord>;

export interface MutationLeaseRecord {
  token: string;
  scope: { type: 'workspace' } | { type: 'files'; paths: string[] };
  owner?: {
    runId?: string;
    sessionId?: string;
    toolCallId?: string;
    toolName?: string;
    cwd?: string;
    targetSummary?: string;
  };
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
}

export type MutationLeaseListResult = MutationLeaseRecord[] | BackendDiagnosticArrayResult<MutationLeaseRecord>;

export type BridgeTextResult = string | BackendNotWiredTextResult | BackendDiagnosticTextResult;
export type ModelListResult = string[] | BackendDiagnosticArrayResult<string>;
export type SessionListResult = DaemonSessionsListedResponse | BackendDiagnosticArrayResult<DaemonSessionRecord>;

export type HostOpenerKind = 'file-manager' | 'editor';

export interface HostOpener {
  id: string;
  label: string;
  kind: HostOpenerKind;
  available: boolean;
  reason?: string;
}

export type HostOpenerListResult = HostOpener[] | BackendDiagnosticArrayResult<HostOpener>;

export interface HostOpenTarget {
  type: 'path' | 'url';
  path?: string;
  url?: string;
}

export interface HostOpenResult {
  ok: boolean;
  openerId: string;
  targetKind: 'path' | 'url';
  target: string;
  command: string;
}

export type WorkbenchMetricsResult = WorkbenchMetricsQueryResult | BackendDiagnosticResult | null;

const noopUnlisten: UnlistenFn = () => {};
const backendDiagnostics: BackendCommandDiagnostic[] = [];
const backendViewStatuses = new Map<string, BridgeViewStatus>();
const reportedBackendDiagnosticKeys = new Set<string>();

export function getBackendDiagnostics(): BackendCommandDiagnostic[] {
  return [...backendDiagnostics];
}

export function getBackendViewStatuses(): BridgeViewStatus[] {
  return [...backendViewStatuses.values()];
}

export function getBackendViewStatus(command: string): BridgeViewStatus | undefined {
  return backendViewStatuses.get(command);
}

export function getBackendNotWiredDiagnostics(): BackendNotWiredDiagnostic[] {
  return backendDiagnostics.filter((diagnostic): diagnostic is BackendNotWiredDiagnostic => diagnostic.code === 'backend-not-wired');
}

export function clearBackendNotWiredDiagnosticsForTest(): void {
  backendDiagnostics.length = 0;
  backendViewStatuses.clear();
  reportedBackendDiagnosticKeys.clear();
}

export const clearBackendDiagnosticsForTest = clearBackendNotWiredDiagnosticsForTest;

/**
 * Tauri Bridge 类
 */
export class TauriBridge {
  private eventListeners: Map<string, UnlistenFn[]> = new Map();
  private runSessions: Map<string, string> = new Map();

  createRunTaskRequest(request: RunTaskRequest): PreparedRunTaskRequest {
    const sessionId = this.nonEmptyString(request.sessionId) ?? this.createSessionId();
    return {
      ...request,
      sessionId,
      runId: this.nonEmptyString(request.runId) ?? this.createRunId(),
    };
  }

  /**
   * 运行任务（流式）
   */
  async runTask(request: RunTaskRequest): Promise<RunTaskStarted> {
    const prepared = this.createRunTaskRequest(request);
    this.runSessions.set(prepared.runId, prepared.sessionId);

    if (!isTauri) {
      showToast('非 Tauri 环境，无法运行任务', 'warning', 4500);
      return { runId: prepared.runId, sessionId: prepared.sessionId };
    }
    try {
      const result = await invoke<{ runId?: string }>('workbench_run_task_stream', {
        request: {
          prompt: prepared.prompt,
          sessionId: prepared.sessionId,
          runId: prepared.runId,
          mode: prepared.mode,
          workspaceMode: prepared.workspaceMode,
          visibleGoal: prepared.visibleGoal,
          budgetDifficulty: prepared.budgetDifficulty,
          runTokenBudget: prepared.runTokenBudget,
          maxRounds: prepared.maxRounds,
          maxStalledRounds: prepared.maxStalledRounds,
          backgroundDrainTimeoutMs: prepared.backgroundDrainTimeoutMs,
          cwd: prepared.cwd,
          permissionMode: prepared.permissionMode,
        },
      });
      const runId = this.nonEmptyString(result?.runId) ?? prepared.runId;
      this.runSessions.set(runId, prepared.sessionId);
      return { runId, sessionId: prepared.sessionId };
    } catch (error) {
      showToast('运行任务失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 取消运行中的任务
   */
  async cancelRun(runId: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_cancel_run', { runId });
    } catch (error) {
      showToast('取消任务失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 取消后台任务
   */
  async cancelBackgroundTask(taskId: string): Promise<void> {
    if (!isTauri) return;
    if (isBackendNotWiredCommand('workbench_cancel_background_task')) {
      this.throwBackendNotWired('workbench_cancel_background_task');
    }
    try {
      await invoke('workbench_cancel_background_task', { taskId });
    } catch (error) {
      showToast('取消后台任务失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 获取后台任务完整输出
   */
  async getBackgroundTaskOutput(taskId: string): Promise<BridgeTextResult> {
    if (!isTauri) return '';
    if (isBackendNotWiredCommand('workbench_get_background_task_output')) {
      return this.backendNotWiredText('workbench_get_background_task_output');
    }
    try {
      return await invoke<string>('workbench_get_background_task_output', { taskId });
    } catch (error) {
      showToast('获取后台任务输出失败', 'error', 4500);
      return this.backendDiagnosticText('workbench_get_background_task_output', error);
    }
  }

  /**
   * 列出所有后台任务
   */
  async listBackgroundTasks(): Promise<BackgroundTaskListResult> {
    if (!isTauri) return [];
    if (isBackendNotWiredCommand('workbench_list_background_tasks')) {
      return this.backendNotWiredArray<WorkbenchBackgroundTask>('workbench_list_background_tasks');
    }
    try {
      return await invoke<WorkbenchBackgroundTask[]>('workbench_list_background_tasks');
    } catch (error) {
      showToast('列出后台任务失败', 'error', 4500);
      return this.backendDiagnosticArray<WorkbenchBackgroundTask>('workbench_list_background_tasks', error);
    }
  }

  /**
   * 列出 artifacts
   */
  async listArtifacts(sessionId?: string): Promise<ArtifactListResult> {
    if (!isTauri) return this.backendUnsupportedArray<ArtifactRecord>('workbench_list_artifacts');
    try {
      const result = await invoke<unknown[]>('workbench_list_artifacts', { sessionId });
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<ArtifactRecord>(
          'workbench_list_artifacts',
          'Invalid artifacts response: expected an array.'
        );
      }
      return this.backendOkArray('workbench_list_artifacts', (result as any[]).map((a: any) => ({
        id: a.id ?? '',
        name: a.name ?? '',
        type: a.type ?? 'unknown',
        size: a.size ?? 0,
        uri: a.uri ?? '',
        mimeType: a.mimeType ?? undefined,
        createdAt: typeof a.createdAt === 'number' ? a.createdAt : typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : undefined,
        sessionId: a.sessionId ?? undefined,
        runId: a.runId ?? undefined,
      })));
    } catch (error) {
      showToast('列出 artifacts 失败', 'error', 4500);
      return this.backendDiagnosticArray<ArtifactRecord>('workbench_list_artifacts', error);
    }
  }

  /**
   * 获取 artifact 内容
   */
  async getArtifactContent(artifactUri: string): Promise<BridgeTextResult> {
    if (!isTauri) return '';
    try {
      return await invoke<string>('workbench_get_artifact_content', { artifactUri });
    } catch (error) {
      showToast('获取 artifact 内容失败', 'error', 4500);
      return this.backendDiagnosticText('workbench_get_artifact_content', error);
    }
  }

  /**
   * 列出 MCP 服务器状态
   */
  async listMcpServers(): Promise<McpServerListResult> {
    if (!isTauri) return this.backendUnsupportedArray<McpServerRecord>('workbench_list_mcp_servers');
    try {
      const result = await invoke<unknown[]>('workbench_list_mcp_servers');
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<McpServerRecord>(
          'workbench_list_mcp_servers',
          'Invalid MCP server response: expected an array.'
        );
      }
      return this.backendOkArray('workbench_list_mcp_servers', (result as any[]).map((s: any) => ({
        id: s.id ?? s.name ?? '',
        name: s.name ?? s.id ?? '',
        status: s.status ?? s.state ?? 'unknown',
        transport: s.transport ?? undefined,
        toolCount: s.toolCount ?? s.tools?.length ?? undefined,
        error: s.error ?? s.lastError ?? undefined,
        startedAt: s.startedAt ?? undefined,
      })));
    } catch (error) {
      showToast('列出 MCP 服务器失败', 'error', 4500);
      return this.backendDiagnosticArray<McpServerRecord>('workbench_list_mcp_servers', error);
    }
  }

  /**
   * 启动 MCP 服务器
   */
  async startMcpServer(serverId: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_start_mcp_server', { serverId });
    } catch (error) {
      showToast('启动 MCP 服务器失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 停止 MCP 服务器
   */
  async stopMcpServer(serverId: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_stop_mcp_server', { serverId });
    } catch (error) {
      showToast('停止 MCP 服务器失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 列出记忆条目
   */
  async listMemories(): Promise<MemoryListResult> {
    if (!isTauri) return this.backendUnsupportedArray<MemoryRecord>('workbench_list_memories');
    try {
      const result = await invoke<unknown[]>('workbench_list_memories');
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<MemoryRecord>(
          'workbench_list_memories',
          'Invalid memory response: expected an array.'
        );
      }
      return this.backendOkArray('workbench_list_memories', (result as any[]).map((m: any) => ({
        id: m.id ?? '',
        content: typeof m.content === 'string' ? m.content : typeof m.value === 'string' ? m.value : JSON.stringify(m.content ?? m.value ?? ''),
        tags: Array.isArray(m.tags) ? m.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
        scope: m.scope ?? 'user',
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : typeof m.createdAt === 'string' ? new Date(m.createdAt).getTime() : Date.now(),
      })));
    } catch (error) {
      showToast('列出记忆失败', 'error', 4500);
      return this.backendDiagnosticArray<MemoryRecord>('workbench_list_memories', error);
    }
  }

  /**
   * 删除记忆
   */
  async deleteMemory(memoryId: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_delete_memory', { memoryId });
    } catch (error) {
      showToast('删除记忆失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 回答交互式提问（消费 BE-16 workbench_answer_question）
   */
  async answerQuestion(
    questionId: string,
    value: string | string[],
    context?: { runId?: string; sessionId?: string }
  ): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_answer_question', {
        questionId,
        value,
        runId: context?.runId,
        sessionId: context?.sessionId,
      });
    } catch (error) {
      showToast('回答提问失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * Git 工作区状态（消费 BE-19 workbench_git_status）。非 Git 目录返回 found:false。
   */
  async gitStatus(cwd?: string): Promise<GitStatusResult> {
    if (!isTauri) return { found: false, files: [] };
    try {
      const result = await invoke<any>('workbench_git_status', { cwd });
      return {
        found: result?.found !== false,
        files: Array.isArray(result?.files) ? result.files : [],
        staged: typeof result?.staged === 'number' ? result.staged : undefined,
        unstaged: typeof result?.unstaged === 'number' ? result.unstaged : undefined,
        untracked: typeof result?.untracked === 'number' ? result.untracked : undefined,
        conflicted: typeof result?.conflicted === 'number' ? result.conflicted : undefined,
      };
    } catch (error) {
      showToast('Git 状态查询失败', 'error', 4500);
      return { found: false, files: [] };
    }
  }

  /**
   * Git 文件级 diff（消费 BE-19 workbench_git_diff）。
   */
  async gitDiff(params: { cwd?: string; path?: string; staged?: boolean }): Promise<GitDiffResult> {
    if (!isTauri) return {};
    try {
      const result = await invoke<any>('workbench_git_diff', params);
      return {
        found: result?.found,
        unified: typeof result?.unified === 'string' ? result.unified : undefined,
        stat: typeof result?.stat === 'string' ? result.stat : undefined,
        files: Array.isArray(result?.files) ? result.files : undefined,
      };
    } catch (error) {
      showToast('Git diff 查询失败', 'error', 4500);
      return {};
    }
  }

  /**
   * 获取轻量连接状态（不经过 daemon 往返，直接读 sidecar supervisor 快照）
   */
  async getConnectionStatus(): Promise<{
    connected: boolean;
    state: string;
    generation: number | null;
    pid: number | null;
    disconnectCount: number;
    reconnectRetryCount: number;
    lastReconnectError: string | null;
    lastReconnectAttempt: string | null;
    lastTransitionAt: string;
    daemonBuildHash: string | null;
    checkedAt: number;
  }> {
    if (!isTauri) return {
      connected: false, state: 'stopped', generation: null, pid: null,
      disconnectCount: 0, reconnectRetryCount: 0,
      lastReconnectError: null, lastReconnectAttempt: null,
      lastTransitionAt: '', daemonBuildHash: null, checkedAt: Date.now(),
    };
    return await invoke('workbench_connection_status');
  }

  /**
   * 获取工作台状态
   */
  async getStatus(): Promise<WorkbenchStatus> {
    if (!isTauri) return { activeRuns: 0, pendingApprovals: 0 };
    try {
      return this.normalizeWorkbenchStatus(await invoke<Record<string, unknown>>('workbench_status'));
    } catch (error) {
      showToast('获取状态失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 获取任务快照（完整的 WorkbenchTaskSnapshot）
   */
  async getRunSnapshot(params: DaemonRunSnapshotQuery | string): Promise<DaemonRunSnapshotResponse | null> {
    const runId = typeof params === 'string' ? params : params.runId;
    if (!runId) return null;
    if (!isTauri) return null;
    try {
      return await invoke<DaemonRunSnapshotResponse>('workbench_get_run_snapshot', { runId });
    } catch (error) {
      showToast('Get daemon run snapshot failed', 'error', 4500);
      throw error;
    }
  }

  async getTaskSnapshot(runId: string): Promise<WorkbenchTaskSnapshot | null> {
    try {
      const response = await this.getRunSnapshot({ runId });
      return response?.snapshot ? projectDaemonTaskSnapshotToWorkbench(response.snapshot) : null;
    } catch (error) {
      showToast('Get daemon task snapshot failed', 'error', 4500);
      return null;
    }
  }

  async listSessions(): Promise<SessionListResult> {
    if (!isTauri) return this.backendUnsupportedArray<DaemonSessionRecord>('workbench_list_sessions');
    try {
      const result = await invoke<DaemonSessionsListedResponse>('workbench_list_sessions');
      if (!Array.isArray(result?.sessions)) {
        return this.backendDiagnosticArray<DaemonSessionRecord>(
          'workbench_list_sessions',
          'Invalid sessions response: expected a sessions array.'
        );
      }
      this.recordBridgeViewStatus('workbench_list_sessions', result.sessions);
      return {
        type: result.type,
        sessions: result.sessions,
        ...(Array.isArray(result.summaries) ? { summaries: result.summaries } : {}),
      };
    } catch (error) {
      showToast('List sessions failed', 'error', 4500);
      return this.backendDiagnosticArray<DaemonSessionRecord>('workbench_list_sessions', error);
    }
  }

  async applySessionAction(action: WorkbenchSessionAction): Promise<SessionActionResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_apply_session_action');
    try {
      const result = await invoke<WorkbenchSessionActionReceipt>('workbench_apply_session_action', { action });
      if (!isWorkbenchSessionActionReceipt(result)) {
        return this.backendDiagnosticResult(
          'workbench_apply_session_action',
          'Invalid session action receipt response.'
        );
      }
      this.recordBridgeViewStatus('workbench_apply_session_action', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_apply_session_action', error);
    }
  }

  async listHostOpeners(): Promise<HostOpenerListResult> {
    if (!isTauri) return this.backendUnsupportedArray<HostOpener>('workbench_list_host_openers');
    try {
      const result = await invoke<unknown[]>('workbench_list_host_openers');
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<HostOpener>(
          'workbench_list_host_openers',
          'Invalid host opener response: expected an array.'
        );
      }
      return this.backendOkArray(
        'workbench_list_host_openers',
        result.map((item) => this.normalizeHostOpener(item))
      );
    } catch (error) {
      return this.backendDiagnosticArray<HostOpener>('workbench_list_host_openers', error);
    }
  }

  async openHostTarget(openerId: string, target: HostOpenTarget): Promise<HostOpenResult> {
    if (!isTauri) throw createUnsupportedCommandDiagnostic('workbench_open_host_target');
    try {
      return await invoke<HostOpenResult>('workbench_open_host_target', { openerId, target });
    } catch (error) {
      showToast('Open host target failed', 'error', 4500);
      throw error;
    }
  }

  async listRuns(sessionId?: string): Promise<DaemonRunRecord[]> {
    if (!isTauri) return [];
    try {
      const result = await invoke<{ runs?: DaemonRunRecord[] }>('workbench_list_runs', { sessionId });
      const runs = Array.isArray(result?.runs) ? result.runs : [];
      runs.forEach((run) => {
        if (run.id && run.sessionId) {
          this.runSessions.set(run.id, run.sessionId);
        }
      });
      return runs;
    } catch (error) {
      showToast('List runs failed', 'error', 4500);
      throw error;
    }
  }

  async enqueuePendingInput(request: WorkbenchEnqueuePendingInputRequest): Promise<PendingInputQueueResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_enqueue_pending_input');
    try {
      const result = await invoke<DaemonPendingInputQueuedResponse>('workbench_enqueue_pending_input', { request });
      if (!isDaemonPendingInputQueuedResponse(result)) {
        return this.backendDiagnosticResult(
          'workbench_enqueue_pending_input',
          'Invalid pending input queue response.'
        );
      }
      this.recordBridgeViewStatus('workbench_enqueue_pending_input', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_enqueue_pending_input', error);
    }
  }

  async cancelPendingInput(request: WorkbenchCancelPendingInputRequest): Promise<PendingInputCancelResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_cancel_pending_input');
    try {
      const result = await invoke<DaemonPendingInputCancelledResponse>('workbench_cancel_pending_input', { request });
      if (!isDaemonPendingInputCancelledResponse(result)) {
        return this.backendDiagnosticResult(
          'workbench_cancel_pending_input',
          'Invalid pending input cancellation response.'
        );
      }
      this.recordBridgeViewStatus('workbench_cancel_pending_input', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_cancel_pending_input', error);
    }
  }

  async dispatchPendingInput(request: WorkbenchDispatchPendingInputRequest): Promise<PendingInputDispatchResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_dispatch_pending_input');
    try {
      const result = await invoke<DaemonPendingInputDispatchedResponse>('workbench_dispatch_pending_input', { request });
      if (!isDaemonPendingInputDispatchedResponse(result)) {
        return this.backendDiagnosticResult(
          'workbench_dispatch_pending_input',
          'Invalid pending input dispatch response.'
        );
      }
      this.recordBridgeViewStatus('workbench_dispatch_pending_input', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_dispatch_pending_input', error);
    }
  }

  async listPendingInputs(sessionId?: string): Promise<PendingInputListResult> {
    if (!isTauri) return this.backendUnsupportedArray<DaemonPendingInputRecord>('workbench_list_pending_inputs');
    try {
      const result = await invoke<DaemonPendingInputsListedResponse>('workbench_list_pending_inputs', { sessionId });
      if (!isDaemonPendingInputsListedResponse(result)) {
        return this.backendDiagnosticArray<DaemonPendingInputRecord>(
          'workbench_list_pending_inputs',
          'Invalid pending input list response.'
        );
      }
      this.recordBridgeViewStatus('workbench_list_pending_inputs', result.inputs);
      return result.inputs;
    } catch (error) {
      return this.backendDiagnosticArray<DaemonPendingInputRecord>('workbench_list_pending_inputs', error);
    }
  }

  async readSessionEvents(params: {
    sessionId: string;
    afterSequence?: number;
    lastEventId?: string;
    maxEvents?: number;
    cursor?: DaemonRunEventsQuery["cursor"];
  }): Promise<DaemonSessionEventsResponse> {
    if (!isTauri) {
      const eventLog = params.cursor
        ? {
            eventLogId: params.cursor.eventLogId,
            generation: params.cursor.generation,
            schemaVersion: params.cursor.schemaVersion,
            protocolVersion: params.cursor.protocolVersion,
          }
        : { eventLogId: 'browser-mock', generation: 1, schemaVersion: 1, protocolVersion: 1 };
      return {
        sessionId: params.sessionId,
        events: [],
        eventLog,
        nextAfterSequence: params.afterSequence ?? 0,
        hasMore: false,
        afterSequence: params.afterSequence,
        lastEventId: params.lastEventId,
      };
    }
    try {
      return await invoke<DaemonSessionEventsResponse>('workbench_read_session_events', params);
    } catch (error) {
      showToast('Read session events failed', 'error', 4500);
      throw error;
    }
  }

  async readRunEvents(params: DaemonRunEventsQuery): Promise<DaemonRunEventsResponse> {
    if (!isTauri) {
      const eventLog = params.cursor
        ? {
            eventLogId: params.cursor.eventLogId,
            generation: params.cursor.generation,
            schemaVersion: params.cursor.schemaVersion,
            protocolVersion: params.cursor.protocolVersion,
          }
        : { eventLogId: 'browser-mock', generation: 1, schemaVersion: 1, protocolVersion: 1 };
      return {
        runId: params.runId,
        events: [],
        eventLog,
        nextAfterSequence: params.afterSequence ?? 0,
        hasMore: false,
        afterSequence: params.afterSequence,
        lastEventId: params.lastEventId,
      };
    }
    try {
      const request: Record<string, unknown> = { ...params };
      return await invoke<DaemonRunEventsResponse>('workbench_read_run_events', request);
    } catch (error) {
      showToast('Read run events failed', 'error', 4500);
      throw error;
    }
  }

  /**
   * Goal 模式流式运行（多轮自动续跑）
   */
  async runGoalStream(params: {
    cwd: string;
    prompt: string;
    mode?: string;
    maxRounds?: number;
    runId?: string;
    sessionId?: string;
    permissionMode?: string;
  }): Promise<{ runId: string; sessionId: string }> {
    if (!isTauri) return { runId: '', sessionId: '' };
    try {
      const sessionId = this.nonEmptyString(params.sessionId) ?? this.createSessionId();
      const runId = this.nonEmptyString(params.runId) ?? this.createRunId();
      this.runSessions.set(runId, sessionId);
      const result = await invoke('workbench_run_goal_stream', {
        request: {
          prompt: params.prompt,
          sessionId,
          runId,
          cwd: params.cwd,
          mode: 'goal',
          maxRounds: params.maxRounds,
          permissionMode: params.permissionMode || 'ask',
        },
      });
      const resolvedRunId = this.nonEmptyString((result as any)?.runId) ?? runId;
      const resolvedSessionId = this.nonEmptyString((result as any)?.sessionId) ?? sessionId;
      this.runSessions.set(resolvedRunId, resolvedSessionId);
      return { runId: resolvedRunId, sessionId: resolvedSessionId };
    } catch (error) {
      showToast('Goal 模式运行失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 续跑已暂停的任务
   */
  async continuation(runId: string, decision: { action: string; reason: string; prompt?: string }): Promise<void | BackendDiagnosticResult> {
    void runId;
    void decision;
    return this.backendDiagnosticResult(
      'workbench_continuation',
      'unsupported: product continuation is not daemon-backed yet; legacy CLI continuation is isolated as workbench_dev_cli_continuation.'
    );
  }

  /**
   * 获取性能快照（内存/CPU/进程树）
   */
  async getPerformanceSnapshot(): Promise<any> {
    if (!isTauri) return null;
    try {
      return await invoke('workbench_performance_snapshot');
    } catch (error) {
      showToast('获取性能快照失败', 'error', 4500);
      return null;
    }
  }

  async getMetrics(query: WorkbenchMetricsQuery = {}): Promise<WorkbenchMetricsResult> {
    if (!isTauri) return null;
    try {
      return await invoke<WorkbenchMetricsQueryResult>('workbench_get_metrics', {
        runId: query.runId,
        sessionId: query.sessionId,
        includeRuns: query.includeRuns,
      });
    } catch (error) {
      return this.backendDiagnosticResult('workbench_get_metrics', error);
    }
  }

  /**
   * 重启 Daemon 进程
   */
  async restartDaemon(): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_restart_daemon');
    } catch (error) {
      showToast('重启 Daemon 失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 停止 Daemon 进程
   */
  async stopDaemon(): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('workbench_stop_daemon');
    } catch (error) {
      showToast('停止 Daemon 失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 监听运行事件
   */
  async onRunEvent(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    if (!isTauri) return noopUnlisten;
    const unlisten = await listen('workbench-run-event', (event: any) => {
      callback(this.normalizeEvent(event.payload));
    });

    this.addListener('workbench-run-event', unlisten);
    return unlisten;
  }

  /**
   * 监听审批请求事件
   */
  async onApprovalRequested(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    if (!isTauri) return noopUnlisten;
    const unlisten = await listen('workbench-approval-requested', (event: any) => {
      callback(this.normalizeEvent(event.payload));
    });

    this.addListener('workbench-approval-requested', unlisten);
    return unlisten;
  }

  /**
   * 监听审批结果事件
   */
  async onApprovalResolved(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    if (!isTauri) return noopUnlisten;
    const unlisten = await listen('workbench-approval-resolved', (event: any) => {
      callback(this.normalizeEvent(event.payload));
    });

    this.addListener('workbench-approval-resolved', unlisten);
    return unlisten;
  }

  /**
   * 批准工具调用
   */
  async approveToolCall(toolCallId: string, scope?: 'project' | 'always', context?: { runId?: string; sessionId?: string }): Promise<void> {
    void context;
    if (!isTauri) return;
    try {
      await invoke('workbench_approve_tool', { toolCallId, scope });
    } catch (error) {
      showToast('批准工具调用失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 拒绝工具调用
   */
  async denyToolCall(toolCallId: string, context?: { runId?: string; sessionId?: string }): Promise<void> {
    void context;
    if (!isTauri) return;
    try {
      await invoke('workbench_deny_tool', { toolCallId });
    } catch (error) {
      showToast('拒绝工具调用失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 选择文件夹对话框
   */
  async selectFolder(): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const result = await invoke<{ path: string | null }>('select_folder');
      return result.path;
    } catch (error) {
      showToast('选择文件夹失败', 'error', 4500);
      return null;
    }
  }

  /**
   * 保存 API 配置到 Rust 端
   */
  async saveApiConfig(apiKey: string, baseUrl: string, model: string): Promise<WorkbenchProviderConfigSnapshot> {
    if (!isTauri) {
      return this.normalizeProviderConfigSnapshot({
        apiKey,
        baseUrl,
        model,
        credentialMode: 'direct',
      });
    }
    try {
      const result = await invoke<Record<string, unknown>>('save_api_config', { apiKey, baseUrl, model });
      return this.normalizeProviderConfigSnapshot({
        ...result,
        baseUrl,
        model,
        credentialMode: 'direct',
      });
    } catch (error) {
      showToast('保存 API 配置失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 更新守护进程配置
   */
  async updateDaemonConfig(
    apiKeyOrConfig: string | WorkbenchProviderConfigUpdate,
    baseUrl?: string,
    model?: string
  ): Promise<WorkbenchProviderConfigSnapshot> {
    const update =
      typeof apiKeyOrConfig === 'string'
        ? { apiKey: apiKeyOrConfig, baseUrl, model, credentialMode: 'direct' as WorkbenchProviderMode }
        : apiKeyOrConfig;
    if (!isTauri) {
      return this.normalizeProviderConfigSnapshot({ ...update });
    }
    try {
      const request: Record<string, string | boolean> = {};
      if ('apiKey' in update && update.apiKey !== undefined) request.apiKey = update.apiKey;
      if (update.baseUrl !== undefined) request.baseUrl = update.baseUrl;
      if (update.model !== undefined) request.model = update.model;
      if (update.credentialMode !== undefined) request.credentialMode = update.credentialMode;
      if (update.endpoint !== undefined) request.endpoint = update.endpoint;
      if (update.stream !== undefined) request.stream = update.stream;
      const result = await invoke<Record<string, unknown>>('update_daemon_config', request);
      return this.normalizeProviderConfigSnapshot({
        ...result,
        baseUrl: update.baseUrl,
        model: update.model,
        credentialMode: update.credentialMode,
        endpoint: update.endpoint,
        stream: update.stream,
      });
    } catch (error) {
      showToast('更新守护进程配置失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 获取守护进程状态
   */
  async getDaemonStatus(): Promise<WorkbenchStatus> {
    if (!isTauri) return { activeRuns: 0, pendingApprovals: 0 };
    try {
      return this.normalizeWorkbenchStatus(await invoke<Record<string, unknown>>('workbench_status'));
    } catch (error) {
      showToast('获取守护进程状态失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 获取当前 API 配置
   */
  async getApiConfig(): Promise<WorkbenchProviderConfigSnapshot & { apiKey: string }> {
    if (!isTauri) {
      return {
        ...this.normalizeProviderConfigSnapshot({}),
        apiKey: '',
      };
    }
    try {
      const result = await invoke<Record<string, unknown>>('get_api_config');
      return {
        ...this.normalizeProviderConfigSnapshot(result),
        apiKey: typeof result.apiKey === 'string' ? result.apiKey : '',
      };
    } catch (error) {
      showToast('获取 API 配置失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 从 Provider API 动态获取可用模型列表
   */
  async fetchModels(baseUrl: string, apiKey?: string): Promise<ModelListResult> {
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        return this.backendDiagnosticArray<string>(
          'provider_model_list',
          `Provider model list request failed with HTTP ${response.status}.`
        );
      }
      const data = await response.json();
      if (Array.isArray(data.data)) {
        return data.data
          .map((m: any) => m.id || m.name || '')
          .filter((id: string) => id.length > 0)
          .sort();
      }
      return this.backendDiagnosticArray<string>(
        'provider_model_list',
        'Invalid provider model list response: missing data array.'
      );
    } catch (error) {
      showToast('获取模型列表失败', 'error', 4500);
      return this.backendDiagnosticArray<string>('provider_model_list', error);
    }
  }

  /**
   * 列出目录内容
   */
  async listDirectory(path: string): Promise<{ items: Array<{ name: string; isDir: boolean; size: number | null; modified: string | null }> }> {
    if (!isTauri) return { items: [] };
    try {
      return await invoke('list_directory', { path });
    } catch (error) {
      showToast('列出目录失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 读取文件内容
   */
  async readFileContent(path: string, maxLines?: number): Promise<{ content: string; lineCount: number; truncated: boolean }> {
    if (!isTauri) return { content: '', lineCount: 0, truncated: false };
    try {
      return await invoke('read_file_content', { path, maxLines });
    } catch (error) {
      showToast('读取文件内容失败', 'error', 4500);
      throw error;
    }
  }

  async openFileInFolder(filePath: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('open_file_in_folder', { filePath });
    } catch (error) {
      showToast('在文件管理器中打开失败', 'error', 4500);
      throw error;
    }
  }

  async openFileWithDefaultApp(filePath: string): Promise<void> {
    if (!isTauri) return;
    try {
      await invoke('open_file_with_default_app', { filePath });
    } catch (error) {
      showToast('用默认应用打开失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 清理所有事件监听器
   */
  cleanup() {
    this.eventListeners.forEach((listeners) => {
      listeners.forEach((unlisten) => unlisten());
    });
    this.eventListeners.clear();
  }

  /**
   * 列出 Checkpoint
   */
  async listCheckpoints(sessionId?: string): Promise<CheckpointListResult> {
    if (!isTauri) return this.backendUnsupportedArray<CheckpointRecord>('workbench_list_checkpoints');
    try {
      const result = await invoke<unknown[]>('workbench_list_checkpoints', { sessionId });
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<CheckpointRecord>(
          'workbench_list_checkpoints',
          'Invalid checkpoint response: expected an array.'
        );
      }
      return this.backendOkArray('workbench_list_checkpoints', (result as any[]).map((c: any) => ({
        id: c.id ?? c.checkpointId ?? '',
        label: c.label ?? c.message ?? '',
        runId: c.runId ?? undefined,
        sessionId: c.sessionId ?? undefined,
        filePaths: Array.isArray(c.filePaths) ? c.filePaths : Array.isArray(c.changedFiles) ? c.changedFiles : [],
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : typeof c.createdAt === 'string' ? new Date(c.createdAt).getTime() : Date.now(),
        restoredAt: c.restoredAt ?? undefined,
      })));
    } catch (error) {
      showToast('列出 Checkpoint 失败', 'error', 4500);
      return this.backendDiagnosticArray<CheckpointRecord>('workbench_list_checkpoints', error);
    }
  }

  /**
   * Get Checkpoint Diff
   */
  async getCheckpointDiff(checkpointId: string): Promise<CheckpointDiffResult> {
    if (!isTauri) return this.backendUnsupportedArray<ChangedFile>('workbench_get_checkpoint_diff');
    try {
      const result = await invoke<unknown>('workbench_get_checkpoint_diff', { checkpointId });
      const files = (result as any)?.files ?? (result as any)?.changedFiles;
      if (!Array.isArray(files)) {
        return this.backendDiagnosticArray<ChangedFile>(
          'workbench_get_checkpoint_diff',
          'Invalid checkpoint diff response: expected files array.'
        );
      }
      return this.backendOkArray('workbench_get_checkpoint_diff', files.map((f: any) => ({
        path: f.path ?? f.filePath ?? '',
        status: f.status ?? f.changeType ?? 'modified',
        addedLines: f.addedLines ?? f.additions ?? 0,
        removedLines: f.removedLines ?? f.deletions ?? 0,
      })));
    } catch (error) {
      showToast('获取 Checkpoint Diff 失败', 'error', 4500);
      return this.backendDiagnosticArray<ChangedFile>('workbench_get_checkpoint_diff', error);
    }
  }

  /**
   * 恢复 Checkpoint
   */
  async restoreCheckpoint(checkpointId: string): Promise<CheckpointRestoreResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_restore_checkpoint');
    try {
      const result = await invoke<Record<string, unknown>>('workbench_restore_checkpoint', { checkpointId });
      return (result as any)?.ok === true;
    } catch (error) {
      showToast('恢复 Checkpoint 失败', 'error', 4500);
      return this.backendDiagnosticResult('workbench_restore_checkpoint', error);
    }
  }

  /**
   * 向子 Agent 发送消息
   */
  async previewConversationRewind(
    request: WorkbenchConversationRewindPreviewRequest
  ): Promise<ConversationRewindPreviewResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_preview_conversation_rewind');
    try {
      const result = await invoke<WorkbenchConversationRewindPreviewResult>(
        'workbench_preview_conversation_rewind',
        { request: this.toConversationRewindBackendRequest(request) }
      );
      if (!isWorkbenchConversationRewindPreviewResult(result)) {
        return this.backendDiagnosticResult(
          'workbench_preview_conversation_rewind',
          'Invalid conversation rewind preview response.'
        );
      }
      this.recordBridgeViewStatus('workbench_preview_conversation_rewind', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_preview_conversation_rewind', error);
    }
  }

  async applyConversationRewind(
    request: WorkbenchConversationRewindApplyRequest
  ): Promise<ConversationRewindApplyResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_apply_conversation_rewind');
    if (request.dryRun === true) {
      return this.backendDiagnosticResult(
        'workbench_apply_conversation_rewind',
        'unsupported: dryRun is represented by previewConversationRewind in the daemon protocol.'
      );
    }
    if (request.force === true) {
      return this.backendDiagnosticResult(
        'workbench_apply_conversation_rewind',
        'unsupported: force is not part of the daemon conversation rewind apply protocol.'
      );
    }
    try {
      const result = await invoke<WorkbenchConversationRewindAppliedResponse>(
        'workbench_apply_conversation_rewind',
        { request: this.toConversationRewindBackendRequest(request) }
      );
      if (!isWorkbenchConversationRewindAppliedResponse(result)) {
        return this.backendDiagnosticResult(
          'workbench_apply_conversation_rewind',
          'Invalid conversation rewind apply response.'
        );
      }
      this.recordBridgeViewStatus('workbench_apply_conversation_rewind', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_apply_conversation_rewind', error);
    }
  }

  async sendToSubagent(subagentRunId: string, message: string): Promise<void> {
    if (!isTauri) return;
    if (isBackendNotWiredCommand('workbench_send_to_subagent')) {
      this.throwBackendNotWired('workbench_send_to_subagent');
    }
    try {
      await invoke('workbench_send_to_subagent', { subagentRunId, message });
    } catch (error) {
      showToast('发送消息到子 Agent 失败', 'error', 4500);
      throw error;
    }
  }

  /**
   * 获取子 Agent 的运行状态
   */
  async getSubagentStatus(subagentRunId: string): Promise<SubagentStatusResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_get_subagent_status');
    if (isBackendNotWiredCommand('workbench_get_subagent_status')) {
      return this.backendNotWiredResult('workbench_get_subagent_status');
    }
    try {
      return await invoke<Record<string, unknown>>('workbench_get_subagent_status', { subagentRunId });
    } catch (error) {
      return this.backendDiagnosticResult('workbench_get_subagent_status', error);
      showToast('获取子 Agent 状态失败', 'error', 4500);
      return null;
    }
  }

  /**
   * 获取工作区文件锁列表
   */
  async listMutationLeases(): Promise<MutationLeaseListResult> {
    if (!isTauri) return this.backendUnsupportedArray<MutationLeaseRecord>('workbench_list_mutation_leases');
    try {
      const result = await invoke<MutationLeaseRecord[]>('workbench_list_mutation_leases', {});
      if (!Array.isArray(result)) {
        return this.backendDiagnosticArray<MutationLeaseRecord>(
          'workbench_list_mutation_leases',
          'Invalid mutation lease response: expected an array.'
        );
      }
      return this.backendOkArray('workbench_list_mutation_leases', result);
    } catch (error) {
      showToast('获取文件锁列表失败', 'error', 4500);
      return this.backendDiagnosticArray<MutationLeaseRecord>('workbench_list_mutation_leases', error);
    }
  }

  async listPlanDocuments(): Promise<PlanDocumentListResult> {
    if (!isTauri) return this.backendUnsupportedArray<WorkbenchPlanDocumentSummary>('workbench_list_plan_documents');
    try {
      const result = await invoke<WorkbenchPlanDocumentsListedResponse>('workbench_list_plan_documents');
      if (!Array.isArray(result?.documents)) {
        return this.backendDiagnosticArray<WorkbenchPlanDocumentSummary>(
          'workbench_list_plan_documents',
          'Invalid plan document list response: expected documents array.'
        );
      }
      return this.backendOkArray('workbench_list_plan_documents', result.documents);
    } catch (error) {
      return this.backendDiagnosticArray<WorkbenchPlanDocumentSummary>('workbench_list_plan_documents', error);
    }
  }

  async createPlanDocument(request: WorkbenchCreatePlanDocumentRequest): Promise<PlanDocumentResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_create_plan_document');
    try {
      const result = await invoke<WorkbenchPlanDocumentResponse>('workbench_create_plan_document', { request });
      return this.planDocumentFromResponse('workbench_create_plan_document', result);
    } catch (error) {
      return this.backendDiagnosticResult('workbench_create_plan_document', error);
    }
  }

  async createRequirementsAlignmentPlan(
    request: WorkbenchCreateRequirementsAlignmentPlanRequest
  ): Promise<PlanDocumentResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_create_requirements_alignment_plan');
    try {
      const result = await invoke<WorkbenchPlanDocumentResponse>('workbench_create_requirements_alignment_plan', {
        request,
      });
      return this.planDocumentFromResponse('workbench_create_requirements_alignment_plan', result);
    } catch (error) {
      return this.backendDiagnosticResult('workbench_create_requirements_alignment_plan', error);
    }
  }

  async getPlanDocument(documentId: string): Promise<PlanDocumentResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_get_plan_document');
    try {
      const result = await invoke<WorkbenchPlanDocumentResponse>('workbench_get_plan_document', { documentId });
      return this.planDocumentFromResponse('workbench_get_plan_document', result);
    } catch (error) {
      return this.backendDiagnosticResult('workbench_get_plan_document', error);
    }
  }

  async patchPlanDocument(documentId: string, patch: WorkbenchPlanDocumentPatch): Promise<PlanDocumentResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_patch_plan_document');
    try {
      const result = await invoke<WorkbenchPlanDocumentResponse>('workbench_patch_plan_document', { documentId, patch });
      return this.planDocumentFromResponse('workbench_patch_plan_document', result);
    } catch (error) {
      return this.backendDiagnosticResult('workbench_patch_plan_document', error);
    }
  }

  async deletePlanDocument(documentId: string): Promise<PlanDocumentDeleteResult> {
    if (!isTauri) return this.backendUnsupportedResult('workbench_delete_plan_document');
    try {
      const result = await invoke<WorkbenchPlanDocumentDeletedResponse>('workbench_delete_plan_document', { documentId });
      if (!isRecord(result) || typeof result.documentId !== 'string') {
        return this.backendDiagnosticResult(
          'workbench_delete_plan_document',
          'Invalid plan document delete response: expected documentId.'
        );
      }
      this.recordBridgeViewStatus('workbench_delete_plan_document', result);
      return result;
    } catch (error) {
      return this.backendDiagnosticResult('workbench_delete_plan_document', error);
    }
  }

  private backendNotWiredResult(command: string): BackendNotWiredResult {
    const result = createBackendNotWiredResult(command);
    this.reportBackendNotWired(result.diagnostic);
    return result;
  }

  private backendNotWiredArray<T>(command: string): BackendNotWiredArrayResult<T> {
    const result = createBackendNotWiredArrayResult<T>(command);
    this.reportBackendNotWired(result.diagnostic);
    return result;
  }

  private backendNotWiredText(command: string): BackendNotWiredTextResult {
    const result = createBackendNotWiredTextResult(command);
    this.reportBackendNotWired(result.diagnostic);
    return result;
  }

  private backendUnsupportedResult(command: string): BackendDiagnosticResult {
    return this.backendDiagnosticResult(command, 'unsupported: Tauri bridge is unavailable in this environment.');
  }

  private backendUnsupportedArray<T>(command: string): BackendDiagnosticArrayResult<T> {
    return this.backendDiagnosticArray<T>(command, 'unsupported: Tauri bridge is unavailable in this environment.');
  }

  private backendOkArray<T>(command: string, value: T[]): T[] {
    this.recordBridgeViewStatus(command, value);
    return value;
  }

  private throwBackendNotWired(command: string): never {
    const error = createBackendNotWiredError(command);
    this.reportBackendNotWired(error.diagnostic);
    throw error;
  }

  private backendDiagnosticResult(command: string, cause: unknown): BackendDiagnosticResult {
    const result = createBackendDiagnosticResult(command, cause);
    this.reportBackendDiagnostic(result.diagnostic);
    return result;
  }

  private backendDiagnosticArray<T>(command: string, cause: unknown): BackendDiagnosticArrayResult<T> {
    const result = createBackendDiagnosticArrayResult<T>(command, cause);
    this.reportBackendDiagnostic(result.diagnostic);
    return result;
  }

  private backendDiagnosticText(command: string, cause: unknown): BackendDiagnosticTextResult {
    const result = createBackendDiagnosticTextResult(command, cause);
    this.reportBackendDiagnostic(result.diagnostic);
    return result;
  }

  private reportBackendNotWired(diagnostic: BackendNotWiredDiagnostic): void {
    this.reportBackendDiagnostic(diagnostic);
  }

  private reportBackendDiagnostic(diagnostic: BackendCommandDiagnostic): void {
    backendViewStatuses.set(diagnostic.command, getBridgeViewStatus({ ok: false, diagnostic }));
    const key = `${diagnostic.code}:${diagnostic.command}`;
    if (reportedBackendDiagnosticKeys.has(key)) return;
    reportedBackendDiagnosticKeys.add(key);
    backendDiagnostics.push(diagnostic);
    /* backend diagnostic recorded silently */
  }

  private recordBridgeViewStatus(command: string, value: unknown): void {
    backendViewStatuses.set(command, getBridgeViewStatus(value, command));
  }

  private planDocumentFromResponse(command: string, result: unknown): PlanDocumentResult {
    const document = isRecord(result) ? result.document : undefined;
    if (!isRecord(document) || typeof document.id !== 'string') {
      return this.backendDiagnosticResult(
        command,
        'Invalid plan document response: expected document object with id.'
      );
    }
    this.recordBridgeViewStatus(command, document);
    return document as unknown as WorkbenchPlanDocument;
  }

  private normalizeHostOpener(input: unknown): HostOpener {
    const item = isRecord(input) ? input : {};
    const kind = item.kind === 'file-manager' || item.kind === 'editor' ? item.kind : 'editor';
    return {
      id: typeof item.id === 'string' ? item.id : '',
      label: typeof item.label === 'string' ? item.label : '',
      kind,
      available: item.available === true,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    };
  }

  private toConversationRewindBackendRequest(
    request: WorkbenchConversationRewindPreviewRequest | WorkbenchConversationRewindApplyRequest
  ): Record<string, unknown> {
    const { runId, retainTargetUserMessage, dryRun, force, ...backendRequest } = request;
    void runId;
    void dryRun;
    void force;
    return {
      ...backendRequest,
      ...(retainTargetUserMessage !== undefined
        ? { mode: retainTargetUserMessage ? 'keep-user-message' : 'remove-user-message' }
        : {}),
    };
  }

  private addListener(event: string, unlisten: UnlistenFn) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(unlisten);
  }

  private normalizeEvent(payload: any): WorkbenchEvent {
    const normalizedPayload = normalizeWorkbenchEvent(payload) as WorkbenchEvent;
    const event = normalizedPayload?.event && typeof normalizedPayload.event === 'object' ? normalizedPayload.event : undefined;
    const runId =
      this.nonEmptyString(normalizedPayload?.runId) ??
      this.nonEmptyString(event?.runId) ??
      this.runIdFromRuntimeSession(event?.sessionId);
    const mappedSessionId = runId ? this.runSessions.get(runId) : undefined;
    const explicitFrontendSessionId =
      this.nonEmptyString(normalizedPayload?.frontendSessionId) ??
      this.nonEmptyString(event?.frontendSessionId);
    const topLevelSessionId = this.nonEmptyString(normalizedPayload?.sessionId);
    const runtimeSessionId =
      this.nonEmptyString(normalizedPayload?.runtimeSessionId) ??
      this.nonEmptyString(event?.sessionId);
    const sessionId =
      explicitFrontendSessionId ??
      mappedSessionId ??
      (topLevelSessionId && topLevelSessionId !== runId ? topLevelSessionId : undefined);

    return {
      ...normalizedPayload,
      runId,
      sessionId,
      runtimeSessionId,
      event: event
        ? {
            ...event,
            runId: this.nonEmptyString(event.runId) ?? runId,
            frontendSessionId: sessionId,
          }
        : payload?.event,
    };
  }

  private runIdFromRuntimeSession(sessionId: unknown): string | undefined {
    const value = this.nonEmptyString(sessionId);
    if (!value) return undefined;
    return this.runSessions.has(value) ? value : undefined;
  }

  private createRunId(): string {
    return `run-${this.createIdSuffix()}`;
  }

  private createSessionId(): string {
    return `session-${this.createIdSuffix()}`;
  }

  private createIdSuffix(): string {
    const randomPart =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${Date.now()}-${randomPart}`;
  }

  private normalizeProviderConfigSnapshot(input: Record<string, unknown>): WorkbenchProviderConfigSnapshot {
    const daemonStatus = this.readDaemonProviderStatus(input);
    if (daemonStatus) {
      return projectDaemonProviderStatusToWorkbench(daemonStatus);
    }

    const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : '';
    const model = typeof input.model === 'string' ? input.model : '';
    const hasApiKey = Boolean(input.hasApiKey || (typeof input.apiKey === 'string' && input.apiKey.trim()));
    const apiKeySource = this.normalizeApiKeySource(input.apiKeySource);
    const credentialMode =
      input.credentialMode === 'account-center' || input.credentialMode === 'auto'
        ? input.credentialMode
        : 'direct';
    const accountCenterConfigured =
      typeof input.accountCenterConfigured === 'boolean' ? input.accountCenterConfigured : 'unknown';
    const credentialStatus = this.providerCredentialStatus(credentialMode, hasApiKey, accountCenterConfigured);
    const endpoint =
      input.endpoint === 'responses' || input.endpoint === 'chat-completions' || input.endpoint === 'auto'
        ? input.endpoint
        : undefined;
    const stream = typeof input.stream === 'boolean' ? input.stream : undefined;
    return {
      baseUrl,
      model,
      hasApiKey,
      apiKeySource,
      accountCenterConfigured,
      credentialMode,
      credentialStatus,
      statusText: this.providerStatusText(credentialStatus, apiKeySource),
      updatedAt: new Date().toISOString(),
      endpoint,
      stream,
    };
  }

  private normalizeWorkbenchStatus(input: Record<string, unknown>): WorkbenchStatus {
    const providerStatus = this.readDaemonProviderStatus(input);
    return projectDaemonStatusToWorkbench(input, {
      providerConfig: providerStatus
        ? undefined
        : isRecord(input.providerConfig)
          ? this.normalizeProviderConfigSnapshot(input.providerConfig)
          : undefined,
    });
  }

  private readDaemonProviderStatus(input: Record<string, unknown>): DaemonProviderStatusSnapshot | null {
    if (isDaemonProviderStatusSnapshot(input)) return input;
    return isDaemonProviderStatusSnapshot(input.providerStatus) ? input.providerStatus : null;
  }

  private normalizeApiKeySource(value: unknown): WorkbenchApiKeySource {
    return value === 'frontend' || value === 'env' || value === 'unset' ? value : 'unknown';
  }

  private providerCredentialStatus(
    mode: WorkbenchProviderMode,
    hasApiKey: boolean,
    accountCenterConfigured: boolean | 'unknown'
  ): WorkbenchProviderConfigSnapshot['credentialStatus'] {
    if (mode === 'direct') return hasApiKey ? 'ready' : 'missing';
    if (accountCenterConfigured === true) return 'account-center-pending';
    if (accountCenterConfigured === false) return 'missing';
    return 'unknown';
  }

  private providerStatusText(
    status: WorkbenchProviderConfigSnapshot['credentialStatus'],
    apiKeySource: WorkbenchApiKeySource
  ): string {
    if (status === 'ready') return apiKeySource === 'env' ? 'Environment key available' : 'API key available';
    if (status === 'account-center-pending') return 'Account balance will be used at run time';
    if (status === 'unknown') return 'Waiting for account-center status';
    return 'Provider credential needed';
  }

  private nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
}

// 全局单例
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const tauriBridge = new TauriBridge();
