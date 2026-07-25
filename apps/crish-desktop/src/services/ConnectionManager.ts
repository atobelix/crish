/**
 * ConnectionManager —— Daemon 连接管理器
 *
 * 职责：
 * - 三阶段连接：DISCONNECTED → CONNECTING → AUTHENTICATING → READY
 * - 指数退避重连（1s, 2s, 4s, 8s, 16s, 32s, max 60s + jitter ±25%）
 * - Probe 心跳探测（30s 间隔，3 次 miss 断连）
 * - 通过 eventBus 广播连接状态变更
 * - 导出单例 connectionManager
 *
 * 依赖：
 * - DesktopDaemonClient（单例，WebSocket 传输层）
 * - EventBus（单例，事件广播）
 */

import { getDesktopDaemonClient, DesktopDaemonClient, type DaemonConnState } from '../api/daemonClient';
import { eventBus } from './EventBus';

export type ConnectionPhase = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'recovering';
export type ConnectionLevel = 'excellent' | 'good' | 'degraded' | 'poor' | 'offline';

export interface ConnectionState {
  phase: ConnectionPhase;
  level: ConnectionLevel;
  latencyMs: number;
  lastReadyTimestamp: number | null;
  probeMissCount: number;
  retryAttempt: number;
  retryDelay: number;
}

const PROBE_INTERVAL_MS = 30_000;
const PROBE_MISS_LIMIT = 3;
const AUTH_TIMEOUT_MS = 15_000;
const LATENCY_HISTORY_SIZE = 5;

export class ConnectionManager {
  private static instance: ConnectionManager | null = null;

  public static resetInstanceForTests(): void {
    if (ConnectionManager.instance) {
      ConnectionManager.instance.dispose();
      ConnectionManager.instance = null;
    }
  }

  public static createForTest(client: DesktopDaemonClient): ConnectionManager {
    const cm = new ConnectionManager(client);
    ConnectionManager.instance = cm;
    return cm;
  }

  public dispose(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.callbacks.clear();
  }

  private client: DesktopDaemonClient;
  private state: ConnectionState;
  private callbacks = new Set<(state: ConnectionState) => void>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private latencyHistory: number[] = [];

  private constructor(client?: DesktopDaemonClient) {
    this.client = client ?? getDesktopDaemonClient();
    this.state = this.createInitialState();

    this.client.onState((s, err?) => this.handleDaemonStateChange(s, err));
    this.client.onMessage((msg) => this.handleDaemonMessage(msg));
  }

  static getInstance(): ConnectionManager {
    if (!this.instance) {
      this.instance = new ConnectionManager();
    }
    return this.instance;
  }

  // ─── 连接控制 ───────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state.phase === 'ready') return;
    if (this.connectPromise) return this.connectPromise;

    this.clearReconnectTimer();
    this.stopProbe();

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.stopProbe();
    this.clearReconnectTimer();
    this.connectPromise = null;
    this.client.disconnect();
    this.state = this.createInitialState();
    this.latencyHistory = [];
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
    return this.state.phase === 'ready' && this.client.isConnected();
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
    this.updateState({ phase: 'connecting', retryAttempt: 0 });

    try {
      await this.client.connect();
    } catch (err) {
      this.client.disconnect();
      this.scheduleReconnect();
      throw err;
    }

    if (!this.client.isConnected()) {
      this.client.disconnect();
      this.scheduleReconnect();
      throw new Error('Connection lost immediately after open');
    }

    try {
      await this.authenticate();
    } catch (err) {
      this.client.disconnect();
      this.scheduleReconnect();
      throw err;
    }

    this.enterReadyState();
  }

  private authenticate(): Promise<void> {
    this.updateState({ phase: 'authenticating' });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        reject(new Error('Authentication timed out'));
      }, AUTH_TIMEOUT_MS);

      const unsub = this.client.onMessage((msg) => {
        const type = String(msg.type ?? '');
        if (type === 'authenticated') {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsub();
          resolve();
        } else if (type === 'auth_error') {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsub();
          reject(new Error(String(msg.message ?? 'Authentication failed')));
        }
      });

      this.client.send({ type: 'authenticate' }).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private enterReadyState(): void {
    this.state.phase = 'ready';
    this.state.probeMissCount = 0;
    this.state.retryAttempt = 0;
    this.state.retryDelay = this.computeBackoffDelay(0);
    this.state.lastReadyTimestamp = Date.now();
    this.state.latencyMs = 0;
    this.latencyHistory = [];
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
    this.startProbe();
  }

  // ─── 内部：重连与退避 ───────────────────────────────────────

  private handleUnexpectedDisconnect(): void {
    this.stopProbe();
    this.clearReconnectTimer();
    this.connectPromise = null;
    this.client.disconnect();
    this.state.phase = 'recovering';
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.computeBackoffDelay(this.state.retryAttempt);
    this.state.retryDelay = delay;
    this.state.retryAttempt += 1;
    this.state.phase = 'recovering';
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        /* scheduleReconnect is triggered by doConnect failure */
      });
    }, delay);
  }

  private computeBackoffDelay(attempt: number): number {
    const baseDelay = attempt < 6
      ? 1000 * Math.pow(2, attempt)
      : 60000;
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.round(baseDelay + jitter);
  }

  // ─── 内部：Probe 心跳探测 ───────────────────────────────────

  private startProbe(): void {
    this.stopProbe();
    this.state.probeMissCount = 0;

    this.probeTimer = setInterval(() => {
      if (this.state.phase !== 'ready') return;

      this.state.probeMissCount += 1;

      if (this.state.probeMissCount >= PROBE_MISS_LIMIT) {
        this.handleProbeFailure();
        return;
      }

      this.computeLevel();
      this.client.send({ type: 'echo', timestamp: Date.now() }).catch(() => {
        this.state.probeMissCount += 1;
        if (this.state.probeMissCount >= PROBE_MISS_LIMIT) {
          this.handleProbeFailure();
        }
      });
    }, PROBE_INTERVAL_MS);
  }

  private stopProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private handleProbeFailure(): void {
    this.stopProbe();
    this.clearReconnectTimer();
    this.connectPromise = null;
    this.state.phase = 'recovering';
    this.state.probeMissCount = PROBE_MISS_LIMIT;
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
    this.client.disconnect();
    this.scheduleReconnect();
  }

  // ─── 内部：Daemon 事件处理 ──────────────────────────────────

  private handleDaemonStateChange(s: DaemonConnState, _err?: Error): void {
    if (s === 'connected') {
      if (this.state.phase === 'recovering') {
        void this.authenticate().then(
          () => this.enterReadyState(),
          () => {
            this.client.disconnect();
            this.scheduleReconnect();
          },
        );
      }
    } else if (s === 'disconnected' || s === 'failed') {
      if (this.state.phase === 'ready' || this.state.phase === 'authenticating') {
        this.handleUnexpectedDisconnect();
      }
    }
  }

  private handleDaemonMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? '');

    if (type === 'pong') {
      this.state.probeMissCount = 0;
      if (typeof msg.timestamp === 'number') {
        this.recordLatency(Date.now() - msg.timestamp);
      }
      this.computeLevel();
    }
  }

  // ─── 内部：延迟与级别计算 ───────────────────────────────────

  private recordLatency(ms: number): void {
    this.latencyHistory.push(ms);
    if (this.latencyHistory.length > LATENCY_HISTORY_SIZE) {
      this.latencyHistory.shift();
    }
    const avg = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
    this.state.latencyMs = Math.round(avg);
  }

  private computeLevel(): void {
    const { phase, probeMissCount, latencyMs } = this.state;

    let level: ConnectionLevel;
    if (phase === 'disconnected' || phase === 'recovering') {
      level = 'offline';
    } else if (probeMissCount >= PROBE_MISS_LIMIT) {
      level = 'offline';
    } else if (probeMissCount > 0) {
      level = 'poor';
    } else if (latencyMs < 100) {
      level = 'excellent';
    } else if (latencyMs < 300) {
      level = 'good';
    } else if (latencyMs < 1000) {
      level = 'degraded';
    } else {
      level = 'poor';
    }

    this.state.level = level;
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
    eventBus.emit(
      'daemon:connection:change',
      { ...this.state },
      'daemon',
    );
  }

  // ─── 内部：辅助 ─────────────────────────────────────────────

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private createInitialState(): ConnectionState {
    return {
      phase: 'disconnected',
      level: 'offline',
      latencyMs: 0,
      lastReadyTimestamp: null,
      probeMissCount: 0,
      retryAttempt: 0,
      retryDelay: this.computeBackoffDelay(0),
    };
  }
}

export const connectionManager = ConnectionManager.getInstance();
