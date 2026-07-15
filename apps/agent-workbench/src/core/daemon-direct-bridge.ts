/**
 * Daemon 直连桥接层
 *
 * 基于 DaemonWebSocketClient，将 daemon 协议消息映射为 TauriBridge 兼容的接口。
 * 该层负责：
 * - 管理 WebSocket 连接生命周期
 * - 将 daemon 协议请求/响应转换为前端可用的数据结构
 * - 将 daemon 事件流转换为 WorkbenchEvent 格式
 *
 * 迁移策略：
 * - 该层提供与 TauriBridge 相同语义的方法
 * - 调用方可逐步从 TauriBridge 迁移到 DaemonDirectBridge
 * - Rust sidecar 透传命令可逐步移除
 */

import {
  getDaemonWebSocketClient,
  type DaemonConnectionState,
  type DaemonWebSocketClient,
} from './daemon-websocket-client';
import type { WorkbenchEvent } from './tauri-bridge';

/** 连接就绪回调 */
type ReadyCallback = () => void;

/** Daemon 协议消息类型映射 */
const DAEMON_RESPONSE_TYPES = {
  statusResponse: 'status-response',
  sessionsListed: 'sessions-listed',
  runsListed: 'runs-listed',
  sessionEvents: 'session-events',
  runEvents: 'run-events',
  runSnapshot: 'run-snapshot',
  pendingInputQueued: 'pending-input-queued',
  pendingInputCancelled: 'pending-input-cancelled',
  pendingInputDispatched: 'pending-input-dispatched',
  pendingInputsListed: 'pending-inputs-listed',
  capabilitiesResponse: 'capabilities-response',
  configUpdated: 'config-updated',
  planDocumentsListed: 'plan-documents-listed',
  planDocumentCreated: 'plan-document-created',
  planDocument: 'plan-document',
  planDocumentPatched: 'plan-document-patched',
  planDocumentDeleted: 'plan-document-deleted',
  approvalRequested: 'approval-requested',
  error: 'error',
} as const;

/** Daemon 事件消息类型（无需 correlationId 匹配的广播消息） */
const DAEMON_EVENT_TYPES = [
  'event',
  'subagent-event',
  'subagent-started',
  'subagent-ended',
  'approval-requested',
  'run-started',
  'run-ended',
  'daemon-ready',
] as const;

function isDaemonEvent(type: string): boolean {
  return (DAEMON_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Daemon 直连桥接层
 *
 * 封装 DaemonWebSocketClient，提供与 TauriBridge 语义对齐的高层 API。
 */
export class DaemonDirectBridge {
  private client: DaemonWebSocketClient;
  private readyCallbacks = new Set<ReadyCallback>();
  private connected = false;

  constructor(client: DaemonWebSocketClient = getDaemonWebSocketClient()) {
    this.client = client;
    this.client.onStateChange((state) => {
      const wasConnected = this.connected;
      this.connected = state === 'connected';
      if (this.connected && !wasConnected) {
        for (const callback of this.readyCallbacks) {
          try {
            callback();
          } catch (error) {
            console.error('[DaemonDirectBridge] Ready callback threw:', error);
          }
        }
      }
    });
  }

  /** 获取底层 WebSocket 客户端 */
  getClient(): DaemonWebSocketClient {
    return this.client;
  }

  /** 当前是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 获取连接状态 */
  getState(): DaemonConnectionState {
    return this.client.getState();
  }

  /** 建立连接 */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /** 断开连接 */
  disconnect(): void {
    this.client.disconnect();
  }

  /** 注册连接就绪回调 */
  onReady(callback: ReadyCallback): () => void {
    this.readyCallbacks.add(callback);
    return () => this.readyCallbacks.delete(callback);
  }

  // ==================== 状态与配置 ====================

  /** 获取 daemon 状态（对应 workbench_status） */
  async getStatus(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'get-status' },
      DAEMON_RESPONSE_TYPES.statusResponse,
    );
  }

  /** 获取能力清单 */
  async listCapabilities(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'list-capabilities' },
      DAEMON_RESPONSE_TYPES.capabilitiesResponse,
    );
  }

  /** 更新配置 */
  async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'update-config', config },
      DAEMON_RESPONSE_TYPES.configUpdated,
    );
  }

  // ==================== 会话与运行 ====================

  /** 列出会话 */
  async listSessions(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'list-sessions' },
      DAEMON_RESPONSE_TYPES.sessionsListed,
    );
  }

  /** 列出运行 */
  async listRuns(sessionId?: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'list-runs', ...(sessionId ? { sessionId } : {}) },
      DAEMON_RESPONSE_TYPES.runsListed,
    );
  }

  /** 读取会话事件 */
  async readSessionEvents(params: {
    sessionId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'read-session-events', ...params },
      DAEMON_RESPONSE_TYPES.sessionEvents,
    );
  }

  /** 读取运行事件 */
  async readRunEvents(params: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'read-run-events', ...params },
      DAEMON_RESPONSE_TYPES.runEvents,
    );
  }

  /** 获取运行快照 */
  async getRunSnapshot(runId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'get-run-snapshot', runId },
      DAEMON_RESPONSE_TYPES.runSnapshot,
    );
  }

  /**
   * 启动任务（流式）
   *
   * 发送 run-task 命令，daemon 会通过 event 消息流式推送运行事件。
   * 调用方应通过 subscribeRunEvents 订阅事件流。
   */
  async startRunTask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    // run-task 的响应类型不固定，daemon 可能返回 run-started 或直接开始推送事件
    // 这里使用宽松匹配，等待任意非 event 类型的响应
    return this.client.request<Record<string, unknown>>(
      { type: 'run-task', ...request },
      ['run-started', 'status-response', 'error'],
    );
  }

  /** 取消运行 */
  async cancelRun(runId: string): Promise<void> {
    await this.client.send({ type: 'cancel-run', runId });
  }

  // ==================== 审批 ====================

  /** 批准工具调用 */
  async approveTool(toolCallId: string, scope?: string): Promise<void> {
    await this.client.send({
      type: 'approve-tool',
      toolCallId,
      ...(scope ? { scope } : {}),
    });
  }

  /** 拒绝工具调用 */
  async denyTool(toolCallId: string): Promise<void> {
    await this.client.send({ type: 'deny-tool', toolCallId });
  }

  // ==================== 待处理输入 ====================

  async enqueuePendingInput(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'enqueue-pending-input', ...request },
      DAEMON_RESPONSE_TYPES.pendingInputQueued,
    );
  }

  async cancelPendingInput(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'cancel-pending-input', ...request },
      DAEMON_RESPONSE_TYPES.pendingInputCancelled,
    );
  }

  async dispatchPendingInput(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'dispatch-pending-input', ...request },
      DAEMON_RESPONSE_TYPES.pendingInputDispatched,
    );
  }

  async listPendingInputs(sessionId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'list-pending-inputs', sessionId },
      DAEMON_RESPONSE_TYPES.pendingInputsListed,
    );
  }

  // ==================== 计划文档 ====================

  async listPlanDocuments(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'list-plan-documents' },
      DAEMON_RESPONSE_TYPES.planDocumentsListed,
    );
  }

  async createPlanDocument(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'create-plan-document', ...request },
      DAEMON_RESPONSE_TYPES.planDocumentCreated,
    );
  }

  async getPlanDocument(documentId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'get-plan-document', documentId },
      DAEMON_RESPONSE_TYPES.planDocument,
    );
  }

  async patchPlanDocument(
    documentId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'patch-plan-document', documentId, patch },
      DAEMON_RESPONSE_TYPES.planDocumentPatched,
    );
  }

  async deletePlanDocument(documentId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>(
      { type: 'delete-plan-document', documentId },
      DAEMON_RESPONSE_TYPES.planDocumentDeleted,
    );
  }

  // ==================== 事件订阅 ====================

  /**
   * 订阅运行事件流
   *
   * @param runId 运行 ID
   * @param callback 事件回调（接收 WorkbenchEvent 格式）
   */
  subscribeRunEvents(runId: string, callback: (event: WorkbenchEvent) => void): () => void {
    return this.client.subscribe(
      { runId, types: [...DAEMON_EVENT_TYPES] },
      (event) => callback(this.normalizeEvent(event)),
    );
  }

  /**
   * 订阅会话事件流
   */
  subscribeSessionEvents(sessionId: string, callback: (event: WorkbenchEvent) => void): () => void {
    return this.client.subscribe(
      { sessionId, types: [...DAEMON_EVENT_TYPES] },
      (event) => callback(this.normalizeEvent(event)),
    );
  }

  /**
   * 订阅所有事件流
   */
  subscribeAllEvents(callback: (event: WorkbenchEvent) => void): () => void {
    return this.client.subscribe(
      { types: [...DAEMON_EVENT_TYPES] },
      (event) => callback(this.normalizeEvent(event)),
    );
  }

  /** 将 daemon 原始事件转换为 WorkbenchEvent 格式 */
  private normalizeEvent(event: Record<string, unknown>): WorkbenchEvent {
    return {
      type: String(event.type ?? ''),
      runId: event.runId !== undefined ? String(event.runId) : undefined,
      sessionId: event.sessionId !== undefined ? String(event.sessionId) : undefined,
      runtimeSessionId:
        event.runtimeSessionId !== undefined ? String(event.runtimeSessionId) : undefined,
      ...event,
    } as WorkbenchEvent;
  }
}

/** 全局单例 */
let globalBridge: DaemonDirectBridge | null = null;

/** 获取全局 DaemonDirectBridge 单例 */
export function getDaemonDirectBridge(): DaemonDirectBridge {
  if (!globalBridge) {
    globalBridge = new DaemonDirectBridge();
  }
  return globalBridge;
}
