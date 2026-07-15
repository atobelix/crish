/**
 * Daemon WebSocket 直连客户端
 *
 * 取代 Rust sidecar 透传层，前端直接通过 WebSocket 与 daemon 通信。
 * Rust 层仅保留进程守护（启动/停止/重启 daemon）与 endpoint 暴露职责。
 *
 * 设计要点：
 * - 单一长连接，自动重连
 * - 请求/响应通过 correlationId 关联
 * - 事件流通过订阅 runId/sessionId 过滤
 * - 与现有 TauriBridge 接口对齐，便于渐进式迁移
 */

import { invoke } from '@tauri-apps/api/core';

/** Daemon WebSocket 端点信息（由 Rust sidecar 暴露） */
export interface DaemonEndpoint {
  available: boolean;
  url: string | null;
  port: number | null;
  pid: number | null;
  buildHash: string | null;
}

/** 请求待处理项 */
interface PendingRequest {
  requestId: string;
  expectedType: string | string[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/** 事件订阅回调 */
type EventCallback = (event: Record<string, unknown>) => void;

/** 事件订阅 */
interface EventSubscription {
  id: string;
  filter: { runId?: string; sessionId?: string; types?: string[] };
  callback: EventCallback;
}

/** 连接状态 */
export type DaemonConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

/** 连接状态变更回调 */
type StateChangeCallback = (state: DaemonConnectionState, error?: Error) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_MAX_ATTEMPTS = 10;

function generateRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function matchesExpectedType(messageType: string, expected: string | string[]): boolean {
  if (typeof expected === 'string') return messageType === expected;
  return expected.includes(messageType);
}

function eventMatchesFilter(event: Record<string, unknown>, filter: EventSubscription['filter']): boolean {
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.types !== undefined && !filter.types.includes(String(event.type))) return false;
  return true;
}

/**
 * Daemon WebSocket 直连客户端
 *
 * 通过 `workbench_daemon_endpoint` Tauri 命令获取 daemon WebSocket URL，
 * 建立长连接，并提供请求/响应与事件订阅能力。
 */
export class DaemonWebSocketClient {
  private socket: WebSocket | null = null;
  private endpoint: DaemonEndpoint | null = null;
  private state: DaemonConnectionState = 'disconnected';
  private pendingRequests = new Map<string, PendingRequest>();
  private eventSubscriptions = new Map<string, EventSubscription>();
  private stateListeners = new Set<StateChangeCallback>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;
  private messageQueue: string[] = [];

  /** 获取当前连接状态 */
  getState(): DaemonConnectionState {
    return this.state;
  }

  /** 获取当前端点信息 */
  getEndpoint(): DaemonEndpoint | null {
    return this.endpoint;
  }

  /** 监听连接状态变更 */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * 连接 daemon WebSocket
   *
   * 通过 Tauri 命令获取 daemon 端点，然后建立 WebSocket 连接。
   * 若端点不可用，将进入重连流程。
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }
    this.explicitClose = false;
    await this.attemptConnect();
  }

  /** 显式断开连接，停止重连 */
  disconnect(): void {
    this.explicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.rejectAllPending('Daemon WebSocket client disconnected');
    this.setState('disconnected');
  }

  /**
   * 发送请求并等待响应
   *
   * @param command 命令消息（需包含 type 字段）
   * @param expectedType 期望的响应消息类型
   * @param timeoutMs 超时时间（毫秒）
   */
  async request<T = unknown>(
    command: Record<string, unknown>,
    expectedType: string | string[],
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.state !== 'connected' || !this.socket) {
      throw new Error(`Daemon WebSocket not connected (state: ${this.state})`);
    }

    const requestId = generateRequestId('req');
    const correlationId = requestId;
    const payload = { ...command, requestId, correlationId };
    const message = JSON.stringify(payload);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Daemon request timed out after ${timeoutMs}ms (type: ${command.type})`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        requestId,
        expectedType,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        startedAt: Date.now(),
      });

      this.sendRaw(message);
    });
  }

  /**
   * 发送命令（无需等待响应）
   */
  async send(command: Record<string, unknown>): Promise<void> {
    if (this.state !== 'connected' || !this.socket) {
      throw new Error(`Daemon WebSocket not connected (state: ${this.state})`);
    }
    const requestId = generateRequestId('cmd');
    const payload = { ...command, requestId, correlationId: requestId };
    this.sendRaw(JSON.stringify(payload));
  }

  /**
   * 订阅事件流
   *
   * @param filter 事件过滤条件
   * @param callback 事件回调
   */
  subscribe(filter: EventSubscription['filter'], callback: EventCallback): () => void {
    const id = generateRequestId('sub');
    this.eventSubscriptions.set(id, { id, filter, callback });
    return () => this.eventSubscriptions.delete(id);
  }

  // ==================== 内部实现 ====================

  private async attemptConnect(): Promise<void> {
    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    try {
      this.endpoint = await this.fetchEndpoint();
    } catch (error) {
      this.handleConnectFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!this.endpoint.available || !this.endpoint.url) {
      this.handleConnectFailure(new Error('Daemon endpoint not available'));
      return;
    }

    try {
      this.openSocket(this.endpoint.url);
    } catch (error) {
      this.handleConnectFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async fetchEndpoint(): Promise<DaemonEndpoint> {
    try {
      return await invoke<DaemonEndpoint>('workbench_daemon_endpoint');
    } catch (error) {
      throw new Error(`Failed to fetch daemon endpoint: ${String(error)}`);
    }
  }

  private openSocket(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.flushMessageQueue();
    };

    socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    socket.onerror = () => {
      // 错误详情由 onclose 处理，这里不直接进入失败状态
    };

    socket.onclose = (event) => {
      this.socket = null;
      if (this.explicitClose) {
        this.setState('disconnected');
        return;
      }
      const reason = event.reason || `WebSocket closed (code: ${event.code})`;
      this.handleConnectFailure(new Error(reason));
    };
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        // 忽略关闭错误
      }
      this.socket = null;
    }
  }

  private handleMessage(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : String(data);
      message = JSON.parse(text);
    } catch {
      return;
    }

    const messageType = String(message.type ?? '');
    const correlationId = message.correlationId !== undefined ? String(message.correlationId) : undefined;
    const requestId = message.requestId !== undefined ? String(message.requestId) : correlationId;

    // 优先匹配请求响应
    if (requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending && matchesExpectedType(messageType, pending.expectedType)) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        pending.resolve(message);
        return;
      }
    }

    // 否则作为事件分发
    this.dispatchEvent(message);
  }

  private dispatchEvent(event: Record<string, unknown>): void {
    for (const subscription of this.eventSubscriptions.values()) {
      if (eventMatchesFilter(event, subscription.filter)) {
        try {
          subscription.callback(event);
        } catch (error) {
          console.error('[DaemonWebSocket] Event subscriber threw:', error);
        }
      }
    }
  }

  private sendRaw(message: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  private flushMessageQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()!;
      this.socket.send(message);
    }
  }

  private handleConnectFailure(error: Error): void {
    this.socket = null;
    if (this.explicitClose) {
      this.setState('disconnected');
      return;
    }

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setState('failed', error);
      this.rejectAllPending(`Daemon WebSocket connection failed: ${error.message}`);
      return;
    }

    this.reconnectAttempts += 1;
    this.setState('reconnecting', error);

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect().catch((retryError) => {
        this.handleConnectFailure(retryError instanceof Error ? retryError : new Error(String(retryError)));
      });
    }, delay);
  }

  private setState(state: DaemonConnectionState, error?: Error): void {
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state, error);
      } catch (listenerError) {
        console.error('[DaemonWebSocket] State listener threw:', listenerError);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}

/** 全局单例 */
let globalClient: DaemonWebSocketClient | null = null;

/** 获取全局 DaemonWebSocketClient 单例 */
export function getDaemonWebSocketClient(): DaemonWebSocketClient {
  if (!globalClient) {
    globalClient = new DaemonWebSocketClient();
  }
  return globalClient;
}
