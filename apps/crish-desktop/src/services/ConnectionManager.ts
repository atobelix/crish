/**
 * ConnectionManager —— 核心连接状态投影器（Tauri IPC transport 驱动）
 *
 * C3.1 迁移后语义：
 * - phase 由「核心已初始化」（transport.isReady / waitUntilConnected）驱动，
 *   不再有 WS 心跳 / 指数退避重连 / authenticate 认证协议（03 §3.3 职责表 2/3/4/9 均删）。
 * - 仅投影 TransportStatus → ConnectionPhase，不独立跑任何 probe / timer。
 * - connect() 委托 transport.waitUntilConnected（core_get_status 轮询）。
 * - disconnect() 仅复位投影状态（进程内核心无「断开 keep-alive」语义）。
 * - 通过 eventBus 广播连接状态变更（engine:connection:change）。
 *
 * 状态映射：
 *   TransportStatus            → ConnectionPhase
 *   ─────────────────────────────────────────────
 *   'disconnected'             → 'disconnected'
 *   'connecting'               → 'connecting'
 *   'connected'（核心已初始化）  → 'ready'
 *   'failed'                   → 'recovering'
 *
 * 保留 ConnectionState 旧字段形状（latencyMs / probeMissCount 等）供 UI 兼容：
 * transport 无心跳指标，恒为初始值（0 / null），仅 lastReadyTimestamp 有实际更新。
 */

import type { Transport, TransportStatus } from '../api/transport';
import { getTransport } from '../api/transport';
import { eventBus } from './EventBus';

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'recovering';

export type ConnectionLevel =
  | 'excellent'
  | 'good'
  | 'degraded'
  | 'poor'
  | 'offline';

export interface ConnectionState {
  phase: ConnectionPhase;
  level: ConnectionLevel;
  latencyMs: number;
  lastReadyTimestamp: number | null;
  /** transport 无心跳指标：恒 0（兼容旧 UI 字段） */
  probeMissCount: number;
  /** transport 无重连计数：恒 0（兼容旧 UI 字段） */
  retryAttempt: number;
  /** transport 无退避延迟：恒 0（兼容旧 UI 字段） */
  retryDelay: number;
}

/** 等待核心就绪（waitUntilConnected）的超时 */
const CORE_CONNECT_TIMEOUT_MS = 15_000;

export class ConnectionManager {
  private static instance: ConnectionManager | null = null;

  public static resetInstanceForTests(): void {
    if (ConnectionManager.instance) {
      ConnectionManager.instance.dispose();
      ConnectionManager.instance = null;
    }
  }

  /** 测试注入：自定义 transport（默认取进程级单例） */
  public static createForTest(transport: Transport): ConnectionManager {
    const cm = new ConnectionManager(transport);
    ConnectionManager.instance = cm;
    return cm;
  }

  private transport: Transport;
  private state: ConnectionState;
  private callbacks = new Set<(state: ConnectionState) => void>();
  /** 进行中的 connect Promise（去重并发 connect 调用） */
  private connectPromise: Promise<void> | null = null;
  /** transport 状态订阅句柄；dispose 时清理 */
  private unsubStatus: (() => void) | null = null;

  private constructor(transport?: Transport) {
    this.transport = transport ?? getTransport();
    this.state = this.createInitialState();
    // 被动投影 transport 状态；transport 内部无心跳/重连，无需其它订阅
    this.unsubStatus = this.transport.onStatus((s, err?) =>
      this.handleStatusChange(s, err),
    );
  }

  static getInstance(): ConnectionManager {
    if (!this.instance) {
      this.instance = new ConnectionManager();
    }
    return this.instance;
  }

  // ─── 生命周期 ───────────────────────────────────────────────

  public dispose(): void {
    if (this.unsubStatus) {
      this.unsubStatus();
      this.unsubStatus = null;
    }
    this.callbacks.clear();
  }

  // ─── 连接控制 ───────────────────────────────────────────────

  /**
   * 启动连接流程：等待「核心已初始化」。
   * - 已 ready 立即返回（no-op tear-down）
   * - 进行中复用现有 connectPromise
   * - 否则 transport.waitUntilConnected（core_get_status 轮询）
   */
  async connect(): Promise<void> {
    if (this.state.phase === 'ready') return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  /**
   * 显式复位投影（进程内核心无 keep-alive 可停；仅把 UI 状态拉回 disconnected）。
   * 保留签名兼容旧调用方（bootstrap / 测试）。
   */
  disconnect(): void {
    this.connectPromise = null;
    this.state = this.createInitialState();
    this.emitStateChange();
    this.emitEventBus();
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect();
  }

  // ─── 状态查询 ───────────────────────────────────────────────

  getState(): ConnectionState {
    return { ...this.state };
  }

  isReady(): boolean {
    return this.state.phase === 'ready' && this.transport.isReady();
  }

  // ─── 订阅 ───────────────────────────────────────────────────

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  // ─── 内部：连接流程 ─────────────────────────────────────────

  private async doConnect(): Promise<void> {
    const ready = await this.transport.waitUntilConnected(
      CORE_CONNECT_TIMEOUT_MS,
    );
    if (ready) {
      this.enterReadyState();
    } else {
      // 核心未在超时内就绪：投影为 recovering（不崩，等待后续 onStatus 纠正）
      this.state.phase = 'recovering';
      this.computeLevel();
      this.emitStateChange();
      this.emitEventBus();
    }
  }

  private enterReadyState(): void {
    this.state.phase = 'ready';
    this.state.probeMissCount = 0;
    this.state.retryAttempt = 0;
    this.state.retryDelay = 0;
    this.state.lastReadyTimestamp = Date.now();
    this.state.latencyMs = 0;
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
  }

  // ─── 内部：transport 状态投影 ────────────────────────────────

  private handleStatusChange(s: TransportStatus, _err?: Error): void {
    switch (s) {
      case 'disconnected':
        this.state.phase = 'disconnected';
        break;
      case 'connecting':
        // 仅在初始 disconnected → connecting 时切换，避免覆盖 recovering/ready
        if (this.state.phase === 'disconnected') {
          this.state.phase = 'connecting';
        }
        break;
      case 'connected':
        this.state.phase = 'ready';
        this.state.lastReadyTimestamp = Date.now();
        break;
      case 'failed':
        this.state.phase = 'recovering';
        break;
    }
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
  }

  // ─── 内部：级别计算（无心跳指标，纯 phase 驱动）───────────────

  private computeLevel(): void {
    const { phase } = this.state;
    this.state.level =
      phase === 'disconnected' || phase === 'recovering' ? 'offline' : 'good';
  }

  // ─── 内部：状态变更通知 ─────────────────────────────────────

  private updateState(partial: Partial<ConnectionState>): void {
    Object.assign(this.state, partial);
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
  }

  private emitStateChange(): void {
    const snapshot = { ...this.state };
    for (const cb of this.callbacks) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error('[ConnectionManager] state callback error:', err);
      }
    }
  }

  private emitEventBus(): void {
    eventBus.emit('engine:connection:change', { ...this.state }, 'engine');
  }

  // ─── 内部：辅助 ─────────────────────────────────────────────

  private createInitialState(): ConnectionState {
    return {
      phase: 'disconnected',
      level: 'offline',
      latencyMs: 0,
      lastReadyTimestamp: null,
      probeMissCount: 0,
      retryAttempt: 0,
      retryDelay: 0,
    };
  }
}

export const connectionManager = ConnectionManager.getInstance();
